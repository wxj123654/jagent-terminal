//! ThreadStore：会话事实源（对应旧 `threads/store.ts` + `internal/*`）。
//!
//! 设计（与旧 TS 的机制差异，规则不变）：
//! - 纯同步、无运行时：旧版 `spawnFromPreset` / `sendConversationMessage` 是 async，这里拆成
//!   **两步**——`begin_*` 校验并返回请求，调用方（gpui 层）去 spawn / 调 agent，再回调 `finish_*`。
//!   这样所有规则都能用普通 `#[test]` 确定性地测，不需要 mock 时间或 await。
//! - 副作用经 [`Effects`] 注入（旧 `ThreadDeps`）：销毁 PTY、桌面通知、读取 closeOnExit、
//!   当前路由读侧、时钟、id、cwd 兜底。store 本体零 gpui、零 IO。
//! - 导航 `active` 是 store 自己的字段（旧版是 router 的 URL）；`navigate` 副作用不再需要。
//!
//! 规则表见 docs/architecture.md §3.3（P8 前仍是权威规格）；本文件的测试逐条对应旧 `store.test.ts`。

use super::model::*;
use super::workspaces::{clear_last_session, record_last_session};
use crate::presets::TerminalPreset;

/// 注入的副作用与环境（旧 `ThreadDeps`）。
pub trait Effects {
    /// 销毁 PTY。旧版在这里吞掉 reject；调用方负责把失败送进错误总线。
    fn destroy_session(&mut self, session_id: u64);
    /// 桌面通知。入参放宽到 Thread：shell 视图 PTY 的 bell 也可能属于 chat / acp 会话。
    fn notify(&mut self, thread: &Thread);
    /// 读 settings 终端区：进程退出后是否直接关闭该行。
    fn close_on_exit(&self) -> bool;
    /// ACP 连接的 dispose（close acp thread 时调）。
    fn dispose_acp(&mut self, thread_id: &str);
    /// 时钟（created_at / 消息 at / 通知 at）。
    fn now(&self) -> i64;
    /// id 生成（c / a / w 前缀后的 uuid 部分）。
    fn new_id(&mut self) -> String;
    /// cwd 继承链兜底（preset.cwd ?? workspace.path ?? 本项）。
    fn default_cwd(&self) -> String;
    /// 用系统关联程序打开文件（设置页「在编辑器中打开」settings.json）。
    /// 失败由实现方自理（UI 不因外部程序问题报错弹窗）。
    fn open_path(&mut self, path: &str);
}

/// `spawn_from_preset` 的第一步产物：调用方据此创建 PTY，拿到 session id 后调 `finish_spawn`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnRequest {
    pub preset: TerminalPreset,
    pub cwd: String,
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    UnknownPreset(String),
    UnknownWorkspace(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownPreset(id) => write!(f, "unknown preset: {id}"),
            Self::UnknownWorkspace(id) => write!(f, "unknown workspace: {id}"),
        }
    }
}

impl std::error::Error for StoreError {}

/// 终端会话事件（旧 `TerminalSessionEvent` 判别联合）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    Title {
        session_id: u64,
        title: Option<String>,
    },
    Bell {
        session_id: u64,
    },
    Exit {
        session_id: u64,
        code: Option<i32>,
    },
}

impl SessionEvent {
    pub fn session_id(&self) -> u64 {
        match self {
            Self::Title { session_id, .. }
            | Self::Bell { session_id }
            | Self::Exit { session_id, .. } => *session_id,
        }
    }
}

/// `begin_send` 的产物：调用方把 `text` 交给 agent，结果回调 `finish_send`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendRequest {
    pub thread_id: String,
    pub kind: ConversationKind,
    pub text: String,
    /// ACP 才有：连接按 thread 惰性建立，调用方据此创建
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConversationKind {
    Chat,
    Acp,
}

pub struct ThreadStore<E: Effects> {
    pub threads: Vec<Thread>,
    pub workspaces: Vec<Workspace>,
    /// 运行时态，不写 settings.json
    pub last_used_preset: Option<String>,
    /// 通知中心事件流（未读 = `notices.filter(!read)`）；容量 50 丢最旧；不持久化
    pub notices: Vec<SessionNotice>,
    /// 导航唯一事实源（旧版是 router 的 URL）
    active: ActiveTarget,
    effects: E,
    /// workspaces 变化后置位；调用方 `take_workspaces_dirty` 后写 state.json（fire-and-forget）
    workspaces_dirty: bool,
    msg_seq: u64,
    notice_seq: u64,
    /// 已建立 ACP 连接的 thread（运行时资源，不进持久态）
    acp_connected: std::collections::HashSet<String>,
    /// 正在逐 chunk 更新的 assistant 消息（thread id, kind）；finish_send 会定稿替换该行。
    streaming_replies: std::collections::HashSet<(String, ConversationKind)>,
}

