//! GitGraphStore：Git 图的状态机（对应旧 `git/store.ts` + `generation.ts`）。
//!
//! 独立于 ThreadStore（git 数据非会话，生命周期 = 工作区 tab 级）。
//!
//! 与旧 TS 的机制差异（规则不变）：旧版靠 Promise + `seq.isCurrent` 丢弃迟到回调；这里没有运行时，
//! 所以 store 是**同步状态机**，每个异步动作拆成 `begin_*`（返回 [`Ticket`]）+ `finish_*`（带回 ticket）。
//! 调用方（gpui 层）把慢活丢到后台任务，结果回来时携带 ticket；**ticket 过期（代际已变）就静默丢弃**。
//! 这样"换 cwd / 快速换选 / unmount 之后旧结果迟到"这类竞态，全部能用普通 `#[test]` 确定性地测。

use super::graph::{CommitLine, GitGraphData, GraphRow};
use super::types::{ChangedFile, GitBranch, GraphCommit};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitGraphStatus {
    Idle,
    Loading,
    Ready,
    Error,
    NotARepo,
}

/// 异步结果的凭据：携带发起时的代际。过期则 `finish_*` 丢弃。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ticket(u64);

pub struct GitGraphStore {
    pub status: GitGraphStatus,
    data: GitGraphData,
    /// 流式进度（工具条 n commits）
    pub loaded_count: usize,
    pub selected_sha: Option<String>,
    /// 选中提交的说明正文（`%b`）；无正文为空串
    pub body: Option<String>,
    pub detail_loading: bool,
    pub detail_error: Option<String>,
    /// 选中提交的变更文件（行内详情文件列表）
    pub files: Vec<ChangedFile>,
    pub branches: Vec<GitBranch>,
    pub show_remote: bool,
    pub find_query: String,
    pub find_matches: Vec<String>,
    pub find_index: Option<usize>,
    pub action_error: Option<String>,
    /// log 流级错误（非 repo 单列 status）
    pub error: Option<String>,

    /// 挂载代际：旧流的回调 / done 看到代际不符即静默丢弃
    mount_gen: u64,
    /// 详情代际：select 切换使旧 body / files 回调作废
    detail_gen: u64,
    mounted_cwd: Option<String>,
    repo_root: Option<String>,
    streaming: bool,
}

/// `mount` 的决策：调用方据此行动。
#[derive(Debug, PartialEq, Eq)]
pub enum MountPlan {
    /// 同 cwd 且流已建：复用，什么都不用做
    Reuse,
    /// 需要先解析 repo root；结果用 [`GitGraphStore::root_resolved`] 回灌
    ResolveRoot(Ticket),
}

/// `root_resolved` 的决策。
#[derive(Debug, PartialEq, Eq)]
pub enum RootPlan {
    /// ticket 过期，丢弃
    Stale,
    /// 非 repo，已置 `NotARepo`
    NotARepo,
    /// 开始流式 log + 列分支（都带同一个 ticket）
    Stream { root: String, ticket: Ticket },
}

impl Default for GitGraphStore {
    fn default() -> Self {
        Self::new()
    }
}

impl GitGraphStore {
    pub fn new() -> Self {
        Self {
            status: GitGraphStatus::Idle,
            data: GitGraphData::default(),
            loaded_count: 0,
            selected_sha: None,
            body: None,
            detail_loading: false,
            detail_error: None,
            files: vec![],
            branches: vec![],
            show_remote: true,
            find_query: String::new(),
            find_matches: vec![],
            find_index: None,
            action_error: None,
            error: None,
            mount_gen: 0,
            detail_gen: 0,
            mounted_cwd: None,
            repo_root: None,
            streaming: false,
        }
    }

    pub fn rows(&self) -> &[GraphRow] {
        &self.data.rows
    }
    pub fn lines_by_row(&self, row: usize) -> &[CommitLine] {
        self.data.lines_by_row.get(&row).map_or(&[], Vec::as_slice)
    }
    pub fn max_lanes(&self) -> usize {
        self.data.max_lanes
    }
    pub fn repo_root(&self) -> Option<&str> {
        self.repo_root.as_deref()
    }
    pub fn mounted_cwd(&self) -> Option<&str> {
        self.mounted_cwd.as_deref()
    }

