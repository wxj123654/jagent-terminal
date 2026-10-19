//! 根视图：标题栏 + 侧栏 + 主面 + 工作面板右栏（对应旧 `plane/AgentPlane.tsx`）。
//!
//! V2：顶栏分支钮（异步 `git rev-parse` 经 `list_worktree_status`，cwd 变化重查）+
//! Git 菜单浮层；`panelRight` 钮开关工作面板——视口 ≥1100 是可拖宽右栏（244–720），
//! <1100 转为右缘 absolute 浮层（`#work-panel.overlay`）。

use std::rc::Rc;

use gpui::AnimationExt as _;
use gpui::{
    AnyElement, App, AppContext as _, BoxShadow, Context, Entity, InteractiveElement as _,
    IntoElement, MouseButton, MouseDownEvent, ParentElement, Render, SharedString,
    StatefulInteractiveElement as _, Styled, Window, div, hsla, prelude::FluentBuilder as _, px,
};
use gpui_base::{Popover, ResizeHandleContext, ResizeHandleRenderer, ResizeHandleState};
use gpui_component::notification::Notification;
use gpui_component::resizable::{ResizableState, h_resizable, resizable_panel};
use gpui_component::{ActiveTheme, WindowExt as _, h_flex, v_flex};
use jagent_core::threads::{ActiveTarget, MAIN_VIEW_ID, SessionView, Thread};
use jagent_terminal::TerminalView;

use crate::actions::*;
use crate::icons::{IconName, icon};
use crate::state::{AppState, StateChanged};
use crate::theme::{accent_alpha, colors, hex, sizes};
use crate::views::conversation::ConversationView;
use crate::views::empty_presets;
use crate::views::notif_center::{NotifSlot, notif_models};
use crate::views::popup::{MenuEntry, PopupTrigger, action_row, menu_popover, overlay_shell};
use crate::views::selectable::sel_text_id;
use crate::views::session_tabs::{ContextTab, SessionTabs, tab_models};
use crate::views::sidebar::{
    GroupAction, MenuTarget, RowAction, Sidebar, SidebarMode, build_groups,
};
use crate::views::terminal_pane::view_for_session;
use crate::views::work_panel::WorkPanel;
use crate::views::{
    git_graph, nested_scroll, new_session, rename, search_threads, settings, workspace_dialog,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FileSurfaceMode {
    #[default]
    Source,
    Diff,
    Split,
}

/// 性能 HUD 与帧覆盖层采样器（对接 `jagent_terminal::take_paint_perf` 与渲染帧间隔）。
#[derive(Debug, Clone)]
pub struct PerfTracker {
    last_frame: std::time::Instant,
    prev_paint_count: u64,
    prev_paint_ns: u64,
    pub frame_ms: f32,
    pub p90_ms: f32,
    pub max_ms: f32,
    pub paint_us: u64,
    pub paint_max_us: u64,
    pub history_ms: std::collections::VecDeque<f32>,
}

impl Default for PerfTracker {
    fn default() -> Self {
        let mut history_ms = std::collections::VecDeque::with_capacity(24);
        for _ in 0..24 {
            history_ms.push_back(1.2);
        }
        Self {
            last_frame: std::time::Instant::now(),
            prev_paint_count: 0,
            prev_paint_ns: 0,
            frame_ms: 1.2,
            p90_ms: 1.5,
            max_ms: 2.0,
            paint_us: 0,
            paint_max_us: 0,
            history_ms,
        }
    }
}

impl PerfTracker {
    pub fn sample(&mut self) {
        let now = std::time::Instant::now();
        let elapsed_ms = now.duration_since(self.last_frame).as_secs_f32() * 1000.0;
        self.last_frame = now;
        let sample_ms = if elapsed_ms > 200.0 {
            0.8
        } else {
            elapsed_ms.clamp(0.3, 50.0)
        };
        self.frame_ms = sample_ms;
        if self.history_ms.len() >= 24 {
            self.history_ms.pop_front();
        }
        self.history_ms.push_back(sample_ms);

        let mut sorted: Vec<f32> = self.history_ms.iter().copied().collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        if !sorted.is_empty() {
            let p90_ix = ((sorted.len() as f32 * 0.9) as usize).min(sorted.len() - 1);
            self.p90_ms = sorted[p90_ix];
            self.max_ms = *sorted.last().unwrap_or(&sample_ms);
        }

        let snap = jagent_terminal::take_paint_perf();
        let delta_count = snap.count.saturating_sub(self.prev_paint_count);
        let delta_ns = snap.ns_total.saturating_sub(self.prev_paint_ns);
        self.prev_paint_count = snap.count;
        self.prev_paint_ns = snap.ns_total;
        if delta_count > 0 {
            self.paint_us = (delta_ns / delta_count) / 1_000;
        }
        if snap.ns_max > 0 {
            self.paint_max_us = snap.ns_max / 1_000;
        }
    }
}

pub struct RootView {
    pub(crate) state: Entity<AppState>,
    focus_handle: gpui::FocusHandle,
    /// 当前主面的终端视图，键为 (thread id, 视图 id)；键变了才重建（PTY 在池里持续运行）
    terminal: Option<((String, String), Entity<TerminalView>)>,
    /// 当前主面终端的 OpenLink 事件订阅（随 terminal 切换同步更新）
    _terminal_link_sub: Option<gpui::Subscription>,
    /// 当前主面的对话视图（chat），键为 thread id
    conversation: Option<(String, Entity<ConversationView>)>,
    settings_open: bool,
    settings_view: Option<Entity<settings::SettingsView>>,
    /// 主画布内嵌 Git 图谱视图（键为 git_cwd）
    git_view: Option<(String, Entity<git_graph::GitGraphDialog>)>,
    sidebar_width: f32,
    /// 主分隔条（侧栏 | 主面）的运行时态；拖动结束时宽度写回 settings
    split: Entity<ResizableState>,
    /// 宽屏：侧栏面板是否可见（`ToggleSidebar` 切换）；窄屏：抽屉是否打开
    sidebar_open: bool,
    /// 左侧栏双模式（Devin 风格：`Agent` 会话导航 vs `Edit` 项目文件树）
    pub(crate) sidebar_mode: SidebarMode,
    /// 左侧栏 `Edit` 模式下的内嵌文件树与变更面板
    pub(crate) sidebar_edit_panel: Option<Entity<WorkPanel>>,
    /// 上一帧是否为窄屏；从宽切窄时自动收起抽屉
    was_narrow: bool,
    /// 工作面板开关（原型 `ui.panelOpen`，默认关；不落盘——会话期 UI 态）
    panel_open: bool,
    /// 工作面板右栏宽度（拖拽内存态，244–720；原型 `ui.panelWidth` 默认 280）
    panel_width: f32,
    /// workbench 分隔条（主面 | 工作面板）的运行时态
    work_split: Entity<ResizableState>,
    /// 工作面板本体（首开时建；关开之间保留，tab/选中态不丢）
    pub(crate) panel: Option<Entity<WorkPanel>>,
    /// 顶栏分支钮数据：当前工作区目录的 Git 分支（非 repo → `None`，不渲染钮）
    branch: Option<String>,
    /// 同一次 worktree 查询的变更文件（AddPopover「打开文件」区；非 repo → 空）
    pub(crate) worktree_files: Vec<jagent_core::git::WorktreeFile>,
    /// 上次分支查询的 cwd；变化时重查（render 期检查，字符串比较开销可忽略）
    branch_cwd: String,
    /// 分支查询的代际；过期响应不得回写
    branch_generation: u64,
    /// 侧栏「…」菜单的受控开合态（V5 统一浮层：行 / 工作区同一浮层实例，
    /// 左键 / 右键 / 点外 / Esc / 选中项都汇聚到这一份状态）
    open_menu: Option<MenuTarget>,
    /// 顶栏 SessionTabs「+」的 AddPopover 受控开合态（原型 session-add-pop）
    add_popover_open: bool,
    /// 顶栏 SessionTabs「+N ▾」溢出管理浮层受控开合态
    overflow_popover_open: bool,
    /// 主画布宽幅文件预览模式（Unified Diff / 并排对比 / 完整源码）
    pub(crate) file_surface_mode: FileSurfaceMode,
    /// 主画布宽幅文件预览与编辑器状态机（Editor + Diff）
    pub(crate) file_surface: crate::views::file_surface::FileSurfaceController,
    /// 启动台外层画布与内层会话列表的持久化滚动句柄（支持内层边缘穿透）
    bento_outer_scroll: gpui::ScrollHandle,
    bento_sessions_scroll: gpui::ScrollHandle,
    /// 主画布 FileSurface 的持久化滚动句柄及上次 (path, mode) 键（切换时回顶）
    pub(crate) file_surface_scroll: gpui::ScrollHandle,
    file_surface_last_key: (String, FileSurfaceMode),
    /// 终端点击 `path:line` 跳转至 FileSurface 时定位并高亮的目标行 `(path, 1-based line)`
    file_surface_target_line: Option<(String, u32)>,
    /// 待在 FileSurface 完成首帧布局后应用的纵向滚动偏移（正值表示向下滚 N px）
    pub(crate) pending_file_scroll_y: Rc<std::cell::Cell<Option<gpui::Pixels>>>,
    /// 性能指标 HUD 与帧耗时覆盖层状态
    pub(crate) perf_tracker: PerfTracker,
}

impl RootView {
    pub fn new(state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        cx.subscribe(&state, |_, _, _: &StateChanged, cx| cx.notify())
            .detach();
        let sidebar_width = state.read(cx).settings.get().appearance.sidebar_width as f32;
        let split = cx.new(|_| ResizableState::default());
        let mut view = Self {
            state,
            focus_handle: cx.focus_handle(),
            terminal: None,
            _terminal_link_sub: None,
            conversation: None,
            settings_open: false,
            settings_view: None,
            git_view: None,
            sidebar_width,
            split,
            sidebar_open: true,
            sidebar_mode: SidebarMode::Agent,
            sidebar_edit_panel: None,
            was_narrow: false,
            panel_open: false,
            panel_width: sizes::PANEL_WIDTH,
            work_split: cx.new(|_| ResizableState::default()),
            panel: None,
            branch: None,
            worktree_files: Vec::new(),
            branch_cwd: String::new(),
            branch_generation: 0,
            open_menu: None,
            add_popover_open: false,
            overflow_popover_open: false,
            file_surface_mode: FileSurfaceMode::Source,
            file_surface: crate::views::file_surface::FileSurfaceController::default(),
            bento_outer_scroll: gpui::ScrollHandle::new(),
            bento_sessions_scroll: gpui::ScrollHandle::new(),
            file_surface_scroll: gpui::ScrollHandle::new(),
            file_surface_last_key: (String::new(), FileSurfaceMode::Source),
            file_surface_target_line: None,
            pending_file_scroll_y: Rc::new(std::cell::Cell::new(None)),
            perf_tracker: PerfTracker::default(),
        };
        // 顶栏分支钮的首次异步查询（cwd 变化时 render 里会重查）
        view.refresh_branch(cx);
        view
    }

    /// 异步解析当前工作区目录的 Git 分支（`list_worktree_status` 顺带返回；
    /// 非 repo → `None` → 分支钮不渲染）。代际防串：cwd 切换后旧响应丢弃。
    pub(crate) fn refresh_branch(&mut self, cx: &mut Context<Self>) {
        self.branch_generation = self.branch_generation.wrapping_add(1);
        let generation = self.branch_generation;
        let cwd = self.state.read(cx).git_cwd();
        self.branch_cwd = cwd.clone();
        self.branch = None;
        self.worktree_files = Vec::new();
        let weak = cx.entity().downgrade();
        cx.spawn(async move |_, cx| {
            let result = cx
                .background_spawn(async move {
                    jagent_core::git::cli::list_worktree_status(std::path::Path::new(&cwd))
                })
                .await;
            let _ = weak.update(cx, |this, cx| {
                if this.branch_generation != generation {
                    return;
                }
                this.branch = result.as_ref().and_then(|s| s.branch.clone());
                this.worktree_files = result.map(|s| s.files).unwrap_or_default();
                cx.notify();
            });
        })
        .detach();
    }

    /// 打开工作面板（分支菜单「查看变更」也走这里）：首开建实体，复用不重建。
    fn ensure_panel(&mut self, cx: &mut Context<Self>) {
        if self.panel_open && self.panel.is_none() {
            let state = self.state.clone();
            let weak = cx.entity().downgrade();
            let weak_open = weak.clone();
            let on_close: crate::views::work_panel::CloseFn = Rc::new(move |_, cx| {
                let _ = weak.update(cx, |v, cx| {
                    v.panel_open = false;
                    cx.notify();
                });
            });
            self.panel = Some(cx.new(|cx| {
                WorkPanel::new(state, cx)
                    .with_on_close(on_close)
                    .with_on_open_file(move |_, cx| {
                        let _ = weak_open.update(cx, |v, cx| {
                            v.file_surface_mode = FileSurfaceMode::Source;
                            v.file_surface.commit_sha = None;
                            v.file_surface_target_line = None;
                            cx.notify();
                        });
                    })
            }));
        }
    }

    fn ensure_sidebar_edit_panel(&mut self, cx: &mut Context<Self>) {
        if self.sidebar_edit_panel.is_none() {
            let state = self.state.clone();
            let weak_open = cx.entity().downgrade();
            self.sidebar_edit_panel = Some(cx.new(|cx| {
                WorkPanel::new(state, cx)
                    .with_sidebar_embedded(true)
                    .with_on_open_file(move |_, cx| {
                        let _ = weak_open.update(cx, |v, cx| {
                            v.file_surface_mode = FileSurfaceMode::Source;
                            v.file_surface.commit_sha = None;
                            v.file_surface_target_line = None;
                            cx.notify();
                        });
                    })
            }));
        }
    }

    /// 分支菜单「查看变更」：开面板并切到变更页。
    fn open_panel_changes(&mut self, cx: &mut Context<Self>) {
        self.panel_open = true;
        self.ensure_panel(cx);
        if let Some(panel) = &self.panel {
            panel.update(cx, |p, cx| p.show_changes(cx));
        }
        cx.notify();
    }

    /// AddPopover「打开文件」：开面板、切文件页并选中 `path`（主画布默认打开标准编辑器）。
    fn open_panel_file(&mut self, path: &str, cx: &mut Context<Self>) {
        self.file_surface_mode = FileSurfaceMode::Source;
        self.file_surface.commit_sha = None;
        self.panel_open = true;
        self.ensure_panel(cx);
        if let Some(panel) = &self.panel {
            panel.update(cx, |p, cx| p.show_file(path, cx));
        }
        cx.notify();
    }

    /// 处理终端内 Cmd/Ctrl+Click 触发的链接或文件路径打开：
    /// - URL：调用 `cx.open_url` 打开系统浏览器；
    /// - 本地文件路径：在当前会话顶栏新增/激活 `file:<path>` 副视图并在主画布 `FileSurface` 打开预览；
    ///   若附带 `:line` 行号，自动切到 `FileSurfaceMode::Source`（完整源码），高亮并滚动定位到目标行。
    pub fn handle_terminal_open_link(
        &mut self,
        target: jagent_terminal::TerminalLinkTarget,
        cx: &mut Context<Self>,
    ) {
        match target {
            jagent_terminal::TerminalLinkTarget::Url(url) => {
                cx.open_url(&url);
            }
            jagent_terminal::TerminalLinkTarget::File { path, line, .. } => {
                let git_cwd = self.state.read(cx).git_cwd();
                let display_path = if !git_cwd.is_empty()
                    && let Ok(rel) = path.strip_prefix(std::path::Path::new(&git_cwd))
                {
                    rel.to_string_lossy().replace('\\', "/")
                } else {
                    path.to_string_lossy().replace('\\', "/")
                };
                if display_path.is_empty() {
                    return;
                }
                let tid = self
                    .state
                    .read(cx)
                    .threads
                    .active_thread_id()
                    .map(str::to_owned);
                let Some(tid) = tid else {
                    return;
                };
                self.file_surface_mode = FileSurfaceMode::Source;
                self.file_surface.commit_sha = None;
                if let Some(line_no) = line {
                    self.file_surface_target_line = Some((display_path.clone(), line_no));
                    let scroll_y = ((line_no.saturating_sub(6) as f32) * 19.0).max(0.0);
                    self.file_surface_last_key = (display_path.clone(), FileSurfaceMode::Source);
                    self.file_surface_scroll
                        .set_offset(gpui::point(px(0.0), px(-scroll_y)));
                    self.pending_file_scroll_y.set(Some(px(scroll_y)));
                } else {
                    self.file_surface_target_line = None;
                    self.pending_file_scroll_y.set(None);
                }
                self.state.update(cx, |s, cx| {
                    s.threads.open_session_file(&tid, &display_path);
                    s.flush(cx);
                    cx.emit(StateChanged);
                });
                cx.notify();
            }
        }
    }

    /// 当前 FileSurface 预览关联的目标行号（1-based）。
    pub fn file_surface_target_line(&self, path: &str) -> Option<u32> {
        self.file_surface_target_line
            .as_ref()
            .and_then(|(p, line)| (p == path).then_some(*line))
    }

    /// 仅供视觉测试（tests/v_shots.rs）：直接置 AddPopover 的受控开合态，
    /// 等价于点击顶栏 tab 条「+」钮（`add_popover_open` 字段对外不可见，
    /// 而钮的 x 坐标随 tab 文本宽度变化，鼠标点击不可复现）。
    pub fn set_add_popover_open(&mut self, open: bool, cx: &mut Context<Self>) {
        self.add_popover_open = open;
        cx.notify();
    }

    /// 行菜单动作：规则全在 store（`set_thread_pinned` / `set_thread_unread` / `close`），这里只落盘并通知。
    fn row_action(
        state: &Entity<AppState>,
        thread_id: &str,
        action: RowAction,
        window: &mut Window,
        cx: &mut App,
    ) {
        if action == RowAction::Rename {
            let title = state
                .read(cx)
                .threads
                .thread(thread_id)
                .map(|t| t.title())
                .unwrap_or_default();
            rename::open(state.clone(), thread_id.to_owned(), title, window, cx);
            return;
        }
        apply_row_action(state, thread_id, action, cx);
    }

    fn ensure_settings_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings_view.is_none() {
            let state = self.state.clone();
            let weak = cx.entity().downgrade();
            self.settings_view = Some(cx.new(|cx| {
                settings::SettingsView::new(state, window, cx).with_on_close(move |_, cx| {
                    let _ = weak.update(cx, |v, cx| {
                        v.settings_open = false;
                        cx.notify();
                    });
                })
            }));
        }
    }

    fn toggle_settings(&mut self, cx: &mut Context<Self>) {
        self.settings_open = !self.settings_open;
        cx.notify();
    }

    fn select(&mut self, thread_id: &str, cx: &mut Context<Self>) {
        self.settings_open = false;
        self.open_menu = None;
        let id = thread_id.to_owned();
        // 窄屏下选中会话后收起抽屉，不挡住主面
        if self.was_narrow {
            self.sidebar_open = false;
        }
        self.state.update(cx, |s, cx| {
            s.activate(ActiveTarget::Thread(id), cx);
        });
        cx.notify();
    }

    /// 主面当前该显示的终端：(thread id, 视图 id, PTY session id)。
    /// 激活的是 shell 视图 → 该视图的 PTY；主面 → 会话主 PTY；git / file 视图尚未实现 → `None`。
    fn active_terminal_session(&self, cx: &Context<Self>) -> Option<(String, String, u64)> {
        let s = self.state.read(cx);
        let id = s.threads.active_thread_id()?;
        let thread = s.threads.thread(id)?;
        let view_id = thread
            .common()
            .active_view_id
            .as_deref()
            .unwrap_or(MAIN_VIEW_ID);
        if view_id == MAIN_VIEW_ID {
            let term = thread.as_terminal()?;
            return Some((id.to_owned(), view_id.to_owned(), term.session_id));
        }
        thread.common().views.iter().find_map(|v| match v {
            SessionView::Shell(sh) if sh.id == view_id => {
                Some((id.to_owned(), view_id.to_owned(), sh.session_id))
            }
            _ => None,
        })
    }
}