impl<E: Effects> ThreadStore<E> {
    pub fn new(effects: E, initial_workspaces: Vec<Workspace>) -> Self {
        Self {
            threads: vec![],
            workspaces: initial_workspaces,
            last_used_preset: None,
            notices: vec![],
            active: ActiveTarget::Home,
            effects,
            workspaces_dirty: false,
            msg_seq: 0,
            notice_seq: 0,
            acp_connected: Default::default(),
            streaming_replies: Default::default(),
        }
    }

    pub fn effects(&self) -> &E {
        &self.effects
    }
    pub fn effects_mut(&mut self) -> &mut E {
        &mut self.effects
    }

    pub fn active(&self) -> &ActiveTarget {
        &self.active
    }

    /// 路由读侧：当前指向的 thread id。
    pub fn active_thread_id(&self) -> Option<&str> {
        if let ActiveTarget::Thread(id) = &self.active {
            Some(id)
        } else {
            None
        }
    }

    fn active_workspace_id(&self) -> Option<&str> {
        if let ActiveTarget::Workspace(id) = &self.active {
            Some(id)
        } else {
            None
        }
    }

    pub fn thread(&self, id: &str) -> Option<&Thread> {
        self.threads.iter().find(|t| t.id() == id)
    }
    fn thread_mut(&mut self, id: &str) -> Option<&mut Thread> {
        self.threads.iter_mut().find(|t| t.id() == id)
    }
    pub fn workspace(&self, id: &str) -> Option<&Workspace> {
        self.workspaces.iter().find(|w| w.id == id)
    }

    /// workspaces 是否有待持久化的变化；读取即清除。
    pub fn take_workspaces_dirty(&mut self) -> bool {
        std::mem::take(&mut self.workspaces_dirty)
    }

    fn persist(&mut self) {
        self.workspaces_dirty = true;
    }

    pub fn unread_notice_count(&self) -> usize {
        self.notices.iter().filter(|n| !n.read).count()
    }

    // ── spawn ────────────────────────────────────────────────────

