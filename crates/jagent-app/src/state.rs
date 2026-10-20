//! 应用状态：把 `jagent-core` 的纯状态机装进 gpui `Entity`，并接上副作用。
//!
//! 分层：规则全在 core（普通 `#[test]`）；这里只做三件事——
//! 1. [`GuiEffects`]：实现 core 的 `Effects`（销毁 PTY、桌面通知、读 closeOnExit、时钟、id）；
//! 2. [`AppState`]：持有 `ThreadStore` / `SettingsStore` / `GitGraphStore`，对外提供"改完要 `cx.notify()`"的方法；
//! 3. 终端事件桥：`jagent-terminal` 的全局事件汇（后台线程回调）→ channel → 前台任务 → `ThreadStore::on_session_event`。

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use gpui::{
    App, AppContext as _, AsyncApp, BorrowAppContext as _, Context, Entity, EventEmitter,
    WeakEntity,
};
use jagent_core::git::cli::{
    CancelToken, diff_worktree_file, find_repo_root, list_branches, list_changed_files,
    list_worktree_status, show_commit_body, show_patch, stream_git_log,
};
use jagent_core::git::{GitGraphStore, GraphCommit, MountPlan, RootPlan, Ticket};
use jagent_core::presets::TerminalPreset;
use jagent_core::settings::{FsAdapter, Settings, SettingsStore};
#[cfg(test)]
use jagent_core::threads::serialize_workspace_state;
use jagent_core::threads::{
    ActiveTarget, ConversationKind, Effects, SessionEvent as CoreSessionEvent, SpawnRequest,
    StoreError, Thread, ThreadStore, Workspace, echo_reply, parse_persisted_acp_threads,
    parse_workspace_state, serialize_workspace_and_acp_state,
};
use jagent_terminal::{SessionEvent as TermEvent, SpawnOptions, TerminalPool};

/// 数据目录（`~/.j-agent`）：settings.json / state.json / 日志都在这里。
pub fn data_dir() -> PathBuf {
    std::env::var_os("JAGENT_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".j-agent")
        })
}

/// 用系统关联程序打开文件（旧 `settings/file.ts` 的 `openInSystemApp`：
/// macOS `open` / Windows `cmd /c start` / 其他 `xdg-open`）。
/// fire-and-forget：失败仅忽略——外部程序问题不该打断 app（旧版也只 warn）。
fn open_in_system_app(path: &str) {
    use std::process::{Command, Stdio};
    let spawn_ignore = |cmd: &mut Command| {
        let _ = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    };
    if cfg!(target_os = "windows") {
        // 空标题参防路径带空格被当成标题
        spawn_ignore(Command::new("cmd").args(["/c", "start", "", path]));
    } else if cfg!(target_os = "macos") {
        spawn_ignore(Command::new("open").arg(path));
    } else {
        spawn_ignore(Command::new("xdg-open").arg(path));
    }
}

/// 已派发的系统桌面通知记录（供宿主与单元测试验证 `notifications.desktop` / `notifications.sound`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopNotificationRecord {
    pub thread_id: String,
    pub title: String,
    pub body: String,
    pub sound: bool,
}

/// 调用操作系统原生通知工具发送桌面通知（fire-and-forget，不阻塞 UI 线程）。
#[cfg(not(test))]
fn send_system_desktop_notification(title: &str, body: &str, sound: bool) {
    use std::process::{Command, Stdio};
    let spawn_ignore = |cmd: &mut Command| {
        let _ = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    };
    if cfg!(target_os = "macos") {
        let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let script = if sound {
            format!(
                r#"display notification "{}" with title "{}" sound name "Glass""#,
                esc(body),
                esc(title)
            )
        } else {
            format!(
                r#"display notification "{}" with title "{}""#,
                esc(body),
                esc(title)
            )
        };
        spawn_ignore(Command::new("osascript").args(["-e", &script]));
    } else if cfg!(target_os = "linux") {
        spawn_ignore(Command::new("notify-send").args([title, body]));
    }
}

/// 副作用的可观察记录：桌面通知交给宿主（平台 toast 在 P7），这里先累积待发队列。
#[derive(Default)]
pub struct EffectLog {
    /// 待销毁的 PTY（`close` 里收集；`AppState::drain_effects` 在持有 `&mut App` 时真正销毁）
    pub to_destroy: Vec<u64>,
    /// 待发桌面通知（thread id）
    pub to_notify: Vec<String>,
    pub to_dispose_acp: Vec<String>,
    /// 待用系统关联程序打开的文件路径（设置页「在编辑器中打开」）
    pub to_open: Vec<String>,
}

/// core 的 `Effects` 实现。`ThreadStore` 方法拿不到 `&mut App`，所以副作用先记账，
/// 由 `AppState` 在随后的 `update` 里统一兑现——这样 store 保持同步、可测、无 gpui 依赖。
#[derive(Clone)]
pub struct GuiEffects {
    pub log: Rc<RefCell<EffectLog>>,
    close_on_exit: Rc<RefCell<bool>>,
    cwd: Rc<RefCell<String>>,
}

