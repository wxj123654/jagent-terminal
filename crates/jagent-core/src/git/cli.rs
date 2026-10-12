//! git CLI 子进程封装：唯一的进程边界。解析在 [`super::parse`]，本文件只负责起进程 / 读流 / 归一错误。
//!
//! 协议照抄 Zed `crates/git/src/repository.rs`：`--format` 用 `\x00` 分字段、`--date-order`、
//! 按 chunk 回调（512 行）。stdout 用 [`LineBuffer`] 流式切行——禁止整体读完再拼接（大 repo 会卡爆）。
//!
//! Windows：GUI 子系统进程没有可继承的 console，spawn console 子进程时系统会给子进程新建一个
//! **可见**控制台窗口（git 面板每次刷新都闪黑框）。必须传 `CREATE_NO_WINDOW`（0x0800_0000）。

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::parse::{
    LineBuffer, parse_branches, parse_changed_files, parse_log_line, parse_status_entries,
};
use super::types::{ChangedFile, GitBranch, GraphCommit, WorktreeFile, WorktreeStatus};

/// Zed 三字段 + 行内详情元数据（email / committer 单行字段；body 含换行，选中时另拉）。
const LOG_FORMAT: &str = "--format=%H%x00%P%x00%D%x00%h%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%s";

/// 流式回调的 chunk 大小（Zed GRAPH_CHUNK_SIZE 同量级：首屏快 + 避免重绘风暴）。
pub const CHUNK_SIZE: usize = 512;

#[derive(Debug)]
pub enum GitError {
    /// git 不可用 / 目录不存在等 spawn 失败
    Spawn(String),
    /// 非 0 退出；携带 stderr 尾部
    Failed {
        code: Option<i32>,
        stderr: String,
    },
    Cancelled,
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(m) => write!(f, "{m}"),
            Self::Failed { code, stderr } if stderr.is_empty() => {
                write!(f, "git exited with {code:?}")
            }
            Self::Failed { stderr, .. } => write!(f, "{stderr}"),
            Self::Cancelled => write!(f, "cancelled"),
        }
    }
}

impl std::error::Error for GitError {}

fn command(args: &[&str], cwd: &Path) -> Command {
    let mut c = Command::new("git");
    c.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

/// 一次性 git 子进程（非流式）。stdout 全文返回；非 0 返回 stderr。
pub fn run_git(cwd: &Path, args: &[&str]) -> Result<String, GitError> {
    let out = command(args, cwd)
        .output()
        .map_err(|e| GitError::Spawn(e.to_string()))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    Err(GitError::Failed {
        code: out.status.code(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
    })
}

/// repo root 检测（`git rev-parse --show-toplevel`）；非 repo / 无 git → `None`。
pub fn find_repo_root(cwd: &Path) -> Option<String> {
    let out = run_git(cwd, &["rev-parse", "--show-toplevel"]).ok()?;
    let root = out.trim();
    (!root.is_empty()).then(|| root.to_owned())
}

/// 取消句柄：`cancel` 幂等；子进程在下次读取时被 kill。
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// 流式 `git log`：阻塞调用，在**调用方的后台线程**里跑；每攒满 [`CHUNK_SIZE`] 条回调一次。
/// stderr 必须同时消费：只读 stdout 会让子进程在 stderr 缓冲区满时卡死。
/// 取消 → kill 子进程并返回 `Err(Cancelled)`，不再回调。
pub fn stream_git_log(
    cwd: &Path,
    cancel: &CancelToken,
    mut on_chunk: impl FnMut(Vec<GraphCommit>),
) -> Result<(), GitError> {
    let mut child = command(&["log", LOG_FORMAT, "--date-order"], cwd)
        .spawn()
        .map_err(|e| GitError::Spawn(e.to_string()))?;
    let mut stderr = child.stderr.take().expect("piped");
    let stderr_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        let keep = s.len().saturating_sub(4096);
        s[s.ceil_char_boundary(keep)..].trim().to_owned()
    });

    let mut stdout = child.stdout.take().expect("piped");
    let mut lb = LineBuffer::default();
    let mut pending: Vec<GraphCommit> = vec![];
    let mut buf = [0u8; 64 * 1024];
    let mut flush = |pending: &mut Vec<GraphCommit>| {
        if !pending.is_empty() {
            on_chunk(std::mem::take(pending));
        }
    };

    loop {
        if cancel.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(GitError::Cancelled);
        }
        let n = match stdout.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitError::Spawn(e.to_string()));
            }
        };
        for line in lb.push(&buf[..n]) {
            if let Some(c) = parse_log_line(&line) {
                pending.push(c);
                if pending.len() >= CHUNK_SIZE {
                    flush(&mut pending);
                }
            }
        }
    }
    for line in lb.flush() {
        if let Some(c) = parse_log_line(&line) {
            pending.push(c);
        }
    }
    flush(&mut pending);

    let status = child.wait().map_err(|e| GitError::Spawn(e.to_string()))?;
    let tail = stderr_thread.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        Err(GitError::Failed {
            code: status.code(),
            stderr: tail,
        })
    }
}