    // ── mount / 流 ───────────────────────────────────────────────

    /// 幂等挂载：同 cwd 且流已建 → 复用；否则作废旧流，清态重跑。
    pub fn mount(&mut self, cwd: &str) -> MountPlan {
        if self.mounted_cwd.as_deref() == Some(cwd) && self.streaming {
            return MountPlan::Reuse;
        }
        self.mount_gen += 1;
        self.mounted_cwd = Some(cwd.to_owned());
        self.repo_root = None;
        self.streaming = false;
        self.data = GitGraphData::default();
        self.status = GitGraphStatus::Loading;
        self.loaded_count = 0;
        self.selected_sha = None;
        self.body = None;
        self.detail_loading = false;
        self.detail_error = None;
        self.files.clear();
        self.find_query.clear();
        self.find_matches.clear();
        self.find_index = None;
        self.action_error = None;
        self.error = None;
        MountPlan::ResolveRoot(Ticket(self.mount_gen))
    }

    fn is_current(&self, t: Ticket) -> bool {
        t.0 == self.mount_gen
    }

    pub fn root_resolved(&mut self, ticket: Ticket, root: Option<String>) -> RootPlan {
        if !self.is_current(ticket) {
            return RootPlan::Stale;
        }
        let Some(root) = root else {
            self.status = GitGraphStatus::NotARepo;
            return RootPlan::NotARepo;
        };
        self.repo_root = Some(root.clone());
        self.streaming = true;
        RootPlan::Stream { root, ticket }
    }

    /// 流式 chunk 到达。过期丢弃，返回是否被接受。
    pub fn on_chunk(&mut self, ticket: Ticket, chunk: &[GraphCommit]) -> bool {
        if !self.is_current(ticket) {
            return false;
        }
        self.data.add_commits(chunk);
        self.loaded_count = self.data.rows.len();
        true
    }

    pub fn on_branches(&mut self, ticket: Ticket, branches: Vec<GitBranch>) {
        if self.is_current(ticket) {
            self.branches = branches;
        }
    }

    /// 流结束。`Err("cancelled")` 视为取消，不改状态；其余失败 → Error；零提交 → Error「没有任何提交」。
    pub fn on_stream_done(&mut self, ticket: Ticket, result: Result<(), String>) {
        if !self.is_current(ticket) {
            return;
        }
        match result {
            Err(e) if e == "cancelled" => {}
            Err(e) => {
                self.status = GitGraphStatus::Error;
                self.error = Some(if e.is_empty() {
                    "git log failed".into()
                } else {
                    e
                });
            }
            Ok(()) if self.data.rows.is_empty() => {
                self.status = GitGraphStatus::Error;
                self.error = Some("没有任何提交".into());
            }
            Ok(()) => {
                self.status = GitGraphStatus::Ready;
                self.error = None;
            }
        }
    }

    /// 取消当前流 + 复位（切工作区由 `mount(new_cwd)` 覆盖；这个给装配层 / 测试用）。
    pub fn unmount(&mut self) {
        self.mount_gen += 1;
        self.detail_gen += 1;
        let (show_remote, gen_m, gen_d) = (self.show_remote, self.mount_gen, self.detail_gen);
        *self = Self::new();
        // 代际单调：复位后旧 ticket 仍然作废。show_remote 是用户偏好，复位回初始值（与旧实现一致）
        self.mount_gen = gen_m;
        self.detail_gen = gen_d;
        let _ = show_remote;
    }

    /// 取消当前流 + 清态重跑。未挂载 → `None`。
    pub fn refresh(&mut self) -> Option<MountPlan> {
        let cwd = self.mounted_cwd.clone()?;
        self.streaming = false;
        Some(self.mount(&cwd))
    }

    // ── 选中与详情 ───────────────────────────────────────────────