    /// 第一步：查 preset → cwd 继承链（preset 显式 cwd = 用户配置意图优先 → 工作区目录 → 进程 CWD）。
    /// 显式 workspace_id 不存在 → 错误（调用方 bug 早暴露）。
    pub fn begin_spawn(
        &self,
        preset: Option<&TerminalPreset>,
        preset_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<SpawnRequest, StoreError> {
        let preset = preset.ok_or_else(|| StoreError::UnknownPreset(preset_id.to_owned()))?;
        let ws = match workspace_id {
            Some(id) => Some(
                self.workspace(id)
                    .ok_or_else(|| StoreError::UnknownWorkspace(id.to_owned()))?,
            ),
            None => None,
        };
        let cwd = preset
            .cwd
            .clone()
            .or_else(|| ws.map(|w| w.path.clone()))
            .unwrap_or_else(|| self.effects.default_cwd());
        Ok(SpawnRequest {
            preset: preset.clone(),
            cwd,
            workspace_id: ws.map(|w| w.id.clone()),
        })
    }

    /// 第二步：PTY 已创建 → push thread + `last_used_preset` + activate。返回 thread id。
    pub fn finish_spawn(&mut self, req: &SpawnRequest, session_id: u64) -> String {
        let thread = TerminalThread {
            id: format!("t{session_id}"),
            session_id,
            preset: Some(req.preset.id.clone()),
            cwd: req.cwd.clone(),
            init_command: req.preset.init_command.clone(),
            osc_title: None,
            custom_title: None,
            status: RunStatus::Running,
            exit_code: None,
            has_bell: false,
            created_at: self.effects.now(),
            common: ThreadCommon {
                workspace_id: req.workspace_id.clone(),
                ..Default::default()
            },
        };
        let id = thread.id.clone();
        self.threads.push(Thread::Terminal(thread));
        self.last_used_preset = Some(req.preset.id.clone());
        self.activate(ActiveTarget::Thread(id.clone()));
        id
    }

    // ── activate / close / rename / cycle ───────────────────────

    /// 表面切换单点：聚焦即清 bell 红点 + unread（打开即已读）+ 正在展示的视图 hasBell +
    /// 该会话通知标读 + last_session 记录。settings / Home 不动 threads（后台 PTY 照跑）。
    pub fn activate(&mut self, target: ActiveTarget) {
        if let ActiveTarget::Thread(id) = &target {
            let mut touched = false;
            if let Some(t) = self.threads.iter_mut().find(|t| t.id() == id) {
                if let Thread::Terminal(x) = t {
                    x.has_bell = false;
                }
                t.common_mut().unread = false;
                clear_view_bell(t);
                if let Some(ws_id) = t.workspace_id().map(str::to_owned) {
                    touched = record_last_session(&mut self.workspaces, &ws_id, id);
                }
            }
            for n in self.notices.iter_mut().filter(|n| &n.thread_id == id) {
                n.read = true;
            }
            if touched {
                self.persist();
            }
        }
        self.active = target;
    }

    /// 会话移除单点：先导航离开（不变量 1）→ 销毁 PTY / dispose / 视图 PTY 连带销毁 →
    /// 移除行 + last_session 兜底 + persist。
    pub fn close(&mut self, id: &str) {
        let Some(thread) = self.thread(id).cloned() else {
            return;
        };
        if self.active_thread_id() == Some(id) {
            let to = thread.workspace_id().map_or(ActiveTarget::Home, |w| {
                ActiveTarget::Workspace(w.to_owned())
            });
            self.activate(to);
        }
        if let Thread::Terminal(t) = &thread {
            self.effects.destroy_session(t.session_id);
        }
        for v in &thread.common().views {
            if let SessionView::Shell(s) = v {
                self.effects.destroy_session(s.session_id);
            }
        }
        if matches!(thread, Thread::Acp(_)) && self.acp_connected.remove(id) {
            self.effects.dispose_acp(id);
        }
        self.threads.retain(|t| t.id() != id);
        if let Some(ws_id) = thread.workspace_id() {
            clear_last_session(&mut self.workspaces, ws_id, id);
        }
        self.persist();
    }

    /// 空串忽略；terminal 写 custom_title → 冻结（不变量 2）；chat / acp 直接改 title
    /// （首条消息改写只在哨兵期间发生——手改后冻结）。
    pub fn rename(&mut self, id: &str, title: &str) {
        if title.trim().is_empty() {
            return;
        }
        match self.thread_mut(id) {
            Some(Thread::Terminal(t)) => t.custom_title = Some(title.to_owned()),
            Some(Thread::Chat(t)) => t.title = title.to_owned(),
            Some(Thread::Acp(t)) => {
                t.title = title.to_owned();
                t.auto_title = false;
            }
            None => {}
        }
    }

    /// 环形移动：基准 = 当前 active。无 active（Home / settings 表面）时：dir=1 → 第一个，dir=-1 → 最后一个。
    pub fn cycle(&mut self, dir: i32) {
        let n = self.threads.len() as i32;
        if n == 0 {
            return;
        }
        let idx = self
            .threads
            .iter()
            .position(|t| Some(t.id()) == self.active_thread_id());
        let next = match idx {
            None => {
                if dir >= 0 {
                    0
                } else {
                    n - 1
                }
            }
            Some(i) => (i as i32 + dir).rem_euclid(n),
        };
        let id = self.threads[next as usize].id().to_owned();
        self.activate(ActiveTarget::Thread(id));
    }

    // ── 终端会话事件 ─────────────────────────────────────────────

    /// native → store：主会话 `t${sid}` 定位落空 → 视图 PTY 归属（按 view.session_id 路由到所属 shell 视图）；
    /// 命中主会话走 title / bell / exit 三分支。
    pub fn on_session_event(&mut self, e: SessionEvent) {
        let id = format!("t{}", e.session_id());
        if self.thread(&id).is_none() {
            if let Some((thread_id, view_id)) = self.find_shell_view_owner(e.session_id()) {
                self.handle_shell_view_event(&thread_id, &view_id, &e);
            }
            return;
        }
        match e {
            SessionEvent::Title { title, .. } => {
                // custom_title 存在则忽略（冻结）；空串忽略
                if let (Some(Thread::Terminal(t)), Some(title)) =
                    (self.thread_mut(&id), title.filter(|s| !s.is_empty()))
                    && t.custom_title.is_none()
                {
                    t.osc_title = Some(title);
                }
            }
            SessionEvent::Bell { .. } => {
                // 非 active 时红点 + 通知
                if self.active_thread_id() != Some(&id) {
                    let Some(Thread::Terminal(t)) = self.thread_mut(&id) else {
                        return;
                    };
                    t.has_bell = true;
                    let snapshot = Thread::Terminal(t.clone());
                    let text = format!("「{}」等待注意", snapshot.title());
                    self.push_notice(&snapshot, NoticeTone::Warn, text, Some("BEL"), None);
                    self.effects.notify(&snapshot);
                }
            }
            SessionEvent::Exit { code, .. } => {
                let Some(Thread::Terminal(t)) = self.thread(&id) else {
                    return;
                };
                let title = Thread::Terminal(t.clone()).title();
                let snapshot = Thread::Terminal(t.clone());
                // 退出是真实会话事件——非零码 err、正常退出 ok
                self.push_notice(
                    &snapshot,
                    exit_tone(code),
                    format!("「{title}」已退出"),
                    None,
                    None,
                );
                if self.effects.close_on_exit() {
                    self.close(&id);
                } else if let Some(Thread::Terminal(row)) = self.thread_mut(&id) {
                    // exited 会话留在池中（不变量 3）——重激活显示残留
                    row.status = RunStatus::Exited;
                    row.exit_code = code;
                }
            }
        }
    }

    // ── 通知中心 ─────────────────────────────────────────────────

    /// 通知落列：sub = 归属工作区名 / 「未归属」+ 可选原因（「dotfiles · BEL」格式）。容量 50 丢最旧。
    fn push_notice(
        &mut self,
        t: &Thread,
        tone: NoticeTone,
        text: String,
        reason: Option<&str>,
        view_id: Option<&str>,
    ) {
        let ws_name = t
            .workspace_id()
            .and_then(|id| self.workspace(id))
            .map_or("未归属", |w| w.name.as_str())
            .to_owned();
        self.notice_seq += 1;
        let at = self.effects.now();
        self.notices.push(SessionNotice {
            id: format!("n{}", self.notice_seq),
            tone,
            text,
            sub: match reason {
                Some(r) => format!("{ws_name} · {r}"),
                None => ws_name,
            },
            at,
            thread_id: t.id().to_owned(),
            read: false,
            view_id: view_id.map(str::to_owned),
        });
        let over = self.notices.len().saturating_sub(50);
        self.notices.drain(..over);
    }

    /// 全部已读——红点清除，条目保留。
    pub fn mark_notices_read(&mut self) {
        for n in &mut self.notices {
            n.read = true;
        }
    }

    /// 条目点击：标已读 + 来源会话仍在则 activate 跳转（已关闭仅标已读——路由不得指向不存在的行）；
    /// 带 view_id 时一并激活该视图直达现场。
    pub fn open_notice(&mut self, notice_id: &str) {
        let Some(n) = self.notices.iter_mut().find(|n| n.id == notice_id) else {
            return;
        };
        n.read = true;
        let (thread_id, view_id) = (n.thread_id.clone(), n.view_id.clone());
        if self.thread(&thread_id).is_some() {
            self.activate(ActiveTarget::Thread(thread_id.clone()));
            if let Some(v) = view_id {
                self.activate_session_view(&thread_id, &v);
            }
        }
    }

    // ── 工作区 ───────────────────────────────────────────────────

    /// 新建工作区（name 空串回退 basename(path)）；返回 id。
    pub fn add_workspace(&mut self, name: &str, path: &str) -> String {
        let id = format!("w{}", self.effects.new_id());
        let name = if name.trim().is_empty() {
            workspace_display_name(path)
        } else {
            name.trim().to_owned()
        };
        let created_at = self.effects.now();
        self.workspaces.push(Workspace {
            id: id.clone(),
            name,
            path: path.to_owned(),
            expanded: true,
            last_session: None,
            pane_tab: PaneTab::Home,
            show_all: false,
            pin: false,
            created_at,
        });
        self.persist();
        id
    }

    /// 空串忽略（同 rename 纪律）。
    pub fn rename_workspace(&mut self, id: &str, name: &str) {
        if name.trim().is_empty() {
            return;
        }
        if let Some(w) = self.workspaces.iter_mut().find(|w| w.id == id) {
            w.name = name.trim().to_owned();
        }
        self.persist();
    }

    /// 移除工作区：连带 close 其全部会话（destroy / dispose / 导航兜底同 close 单点）+ 移除行。
    pub fn remove_workspace(&mut self, id: &str) {
        if self.workspace(id).is_none() {
            return;
        }
        let victims: Vec<String> = self
            .threads
            .iter()
            .filter(|t| t.workspace_id() == Some(id))
            .map(|t| t.id().to_owned())
            .collect();
        for v in victims {
            self.close(&v);
        }
        self.workspaces.retain(|w| w.id != id);
        // 路由若指向它的起始页 → 回全局起始页
        if self.active_workspace_id() == Some(id) {
            self.activate(ActiveTarget::Home);
        }
        self.persist();
    }

    /// 切换工作区（点行）：恢复 last_session（存在则 activate，否则回工作区起始页）。不改 expanded。
    pub fn activate_workspace(&mut self, id: &str) {
        let Some(ws) = self.workspace(id) else { return };
        let target = ws
            .last_session
            .as_ref()
            .filter(|s| self.thread(s).is_some())
            .cloned();
        self.activate(match target {
            Some(t) => ActiveTarget::Thread(t),
            None => ActiveTarget::Workspace(id.to_owned()),
        });
    }

    fn with_workspace(&mut self, id: &str, f: impl FnOnce(&mut Workspace)) {
        if let Some(w) = self.workspaces.iter_mut().find(|w| w.id == id) {
            f(w);
        }
        self.persist();
    }

    pub fn toggle_workspace_expanded(&mut self, id: &str) {
        self.with_workspace(id, |w| w.expanded = !w.expanded);
    }
    pub fn set_workspace_show_all(&mut self, id: &str, show_all: bool) {
        self.with_workspace(id, |w| w.show_all = show_all);
    }
    pub fn set_workspace_pinned(&mut self, id: &str, pin: bool) {
        self.with_workspace(id, |w| w.pin = pin);
    }
    pub fn set_workspace_pane_tab(&mut self, id: &str, tab: PaneTab) {
        self.with_workspace(id, |w| w.pane_tab = tab);
    }
    /// 会话置顶（不持久化，不导航）。
    pub fn set_thread_pinned(&mut self, id: &str, pin: bool) {
        if let Some(t) = self.thread_mut(id) {
            t.common_mut().pin = pin;
        }
    }
    /// 会话未读标记（activate 清除——待办语义）。
    pub fn set_thread_unread(&mut self, id: &str, unread: bool) {
        if let Some(t) = self.thread_mut(id) {
            t.common_mut().unread = unread;
        }
    }

    // ── 会话内视图 ───────────────────────────────────────────────

    fn find_shell_view_owner(&self, session_id: u64) -> Option<(String, String)> {
        self.threads.iter().find_map(|t| {
            t.common().views.iter().find_map(|v| match v {
                SessionView::Shell(s) if s.session_id == session_id => {
                    Some((t.id().to_owned(), s.id.clone()))
                }
                _ => None,
            })
        })
    }

    /// 激活会话内视图（'main' = 回主面；不存在 id 忽略）。「已看到」只对真正展示的视图成立——
    /// 后台会话的程序化调用不清标记。
    pub fn activate_session_view(&mut self, thread_id: &str, view_id: &str) {
        let active = self.active_thread_id() == Some(thread_id);
        let Some(t) = self.thread_mut(thread_id) else {
            return;
        };
        if view_id != MAIN_VIEW_ID && !t.common().views.iter().any(|v| v.id() == view_id) {
            return;
        }
        t.common_mut().active_view_id = Some(view_id.to_owned());
        if active {
            clear_view_bell(t);
        }
    }

    /// 视图移除单点：shell 视图连带销毁 PTY；关的是当前视图 → 回退左邻或主面。
    fn remove_session_view(&mut self, thread_id: &str, view_id: &str) {
        let Some(t) = self.thread(thread_id) else {
            return;
        };
        let Some(i) = t.common().views.iter().position(|v| v.id() == view_id) else {
            return;
        };
        if let SessionView::Shell(s) = &t.common().views[i] {
            self.effects.destroy_session(s.session_id);
        }
        let t = self.thread_mut(thread_id).expect("checked");
        let c = t.common_mut();
        c.views.remove(i);
        if c.active_view_id.as_deref() == Some(view_id) {
            c.active_view_id = Some(
                i.checked_sub(1)
                    .map_or_else(|| MAIN_VIEW_ID.to_owned(), |j| c.views[j].id().to_owned()),
            );
        }
    }

    /// 关闭会话内视图（'main' 不可关）。
    pub fn close_session_view(&mut self, thread_id: &str, view_id: &str) {
        if view_id != MAIN_VIEW_ID {
            self.remove_session_view(thread_id, view_id);
        }
    }

    /// 打开文件视图（`file:<path>` 去重复用）。
    pub fn open_session_file(&mut self, thread_id: &str, path: &str) {
        let Some(t) = self.thread_mut(thread_id) else {
            return;
        };
        let id = format!("file:{path}");
        let c = t.common_mut();
        if !c.views.iter().any(|v| v.id() == id) {
            let label = path
                .rsplit(['/', '\\'])
                .next()
                .filter(|s| !s.is_empty())
                .unwrap_or(path)
                .to_owned();
            c.views.push(SessionView::File {
                id: id.clone(),
                label,
                path: path.to_owned(),
            });
        }
        c.active_view_id = Some(id);
    }

    /// 新建会话内 shell 视图的第一步：算 cwd（会话 cwd → 工作区 path → 进程 CWD）。
    pub fn begin_add_session_shell(&self, thread_id: &str) -> Option<String> {
        let t = self.thread(thread_id)?;
        Some(
            t.as_terminal()
                .map(|t| t.cwd.clone())
                .or_else(|| {
                    t.workspace_id()
                        .and_then(|id| self.workspace(id))
                        .map(|w| w.path.clone())
                })
                .unwrap_or_else(|| self.effects.default_cwd()),
        )
    }

    /// 第二步：PTY 已创建。spawn 期间会话被关 → 孤儿 PTY 立即回收，不落视图。
    pub fn finish_add_session_shell(&mut self, thread_id: &str, session_id: u64, cwd: String) {
        if self.thread(thread_id).is_none() {
            self.effects.destroy_session(session_id);
            return;
        }
        let t = self.thread_mut(thread_id).expect("checked");
        let c = t.common_mut();
        let mut n = 1;
        while c.views.iter().any(|v| v.id() == format!("shell:{n}")) {
            n += 1;
        }
        let id = format!("shell:{n}");
        c.views.push(SessionView::Shell(ShellView {
            id: id.clone(),
            label: format!("Shell {n}"),
            session_id,
            cwd,
            osc_title: None,
            has_bell: false,
            status: RunStatus::Running,
            exit_code: None,
        }));
        c.active_view_id = Some(id);
    }

    /// 打开 Git 图：活跃会话已归属工作区 → 会话内 'git' 视图（不切路由）；
    /// 否则当前 / 首个工作区切 pane_tab=git 并激活。
    pub fn open_git_graph(&mut self) {
        let thread_id = self.active_thread_id().map(str::to_owned);
        if let Some(t) = thread_id.as_deref().and_then(|id| self.thread_mut(id))
            && t.workspace_id().is_some()
        {
            let c = t.common_mut();
            if !c.views.iter().any(|v| v.id() == "git") {
                c.views.push(SessionView::Git {
                    id: "git".into(),
                    label: "Git 图".into(),
                });
            }
            c.active_view_id = Some("git".into());
            return;
        }
        // 非会话上下文（工作区页 / 未归属会话 / 起始页）→ 工作区 pane_tab 路径
        let Some(id) = self
            .active_workspace_id()
            .map(str::to_owned)
            .or_else(|| self.workspaces.first().map(|w| w.id.clone()))
        else {
            return;
        };
        if let Some(w) = self.workspaces.iter_mut().find(|w| w.id == id) {
            w.pane_tab = PaneTab::Git;
        }
        self.persist();
        self.activate(ActiveTarget::Workspace(id));
    }

    /// 视图 PTY 事件：title / bell / exit 归属到所属 shell 视图。
    fn handle_shell_view_event(&mut self, thread_id: &str, view_id: &str, e: &SessionEvent) {
        let Some(thread) = self.thread(thread_id).cloned() else {
            return;
        };
        let thread_active = self.active_thread_id() == Some(thread_id);
        let view_title = |s: &Self| -> String {
            s.thread(thread_id)
                .and_then(|t| t.common().views.iter().find(|v| v.id() == view_id))
                .map(|v| v.title().to_owned())
                .unwrap_or_default()
        };
        match e {
            SessionEvent::Title { title, .. } => {
                let Some(title) = title.as_ref().filter(|s| !s.is_empty()) else {
                    return;
                };
                if let Some(v) = self.shell_view_mut(thread_id, view_id) {
                    v.osc_title = Some(title.clone());
                }
            }
            SessionEvent::Bell { .. } => {
                // 视图正在显示（会话 active 且它是活动视图）→ 同主面规则：不落标记
                let shown = thread
                    .common()
                    .active_view_id
                    .as_deref()
                    .unwrap_or(MAIN_VIEW_ID)
                    == view_id;
                if thread_active && shown {
                    return;
                }
                if let Some(v) = self.shell_view_mut(thread_id, view_id) {
                    v.has_bell = true;
                }
                // 会话本身在后台 → 会话级提醒面（terminal=has_bell / chat·acp=unread）+ notice + notify
                if !thread_active {
                    match self.thread_mut(thread_id) {
                        Some(Thread::Terminal(t)) => t.has_bell = true,
                        Some(t) => t.common_mut().unread = true,
                        None => {}
                    }
                    let text = format!("「{} · {}」等待注意", thread.title(), view_title(self));
                    let snap = self.thread(thread_id).cloned().expect("exists");
                    self.push_notice(&snap, NoticeTone::Warn, text, Some("BEL"), Some(view_id));
                    self.effects.notify(&snap);
                }
            }
            SessionEvent::Exit { code, .. } => {
                let text = format!("「{} · {}」已退出", thread.title(), view_title(self));
                self.push_notice(&thread, exit_tone(*code), text, None, Some(view_id));
                if self.effects.close_on_exit() {
                    // PTY 已死；销毁走同一移除单点（幂等）
                    self.remove_session_view(thread_id, view_id);
                } else if let Some(v) = self.shell_view_mut(thread_id, view_id) {
                    v.status = RunStatus::Exited;
                    v.exit_code = *code;
                }
            }
        }
    }

    fn shell_view_mut(&mut self, thread_id: &str, view_id: &str) -> Option<&mut ShellView> {
        self.thread_mut(thread_id)?
            .common_mut()
            .views
            .iter_mut()
            .find_map(|v| match v {
                SessionView::Shell(s) if s.id == view_id => Some(s),
                _ => None,
            })
    }

    // ── chat / acp ───────────────────────────────────────────────

    fn assert_workspace(&self, id: Option<&str>) -> Result<(), StoreError> {
        match id {
            Some(id) if self.workspace(id).is_none() => {
                Err(StoreError::UnknownWorkspace(id.to_owned()))
            }
            _ => Ok(()),
        }
    }

    /// 新建空 chat thread + activate。
    pub fn create_chat(&mut self, workspace_id: Option<&str>) -> Result<String, StoreError> {
        self.assert_workspace(workspace_id)?;
        let id = format!("c{}", self.effects.new_id());
        let created_at = self.effects.now();
        self.threads.push(Thread::Chat(ChatThread {
            id: id.clone(),
            title: CHAT_DEFAULT_TITLE.into(),
            created_at,
            messages: vec![],
            pending_reply: false,
            common: ThreadCommon {
                workspace_id: workspace_id.map(Into::into),
                ..Default::default()
            },
        }));
        self.activate(ActiveTarget::Thread(id.clone()));
        Ok(id)
    }

    /// 新建 ACP thread + activate。label 来自调用方的 settings 快照——store 不读 settings。
    pub fn create_acp_thread(
        &mut self,
        agent_id: &str,
        label: &str,
        workspace_id: Option<&str>,
    ) -> Result<String, StoreError> {
        self.assert_workspace(workspace_id)?;
        let id = format!("a{}", self.effects.new_id());
        let created_at = self.effects.now();
        self.threads.push(Thread::Acp(AcpThread {
            id: id.clone(),
            title: label.into(),
            created_at,
            agent_id: agent_id.into(),
            messages: vec![],
            pending_reply: false,
            auto_title: true,
            common: ThreadCommon {
                workspace_id: workspace_id.map(Into::into),
                ..Default::default()
            },
        }));
        self.activate(ActiveTarget::Thread(id.clone()));
        Ok(id)
    }

    fn next_msg_id(&mut self) -> String {
        self.msg_seq += 1;
        format!("m{}", self.msg_seq)
    }

    fn messages_mut(
        &mut self,
        id: &str,
        kind: ConversationKind,
    ) -> Option<(&mut Vec<ChatMessage>, &mut bool)> {
        match (self.thread_mut(id)?, kind) {
            (Thread::Chat(t), ConversationKind::Chat) => {
                Some((&mut t.messages, &mut t.pending_reply))
            }
            (Thread::Acp(t), ConversationKind::Acp) => {
                Some((&mut t.messages, &mut t.pending_reply))
            }
            _ => None,
        }
    }

    /// 会话消息状态机第一步（chat / acp 同构）：空串 / pending 中忽略；user 落列 + pending_reply=true；
    /// 首条 user 消息截断改写 title（仅哨兵期间；手改后冻结）。
    /// 返回 `None` = 被忽略；`Some` = 调用方把 `text` 交给 agent，结果回调 [`Self::finish_send`]。
    pub fn begin_send(
        &mut self,
        thread_id: &str,
        raw: &str,
        kind: ConversationKind,
    ) -> Option<SendRequest> {
        let text = raw.trim();
        if text.is_empty() {
            return None; // 空串忽略（同 rename）
        }
        let msg = ChatMessage {
            id: self.next_msg_id(),
            role: MessageRole::User,
            text: text.to_owned(),
            at: self.effects.now(),
        };
        let msg_id = msg.id.clone();
        let (msgs, pending) = self.messages_mut(thread_id, kind)?;
        if *pending {
            self.msg_seq -= 1; // 没用上的 id 退回，保持 id 序列稳定
            return None;
        }
        msgs.push(msg);
        *pending = true;
        let is_first_user = msgs.iter().all(|m| !m.is_user() || m.id == msg_id);
        let truncated = if text.chars().count() > 32 {
            format!("{}…", text.chars().take(32).collect::<String>())
        } else {
            text.to_owned()
        };
        let agent_id = match self.thread_mut(thread_id) {
            Some(Thread::Chat(t)) => {
                // 首条 user 消息定标题（title === 默认值哨兵；手改后冻结）
                if is_first_user && t.title == CHAT_DEFAULT_TITLE {
                    t.title = truncated;
                }
                None
            }
            Some(Thread::Acp(t)) => {
                if is_first_user && t.auto_title {
                    t.title = truncated;
                    t.auto_title = false;
                }
                Some(t.agent_id.clone())
            }
            _ => None,
        };
        Some(SendRequest {
            thread_id: thread_id.to_owned(),
            kind,
            text: text.to_owned(),
            agent_id,
        })
    }

    /// 会话消息的只读投影（chat / acp）；终端会话返回 `None`。
    pub fn conversation(&self, id: &str) -> Option<super::conversation::Conversation<'_>> {
        super::conversation::Conversation::of(self.thread(id)?)
    }