impl Render for RootView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if window.focused(cx).is_none() {
            window.focus(&self.focus_handle, cx);
        }
        // 对话主面：激活的是 chat 线程时建 / 复用 ConversationView（键 = thread id）
        let chat_id = {
            let s = self.state.read(cx);
            s.threads
                .active_thread_id()
                .filter(|id| matches!(s.threads.thread(id), Some(Thread::Chat(_) | Thread::Acp(_))))
                .map(str::to_owned)
        };
        if self.conversation.as_ref().map(|(id, _)| id) != chat_id.as_ref() {
            let state = self.state.clone();
            // 会话面切换：收 AddPopover / 侧栏菜单（锚点已卸载，防残留态弹出）
            self.add_popover_open = false;
            self.overflow_popover_open = false;
            self.open_menu = None;
            self.conversation = chat_id.map(|id| {
                let view = cx.new(|cx| ConversationView::new(state, id.clone(), window, cx));
                (id, view)
            });
        }

        let want = self.active_terminal_session(cx);
        let key = want.as_ref().map(|(t, v, _)| (t.clone(), v.clone()));
        if self.terminal.as_ref().map(|(k, _)| k) != key.as_ref() {
            self.add_popover_open = false;
            self.overflow_popover_open = false;
            self.open_menu = None;
            self._terminal_link_sub = None;
            let mut sub = None;
            self.terminal = want.and_then(|(t, v, sid)| {
                let view = view_for_session(sid, window, cx)?;
                let model = view.read(cx).model();
                sub = Some(
                    cx.subscribe(&model, |this, _, event: &jagent_terminal::Event, cx| {
                        if let jagent_terminal::Event::OpenLink(target) = event {
                            this.handle_terminal_open_link(target.clone(), cx);
                        }
                    }),
                );
                Some(((t, v), view))
            });
            self._terminal_link_sub = sub;
        }

        let (groups, mut title): (_, SharedString) = {
            let s = self.state.read(cx);
            let active = s.threads.active_thread_id();
            let title = active
                .and_then(|id| s.threads.thread(id))
                .map_or_else(|| "j-agent".to_owned(), |t| t.title());
            (
                build_groups(s.workspaces(), &s.threads.threads, active),
                title.into(),
            )
        };
        if self.settings_open {
            title = "设置 · j-agent".into();
        }
        // 窄屏切换：从宽变窄时默认收起抽屉，从窄变宽时恢复侧栏面板
        let viewport_w = f32::from(window.viewport_size().width);
        let narrow = is_narrow(viewport_w);
        if narrow != self.was_narrow {
            self.was_narrow = narrow;
            self.sidebar_open = !narrow;
        }
        // 分支钮数据：cwd 变化时重查（查询中先置 None，钮短暂消失——原型同样按 worktree.branch 渲染）
        let cwd_now = self.state.read(cx).git_cwd();
        if cwd_now != self.branch_cwd {
            self.refresh_branch(cx);
        }
        // 工作面板首开建实体（关开之间复用）
        self.ensure_panel(cx);
        if self.sidebar_mode == SidebarMode::Edit {
            self.ensure_sidebar_edit_panel(cx);
        }
        let sidebar_edit_el = self
            .sidebar_edit_panel
            .as_ref()
            .map(|p| p.clone().into_any_element());
        let this_for_mode = cx.entity().downgrade();
        // <1100：右栏转右缘浮层（原型 PANEL_OVERLAY_W）
        let panel_overlay = is_panel_overlay(viewport_w);

        let this = cx.entity().downgrade();
        let state_for_rows = self.state.clone();
        let unread_notices = self.state.read(cx).threads.unread_notice_count();
        // 通知中心投影（倒序 + 相对时间定格）；点击条目/全部已读的规则在 core
        let notif_slot = {
            let s = self.state.read(cx);
            NotifSlot {
                models: notif_models(&s.threads.notices, now_ms()),
                unread: unread_notices,
                on_open: {
                    let state = self.state.clone();
                    Rc::new(move |id, _, cx| {
                        state.update(cx, |s, cx| {
                            s.threads.open_notice(id);
                            s.flush(cx);
                            cx.emit(StateChanged);
                        });
                    })
                },
                on_read_all: {
                    let state = self.state.clone();
                    Rc::new(move |_, cx| {
                        state.update(cx, |s, cx| {
                            s.threads.mark_notices_read();
                            s.flush(cx);
                            cx.emit(StateChanged);
                        });
                    })
                },
            }
        };
        let sidebar = Sidebar::new(
            groups,
            notif_slot,
            env!("CARGO_PKG_VERSION"),
            self.open_menu.clone(),
            {
                // 侧栏「…」菜单受控开合（V5 统一浮层）：一处状态，行/工作区共用
                let this = cx.entity().downgrade();
                move |target, open, _, cx| {
                    let _ = this.update(cx, |v, cx| {
                        v.open_menu = open.then_some(target);
                        cx.notify();
                    });
                }
            },
            move |id, _, cx| {
                let id = id.to_owned();
                let _ = this.update(cx, |v, cx| v.select(&id, cx));
            },
            move |id, action, window, cx| Self::row_action(&state_for_rows, id, action, window, cx),
            {
                let state = self.state.clone();
                let this = cx.entity().downgrade();
                move |window, cx| {
                    let _ = this.update(cx, |v, _| {
                        v.settings_open = false;
                        v.open_menu = None;
                    });
                    workspace_dialog::open(state.clone(), window, cx)
                }
            },
            {
                let this = cx.entity().downgrade();
                move |window, cx| {
                    let _ = this.update(cx, |v, cx| {
                        v.settings_open = !v.settings_open;
                        if v.settings_open {
                            v.ensure_settings_view(window, cx);
                        }
                        cx.notify();
                    });
                }
            },
            {
                // 工作区菜单动作：Rename 在视图层拦截开弹窗，Activate 同时收起设置面，其余落 store
                let state = self.state.clone();
                let this = cx.entity().downgrade();
                move |id: &str, action, window, cx| match action {
                    GroupAction::Rename => {
                        let name = state
                            .read(cx)
                            .threads
                            .workspace(id)
                            .map(|w| w.name.clone())
                            .unwrap_or_default();
                        rename::open_workspace(state.clone(), id.to_owned(), name, window, cx);
                    }
                    GroupAction::Activate => {
                        let _ = this.update(cx, |v, _| {
                            v.settings_open = false;
                            v.open_menu = None;
                        });
                        apply_group_action(&state, id, action, cx);
                    }
                    GroupAction::NewSession { shift } => {
                        let _ = this.update(cx, |v, _| {
                            v.settings_open = false;
                            v.open_menu = None;
                        });
                        new_session::trigger_plus_or_open(
                            state.clone(),
                            Some(id.to_owned()),
                            shift,
                            window,
                            cx,
                        );
                    }
                    _ => apply_group_action(&state, id, action, cx),
                }
            },
            {
                let state = self.state.clone();
                let this = cx.entity().downgrade();
                move |window, cx| {
                    let _ = this.update(cx, |v, _| {
                        v.settings_open = false;
                        v.open_menu = None;
                    });
                    new_session::trigger_plus_or_open(state.clone(), None, false, window, cx)
                }
            },
            {
                let state = self.state.clone();
                move |window, cx| search_threads::open(state.clone(), window, cx)
            },
            {
                let this = cx.entity().downgrade();
                move |cx| {
                    let _ = this.update(cx, |v, cx| {
                        v.sidebar_open = !v.sidebar_open;
                        cx.notify();
                    });
                }
            },
        )
        .with_mode(
            self.sidebar_mode,
            move |mode, _, cx| {
                let _ = this_for_mode.update(cx, |v, cx| {
                    v.sidebar_mode = mode;
                    if mode == SidebarMode::Edit {
                        v.file_surface_mode = FileSurfaceMode::Source;
                        v.file_surface.commit_sha = None;
                        v.panel_open = false;
                        v.ensure_sidebar_edit_panel(cx);
                    }
                    cx.notify();
                });
            },
            sidebar_edit_el,
        );

        let (active_tid, tabs, conv_status_badge) = {
            let s = self.state.read(cx);
            let tid = s.threads.active_thread_id().map(str::to_owned);
            let thread = tid.as_deref().and_then(|id| s.threads.thread(id));
            let tabs = thread.map(tab_models);
            let conv_status_badge = thread.and_then(|t| match t {
                Thread::Chat(c) => Some((c.pending_reply, false, true, false)),
                Thread::Acp(a) => {
                    let connected = s.is_acp_connected(&a.id);
                    let last_err = a.messages.last().is_some_and(|m| m.is_error());
                    Some((a.pending_reply, true, connected, last_err))
                }
                Thread::Terminal(_) => None,
            });
            (tid, tabs, conv_status_badge)
        };

        // 顶栏上下文块（原型 .tb-context：folder + 名 + cwd）
        let (ctx_icon, ctx_label, ctx_cwd, ctx_ws_id) = {
            let s = self.state.read(cx);
            if let Some(tid) = s.threads.active_thread_id() {
                let t = s.threads.thread(tid);
                let ws = t
                    .and_then(|t| t.workspace_id())
                    .and_then(|wid| s.threads.workspace(wid));
                match ws {
                    Some(w) => (IconName::Folder, w.name.clone(), None, Some(w.id.clone())),
                    None => (
                        IconName::Folder,
                        t.map(|t| t.title()).unwrap_or_else(|| "未归属会话".into()),
                        None,
                        s.workspaces().first().map(|w| w.id.clone()),
                    ),
                }
            } else {
                let ws_id = s.active_workspace_id();
                let ws = (!ws_id.is_empty())
                    .then(|| s.threads.workspace(&ws_id))
                    .flatten()
                    .or_else(|| s.workspaces().first());
                match ws {
                    Some(w) => (
                        IconName::Folder,
                        w.name.clone(),
                        Some(w.path.clone()),
                        Some(w.id.clone()),
                    ),
                    None => (IconName::Folder, "j-agent".to_owned(), None, None),
                }
            }
        };

        let (active_file_path, active_view_is_git, active_view_is_main) = {
            let s = self.state.read(cx);
            let tid = s.threads.active_thread_id();
            let thread = tid.and_then(|id| s.threads.thread(id));
            let vid = thread
                .and_then(|t| t.common().active_view_id.as_deref())
                .unwrap_or(MAIN_VIEW_ID);
            let fpath = thread.and_then(|t| {
                t.common().views.iter().find_map(|v| match v {
                    SessionView::File { id, path, .. } if id == vid => Some(path.clone()),
                    _ => None,
                })
            });
            let is_git = thread.is_some_and(|t| {
                t.common()
                    .views
                    .iter()
                    .any(|v| matches!(v, SessionView::Git { id, .. } if id == vid))
            });
            (fpath, is_git, vid == MAIN_VIEW_ID)
        };

        let term_body = if active_view_is_git {
            let cwd = self.state.read(cx).git_cwd();
            if self.git_view.as_ref().map(|(c, _)| c) != Some(&cwd) {
                let state = self.state.clone();
                let gv = cx.new(|cx| git_graph::GitGraphDialog::new_embedded(state, window, cx));
                self.git_view = Some((cwd, gv));
            }
            self.git_view
                .as_ref()
                .map(|(_, gv)| div().size_full().child(gv.clone()).into_any_element())
                .unwrap_or_else(|| div().into_any_element())
        } else if let Some(ref fpath) = active_file_path {
            if self.file_surface_last_key.0 != *fpath {
                self.file_surface_mode = FileSurfaceMode::Source;
                self.file_surface.commit_sha = None;
            }
            let key = (fpath.clone(), self.file_surface_mode);
            if self.file_surface_last_key != key {
                self.file_surface_scroll
                    .set_offset(gpui::point(px(0.0), px(0.0)));
                self.file_surface_last_key = key;
            }
            let target_line = self.file_surface_target_line(fpath);
            self.render_file_surface(fpath, target_line, window, cx)
        } else {
            if !self.file_surface_last_key.0.is_empty() {
                self.file_surface_last_key.0.clear();
            }
            match &self.terminal {
                Some((_, v)) => terminal_surface_with_statusbar(&self.state, v.clone(), cx),
                None => empty_presets(
                    &self.state,
                    narrow,
                    self.branch.clone(),
                    self.worktree_files.clone(),
                    self.bento_outer_scroll.clone(),
                    self.bento_sessions_scroll.clone(),
                    cx,
                ),
            }
        };

        let body = if active_view_is_main && self.conversation.is_some() {
            self.conversation
                .as_ref()
                .map(|(_, v)| v.clone().into_any_element())
                .unwrap_or_else(|| term_body)
        } else {
            term_body
        };
        // 主体列
        let body_column = body;
        let _ = title;

        let inline_tabs = stop_titlebar_drag(
            h_flex()
                .id("tb-tabs")
                .min_w_0()
                .items_center()
                .gap(px(4.0))
                .overflow_hidden(),
        )
        .child({
            match (active_tid, tabs) {
                (Some(tid), Some(tabs)) => {
                    let st = self.state.clone();
                    let (st_a, st_c) = (st.clone(), st);
                    let (tid_a, tid_c, add_tid) = (tid.clone(), tid.clone(), tid);
                    let this_add = cx.entity().downgrade();
                    let add_on_open = cx.entity().downgrade();
                    let (add_state, add_weak) = (self.state.clone(), cx.entity().downgrade());
                    let add_files = self.worktree_files.clone();
                    let add_popover = Popover::new("session-add-popover")
                        .open(self.add_popover_open)
                        .anchor(gpui::Anchor::TopLeft)
                        .offset(px(4.0))
                        .on_open_change(move |open, _, cx| {
                            let _ = add_on_open.update(cx, |v, cx| {
                                v.add_popover_open = *open;
                                cx.notify();
                            });
                        })
                        .trigger(PopupTrigger::new(|_| {
                            div().id("add-pop-anchor").size(px(0.0)).into_any_element()
                        }))
                        .content(move |_, _, _| {
                            let (state, weak, tid) =
                                (add_state.clone(), add_weak.clone(), add_tid.clone());
                            let mut pop = overlay_shell("session-add-pop").w(px(280.0)).p(px(4.0));
                            pop = pop.child(action_row(
                                "add-pop-graph",
                                IconName::GitBranch,
                                "打开 Git 图",
                                {
                                    let (state, weak) = (state.clone(), weak.clone());
                                    move |window, cx| {
                                        let _ = weak.update(cx, |v, cx| {
                                            v.add_popover_open = false;
                                            cx.notify();
                                        });
                                        git_graph::open(state.clone(), window, cx);
                                    }
                                },
                            ));
                            let weak_shell = weak.clone();
                            let state_shell = state.clone();
                            let tid_shell = tid.clone();
                            pop = pop.child(action_row(
                                "add-pop-shell",
                                IconName::Terminal,
                                "新建 Shell",
                                move |window, cx| {
                                    let _ = weak_shell.update(cx, |v, cx| {
                                        v.add_popover_open = false;
                                        cx.notify();
                                    });
                                    let r = state_shell.update(cx, |s, cx| {
                                        let r = s.add_session_shell(&tid_shell, cx);
                                        cx.emit(StateChanged);
                                        r
                                    });
                                    if let Err(e) = r {
                                        window.push_notification(
                                            Notification::error(format!("新建 Shell 失败：{e}")),
                                            cx,
                                        );
                                    }
                                },
                            ));
                            pop = pop.child(
                                div()
                                    .pl(px(8.0))
                                    .pr(px(8.0))
                                    .pt(px(8.0))
                                    .pb(px(4.0))
                                    .text_size(px(10.5))
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .text_color(hex(colors::MUTED))
                                    .child("打开文件"),
                            );
                            if add_files.is_empty() {
                                pop = pop.child(
                                    div()
                                        .pl(px(8.0))
                                        .pr(px(8.0))
                                        .pb(px(4.0))
                                        .text_size(px(11.0))
                                        .text_color(hex(colors::MUTED))
                                        .child("当前工作区无变更文件"),
                                );
                            } else {
                                let mut list = div()
                                    .id("sa-files")
                                    .max_h(px(220.0))
                                    .overflow_y_scroll()
                                    .flex()
                                    .flex_col();
                                for f in add_files.iter() {
                                    let (path, pick_weak, pick_state, pick_tid) =
                                        (f.path.clone(), weak.clone(), state.clone(), tid.clone());
                                    list = list.child(sa_file_row(f, move |_, cx| {
                                        pick_state.update(cx, |s, cx| {
                                            s.threads.open_session_file(&pick_tid, &path);
                                            s.flush(cx);
                                            cx.emit(StateChanged);
                                        });
                                        let _ = pick_weak.update(cx, |v, cx| {
                                            v.add_popover_open = false;
                                            v.open_panel_file(&path, cx);
                                            cx.notify();
                                        });
                                    }));
                                }
                                pop = pop.child(list);
                            }
                            pop.into_any_element()
                        });
                    let this_overflow = cx.entity().downgrade();
                    let overflow_on_open = cx.entity().downgrade();
                    let (ov_state, ov_weak, ov_tid) =
                        (self.state.clone(), cx.entity().downgrade(), tid_a.clone());
                    let ov_tabs = tabs.clone();
                    let overflow_popover = Popover::new("session-overflow-popover")
                        .open(self.overflow_popover_open)
                        .anchor(gpui::Anchor::TopLeft)
                        .offset(px(4.0))
                        .on_open_change(move |open, _, cx| {
                            let _ = overflow_on_open.update(cx, |v, cx| {
                                v.overflow_popover_open = *open;
                                cx.notify();
                            });
                        })
                        .trigger(PopupTrigger::new(|_| {
                            div()
                                .id("overflow-pop-anchor")
                                .size(px(0.0))
                                .into_any_element()
                        }))
                        .content(move |_, _, _| {
                            let sub_views: Vec<_> = ov_tabs.iter().skip(1).cloned().collect();
                            let (vis, _) = crate::views::session_tabs::visible_and_overflow_tabs(
                                &ov_tabs,
                                crate::views::session_tabs::MAX_INLINE_VIEWS,
                            );
                            let mut pop = overlay_shell("session-overflow-pop")
                                .w(px(280.0))
                                .p(px(6.0))
                                .flex()
                                .flex_col()
                                .gap(px(4.0));
                            pop = pop.child(
                                div()
                                    .px(px(6.0))
                                    .py(px(2.0))
                                    .text_size(px(10.5))
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .text_color(hex(colors::MUTED))
                                    .child(format!(
                                        "当前会话副视图 ({}) · 顶栏上限 {} 项",
                                        sub_views.len(),
                                        crate::views::session_tabs::MAX_INLINE_VIEWS
                                    )),
                            );
                            let mut list = v_flex()
                                .id("ov-views-list")
                                .max_h(px(210.0))
                                .overflow_y_scroll()
                                .gap(px(2.0));
                            for v in &sub_views {
                                let is_act = v.active;
                                let in_bar = vis.iter().any(|x| x.id == v.id);
                                let (vid_act, vid_close) = (v.id.clone(), v.id.clone());
                                let (st_act, st_cls) = (ov_state.clone(), ov_state.clone());
                                let (tid_act, tid_cls) = (ov_tid.clone(), ov_tid.clone());
                                let (wk_act, wk_cls) = (ov_weak.clone(), ov_weak.clone());
                                list = list.child(
                                    h_flex()
                                        .id(gpui::ElementId::Name(
                                            format!("ov-view-{}", v.id).into(),
                                        ))
                                        .h(px(28.0))
                                        .px(px(8.0))
                                        .gap(px(6.0))
                                        .items_center()
                                        .justify_between()
                                        .rounded(px(5.0))
                                        .cursor_pointer()
                                        .when_else(
                                            is_act,
                                            |d| d.bg(hex(colors::SURFACE_ACTIVE)),
                                            |d| d.hover(|h| h.bg(hex(colors::SURFACE))),
                                        )
                                        .on_click(move |_, _, cx| {
                                            let _ = wk_act.update(cx, |r, cx| {
                                                r.overflow_popover_open = false;
                                                cx.notify();
                                            });
                                            st_act.update(cx, |s, cx| {
                                                s.activate_view(&tid_act, &vid_act, cx);
                                                cx.emit(StateChanged);
                                            });
                                        })
                                        .child(
                                            h_flex()
                                                .gap(px(6.0))
                                                .items_center()
                                                .min_w_0()
                                                .flex_1()
                                                .child(
                                                    div()
                                                        .min_w_0()
                                                        .overflow_hidden()
                                                        .whitespace_nowrap()
                                                        .text_ellipsis()
                                                        .text_size(px(12.0))
                                                        .text_color(if is_act {
                                                            hex(colors::TEXT_BRIGHT)
                                                        } else {
                                                            hex(colors::TEXT)
                                                        })
                                                        .child(v.title.clone()),
                                                )
                                                .when(!in_bar, |d| {
                                                    d.child(
                                                        div()
                                                            .px(px(5.0))
                                                            .rounded(px(4.0))
                                                            .bg(accent_alpha(0.14))
                                                            .font_family("monospace")
                                                            .text_size(px(9.5))
                                                            .text_color(hex(colors::ACCENT_HOVER))
                                                            .child("已收纳"),
                                                    )
                                                }),
                                        )
                                        .child(
                                            div()
                                                .id(gpui::ElementId::Name(
                                                    format!("ov-close-{}", v.id).into(),
                                                ))
                                                .size(px(20.0))
                                                .rounded(px(4.0))
                                                .flex()
                                                .items_center()
                                                .justify_center()
                                                .hover(|h| h.bg(hex(colors::CLOSE_HOVER)))
                                                .child(icon(
                                                    IconName::Close,
                                                    11.0,
                                                    hex(colors::MUTED),
                                                ))
                                                .on_click(move |_, _, cx| {
                                                    cx.stop_propagation();
                                                    st_cls.update(cx, |s, cx| {
                                                        s.close_view(&tid_cls, &vid_close, cx);
                                                        cx.emit(StateChanged);
                                                    });
                                                    let _ = wk_cls.update(cx, |_, cx| {
                                                        cx.notify();
                                                    });
                                                }),
                                        ),
                                );
                            }
                            pop = pop.child(list);
                            let st_all = ov_state.clone();
                            let tid_all = ov_tid.clone();
                            let wk_all = ov_weak.clone();
                            let ids_all: Vec<String> =
                                sub_views.iter().map(|v| v.id.clone()).collect();
                            pop = pop.child(
                                div()
                                    .pt(px(4.0))
                                    .border_t_1()
                                    .border_color(hex(colors::BORDER_SUBTLE))
                                    .child(
                                        h_flex()
                                            .id("ov-close-all")
                                            .h(px(28.0))
                                            .px(px(8.0))
                                            .gap(px(6.0))
                                            .items_center()
                                            .rounded(px(5.0))
                                            .cursor_pointer()
                                            .hover(|h| h.bg(hex(colors::SURFACE)))
                                            .child(icon(IconName::Trash, 12.0, hex(colors::BELL)))
                                            .child(
                                                div()
                                                    .text_size(px(12.0))
                                                    .text_color(hex(colors::BELL))
                                                    .child(format!(
                                                        "关闭全部副视图 ({})",
                                                        sub_views.len()
                                                    )),
                                            )
                                            .on_click(move |_, _, cx| {
                                                let _ = wk_all.update(cx, |r, cx| {
                                                    r.overflow_popover_open = false;
                                                    cx.notify();
                                                });
                                                st_all.update(cx, |s, cx| {
                                                    for vid in &ids_all {
                                                        s.close_view(&tid_all, vid, cx);
                                                    }
                                                    cx.emit(StateChanged);
                                                });
                                            }),
                                    ),
                            );
                            pop.into_any_element()
                        });
                    h_flex()
                        .min_w_0()
                        .items_center()
                        .child(
                            SessionTabs::new(
                                tabs,
                                move |vid, _, cx| {
                                    st_a.update(cx, |s, cx| {
                                        s.activate_view(&tid_a, vid, cx);
                                        cx.emit(StateChanged);
                                    })
                                },
                                move |vid, _, cx| {
                                    st_c.update(cx, |s, cx| {
                                        s.close_view(&tid_c, vid, cx);
                                        cx.emit(StateChanged);
                                    })
                                },
                                move |_window, cx| {
                                    let _ = this_add.update(cx, |v, cx| {
                                        v.add_popover_open = !v.add_popover_open;
                                        cx.notify();
                                    });
                                },
                            )
                            .with_on_overflow(move |_window, cx| {
                                let _ = this_overflow.update(cx, |v, cx| {
                                    v.overflow_popover_open = !v.overflow_popover_open;
                                    cx.notify();
                                });
                            }),
                        )
                        .child(overflow_popover)
                        .child(add_popover)
                        .into_any_element()
                }
                (Some(_), None) => {
                    let s = self.state.read(cx);
                    let (ic, label) = s
                        .threads
                        .active_thread_id()
                        .and_then(|id| s.threads.thread(id))
                        .map(|t| match t {
                            Thread::Chat(_) => (IconName::Chat, t.title()),
                            Thread::Acp(_) => (IconName::Acp, t.title()),
                            Thread::Terminal(_) => (IconName::Terminal, t.title()),
                        })
                        .unwrap_or((IconName::Home, "j-agent".into()));
                    ContextTab::new(ic, label).into_any_element()
                }
                _ => ContextTab::new(IconName::Home, "j-agent").into_any_element(),
            }
        });

        // ── 单行融合工作台顶栏（40px：工作区面包屑 + 内联副页签 + 对话状态胶囊 + 分支胶囊 + 面板开关）──
        let (perf_hud_on, frame_overlay_on) = {
            let adv = &self.state.read(cx).settings.get().advanced;
            (adv.perf_hud, adv.frame_overlay)
        };
        if perf_hud_on || frame_overlay_on {
            self.perf_tracker.sample();
        }
        let perf_snapshot = self.perf_tracker.clone();
        let is_fullscreen = window.is_fullscreen();
        let workbench_pl = workbench_header_left_padding(
            cfg!(target_os = "macos"),
            is_fullscreen,
            !narrow && self.sidebar_open,
        );
        let workbench_header = bind_titlebar_drag(
            h_flex()
                .id("title-bar")
                .h(px(sizes::TOOLBAR_HEIGHT))
                .flex_shrink_0()
                .items_center()
                .pl(px(workbench_pl))
                .pr(px(if cfg!(target_os = "macos") { 6.0 } else { 0.0 }))
                .when(!narrow, |d| d.rounded_t(px(sizes::ISLAND_RADIUS - 1.0)))
                .bg(crate::theme::rgba_css(13, 15, 21, 0.75))
                .border_b_1()
                .border_color(hex(colors::BORDER_SUBTLE)),
            "workbench-titlebar-drag",
            window,
            cx,
        )
        // 窄屏汉堡钮 / 宽屏侧栏收起态的恢复钮
        .when(narrow || !self.sidebar_open, |tb| {
            let this = cx.entity().downgrade();
            let (ic, on) = if narrow {
                (IconName::Menu, self.sidebar_open)
            } else {
                (IconName::PanelLeft, false)
            };
            tb.child(stop_titlebar_drag(
                div()
                    .id("titlebar-sidebar-toggle")
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(28.0))
                    .rounded(px(7.0))
                    .ml(px(6.0))
                    .mr(px(2.0))
                    .flex_shrink_0()
                    .cursor_pointer()
                    .when(on, |d| d.bg(hex(colors::SURFACE_ACTIVE)))
                    .when(!on, |d| d.hover(|h| h.bg(hex(colors::SURFACE))))
                    .child(icon(
                        ic,
                        15.0,
                        if on {
                            hex(colors::TEXT_BRIGHT)
                        } else {
                            hex(colors::MUTED)
                        },
                    ))
                    .on_click(move |_, _, cx| {
                        let _ = this.update(cx, |v, cx| {
                            v.sidebar_open = !v.sidebar_open;
                            cx.notify();
                        });
                    }),
            ))
        })
        // 左侧工作区路径面包屑（点击返回工作区 Bento 启动台）
        .child({
            let this_ctx = cx.entity().downgrade();
            let state_ctx = self.state.clone();
            let target_ws = ctx_ws_id.clone();
            stop_titlebar_drag(
                h_flex()
                    .id("tb-context")
                    .h_full()
                    .items_center()
                    .gap(px(6.0))
                    .pl(px(12.0))
                    .pr(px(8.0))
                    .flex_shrink_0()
                    .cursor_pointer()
                    .child(icon(ctx_icon, 13.5, hex(colors::ACCENT_HOVER)))
                    .child(
                        div()
                            .text_size(px(12.0))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(hex(colors::TEXT_BRIGHT))
                            .whitespace_nowrap()
                            .child(ctx_label.clone()),
                    )
                    .when(!narrow, |d| {
                        d.when_some(ctx_cwd.clone(), |d, cwd| {
                            d.child(
                                div()
                                    .max_w(px(200.0))
                                    .min_w_0()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .text_size(px(11.0))
                                    .font_family("monospace")
                                    .text_color(hex(colors::FAINT))
                                    .child(cwd),
                            )
                        })
                    })
                    .on_click(move |_, _, cx| {
                        let _ = this_ctx.update(cx, |v, _| {
                            v.settings_open = false;
                            v.open_menu = None;
                        });
                        if let Some(ref wid) = target_ws {
                            state_ctx.update(cx, |s, cx| {
                                s.activate(ActiveTarget::Workspace(wid.clone()), cx);
                            });
                        }
                    })
                    .child(
                        div()
                            .ml(px(4.0))
                            .w(px(1.0))
                            .h(px(14.0))
                            .bg(hex(colors::BORDER_SUBTLE)),
                    ),
            )
        })
        .child(inline_tabs)
        // AI 对话 / ACP 连接状态胶囊（替代原 conv-head 独立栏）
        .when(!narrow && !self.settings_open, |tb| {
            tb.when_some(
                conv_status_badge,
                |tb, (pending, is_acp, connected, last_err)| {
                    let (bg, border, fg, label) = if pending {
                        (
                            crate::theme::rgba_css(251, 191, 36, 0.14),
                            crate::theme::rgba_css(251, 191, 36, 0.30),
                            hex(colors::STATUS_RUNNING),
                            if is_acp && !connected {
                                "正在连接 ACP…"
                            } else {
                                "正在回复…"
                            },
                        )
                    } else if is_acp && last_err && !connected {
                        (
                            crate::theme::rgba_css(224, 108, 117, 0.14),
                            crate::theme::rgba_css(224, 108, 117, 0.30),
                            hex(colors::STATUS_ERROR),
                            "ACP 连接失败",
                        )
                    } else if is_acp && !connected {
                        (
                            crate::theme::rgba_css(148, 163, 184, 0.12),
                            crate::theme::rgba_css(148, 163, 184, 0.26),
                            hex(colors::MUTED),
                            "待连接 ACP",
                        )
                    } else {
                        (
                            crate::theme::rgba_css(52, 211, 153, 0.14),
                            crate::theme::rgba_css(52, 211, 153, 0.30),
                            hex(colors::STATUS_DONE),
                            if is_acp { "已连接 ACP" } else { "在线" },
                        )
                    };
                    tb.child(stop_titlebar_drag(
                        h_flex()
                            .id("titlebar-conv-status")
                            .debug_selector(|| "titlebar-conv-status".to_string())
                            .ml(px(6.0))
                            .h(px(22.0))
                            .px(px(8.0))
                            .gap(px(5.0))
                            .items_center()
                            .rounded_full()
                            .bg(bg)
                            .border_1()
                            .border_color(border)
                            .flex_shrink_0()
                            .child(div().size(px(6.0)).rounded_full().bg(fg))
                            .child(
                                div()
                                    .text_size(px(10.5))
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .text_color(fg)
                                    .child(label),
                            ),
                    ))
                },
            )
        })
        .child(div().flex_1().min_w(px(8.0)).h_full())
        // 性能指标 HUD（settings.advanced.perfHud）
        .when(perf_hud_on, |tb| {
            tb.child(stop_titlebar_drag(
                h_flex()
                    .id("perf-hud")
                    .debug_selector(|| "perf-hud".to_string())
                    .mr(px(6.0))
                    .h(px(22.0))
                    .px(px(8.0))
                    .gap(px(6.0))
                    .items_center()
                    .rounded(px(5.0))
                    .bg(hex(colors::INPUT_BG))
                    .border_1()
                    .border_color(hex(colors::BORDER_SUBTLE))
                    .font_family("monospace")
                    .text_size(px(10.0))
                    .text_color(hex(colors::MUTED))
                    .child(
                        div()
                            .size(px(6.0))
                            .rounded_full()
                            .bg(if perf_snapshot.p90_ms <= 16.7 {
                                hex(colors::STATUS_DONE)
                            } else {
                                hex(colors::STATUS_RUNNING)
                            }),
                    )
                    .child(format!(
                        "p90 {:.1}ms · max {:.1}ms · paint {}µs",
                        perf_snapshot.p90_ms, perf_snapshot.max_ms, perf_snapshot.paint_us
                    )),
            ))
        })
        // 分支胶囊
        .when(!narrow, |tb| {
            tb.when_some(self.branch.clone(), |tb, branch| {
                tb.child(
                    stop_titlebar_drag(div().id("tb-branch-wrap")).child(branch_menu(
                        branch,
                        &self.state,
                        cx,
                    )),
                )
            })
        })
        // 搜索入口（仅窄屏 / 侧栏收起时显示）
        .when(narrow || !self.sidebar_open, |tb| {
            let state = self.state.clone();
            tb.child(tb_icon_btn(
                "titlebar-search",
                IconName::Search,
                15.0,
                false,
                move |_, window, cx| search_threads::open(state.clone(), window, cx),
            ))
        })
        // 右侧工作面板开关
        .child({
            let this = cx.entity().downgrade();
            tb_icon_btn(
                "titlebar-panel-toggle",
                IconName::PanelRight,
                15.0,
                self.panel_open,
                move |_, _, cx| {
                    let _ = this.update(cx, |v, cx| {
                        v.panel_open = !v.panel_open;
                        v.ensure_panel(cx);
                        cx.notify();
                    });
                },
            )
        })
        .child(window_controls_bar(window, !narrow));

        let state = self.state.clone();
        let active_term_for_copy = (!self.settings_open
            && !active_view_is_git
            && active_file_path.is_none()
            && !(active_view_is_main && self.conversation.is_some()))
        .then(|| self.terminal.as_ref().map(|(_, v)| v.clone()))
        .flatten();
        v_flex()
            .track_focus(&self.focus_handle)
            .key_context(CTX_WORKSPACE)
            .on_modifiers_changed(cx.listener(|this, e: &gpui::ModifiersChangedEvent, _, cx| {
                if let Some((_, ref tv)) = this.terminal {
                    tv.update(cx, |v, cx| v.on_modifiers_changed(e, cx));
                }
            }))
            .child(
                gpui::canvas(
                    |_, _, _| (),
                    move |_, _, window, _cx| {
                        let term_for_copy = active_term_for_copy.clone();
                        window.on_action(
                            std::any::TypeId::of::<gpui_base::input::Copy>(),
                            move |_, phase, window, cx| {
                                if phase == gpui::DispatchPhase::Capture {
                                    let text = gpui_base::TextSelection::selected_text(window, cx);
                                    if !text.trim().is_empty() {
                                        cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                                            text.trim().to_string(),
                                        ));
                                        cx.stop_propagation();
                                        return;
                                    }
                                    if let Some(ref tv) = term_for_copy {
                                        let copied = tv.update(cx, |v, cx| {
                                            let ok = v.copy_selection(cx);
                                            #[cfg(not(target_os = "macos"))]
                                            if ok {
                                                v.clear_selection(cx);
                                            }
                                            ok
                                        });
                                        if copied {
                                            cx.stop_propagation();
                                        }
                                    }
                                }
                            },
                        );
                    },
                )
                .size_0()
                .absolute(),
            )
            .on_action(cx.listener(|this, _: &ToggleSettings, window, cx| {
                this.toggle_settings(cx);
                if this.settings_open {
                    this.ensure_settings_view(window, cx);
                    if let Some(view) = &this.settings_view {
                        view.update(cx, |view, _| view.focus_search());
                    }
                } else if let Some((_, ref tv)) = this.terminal {
                    let fh = tv.read(cx).focus_handle().clone();
                    fh.focus(window, cx);
                }
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &CloseSettings, window, cx| {
                this.settings_open = false;
                if let Some((_, ref tv)) = this.terminal {
                    let fh = tv.read(cx).focus_handle().clone();
                    fh.focus(window, cx);
                }
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &FocusSettingsSearch, _, cx| {
                if let Some(settings) = &this.settings_view {
                    settings.update(cx, |view, _| view.focus_search());
                }
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ToggleSidebar, _, cx| {
                this.sidebar_open = !this.sidebar_open;
                this.open_menu = None;
                cx.notify();
            }))
            .on_action({
                let this = cx.entity();
                move |_: &CycleNext, _, cx| cycle_thread(&this, 1, cx)
            })
            .on_action({
                let this = cx.entity();
                move |_: &CyclePrev, _, cx| cycle_thread(&this, -1, cx)
            })
            .on_action({
                let state = state.clone();
                move |_: &NewSession, window, cx| new_session::open(state.clone(), window, cx)
            })
            .on_action({
                let state = state.clone();
                let this = cx.entity().downgrade();
                move |_: &NewTerminal, window, cx| {
                    let _ = this.update(cx, |v, _| {
                        v.settings_open = false;
                        v.open_menu = None;
                    });
                    let ws_opt = {
                        let s = state.read(cx);
                        let active = s.active_workspace_id();
                        if !active.is_empty() {
                            Some(active)
                        } else {
                            s.workspaces().first().map(|w| w.id.clone())
                        }
                    };
                    let r = state.update(cx, |s, cx| {
                        let r = s
                            .spawn_from_preset("shell", ws_opt.as_deref(), cx)
                            .map(|_| ());
                        cx.emit(StateChanged);
                        r
                    });
                    if let Err(e) = r
                        && window.root::<gpui_base::Root>().flatten().is_some()
                    {
                        window.push_notification(Notification::error(e.to_string()), cx);
                    }
                }
            })
            .on_action({
                let state = state.clone();
                move |_: &SearchThreads, window, cx| search_threads::open(state.clone(), window, cx)
            })
            .on_action(move |_: &OpenGitGraph, window, cx| {
                git_graph::open(state.clone(), window, cx)
            })
            .on_action(|_: &ToggleFullScreen, window, _| {
                window.toggle_fullscreen();
            })
            .on_action(|_: &MinimizeWindow, window, _| {
                window.minimize_window();
            })
            .on_action(|_: &ZoomWindow, window, _| {
                window.zoom_window();
            })
            .relative()
            .size_full()
            .bg(hex(colors::APP))
            .child(if narrow {
                let narrow_workbench = v_flex()
                    .size_full()
                    .min_h_0()
                    .min_w_0()
                    .bg(hex(colors::PANE))
                    .child(workbench_header)
                    .child(div().flex_1().min_h_0().min_w_0().child(body_column))
                    .into_any_element();
                narrow_body(
                    sidebar,
                    narrow_workbench,
                    self.sidebar_open,
                    self.sidebar_width,
                    self.panel
                        .as_ref()
                        .filter(|_| self.panel_open)
                        .map(|p| p.clone().into_any_element())
                        .map(|el| panel_overlay_el(el, self.panel_width, viewport_w)),
                    cx,
                )
            } else {
                // 工作台内容区（主面 + 右侧工作面板）
                let workbench_body = if panel_overlay {
                    div()
                        .relative()
                        .flex_1()
                        .min_h_0()
                        .min_w_0()
                        .size_full()
                        .child(
                            div()
                                .size_full()
                                .min_w_0()
                                .bg(cx.theme().colors.list)
                                .child(body_column),
                        )
                        .when(self.panel_open, |d| {
                            let panel = self
                                .panel
                                .as_ref()
                                .map(|p| p.clone().into_any_element())
                                .expect("panel_open 时 ensure_panel 已建实体");
                            d.child(panel_overlay_el(panel, self.panel_width, viewport_w))
                        })
                        .into_any_element()
                } else {
                    let panel_width = self.panel_width;
                    let this = cx.entity().downgrade();
                    h_resizable("work-split")
                        .with_handle_appearance(accent_handle())
                        .with_state(&self.work_split)
                        .on_resize(move |split, _, cx| {
                            let Some(w) = split.read(cx).sizes().get(1).copied() else {
                                return;
                            };
                            let _ = this.update(cx, |v, _| v.panel_width = f32::from(w));
                        })
                        .child(
                            resizable_panel().child(
                                div()
                                    .size_full()
                                    .min_w_0()
                                    .bg(cx.theme().colors.list)
                                    .child(body_column),
                            ),
                        )
                        .child(
                            resizable_panel()
                                .size(px(panel_width))
                                .size_range(px(sizes::PANEL_WIDTH_MIN)..px(sizes::PANEL_WIDTH_MAX))
                                .visible(self.panel_open)
                                .child(match self.panel.as_ref() {
                                    Some(p) => p.clone().into_any_element(),
                                    None => div().into_any_element(),
                                }),
                        )
                        .into_any_element()
                };

                // ── Arc 风格左右对称双悬浮圆角岛（左导航岛 + 右工作台画布岛）──
                let island_margin = sizes::ISLAND_MARGIN;
                let sidebar_island = div()
                    .size_full()
                    .min_h_0()
                    .min_w_0()
                    .pt(px(island_margin))
                    .pb(px(island_margin))
                    .pl(px(island_margin))
                    .pr(px(island_margin * 0.5))
                    .bg(hex(colors::APP))
                    .child(
                        v_flex()
                            .size_full()
                            .min_h_0()
                            .min_w_0()
                            .rounded(px(sizes::ISLAND_RADIUS))
                            .border_1()
                            .border_color(hex(colors::BORDER_SUBTLE))
                            .bg(hex(colors::PANE))
                            .overflow_hidden()
                            .shadow(vec![
                                BoxShadow::new(px(0.0), px(6.0), gpui::hsla(0.0, 0.0, 0.0, 0.42))
                                    .blur_radius(px(24.0)),
                            ])
                            .child(sidebar),
                    )
                    .into_any_element();

                let workbench_island = div()
                    .size_full()
                    .min_h_0()
                    .min_w_0()
                    .pt(px(island_margin))
                    .pb(px(island_margin))
                    .pr(px(island_margin))
                    .pl(px(if self.sidebar_open {
                        island_margin * 0.5
                    } else {
                        island_margin
                    }))
                    .bg(hex(colors::APP))
                    .child(
                        v_flex()
                            .size_full()
                            .min_h_0()
                            .min_w_0()
                            .rounded(px(sizes::ISLAND_RADIUS))
                            .border_1()
                            .border_color(hex(colors::BORDER_SUBTLE))
                            .bg(hex(colors::PANE))
                            .overflow_hidden()
                            .shadow(vec![
                                BoxShadow::new(px(0.0), px(6.0), gpui::hsla(0.0, 0.0, 0.0, 0.42))
                                    .blur_radius(px(24.0)),
                            ])
                            .child(workbench_header)
                            .child(workbench_body),
                    )
                    .into_any_element();

                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .min_h_0()
                    .child(
                        h_resizable("main-split")
                            .with_handle_appearance(accent_handle())
                            .with_state(&self.split)
                            .on_resize({
                                let state = self.state.clone();
                                move |split, _, cx| {
                                    let Some(w) = split.read(cx).sizes().first().copied() else {
                                        return;
                                    };
                                    persist_sidebar_width(&state, f32::from(w), cx);
                                }
                            })
                            .child(
                                resizable_panel()
                                    .size(px(self.sidebar_width))
                                    .size_range(px(200.)..px(400.))
                                    .visible(self.sidebar_open)
                                    .child(sidebar_island),
                            )
                            .child(resizable_panel().child(workbench_island)),
                    )
                    .into_any_element()
            })
            // ── 屏幕帧耗时直方图覆盖层（settings.advanced.frameOverlay）──
            .when(frame_overlay_on, |d| {
                d.child(render_frame_overlay(&perf_snapshot))
            })
            // ── 独立多窗口设置中心覆盖层（Multi-Window SettingsWindow）──
            .when(self.settings_open, |d| {
                self.ensure_settings_view(window, cx);
                if let Some(ref sv) = self.settings_view {
                    d.child(div().absolute().inset_0().child(sv.clone()))
                } else {
                    d
                }
            })
    }
}

/// 屏幕右下角帧耗时直方图覆盖层（对应 `settings.advanced.frameOverlay`）。
fn render_frame_overlay(perf: &PerfTracker) -> AnyElement {
    let bars: Vec<AnyElement> = perf
        .history_ms
        .iter()
        .copied()
        .map(|ms| {
            let ratio = (ms / 20.0).clamp(0.12, 1.0);
            let h = (ratio * 28.0).round();
            let col = if ms <= 8.0 {
                hex(colors::STATUS_DONE)
            } else if ms <= 16.7 {
                hex(colors::ACCENT_HOVER)
            } else {
                hex(colors::STATUS_RUNNING)
            };
            div()
                .w(px(3.5))
                .h(px(h))
                .rounded(px(1.5))
                .bg(col)
                .into_any_element()
        })
        .collect();

    v_flex()
        .id("frame-overlay")
        .debug_selector(|| "frame-overlay".to_string())
        .absolute()
        .right(px(16.0))
        .bottom(px(36.0))
        .p(px(8.0))
        .gap(px(5.0))
        .rounded(px(8.0))
        .bg(crate::theme::rgba_css(13, 15, 21, 0.88))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .font_family("monospace")
        .text_size(px(10.0))
        .text_color(hex(colors::MUTED))
        .child(
            h_flex()
                .gap(px(8.0))
                .items_center()
                .justify_between()
                .child(
                    div()
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .child("FRAME OVERLAY"),
                )
                .child(format!(
                    "{:.1}ms · paint max {}µs",
                    perf.frame_ms, perf.paint_max_us
                )),
        )
        .child(
            h_flex()
                .h(px(28.0))
                .gap(px(2.0))
                .items_end()
                .children(bars),
        )
        .into_any_element()
}

/// 终端主面 / 伴随 Shell 表面（含底部 26px 轻量终端状态条 `.term-statusbar`）。
fn terminal_surface_with_statusbar(
    state: &Entity<AppState>,
    term_view: Entity<TerminalView>,
    cx: &App,
) -> AnyElement {
    let (status_title, is_exited, cwd_text, font_info) = {
        let s = state.read(cx);
        let term_cfg = &s.settings.get().terminal;
        let font_info = format!("{} {}px", term_cfg.font_family, term_cfg.font_size);
        let tid = s.threads.active_thread_id();
        let thread = tid.and_then(|id| s.threads.thread(id));
        let vid = thread
            .and_then(|t| t.common().active_view_id.as_deref())
            .unwrap_or(MAIN_VIEW_ID);
        if vid != MAIN_VIEW_ID
            && let Some(sh) = thread.and_then(|t| {
                t.common().views.iter().find_map(|v| match v {
                    SessionView::Shell(sh) if sh.id == vid => Some(sh),
                    _ => None,
                })
            })
        {
            let exited = sh.status == jagent_core::threads::RunStatus::Exited;
            (
                format!("● 伴随 Shell · {}", sh.label),
                exited,
                format!("cwd: {}", sh.cwd),
                font_info,
            )
        } else if let Some(term) = thread.and_then(|t| t.as_terminal()) {
            let exited = term.status == jagent_core::threads::RunStatus::Exited;
            let st_txt = if exited {
                format!("● 进程已退出 · session #{}", term.session_id)
            } else {
                format!("● PTY 活跃 · session #{}", term.session_id)
            };
            (st_txt, exited, format!("cwd: {}", term.cwd), font_info)
        } else {
            (
                "● PTY 活跃".to_owned(),
                false,
                format!("cwd: {}", s.git_cwd()),
                font_info,
            )
        }
    };

    let statusbar = h_flex()
        .id("term-statusbar")
        .h(px(26.0))
        .px(px(14.0))
        .items_center()
        .justify_between()
        .flex_shrink_0()
        .bg(hex(colors::SIDEBAR))
        .border_t_1()
        .border_color(hex(colors::BORDER))
        .font_family("monospace")
        .text_size(px(11.0))
        .text_color(hex(colors::MUTED))
        .child(
            h_flex()
                .gap(px(14.0))
                .items_center()
                .child(
                    div()
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(if is_exited {
                            hex(colors::FAINT)
                        } else {
                            hex(colors::TERMINAL_KIND)
                        })
                        .child(sel_text_id("term-status-title", status_title)),
                )
                .child(
                    div()
                        .max_w(px(360.0))
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .child(sel_text_id("term-status-cwd", cwd_text)),
                ),
        )
        .child(
            h_flex()
                .gap(px(14.0))
                .items_center()
                .child(div().child(sel_text_id("term-status-font", font_info)))
                .child(div().child("UTF-8")),
        );

    let term_for_copy = term_view.clone();
    let term_for_paste = term_view.clone();
    let term_for_select_all = term_view.clone();
    let term_for_mouse = term_view.clone();
    v_flex()
        .size_full()
        .min_h_0()
        .min_w_0()
        .bg(hex(colors::PANE))
        .on_action(move |_: &gpui_base::input::Copy, _window, cx| {
            let copied = term_for_copy.update(cx, |v, cx| {
                let ok = v.copy_selection(cx);
                #[cfg(not(target_os = "macos"))]
                if ok {
                    // 非 macOS 下 Ctrl+C 绑为 Copy：复制后清除选区，使下一次 Ctrl+C 可正常发送 SIGINT (0x03)。
                    v.clear_selection(cx);
                }
                ok
            });
            if !copied {
                cx.propagate();
            }
        })
        .on_action(move |_: &gpui_base::input::Paste, _window, cx| {
            term_for_paste.update(cx, |v, cx| v.paste_clipboard(cx));
        })
        .on_action(move |_: &gpui_base::input::SelectAll, _window, cx| {
            term_for_select_all.update(cx, |v, cx| v.select_all(cx));
        })
        .child(
            div()
                .relative()
                .flex_1()
                .min_h_0()
                .min_w_0()
                .child(
                    gpui::canvas(
                        |bounds, _, _| bounds,
                        move |bounds, _, window, _cx| {
                            let term_for_down = term_for_mouse.clone();
                            window.on_mouse_event(
                                move |event: &MouseDownEvent, phase, window, cx| {
                                    if phase == gpui::DispatchPhase::Capture {
                                        if bounds.contains(&event.position) {
                                            if matches!(
                                                event.button,
                                                MouseButton::Left | MouseButton::Right
                                            ) {
                                                // 终端拥有独立网格选区：抑制 Root 的窗口级 TextSelectionLayer 拖选，
                                                // 并清除窗口其他区域（侧栏/状态栏）的旧选区，防止跨区误选与 Cmd+C 截胡。
                                                gpui_base::GlobalState::suppress_text_selection(cx);
                                                gpui_base::TextSelection::clear(window, cx);
                                            }
                                        } else if event.button == MouseButton::Left {
                                            // 点击在终端画布外（如状态栏/侧栏/顶栏）时清除终端选区，保持全窗单一选区。
                                            term_for_down.update(cx, |v, cx| {
                                                v.clear_selection(cx);
                                            });
                                        }
                                    }
                                },
                            );
                            window.on_mouse_event(
                                move |event: &gpui::ScrollWheelEvent, phase, _window, _cx| {
                                    if phase == gpui::DispatchPhase::Capture
                                        && bounds.contains(&event.position)
                                    {
                                        // 终端视口滚动独立自管，进入终端时复位外层滚轮锁存器。
                                        nested_scroll::reset_wheel_latch();
                                    }
                                },
                            );
                        },
                    )
                    .absolute()
                    .inset_0()
                    .size_full(),
                )
                .child(term_view),
        )
        .child(statusbar)
        .into_any_element()
}

/// 空态（对应原型 `BentoLaunchpad`）：四层 Bento 启动台架构（支持会话列表内层滚动 + 边缘穿透）。
fn empty_presets(
    state: &Entity<AppState>,
    narrow: bool,
    branch: Option<String>,
    worktree_files: Vec<jagent_core::git::WorktreeFile>,
    outer_scroll: gpui::ScrollHandle,
    sessions_scroll: gpui::ScrollHandle,
    cx: &mut Context<RootView>,
) -> AnyElement {
    let weak_settings = cx.entity().downgrade();
    let weak_changes = cx.entity().downgrade();
    empty_presets::empty_pane_with_context(
        state,
        narrow,
        empty_presets::LaunchpadContext {
            branch,
            worktree_files,
            on_open_settings: Rc::new(move |window, cx| {
                let _ = weak_settings.update(cx, |v, cx| {
                    v.settings_open = true;
                    v.ensure_settings_view(window, cx);
                    cx.notify();
                });
            }),
            on_open_changes: Rc::new(move |_, cx| {
                let _ = weak_changes.update(cx, |v, cx| v.open_panel_changes(cx));
            }),
            outer_scroll,
            sessions_scroll,
        },
        cx,
    )
}

pub fn apply_group_action(
    state: &Entity<AppState>,
    workspace_id: &str,
    action: GroupAction,
    cx: &mut App,
) {
    state.update(cx, |s, cx| {
        match action {
            GroupAction::Activate => {
                if s.threads.active() == &ActiveTarget::Workspace(workspace_id.to_owned()) {
                    s.threads.toggle_workspace_expanded(workspace_id);
                } else {
                    if let Some(w) = s
                        .threads
                        .workspaces
                        .iter_mut()
                        .find(|w| w.id == workspace_id)
                    {
                        w.expanded = true;
                    }
                    s.activate(ActiveTarget::Workspace(workspace_id.to_owned()), cx);
                    return;
                }
            }
            GroupAction::ToggleExpanded => s.threads.toggle_workspace_expanded(workspace_id),
            GroupAction::SetShowAll(show) => s.threads.set_workspace_show_all(workspace_id, show),
            GroupAction::SetPinned(pin) => s.threads.set_workspace_pinned(workspace_id, pin),
            GroupAction::Rename => {} // 在视图层拦截（rename::open_workspace）
            GroupAction::NewSession { .. } => {} // 在视图层拦截（new_session::trigger_plus_or_open）
            GroupAction::Remove => {
                s.threads.remove_workspace(workspace_id);
                cx.notify();
                return;
            }
        }
        s.flush(cx);
        cx.emit(StateChanged);
        cx.notify();
    });
}

fn cycle_thread(root: &Entity<RootView>, direction: i32, cx: &mut App) {
    root.update(cx, |view, cx| {
        view.settings_open = false;
        view.state.update(cx, |s, cx| {
            s.threads.cycle(direction);
            s.flush(cx);
            cx.emit(StateChanged);
        });
        cx.notify();
    });
}

#[cfg(test)]
mod cycle_action_tests {
    use super::*;

    #[gpui::test]
    fn cycling_from_settings_returns_to_the_selected_conversation(cx: &mut gpui::TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        let root = cx.update(|cx| {
            let state = crate::state::init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let workspace = state.read(cx).workspaces()[0].id.clone();
            let _ = state.update(cx, |s, cx| s.create_chat(Some(&workspace), cx).unwrap());
            let split = cx.new(|_| ResizableState::default());
            let work_split = cx.new(|_| ResizableState::default());
            cx.new(|cx| RootView {
                state,
                focus_handle: cx.focus_handle(),
                terminal: None,
                _terminal_link_sub: None,
                conversation: None,
                settings_open: true,
                settings_view: None,
                git_view: None,
                sidebar_width: 260.0,
                split,
                sidebar_open: true,
                sidebar_mode: SidebarMode::Agent,
                sidebar_edit_panel: None,
                was_narrow: false,
                panel_open: false,
                panel_width: sizes::PANEL_WIDTH,
                work_split,
                panel: None,
                branch: None,
                worktree_files: Vec::new(),
                branch_cwd: String::new(),
                branch_generation: 0,
                open_menu: None,
                add_popover_open: false,
                overflow_popover_open: false,
                file_surface_mode: FileSurfaceMode::Source,
                file_surface: crate::views::file_surface::FileSurfaceController::default(),
                bento_outer_scroll: gpui::ScrollHandle::new(),
                bento_sessions_scroll: gpui::ScrollHandle::new(),
                file_surface_scroll: gpui::ScrollHandle::new(),
                file_surface_last_key: (String::new(), FileSurfaceMode::Source),
                file_surface_target_line: None,
                pending_file_scroll_y: Rc::new(std::cell::Cell::new(None)),
                perf_tracker: PerfTracker::default(),
            })
        });
        cx.update(|cx| cycle_thread(&root, 1, cx));
        cx.update(|cx| {
            assert!(
                !root.read(cx).settings_open,
                "cycle action closes settings surface"
            );
            assert!(
                root.read(cx)
                    .state
                    .read(cx)
                    .threads
                    .active_thread_id()
                    .is_some()
            );
        });
    }
}

/// 非重命名的行菜单动作。不需要窗口，单独成函数，便于 `#[gpui::test]` 直接驱动。
pub fn apply_row_action(
    state: &Entity<AppState>,
    thread_id: &str,
    action: RowAction,
    cx: &mut App,
) {
    state.update(cx, |s, cx| {
        match action {
            RowAction::Rename => {}
            RowAction::SetPinned(pin) => s.threads.set_thread_pinned(thread_id, pin),
            RowAction::SetUnread(unread) => s.threads.set_thread_unread(thread_id, unread),
            RowAction::Remove => {
                // Dispose now even if the ACP turn is still connecting and ThreadStore has not marked it connected yet.
                s.close_thread(thread_id, cx);
                cx.notify();
                return;
            }
        }
        s.flush(cx);
        cx.emit(StateChanged);
        cx.notify();
    });
}

/// 侧栏宽度默认值，供装配层引用。
pub const DEFAULT_SIDEBAR_WIDTH: f32 = sizes::SIDEBAR_WIDTH;

/// 窄屏断点（视口宽度 < 此值 时侧栏改为抽屉）。与旧 AgentPlane 一致。
pub const NARROW_BREAKPOINT: f32 = 760.0;

pub fn is_narrow(viewport_width: f32) -> bool {
    viewport_width < NARROW_BREAKPOINT
}

/// 工作面板右栏转浮层的断点（原型 `PANEL_OVERLAY_W = 1100`，严格小于）。
pub fn is_panel_overlay(viewport_width: f32) -> bool {
    viewport_width < sizes::PANEL_OVERLAY_WIDTH
}

/// 视图层的「现在」（毫秒）——只用于通知相对时间的定格展示，不是业务副作用。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// <1100 时工作面板的浮层形态（原型 `#work-panel.overlay`：右缘 absolute +
/// `min(panelWidth, min(420, winW))` + 向左投影 `-12px 0 32px rgba(0,0,0,.35)`）。
fn panel_overlay_el(panel: AnyElement, panel_width: f32, viewport_w: f32) -> AnyElement {
    let w = panel_width.min(420.0).min(viewport_w);
    div()
        .absolute()
        .top_0()
        .right_0()
        .bottom_0()
        .w(px(w))
        .shadow(vec![
            BoxShadow::new(px(-12.0), px(0.0), gpui::hsla(0.0, 0.0, 0.0, 0.35))
                .blur_radius(px(32.0)),
        ])
        .child(panel)
        .into_any_element()
}

/// macOS 左上角原生红绿灯让位宽度（非全屏时由位于窗口左上角的顶栏承担）。
pub const MACOS_TRAFFIC_LIGHT_PADDING: f32 = 74.0;

/// 计算左悬浮导航岛顶栏（`#sidebar-header`）的左内边距：
/// - macOS 非全屏时，左岛位于窗口左上角，预留 74px 给原生红绿灯；
/// - macOS 全屏（红绿灯已收入屏幕顶部自动隐藏层）或非 macOS 平台时，恢复紧凑 10px 内边距。
pub fn sidebar_header_left_padding(is_macos: bool, is_fullscreen: bool) -> f32 {
    if is_macos && !is_fullscreen {
        MACOS_TRAFFIC_LIGHT_PADDING
    } else {
        10.0
    }
}

/// 计算右工作台画布岛顶栏（`#title-bar`）的左内边距：
/// - macOS 非全屏且左侧栏不可见（窄屏或宽屏侧栏已收起）时，右岛接替窗口左上角，预留 74px 给原生红绿灯；
/// - 其余情况（侧栏已在左岛让位、处于全屏态、或非 macOS 平台）返回 0px，由首个子控件自带边距控制。
pub fn workbench_header_left_padding(
    is_macos: bool,
    is_fullscreen: bool,
    sidebar_visible_on_left: bool,
) -> f32 {
    if is_macos && !is_fullscreen && !sidebar_visible_on_left {
        MACOS_TRAFFIC_LIGHT_PADDING
    } else {
        0.0
    }
}

/// 顶栏拖拽与双击缩放状态机：
/// 确保只有连续两次点击都落在顶栏空白区域时才触发双击缩放，
/// 杜绝「点击顶栏按钮穿透触发双击」或「第 1 击点在关闭/收起按钮上、按钮消失后第 2 击落空携带 OS click_count=2 误触发双击」。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct TitleBarDragState {
    pub should_move: bool,
    pub armed_first_click: bool,
}

