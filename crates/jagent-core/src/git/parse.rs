//! `git` 输出解析（零 IO）。协议照抄 Zed `crates/git/src/repository.rs`：`--format` 用 `\x00` 分字段。

use super::types::{ChangedFile, GitBranch, GraphCommit, WorktreeFileKind};

/// 单行解析：字段数 < 10 或空 sha → `None`（坏行丢弃不炸）。
pub fn parse_log_line(line: &str) -> Option<GraphCommit> {
    if line.is_empty() {
        return None;
    }
    let parts: Vec<&str> = line.split('\0').collect();
    if parts.len() < 10 || parts[0].is_empty() {
        return None;
    }
    // subject 是最后一个字段，不会含 \0（git 不允许）
    Some(GraphCommit {
        sha: parts[0].to_owned(),
        parents: parts[1].split_whitespace().map(str::to_owned).collect(),
        ref_names: if parts[2].is_empty() {
            vec![]
        } else {
            parts[2].split(", ").filter(|s| !s.is_empty()).map(str::to_owned).collect()
        },
        short_sha: parts[3].to_owned(),
        author_name: parts[4].to_owned(),
        author_email: parts[5].to_owned(),
        timestamp: parts[6].parse().unwrap_or(0),
        committer_name: parts[7].to_owned(),
        committer_email: parts[8].to_owned(),
        subject: parts[9].to_owned(),
    })
}

/// 流式字节 → 完整行（`\n` 切）。跨 chunk 的半行（含被切断的多字节 UTF-8 序列）留在缓冲里。
#[derive(Default)]
pub struct LineBuffer {
    buf: Vec<u8>,
}

impl LineBuffer {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut lines = vec![];
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            lines.push(String::from_utf8_lossy(&line[..line.len() - 1]).into_owned());
        }
        lines
    }

    /// 流结束：冲掉残留（git log 末行无换行的兜底）。
    pub fn flush(&mut self) -> Vec<String> {
        if self.buf.is_empty() {
            return vec![];
        }
        let rest = String::from_utf8_lossy(&std::mem::take(&mut self.buf)).into_owned();
        vec![rest]
    }
}

/// `git diff-tree --numstat` / `git show --numstat --format=` 输出解析。
pub fn parse_changed_files(raw: &str) -> Vec<ChangedFile> {
    raw.lines()
        .filter_map(|line| {
            let mut it = line.splitn(3, '\t');
            let (a, d, path) = (it.next()?, it.next()?, it.next()?);
            if path.is_empty() {
                return None;
            }
            let num = |s: &str| if s == "-" { None } else { Some(s.parse().unwrap_or(0)) };
            Some(ChangedFile { path: path.to_owned(), added: num(a), deleted: num(d) })
        })
        .collect()
}

/// `git for-each-ref --format=%(refname:short)%x00%(HEAD)` refs/heads。
pub fn parse_branches(raw: &str) -> Vec<GitBranch> {
    raw.lines()
        .filter_map(|line| {
            let mut it = line.split('\0');
            let name = it.next().filter(|n| !n.is_empty())?;
            Some(GitBranch { name: name.to_owned(), current: it.next() == Some("*") })
        })
        .collect()
}