impl GuiEffects {
    pub fn new(default_cwd: String) -> Self {
        Self {
            log: Rc::default(),
            close_on_exit: Rc::default(),
            cwd: Rc::new(RefCell::new(default_cwd)),
        }
    }
    pub fn set_close_on_exit(&self, v: bool) {
        *self.close_on_exit.borrow_mut() = v;
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// 进程内唯一的短 id（c / a / w 前缀后的部分）。不依赖 uuid：同进程内单调且带时间戳，足够区分；
/// 持久化的只有 workspace id，跨进程冲突概率取决于毫秒时间戳 + 计数，可忽略。
fn new_id(seq: &mut u64) -> String {
    *seq += 1;
    format!("{:x}{:x}", now_ms(), seq)
}

struct IdSeq(u64);

impl Effects for GuiEffects {
    fn destroy_session(&mut self, id: u64) {
        self.log.borrow_mut().to_destroy.push(id);
    }
    fn notify(&mut self, t: &Thread) {
        self.log.borrow_mut().to_notify.push(t.id().to_owned());
    }
    fn close_on_exit(&self) -> bool {
        *self.close_on_exit.borrow()
    }
    fn dispose_acp(&mut self, thread_id: &str) {
        self.log
            .borrow_mut()
            .to_dispose_acp
            .push(thread_id.to_owned());
    }
    fn now(&self) -> i64 {
        now_ms()
    }
    fn new_id(&mut self) -> String {
        thread_local! { static SEQ: RefCell<IdSeq> = const { RefCell::new(IdSeq(0)) }; }
        SEQ.with(|s| new_id(&mut s.borrow_mut().0))
    }
    fn default_cwd(&self) -> String {
        self.cwd.borrow().clone()
    }
    fn open_path(&mut self, path: &str) {
        self.log.borrow_mut().to_open.push(path.to_owned());
    }
}

/// 状态变化通知：视图 `cx.subscribe` / `cx.observe` 即可重绘。
pub struct StateChanged;

pub struct AppState {
    pub threads: ThreadStore<GuiEffects>,
    /// Settings adapter failure injection, only enabled by deterministic UI rollback tests.
    #[cfg(test)]
    pub settings_write_failure: Option<String>,
    pub settings: SettingsStore<FsAdapter>,
    /// Git 图的运行时态（不落盘）；挂载与流式加载由视图层驱动
    pub git_graph: GitGraphStore,
    /// 当前选中提交的 unified patch（展示于展开详情行）
    pub git_patch: Option<String>,
    /// 当前 git log 流的取消句柄；挂载新仓库时取消旧流
    git_cancel: CancelToken,
    effects: GuiEffects,
    workspace_file: FsAdapter,
    /// ACP 连接表（thread id → 已握手连接）。
    acp: std::collections::HashMap<String, crate::acp_io::AcpConnection>,
    /// Cancellation token 在 spawn 前注册，可安全处理关闭与后台进程创建之间的竞态。
    acp_disposers: std::collections::HashMap<String, crate::acp_io::AcpCancellation>,
    /// 正在后台进行预握手的 ACP 会话集合。
    acp_connecting: std::collections::HashSet<String>,
    /// 连接繁忙期间暂存的配置变更请求（thread_id → Vec<(config_id, value, source)>）。
    acp_pending_configs:
        std::collections::HashMap<String, Vec<(String, String, jagent_core::acp::AcpConfigSource)>>,
    /// 各 ACP 会话缓存的 `session/list` 历史会话列表（thread_id → Vec<AcpSessionSummary>）。
    acp_sessions: std::collections::HashMap<String, Vec<jagent_core::acp::AcpSessionSummary>>,
    /// 正在后台拉取 `session/list` 或执行 `session/load` 的会话集合。
    acp_loading_sessions: std::collections::HashSet<String>,
    /// 最近派发的系统桌面通知历史（上限 32 条）。
    pub dispatched_notifications: Vec<DesktopNotificationRecord>,
}

impl EventEmitter<StateChanged> for AppState {}

impl AppState {
    /// 装配：读盘（settings.json / state.json）→ 建 store。首启无工作区 → 以当前目录建默认工作区。
    pub fn load(dir: PathBuf, default_cwd: String) -> std::io::Result<Self> {
        use jagent_core::settings::FileAdapter;
        let settings = SettingsStore::init(FsAdapter::new(dir.join("settings.json")))?;
        let workspace_file = FsAdapter::new(dir.join("state.json"));
        let raw_state = workspace_file.read()?;
        let workspaces = parse_workspace_state(raw_state.as_deref());
        let persisted_acp = parse_persisted_acp_threads(raw_state.as_deref());
        let effects = GuiEffects::new(default_cwd.clone());
        effects.set_close_on_exit(settings.get().terminal.close_on_exit);
        crate::ui_scale::set_ui_scale_percent(settings.get().appearance.ui_scale);
        let first_run = workspaces.is_empty();
        let mut threads = ThreadStore::new(effects.clone(), workspaces);
        if first_run {
            // 首启：空列表 → 默认工作区（目录 basename 为名）。add_workspace 会置 dirty，
            // 随后第一次 flush 把它写进 state.json。
            threads.add_workspace("", &default_cwd);
        }
        if !persisted_acp.is_empty() {
            threads.restore_persisted_acp_threads(persisted_acp);
        }
        Ok(Self {
            threads,
            settings,
            #[cfg(test)]
            settings_write_failure: None,
            git_graph: GitGraphStore::new(),
            git_patch: None,
            git_cancel: CancelToken::default(),
            effects,
            workspace_file,
            acp: Default::default(),
            acp_disposers: Default::default(),
            acp_connecting: Default::default(),
            acp_pending_configs: Default::default(),
            acp_sessions: Default::default(),
            acp_loading_sessions: Default::default(),
            dispatched_notifications: Vec::new(),
        })
    }

    /// 兑现 core 记下的副作用并持久化：销毁 PTY、派发桌面通知、落盘 workspaces、落盘 settings。
    /// 视图在每次改状态后调用（`update` 内，已持有 `&mut App`）。
    pub fn flush(&mut self, cx: &mut App) {
        use jagent_core::settings::FileAdapter as _;
        let (destroy, notify_ids, dispose, to_open) = {
            let mut log = self.effects.log.borrow_mut();
            (
                std::mem::take(&mut log.to_destroy),
                std::mem::take(&mut log.to_notify),
                std::mem::take(&mut log.to_dispose_acp),
                std::mem::take(&mut log.to_open),
            )
        };
        for path in to_open {
            open_in_system_app(&path);
        }
        let notif_cfg = self.settings.get().notifications.clone();
        if notif_cfg.desktop {
            for tid in notify_ids {
                let (title, body) = self
                    .threads
                    .notices
                    .iter()
                    .rev()
                    .find(|n| n.thread_id == tid)
                    .map(|n| (format!("j-agent · {}", n.sub), n.text.clone()))
                    .or_else(|| {
                        self.threads
                            .thread(&tid)
                            .map(|t| ("j-agent".to_owned(), format!("「{}」等待注意", t.title())))
                    })
                    .unwrap_or_else(|| ("j-agent".to_owned(), "会话状态更新".to_owned()));
                #[cfg(not(test))]
                send_system_desktop_notification(&title, &body, notif_cfg.sound);
                if self.dispatched_notifications.len() >= 32 {
                    self.dispatched_notifications.remove(0);
                }
                self.dispatched_notifications
                    .push(DesktopNotificationRecord {
                        thread_id: tid,
                        title,
                        body,
                        sound: notif_cfg.sound,
                    });
            }
        }
        for thread_id in dispose {
            self.acp.remove(&thread_id);
            self.acp_connecting.remove(&thread_id);
            self.acp_pending_configs.remove(&thread_id);
            self.acp_sessions.remove(&thread_id);
            self.acp_loading_sessions.remove(&thread_id);
            if let Some(disposer) = self.acp_disposers.remove(&thread_id) {
                disposer.cancel();
            }
        }
        for id in destroy {
            cx.update_global::<TerminalPool, _>(|pool, cx| {
                let _ = pool.destroy(id, cx); // 已不在池里（进程自己退出）不算错
            });
        }
        if self.threads.take_workspaces_dirty() {
            let _ = self
                .workspace_file
                .write(&serialize_workspace_and_acp_state(
                    &self.threads.workspaces,
                    &self.threads.threads,
                ));
        }
        #[cfg(test)]
        if let Some(message) = self.settings_write_failure.take() {
            let _ = self.settings.fail_next_write_for_test(&message);
        }
        self.settings.flush();
        self.effects
            .set_close_on_exit(self.settings.get().terminal.close_on_exit);
        apply_terminal_settings(cx, self.settings.get());
        crate::ui_scale::apply_ui_scale(cx, self.settings.get());
    }

    /// 两步 spawn 的第二步在这里合并：begin_spawn → 创建 PTY → finish_spawn。
    pub fn spawn_from_preset(
        &mut self,
        preset_id: &str,
        workspace_id: Option<&str>,
        cx: &mut App,
    ) -> Result<String, SpawnError> {
        let preset: Option<TerminalPreset> = self
            .settings
            .get()
            .presets
            .items
            .iter()
            .find(|p| p.id == preset_id)
            .cloned();
        let req: SpawnRequest = self
            .threads
            .begin_spawn(preset.as_ref(), preset_id, workspace_id)
            .map_err(SpawnError::Store)?;
        let opts = SpawnOptions {
            cwd: Some(PathBuf::from(&req.cwd)),
            program: req.preset.program.clone(),
            args: req.preset.args.clone().unwrap_or_default(),
            env: req
                .preset
                .env
                .clone()
                .map(|m| m.into_iter().collect())
                .unwrap_or_default(),
            init_command: req.preset.init_command.clone(),
            scrollback_lines: Some(self.settings.get().terminal.scrollback_lines as usize),
            style: Some(terminal_style(self.settings.get())),
        };
        let session_id = cx
            .update_global::<TerminalPool, _>(|pool, cx| pool.create(opts, cx))
            .map_err(|e| SpawnError::Pty(e.to_string()))?;
        let id = self.threads.finish_spawn(&req, session_id);
        self.flush(cx);
        Ok(id)
    }

    /// 终端事件 → store。后台线程的事件汇经 [`bridge_terminal_events`] 送到前台后调用。
    pub fn on_terminal_event(&mut self, e: &TermEvent, cx: &mut App) {
        self.threads.on_session_event(match e {
            TermEvent::Title { id, title } => CoreSessionEvent::Title {
                session_id: *id,
                title: Some(title.clone()),
            },
            TermEvent::Bell { id } => CoreSessionEvent::Bell { session_id: *id },
            TermEvent::Exit { id, code } => CoreSessionEvent::Exit {
                session_id: *id,
                code: *code,
            },
        });
        self.flush(cx);
    }

    /// 幂等挂载 Git 图到 cwd；相同 repo 正在加载时复用当前流。
    pub fn mount_git_graph(state: &Entity<Self>, cwd: String, cx: &mut App) {
        Self::mount_git_graph_inner(state, cwd, false, cx);
    }

    /// 用户显式刷新：即使 cwd 与上一次相同，也作废旧流并重新读取提交与分支。
    pub fn refresh_git_graph(state: &Entity<Self>, cwd: String, cx: &mut App) {
        Self::mount_git_graph_inner(state, cwd, true, cx);
    }

    fn mount_git_graph_inner(state: &Entity<Self>, cwd: String, force: bool, cx: &mut App) {
        let (plan, cancel) = state.update(cx, |s, cx| {
            let plan = if force {
                s.git_graph
                    .refresh()
                    .unwrap_or_else(|| s.git_graph.mount(&cwd))
            } else {
                s.git_graph.mount(&cwd)
            };
            if force {
                s.git_patch = None;
            }
            // 只有真的要重新流式加载时才取消旧流；复用（Reuse）不动正在跑的流
            let cancel = if matches!(plan, MountPlan::ResolveRoot(_)) {
                s.git_cancel.cancel();
                s.git_cancel = CancelToken::default();
                Some(s.git_cancel.clone())
            } else {
                None
            };
            cx.notify();
            (plan, cancel)
        });
        let (MountPlan::ResolveRoot(ticket), Some(cancel)) = (plan, cancel) else {
            return;
        };
        let state = state.clone();
        cx.spawn(async move |cx| {
            let state = state.downgrade();
            let root = cx.background_spawn({
                let cwd = cwd.clone();
                async move { find_repo_root(std::path::Path::new(&cwd)) }
            });
            let root = root.await;
            let stream = state.update(cx, |s, cx| match s.git_graph.root_resolved(ticket, root) {
                RootPlan::Stream { root, ticket } => {
                    cx.notify();
                    Some((root, ticket))
                }
                RootPlan::NotARepo => {
                    cx.notify();
                    None
                }
                RootPlan::Stale => None,
            });
            if let Ok(Some((root, ticket))) = stream {
                let branch_root = root.clone();
                let branches = cx
                    .background_spawn(
                        async move { list_branches(std::path::Path::new(&branch_root)) },
                    )
                    .await;
                if let Some(state) = state.upgrade() {
                    cx.update(|cx| {
                        state.update(cx, |s, cx| {
                            if let Ok(branches) = branches {
                                s.git_graph.on_branches(ticket, branches);
                            }
                            cx.emit(StateChanged);
                            cx.notify();
                        })
                    });
                }
                Self::stream_git_log_into(&state, root, ticket, cancel, cx).await;
            }
        })
        .detach();
    }

    /// 后台线程跑阻塞的 `stream_git_log`，每个 chunk 经 channel 送回前台写入 store。
    async fn stream_git_log_into(
        state: &WeakEntity<Self>,
        root: String,
        ticket: Ticket,
        cancel: CancelToken,
        cx: &mut AsyncApp,
    ) {
        use futures::StreamExt as _;
        let (tx, mut rx) = futures::channel::mpsc::unbounded::<Result<Vec<GraphCommit>, String>>();
        let done_tx = tx.clone();
        cx.background_spawn({
            let root = root.clone();
            async move {
                let path = std::path::PathBuf::from(&root);
                let result = stream_git_log(&path, &cancel, |chunk| {
                    let _ = tx.unbounded_send(Ok(chunk));
                });
                let _ = done_tx.unbounded_send(Err(
                    result.map_or_else(|e| e.to_string(), |()| String::new())
                ));
            }
        })
        .detach();
        while let Some(msg) = rx.next().await {
            let Some(state) = state.upgrade() else { break };
            let finished = cx.update(|cx| {
                state.update(cx, |s, cx| match msg {
                    Ok(chunk) => {
                        s.git_graph.on_chunk(ticket, &chunk);
                        cx.notify();
                        false
                    }
                    Err(e) => {
                        let result = if e.is_empty() { Ok(()) } else { Err(e) };
                        s.git_graph.on_stream_done(ticket, result);
                        cx.notify();
                        true
                    }
                })
            });
            if finished {
                break;
            }
        }
    }

    /// Git 图的挂载目录：当前工作区的目录；若为未归属终端会话则取终端 cwd；兜底用启动目录。
    pub fn git_cwd(&self) -> String {
        let id = self.active_workspace_id();
        if let Some(w) = self.threads.workspace(&id) {
            return w.path.clone();
        }
        if let Some(tid) = self.threads.active_thread_id()
            && let Some(t) = self.threads.thread(tid)
            && let Some(term) = t.as_terminal()
            && !term.cwd.is_empty()
        {
            return term.cwd.clone();
        }
        self.effects.default_cwd()
    }

    /// 选中 / 清除 Git 图提交；详情（body + numstat）在后台读取，携带 DetailRequest 代际防止迟到结果覆盖新选中项。
    /// 刷新工作区面板：后台调用 git status + numstat，结果回到 state 并通知。
    pub fn refresh_worktree(state: &Entity<Self>, cwd: String, cx: &mut App) {
        let weak = state.downgrade();
        cx.spawn(async move |cx| {
            let result = cx
                .background_spawn(async move { list_worktree_status(&PathBuf::from(cwd)) })
                .await;
            if let Some(state) = weak.upgrade() {
                cx.update(|cx| {
                    state.update(cx, |_, cx| {
                        cx.emit(StateChanged);
                        cx.notify();
                    });
                });
            }
            result
        })
        .detach();
    }

    /// 读取选中文件的 unified diff，返回前触发状态更新。目前 worktree snapshot 由 WorkPanel 自己持有。
    pub fn load_worktree_diff(
        state: &Entity<Self>,
        root: String,
        path: String,
        cx: &mut App,
        done: impl FnOnce(Result<String, String>) + Send + 'static,
    ) {
        let weak = state.downgrade();
        cx.spawn(async move |cx| {
            let result = cx
                .background_spawn(async move {
                    diff_worktree_file(&PathBuf::from(root), &path).map_err(|e| e.to_string())
                })
                .await;
            if weak.upgrade().is_some() {
                done(result);
            }
        })
        .detach();
    }

    pub fn select_git_commit(state: &Entity<Self>, sha: Option<String>, cx: &mut App) {
        let req = state.update(cx, |s, cx| {
            let req = s.git_graph.select(sha.as_deref());
            s.git_patch = None;
            cx.emit(StateChanged);
            cx.notify();
            req
        });
        let Some(req) = req else { return };
        let weak = state.downgrade();
        cx.spawn(async move |cx| {
            let req_for_bg = req.clone();
            let result = cx
                .background_spawn(async move {
                    let root = PathBuf::from(&req_for_bg.root);
                    let body =
                        show_commit_body(&root, &req_for_bg.sha).map_err(|e| e.to_string())?;
                    let files =
                        list_changed_files(&root, &req_for_bg.sha).map_err(|e| e.to_string())?;
                    let patch = show_patch(&root, &req_for_bg.sha).map_err(|e| e.to_string())?;
                    Ok((body, files, patch))
                })
                .await;
            if let Some(state) = weak.upgrade() {
                cx.update(|cx| {
                    state.update(cx, |s, cx| {
                        let is_current = s.git_graph.detail_request_is_current(&req);
                        s.git_graph.on_detail(
                            &req,
                            result.clone().map(|(body, files, _patch)| (body, files)),
                        );
                        if is_current {
                            // Core ticket is authoritative for body/files; keep the sidecar patch
                            // in lockstep, including failures (clear rather than leave stale text).
                            s.git_patch = result.ok().map(|(_, _, patch)| patch);
                        }
                        cx.emit(StateChanged);
                        cx.notify();
                    });
                });
            }
        })
        .detach();
    }

    /// Git 图工具条的「显示远程分支」开关（纯视图偏好，core 已有规则）。
    pub fn set_git_show_remote(state: &Entity<Self>, on: bool, cx: &mut App) {
        state.update(cx, |s, cx| {
            s.git_graph.set_show_remote(on);
            cx.emit(StateChanged);
            cx.notify();
        });
    }

    /// 在仓库根执行一条 git 命令（右键菜单 / 分支切换 / fetch 等）：
    /// 后台跑子进程，结果经 core 的 `finish_action`——成功触发重新挂载刷新，失败进 `action_error` 错误条。
    pub fn run_git_action(state: &Entity<Self>, argv: Vec<String>, cx: &mut App) {
        let Some(root) = state.update(cx, |s, cx| {
            cx.notify();
            s.git_graph.begin_action()
        }) else {
            return;
        };
        let weak = state.downgrade();
        cx.spawn(async move |cx| {
            let argv_bg = argv.clone();
            let result = cx
                .background_spawn(async move {
                    let output = std::process::Command::new("git")
                        .args(&argv_bg)
                        .current_dir(&root)
                        .output()
                        .map_err(|e| e.to_string())?;
                    if output.status.success() {
                        Ok(())
                    } else {
                        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
                    }
                })
                .await;
            if let Some(state) = weak.upgrade() {
                cx.update(|cx| {
                    let plan = state.update(cx, |s, cx| {
                        let plan = s.git_graph.finish_action(result);
                        cx.emit(StateChanged);
                        cx.notify();
                        plan
                    });
                    // 成功后刷新（finish_action 已重置挂载态，重新拉流即重新生效）
                    if plan.is_some() {
                        let cwd = state.read(cx).git_cwd();
                        Self::mount_git_graph_inner(&state, cwd, false, cx);
                    }
                });
            }
        })
        .detach();
    }

    pub fn activate(&mut self, target: ActiveTarget, cx: &mut App) {
        self.threads.activate(target);
        self.flush(cx);
    }

    /// Close a thread and synchronously terminate any active ACP process, including one whose
    /// connection is currently owned by an in-flight background prompt/handshake.
    pub fn close_thread(&mut self, thread_id: &str, cx: &mut Context<Self>) {
        if let Some(cancellation) = self.acp_disposers.remove(thread_id) {
            cancellation.cancel();
        }
        self.acp.remove(thread_id);
        self.acp_connecting.remove(thread_id);
        self.acp_pending_configs.remove(thread_id);
        self.acp_sessions.remove(thread_id);
        self.acp_loading_sessions.remove(thread_id);
        self.threads.close(thread_id);
        self.flush(cx);
        cx.emit(StateChanged);
    }

    /// 会话内新建 shell 视图：store 算 cwd（会话 → 工作区 → 进程 CWD）并校验会话存在；这里起真 PTY，回写视图。
    pub fn add_session_shell(&mut self, thread_id: &str, cx: &mut App) -> Result<(), String> {
        let cwd = self
            .threads
            .begin_add_session_shell(thread_id)
            .ok_or_else(|| format!("会话不存在：{thread_id}"))?;
        let opts = SpawnOptions {
            cwd: Some(PathBuf::from(&cwd)),
            program: None,
            args: vec![],
            env: vec![],
            init_command: None,
            scrollback_lines: Some(self.settings.get().terminal.scrollback_lines as usize),
            style: Some(terminal_style(self.settings.get())),
        };
        let session_id = cx
            .update_global::<TerminalPool, _>(|pool, cx| pool.create(opts, cx))
            .map_err(|e| e.to_string())?;
        self.threads
            .finish_add_session_shell(thread_id, session_id, cwd);
        self.flush(cx);
        Ok(())
    }

    /// 切换会话内视图（`MAIN_VIEW_ID` = 主面）。
    pub fn activate_view(&mut self, thread_id: &str, view_id: &str, cx: &mut App) {
        self.threads.activate_session_view(thread_id, view_id);
        self.flush(cx);
    }

    /// 关闭会话内视图：shell 视图连带销毁 PTY（经 flush 兑现）。主面不可关。
    pub fn close_view(&mut self, thread_id: &str, view_id: &str, cx: &mut App) {
        self.threads.close_session_view(thread_id, view_id);
        self.flush(cx);
    }

    /// 新建对话线程（New Chat）。归属工作区必填，由 core 校验。
    pub fn create_chat(
        &mut self,
        workspace_id: Option<&str>,
        cx: &mut App,
    ) -> Result<String, StoreError> {
        let id = self.threads.create_chat(workspace_id)?;
        self.flush(cx);
        Ok(id)
    }

    /// 新建 ACP 线程。label 由调用方从 settings 快照取出传入（store 不读 settings）。
    pub fn create_acp(
        &mut self,
        agent_id: &str,
        label: &str,
        workspace_id: Option<&str>,
        cx: &mut App,
    ) -> Result<String, StoreError> {
        let id = self
            .threads
            .create_acp_thread(agent_id, label, workspace_id)?;
        self.flush(cx);
        Ok(id)
    }

    /// 「新建会话」的默认归属：激活工作区本身；激活会话则取其所属工作区；其余（起始页 / 设置）为空串 = 临时入口。
    pub fn active_workspace_id(&self) -> String {
        match self.threads.active() {
            ActiveTarget::Workspace(id) => id.clone(),
            ActiveTarget::Thread(id) => self
                .threads
                .thread(id)
                .and_then(|t| t.workspace_id())
                .unwrap_or_default()
                .to_owned(),
            ActiveTarget::Settings | ActiveTarget::Home => String::new(),
        }
    }

    pub fn send_message(
        &mut self,
        thread_id: &str,
        text: &str,
        kind: ConversationKind,
    ) -> Option<jagent_core::threads::SendRequest> {
        self.threads.begin_send(thread_id, text, kind)
    }

    /// 当前已建立或正在运行中的 ACP 会话连接数。
    pub fn active_acp_count(&self) -> usize {
        self.acp.len()
            + self
                .acp_disposers
                .keys()
                .filter(|k| !self.acp.contains_key(*k))
                .count()
    }

    /// 指定会话是否已持有活跃的 ACP 连接。
    pub fn is_acp_connected(&self, thread_id: &str) -> bool {
        self.acp.contains_key(thread_id) || self.threads.is_acp_connected(thread_id)
    }

    /// 指定会话是否正在后台建立 ACP 连接（拉取模型/模式列表中）。
    pub fn is_acp_connecting(&self, thread_id: &str) -> bool {
        self.acp_connecting.contains(thread_id)
    }

    /// 读取指定 ACP 会话已缓存的历史会话列表（`session/list`）。
    pub fn acp_session_list(&self, thread_id: &str) -> &[jagent_core::acp::AcpSessionSummary] {
        self.acp_sessions
            .get(thread_id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// 指定会话是否正在后台拉取历史会话列表或恢复历史会话。
    pub fn is_acp_loading_sessions(&self, thread_id: &str) -> bool {
        self.acp_loading_sessions.contains(thread_id)
    }

    /// 切换 ACP 会话的目标 agent，同时终止并清理旧连接（下次发送或预握手时按新 agent 建连）。
    pub fn switch_acp_agent(&mut self, thread_id: &str, agent_id: &str, label: &str, cx: &mut App) {
        if let Some(cancellation) = self.acp_disposers.remove(thread_id) {
            cancellation.cancel();
        }
        self.acp.remove(thread_id);
        self.acp_connecting.remove(thread_id);
        self.acp_pending_configs.remove(thread_id);
        self.acp_sessions.remove(thread_id);
        self.acp_loading_sessions.remove(thread_id);
        self.threads.set_acp_agent(thread_id, agent_id, label);
        self.flush(cx);
    }

    pub fn workspaces(&self) -> &[Workspace] {
        &self.threads.workspaces
    }
}

#[derive(Debug)]
pub enum SpawnError {
    Store(StoreError),
    Pty(String),
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Pty(e) => write!(f, "无法启动终端：{e}"),
        }
    }
}

impl std::error::Error for SpawnError {}

/// 把 `jagent-terminal` 的全局事件汇（后台线程里回调，`Send + Sync`）桥接到前台：
/// 回调只往 channel 里塞事件，前台任务取出后调用 `AppState::on_terminal_event`。
///
/// `set_session_event_fn` 是进程级 `OnceLock`，只能设置一次，所以此函数也只应调用一次。
pub fn bridge_terminal_events(state: &Entity<AppState>, cx: &mut App) {
    let (tx, mut rx) = futures::channel::mpsc::unbounded::<TermEvent>();
    jagent_terminal::set_session_event_fn(std::sync::Arc::new(move |e| {
        let _ = tx.unbounded_send(e.clone());
    }));
    let state = state.downgrade();
    cx.spawn(async move |cx| {
        use futures::StreamExt as _;
        while let Some(e) = rx.next().await {
            let Some(state) = state.upgrade() else { break };
            cx.update(|cx| {
                state.update(cx, |s, cx| {
                    s.on_terminal_event(&e, cx);
                });
                state.update(cx, |_, cx| cx.emit(StateChanged));
            });
        }
    })
    .detach();
}

pub fn terminal_style(settings: &Settings) -> jagent_terminal::TerminalStyle {
    jagent_terminal::TerminalStyle {
        font_family: settings.terminal.font_family.clone().into(),
        font_size: gpui::px(settings.terminal.font_size as f32),
        line_height_multiplier: 1.2,
        padding: gpui::Edges::all(gpui::px(8.0)),
        palette: settings.terminal.palette.clone().into(),
        cursor_blink: settings.terminal.cursor_blink,
    }
}

/// Apply terminal appearance settings to every active pooled session.
pub fn apply_terminal_settings(cx: &mut App, settings: &Settings) {
    let style = terminal_style(settings);
    cx.update_global::<TerminalPool, _>(|pool, cx| pool.set_style_all(style, cx));
}

/// chat 回复的模拟等待时长（旧 `createEchoAgent` 默认 600ms）。
pub const CHAT_REPLY_DELAY: std::time::Duration = std::time::Duration::from_millis(600);

/// chat 发送：落 user 消息并置等待 → 后台等待 → 落本地回声。空串 / 等待中由 core 忽略。
pub fn send_chat(state: &Entity<AppState>, thread_id: &str, text: &str, cx: &mut App) {
    let req = state.update(cx, |s, cx| {
        let r = s
            .threads
            .begin_send(thread_id, text, ConversationKind::Chat);
        s.flush(cx);
        cx.emit(StateChanged);
        r
    });
    let Some(req) = req else { return };
    let state = state.downgrade();
    cx.spawn(async move |cx| {
        cx.background_executor().timer(CHAT_REPLY_DELAY).await;
        let Some(state) = state.upgrade() else { return };
        let reply = echo_reply(&req.text);
        cx.update(|cx| {
            state.update(cx, |s, cx| {
                s.threads.finish_send(&req.thread_id, req.kind, Ok(reply));
                s.flush(cx);
                cx.emit(StateChanged);
            });
        });
    })
    .detach();
}

/// ACP 发送：落 user 消息 → 惰性连接（后台 spawn + 握手）→ 后台跑一轮 prompt → 回写 assistant 行。
///
/// 规则在 core（`begin_send` / `mark_acp_connected` / `fail_acp_connect` / `finish_send`）；
/// 阻塞的进程 IO 全部在 `background_spawn`，结果经 `state.update` 回到前台。
pub fn send_acp(state: &Entity<AppState>, thread_id: &str, text: &str, cx: &mut App) {
    send_acp_with_prompt(state, thread_id, text, text, cx);
}

/// ACP 发送（支持展示文本 `display_text` 与实际发给 agent 的 `prompt_text` 分离，例如附带文件上下文时）。
pub fn send_acp_with_prompt(
    state: &Entity<AppState>,
    thread_id: &str,
    display_text: &str,
    prompt_text: &str,
    cx: &mut App,
) {
    let req = state.update(cx, |s, cx| {
        let r = s
            .threads
            .begin_send(thread_id, display_text, ConversationKind::Acp);
        s.flush(cx);
        cx.emit(StateChanged);
        r
    });
    let Some(req) = req else { return };
    let Some(agent_id) = req.agent_id.clone() else {
        return;
    };
    let prompt_payload = if prompt_text.trim().is_empty() {
        req.text.clone()
    } else {
        prompt_text.to_owned()
    };
    let cancellation = crate::acp_io::AcpCancellation::default();
    // 取出已有连接（所有权转移到后台任务），而不是复制；若此前预握手仍在进行则先取消预握手。
    let (command, args, cwd, existing, pending_cfgs, resume_sid) = state.update(cx, |s, _| {
        let existing = s.acp.remove(thread_id);
        if existing.is_none() && s.acp_connecting.remove(thread_id) {
            if let Some(prev_cancel) = s.acp_disposers.remove(thread_id) {
                prev_cancel.cancel();
            }
        }
        s.acp_disposers
            .insert(thread_id.to_owned(), cancellation.clone());
        let agent = s
            .settings
            .get()
            .acp_agents
            .iter()
            .find(|a| a.id == agent_id)
            .cloned();
        let cwd = s
            .threads
            .thread(thread_id)
            .and_then(|t| t.workspace_id())
            .and_then(|w| s.threads.workspace(w))
            .map(|w| w.path.clone());
        let cwd = cwd.unwrap_or_else(|| s.git_cwd());
        let pending_cfgs = s.acp_pending_configs.remove(thread_id).unwrap_or_default();
        let resume_sid = s.threads.acp_session_id(thread_id).map(str::to_owned);
        (
            agent.as_ref().map(|a| a.command.clone()),
            agent.map(|a| a.args).unwrap_or_default(),
            cwd,
            existing,
            pending_cfgs,
            resume_sid,
        )
    });
    if let Some(conn) = existing.as_ref() {
        cancellation.register(conn.disposer());
    }
    // This copy stays in the UI-owned state update closure: if the background connection
    // fails after the thread was closed, suppress finish_acp (which would otherwise surface
    // a stale error and partially update the closed thread).
    let cancellation_for_completion = cancellation.clone();

    let state = state.downgrade();
    cx.spawn(async move |cx| {
        let thread_id = req.thread_id.clone();
        let text = prompt_payload;
        // 连接的所有权在后台任务内流转：取出（已有）或新建 → 用一轮 → 放回表。不跨 await 持有共享引用。
        let conn: Result<crate::acp_io::AcpConnection, String> = match existing {
            Some(c) => Ok(c),
            None => match command {
                None => Err("settings 中找不到该 ACP agent".into()),
                Some(command) => {
                    let thread_is_open = state.upgrade().is_some_and(|st| {
                        cx.update(|cx| st.read(cx).threads.thread(&thread_id).is_some())
                    });
                    if !thread_is_open || cancellation.is_cancelled() {
                        return;
                    }
                    let path = std::path::PathBuf::from(cwd);
                    let cancellation_for_connect = cancellation.clone();
                    cx.background_spawn(async move {
                        crate::acp_io::AcpConnection::connect_or_load_with_disposer(
                            &command,
                            &args,
                            &path,
                            resume_sid.as_deref(),
                            move |d| {
                                cancellation_for_connect.register(d);
                            },
                        )
                        .map_err(|e| format!("无法建立 ACP 连接：{e}"))
                    })
                    .await
                }
            },
        };
        let mut conn = match conn {
            Ok(c) => c,
            Err(e) => {
                if cancellation_for_completion.is_cancelled() {
                    return;
                }
                finish_acp(&state, &thread_id, Err(e), cx).await;
                return;
            }
        };
        cancellation.register(conn.disposer());
        if cancellation.is_cancelled() {
            return;
        }
        // 握手完成即刻把 sessionId、模型选择器、可用命令、启动欢迎信息同步回 UI
        let remote_sid = conn.session_id().to_owned();
        let initial_selectors = conn.config_selectors.clone();
        let initial_commands = conn.available_commands.clone();
        let initial_startup = conn.startup_info.clone();
        if let Some(st) = state.upgrade() {
            cx.update(|cx| {
                st.update(cx, |s, cx| {
                    s.threads.mark_acp_connected(&thread_id);
                    s.threads.set_acp_session_id(&thread_id, &remote_sid);
                    if !initial_selectors.is_empty() {
                        s.threads
                            .set_acp_config_selectors(&thread_id, initial_selectors);
                    }
                    if !initial_commands.is_empty() {
                        s.threads
                            .set_acp_available_commands(&thread_id, initial_commands);
                    }
                    if let Some(startup) = initial_startup.as_deref() {
                        s.threads.push_acp_startup_info(&thread_id, startup);
                    }
                    s.flush(cx);
                    cx.emit(StateChanged);
                });
            });
        }
        // prompt 在后台跑；若握手前有暂存的模型/思考等级变更先一并应用，再发 session/prompt。
        use futures::{FutureExt as _, StreamExt as _};
        let (chunk_tx, mut chunk_rx) =
            futures::channel::mpsc::unbounded::<crate::acp_io::AcpTurnUpdate>();
        let turn_task = cx
            .background_spawn(async move {
                for (cid, val, src) in pending_cfgs {
                    let _ = conn.set_config_value(&cid, &val, src);
                }
                let turn = conn
                    .prompt_structured(&text, chunk_tx)
                    .map_err(|e| e.to_string());
                (conn, turn)
            })
            .fuse();
        futures::pin_mut!(turn_task);
        let (conn, turn) = loop {
            let next_chunk = chunk_rx.next().fuse();
            futures::pin_mut!(next_chunk);
            futures::select! {
                chunk = next_chunk => {
                    let Some(chunk) = chunk else { continue };
                    if let Some(st) = state.upgrade() {
                        cx.update(|cx| {
                            st.update(cx, |s, cx| {
                                if let Some(selectors) = chunk.config_selectors {
                                    s.threads.set_acp_config_selectors(&thread_id, selectors);
                                }
                                if let Some(commands) = chunk.available_commands {
                                    s.threads.set_acp_available_commands(&thread_id, commands);
                                }
                                s.threads.update_streaming_reply_full(
                                    &thread_id,
                                    ConversationKind::Acp,
                                    &chunk.text,
                                    &chunk.thought,
                                    chunk.tool_calls,
                                );
                                s.flush(cx);
                                cx.emit(StateChanged);
                            });
                        });
                    } else {
                        return;
                    }
                },
                result = turn_task => break result,
            }
        };
        // 连接交还表：thread 已 close 则连接在此 drop（杀进程）
        let mut need_drain_configs = false;
        if let Some(st) = state.upgrade() {
            cx.update(|cx| {
                st.update(cx, |s, cx| {
                    // thread 已 close：连接在此 drop，子进程被杀
                    if s.threads.thread(&thread_id).is_some() {
                        if !conn.config_selectors.is_empty() {
                            s.threads.set_acp_config_selectors(
                                &thread_id,
                                conn.config_selectors.clone(),
                            );
                        }
                        if !conn.available_commands.is_empty() {
                            s.threads.set_acp_available_commands(
                                &thread_id,
                                conn.available_commands.clone(),
                            );
                        }
                        s.acp_disposers
                            .insert(thread_id.clone(), cancellation.clone());
                        s.acp.insert(thread_id.clone(), conn);
                        s.threads.mark_acp_connected(&thread_id);
                        need_drain_configs = s
                            .acp_pending_configs
                            .get(&thread_id)
                            .is_some_and(|q| !q.is_empty());
                    } else {
                        s.acp_disposers.remove(&thread_id);
                        cancellation.cancel();
                    }
                    s.flush(cx);
                });
                if need_drain_configs {
                    drain_pending_acp_configs(&st, &thread_id, cx);
                }
            });
        }
        finish_acp(&state, &thread_id, turn, cx).await;
    })
    .detach();
}

/// 预连接 ACP 会话（进入会话或切换 Agent 后在后台自动完成 `initialize` + `session/new`（或 `session/load`）握手，
/// 从而立即获取 `configOptions` 模型与思考强度列表，若会话带有持久化的 `acp_session_id` 则一并恢复历史对话记录）。
pub fn ensure_acp_connected(state: &Entity<AppState>, thread_id: &str, cx: &mut App) {
    let setup = state.update(cx, |s, cx| {
        if s.acp.contains_key(thread_id) || s.acp_connecting.contains(thread_id) {
            return None;
        }
        let Some(Thread::Acp(acp_thread)) = s.threads.thread(thread_id) else {
            return None;
        };
        if acp_thread.pending_reply {
            return None;
        }
        let agent_id = acp_thread.agent_id.clone();
        let ws_id = acp_thread.common.workspace_id.clone();
        let resume_sid = acp_thread.acp_session_id.clone();
        let agent = s
            .settings
            .get()
            .acp_agents
            .iter()
            .find(|a| a.id == agent_id)
            .cloned()?;
        let cwd = ws_id
            .as_deref()
            .and_then(|w| s.threads.workspace(w))
            .map(|w| w.path.clone())
            .unwrap_or_else(|| s.git_cwd());
        let cancellation = crate::acp_io::AcpCancellation::default();
        s.acp_connecting.insert(thread_id.to_owned());
        s.acp_disposers
            .insert(thread_id.to_owned(), cancellation.clone());
        cx.emit(StateChanged);
        cx.notify();
        Some((agent.command, agent.args, cwd, resume_sid, cancellation))
    });
    let Some((command, args, cwd, resume_sid, cancellation)) = setup else {
        return;
    };
    let tid = thread_id.to_owned();
    let weak = state.downgrade();
    cx.spawn(async move |cx| {
        let path = std::path::PathBuf::from(cwd);
        let cancel_for_spawn = cancellation.clone();
        let res = cx
            .background_spawn(async move {
                crate::acp_io::AcpConnection::connect_or_load_with_disposer(
                    &command,
                    &args,
                    &path,
                    resume_sid.as_deref(),
                    move |d| {
                        cancel_for_spawn.register(d);
                    },
                )
            })
            .await;
        let Some(st) = weak.upgrade() else { return };
        cx.update(|cx| {
            let mut need_drain = false;
            st.update(cx, |s, cx| {
                s.acp_connecting.remove(&tid);
                if cancellation.is_cancelled() || s.threads.thread(&tid).is_none() {
                    return;
                }
                if let Ok(mut conn) = res {
                    cancellation.register(conn.disposer());
                    let sid = conn.session_id().to_owned();
                    let replayed = std::mem::take(&mut conn.replayed_messages);
                    if !replayed.is_empty() {
                        s.threads.apply_acp_session_load(
                            &tid,
                            &sid,
                            None,
                            replayed,
                            conn.config_selectors.clone(),
                            conn.available_commands.clone(),
                        );
                    } else {
                        s.threads.set_acp_session_id(&tid, &sid);
                        if !conn.config_selectors.is_empty() {
                            s.threads
                                .set_acp_config_selectors(&tid, conn.config_selectors.clone());
                        }
                        if !conn.available_commands.is_empty() {
                            s.threads
                                .set_acp_available_commands(&tid, conn.available_commands.clone());
                        }
                        if let Some(startup) = conn.startup_info.as_deref() {
                            s.threads.push_acp_startup_info(&tid, startup);
                        }
                    }
                    s.threads.mark_acp_connected(&tid);
                    s.acp.insert(tid.clone(), conn);
                    need_drain = s
                        .acp_pending_configs
                        .get(&tid)
                        .is_some_and(|q| !q.is_empty());
                }
                s.flush(cx);
                cx.emit(StateChanged);
                cx.notify();
            });
            if need_drain {
                drain_pending_acp_configs(&st, &tid, cx);
            }
        });
    })
    .detach();
}

/// 在后台调用 `session/list` 拉取当前工作区下的 ACP 历史会话列表（供 `/resume` 浮层展示）。
pub fn fetch_acp_session_list(state: &Entity<AppState>, thread_id: &str, cx: &mut App) {
    let taken = state.update(cx, |s, cx| {
        if s.acp_loading_sessions.contains(thread_id) {
            return None;
        }
        let Some(Thread::Acp(acp_thread)) = s.threads.thread(thread_id) else {
            return None;
        };
        if acp_thread.pending_reply {
            return None;
        }
        let agent_id = acp_thread.agent_id.clone();
        let ws_id = acp_thread.common.workspace_id.clone();
        let resume_sid = acp_thread.acp_session_id.clone();
        let existing = s.acp.remove(thread_id);
        if existing.is_none() && s.acp_connecting.remove(thread_id) {
            if let Some(prev_cancel) = s.acp_disposers.remove(thread_id) {
                prev_cancel.cancel();
            }
        }
        let agent = s
            .settings
            .get()
            .acp_agents
            .iter()
            .find(|a| a.id == agent_id)
            .cloned()?;
        let cwd = ws_id
            .as_deref()
            .and_then(|w| s.threads.workspace(w))
            .map(|w| w.path.clone())
            .unwrap_or_else(|| s.git_cwd());
        let cancellation = crate::acp_io::AcpCancellation::default();
        if let Some(c) = existing.as_ref() {
            cancellation.register(c.disposer());
        }
        s.acp_disposers
            .insert(thread_id.to_owned(), cancellation.clone());
        s.acp_loading_sessions.insert(thread_id.to_owned());
        cx.emit(StateChanged);
        cx.notify();
        Some((
            existing,
            agent.command,
            agent.args,
            cwd,
            resume_sid,
            cancellation,
        ))
    });
    let Some((existing, command, args, cwd, resume_sid, cancellation)) = taken else {
        return;
    };
    let tid = thread_id.to_owned();
    let weak = state.downgrade();
    cx.spawn(async move |cx| {
        let cancel_for_spawn = cancellation.clone();
        let res = cx
            .background_spawn(async move {
                let mut conn = match existing {
                    Some(c) => c,
                    None => crate::acp_io::AcpConnection::connect_or_load_with_disposer(
                        &command,
                        &args,
                        std::path::Path::new(&cwd),
                        resume_sid.as_deref(),
                        move |d| {
                            cancel_for_spawn.register(d);
                        },
                    )?,
                };
                let sessions = conn.list_sessions(Some(&cwd)).unwrap_or_default();
                Ok::<_, crate::acp_io::AcpError>((conn, sessions))
            })
            .await;
        let Some(st) = weak.upgrade() else { return };
        cx.update(|cx| {
            let mut need_drain = false;
            st.update(cx, |s, cx| {
                s.acp_loading_sessions.remove(&tid);
                if cancellation.is_cancelled() || s.threads.thread(&tid).is_none() {
                    return;
                }
                if let Ok((conn, sessions)) = res {
                    cancellation.register(conn.disposer());
                    s.threads.set_acp_session_id(&tid, conn.session_id());
                    if !conn.config_selectors.is_empty() {
                        s.threads
                            .set_acp_config_selectors(&tid, conn.config_selectors.clone());
                    }
                    if !conn.available_commands.is_empty() {
                        s.threads
                            .set_acp_available_commands(&tid, conn.available_commands.clone());
                    }
                    if let Some(startup) = conn.startup_info.as_deref() {
                        s.threads.push_acp_startup_info(&tid, startup);
                    }
                    s.acp_sessions.insert(tid.clone(), sessions);
                    s.threads.mark_acp_connected(&tid);
                    s.acp.insert(tid.clone(), conn);
                    need_drain = s
                        .acp_pending_configs
                        .get(&tid)
                        .is_some_and(|q| !q.is_empty());
                }
                s.flush(cx);
                cx.emit(StateChanged);
                cx.notify();
            });
            if need_drain {
                drain_pending_acp_configs(&st, &tid, cx);
            }
        });
    })
    .detach();
}

/// 在后台调用 `session/load` 恢复指定的历史会话，并将回放的多轮消息、标题与配置选择器写回当前 `AcpThread`。
pub fn resume_acp_session(
    state: &Entity<AppState>,
    thread_id: &str,
    target_session_id: &str,
    title: Option<String>,
    cx: &mut App,
) {
    let target_sid = target_session_id.trim().to_owned();
    if target_sid.is_empty() {
        return;
    }
    let taken = state.update(cx, |s, cx| {
        let Some(Thread::Acp(acp_thread)) = s.threads.thread(thread_id) else {
            return None;
        };
        if acp_thread.pending_reply {
            return None;
        }
        let agent_id = acp_thread.agent_id.clone();
        let ws_id = acp_thread.common.workspace_id.clone();
        let existing = s.acp.remove(thread_id);
        if existing.is_none() && s.acp_connecting.remove(thread_id) {
            if let Some(prev_cancel) = s.acp_disposers.remove(thread_id) {
                prev_cancel.cancel();
            }
        }
        let agent = s
            .settings
            .get()
            .acp_agents
            .iter()
            .find(|a| a.id == agent_id)
            .cloned()?;
        let cwd = ws_id
            .as_deref()
            .and_then(|w| s.threads.workspace(w))
            .map(|w| w.path.clone())
            .unwrap_or_else(|| s.git_cwd());
        let cancellation = crate::acp_io::AcpCancellation::default();
        if let Some(c) = existing.as_ref() {
            cancellation.register(c.disposer());
        }
        s.acp_disposers
            .insert(thread_id.to_owned(), cancellation.clone());
        s.acp_loading_sessions.insert(thread_id.to_owned());
        cx.emit(StateChanged);
        cx.notify();
        Some((existing, agent.command, agent.args, cwd, cancellation))
    });
    let Some((existing, command, args, cwd, cancellation)) = taken else {
        return;
    };
    let tid = thread_id.to_owned();
    let weak = state.downgrade();
    cx.spawn(async move |cx| {
        let cancel_for_spawn = cancellation.clone();
        let sid_for_bg = target_sid.clone();
        let res = cx
            .background_spawn(async move {
                let path = std::path::Path::new(&cwd);
                match existing {
                    Some(mut conn) => {
                        let replayed = conn.load_session(&sid_for_bg, path)?;
                        Ok::<_, crate::acp_io::AcpError>((conn, replayed))
                    }
                    None => {
                        let mut conn = crate::acp_io::AcpConnection::connect_or_load_with_disposer(
                            &command,
                            &args,
                            path,
                            Some(&sid_for_bg),
                            move |d| {
                                cancel_for_spawn.register(d);
                            },
                        )?;
                        let replayed = std::mem::take(&mut conn.replayed_messages);
                        Ok((conn, replayed))
                    }
                }
            })
            .await;
        let Some(st) = weak.upgrade() else { return };
        cx.update(|cx| {
            let mut need_drain = false;
            st.update(cx, |s, cx| {
                s.acp_loading_sessions.remove(&tid);
                if cancellation.is_cancelled() || s.threads.thread(&tid).is_none() {
                    return;
                }
                if let Ok((conn, replayed)) = res {
                    cancellation.register(conn.disposer());
                    s.threads.apply_acp_session_load(
                        &tid,
                        conn.session_id(),
                        title.as_deref(),
                        replayed,
                        conn.config_selectors.clone(),
                        conn.available_commands.clone(),
                    );
                    s.acp.insert(tid.clone(), conn);
                    need_drain = s
                        .acp_pending_configs
                        .get(&tid)
                        .is_some_and(|q| !q.is_empty());
                }
                s.flush(cx);
                cx.emit(StateChanged);
                cx.notify();
            });
            if need_drain {
                drain_pending_acp_configs(&st, &tid, cx);
            }
        });
    })
    .detach();
}

/// 切换 ACP 会话的配置项（如 `model`、`thought_level`、`mode`）：
/// 1. 立即乐观更新 `ThreadStore` 中的当前选中值，UI 零延迟响应；
/// 2. 将变更排入队列，若当前连接空闲则立即在后台发送 `session/set_config_option`（或 `set_model`/`set_mode`），
///    若连接正在执行 prompt 则在归还连接时自动应用。
pub fn set_acp_config_option(
    state: &Entity<AppState>,
    thread_id: &str,
    config_id: &str,
    value: &str,
    cx: &mut App,
) {
    let queued = state.update(cx, |s, cx| {
        let source = s
            .threads
            .update_acp_config_value(thread_id, config_id, value)?;
        let queue = s
            .acp_pending_configs
            .entry(thread_id.to_owned())
            .or_default();
        // 同一 config_id 只保留最新一次选择
        queue.retain(|(cid, _, _)| cid != config_id);
        queue.push((config_id.to_owned(), value.to_owned(), source));
        s.flush(cx);
        cx.emit(StateChanged);
        cx.notify();
        Some(())
    });
    if queued.is_some() {
        drain_pending_acp_configs(state, thread_id, cx);
    }
}

fn drain_pending_acp_configs(state: &Entity<AppState>, thread_id: &str, cx: &mut App) {
    let taken = state.update(cx, |s, _| {
        let has_pending = s
            .acp_pending_configs
            .get(thread_id)
            .is_some_and(|q| !q.is_empty());
        if !has_pending {
            return None;
        }
        let conn = s.acp.remove(thread_id)?;
        let items = s.acp_pending_configs.remove(thread_id).unwrap_or_default();
        let cancel = s.acp_disposers.get(thread_id).cloned().unwrap_or_default();
        Some((conn, items, cancel))
    });
    let Some((mut conn, items, cancellation)) = taken else {
        return;
    };
    let tid = thread_id.to_owned();
    let weak = state.downgrade();
    cx.spawn(async move |cx| {
        let (conn, latest_selectors) = cx
            .background_spawn(async move {
                let mut latest = None;
                for (cid, val, src) in items {
                    if let Ok(sels) = conn.set_config_value(&cid, &val, src) {
                        latest = Some(sels);
                    }
                }
                (conn, latest)
            })
            .await;
        let Some(st) = weak.upgrade() else { return };
        cx.update(|cx| {
            let mut more = false;
            st.update(cx, |s, cx| {
                if cancellation.is_cancelled() || s.threads.thread(&tid).is_none() {
                    return;
                }
                if let Some(sels) = latest_selectors
                    && !sels.is_empty()
                {
                    s.threads.set_acp_config_selectors(&tid, sels);
                }
                s.acp.insert(tid.clone(), conn);
                s.threads.mark_acp_connected(&tid);
                more = s
                    .acp_pending_configs
                    .get(&tid)
                    .is_some_and(|q| !q.is_empty());
                s.flush(cx);
                cx.emit(StateChanged);
                cx.notify();
            });
            if more {
                drain_pending_acp_configs(&st, &tid, cx);
            }
        });
    })
    .detach();
}

/// 回写一轮结果：成功走 finish_send_full；连接 / 协议失败也走 finish_send_full，
/// 思考留空（错误发生在定稿边界，流式阶段已经写入的 thought 由 store 在错误时保留）。
/// thread 已 close 则丢弃（core 内部处理）。
async fn finish_acp(
    state: &WeakEntity<AppState>,
    thread_id: &str,
    reply: Result<crate::acp_io::AcpTurnUpdate, String>,
    cx: &mut AsyncApp,
) {
    let Some(state) = state.upgrade() else { return };
    cx.update(|cx| {
        state.update(cx, |s, cx| {
            match reply {
                Ok(u) => s.threads.finish_send_full(
                    thread_id,
                    ConversationKind::Acp,
                    Ok(u.text),
                    u.thought,
                    u.tool_calls,
                ),
                Err(e) => s.threads.finish_send_full(
                    thread_id,
                    ConversationKind::Acp,
                    Err(e),
                    String::new(),
                    Vec::new(),
                ),
            }
            s.flush(cx);
            cx.emit(StateChanged);
        });
    });
}

/// 构造并注册到 App（`Entity<AppState>`）。
pub fn init(cx: &mut App, dir: PathBuf, default_cwd: String) -> std::io::Result<Entity<AppState>> {
    TerminalPool::init_global(cx);
    let state =
        cx.new(|_: &mut Context<AppState>| AppState::load(dir, default_cwd).expect("加载应用状态"));
    let settings = state.read(cx).settings.get().clone();
    crate::ui_scale::apply_ui_scale(cx, &settings);
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use jagent_core::git::GitGraphStatus;
    use jagent_core::threads::ActiveTarget;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn first_load_creates_a_default_workspace_named_after_the_directory_and_flush_writes_it() {
        let dir = tmp();
        let mut st = AppState::load(dir.path().to_path_buf(), "/Users/u/proj-x".into()).unwrap();
        assert_eq!(st.workspaces().len(), 1);
        assert_eq!(st.workspaces()[0].name, "proj-x");
        assert_eq!(st.workspaces()[0].path, "/Users/u/proj-x");
        assert!(st.threads.take_workspaces_dirty(), "首启的默认工作区待落盘");
        // 落盘：直接用 core 的序列化写，等价于 flush 里的那条分支（flush 需要 App，下面的 gpui 测试覆盖）
        let raw = serialize_workspace_state(st.workspaces());
        std::fs::write(dir.path().join("state.json"), raw).unwrap();
        let again = AppState::load(dir.path().to_path_buf(), "/elsewhere".into()).unwrap();
        assert_eq!(
            again.workspaces().len(),
            1,
            "有 state.json 后不再建默认工作区"
        );
        assert_eq!(again.workspaces()[0].name, "proj-x");
    }

    #[test]
    fn settings_are_loaded_from_settings_json_and_close_on_exit_reaches_the_effects() {
        let dir = tmp();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"terminal":{"closeOnExit":true,"fontSize":15}}"#,
        )
        .unwrap();
        let st = AppState::load(dir.path().to_path_buf(), "/w".into()).unwrap();
        assert_eq!(st.settings.get().terminal.font_size, 15);
        assert!(
            Effects::close_on_exit(&st.effects),
            "settings 的 closeOnExit 传到了 store 的副作用面"
        );
    }