impl TitleBarDragState {
    pub fn on_blank_left_down(&mut self, click_count: usize) {
        self.should_move = true;
        if click_count == 1 {
            self.armed_first_click = true;
        }
    }

    pub fn disarm_move(&mut self) {
        self.should_move = false;
    }

    pub fn reset(&mut self) {
        self.should_move = false;
        self.armed_first_click = false;
    }

    pub fn take_move_on_drag(&mut self) -> bool {
        if self.should_move {
            self.should_move = false;
            self.armed_first_click = false;
            true
        } else {
            false
        }
    }

    pub fn consume_double_click(&mut self, click_count: usize) -> bool {
        if click_count == 2 && self.armed_first_click {
            self.armed_first_click = false;
            true
        } else {
            if click_count >= 2 {
                self.armed_first_click = false;
            }
            false
        }
    }
}

impl Render for TitleBarDragState {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

/// 顶栏内可交互子控件（按钮、Tab、面包屑、下拉触发器等）统一调用：
/// - `.occlude()` 设 `HitboxBehavior::BlockMouse`，使鼠标悬停在按钮上时外层顶栏 `is_hovered` 为 `false`（同时阻断 Windows `HTCAPTION` 抢占）；
/// - `.on_mouse_down(Left)` 截断向顶栏根容器冒泡，防止点按钮触发 `should_move` 拖拽或 `armed_first_click` 双击计数。
pub(crate) fn stop_titlebar_drag(el: gpui::Stateful<gpui::Div>) -> gpui::Stateful<gpui::Div> {
    el.occlude().on_mouse_down(MouseButton::Left, |_, _, cx| {
        cx.stop_propagation();
    })
}

/// 为顶栏容器绑定空白处窗口拖拽与双击缩放（macOS 走 `titlebar_double_click`，其余平台走 `zoom_window`）。
pub(crate) fn bind_titlebar_drag(
    el: gpui::Stateful<gpui::Div>,
    state_key: &'static str,
    window: &mut Window,
    cx: &mut App,
) -> gpui::Stateful<gpui::Div> {
    let drag_state = window.use_keyed_state(state_key, cx, |_, _| TitleBarDragState::default());
    el.window_control_area(gpui::WindowControlArea::Drag)
        .on_mouse_down_out(window.listener_for(&drag_state, |state, _, _, _| {
            state.reset();
        }))
        .on_mouse_up_out(
            MouseButton::Left,
            window.listener_for(&drag_state, |state, _, _, _| {
                state.reset();
            }),
        )
        .on_mouse_down(
            MouseButton::Left,
            window.listener_for(&drag_state, |state, ev: &MouseDownEvent, _, _| {
                state.on_blank_left_down(ev.click_count);
            }),
        )
        .on_mouse_up(
            MouseButton::Left,
            window.listener_for(&drag_state, |state, _, _, _| {
                state.disarm_move();
            }),
        )
        .on_mouse_move(window.listener_for(&drag_state, |state, _, window, _| {
            if state.take_move_on_drag() {
                window.start_window_move();
            }
        }))
        .on_click(
            window.listener_for(&drag_state, |state, ev: &gpui::ClickEvent, window, _| {
                if state.consume_double_click(ev.click_count()) {
                    #[cfg(target_os = "macos")]
                    window.titlebar_double_click();
                    #[cfg(not(target_os = "macos"))]
                    window.zoom_window();
                }
            }),
        )
}

/// 右上角窗口控制三键（最小化 / 最大化 / 关闭）：
/// - `.occlude()` 设 `HitboxBehavior::BlockMouse`，遮挡外层 `#title-bar` 的 `WindowControlArea::Drag`
///   并使外层顶栏 `is_hovered` 为 `false`（触发 `on_mouse_down_out` 重置拖拽/双击计数）；
/// - Windows 走 `WindowControlArea::{Min, Max, Close}`（Win32 `WM_NCHITTEST` → `WM_NCLBUTTONDOWN/UP`）：
///   **绝不可**在 Windows 按钮上注册调用 `cx.stop_propagation()` 的 `on_mouse_down`，否则
///   `gpui-pre-windows::handle_nc_mouse_down_msg` 见到 `!func(input).propagate` 会提前 `return Some(0)`，
///   跳过 `nc_button_pressed.set(Some(HTMINBUTTON/HTMAXBUTTON/HTCLOSE))`，导致三键点击无响应；
/// - 圆角画布岛模式（`rounded_top_right == true`）下，最右侧关闭按钮设置 `.rounded_tr(ISLAND_RADIUS - 1.0)`，
///   防止 GPUI 矩形 `overflow_hidden` 下关闭按钮 hover 红色背景超出画布岛右上圆角边框。
fn window_controls_bar(window: &Window, rounded_top_right: bool) -> AnyElement {
    if cfg!(target_os = "macos") || cfg!(target_family = "wasm") {
        return div().id("window-controls").into_any_element();
    }
    #[cfg(target_os = "linux")]
    if !matches!(
        window.window_decorations(),
        gpui::Decorations::Client { .. }
    ) {
        return div().id("window-controls").into_any_element();
    }
    let supported = window.window_controls();
    let is_windows = cfg!(target_os = "windows");
    let is_linux = cfg!(target_os = "linux");
    let is_fullscreen = window.is_fullscreen();
    let is_zoomed = window.is_maximized() || is_fullscreen;

    let make_btn = |id: &'static str,
                    ic: IconName,
                    area: gpui::WindowControlArea,
                    is_close: bool,
                    action: fn(&mut Window)| {
        div()
            .id(id)
            .debug_selector(move || id.to_string())
            .group(id)
            .occlude()
            .flex()
            .w(px(36.0))
            .h_full()
            .flex_shrink_0()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .when(is_close && rounded_top_right, |d| {
                d.rounded_tr(px(sizes::ISLAND_RADIUS - 1.0))
            })
            .hover(move |s| {
                if is_close {
                    s.bg(hex(colors::BELL)).text_color(hex(colors::TEXT_BRIGHT))
                } else {
                    s.bg(hex(colors::SURFACE))
                        .text_color(hex(colors::TEXT_BRIGHT))
                }
            })
            .active(move |s| {
                if is_close {
                    s.bg(hex(colors::BELL).opacity(0.8))
                        .text_color(hex(colors::TEXT_BRIGHT))
                } else {
                    s.bg(hex(colors::SURFACE_ACTIVE))
                        .text_color(hex(colors::TEXT_BRIGHT))
                }
            })
            .when(is_windows, move |d| d.window_control_area(area))
            .when(is_linux || (is_windows && is_fullscreen), move |d| {
                d.on_mouse_down(MouseButton::Left, |_, window, cx| {
                    window.prevent_default();
                    cx.stop_propagation();
                })
                .on_click(move |_, w, cx| {
                    cx.stop_propagation();
                    action(w);
                })
            })
            .child(
                icon(ic, 12.5, hex(colors::TEXT))
                    .group_hover(id, |s| s.text_color(hex(colors::TEXT_BRIGHT))),
            )
    };

    h_flex()
        .id("window-controls")
        .items_center()
        .flex_shrink_0()
        .h_full()
        .when(supported.minimize, |d| {
            d.child(make_btn(
                "window-btn-minimize",
                IconName::Minimize,
                gpui::WindowControlArea::Min,
                false,
                |w| w.minimize_window(),
            ))
        })
        .when(supported.maximize, |d| {
            d.child(make_btn(
                "window-btn-maximize",
                if is_zoomed {
                    IconName::Restore
                } else {
                    IconName::Maximize
                },
                gpui::WindowControlArea::Max,
                false,
                |w| {
                    if w.is_fullscreen() {
                        w.toggle_fullscreen();
                    } else {
                        w.zoom_window();
                    }
                },
            ))
        })
        .child(make_btn(
            "window-btn-close",
            IconName::Close,
            gpui::WindowControlArea::Close,
            true,
            |w| w.remove_window(),
        ))
        .into_any_element()
}

/// 顶栏方钮（原型 `.tb-cell.tb-icon-btn`：28×28 r8 / margin 0 2；hover = surface +
/// 亮字；on 态 = surfaceActive + 亮字）。
#[allow(clippy::too_many_arguments)]
fn tb_icon_btn(
    id: &'static str,
    ic: IconName,
    icon_size: f32,
    on: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    stop_titlebar_drag(
        div()
            .id(id)
            .flex()
            .items_center()
            .justify_center()
            .size(px(28.0))
            .rounded(px(8.0))
            .flex_shrink_0()
            .ml(px(2.0))
            .mr(px(2.0))
            .cursor_pointer()
            .when_else(
                on,
                |d| d.bg(hex(colors::SURFACE_ACTIVE)),
                |d| d.hover(|h| h.bg(hex(colors::SURFACE))),
            )
            .child(icon(
                ic,
                icon_size,
                if on {
                    hex(colors::TEXT_BRIGHT)
                } else {
                    hex(colors::MUTED)
                },
            ))
            .on_click(move |e, w, cx| on_click(e, w, cx)),
    )
}

/// 顶栏菜单项动作回调（打开 Git 图 / 开工作面板等）。
type MenuFn = Rc<dyn Fn(&mut Window, &mut App)>;

/// 分支钮 + Git 菜单浮层（原型 `BranchButton` + `DropMenu`：点击 →
/// 「打开 Git 图（Ctrl-Shift-G）/ 查看变更（工作面板）」，side bottom / align start / offset 4）。
/// V5 起走统一浮层（`popup::menu_popover`），壳 / 菜单项 / 点外关闭 / Esc 一处定义。
fn branch_menu(
    branch: String,
    git_state: &Entity<AppState>,
    cx: &mut Context<RootView>,
) -> impl IntoElement {
    let git_state = git_state.clone();
    let weak_root = cx.entity().downgrade();
    let state_for_graph = git_state.clone();
    let open_graph: MenuFn =
        Rc::new(move |window, cx| git_graph::open(state_for_graph.clone(), window, cx));
    let weak = weak_root.clone();
    let open_changes: MenuFn = Rc::new(move |_, cx| {
        let _ = weak.update(cx, |v, cx| v.open_panel_changes(cx));
    });
    menu_popover(
        "git-branch-menu",
        vec![
            MenuEntry::item("graph", "打开 Git 提交图谱（Ctrl-Shift-G）"),
            MenuEntry::item("changes", "查看工作区变更（右侧面板）"),
        ],
        move |id, window, cx| match id {
            "graph" => open_graph(window, cx),
            "changes" => open_changes(window, cx),
            _ => {}
        },
        move |open| branch_trigger(&branch, open).into_any_element(),
    )
}

/// AddPopover 的文件行（原型 `.sa-file`：两行 basename 12 text / 全路径
/// 11 mono muted，p 5 8 / r5 / hover surface，单行省略三件套）。
fn sa_file_row(
    f: &jagent_core::git::WorktreeFile,
    on_pick: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let name = f.path.rsplit('/').next().unwrap_or(&f.path).to_owned();
    div()
        .id(gpui::ElementId::Name(f.path.clone().into()))
        .flex()
        .flex_col()
        .gap(px(1.0))
        .pt(px(5.0))
        .pb(px(5.0))
        .pl(px(8.0))
        .pr(px(8.0))
        .rounded(px(5.0))
        .cursor_pointer()
        .hover(|h| h.bg(hex(colors::SURFACE)))
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_size(px(12.0))
                .text_color(hex(colors::TEXT))
                .child(name),
        )
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_size(px(11.0))
                .font_family("monospace")
                .text_color(hex(colors::MUTED))
                .child(f.path.clone()),
        )
        .on_click(move |_, window, cx| {
            cx.stop_propagation();
            on_pick(window, cx);
        })
}

