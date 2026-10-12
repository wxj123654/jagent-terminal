//! 工作区纯函数面：state.json 解析 / 序列化、派生视图、排序、搜索（对应旧 `threads/workspaces.ts`）。
//!
//! state.json 的容错纪律与 settings 同源：坏 JSON / 未知结构 → 空列表；
//! **逐行**容错——单行损坏只剔除该行，不抹掉全部工作区。

use serde_json::{Map, Value};

use super::model::{PaneTab, Thread, Workspace, workspace_display_name};

fn bool_or(o: &Map<String, Value>, k: &str, d: bool) -> bool {
    o.get(k).and_then(Value::as_bool).unwrap_or(d)
}

fn string_or_empty(o: &Map<String, Value>, k: &str) -> String {
    o.get(k).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// 解析 state.json 内容（装配期一次性）：
/// - `None` / 坏 JSON / 顶层不是含 `workspaces` 数组的对象 → 空列表（调用方回退默认工作区）；
/// - 缺 `id` 或缺 `path`（或为空串）的行剔除；
/// - 其余坏字段回默认（expanded=true、lastSession=None、paneTab=home、showAll/pin=false、createdAt=0、name=""）。
pub fn parse_workspace_state(raw: Option<&str>) -> Vec<Workspace> {
    let Some(raw) = raw else { return vec![] };
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(raw) else { return vec![] };
    let Some(Value::Array(rows)) = root.get("workspaces") else { return vec![] };
    rows.iter()
        .filter_map(|row| {
            let o = row.as_object()?;
            let id = o.get("id")?.as_str()?.to_owned();
            let path = o.get("path")?.as_str()?.to_owned();
            // 无 id 无从引用；无 path 的目录语义不成立。name 可由 path 兜底恢复，允许空。
            if id.is_empty() || path.is_empty() {
                return None;
            }
            Some(Workspace {
                id,
                name: string_or_empty(o, "name"),
                path,
                expanded: bool_or(o, "expanded", true),
                last_session: o.get("lastSession").and_then(Value::as_str).map(str::to_owned),
                pane_tab: match o.get("paneTab").and_then(Value::as_str) {
                    Some("git") => PaneTab::Git,
                    _ => PaneTab::Home,
                },
                show_all: bool_or(o, "showAll", false),
                pin: bool_or(o, "pin", false),
                created_at: o.get("createdAt").and_then(Value::as_i64).unwrap_or(0),
            })
        })
        .collect()
}

/// 序列化形态（与 settings 同风格：2 空格缩进 + 尾换行）。
pub fn serialize_workspace_state(workspaces: &[Workspace]) -> String {
    #[derive(serde::Serialize)]
    struct State<'a> {
        workspaces: &'a [Workspace],
    }
    let mut s = serde_json::to_string_pretty(&State { workspaces }).expect("workspace serialize");
    s.push('\n');
    s
}

/// 首启默认工作区（装配层在 state.json 为空时建；name = 目录 basename）。
pub fn default_workspace(id: String, path: &str, now: i64) -> Workspace {
    Workspace {
        id,
        name: workspace_display_name(path),
        path: path.to_owned(),
        expanded: true,
        last_session: None,
        pane_tab: PaneTab::Home,
        show_all: false,
        pin: false,
        created_at: now,
    }
}

/// 工作区的会话（创建序派生视图——侧栏分组渲染与「最后一个会话」判定用）。
pub fn workspace_sessions<'a>(threads: &'a [Thread], workspace_id: &str) -> Vec<&'a Thread> {
    threads.iter().filter(|t| t.workspace_id() == Some(workspace_id)).collect()
}

// ── lastSession 不变量（store 的唯一规则写点）─────────────────────────

/// 会话聚焦 → 归属工作区记录 last_session。实际变化返回 true（store 拿它做 persist 判据）。
pub fn record_last_session(workspaces: &mut [Workspace], workspace_id: &str, thread_id: &str) -> bool {
    match workspaces.iter_mut().find(|w| w.id == workspace_id) {
        Some(ws) if ws.last_session.as_deref() != Some(thread_id) => {
            ws.last_session = Some(thread_id.to_owned());
            true
        }
        _ => false,
    }
}