    /// 选中提交（`None` = 清除）。返回需要加载详情的 (root, sha, ticket)。
    pub fn select(&mut self, sha: Option<&str>) -> Option<DetailRequest> {
        self.selected_sha = sha.map(str::to_owned);
        self.body = None;
        self.detail_error = None;
        self.detail_loading = sha.is_some();
        self.files.clear();
        let (sha, root) = (sha?, self.repo_root.clone()?);
        self.detail_gen += 1;
        Some(DetailRequest {
            root,
            sha: sha.to_owned(),
            ticket: DetailTicket(self.detail_gen),
        })
    }

    /// Whether an async detail response still owns the current selection generation.
    pub fn detail_request_is_current(&self, req: &DetailRequest) -> bool {
        req.ticket.0 == self.detail_gen && self.selected_sha.as_deref() == Some(req.sha.as_str())
    }

    /// 详情结果到达：代际不符或选中已变 → 丢弃。
    pub fn on_detail(
        &mut self,
        req: &DetailRequest,
        result: Result<(String, Vec<ChangedFile>), String>,
    ) {
        if !self.detail_request_is_current(req) {
            return;
        }
        self.detail_loading = false;
        match result {
            Ok((body, files)) => {
                self.body = Some(body);
                self.files = files;
            }
            Err(e) => self.detail_error = Some(e),
        }
    }

    /// ↑/↓ 移动选中（越界钳制；无选中时从端点开始）。
    pub fn move_selection(&mut self, dir: i32) -> Option<DetailRequest> {
        let n = self.data.rows.len();
        if n == 0 {
            return None;
        }
        let idx = self
            .data
            .rows
            .iter()
            .position(|r| Some(&r.commit.sha) == self.selected_sha.as_ref());
        let next = match idx {
            None => {
                if dir >= 0 {
                    0
                } else {
                    n - 1
                }
            }
            Some(i) => (i as i64 + i64::from(dir)).clamp(0, n as i64 - 1) as usize,
        };
        let target = self.data.rows[next].commit.sha.clone();
        if Some(&target) == self.selected_sha.as_ref() {
            return None;
        }
        self.select(Some(&target))
    }

    pub fn set_show_remote(&mut self, on: bool) {
        self.show_remote = on;
    }

    // ── find ─────────────────────────────────────────────────────

    /// 输入变化：只更新匹配集，**不**移动选中（否则每敲一个键详情都跳）。
    pub fn find(&mut self, query: &str) {
        self.apply_find(query, 0);
    }

    /// 步进：循环移动并选中。返回需要加载详情的请求。
    pub fn find_next(&mut self, dir: i32) -> Option<DetailRequest> {
        let q = self.find_query.clone();
        self.apply_find(&q, dir)
    }

