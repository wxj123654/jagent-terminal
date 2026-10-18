//! 纯格式化工具：`%D` 装饰解析、相对时间、变更文件树。

use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::types::{ChangedFile, WorktreeFile, WorktreeFileKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefKind {
    Head,
    Branch,
    Remote,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefDecor {
    pub kind: RefKind,
    pub label: String,
}

/// `%D` 装饰字符串 → 徽章描述数组。输入样例 `"HEAD -> main, origin/main, tag: v1.0"`
/// （detached HEAD 时为 `"HEAD"`，普通提交为空串）。
///
/// ref 名里不可能出现 `", "`（git 自己用它做分隔）；`HEAD -> main` 按原型拆两个 chip。
///
/// **已知缺陷（沿用旧规则，P5 视图验收时决定是否修）**：含 `/` 一律视为远程引用，
/// 所以本地分支 `feature/x` 会被标成 remote。要区分需要拿到 `refs/remotes` 的列表，
/// 而 `%D` 本身不带这个信息。
pub fn parse_ref_names(raw: &str) -> Vec<RefDecor> {
    raw.split(", ")
        .filter(|s| !s.is_empty())
        .flat_map(|part| {
            let d = |kind, label: &str| RefDecor {
                kind,
                label: label.to_owned(),
            };
            if let Some(branch) = part.strip_prefix("HEAD -> ") {
                vec![d(RefKind::Head, "HEAD"), d(RefKind::Branch, branch)]
            } else if part == "HEAD" {
                vec![d(RefKind::Head, "HEAD")]
            } else if let Some(tag) = part.strip_prefix("tag: ") {
                vec![d(RefKind::Tag, tag)]
            } else if part.contains('/') {
                vec![d(RefKind::Remote, part)]
            } else {
                vec![d(RefKind::Branch, part)]
            }
        })
        .collect()
}

/// 一天的毫秒数。
const DAY_MS: i64 = 86_400_000;

/// 相对时间（git graph 行尾 + 详情 Date 用）。
/// 今天 → 刚刚 / N 分钟前 / N 小时前；昨天（**日历日**，不是 24h）→「昨天 HH:MM」；
/// 更早 → N 天前 / N 个月前 / N 年前。
///
/// 日历日需要时区：由调用方传入 `utc_offset_secs`（本地时区相对 UTC 的偏移）。
/// core 不依赖时区库——时区是展示层的事，测试用固定偏移即可确定性复现。
pub fn relative_time(unix_sec: i64, now_ms: i64, utc_offset_secs: i64) -> String {
    let local = |ms: i64| ms + utc_offset_secs * 1000;
    let day_start = |ms: i64| local(ms).div_euclid(DAY_MS) * DAY_MS;
    let (today, day) = (day_start(now_ms), day_start(unix_sec * 1000));

    if day == today {
        let s = (now_ms / 1000 - unix_sec).max(0);
        return match s {
            s if s < 60 => "刚刚".into(),
            s if s < 3600 => format!("{} 分钟前", s / 60),
            s => format!("{} 小时前", s / 3600),
        };
    }
    if day == today - DAY_MS {
        let sod = local(unix_sec * 1000).rem_euclid(DAY_MS) / 1000;
        return format!("昨天 {:02}:{:02}", sod / 3600, sod % 3600 / 60);
    }
    let days = (today - day) / DAY_MS;
    if days < 30 {
        return format!("{days} 天前");
    }
    let mo = days / 30;
    if mo < 12 {
        format!("{mo} 个月前")
    } else {
        format!("{} 年前", mo / 12)
    }
}

// ── 变更文件树（vscode-git-graph 式单子目录折叠）────────────────────

/// 目录节点。`BTreeMap` 保证遍历顺序稳定（旧 TS 靠对象插入序，两者对"按路径出现序"的需求不同：
/// 视图按名排序更符合文件树习惯，且让快照测试确定）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileTreeNode {
    pub dirs: BTreeMap<String, FileTreeNode>,
    pub files: Vec<ChangedFile>,
}

/// 清理路径片段首尾及重复的 `/`。
fn clean_slashes(s: &str) -> String {
    s.split('/')
        .filter(|seg| !seg.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// 将 `git show --numstat` 的路径（含 `{old => new}` 或 `old => new` 重命名语法）
/// 拆分为 `(公共父目录段, 展示用文件名)`。
///
/// - 普通路径 `"src/pages/index.ts"` → `(["src", "pages"], "index.ts")`
/// - 花括号重命名 `"packages/native/src/{ => elements}/git_graph.rs"`
///   → `(["packages", "native", "src"], "git_graph.rs → elements/git_graph.rs")`
/// - 花括号重命名 `"packages/native/src/{element.rs => elements/terminal.rs}"`
///   → `(["packages", "native", "src"], "element.rs → elements/terminal.rs")`
pub fn split_changed_file_path(path: &str) -> (Vec<&str>, String) {
    if let (Some(open), Some(close)) = (path.find('{'), path.find('}'))
        && open < close
        && let Some((old_mid, new_mid)) = path[open + 1..close].split_once(" => ")
    {
        let prefix = path[..open].trim_end_matches('/');
        let dirs: Vec<&str> = if prefix.is_empty() {
            vec![]
        } else {
            prefix.split('/').filter(|s| !s.is_empty()).collect()
        };
        let suffix = &path[close + 1..];
        let old_rel = clean_slashes(&format!("{old_mid}{suffix}"));
        let new_rel = clean_slashes(&format!("{new_mid}{suffix}"));
        return (dirs, format!("{old_rel} → {new_rel}"));
    }
    if let Some((old_full, new_full)) = path.split_once(" => ") {
        return (
            vec![],
            format!("{} → {}", clean_slashes(old_full), clean_slashes(new_full)),
        );
    }
    let mut parts: Vec<&str> = path.split('/').collect();
    let name = parts.pop().unwrap_or_default().to_owned();
    (parts, name)
}

/// 提取变更文件在文件树叶子行的展示名（自动展开美化 `{old => new}` 重命名语法）。
pub fn display_file_name(path: &str) -> String {
    split_changed_file_path(path).1
}

/// 将 `git show --numstat` 的原始路径还原为工作区中的目标新路径（用于点击打开文件）。
pub fn resolve_changed_file_path(path: &str) -> String {
    if let (Some(open), Some(close)) = (path.find('{'), path.find('}'))
        && open < close
        && let Some((_, new_mid)) = path[open + 1..close].split_once(" => ")
    {
        let prefix = &path[..open];
        let suffix = &path[close + 1..];
        return clean_slashes(&format!("{prefix}{new_mid}{suffix}"));
    }
    if let Some((_, new_full)) = path.split_once(" => ") {
        return clean_slashes(new_full);
    }
    path.to_owned()
}

pub fn nest_changed_files(files: &[ChangedFile]) -> FileTreeNode {
    let mut root = FileTreeNode::default();
    for f in files {
        let (parts, _) = split_changed_file_path(&f.path);
        let mut n = &mut root;
        for p in parts {
            n = n.dirs.entry(p.to_owned()).or_default();
        }
        n.files.push(f.clone());
    }
    root
}

/// 连续「单子目录、无文件」链折叠为 `a / b / c`。
pub fn compact_dir<'a>(name: &str, node: &'a FileTreeNode) -> (String, &'a FileTreeNode) {
    let mut parts = vec![name.to_owned()];
    let mut n = node;
    while n.dirs.len() == 1 && n.files.is_empty() {
        let (only, child) = n.dirs.iter().next().expect("len == 1");
        parts.push(only.clone());
        n = child;
    }
    (parts.join(" / "), n)
}

// ── 工作区完整多级文件树（Zed 风格 Project Panel 数据模型）──────────

/// 工作区文件树中的叶子文件条目（附带可选的 Git 变更状态与增删行数）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceFileEntry {
    /// 相对工作区根的完整路径（如 `"crates/jagent-app/src/views/root.rs"`）
    pub path: String,
    /// 叶子文件名（如 `"root.rs"`）
    pub name: String,
    pub status: Option<WorktreeFileKind>,
    pub added: Option<u32>,
    pub deleted: Option<u32>,
}

/// 工作区多级文件树目录节点。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkspaceTreeNode {
    pub dirs: BTreeMap<String, WorkspaceTreeNode>,
    pub files: Vec<WorkspaceFileEntry>,
    /// 子孙节点的聚合 Git 状态（优先级：`M > A > D`）
    pub aggregated_status: Option<WorktreeFileKind>,
}