/// 单提交 patch（选中看 diff 用）。空串 = 无变更（空提交 / 根提交的极端）。
pub fn show_patch(cwd: &Path, sha: &str) -> Result<String, GitError> {
    run_git(cwd, &["show", "--format=", "--patch", "--no-color", sha])
}

/// 提交说明正文（`%b`，不含 subject）。多段以换行保留；无正文返回空串。
pub fn show_commit_body(cwd: &Path, sha: &str) -> Result<String, GitError> {
    let raw = run_git(cwd, &["log", "-1", "--format=%b", sha])?;
    Ok(raw.trim_end_matches('\n').to_owned())
}

/// 单提交变更文件（行内详情文件树）。
pub fn list_changed_files(cwd: &Path, sha: &str) -> Result<Vec<ChangedFile>, GitError> {
    Ok(parse_changed_files(&run_git(
        cwd,
        &["show", "--format=", "--numstat", "--no-color", sha],
    )?))
}

/// 本地分支列表（控件条下拉）。
pub fn list_branches(cwd: &Path) -> Result<Vec<GitBranch>, GitError> {
    Ok(parse_branches(&run_git(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(HEAD)",
            "refs/heads",
        ],
    )?))
}

/// 工作区快照：porcelain 状态表 + `git diff HEAD --numstat` 行数合并 + 当前分支。非 repo → `None`。
/// 单条子命令失败（如无 HEAD 的空 repo）降级为空数据而不是整体失败。
pub fn list_worktree_status(cwd: &Path) -> Option<WorktreeStatus> {
    let root = find_repo_root(cwd)?;
    let rootp = Path::new(&root);
    let safe = |args: &[&str]| run_git(rootp, args).unwrap_or_default();
    let status_raw = safe(&["status", "--porcelain=v1", "-z"]);
    let numstat_raw = safe(&["diff", "--numstat", "--no-color", "HEAD", "--"]);
    let branch_raw = safe(&["rev-parse", "--abbrev-ref", "HEAD"]);

    let counts: std::collections::HashMap<String, ChangedFile> = parse_changed_files(&numstat_raw)
        .into_iter()
        .map(|f| (f.path.clone(), f))
        .collect();
    let files = parse_status_entries(&status_raw)
        .into_iter()
        .map(|(path, status)| {
            let c = counts.get(&path);
            WorktreeFile {
                added: c.and_then(|c| c.added),
                deleted: c.and_then(|c| c.deleted),
                path,
                status,
            }
        })
        .collect();
    let branch = branch_raw.trim();
    Some(WorktreeStatus {
        root,
        branch: (!branch.is_empty() && branch != "HEAD").then(|| branch.to_owned()),
        files,
    })
}