/// 侧栏/工作面板分隔条把手绘制（原型 `.sb-resize`/`.wp-resize` :hover：
/// 6px 把手带填充 `rgba(97,175,239,.25)`；拖拽中保持点亮。
/// 命中区 / 光标 / 拖拽逻辑在 resizable 组件内，这里只画可见部分。
fn accent_handle() -> ResizeHandleRenderer {
    Rc::new(|ctx: &ResizeHandleContext, _, _| {
        let lit = matches!(
            ctx.state(),
            ResizeHandleState::Hovered | ResizeHandleState::Pressed | ResizeHandleState::Dragging
        );
        Some(
            div()
                .size_full()
                .when(lit, |d| d.bg(accent_alpha(0.35)))
                .into_any_element(),
        )
    })
}

/// 分支钮本体（原型 `.tb-branch-btn`：h28 min-w28 max-w220 / p0 7 / r8 /
/// tile 底 + borderSubtle 边；hover = surface + 边框提亮；浮层开着时保持
/// 提亮（Radix data-state=open 视觉等价）——mono 分支名 12px）。
fn branch_trigger(branch: &str, open: bool) -> impl IntoElement {
    h_flex()
        .id("tb-branch-btn")
        .h(px(28.0))
        .min_w(px(28.0))
        .max_w(px(220.0))
        .pl(px(7.0))
        .pr(px(7.0))
        .gap(px(5.0))
        .items_center()
        .flex_shrink_0()
        .ml(px(2.0))
        .mr(px(2.0))
        .rounded(px(8.0))
        .when_else(
            open,
            |d| {
                d.bg(hex(colors::SURFACE))
                    .border_1()
                    .border_color(hex(colors::EXITED))
            },
            |d| {
                d.bg(hex(colors::TILE))
                    .border_1()
                    .border_color(hex(colors::BORDER_SUBTLE))
                    .hover(|h| h.bg(hex(colors::SURFACE)).border_color(hex(colors::EXITED)))
            },
        )
        .cursor_pointer()
        .child(icon(IconName::GitBranch, 13.5, hex(colors::ACCENT_HOVER)))
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .font_family("monospace")
                .text_size(px(12.0))
                .text_color(hex(colors::TEXT))
                .child(branch.to_owned()),
        )
        .child(icon(IconName::ChevronDown, 12.0, hex(colors::MUTED)))
}