fn merge_status(
    a: Option<WorktreeFileKind>,
    b: Option<WorktreeFileKind>,
) -> Option<WorktreeFileKind> {
    let rank = |k: WorktreeFileKind| match k {
        WorktreeFileKind::M => 3u8,
        WorktreeFileKind::A => 2u8,
        WorktreeFileKind::D => 1u8,
    };
    match (a, b) {
        (Some(x), Some(y)) => {
            if rank(x) >= rank(y) {
                Some(x)
            } else {
                Some(y)
            }
        }
        (Some(x), None) => Some(x),
        (None, Some(y)) => Some(y),
        (None, None) => None,
    }
}

fn matches_filter(path: &str, query_terms: &[String]) -> bool {
    if query_terms.is_empty() {
        return true;
    }
    let lower = path.to_lowercase();
    query_terms.iter().all(|t| lower.contains(t.as_str()))
}

/// 将工作区全量文件路径与 Git 变更列表融合为多级目录树，支持多词大小写无关过滤。
pub fn build_workspace_tree(
    all_files: &[String],
    changed: &[WorktreeFile],
    filter_query: &str,
) -> WorkspaceTreeNode {
    let changed_map: HashMap<&str, &WorktreeFile> =
        changed.iter().map(|f| (f.path.as_str(), f)).collect();

    let mut unique_paths: BTreeSet<&str> = all_files
        .iter()
        .map(String::as_str)
        .filter(|p| !p.is_empty())
        .collect();
    for c in changed {
        if !c.path.is_empty() {
            unique_paths.insert(c.path.as_str());
        }
    }

    let query_terms: Vec<String> = filter_query
        .split_whitespace()
        .map(|s| s.to_lowercase())
        .collect();

    let mut root = WorkspaceTreeNode::default();
    for path in unique_paths {
        if !matches_filter(path, &query_terms) {
            continue;
        }
        let mut parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let Some(name) = parts.pop() else {
            continue;
        };
        let ch = changed_map.get(path).copied();
        let status = ch.map(|c| c.status);
        let entry = WorkspaceFileEntry {
            path: path.to_owned(),
            name: name.to_owned(),
            status,
            added: ch.and_then(|c| c.added),
            deleted: ch.and_then(|c| c.deleted),
        };

        let mut cur = &mut root;
        cur.aggregated_status = merge_status(cur.aggregated_status, status);
        for seg in parts {
            cur = cur.dirs.entry(seg.to_owned()).or_default();
            cur.aggregated_status = merge_status(cur.aggregated_status, status);
        }
        cur.files.push(entry);
    }
    root
}