    #[test]
    fn a_corrupt_state_json_degrades_to_a_default_workspace_instead_of_failing() {
        let dir = tmp();
        std::fs::write(dir.path().join("state.json"), "{ not json").unwrap();
        let st = AppState::load(dir.path().to_path_buf(), "/w/proj".into()).unwrap();
        assert_eq!(st.workspaces().len(), 1);
    }

    #[gpui::test]
    fn spawning_a_preset_creates_a_real_pty_session_a_thread_and_activates_it(
        cx: &mut TestAppContext,
    ) {
        let dir = tmp();
        let cwd = dir.path().to_string_lossy().into_owned();
        cx.update(|cx| {
            let state = init(cx, dir.path().to_path_buf(), cwd.clone()).unwrap();
            let id = state.update(cx, |s, cx| {
                let ws = s.workspaces()[0].id.clone();
                s.spawn_from_preset("shell", Some(&ws), cx)
                    .expect("应能启动 shell")
            });
            state.read(cx);
            let s = state.read(cx);
            assert!(id.starts_with('t'), "{id}");
            assert_eq!(s.threads.active(), &ActiveTarget::Thread(id.clone()));
            assert_eq!(s.threads.last_used_preset.as_deref(), Some("shell"));
            let t = s.threads.thread(&id).unwrap().as_terminal().unwrap();
            assert_eq!(
                std::fs::canonicalize(&t.cwd).unwrap(),
                std::fs::canonicalize(dir.path()).unwrap(),
                "cwd 继承工作区目录"
            );
            assert!(
                cx.global::<TerminalPool>().get(t.session_id).is_some(),
                "PTY 在池里"
            );
            // state.json 在 flush 时写出
            assert!(dir.path().join("state.json").exists());
            state.update(cx, |s, cx| s.close_thread(&id, cx));
        });
    }