/// 拖动结束后把侧栏宽度写回 `appearance.sidebarWidth`（越界值由 core 容错回默认，这里不再钳位）。
pub fn persist_sidebar_width(state: &Entity<AppState>, width: f32, cx: &mut App) {
    let w = width.round() as i64;
    state.update(cx, |s, cx| {
        s.settings
            .patch("appearance.sidebarWidth", serde_json::json!(w));
        s.flush(cx);
    });
}

/// CSS `cubic-bezier(x1,y1,x2,y2)` timing function 的数值解（二分 24 次
/// 解 `x(u)=delta` 再回代 `y(u)`）。抽屉动画照抄原型过渡曲线
/// `cubic-bezier(.2,.8,.2,1)`（index.css 唯一的 UI 贝塞尔，ws-collapse 用）。
fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32, delta: f32) -> f32 {
    let bez = |t: f32, a: f32, b: f32| -> f32 {
        3.0 * a * (1.0 - t) * (1.0 - t) * t + 3.0 * b * (1.0 - t) * t * t + t * t * t
    };
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    for _ in 0..24 {
        let mid = 0.5 * (lo + hi);
        if bez(mid, x1, x2) < delta {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    bez(0.5 * (lo + hi), y1, y2)
}

/// 抽屉滑入缓动（原型 cubic-bezier(.2,.8,.2,1)：快出慢收）。
/// 端点恒等：数值求解在边界有 f32 残留，动画起止帧需要精确 0/1。
fn drawer_ease(delta: f32) -> f32 {
    if delta <= 0.0 {
        return 0.0;
    }
    if delta >= 1.0 {
        return 1.0;
    }
    cubic_bezier(0.2, 0.8, 0.2, 1.0, delta)
}

/// 窄屏布局：主面全宽；侧栏作为左侧覆盖层抽屉，带遮罩。点遮罩关闭。
/// 工作面板（<1100 必然浮层形态）作为右缘 absolute 层，画在主面之上。
///
/// 滑入动画（V5）：原型 `#drawer-scrim`/`#drawer-panel` 本身无 transition
/// （条件渲染直挂直卸），本层按原型动画语言补 200ms
/// `cubic-bezier(.2,.8,.2,1)` 滑入 + 遮罩淡入；关闭侧保持原型直接卸载
/// （无退出动画）。`with_animation` 尊重系统 reduce-motion（直达终态）。
fn narrow_body(
    sidebar: Sidebar,
    body: AnyElement,
    open: bool,
    width: f32,
    panel: Option<AnyElement>,
    cx: &mut Context<RootView>,
) -> AnyElement {
    let backdrop = div()
        .absolute()
        .inset_0()
        // 原型 #drawer-scrim：rgba(0,0,0,.6)
        .bg(hsla(0.0, 0.0, 0.0, 0.6))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, _: &MouseDownEvent, _, cx| {
                this.sidebar_open = false;
                this.open_menu = None;
                cx.notify();
            }),
        )
        .with_animation(
            "drawer-scrim-fade",
            gpui::Animation::new(std::time::Duration::from_millis(180)),
            |el, t| el.opacity(t.clamp(0.0, 1.0)),
        );
    let drawer = div()
        .absolute()
        .top_0()
        .bottom_0()
        .left_0()
        .w(px(width))
        // 原型 #drawer-panel：box-shadow 8px 0 32px rgba(0,0,0,.4)
        .shadow(vec![
            BoxShadow::new(px(8.0), px(0.0), hsla(0.0, 0.0, 0.0, 0.4)).blur_radius(px(32.0)),
        ])
        .child(sidebar)
        .with_animation(
            "drawer-slide-in",
            gpui::Animation::new(std::time::Duration::from_millis(200)).with_easing(drawer_ease),
            move |el, t| el.left(px(-width * (1.0 - t.clamp(0.0, 1.0)))),
        );
    div()
        .relative()
        .flex_1()
        .min_h_0()
        .size_full()
        .child(body)
        .when_some(panel, |d, p| d.child(p))
        .when(open, |d| d.child(backdrop).child(drawer))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use gpui::TestAppContext;

    use super::*;
    use crate::state::init;

    #[gpui::test]
    fn dragging_the_divider_persists_the_sidebar_width_and_survives_a_reload(
        cx: &mut TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        cx.update(|cx| {
            let state = init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            persist_sidebar_width(&state, 312.4, cx);
            assert_eq!(state.read(cx).settings.get().appearance.sidebar_width, 312);
            // 越界值由 core 容错回默认（不在视图钳位）
            persist_sidebar_width(&state, 9000.0, cx);
            assert_eq!(
                state.read(cx).settings.get().appearance.sidebar_width,
                264,
                "越界回默认"
            );
            persist_sidebar_width(&state, 300.0, cx);
        });
        let raw = std::fs::read_to_string(dir.path().join("settings.json")).expect("落盘");
        assert!(
            raw.contains("\"sidebarWidth\": 300") || raw.contains("\"sidebarWidth\":300"),
            "{raw}"
        );
    }

    #[test]
    fn narrow_switch_is_strict_below_the_breakpoint() {
        assert!(is_narrow(759.9));
        assert!(!is_narrow(760.0), "正好 760 不算窄");
        assert!(!is_narrow(1280.0));
    }

    /// 抽屉滑入缓动 = 原型 cubic-bezier(.2,.8,.2,1)：端点恒等、
    /// 先快后慢（中点高于线性）、全程单调；求解器对线性曲线退化自检。
    #[test]
    fn drawer_easing_matches_the_css_cubic_bezier() {
        assert_eq!(drawer_ease(0.0), 0.0);
        assert_eq!(drawer_ease(1.0), 1.0);
        assert!(drawer_ease(0.5) > 0.5, "ease-out 型曲线中点大于线性");
        let mut prev = -0.001;
        for i in 0..=20 {
            let v = drawer_ease(i as f32 / 20.0);
            assert!(v >= prev, "缓动单调不回退：{v} < {prev}");
            prev = v;
        }
        // 求解器自检：control 点落在对角线上时退化为恒等
        for t in [0.0f32, 0.25, 0.5, 0.75, 1.0] {
            let v = cubic_bezier(0.0, 0.0, 1.0, 1.0, t);
            assert!((v - t).abs() < 1e-3, "线性退化：{v} != {t}");
        }
    }

    /// 侧栏菜单是受控浮层：唯一开合态挂在 RootView 上；选中会话 /
    /// 切换侧栏时清空（锚点随行卸载，防残留态在下次挂载时弹出）。
    #[gpui::test]
    fn selecting_a_thread_or_toggling_the_sidebar_closes_the_open_menu(cx: &mut TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        let (state, root) = cx.update(|cx| {
            let state = init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let root = cx.new(|cx| RootView::new(state.clone(), cx));
            (state, root)
        });
        cx.run_until_parked();
        let (ws, id) = cx.update(|cx| {
            state.update(cx, |s, cx| {
                let ws = s.workspaces()[0].id.clone();
                let id = s.create_chat(Some(&ws), cx).unwrap();
                (ws, id)
            })
        });
        cx.update(|cx| {
            root.update(cx, |v, cx| {
                v.open_menu = Some(MenuTarget::Row("some-row".into()));
                v.select(&id, cx);
                assert_eq!(v.open_menu, None, "选中会话关闭行菜单");

                v.open_menu = Some(MenuTarget::Workspace(ws));
                v.select(&id, cx);
                assert_eq!(v.open_menu, None, "选中会话关闭工作区菜单");
            });
        });
    }

    #[test]
    fn panel_overlay_switch_is_strict_below_1100() {
        assert!(is_panel_overlay(1099.9), "窄于 1100 → 右栏浮层");
        assert!(!is_panel_overlay(1100.0), "正好 1100 仍是停靠右栏");
        assert!(!is_panel_overlay(1440.0));
        // 窄屏（<760）必然也命中浮层（原型 PANEL_OVERLAY_W > NARROW_BP）
        assert!(is_panel_overlay(700.0) && is_narrow(700.0));
    }

    #[gpui::test]
    fn branch_query_resolves_the_repo_head_branch_async(cx: &mut TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(&repo)
                    .env("GIT_AUTHOR_NAME", "t")
                    .env("GIT_AUTHOR_EMAIL", "t@t")
                    .env("GIT_COMMITTER_NAME", "t")
                    .env("GIT_COMMITTER_EMAIL", "t@t")
                    .status()
                    .unwrap()
                    .success(),
                "git {args:?}"
            );
        };
        git(&["init", "-q", "-b", "feature/v2"]);
        git(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ]);
        let state = cx.update(|cx| {
            init(
                cx,
                dir.path().to_path_buf(),
                repo.to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let root = cx.update(|cx| cx.new(|cx| RootView::new(state, cx)));
        // 初始为 None（查询在途），park 后拿到 HEAD 分支名
        assert_eq!(cx.update(|cx| root.read(cx).branch.clone()), None);
        cx.run_until_parked();
        assert_eq!(
            cx.update(|cx| root.read(cx).branch.clone()),
            Some("feature/v2".to_owned())
        );
    }

    /// AddPopover「打开文件」：开面板、切文件页并带上选中路径（show_file）。
    #[gpui::test]
    fn opening_a_file_from_the_add_popover_switches_the_panel_to_the_files_tab(
        cx: &mut TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let state = cx.update(|cx| {
            init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let root = cx.update(|cx| cx.new(|cx| RootView::new(state, cx)));
        cx.run_until_parked();
        cx.update(|cx| {
            root.update(cx, |v, cx| {
                v.open_panel_file("src/main.rs", cx);
                assert!(v.panel_open && v.panel.is_some(), "开面板");
                let panel = v.panel.clone().unwrap();
                assert_eq!(
                    panel.read(cx).tab(),
                    crate::views::work_panel::WorkPanelTab::Files,
                    "切到文件页"
                );
            });
        });
    }

    #[gpui::test]
    fn opening_the_panel_creates_the_entity_once_and_toggles_state(cx: &mut TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        let state = cx.update(|cx| {
            init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let root = cx.update(|cx| cx.new(|cx| RootView::new(state, cx)));
        cx.run_until_parked();
        cx.update(|cx| {
            root.update(cx, |v, cx| {
                assert!(v.panel.is_none(), "默认不开面板");
                v.open_panel_changes(cx);
                assert!(v.panel_open && v.panel.is_some(), "首开建实体");
                let first = v.panel.clone().unwrap();
                v.panel_open = false;
                v.open_panel_changes(cx);
                assert_eq!(
                    v.panel.clone().unwrap().entity_id(),
                    first.entity_id(),
                    "关开之间复用同一面板（tab/选中态不丢）"
                );
                // 面板内部 tab 已切到变更页
                let tab = v.panel.clone().unwrap().read(cx).tab();
                assert_eq!(tab, crate::views::work_panel::WorkPanelTab::Changes);
            });
        });
    }

    #[gpui::test]
    fn notif_actions_reach_the_core_notice_store(cx: &mut TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        let state = cx.update(|cx| {
            init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        cx.update(|cx| {
            // BEL 只对「后台会话」落通知（core 规则）：spawn a 后再 spawn b，
            // a 退居后台，此时 BEL → 未读通知 + has_bell
            let a = state.update(cx, |s, cx| {
                let ws = s.workspaces()[0].id.clone();
                s.spawn_from_preset("shell", Some(&ws), cx).unwrap()
            });
            let _b = state.update(cx, |s, cx| {
                let ws = s.workspaces()[0].id.clone();
                s.spawn_from_preset("shell", Some(&ws), cx).unwrap()
            });
            let sid = state
                .read(cx)
                .threads
                .thread(&a)
                .unwrap()
                .as_terminal()
                .unwrap()
                .session_id;
            state.update(cx, |s, cx| {
                s.on_terminal_event(&jagent_terminal::SessionEvent::Bell { id: sid }, cx);
                cx.emit(StateChanged);
            });
            assert_eq!(state.read(cx).threads.unread_notice_count(), 1);
            let models =
                crate::views::notif_center::notif_models(&state.read(cx).threads.notices, 1);
            assert_eq!(models.len(), 1);
            assert_eq!(models[0].tone, jagent_core::threads::NoticeTone::Warn);
            // 「全部已读」走 core：红点清零、条目保留
            state.update(cx, |s, cx| {
                s.threads.mark_notices_read();
                s.flush(cx);
            });
            assert_eq!(state.read(cx).threads.unread_notice_count(), 0);
            assert_eq!(state.read(cx).threads.notices.len(), 1);
            // 点条目：core open_notice 跳转来源会话
            let nid = state.read(cx).threads.notices[0].id.clone();
            state.update(cx, |s, cx| {
                s.threads.open_notice(&nid);
                s.flush(cx);
            });
            assert_eq!(
                state.read(cx).threads.active(),
                &jagent_core::threads::ActiveTarget::Thread(a.clone())
            );
            state.update(cx, |s, cx| {
                s.close_thread(&a, cx);
                s.close_thread(&_b, cx);
            });
        });
    }

    #[gpui::test]
    fn row_menu_pin_mark_and_remove_reach_the_store(cx: &mut TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        cx.update(|cx| {
            let state = init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let (ws, id) = state.update(cx, |s, cx| {
                let ws = s.workspaces()[0].id.clone();
                let id = s.create_chat(Some(&ws), cx).unwrap();
                (ws, id)
            });
            apply_row_action(&state, &id, RowAction::SetPinned(true), cx);
            assert!(
                state.read(cx).threads.thread(&id).unwrap().common().pin,
                "置顶写入 store"
            );
            apply_row_action(&state, &id, RowAction::SetUnread(true), cx);
            assert!(
                state.read(cx).threads.thread(&id).unwrap().common().unread,
                "标记未读写入 store"
            );
            // 原型是切换语义：已读行菜单显示「标记为未读」
            apply_row_action(&state, &id, RowAction::SetUnread(false), cx);
            assert!(
                !state.read(cx).threads.thread(&id).unwrap().common().unread,
                "标记已读写入 store"
            );
            apply_row_action(&state, &id, RowAction::Remove, cx);
            assert!(state.read(cx).threads.thread(&id).is_none(), "移除会话");
            assert!(
                state
                    .read(cx)
                    .threads
                    .threads
                    .iter()
                    .all(|thread| thread.id() != id),
                "removed thread is absent from every workspace sidebar projection"
            );
            assert!(
                state.read(cx).workspaces().iter().any(|w| w.id == ws),
                "移除会话不删工作区"
            );
        });
    }

    /// 终端文件路径 Zed 风格 Cmd/Ctrl 悬停探测 + Cmd/Ctrl+Click 打开顶栏 FileSurface 预览并定位行号。
    #[gpui::test]
    fn terminal_cmd_click_file_path_opens_topbar_file_surface_at_target_line(
        cx: &mut TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let src_dir = dir.path().join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        let target_file = src_dir.join("main.rs");
        let mut file_body = String::new();
        for i in 1..=120 {
            file_body.push_str(&format!("fn line_{i}() {{}}\n"));
        }
        std::fs::write(&target_file, &file_body).unwrap();

        let (state, thread_id, model) = cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::install(cx).unwrap();
            crate::actions::install(cx, &jagent_core::settings::Settings::default());
            let state = init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let ws = state.read(cx).workspaces()[0].id.clone();
            let tid = state.update(cx, |s, cx| {
                s.spawn_from_preset("shell", Some(&ws), cx).unwrap()
            });
            let sid = state
                .read(cx)
                .threads
                .thread(&tid)
                .unwrap()
                .as_terminal()
                .unwrap()
                .session_id;
            let model = cx
                .global::<jagent_terminal::TerminalPool>()
                .get(sid)
                .unwrap();
            // 立即关闭后台 PTY reader 线程并 join，用 feed_bytes 确定性注入测试输出，
            // 防止后台 OS 线程在 TestScheduler 运行期间异步唤醒导致非确定性断言。
            model.read(cx).shutdown();
            (state, tid, model)
        });

        let (root_win, cx) = cx.add_window_view(|window, cx| {
            let root_view = cx.new(|cx| RootView::new(state.clone(), cx));
            gpui_base::Root::new(root_view, window, cx)
        });
        cx.run_until_parked();

        // 取出 RootView 与挂载的 TerminalView；待首帧完成终端尺寸测量与 resize 后再写入测试输出
        let (root_view, term_view, link_pos) = cx.update(|window, cx| {
            let _ = window.draw(cx);
            let dir_path = dir.path().to_path_buf();
            model.update(cx, |m, _| {
                m.set_cwd(Some(dir_path));
                m.feed_bytes(b"\x1b[2J\x1b[Herror[E0001]: sample\r\n  --> src/main.rs:60:5\r\n");
            });
            let _ = window.draw(cx);
            let rv = root_win
                .read(cx)
                .view()
                .clone()
                .downcast::<RootView>()
                .unwrap();
            let tv = rv.read(cx).terminal.as_ref().unwrap().1.clone();
            let bounds = tv.read(cx).bounds();
            // padding=8px, TestTextSystem cell_height=12px → 第 1 行 (0-based row=1) rel_y 取 16px, 第 10 列 rel_x 取 80px
            let pos = gpui::point(
                bounds.origin.x + px(8.0 + 80.0),
                bounds.origin.y + px(8.0 + 16.0),
            );
            (rv, tv, pos)
        });

        let link_mods = if cfg!(target_os = "macos") {
            gpui::Modifiers {
                platform: true,
                ..Default::default()
            }
        } else {
            gpui::Modifiers {
                control: true,
                ..Default::default()
            }
        };

        // 1. 不按修饰键移动鼠标：Zed 风格不应激活 hovered_link
        cx.simulate_mouse_move(link_pos, None, gpui::Modifiers::default());
        cx.run_until_parked();
        cx.update(|window, cx| {
            let _ = window.draw(cx);
            assert!(
                term_view.read(cx).hovered_link().is_none(),
                "未按 Cmd/Ctrl 时普通鼠标悬停不应激活链接下划线"
            );
        });

        // 2. 按下 Cmd/Ctrl 修饰键（原地 ModifiersChangedEvent）：立即识别并激活链接下划线
        cx.simulate_event(gpui::ModifiersChangedEvent {
            modifiers: link_mods,
            capslock: gpui::Capslock::default(),
        });
        cx.run_until_parked();
        cx.update(|_, cx| {
            let hovered = term_view
                .read(cx)
                .hovered_link()
                .expect("按下 Cmd/Ctrl 后应识别出 src/main.rs:60:5");
            assert_eq!(
                hovered.target,
                jagent_terminal::TerminalLinkTarget::File {
                    path: target_file.clone(),
                    line: Some(60),
                    column: Some(5),
                }
            );
        });

        // 3. Cmd/Ctrl + Click 点击该路径：应在顶栏新增并激活 `file:src/main.rs` 副视图，切到完整源码并定位到第 60 行
        cx.simulate_mouse_down(link_pos, MouseButton::Left, link_mods);
        cx.simulate_mouse_up(link_pos, MouseButton::Left, link_mods);
        cx.run_until_parked();

        cx.update(|window, cx| {
            let _ = window.draw(cx);
            let active_vid = state
                .read(cx)
                .threads
                .thread(&thread_id)
                .unwrap()
                .common()
                .active_view_id
                .clone();
            assert_eq!(
                active_vid.as_deref(),
                Some("file:src/main.rs"),
                "Cmd/Ctrl+Click 应在顶栏激活 file:src/main.rs 副视图预览"
            );
            let rv = root_view.read(cx);
            assert_eq!(
                rv.file_surface_mode,
                FileSurfaceMode::Source,
                "带 :line 行号跳转时应自动切到完整源码模式"
            );
            assert_eq!(
                rv.file_surface_target_line("src/main.rs"),
                Some(60),
                "应记录并高亮第 60 行"
            );
            let scroll_y: f32 = rv.file_surface_scroll.offset().y.into();
            assert!(
                scroll_y < -500.0,
                "源码滚动句柄应自动向下滚动定位到目标行附近，实际 offset.y={scroll_y}"
            );
        });

        // 清理测试 PTY 会话，满足 PtySender Drop 纪律
        cx.update(|_, cx| {
            model.read(cx).shutdown();
        });
    }

    #[test]
    fn titlebar_left_padding_adapts_to_platform_fullscreen_and_sidebar_visibility() {
        // 1. 左岛 #sidebar-header：macOS 非全屏留 74px，全屏或非 macOS 恢复 10px
        assert_eq!(sidebar_header_left_padding(true, false), 74.0);
        assert_eq!(sidebar_header_left_padding(true, true), 10.0);
        assert_eq!(sidebar_header_left_padding(false, false), 10.0);
        assert_eq!(sidebar_header_left_padding(false, true), 10.0);

        // 2. 右岛 #title-bar：仅在 macOS 非全屏且左侧栏不可见（收起或窄屏）时接替 74px 红绿灯让位
        assert_eq!(workbench_header_left_padding(true, false, true), 0.0);
        assert_eq!(workbench_header_left_padding(true, false, false), 74.0);
        assert_eq!(workbench_header_left_padding(true, true, false), 0.0);
        assert_eq!(workbench_header_left_padding(false, false, false), 0.0);
    }

    #[test]
    fn titlebar_drag_state_requires_both_clicks_on_blank_area_to_zoom() {
        let mut s = TitleBarDragState::default();

        // 场景 1：在空白处正常双击（click_count=1 -> click_count=2）
        s.on_blank_left_down(1);
        assert!(s.should_move && s.armed_first_click);
        s.disarm_move();
        assert!(!s.consume_double_click(1));
        assert!(s.armed_first_click);

        s.on_blank_left_down(2);
        s.disarm_move();
        assert!(
            s.consume_double_click(2),
            "空白处连续两次点击应触发双击缩放"
        );
        assert!(!s.armed_first_click);

        // 场景 2：第 1 击点在按钮上（未进入 on_blank_left_down(1)），按钮消失后第 2 击落空携带 click_count=2
        s.reset();
        s.on_blank_left_down(2);
        s.disarm_move();
        assert!(
            !s.consume_double_click(2),
            "第 1 击点在按钮上时，第 2 击绝不能触发顶栏双击缩放"
        );

        // 场景 3：第 1 击在空白处，但随后拖拽移动了窗口 -> 取消双击预备态
        s.on_blank_left_down(1);
        assert!(s.take_move_on_drag());
        assert!(!s.should_move && !s.armed_first_click);
        s.on_blank_left_down(2);
        assert!(!s.consume_double_click(2));
    }

    #[test]
    fn perf_tracker_samples_frame_history_and_terminal_paint_metrics() {
        let mut tracker = PerfTracker::default();
        assert_eq!(tracker.history_ms.len(), 24);
        tracker.sample();
        assert_eq!(tracker.history_ms.len(), 24);
        assert!(tracker.p90_ms > 0.0 && tracker.max_ms >= tracker.p90_ms);
    }

    /// Windows 顶栏最小化 / 最大化 / 关闭三键回归测试：
    /// `gpui-pre-windows` 在 `handle_nc_mouse_down_msg` / `handle_nc_mouse_up_msg` 中先向 GPUI
    /// 派发 `MouseDown` / `MouseUp` 并检查 `if !func(input).propagate { return Some(0); }`。
    /// 若按钮调用了 `cx.stop_propagation()`，将导致 `nc_button_pressed` 永远无法置位、三键失灵。
    #[cfg(target_os = "windows")]
    #[gpui::test]
    fn windows_window_control_buttons_preserve_event_propagation_for_nc_handlers(
        cx: &mut TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let state = cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::install(cx).unwrap();
            crate::actions::install(cx, &jagent_core::settings::Settings::default());
            init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });

        let (_root_win, cx) = cx.add_window_view(|window, cx| {
            let root_view = cx.new(|cx| RootView::new(state.clone(), cx));
            gpui_base::Root::new(root_view, window, cx)
        });
        cx.run_until_parked();

        cx.update(|window, _| {
            // 仅触发绘制以记录 debug_selector bounds
            let _ = window;
        });
        cx.run_until_parked();

        for selector in [
            "window-btn-minimize",
            "window-btn-maximize",
            "window-btn-close",
        ] {
            let bounds = cx
                .debug_bounds(selector)
                .unwrap_or_else(|| panic!("{selector} 应在 Windows 顶栏渲染"));
            let center = bounds.center();

            cx.update(|window, cx| {
                let move_res = window.dispatch_event(
                    gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                        position: center,
                        pressed_button: None,
                        modifiers: gpui::Modifiers::default(),
                    }),
                    cx,
                );
                assert!(move_res.propagate, "{selector} MouseMove 不应阻断冒泡");

                let down_res = window.dispatch_event(
                    gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                        button: MouseButton::Left,
                        position: center,
                        modifiers: gpui::Modifiers::default(),
                        click_count: 1,
                        first_mouse: false,
                    }),
                    cx,
                );
                assert!(
                    down_res.propagate,
                    "{selector} MouseDown 必须保持 propagate=true，否则 gpui-pre-windows 无法记录 nc_button_pressed"
                );

                let up_res = window.dispatch_event(
                    gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                        button: MouseButton::Left,
                        position: center,
                        modifiers: gpui::Modifiers::default(),
                        click_count: 1,
                    }),
                    cx,
                );
                assert!(
                    up_res.propagate,
                    "{selector} MouseUp 必须保持 propagate=true，否则 gpui-pre-windows 无法执行最小化/最大化/关闭"
                );
            });
        }
    }
}