/// 会话移除 → 若是所属工作区 last_session 则清空。实际变化返回 true。
pub fn clear_last_session(workspaces: &mut [Workspace], workspace_id: &str, thread_id: &str) -> bool {
    match workspaces.iter_mut().find(|w| w.id == workspace_id) {
        Some(ws) if ws.last_session.as_deref() == Some(thread_id) => {
            ws.last_session = None;
            true
        }
        _ => false,
    }
}

// ── 优先级排序 ───────────────────────────────────────────────────────

/// 会话优先级桶（小 = 靠前）：run=进行中 > queue=等待注意 > unread=未读 > 其余。
/// terminal 的存活不算 run（PTY 活着 ≠ agent 在工作，诚实语义）。
pub fn thread_priority(t: &Thread) -> u8 {
    let unread_bucket = |unread: bool| if unread { 2 } else { 3 };
    match t {
        Thread::Terminal(t) => {
            if t.has_bell {
                1
            } else {
                unread_bucket(t.common.unread)
            }
        }
        Thread::Chat(c) => conversation_priority(c.pending_reply, &c.messages, c.common.unread),
        Thread::Acp(a) => conversation_priority(a.pending_reply, &a.messages, a.common.unread),
    }
}

fn conversation_priority(pending: bool, messages: &[super::model::ChatMessage], unread: bool) -> u8 {
    if pending {
        return 0;
    }
    if messages.last().is_some_and(|m| m.is_error()) {
        return 3;
    }
    if unread { 2 } else { 3 }
}

/// 组内会话排序：pin > run > queue > unread > recency。
/// recency = created_at 新→旧；同毫秒并列兜底原数组序倒排（数组尾 = 最新）。
pub fn sort_threads(threads: &[Thread]) -> Vec<&Thread> {
    let mut v: Vec<(usize, &Thread)> = threads.iter().enumerate().collect();
    v.sort_by(|(ia, a), (ib, b)| {
        b.common()
            .pin
            .cmp(&a.common().pin)
            .then(thread_priority(a).cmp(&thread_priority(b)))
            .then(b.created_at().cmp(&a.created_at()))
            .then(ib.cmp(ia))
    });
    v.into_iter().map(|(_, t)| t).collect()
}

/// 工作区排序：pin 在前，创建序内稳定。
pub fn sort_workspaces(workspaces: &[Workspace]) -> Vec<&Workspace> {
    let mut v: Vec<&Workspace> = workspaces.iter().collect();
    v.sort_by(|a, b| b.pin.cmp(&a.pin).then(a.created_at.cmp(&b.created_at)));
    v
}

/// 相对时间标签（通知中心 sub）。
pub fn rel_time(at: i64, now: i64) -> String {
    let diff = (now - at).max(0);
    match diff {
        d if d < 60_000 => "刚刚".into(),
        d if d < 3_600_000 => format!("{} 分钟前", d / 60_000),
        d if d < 86_400_000 => format!("{} 小时前", d / 3_600_000),
        d => format!("{} 天前", d / 86_400_000),
    }
}

// ── 跨工作区搜索 ─────────────────────────────────────────────────────

pub struct SearchHit<'a> {
    pub thread: &'a Thread,
    pub workspace: Option<&'a Workspace>,
}