    /// ACP 连接首次建立（调用方创建连接成功后调；close 时据此 dispose）。
    pub fn mark_acp_connected(&mut self, thread_id: &str) {
        self.acp_connected.insert(thread_id.to_owned());
    }

    /// 收到 ACP / streaming backend 的增量文本：新建或更新同一条 assistant 行，不结束 pending。
    pub fn update_streaming_reply(&mut self, thread_id: &str, kind: ConversationKind, text: &str) {
        if self.thread(thread_id).is_none() {
            return;
        }
        let key = (thread_id.to_owned(), kind);
        if !self.streaming_replies.contains(&key) {
            let msg = ChatMessage {
                id: self.next_msg_id(),
                role: MessageRole::Assistant { error: false },
                text: text.to_owned(),
                at: self.effects.now(),
            };
            if let Some((messages, pending)) = self.messages_mut(thread_id, kind)
                && *pending
            {
                messages.push(msg);
                self.streaming_replies.insert(key);
            }
        } else if let Some((messages, _)) = self.messages_mut(thread_id, kind)
            && let Some(last) = messages.last_mut()
            && matches!(last.role, MessageRole::Assistant { error: false })
        {
            last.text = text.to_owned();
        }
    }

    /// 第二步：回复落列。若有 streaming 行则定稿替换它；否则新建 assistant 行。
    /// thread 已 close → 丢弃回复（不复活已删行）。
    pub fn finish_send(
        &mut self,
        thread_id: &str,
        kind: ConversationKind,
        reply: Result<String, String>,
    ) {
        let (text, error) = match reply {
            Ok(t) => (t, false),
            Err(e) => (format!("发送失败：{e}"), true),
        };
        let key = (thread_id.to_owned(), kind);
        if self.streaming_replies.remove(&key) {
            if let Some((messages, pending)) = self.messages_mut(thread_id, kind) {
                if let Some(last) = messages.last_mut()
                    && matches!(last.role, MessageRole::Assistant { error: false })
                {
                    last.text = text;
                    last.role = MessageRole::Assistant { error };
                }
                *pending = false;
            }
        } else {
            self.push_reply(thread_id, kind, text, error);
        }
    }