    #[gpui::test]
    fn an_unknown_preset_is_a_store_error_and_leaves_no_session(cx: &mut TestAppContext) {
        let dir = tmp();
        cx.update(|cx| {
            let state = init(cx, dir.path().to_path_buf(), "/w".into()).unwrap();
            let err = state
                .update(cx, |s, cx| s.spawn_from_preset("nope", None, cx))
                .unwrap_err();
            assert!(matches!(
                err,
                SpawnError::Store(StoreError::UnknownPreset(_))
            ));
            assert!(cx.global::<TerminalPool>().is_empty());
            assert!(state.read(cx).threads.threads.is_empty());
        });
    }

    #[gpui::test]
    fn closing_a_session_destroys_its_pty_via_the_flushed_effects(cx: &mut TestAppContext) {
        let dir = tmp();
        cx.update(|cx| {
            let state = init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let id = state.update(cx, |s, cx| s.spawn_from_preset("shell", None, cx).unwrap());
            assert_eq!(cx.global::<TerminalPool>().len(), 1);
            state.update(cx, |s, cx| {
                s.threads.close(&id);
                s.flush(cx); // 兑现 core 记下的 destroy
            });
            assert!(state.read(cx).threads.threads.is_empty());
            assert!(cx.global::<TerminalPool>().is_empty(), "PTY 随会话一起销毁");
        });
    }