/// 搜索命中面：标题 + 工具名（调用方注入 preset 查询）+ 目录 + 工作区名/路径，不区分大小写。
/// 空 query 全命中（搜索弹窗空态列全部会话）。
pub fn search_threads<'a>(
    threads: &'a [Thread],
    workspaces: &'a [Workspace],
    query: &str,
    preset_label_of: impl Fn(Option<&str>) -> Option<String>,
) -> Vec<SearchHit<'a>> {
    let q = query.trim().to_lowercase();
    threads
        .iter()
        .filter_map(|t| {
            let ws = t.workspace_id().and_then(|id| workspaces.iter().find(|w| w.id == id));
            let (tool, dir) = match t {
                Thread::Terminal(x) => (
                    preset_label_of(x.preset.as_deref()).unwrap_or_else(|| "Terminal".into()),
                    x.cwd.clone(),
                ),
                Thread::Acp(_) => ("ACP".into(), ws.map(|w| w.path.clone()).unwrap_or_default()),
                Thread::Chat(_) => ("Chat".into(), ws.map(|w| w.path.clone()).unwrap_or_default()),
            };
            let haystack = format!(
                "{} {} {} {} {}",
                t.title(),
                tool,
                dir,
                ws.map_or("", |w| w.name.as_str()),
                ws.map_or("", |w| w.path.as_str()),
            )
            .to_lowercase();
            haystack.contains(&q).then_some(SearchHit { thread: t, workspace: ws })
        })
        .collect()
}

/// 「添加工作区」弹窗的校验（规则在 core，视图只展示错误文案）。
///
/// - 名称与目录至少填一个；
/// - 目录必填且为绝对路径（`/…`、`~/…`、`C:\…`、`\\…`）；
/// - 与既有工作区目录重复（尾部斜杠归一后比较）则拒绝。
///
/// 通过返回 `Ok(())`；名称为空由 `ThreadStore::add_workspace` 用目录 basename 兜底。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceFormError {
    NeedNameOrPath,
    PathRequired,
    PathNotAbsolute,
    DuplicatePath,
}

impl WorkspaceFormError {
    /// 与旧 TS 弹窗一致的提示文案。
    pub fn message(&self) -> &'static str {
        match self {
            Self::NeedNameOrPath => "请填写名称或项目目录。",
            Self::PathRequired => "请填写项目目录。",
            Self::PathNotAbsolute => "请填写绝对路径，例如 ~/Projects/app、/Projects/app 或 C:\\Projects\\app。",
            Self::DuplicatePath => "此目录已有工作区，请从左侧选择，或填写其他目录。",
        }
    }
}

fn is_absolute_path(p: &str) -> bool {
    let b = p.as_bytes();
    p.starts_with('/')
        || p.starts_with("~/")
        || p.starts_with("\\\\")
        || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
}

fn normalize_dir(p: &str) -> &str {
    p.trim_end_matches(['/', '\\'])
}