/// 连续「单子目录、无直接文件」链折叠为 `(完整相对路径, 展示名 "a/b/c", 目标节点)`。
pub fn compact_workspace_dir<'a>(
    parent_rel: &str,
    name: &str,
    node: &'a WorkspaceTreeNode,
) -> (String, String, &'a WorkspaceTreeNode) {
    let mut names = vec![name.to_owned()];
    let mut full = if parent_rel.is_empty() {
        name.to_owned()
    } else {
        format!("{parent_rel}/{name}")
    };
    let mut n = node;
    while n.dirs.len() == 1 && n.files.is_empty() {
        let (only, child) = n.dirs.iter().next().expect("len == 1");
        names.push(only.clone());
        full.push('/');
        full.push_str(only);
        n = child;
    }
    (full, names.join("/"), n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use RefKind::*;

    fn r(kind: RefKind, label: &str) -> RefDecor {
        RefDecor {
            kind,
            label: label.into(),
        }
    }

    #[test]
    fn ref_names_empty_and_head_forms() {
        assert!(parse_ref_names("").is_empty());
        assert_eq!(
            parse_ref_names("HEAD -> main"),
            [r(Head, "HEAD"), r(Branch, "main")]
        );
        assert_eq!(parse_ref_names("HEAD"), [r(Head, "HEAD")], "detached HEAD");
    }

    #[test]
    fn ref_names_classify_branch_remote_and_tag() {
        assert_eq!(parse_ref_names("main"), [r(Branch, "main")]);
        assert_eq!(parse_ref_names("origin/main"), [r(Remote, "origin/main")]);
        assert_eq!(parse_ref_names("tag: v1.0"), [r(Tag, "v1.0")]);
    }

    #[test]
    fn ref_names_known_limitation_a_local_branch_with_a_slash_looks_remote() {
        // 沿用旧规则：这是「已知缺陷」而不是期望行为，测试把它锁住，改规则时要有意识地改这条。
        assert_eq!(parse_ref_names("feature/x"), [r(Remote, "feature/x")]);
    }

    #[test]
    fn ref_names_mixed_decorations_keep_their_order() {
        assert_eq!(
            parse_ref_names("HEAD -> dev, origin/dev, tag: v0.9.0, main"),
            [
                r(Head, "HEAD"),
                r(Branch, "dev"),
                r(Remote, "origin/dev"),
                r(Tag, "v0.9.0"),
                r(Branch, "main")
            ]
        );
    }

    // 2027-01-15 08:00:00 UTC。固定 UTC+8 → 本地 2027-01-15 16:00。
    const NOW_MS: i64 = 1_800_000_000_000;
    const TZ: i64 = 8 * 3600;
    fn at(sec_ago: i64) -> i64 {
        NOW_MS / 1000 - sec_ago
    }

    #[test]
    fn relative_time_ladder() {
        let t = |s: i64| relative_time(at(s), NOW_MS, TZ);
        assert_eq!(t(30), "刚刚");
        assert_eq!(t(59), "刚刚");
        assert_eq!(t(61), "1 分钟前");
        assert_eq!(t(3599), "59 分钟前");
        assert_eq!(t(3600), "1 小时前");
        assert_eq!(t(29 * 86_400), "29 天前");
        assert_eq!(t(30 * 86_400), "1 个月前");
        assert_eq!(t(350 * 86_400), "11 个月前");
        assert_eq!(t(366 * 86_400), "1 年前");
        assert_eq!(t(800 * 86_400), "2 年前");
    }

    #[test]
    fn yesterday_is_a_calendar_day_not_24_hours() {
        // now 本地 = 16:00。昨天 23:59 只是 ~16 小时前，昨天 00:01 是 ~40 小时前——都应是「昨天」
        let local_midnight = (NOW_MS / 1000 + TZ).div_euclid(86_400) * 86_400 - TZ; // 今天本地 00:00 的 unix 秒
        assert_eq!(relative_time(local_midnight - 60, NOW_MS, TZ), "昨天 23:59");
        assert_eq!(
            relative_time(local_midnight - 86_400 + 60, NOW_MS, TZ),
            "昨天 00:01"
        );
        // 再早一秒就是前天 23:59 → 「2 天前」
        assert_eq!(
            relative_time(local_midnight - 86_400 - 60, NOW_MS, TZ),
            "2 天前"
        );
    }

    #[test]
    fn the_timezone_decides_which_calendar_day_a_timestamp_belongs_to() {
        let t = at(2 * 3600); // 两小时前
        // UTC+8：now 本地 16:00，两小时前仍是今天 → 小时前
        assert_eq!(relative_time(t, NOW_MS, 8 * 3600), "2 小时前");
        // UTC-12：now 本地 = 前一天 20:00（00:00 UTC-12 偏移让日历日不同），两小时前 18:00 仍同一天
        assert_eq!(relative_time(t, NOW_MS, -12 * 3600), "2 小时前");
        // 构造跨日：把 now 放到本地 00:30，一小时前就是昨天
        let now = (NOW_MS / 1000 + TZ).div_euclid(86_400) * 86_400 - TZ + 30 * 60; // 今天本地 00:30
        assert_eq!(relative_time(now - 3600, now * 1000, TZ), "昨天 23:30");
    }

    #[test]
    fn future_timestamps_clamp_to_just_now() {
        assert_eq!(relative_time(NOW_MS / 1000 + 120, NOW_MS, TZ), "刚刚");
    }

    fn f(path: &str) -> ChangedFile {
        ChangedFile {
            path: path.into(),
            added: Some(1),
            deleted: Some(0),
        }
    }

    #[test]
    fn nest_splits_by_path_segments() {
        let root = nest_changed_files(&[f("a.ts"), f("src/b.ts")]);
        assert_eq!(
            root.files
                .iter()
                .map(|x| x.path.as_str())
                .collect::<Vec<_>>(),
            ["a.ts"]
        );
        assert_eq!(root.dirs.keys().collect::<Vec<_>>(), ["src"]);
        assert_eq!(root.dirs["src"].files[0].path, "src/b.ts");
    }

    #[test]
    fn a_single_child_chain_collapses_into_a_slash_separated_name() {
        let root = nest_changed_files(&[f("src/pages/index.ts")]);
        let (name, node) = compact_dir("src", &root.dirs["src"]);
        assert_eq!(name, "src / pages");
        assert_eq!(node.files[0].path, "src/pages/index.ts");
    }

    #[test]
    fn a_dir_that_holds_files_does_not_collapse() {
        let root = nest_changed_files(&[f("src/a.ts"), f("src/pages/b.ts")]);
        let (name, node) = compact_dir("src", &root.dirs["src"]);
        assert_eq!(name, "src");
        assert_eq!(node.dirs.keys().collect::<Vec<_>>(), ["pages"]);
    }

    #[test]
    fn sibling_dirs_do_not_collapse() {
        let root = nest_changed_files(&[f("src/a/x.ts"), f("src/b/y.ts")]);
        let (name, node) = compact_dir("src", &root.dirs["src"]);
        assert_eq!(name, "src");
        assert_eq!(node.dirs.keys().collect::<Vec<_>>(), ["a", "b"]);
    }

    #[test]
    fn deep_chains_collapse_all_the_way() {
        let root = nest_changed_files(&[f("a/b/c/d/e.rs")]);
        assert_eq!(compact_dir("a", &root.dirs["a"]).0, "a / b / c / d");
    }

    #[test]
    fn brace_rename_paths_keep_common_parent_dir_and_format_clean_display_and_target() {
        let p1 = "packages/native/src/{ => elements}/git_graph.rs";
        assert_eq!(
            split_changed_file_path(p1),
            (
                vec!["packages", "native", "src"],
                "git_graph.rs → elements/git_graph.rs".into()
            )
        );
        assert_eq!(
            resolve_changed_file_path(p1),
            "packages/native/src/elements/git_graph.rs"
        );

        let p2 = "packages/native/src/{element.rs => elements/terminal.rs}";
        assert_eq!(
            split_changed_file_path(p2),
            (
                vec!["packages", "native", "src"],
                "element.rs → elements/terminal.rs".into()
            )
        );
        assert_eq!(
            resolve_changed_file_path(p2),
            "packages/native/src/elements/terminal.rs"
        );

        let root = nest_changed_files(&[f(p1), f(p2), f("packages/native/src/lib.rs")]);
        let (collapsed, node) = compact_dir("packages", &root.dirs["packages"]);
        assert_eq!(collapsed, "packages / native / src");
        assert_eq!(node.files.len(), 3);
    }

    #[test]
    fn workspace_tree_merges_status_filters_and_compacts_single_child_dirs() {
        let all = vec![
            "README.md".to_owned(),
            "crates/jagent-app/src/views/root.rs".to_owned(),
            "crates/jagent-app/src/views/sidebar.rs".to_owned(),
            "crates/jagent-core/src/lib.rs".to_owned(),
        ];
        let changed = vec![
            WorktreeFile {
                path: "crates/jagent-app/src/views/root.rs".into(),
                status: WorktreeFileKind::M,
                added: Some(10),
                deleted: Some(2),
            },
            WorktreeFile {
                path: "deleted.txt".into(),
                status: WorktreeFileKind::D,
                added: Some(0),
                deleted: Some(5),
            },
        ];
        let tree = build_workspace_tree(&all, &changed, "");
        assert_eq!(tree.files.len(), 2, "README.md + deleted.txt");
        assert_eq!(tree.aggregated_status, Some(WorktreeFileKind::M));
        let crates_node = &tree.dirs["crates"];
        assert_eq!(crates_node.aggregated_status, Some(WorktreeFileKind::M));
        let (rel, label, views_node) =
            compact_workspace_dir("crates", "jagent-app", &crates_node.dirs["jagent-app"]);
        assert_eq!(rel, "crates/jagent-app/src/views");
        assert_eq!(label, "jagent-app/src/views");
        assert_eq!(views_node.files.len(), 2);

        let filtered = build_workspace_tree(&all, &changed, "app root");
        assert!(filtered.files.is_empty());
        assert_eq!(filtered.dirs.keys().collect::<Vec<_>>(), ["crates"]);
    }
}