/// 单文件 vs HEAD 的 unified patch（工作面板内联 diff）。未跟踪文件 → 空串。
pub fn diff_worktree_file(root: &Path, path: &str) -> Result<String, GitError> {
    run_git(root, &["diff", "--no-color", "HEAD", "--", path])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 在临时目录建一个确定性的 repo：三个提交，其中一个 merge。
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(p)
                .env("GIT_AUTHOR_NAME", "wxj")
                .env("GIT_AUTHOR_EMAIL", "wxj@jagent.dev")
                .env("GIT_COMMITTER_NAME", "wxj")
                .env("GIT_COMMITTER_EMAIL", "wxj@jagent.dev")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .output()
                .expect("git 必须可用");
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(p.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init: first, with comma"]);
        git(&["checkout", "-q", "-b", "feat"]);
        std::fs::write(p.join("b.txt"), "feat\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "feat: b"]);
        git(&["checkout", "-q", "main"]);
        std::fs::write(p.join("a.txt"), "one\ntwo\n").unwrap();
        git(&["commit", "-q", "-am", "main: a\n\nbody line 1\nbody line 2"]);
        git(&["merge", "-q", "--no-ff", "-m", "merge feat", "feat"]);
        dir
    }

    #[test]
    fn find_repo_root_hits_the_root_from_a_subdirectory_and_none_outside() {
        let d = fixture();
        std::fs::create_dir(d.path().join("sub")).unwrap();
        let root = find_repo_root(&d.path().join("sub")).unwrap();
        assert_eq!(
            std::fs::canonicalize(root).unwrap(),
            std::fs::canonicalize(d.path()).unwrap()
        );
        let outside = tempfile::tempdir().unwrap();
        assert_eq!(find_repo_root(outside.path()), None);
        assert_eq!(find_repo_root(Path::new("/definitely/not/a/path")), None);
    }

    #[test]
    fn stream_log_yields_all_commits_newest_first_with_sane_fields() {
        let d = fixture();
        let mut chunks = vec![];
        let mut all: Vec<GraphCommit> = vec![];
        stream_git_log(d.path(), &CancelToken::default(), |c| {
            chunks.push(c.len());
            all.extend(c);
        })
        .unwrap();
        assert_eq!(all.len(), 4, "init, feat, main, merge");
        assert!(chunks.iter().all(|&n| n <= CHUNK_SIZE));
        assert_eq!(chunks.iter().sum::<usize>(), all.len());
        assert_eq!(all[0].subject, "merge feat", "新 → 旧");
        assert_eq!(all[0].parents.len(), 2, "merge 提交双 parent");
        assert_eq!(
            (all[0].author_name.as_str(), all[0].author_email.as_str()),
            ("wxj", "wxj@jagent.dev")
        );
        assert_eq!(all[0].sha.len(), 40);
        assert!(all[0].short_sha.len() >= 7 && all[0].ref_names.iter().any(|r| r.contains("main")));
        assert!(
            all.iter().any(|c| c.subject == "init: first, with comma"),
            "subject 含逗号不被切"
        );
        assert!(all.last().unwrap().parents.is_empty(), "根提交无 parent");
        // 顺序不变量：每个 parent 都出现在子提交之后
        let pos = |sha: &str| all.iter().position(|c| c.sha == sha).unwrap();
        for (i, c) in all.iter().enumerate() {
            assert!(c.parents.iter().all(|p| pos(p) > i));
        }
    }

    #[test]
    fn streamed_log_feeds_the_lane_algorithm_end_to_end() {
        let d = fixture();
        let mut g = super::super::graph::GitGraphData::default();
        stream_git_log(d.path(), &CancelToken::default(), |c| g.add_commits(&c)).unwrap();
        assert_eq!(g.rows.len(), 4);
        assert_eq!(g.max_lanes, 2, "有一个 merge → 两条 lane");
        assert!(!g.lines.is_empty());
    }

    #[test]
    fn stream_log_on_a_non_repo_fails_with_a_reason() {
        let d = tempfile::tempdir().unwrap();
        let err = stream_git_log(d.path(), &CancelToken::default(), |_| {}).unwrap_err();
        assert!(matches!(err, GitError::Failed { .. }));
        assert!(!err.to_string().is_empty());
        let err = stream_git_log(
            Path::new("/definitely/not/a/path"),
            &CancelToken::default(),
            |_| {},
        )
        .unwrap_err();
        assert!(matches!(err, GitError::Spawn(_)));
    }

    #[test]
    fn a_pre_cancelled_stream_calls_back_nothing() {
        let d = fixture();
        let tok = CancelToken::default();
        tok.cancel();
        tok.cancel(); // 幂等
        let mut called = false;
        let r = stream_git_log(d.path(), &tok, |_| called = true);
        assert!(matches!(r, Err(GitError::Cancelled)) && !called);
    }

    #[test]
    fn commit_body_excludes_the_subject_and_may_be_empty() {
        let d = fixture();
        let log = |n: &str| {
            run_git(d.path(), &["log", "-1", "--format=%H", n])
                .unwrap()
                .trim()
                .to_owned()
        };
        let main_commit = run_git(d.path(), &["log", "--format=%H %s", "--all"]).unwrap();
        let sha = main_commit
            .lines()
            .find(|l| l.contains("main: a"))
            .unwrap()
            .split(' ')
            .next()
            .unwrap()
            .to_owned();
        assert_eq!(
            show_commit_body(d.path(), &sha).unwrap(),
            "body line 1\nbody line 2"
        );
        assert_eq!(
            show_commit_body(d.path(), &log("feat")).unwrap(),
            "",
            "无正文 → 空串"
        );
    }

    #[test]
    fn changed_files_and_patch_for_a_commit() {
        let d = fixture();
        let sha = run_git(d.path(), &["log", "--format=%H %s", "--all"]).unwrap();
        let sha = sha
            .lines()
            .find(|l| l.contains("feat: b"))
            .unwrap()
            .split(' ')
            .next()
            .unwrap()
            .to_owned();
        let files = list_changed_files(d.path(), &sha).unwrap();
        assert_eq!(
            files,
            [ChangedFile {
                path: "b.txt".into(),
                added: Some(1),
                deleted: Some(0)
            }]
        );
        let patch = show_patch(d.path(), &sha).unwrap();
        assert!(patch.contains("+++ b/b.txt") && patch.contains("+feat"));
    }

    #[test]
    fn branches_list_marks_the_current_one() {
        let d = fixture();
        let b = list_branches(d.path()).unwrap();
        assert!(b.contains(&GitBranch {
            name: "main".into(),
            current: true
        }));
        assert!(b.contains(&GitBranch {
            name: "feat".into(),
            current: false
        }));
    }

    #[test]
    fn worktree_status_reports_branch_files_and_line_counts() {
        use super::super::types::WorktreeFileKind::*;
        let d = fixture();
        std::fs::write(d.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(d.path().join("new.txt"), "x\n").unwrap();
        let st = list_worktree_status(d.path()).unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));
        let a = st.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!((a.status, a.added, a.deleted), (M, Some(1), Some(0)));
        let n = st.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(
            (n.status, n.added),
            (A, None),
            "未跟踪文件不在 diff HEAD 里 → 无行数"
        );
        assert!(
            diff_worktree_file(Path::new(&st.root), "a.txt")
                .unwrap()
                .contains("+three")
        );
        assert_eq!(
            diff_worktree_file(Path::new(&st.root), "new.txt").unwrap(),
            "",
            "未跟踪文件 → 空串"
        );
    }

    #[test]
    fn worktree_status_outside_a_repo_is_none_and_an_empty_repo_degrades() {
        let outside = tempfile::tempdir().unwrap();
        assert!(list_worktree_status(outside.path()).is_none());
        let empty = tempfile::tempdir().unwrap();
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(empty.path())
            .output()
            .unwrap();
        std::fs::write(empty.path().join("f"), "x").unwrap();
        let st = list_worktree_status(empty.path()).expect("空 repo 也能给出状态");
        assert_eq!(st.branch, None, "无 HEAD → 无分支");
        assert_eq!(st.files.len(), 1);
    }
}