    fn apply_find(&mut self, query: &str, dir: i32) -> Option<DetailRequest> {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            self.find_query.clear();
            self.find_matches.clear();
            self.find_index = None;
            return None;
        }
        let matches: Vec<String> = self
            .data
            .rows
            .iter()
            .filter(|r| {
                r.commit.subject.to_lowercase().contains(&q)
                    || r.commit.sha.to_lowercase().starts_with(&q)
            })
            .map(|r| r.commit.sha.clone())
            .collect();
        self.find_query = query.to_owned();
        if matches.is_empty() {
            self.find_matches.clear();
            self.find_index = None;
            return None;
        }
        let n = matches.len() as i64;
        let idx = if dir == 0 {
            0
        } else {
            let prev = self.find_index.map_or(0, |i| i as i64);
            (prev + i64::from(dir)).rem_euclid(n) as usize
        };
        self.find_matches = matches;
        self.find_index = Some(idx);
        // 原型语义：输入只更新匹配集 + 淡化，步进才移动选中
        if dir != 0 {
            let sha = self.find_matches[idx].clone();
            return self.select(Some(&sha));
        }
        None
    }

    // ── 动作 ─────────────────────────────────────────────────────

    /// 执行 git 动作前清错并返回 root；未挂载 → `None`。
    pub fn begin_action(&mut self) -> Option<String> {
        let root = self.repo_root.clone()?;
        self.action_error = None;
        Some(root)
    }

    /// 动作结果：成功 → 刷新（返回新的 MountPlan）；失败 → `action_error`。
    pub fn finish_action(&mut self, result: Result<(), String>) -> Option<MountPlan> {
        match result {
            Ok(()) => self.mounted_cwd.take().map(|cwd| self.mount(&cwd)),
            Err(e) => {
                self.action_error = Some(e);
                None
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetailTicket(u64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetailRequest {
    pub root: String,
    pub sha: String,
    pub ticket: DetailTicket,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(sha: &str, parents: &[&str]) -> GraphCommit {
        GraphCommit {
            sha: sha.into(),
            parents: parents.iter().map(|s| (*s).to_owned()).collect(),
            ref_names: vec![],
            short_sha: sha.chars().take(7).collect(),
            author_name: "a".into(),
            author_email: "a@x".into(),
            timestamp: 0,
            committer_name: "a".into(),
            committer_email: "a@x".into(),
            subject: format!("s-{sha}"),
        }
    }

    /// 挂载并推进到「已解析 root、流已建」，返回 ticket。
    fn mounted(s: &mut GitGraphStore, cwd: &str) -> Ticket {
        let MountPlan::ResolveRoot(t) = s.mount(cwd) else {
            panic!("应需要解析 root")
        };
        match s.root_resolved(t, Some(format!("/repo/{cwd}"))) {
            RootPlan::Stream { ticket, .. } => ticket,
            p => panic!("{p:?}"),
        }
    }

    fn loaded(shas: &[&str]) -> (GitGraphStore, Ticket) {
        let mut s = GitGraphStore::new();
        let t = mounted(&mut s, "x");
        let commits: Vec<_> = shas.iter().map(|x| c(x, &[])).collect();
        s.on_chunk(t, &commits);
        s.on_stream_done(t, Ok(()));
        (s, t)
    }

    // ═════════ mount ═════════

    #[test]
    fn non_repo_ends_in_not_a_repo() {
        let mut s = GitGraphStore::new();
        let MountPlan::ResolveRoot(t) = s.mount("/plain") else {
            panic!()
        };
        assert_eq!(s.status, GitGraphStatus::Loading);
        assert_eq!(s.root_resolved(t, None), RootPlan::NotARepo);
        assert_eq!(s.status, GitGraphStatus::NotARepo);
    }

    #[test]
    fn streamed_chunks_fill_rows_and_done_makes_it_ready() {
        let mut s = GitGraphStore::new();
        let t = mounted(&mut s, "a");
        assert!(s.on_chunk(t, &[c("c2", &["c1"]), c("c1", &[])]));
        assert_eq!(
            (s.rows().len(), s.loaded_count, s.status),
            (2, 2, GitGraphStatus::Loading)
        );
        assert_eq!(s.max_lanes(), 1);
        assert!(!s.lines_by_row(0).is_empty());
        s.on_stream_done(t, Ok(()));
        assert_eq!((s.status, s.error.clone()), (GitGraphStatus::Ready, None));
    }

    #[test]
    fn mounting_the_same_cwd_reuses_the_stream_a_different_cwd_cancels_it() {
        let mut s = GitGraphStore::new();
        let t1 = mounted(&mut s, "a");
        assert_eq!(
            s.mount("a"),
            MountPlan::Reuse,
            "同 cwd 幂等复用（不重复 spawn）"
        );

        let MountPlan::ResolveRoot(t2) = s.mount("b") else {
            panic!()
        };
        assert_ne!(t1, t2);
        // 旧流的回调 / done 看到代际不符即静默丢弃
        assert!(!s.on_chunk(t1, &[c("old", &[])]));
        s.on_stream_done(t1, Err("late failure".into()));
        assert_eq!(s.rows().len(), 0);
        assert_eq!(s.status, GitGraphStatus::Loading, "旧流的失败不污染新挂载");
        assert_eq!(s.root_resolved(t1, Some("/stale".into())), RootPlan::Stale);
    }

    #[test]
    fn log_failure_gives_an_error_state_with_the_reason() {
        let mut s = GitGraphStore::new();
        let t = mounted(&mut s, "a");
        s.on_stream_done(t, Err("fatal: bad object".into()));
        assert_eq!(
            (s.status, s.error.as_deref()),
            (GitGraphStatus::Error, Some("fatal: bad object"))
        );
    }

    #[test]
    fn an_empty_history_is_an_error_not_ready_and_a_blank_reason_gets_a_default() {
        let mut s = GitGraphStore::new();
        let t = mounted(&mut s, "a");
        s.on_stream_done(t, Ok(()));
        assert_eq!(
            (s.status, s.error.as_deref()),
            (GitGraphStatus::Error, Some("没有任何提交"))
        );
        let t = mounted(&mut s, "b");
        s.on_stream_done(t, Err(String::new()));
        assert_eq!(s.error.as_deref(), Some("git log failed"));
    }

    #[test]
    fn a_cancelled_stream_does_not_change_the_status() {
        let mut s = GitGraphStore::new();
        let t = mounted(&mut s, "a");
        s.on_stream_done(t, Err("cancelled".into()));
        assert_eq!(s.status, GitGraphStatus::Loading);
    }

    #[test]
    fn branches_are_applied_only_for_the_current_mount() {
        let mut s = GitGraphStore::new();
        let t1 = mounted(&mut s, "a");
        let MountPlan::ResolveRoot(_) = s.mount("b") else {
            panic!()
        };
        s.on_branches(
            t1,
            vec![GitBranch {
                name: "stale".into(),
                current: true,
            }],
        );
        assert!(s.branches.is_empty());
    }

    // ═════════ select / moveSelection ═════════

    #[test]
    fn select_loads_details_and_clearing_does_not() {
        let (mut s, _) = loaded(&["c3", "c2", "c1"]);
        let req = s.select(Some("c2")).expect("需要加载详情");
        assert_eq!((req.sha.as_str(), req.root.as_str()), ("c2", "/repo/x"));
        assert!(s.detail_loading && s.body.is_none());
        s.on_detail(&req, Ok(("BODY-c2".into(), vec![])));
        assert_eq!(
            (s.body.as_deref(), s.detail_loading),
            (Some("BODY-c2"), false)
        );

        assert!(s.select(None).is_none(), "清除时不再加载");
        assert_eq!(
            (s.selected_sha.clone(), s.detail_loading, s.body.clone()),
            (None, false, None)
        );
    }

    #[test]
    fn a_late_same_sha_request_is_rejected_by_ticket_generation() {
        let (mut s, _) = loaded(&["c1"]);
        let first = s.select(Some("c1")).unwrap();
        let second = s.select(Some("c1")).unwrap();
        assert_eq!(first.sha, second.sha);
        assert!(!s.detail_request_is_current(&first));
        assert!(s.detail_request_is_current(&second));
        s.on_detail(&second, Ok(("new body".into(), vec![])));
        s.on_detail(&first, Ok(("old body".into(), vec![])));
        assert_eq!(s.body.as_deref(), Some("new body"));
    }

    #[test]
    fn a_late_body_for_a_superseded_selection_never_overwrites_the_new_one() {
        let (mut s, _) = loaded(&["c3", "c2", "c1"]);
        let first = s.select(Some("c3")).unwrap();
        let second = s.select(Some("c2")).unwrap();
        s.on_detail(&second, Ok(("BODY-c2".into(), vec![])));
        s.on_detail(&first, Ok(("BODY-c3".into(), vec![]))); // 迟到
        assert_eq!(s.body.as_deref(), Some("BODY-c2"));
        assert_eq!(s.selected_sha.as_deref(), Some("c2"));
    }

    #[test]
    fn a_detail_failure_is_recorded_and_clears_the_loading_flag() {
        let (mut s, _) = loaded(&["c1"]);
        let req = s.select(Some("c1")).unwrap();
        s.on_detail(&req, Err("bad revision".into()));
        assert_eq!(
            (s.detail_loading, s.detail_error.as_deref()),
            (false, Some("bad revision"))
        );
    }

    #[test]
    fn a_stale_detail_failure_is_also_dropped() {
        let (mut s, _) = loaded(&["c2", "c1"]);
        let first = s.select(Some("c2")).unwrap();
        let _second = s.select(Some("c1")).unwrap();
        s.on_detail(&first, Err("late".into()));
        assert_eq!(s.detail_error, None);
        assert!(s.detail_loading, "新选中的详情仍在加载");
    }

    #[test]
    fn move_selection_starts_at_the_end_and_clamps() {
        let (mut s, _) = loaded(&["c3", "c2", "c1"]);
        s.move_selection(1);
        assert_eq!(
            s.selected_sha.as_deref(),
            Some("c3"),
            "无选中 + 向下 → 首行"
        );
        s.move_selection(-1);
        assert_eq!(
            s.selected_sha.as_deref(),
            Some("c3"),
            "已在顶，向上钳制不动"
        );
        assert!(s.move_selection(-1).is_none(), "没变化就不重复加载");
        s.move_selection(1);
        s.move_selection(1);
        s.move_selection(1);
        assert_eq!(s.selected_sha.as_deref(), Some("c1"), "到底钳制");

        let (mut s, _) = loaded(&["c3", "c2", "c1"]);
        s.move_selection(-1);
        assert_eq!(
            s.selected_sha.as_deref(),
            Some("c1"),
            "无选中 + 向上 → 末行"
        );
    }

    #[test]
    fn move_selection_on_an_empty_graph_is_a_no_op() {
        let mut s = GitGraphStore::new();
        assert!(s.move_selection(1).is_none());
    }

    // ═════════ refresh / unmount ═════════

    #[test]
    fn refresh_restarts_the_stream_and_clears_the_selection() {
        let (mut s, t1) = loaded(&["c2", "c1"]);
        s.select(Some("c1"));
        let Some(MountPlan::ResolveRoot(t2)) = s.refresh() else {
            panic!()
        };
        assert_ne!(t1, t2);
        assert_eq!(
            (s.rows().len(), s.selected_sha.clone(), s.status),
            (0, None, GitGraphStatus::Loading)
        );
        assert!(!s.on_chunk(t1, &[c("old", &[])]), "旧流作废");
    }

    #[test]
    fn refresh_without_a_mount_is_a_no_op() {
        assert!(GitGraphStore::new().refresh().is_none());
    }

    #[test]
    fn unmount_resets_to_idle_and_later_results_do_not_write_back() {
        let (mut s, t) = loaded(&["c1"]);
        let req = s.select(Some("c1")).unwrap();
        s.unmount();
        assert_eq!(
            (s.status, s.rows().len(), s.selected_sha.clone()),
            (GitGraphStatus::Idle, 0, None)
        );
        assert!(s.mounted_cwd().is_none() && s.repo_root().is_none());
        assert!(!s.on_chunk(t, &[c("late", &[])]), "旧 ticket 仍然作废");
        s.on_stream_done(t, Err("late".into()));
        s.on_detail(&req, Ok(("late body".into(), vec![])));
        assert_eq!(
            (s.status, s.body.clone(), s.error.clone()),
            (GitGraphStatus::Idle, None, None)
        );
    }

    #[test]
    fn mounting_again_after_unmount_works_and_old_tickets_stay_dead() {
        let (mut s, t_old) = loaded(&["c1"]);
        s.unmount();
        let t_new = mounted(&mut s, "x");
        assert_ne!(t_old, t_new);
        assert!(s.on_chunk(t_new, &[c("n1", &[])]));
        assert!(!s.on_chunk(t_old, &[c("o1", &[])]));
    }

    // ═════════ files / find / action ═════════

    #[test]
    fn select_loads_the_changed_files_too() {
        let (mut s, _) = loaded(&["c1"]);
        let req = s.select(Some("c1")).unwrap();
        let f = vec![ChangedFile {
            path: "a.rs".into(),
            added: Some(1),
            deleted: Some(0),
        }];
        s.on_detail(&req, Ok((String::new(), f.clone())));
        assert_eq!((s.files.clone(), s.body.as_deref()), (f, Some("")));
    }

    #[test]
    fn find_updates_matches_without_moving_selection_find_next_steps_and_selects() {
        let mut s = GitGraphStore::new();
        let t = mounted(&mut s, "x");
        s.on_chunk(t, &[c("aaa1", &[]), c("bbb2", &[]), c("aaa3", &[])]);
        s.find("aaa");
        assert_eq!(s.find_matches, ["aaa1", "aaa3"]);
        assert_eq!(s.find_index, Some(0));
        assert_eq!(s.selected_sha, None, "输入不跳选中");

        assert!(s.find_next(1).is_some());
        assert_eq!(
            (s.find_index, s.selected_sha.as_deref()),
            (Some(1), Some("aaa3"))
        );
        s.find_next(1);
        assert_eq!(
            (s.find_index, s.selected_sha.as_deref()),
            (Some(0), Some("aaa1")),
            "循环回到首个"
        );
        s.find_next(-1);
        assert_eq!(
            (s.find_index, s.selected_sha.as_deref()),
            (Some(1), Some("aaa3")),
            "反向循环"
        );
    }

    #[test]
    fn find_matches_subject_substring_or_sha_prefix_case_insensitively_and_clears_on_blank() {
        let mut s = GitGraphStore::new();
        let t = mounted(&mut s, "x");
        s.on_chunk(t, &[c("abc123", &[]), c("def456", &[])]);
        s.find("S-DEF");
        assert_eq!(s.find_matches, ["def456"], "subject 子串，不区分大小写");
        s.find("abc");
        assert_eq!(s.find_matches, ["abc123"], "sha 前缀");
        // 注意 subject 形如 `s-abc123`：想验证"sha 只匹配前缀"，查询串必须同时不是任何 subject 的子串。
        // sha=abc123 的中段 `bc12` 在 subject `s-abc123` 里也出现，所以不能用它；换成不在 subject 里的拼法不可能，
        // 因为 subject 就含 sha。改用一个 sha 与 subject 不同的提交来区分两条规则。
        let mut s2 = GitGraphStore::new();
        let t2 = mounted(&mut s2, "x");
        let mut odd = c("f00dbeef", &[]);
        odd.subject = "unrelated subject".into();
        s2.on_chunk(t2, &[odd]);
        s2.find("f00d");
        assert_eq!(s2.find_matches, ["f00dbeef"], "sha 前缀命中");
        s2.find("dbee");
        assert!(
            s2.find_matches.is_empty(),
            "sha 中段不命中（只匹配前缀），subject 里也没有"
        );
        assert_eq!(s2.find_index, None);
        s.find("   ");
        assert_eq!(
            (s.find_query.as_str(), s.find_matches.len(), s.find_index),
            ("", 0, None)
        );
        assert!(s.find_next(1).is_none(), "空查询步进无效果");
    }

    #[test]
    fn a_successful_action_refreshes_a_failed_one_records_the_error() {
        let (mut s, t1) = loaded(&["c1"]);
        let root = s.begin_action().expect("已挂载");
        assert_eq!(root, "/repo/x");
        let Some(MountPlan::ResolveRoot(t2)) = s.finish_action(Ok(())) else {
            panic!("成功后 refresh")
        };
        assert_ne!(t1, t2);

        let mut s2 = loaded(&["c1"]).0;
        s2.begin_action();
        assert!(s2.finish_action(Err("fatal: ...".into())).is_none());
        assert_eq!(s2.action_error.as_deref(), Some("fatal: ..."));
        s2.begin_action();
        assert_eq!(s2.action_error, None, "下次动作开始前清错");

        assert!(
            GitGraphStore::new().begin_action().is_none(),
            "未挂载不能执行动作"
        );
    }
}