/// 校验「添加工作区」表单。`name` / `path` 为用户原始输入（未 trim）。
pub fn validate_workspace_form(name: &str, path: &str, existing: &[Workspace]) -> Result<(), WorkspaceFormError> {
    let (name, path) = (name.trim(), path.trim());
    if name.is_empty() && path.is_empty() {
        return Err(WorkspaceFormError::NeedNameOrPath);
    }
    if path.is_empty() {
        return Err(WorkspaceFormError::PathRequired);
    }
    if !is_absolute_path(path) {
        return Err(WorkspaceFormError::PathNotAbsolute);
    }
    if existing.iter().any(|w| normalize_dir(&w.path) == normalize_dir(path)) {
        return Err(WorkspaceFormError::DuplicatePath);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::model::*;
    use super::*;

    fn ws(id: &str, path: &str, created: i64) -> Workspace {
        default_workspace(id.into(), path, created)
    }

    fn chat(id: &str, title: &str, ws_id: Option<&str>) -> Thread {
        Thread::Chat(ChatThread {
            id: id.into(),
            title: title.into(),
            created_at: 0,
            messages: vec![],
            pending_reply: false,
            common: ThreadCommon { workspace_id: ws_id.map(Into::into), ..Default::default() },
        })
    }

    fn term(id: &str, f: impl FnOnce(&mut TerminalThread)) -> Thread {
        let mut t = TerminalThread {
            id: id.into(),
            session_id: 1,
            preset: None,
            cwd: "/w".into(),
            init_command: None,
            osc_title: None,
            custom_title: None,
            status: RunStatus::Running,
            exit_code: None,
            has_bell: false,
            created_at: 0,
            common: ThreadCommon::default(),
        };
        f(&mut t);
        Thread::Terminal(t)
    }

    // ── parse_workspace_state ─────────────────────────────────────

    #[test]
    fn missing_or_bad_json_gives_empty_list() {
        assert!(parse_workspace_state(None).is_empty());
        assert!(parse_workspace_state(Some("")).is_empty());
        assert!(parse_workspace_state(Some("{oops")).is_empty());
    }

    #[test]
    fn unknown_structure_gives_empty_list() {
        assert!(parse_workspace_state(Some(r#"{"foo":1}"#)).is_empty());
        assert!(parse_workspace_state(Some("[1,2]")).is_empty());
    }

    #[test]
    fn full_row_round_trips_and_bad_fields_fall_back() {
        let raw = r#"{"workspaces":[
            {"id":"w1","name":"proj","path":"/a/b","expanded":false,"lastSession":"t3","createdAt":42},
            {"id":"w2","name":"x","path":"/c","lastSession":7},
            {"id":"w3","path":"/d"}
        ]}"#;
        let w = parse_workspace_state(Some(raw));
        assert_eq!(w.len(), 3);
        assert_eq!(
            w[0],
            Workspace {
                id: "w1".into(),
                name: "proj".into(),
                path: "/a/b".into(),
                expanded: false,
                last_session: Some("t3".into()),
                pane_tab: PaneTab::Home,
                show_all: false,
                pin: false,
                created_at: 42,
            }
        );
        assert!(w[1].expanded, "expanded 缺失 → true");
        assert_eq!(w[1].last_session, None, "lastSession 类型坏 → None");
        assert_eq!(w[1].created_at, 0);
        assert_eq!(w[2].name, "", "name 缺失 → 空串（path 兜底是 UI/装配层职责）");
    }

    #[test]
    fn bad_rows_are_dropped_one_bad_row_does_not_nuke_the_rest() {
        let raw = r#"{"workspaces":[
            {"id":"w1","name":"ok","path":"/a"},
            {"id":"","name":"无 id","path":"/b"},
            {"id":"w3","name":"无 path"},
            {"id":"w4","name":"空 path","path":""},
            {"id":"w5","path":7},
            "garbage"
        ]}"#;
        let ids: Vec<_> = parse_workspace_state(Some(raw)).into_iter().map(|w| w.id).collect();
        assert_eq!(ids, ["w1"], "缺 id / 空 id / 缺 path / 空 path / path 类型错 / 非对象 都剔除");
    }

    #[test]
    fn serialize_then_parse_restores_everything() {
        let list = vec![
            ws("w1", "/Users/u/proj", 1),
            Workspace { expanded: false, last_session: Some("t7".into()), pane_tab: PaneTab::Git, pin: true, ..ws("w2", "/srv/web", 2) },
        ];
        let raw = serialize_workspace_state(&list);
        assert!(raw.ends_with('\n'));
        assert!(raw.contains("\"workspaces\""));
        assert_eq!(parse_workspace_state(Some(&raw)), list);
    }

    // ── 构造与派生 ────────────────────────────────────────────────

    #[test]
    fn default_workspace_uses_basename_and_starts_expanded() {
        let w = default_workspace("w9".into(), "/Users/u/jagent-terminal", 99);
        assert_eq!((w.name.as_str(), w.expanded, w.last_session.clone(), w.created_at), ("jagent-terminal", true, None, 99));
    }

    #[test]
    fn workspace_sessions_filters_by_creation_order() {
        let threads = vec![chat("c1", "c1", Some("w1")), chat("c2", "c2", None), chat("c3", "c3", Some("w2")), chat("c4", "c4", Some("w1"))];
        let ids: Vec<_> = workspace_sessions(&threads, "w1").iter().map(|t| t.id().to_owned()).collect();
        assert_eq!(ids, ["c1", "c4"]);
        assert!(workspace_sessions(&threads, "w-none").is_empty());
    }

    #[test]
    fn last_session_record_and_clear_report_actual_changes_only() {
        let mut w = vec![ws("w1", "/a", 0)];
        assert!(record_last_session(&mut w, "w1", "t1"));
        assert!(!record_last_session(&mut w, "w1", "t1"), "同值不算变化");
        assert!(!record_last_session(&mut w, "nope", "t1"));
        assert!(!clear_last_session(&mut w, "w1", "t9"), "不是 last_session 不清");
        assert!(clear_last_session(&mut w, "w1", "t1"));
        assert_eq!(w[0].last_session, None);
    }

    // ── 搜索 ──────────────────────────────────────────────────────

    #[test]
    fn search_matches_title_tool_dir_and_workspace_name_case_insensitively() {
        let workspaces = vec![ws("w-a", "/w/alpha", 0), Workspace { name: "beta".into(), ..ws("w-b", "/w/beta", 0) }];
        let threads = vec![chat("c-pi", "pi 调试会话", Some("w-a")), chat("c-plain", "c-plain", Some("w-b")), chat("c-orphan", "c-orphan", None)];
        let none = |_: Option<&str>| None;
        let ids = |q: &str| -> Vec<String> { search_threads(&threads, &workspaces, q, none).iter().map(|h| h.thread.id().to_owned()).collect() };

        assert_eq!(ids("pi 调试"), ["c-pi"]);
        assert_eq!(ids("chat"), ["c-pi", "c-plain", "c-orphan"], "工具名 Chat");
        assert_eq!(ids("beta"), ["c-plain"], "工作区名命中；无归属行不进");
        assert_eq!(search_threads(&threads, &workspaces, "beta", none)[0].workspace.unwrap().name, "beta");
        assert_eq!(ids("CHAT").len(), 3);
        assert_eq!(ids("  "), ["c-pi", "c-plain", "c-orphan"], "空 query 全命中");
    }

    #[test]
    fn search_terminal_rows_match_preset_label_and_cwd() {
        let workspaces = vec![ws("w-a", "/w/alpha", 0)];
        let t = vec![term("t1", |t| {
            t.preset = Some("shell".into());
            t.cwd = "/w/alpha/sub".into();
            t.common.workspace_id = Some("w-a".into());
        })];
        let labels = |p: Option<&str>| (p == Some("shell")).then(|| "Shell".to_owned());
        assert_eq!(search_threads(&t, &workspaces, "shell", labels).len(), 1);
        assert_eq!(search_threads(&t, &workspaces, "alpha/sub", |_| None).len(), 1);
        assert_eq!(search_threads(&t, &workspaces, "terminal", |_| None).len(), 1, "未注入 → 工具面回退 Terminal");
    }

    // ── 排序 ──────────────────────────────────────────────────────

    #[test]
    fn threads_sort_pin_then_run_then_queue_then_unread_then_recency() {
        let chat_with = |id: &str, created: i64, f: &dyn Fn(&mut ChatThread)| {
            let Thread::Chat(mut c) = chat(id, id, None) else { unreachable!() };
            c.created_at = created;
            f(&mut c);
            Thread::Chat(c)
        };
        let threads = vec![
            term("t-old", |t| t.created_at = 1),
            chat_with("c-run", 2, &|c| c.pending_reply = true),
            term("t-bell", |t| { t.created_at = 3; t.has_bell = true }),
            chat_with("c-unread", 4, &|c| c.common.unread = true),
            term("t-new", |t| t.created_at = 5),
            chat_with("c-pin", 1, &|c| c.common.pin = true),
        ];
        let ids: Vec<_> = sort_threads(&threads).iter().map(|t| t.id().to_owned()).collect();
        assert_eq!(ids, ["c-pin", "c-run", "t-bell", "c-unread", "t-new", "t-old"]);
    }

    #[test]
    fn live_terminal_is_not_running_and_exited_shares_the_idle_bucket() {
        let Thread::Chat(mut run) = chat("c-run", "c-run", None) else { unreachable!() };
        run.created_at = 2;
        run.pending_reply = true;
        let threads = vec![term("t-live", |t| t.created_at = 1), Thread::Chat(run), term("t-dead", |t| { t.created_at = 3; t.status = RunStatus::Exited })];
        let ids: Vec<_> = sort_threads(&threads).iter().map(|t| t.id().to_owned()).collect();
        assert_eq!(ids, ["c-run", "t-dead", "t-live"]);
    }

    #[test]
    fn same_millisecond_ties_break_by_reverse_array_order() {
        let threads = vec![term("a", |_| {}), term("b", |_| {}), term("c", |_| {})];
        let ids: Vec<_> = sort_threads(&threads).iter().map(|t| t.id().to_owned()).collect();
        assert_eq!(ids, ["c", "b", "a"], "数组尾 = 最新");
    }

    #[test]
    fn failed_assistant_reply_drops_out_of_the_unread_bucket() {
        let Thread::Chat(mut c) = chat("c", "c", None) else { unreachable!() };
        c.common.unread = true;
        c.messages.push(ChatMessage { id: "m1".into(), role: MessageRole::Assistant { error: true }, text: "x".into(), at: 0 });
        assert_eq!(thread_priority(&Thread::Chat(c)), 3);
    }

    #[test]
    fn workspaces_sort_pin_first_then_creation_order() {
        let list = vec![ws("w-a", "/w/a", 1), Workspace { pin: true, ..ws("w-b", "/w/b", 2) }, ws("w-c", "/w/c", 3)];
        let ids: Vec<_> = sort_workspaces(&list).iter().map(|w| w.id.clone()).collect();
        assert_eq!(ids, ["w-b", "w-a", "w-c"]);
    }

    #[test]
    fn rel_time_buckets() {
        assert_eq!(rel_time(0, 59_999), "刚刚");
        assert_eq!(rel_time(0, 5 * 60_000), "5 分钟前");
        assert_eq!(rel_time(0, 3 * 3_600_000), "3 小时前");
        assert_eq!(rel_time(0, 2 * 86_400_000), "2 天前");
        assert_eq!(rel_time(10, 0), "刚刚", "时钟倒退按 0 处理");
    }

    #[test]
    fn workspace_form_requires_a_name_or_a_path_and_an_absolute_path() {
        let none: &[Workspace] = &[];
        assert_eq!(validate_workspace_form("  ", "  ", none), Err(WorkspaceFormError::NeedNameOrPath));
        assert_eq!(validate_workspace_form("app", "", none), Err(WorkspaceFormError::PathRequired));
        assert_eq!(validate_workspace_form("", "relative/dir", none), Err(WorkspaceFormError::PathNotAbsolute));
        assert_eq!(validate_workspace_form("", "app", none), Err(WorkspaceFormError::PathNotAbsolute));
        for ok in ["/Users/u/app", "~/Projects/app", "C:\\Projects\\app", "c:/projects/app", "\\\\server\\share"] {
            assert_eq!(validate_workspace_form("", ok, none), Ok(()), "{ok}");
        }
        // 只填名称、不填路径：路径必填（与旧表单一致）
        assert_eq!(validate_workspace_form("app", "  ", none), Err(WorkspaceFormError::PathRequired));
    }

    #[test]
    fn workspace_form_rejects_a_directory_already_in_use_ignoring_trailing_separators() {
        let existing = [ws("a", "/Users/u/app/", 1), ws("b", "C:\\Projects\\site\\", 2)];
        assert_eq!(validate_workspace_form("", "/Users/u/app", &existing), Err(WorkspaceFormError::DuplicatePath));
        assert_eq!(validate_workspace_form("", "/Users/u/app//", &existing), Err(WorkspaceFormError::DuplicatePath));
        assert_eq!(validate_workspace_form("", "C:\\Projects\\site", &existing), Err(WorkspaceFormError::DuplicatePath));
        assert_eq!(validate_workspace_form("", "/Users/u/other", &existing), Ok(()));
    }

    #[test]
    fn every_form_error_has_the_user_facing_message_from_the_old_dialog() {
        assert_eq!(WorkspaceFormError::PathRequired.message(), "请填写项目目录。");
        assert!(WorkspaceFormError::DuplicatePath.message().starts_with("此目录已有工作区"));
    }
}