    /// ACP 连接建立失败（如配置被删）：落 error 行并复位 pending。注意此时 begin_send 已落了 user 消息。
    pub fn fail_acp_connect(&mut self, thread_id: &str, message: &str) {
        self.push_reply(
            thread_id,
            ConversationKind::Acp,
            format!("无法建立 ACP 连接：{message}"),
            true,
        );
    }

    fn push_reply(&mut self, thread_id: &str, kind: ConversationKind, text: String, error: bool) {
        let msg = ChatMessage {
            id: self.next_msg_id(),
            role: MessageRole::Assistant { error },
            text,
            at: self.effects.now(),
        };
        if let Some((msgs, pending)) = self.messages_mut(thread_id, kind) {
            msgs.push(msg);
            *pending = false;
        }
    }
}

/// 「已看到」单点：当前展示的 shell 视图清 has_bell（activate / activate_session_view 共用）。
fn clear_view_bell(t: &mut Thread) {
    let c = t.common_mut();
    let active = c.active_view_id.clone();
    for v in &mut c.views {
        if let SessionView::Shell(s) = v
            && Some(&s.id) == active.as_ref()
            && s.has_bell
        {
            s.has_bell = false;
        }
    }
}

/// exit 事件 → notice 语气（0 / 无码 = 正常退出 ok；非零 err）。
fn exit_tone(code: Option<i32>) -> NoticeTone {
    if matches!(code, Some(c) if c != 0) {
        NoticeTone::Err
    } else {
        NoticeTone::Ok
    }
}