    #[gpui::test]
    fn adding_and_closing_a_session_shell_creates_and_destroys_its_own_pty(
        cx: &mut TestAppContext,
    ) {
        let dir = tmp();
        cx.update(|cx| {
            let state = init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let id = state.update(cx, |s, cx| s.spawn_from_preset("shell", None, cx).unwrap());
            state.update(cx, |s, cx| s.add_session_shell(&id, cx).unwrap());
            let (view_id, sid) =
                match &state.read(cx).threads.thread(&id).unwrap().common().views[0] {
                    jagent_core::threads::SessionView::Shell(v) => (v.id.clone(), v.session_id),
                    _ => unreachable!(),
                };
            assert_eq!(view_id, "shell:1");
            assert!(
                cx.global::<TerminalPool>().get(sid).is_some(),
                "视图 PTY 在池里"
            );
            state.update(cx, |s, cx| s.close_view(&id, &view_id, cx));
            assert!(
                cx.global::<TerminalPool>().get(sid).is_none(),
                "关闭视图销毁它自己的 PTY"
            );
            assert!(
                state
                    .read(cx)
                    .threads
                    .thread(&id)
                    .unwrap()
                    .common()
                    .views
                    .is_empty()
            );
            assert!(
                state.read(cx).threads.thread(&id).is_some(),
                "关视图不关会话"
            );
            // 收尾显式关会话：spawn_from_preset 的 PTY 走受控销毁（shutdown
            // 后 join），reader 线程活动不得越过本测试边界（gpui test
            // scheduler 的确定性检查会把残留活动判给下一个测试）。
            state.update(cx, |s, cx| s.close_thread(&id, cx));
            assert!(cx.global::<TerminalPool>().is_empty(), "池已清空");
        });
    }