/// `git status --porcelain=v1 -z` 解析。条目 `XY<sp>path\0`；重命名 / 复制在 `-z` 下是
/// `XY<sp>new\0old\0`（字段序反转、无箭头）——跳过后一条目。
/// 状态字母取 X（index 侧）优先、Y（worktree 侧）兜底；`??` → `A`。
pub fn parse_status_entries(raw: &str) -> Vec<(String, WorktreeFileKind)> {
    let entries: Vec<&str> = raw.split('\0').collect();
    let mut out = vec![];
    let mut i = 0;
    while i < entries.len() {
        let e = entries[i];
        i += 1;
        let b = e.as_bytes();
        if b.len() < 4 {
            continue;
        }
        let (x, y) = (b[0] as char, b[1] as char);
        let path = &e[3..];
        if path.is_empty() {
            continue;
        }
        if x == 'R' || x == 'C' {
            i += 1; // 消费 old-path 条目
        }
        let letter = if x != ' ' && x != '?' { x } else { y };
        let status = match letter {
            'A' | '?' => WorktreeFileKind::A,
            'D' => WorktreeFileKind::D,
            _ => WorktreeFileKind::M,
        };
        out.push((path.to_owned(), status));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(f: [&str; 10]) -> String {
        f.join("\0")
    }
    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn parse_full_log_line() {
        let b = "b".repeat(40);
        let c = parse_log_line(&line([SHA, &b, "HEAD -> main, tag: v1.0", "abcdef1", "wxj", "wxj@jagent.dev", "1800000000", "wxj", "wxj@jagent.dev", "fix: 解析崩溃"])).unwrap();
        assert_eq!(c.sha, SHA);
        assert_eq!(c.parents, [b]);
        assert_eq!(c.ref_names, ["HEAD -> main", "tag: v1.0"]);
        assert_eq!((c.short_sha.as_str(), c.author_name.as_str(), c.author_email.as_str()), ("abcdef1", "wxj", "wxj@jagent.dev"));
        assert_eq!(c.timestamp, 1_800_000_000);
        assert_eq!(c.subject, "fix: 解析崩溃");
    }

    #[test]
    fn empty_decoration_and_root_commit() {
        let c = parse_log_line(&line([SHA, "", "", "abcdef1", "wxj", "a@b.c", "1800000000", "wxj", "a@b.c", "init"])).unwrap();
        assert!(c.ref_names.is_empty() && c.parents.is_empty());
    }

    #[test]
    fn merge_commit_has_two_parents() {
        let (p1, p2) = ("1".repeat(40), "2".repeat(40));
        let c = parse_log_line(&line([SHA, &format!("{p1} {p2}"), "", "abcdef1", "w", "w@x", "0", "w", "w@x", "m"])).unwrap();
        assert_eq!(c.parents, [p1, p2]);
    }

    #[test]
    fn commas_in_the_subject_are_not_split() {
        let c = parse_log_line(&line([SHA, "", "", "abcdef1", "w", "w@x", "0", "w", "w@x", "a, b, c"])).unwrap();
        assert_eq!(c.subject, "a, b, c");
    }

    #[test]
    fn bad_lines_are_dropped() {
        assert_eq!(parse_log_line(""), None);
        assert_eq!(parse_log_line("only-three\0fields\0here"), None);
        assert_eq!(parse_log_line("\0p\0\0s\0a\0e\0t\0cn\0ce\0subj"), None, "空 sha");
    }

    #[test]
    fn bad_timestamp_falls_back_to_zero() {
        let c = parse_log_line(&line([SHA, "", "", "abcdef1", "w", "w@x", "not-a-number", "w", "w@x", "s"])).unwrap();
        assert_eq!(c.timestamp, 0);
    }

    #[test]
    fn line_buffer_joins_a_line_split_across_pushes() {
        let mut lb = LineBuffer::default();
        let raw = b"abc\ndef\nghi";
        assert_eq!(lb.push(&raw[..5]), ["abc"]);
        assert_eq!(lb.push(&raw[5..]), ["def"]);
        assert_eq!(lb.flush(), ["ghi"]);
        assert!(lb.flush().is_empty());
    }

    #[test]
    fn line_buffer_many_lines_at_once_and_tail_goes_to_flush() {
        let mut lb = LineBuffer::default();
        assert_eq!(lb.push(b"l1\nl2\nl3\n"), ["l1", "l2", "l3"]);
        assert!(lb.push(b"tail").is_empty());
        assert_eq!(lb.flush(), ["tail"]);
    }

    #[test]
    fn line_buffer_survives_a_multibyte_char_split_mid_sequence() {
        let mut lb = LineBuffer::default();
        let raw = "中文提交\nnext".as_bytes();
        assert!(lb.push(&raw[..3 + 1]).is_empty(), "切在第二个汉字的 UTF-8 序列中间");
        assert_eq!(lb.push(&raw[4..]), ["中文提交"], "拼回后不是乱码");
        assert_eq!(lb.flush(), ["next"]);
    }

    #[test]
    fn numstat_three_columns() {
        let f = parse_changed_files("12\t4\tsrc/a.ts\n0\t3\tdocs/x.md\n");
        assert_eq!(f, [
            ChangedFile { path: "src/a.ts".into(), added: Some(12), deleted: Some(4) },
            ChangedFile { path: "docs/x.md".into(), added: Some(0), deleted: Some(3) },
        ]);
    }

    #[test]
    fn numstat_binary_and_bad_lines() {
        let f = parse_changed_files("-\t-\ticon.png\nnot-a-numstat-line\n1\t1\tok.ts");
        assert_eq!(f, [
            ChangedFile { path: "icon.png".into(), added: None, deleted: None },
            ChangedFile { path: "ok.ts".into(), added: Some(1), deleted: Some(1) },
        ]);
    }

    #[test]
    fn numstat_path_may_contain_tabs_after_the_second_one() {
        let f = parse_changed_files("1\t2\ta\tb.txt");
        assert_eq!(f[0].path, "a\tb.txt");
    }

    #[test]
    fn branches_mark_head_and_skip_blank_lines() {
        let b = parse_branches("main\0*\nfeat/ime\0\n\nfix/titlebar\0");
        assert_eq!(b, [
            GitBranch { name: "main".into(), current: true },
            GitBranch { name: "feat/ime".into(), current: false },
            GitBranch { name: "fix/titlebar".into(), current: false },
        ]);
    }

    #[test]
    fn status_entries_cover_modified_added_deleted_untracked() {
        use WorktreeFileKind::*;
        let raw = " M src/a.rs\0A  new.rs\0 D gone.rs\0?? untracked.rs\0";
        assert_eq!(parse_status_entries(raw), [
            ("src/a.rs".into(), M), ("new.rs".into(), A), ("gone.rs".into(), D), ("untracked.rs".into(), A),
        ]);
    }

    #[test]
    fn status_rename_consumes_the_old_path_entry() {
        use WorktreeFileKind::*;
        // -z 下重命名是 `R  new\0old\0`；old 不能被当成一个独立条目
        let raw = "R  new.rs\0old.rs\0 M other.rs\0";
        assert_eq!(parse_status_entries(raw), [("new.rs".into(), M), ("other.rs".into(), M)]);
    }

    #[test]
    fn status_index_side_wins_over_worktree_side() {
        use WorktreeFileKind::*;
        assert_eq!(parse_status_entries("AM both.rs\0")[0].1, A, "X=A 优先于 Y=M");
        assert_eq!(parse_status_entries("MD both.rs\0")[0].1, M, "X=M 优先于 Y=D");
    }

    #[test]
    fn status_ignores_short_or_empty_entries() {
        assert!(parse_status_entries("").is_empty());
        assert!(parse_status_entries("\0\0").is_empty());
        assert!(parse_status_entries("ab\0").is_empty());
    }
}