    #[gpui::test]
    fn chat_send_appends_the_user_message_then_the_echo_reply_after_the_delay(
        cx: &mut TestAppContext,
    ) {
        let dir = tmp();
        let state = cx.update(|cx| {
            init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let id = cx.update(|cx| {
            let ws = state.read(cx).workspaces()[0].id.clone();
            state.update(cx, |s, cx| s.create_chat(Some(&ws), cx).unwrap())
        });

        cx.update(|cx| send_chat(&state, &id, "你好", cx));
        cx.run_until_parked();
        let (n, pending) = cx.update(|cx| {
            let s = state.read(cx);
            let c = s.threads.conversation(&id).unwrap();
            (c.messages.len(), c.pending)
        });
        assert_eq!((n, pending), (1, true), "发送后只有 user 消息，且等待回复");

        // 等待中再发：被忽略，输入不丢（core 返回 None）
        cx.update(|cx| send_chat(&state, &id, "第二条", cx));
        assert_eq!(
            cx.update(|cx| state
                .read(cx)
                .threads
                .conversation(&id)
                .unwrap()
                .messages
                .len()),
            1
        );

        cx.executor().advance_clock(CHAT_REPLY_DELAY);
        cx.run_until_parked();
        cx.update(|cx| {
            let s = state.read(cx);
            let c = s.threads.conversation(&id).unwrap();
            assert!(!c.pending);
            assert_eq!(c.messages.len(), 2);
            assert!(c.messages[1].text.starts_with("（echo stub）收到：你好"));
        });
    }

    #[gpui::test]
    fn chat_send_ignores_blank_text(cx: &mut TestAppContext) {
        let dir = tmp();
        let state = cx.update(|cx| {
            init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let id = cx.update(|cx| {
            let ws = state.read(cx).workspaces()[0].id.clone();
            state.update(cx, |s, cx| s.create_chat(Some(&ws), cx).unwrap())
        });
        cx.update(|cx| send_chat(&state, &id, "   ", cx));
        cx.run_until_parked();
        let c = cx.update(|cx| {
            let s = state.read(cx);
            let c = s.threads.conversation(&id).unwrap();
            (c.messages.len(), c.pending)
        });
        assert_eq!(c, (0, false), "空白不落消息、不置等待");
    }

    #[cfg(unix)]
    #[gpui::test]
    fn an_acp_send_streams_the_agent_reply_into_the_thread_and_close_disposes_the_process(
        cx: &mut TestAppContext,
    ) {
        use crate::acp_io::tests::fake_agent_script;
        use jagent_core::settings::AcpAgentInput;
        let dir = tmp();
        let script = fake_agent_script(dir.path());
        let state = cx.update(|cx| {
            init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let (agent, ws) = state.update(cx, |s, _| {
            let agent = s.settings.add_acp_agent(AcpAgentInput {
                label: "fake".into(),
                command: Some(script.to_string_lossy().into_owned()),
                args: Some(vec![]),
            });
            (agent, s.workspaces()[0].id.clone())
        });
        let id = cx.update(|cx| {
            state.update(cx, |s, cx| {
                s.create_acp(&agent, "fake", Some(&ws), cx).unwrap()
            })
        });

        cx.update(|cx| send_acp(&state, &id, "hi", cx));
        cx.run_until_parked();
        cx.update(|cx| {
            let s = state.read(cx);
            let c = s.threads.conversation(&id).unwrap();
            assert!(!c.pending, "回复到达后解除等待");
            assert_eq!(c.messages.len(), 2);
            assert_eq!(c.messages[1].text, "hello from fake");
            assert!(s.acp.contains_key(&id), "连接保留在表里，下一轮复用");
        });

        // close → state 层终止 disposer，再释放连接表项。
        cx.update(|cx| state.update(cx, |s, cx| s.close_thread(&id, cx)));
        assert!(
            cx.update(|cx| state.read(cx).acp.is_empty()),
            "close 后连接被释放"
        );
        assert!(
            cx.update(|cx| state.read(cx).acp_disposers.is_empty()),
            "close 后 disposer 被释放"
        );
        assert!(cx.update(|cx| !state.read(cx).acp_disposers.contains_key(&id)));
    }

    #[cfg(unix)]
    #[gpui::test]
    fn acp_send_populates_structured_tool_calls_and_switching_agent_resets_connection(
        cx: &mut TestAppContext,
    ) {
        use crate::acp_io::tests::fake_agent_script_with_tools;
        use jagent_core::settings::AcpAgentInput;
        let dir = tmp();
        let script = fake_agent_script_with_tools(dir.path());
        let state = cx.update(|cx| {
            init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let (agent1, agent2, ws) = state.update(cx, |s, _| {
            let a1 = s.settings.add_acp_agent(AcpAgentInput {
                label: "FakeWithTools".into(),
                command: Some(script.to_string_lossy().into_owned()),
                args: Some(vec![]),
            });
            let a2 = s.settings.add_acp_agent(AcpAgentInput {
                label: "SecondAgent".into(),
                command: Some(script.to_string_lossy().into_owned()),
                args: Some(vec![]),
            });
            (a1, a2, s.workspaces()[0].id.clone())
        });
        let id = cx.update(|cx| {
            state.update(cx, |s, cx| {
                s.create_acp(&agent1, "FakeWithTools", Some(&ws), cx)
                    .unwrap()
            })
        });
        assert!(
            !cx.update(|cx| state.read(cx).is_acp_connected(&id)),
            "新建 ACP 会话尚未发送消息时处于未连接状态"
        );

        cx.update(|cx| send_acp(&state, &id, "inspect", cx));
        cx.run_until_parked();
        cx.update(|cx| {
            let s = state.read(cx);
            assert!(s.is_acp_connected(&id), "发送成功后标记为已连接");
            assert_eq!(
                s.threads.acp_current_model_label(&id).as_deref(),
                Some("GPT-6 Astra"),
                "握手后自动提取当前模型名称"
            );
            let c = s.threads.conversation(&id).unwrap();
            assert_eq!(
                c.messages.len(),
                3,
                "从上往下顺序：0=启动信息，1=用户提问，2=助手工具与回复"
            );
            assert!(
                c.messages[0].text.starts_with("pi v1.3.0"),
                "首条消息为 session/new 启动欢迎信息"
            );
            assert_eq!(c.messages[1].text, "inspect");
            assert_eq!(
                c.messages[2].text, "checked src/lib.rs",
                "助手回复正文不应混入重复的 startupInfo"
            );
            assert_eq!(c.messages[2].tool_calls.len(), 1);
            let tc = &c.messages[2].tool_calls[0];
            assert_eq!(tc.kind.as_deref(), Some("read"));
            assert_eq!(tc.path.as_deref(), Some("src/lib.rs"));
            assert_eq!(tc.status.as_deref(), Some("completed"));
        });

        // 切换模型 → 乐观更新并通过 session/set_config_option 同步给 Agent
        cx.update(|cx| {
            set_acp_config_option(&state, &id, "model", "cpaapi/claude-sonnet-5-5-high", cx);
        });
        cx.run_until_parked();
        cx.update(|cx| {
            let s = state.read(cx);
            assert_eq!(
                s.threads.acp_current_model_label(&id).as_deref(),
                Some("Claude Sonnet 5.5 High")
            );
        });

        // 切换 ACP Agent → 清理旧连接与旧模型列表，连接状态归零
        cx.update(|cx| {
            state.update(cx, |s, cx| {
                s.switch_acp_agent(&id, &agent2, "SecondAgent", cx);
            });
        });
        cx.update(|cx| {
            let s = state.read(cx);
            assert!(!s.is_acp_connected(&id), "切换 Agent 后断开旧连接");
            assert!(
                s.threads.acp_config_selectors(&id).is_empty(),
                "切换 Agent 后清空旧模型列表"
            );
            assert!(s.acp.is_empty());
        });

        // 新建会话并调用 ensure_acp_connected 预握手 → 无需发消息即可立即输出启动信息并拉回模型列表
        let id2 = cx.update(|cx| {
            state.update(cx, |s, cx| {
                s.create_acp(&agent2, "SecondAgent", Some(&ws), cx).unwrap()
            })
        });
        cx.update(|cx| ensure_acp_connected(&state, &id2, cx));
        cx.run_until_parked();
        cx.update(|cx| {
            let s = state.read(cx);
            assert!(s.is_acp_connected(&id2), "预握手完成后标记为已连接");
            assert_eq!(
                s.threads.acp_current_model_label(&id2).as_deref(),
                Some("GPT-6 Astra")
            );
            let c2 = s.threads.conversation(&id2).unwrap();
            assert_eq!(
                c2.messages.len(),
                1,
                "打开 ACP 会话预握手完成后立即输出启动信息，无需等待用户发消息"
            );
            assert!(c2.messages[0].text.starts_with("pi v1.3.0"));
        });

        // 测试 /resume 链路：先拉取 session/list，再执行 resume_acp_session (session/load) 恢复历史消息
        cx.update(|cx| fetch_acp_session_list(&state, &id2, cx));
        cx.run_until_parked();
        cx.update(|cx| {
            let s = state.read(cx);
            let list = s.acp_session_list(&id2);
            assert_eq!(list.len(), 1);
            assert_eq!(list[0].session_id, "s-prev-42");
            assert_eq!(list[0].title.as_deref(), Some("上次重构会话"));
        });

        cx.update(|cx| {
            resume_acp_session(&state, &id2, "s-prev-42", Some("上次重构会话".into()), cx);
        });
        cx.run_until_parked();
        cx.update(|cx| {
            let s = state.read(cx);
            assert_eq!(s.threads.acp_session_id(&id2), Some("s-prev-42"));
            assert_eq!(
                s.threads.thread(&id2).unwrap().title(),
                "上次重构会话",
                "恢复会话后标题同步更新"
            );
            assert_eq!(
                s.threads.acp_current_model_label(&id2).as_deref(),
                Some("Claude Sonnet 5.5 High"),
                "恢复会话后模型同步为该历史会话当时的模型"
            );
            let c2 = s.threads.conversation(&id2).unwrap();
            assert_eq!(c2.messages.len(), 2);
            assert!(c2.messages[0].is_user());
            assert_eq!(c2.messages[0].text, "上次的问题");
            assert_eq!(c2.messages[1].text, "上次的回答");
            assert_eq!(c2.messages[1].tool_calls.len(), 1);
            assert_eq!(
                c2.messages[1].tool_calls[0].path.as_deref(),
                Some("README.md")
            );
        });

        cx.update(|cx| {
            state.update(cx, |s, cx| {
                s.close_thread(&id, cx);
                s.close_thread(&id2, cx);
            })
        });
    }

    #[gpui::test]
    fn terminal_events_reach_the_store_through_on_terminal_event(cx: &mut TestAppContext) {
        let dir = tmp();
        cx.update(|cx| {
            let state = init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let (a, b) = state.update(cx, |s, cx| {
                let a = s.spawn_from_preset("shell", None, cx).unwrap();
                let b = s.spawn_from_preset("shell", None, cx).unwrap();
                (a, b)
            });
            // b 激活，a 在后台
            let a_sid = state
                .read(cx)
                .threads
                .thread(&a)
                .unwrap()
                .as_terminal()
                .unwrap()
                .session_id;
            state.update(cx, |s, cx| {
                s.on_terminal_event(
                    &TermEvent::Title {
                        id: a_sid,
                        title: "vim".into(),
                    },
                    cx,
                );
                s.on_terminal_event(&TermEvent::Bell { id: a_sid }, cx);
            });
            let s = state.read(cx);
            let ta = s.threads.thread(&a).unwrap().as_terminal().unwrap();
            assert_eq!(ta.osc_title.as_deref(), Some("vim"));
            assert!(ta.has_bell, "后台会话 BEL → 红点");
            assert_eq!(s.threads.unread_notice_count(), 1);
            assert_eq!(s.threads.active(), &ActiveTarget::Thread(b.clone()));
            state.update(cx, |s, cx| {
                s.close_thread(&a, cx);
                s.close_thread(&b, cx);
            });
        });
    }

    /// V3：菜单动作执行链——成功动作（建分支）后图自动重新挂载刷新；
    /// 失败动作（坏参数）把 stderr 写进 `action_error`，不刷新。
    #[gpui::test]
    fn run_git_action_refreshes_on_success_and_records_the_error_on_failure(
        cx: &mut TestAppContext,
    ) {
        let dir = tmp();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git_repo_with_commits(&repo, 1);
        let cwd = repo.to_string_lossy().into_owned();
        let state = cx.update(|cx| init(cx, dir.path().to_path_buf(), cwd.clone()).unwrap());
        cx.update(|cx| AppState::mount_git_graph(&state, cwd, cx));
        cx.run_until_parked();
        cx.update(|cx| {
            assert_eq!(state.read(cx).git_graph.status, GitGraphStatus::Ready);
        });

        // 成功动作：建一个分支 → 完成后 store 重新挂载（Loading），再回 Ready
        cx.update(|cx| AppState::run_git_action(&state, vec!["branch".into(), "side".into()], cx));
        cx.run_until_parked();
        let (status, branches) = cx.update(|cx| {
            let s = state.read(cx);
            (
                s.git_graph.status,
                s.git_graph
                    .branches
                    .iter()
                    .map(|b| b.name.clone())
                    .collect::<Vec<_>>(),
            )
        });
        assert_eq!(status, GitGraphStatus::Ready, "成功后重新挂载完成");
        assert!(branches.contains(&"side".to_owned()), "{branches:?}");

        // 失败动作：git 不认的参数 → action_error 带 stderr，状态不动
        cx.update(|cx| {
            AppState::run_git_action(&state, vec!["checkout".into(), "no-such-ref".into()], cx)
        });
        cx.run_until_parked();
        cx.update(|cx| {
            let s = state.read(cx);
            assert_eq!(s.git_graph.status, GitGraphStatus::Ready, "失败不重挂载");
            assert!(
                s.git_graph
                    .action_error
                    .as_deref()
                    .is_some_and(|e| e.contains("no-such-ref")),
                "stderr 摘要进错误条：{:?}",
                s.git_graph.action_error
            );
        });
    }

    /// V3：工具条「显示远程分支」开关写进 store 并广播 StateChanged。
    #[gpui::test]
    fn set_git_show_remote_flips_the_store_flag(cx: &mut TestAppContext) {
        let dir = tmp();
        let state = cx.update(|cx| {
            init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        cx.update(|cx| {
            assert!(state.read(cx).git_graph.show_remote, "默认开");
            AppState::set_git_show_remote(&state, false, cx);
            assert!(!state.read(cx).git_graph.show_remote);
            AppState::set_git_show_remote(&state, true, cx);
            assert!(state.read(cx).git_graph.show_remote);
        });
    }

    #[gpui::test]
    fn mounting_a_git_repo_streams_its_commits_into_the_graph(cx: &mut TestAppContext) {
        let dir = tmp();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(&repo)
                    .status()
                    .unwrap()
                    .success(),
                "git {args:?}"
            );
        };
        git(&["init", "-q"]);
        git(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "first",
        ]);

        let cwd = repo.to_string_lossy().into_owned();
        let state = cx.update(|cx| init(cx, dir.path().to_path_buf(), cwd.clone()).unwrap());
        cx.update(|cx| AppState::mount_git_graph(&state, cwd, cx));
        cx.run_until_parked();

        let (status, rows, root) = cx.update(|cx| {
            let s = state.read(cx);
            (
                s.git_graph.status,
                s.git_graph.rows().len(),
                s.git_graph.repo_root().map(str::to_owned),
            )
        });
        assert_eq!(status, GitGraphStatus::Ready);
        assert_eq!(rows, 1, "一个提交 → 一行");
        assert!(root.is_some(), "应解析出 repo root");
    }

    /// 在 `dir` 下建一个 git 仓库，并提交 `n` 个空提交。
    fn git_repo_with_commits(dir: &std::path::Path, n: usize) {
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(dir)
                    .status()
                    .unwrap()
                    .success(),
                "git {args:?}"
            );
        };
        git(&["init", "-q"]);
        for i in 0..n {
            git(&[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                &format!("c{i}"),
            ]);
        }
    }

    #[gpui::test]
    fn selecting_a_commit_loads_its_body_and_changed_files_for_the_expandable_detail_row(
        cx: &mut TestAppContext,
    ) {
        let dir = tmp();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(&repo)
                    .status()
                    .unwrap()
                    .success(),
                "git {args:?}"
            );
        };
        git(&["init", "-q"]);
        std::fs::write(repo.join("tracked.txt"), "one\\n").unwrap();
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "-m",
            "feat: detail",
            "-m",
            "body line",
        ]);

        let cwd = repo.to_string_lossy().into_owned();
        let state = cx.update(|cx| init(cx, dir.path().to_path_buf(), cwd.clone()).unwrap());
        cx.update(|cx| AppState::mount_git_graph(&state, cwd, cx));
        cx.run_until_parked();
        let sha = cx.update(|cx| state.read(cx).git_graph.rows()[0].commit.sha.clone());
        cx.update(|cx| AppState::select_git_commit(&state, Some(sha.clone()), cx));
        cx.run_until_parked();
        cx.update(|cx| {
            let s = state.read(cx);
            assert_eq!(s.git_graph.selected_sha.as_deref(), Some(sha.as_str()));
            assert_eq!(s.git_graph.body.as_deref(), Some("body line"));
            assert_eq!(
                s.git_graph
                    .files
                    .iter()
                    .map(|f| f.path.as_str())
                    .collect::<Vec<_>>(),
                ["tracked.txt"]
            );
            assert!(
                s.git_patch
                    .as_deref()
                    .is_some_and(|patch| patch.contains("tracked.txt"))
            );
            assert!(!s.git_graph.detail_loading);
        });
    }

    #[gpui::test]
    fn mounting_a_directory_that_is_not_a_repo_reports_not_a_repo(cx: &mut TestAppContext) {
        let dir = tmp();
        let cwd = dir.path().to_string_lossy().into_owned();
        let state = cx.update(|cx| init(cx, dir.path().to_path_buf(), cwd.clone()).unwrap());
        cx.update(|cx| AppState::mount_git_graph(&state, cwd, cx));
        cx.run_until_parked();

        let (status, rows, root) = cx.update(|cx| {
            let s = state.read(cx);
            (
                s.git_graph.status,
                s.git_graph.rows().len(),
                s.git_graph.repo_root().map(str::to_owned),
            )
        });
        assert_eq!(status, GitGraphStatus::NotARepo);
        assert_eq!(rows, 0);
        assert!(root.is_none());
    }

    #[gpui::test]
    fn remounting_cancels_the_previous_stream_token(cx: &mut TestAppContext) {
        let dir = tmp();
        let repo_a = dir.path().join("a");
        let repo_b = dir.path().join("b");
        std::fs::create_dir(&repo_a).unwrap();
        std::fs::create_dir(&repo_b).unwrap();
        git_repo_with_commits(&repo_a, 1);
        git_repo_with_commits(&repo_b, 1);
        let state = cx.update(|cx| {
            init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });

        cx.update(|cx| {
            AppState::mount_git_graph(&state, repo_a.to_string_lossy().into_owned(), cx)
        });
        cx.run_until_parked();
        let old = cx.update(|cx| state.read(cx).git_cancel.clone());
        assert!(!old.is_cancelled(), "挂载后流未被取消");

        cx.update(|cx| {
            AppState::mount_git_graph(&state, repo_b.to_string_lossy().into_owned(), cx)
        });
        assert!(old.is_cancelled(), "切换仓库时旧令牌必须被取消");
        cx.run_until_parked();

        let rows = cx.update(|cx| state.read(cx).git_graph.rows().len());
        assert_eq!(rows, 1, "新仓库的提交正常加载");
    }

    #[gpui::test]
    fn switching_to_a_non_repo_directory_drops_the_previous_graph(cx: &mut TestAppContext) {
        let dir = tmp();
        let repo = dir.path().join("repo");
        let plain = dir.path().join("plain");
        std::fs::create_dir(&repo).unwrap();
        std::fs::create_dir(&plain).unwrap();
        git_repo_with_commits(&repo, 2);
        let state = cx.update(|cx| {
            init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });

        cx.update(|cx| AppState::mount_git_graph(&state, repo.to_string_lossy().into_owned(), cx));
        cx.run_until_parked();
        assert_eq!(
            cx.update(|cx| state.read(cx).git_graph.rows().len()),
            2,
            "先挂载仓库，应有 2 行"
        );

        cx.update(|cx| AppState::mount_git_graph(&state, plain.to_string_lossy().into_owned(), cx));
        cx.run_until_parked();

        let (status, rows, root) = cx.update(|cx| {
            let s = state.read(cx);
            (
                s.git_graph.status,
                s.git_graph.rows().len(),
                s.git_graph.repo_root().map(str::to_owned),
            )
        });
        assert_eq!(status, GitGraphStatus::NotARepo);
        assert_eq!(rows, 0, "切换后旧仓库的提交必须被丢弃");
        assert!(root.is_none(), "旧 repo root 必须被清除");
    }

    #[gpui::test]
    fn desktop_notifications_honor_desktop_and_sound_settings(cx: &mut TestAppContext) {
        let dir = tmp();
        let state = cx.update(|cx| {
            init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });

        cx.update(|cx| {
            let tid = state.update(cx, |s, cx| {
                let ws = s.workspaces()[0].id.clone();
                let tid = s.spawn_from_preset("shell", Some(&ws), cx).unwrap();
                let _c2 = s.create_chat(Some(&ws), cx).unwrap(); // 切走焦点，使终端处于后台
                let sid = s
                    .threads
                    .thread(&tid)
                    .unwrap()
                    .as_terminal()
                    .unwrap()
                    .session_id;
                s.settings
                    .patch("notifications.desktop", serde_json::json!(true));
                s.settings
                    .patch("notifications.sound", serde_json::json!(true));
                s.on_terminal_event(&TermEvent::Bell { id: sid }, cx);
                assert_eq!(s.dispatched_notifications.len(), 1);
                assert_eq!(s.dispatched_notifications[0].thread_id, tid);
                assert!(s.dispatched_notifications[0].sound);

                // 关闭桌面通知开关后不再派发
                s.settings
                    .patch("notifications.desktop", serde_json::json!(false));
                s.on_terminal_event(&TermEvent::Bell { id: sid }, cx);
                assert_eq!(
                    s.dispatched_notifications.len(),
                    1,
                    "notifications.desktop=false 时不派发桌面通知"
                );
                tid
            });
            state.update(cx, |s, cx| s.close_thread(&tid, cx));
        });
    }
}
