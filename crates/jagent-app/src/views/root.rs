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
use gpui_component::{ActiveTheme, TitleBar, WindowExt as _, h_flex, v_flex};
use jagent_core::threads::{ActiveTarget, MAIN_VIEW_ID, SessionView, Thread};
use jagent_terminal::TerminalView;

use crate::actions::*;
use crate::icons::{IconName, icon};
use crate::state::{AppState, StateChanged};
use crate::theme::{colors, hex, sizes};
use crate::views::conversation::ConversationView;
use crate::views::empty_presets;
use crate::views::notif_center::{NotifSlot, notif_models};
use crate::views::popup::{MenuEntry, PopupTrigger, action_row, menu_popover, overlay_shell};
use crate::views::session_tabs::{ContextTab, SessionTabs, tab_models};
use crate::views::sidebar::{GroupAction, MenuTarget, RowAction, Sidebar, build_groups};
use crate::views::terminal_pane::view_for_session;
use crate::views::work_panel::WorkPanel;
use crate::views::{git_graph, new_session, rename, search_threads, settings, workspace_dialog};

pub struct RootView {
    state: Entity<AppState>,
    /// 当前主面的终端视图，键为 (thread id, 视图 id)；键变了才重建（PTY 在池里持续运行）
    terminal: Option<((String, String), Entity<TerminalView>)>,
    /// 当前主面的对话视图（chat），键为 thread id
    conversation: Option<(String, Entity<ConversationView>)>,
    settings_open: bool,
    settings_view: Option<Entity<settings::SettingsView>>,
    sidebar_width: f32,
    /// 主分隔条（侧栏 | 主面）的运行时态；拖动结束时宽度写回 settings
    split: Entity<ResizableState>,
    /// 宽屏：侧栏面板是否可见（`ToggleSidebar` 切换）；窄屏：抽屉是否打开
    sidebar_open: bool,
    /// 上一帧是否为窄屏；从宽切窄时自动收起抽屉
    was_narrow: bool,
    /// 工作面板开关（原型 `ui.panelOpen`，默认关；不落盘——会话期 UI 态）
    panel_open: bool,
    /// 工作面板右栏宽度（拖拽内存态，244–720；原型 `ui.panelWidth` 默认 280）
    panel_width: f32,
    /// workbench 分隔条（主面 | 工作面板）的运行时态
    work_split: Entity<ResizableState>,
    /// 工作面板本体（首开时建；关开之间保留，tab/选中态不丢）
    panel: Option<Entity<WorkPanel>>,
    /// 顶栏分支钮数据：当前工作区目录的 Git 分支（非 repo → `None`，不渲染钮）
    branch: Option<String>,
    /// 同一次 worktree 查询的变更文件（AddPopover「打开文件」区；非 repo → 空）
    worktree_files: Vec<jagent_core::git::WorktreeFile>,
    /// 上次分支查询的 cwd；变化时重查（render 期检查，字符串比较开销可忽略）
    branch_cwd: String,
    /// 分支查询的代际；过期响应不得回写
    branch_generation: u64,
    /// 侧栏「…」菜单的受控开合态（V5 统一浮层：行 / 工作区同一浮层实例，
    /// 左键 / 右键 / 点外 / Esc / 选中项都汇聚到这一份状态）
    open_menu: Option<MenuTarget>,
    /// 顶栏 SessionTabs「+」的 AddPopover 受控开合态（原型 session-add-pop）
    add_popover_open: bool,
}

impl RootView {
    pub fn new(state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        cx.subscribe(&state, |_, _, _: &StateChanged, cx| cx.notify())
            .detach();
        let sidebar_width = state.read(cx).settings.get().appearance.sidebar_width as f32;
        let split = cx.new(|_| ResizableState::default());
        let mut view = Self {
            state,
            terminal: None,
            conversation: None,
            settings_open: false,
            settings_view: None,
            sidebar_width,
            split,
            sidebar_open: true,
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
        };
        // 顶栏分支钮的首次异步查询（cwd 变化时 render 里会重查）
        view.refresh_branch(cx);
        view
    }

    /// 异步解析当前工作区目录的 Git 分支（`list_worktree_status` 顺带返回；
    /// 非 repo → `None` → 分支钮不渲染）。代际防串：cwd 切换后旧响应丢弃。
    fn refresh_branch(&mut self, cx: &mut Context<Self>) {
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
            let on_close: crate::views::work_panel::CloseFn = Rc::new(move |_, cx| {
                let _ = weak.update(cx, |v, cx| {
                    v.panel_open = false;
                    cx.notify();
                });
            });
            self.panel = Some(cx.new(|cx| WorkPanel::new(state, cx).with_on_close(on_close)));
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

    /// AddPopover「打开文件」：开面板、切文件页并选中 `path`（拉 diff/预览）。
    fn open_panel_file(&mut self, path: &str, cx: &mut Context<Self>) {
        self.panel_open = true;
        self.ensure_panel(cx);
        if let Some(panel) = &self.panel {
            panel.update(cx, |p, cx| p.show_file(path, cx));
        }
        cx.notify();
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
        let term = thread.as_terminal()?;
        let view_id = thread
            .common()
            .active_view_id
            .as_deref()
            .unwrap_or(MAIN_VIEW_ID);
        if view_id == MAIN_VIEW_ID {
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
            self.open_menu = None;
            self.terminal = want.and_then(|(t, v, sid)| {
                view_for_session(sid, window, cx).map(|view| ((t, v), view))
            });
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
                move |window, cx| workspace_dialog::open(state.clone(), window, cx)
            },
            {
                let this = cx.entity().downgrade();
                move |window, cx| {
                    let _ = this.update(cx, |v, cx| {
                        v.settings_open = true;
                        if v.settings_view.is_none() {
                            let state = v.state.clone();
                            v.settings_view =
                                Some(cx.new(|cx| settings::SettingsView::new(state, window, cx)));
                        }
                        cx.notify();
                    });
                }
            },
            {
                // 工作区菜单动作：Rename 在视图层拦截开弹窗，其余落 store
                let state = self.state.clone();
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
                    _ => apply_group_action(&state, id, action, cx),
                }
            },
            {
                let state = self.state.clone();
                move |window, cx| new_session::open(state.clone(), window, cx)
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
        );

        let (active_tid, tabs) = {
            let s = self.state.read(cx);
            let tid = s.threads.active_thread_id().map(str::to_owned);
            let tabs = tid
                .as_deref()
                .and_then(|id| s.threads.thread(id))
                .filter(|t| t.as_terminal().is_some())
                .map(tab_models);
            (tid, tabs)
        };

        // 顶栏上下文块（原型 .tb-context：folder/gear + 名 + cwd）
        let (ctx_icon, ctx_label, ctx_cwd) = {
            let s = self.state.read(cx);
            if self.settings_open {
                (IconName::Gear, "设置".to_owned(), None)
            } else if let Some(tid) = s.threads.active_thread_id() {
                let t = s.threads.thread(tid);
                let ws = t
                    .and_then(|t| t.workspace_id())
                    .and_then(|wid| s.threads.workspace(wid));
                match ws {
                    Some(w) => (IconName::Folder, w.name.clone(), Some(w.path.clone())),
                    None => (
                        IconName::Folder,
                        t.map(|t| t.title()).unwrap_or_else(|| "j-agent".into()),
                        None,
                    ),
                }
            } else {
                (IconName::Folder, "j-agent".to_owned(), None)
            }
        };

        let term_body = match &self.terminal {
            Some((_, v)) => div().size_full().child(v.clone()).into_any_element(),
            None => empty_presets(&self.state, narrow, cx),
        };

        let body = if self.settings_open {
            self.settings_view
                .as_ref()
                .map(|v| v.clone().into_any_element())
                .unwrap_or_else(|| div().into_any_element())
        } else {
            match &self.conversation {
                Some((_, v)) => v.clone().into_any_element(),
                None => term_body,
            }
        };
        // 主体列（tab 条已上移顶栏第二行，全宽）
        let body_column = body;

        // 顶栏第二行 tab 条（原型 #tb-tabs：38px tabStrip 内凹面 + 5/8 padding）。
        // settings → ContextTab(gear)；terminal → SessionTabs；chat/acp → ContextTab(kind)。
        let tabs_row = h_flex()
            .id("tb-tabs")
            .flex_shrink_0()
            .min_w_0()
            .h(px(sizes::TAB_BAR_HEIGHT))
            .gap(px(3.0))
            .pt(px(5.0))
            .pb(px(5.0))
            .pl(px(8.0))
            .pr(px(8.0))
            .bg(hex(colors::TAB_STRIP))
            .border_b_1()
            .border_color(hex(colors::BORDER))
            .overflow_hidden()
            .child(if self.settings_open {
                ContextTab::new(IconName::Gear, title.clone()).into_any_element()
            } else {
                match (active_tid, tabs) {
                    (Some(tid), Some(tabs)) => {
                        let st = self.state.clone();
                        let (st_a, st_c) = (st.clone(), st);
                        let (tid_a, tid_c, add_tid) = (tid.clone(), tid.clone(), tid);
                        // 「+」= AddPopover（原型 tb-add-btn + session-add-pop）：
                        // 点击 toggle 受控浮层；动作在浮层内（Git 图 / 新建 Shell）
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
                            // 零尺寸锚点（真「+」钮在 session_tabs，禁改文件；
                            // 锚在 tab 行尾与 + 钮同排，弹出位与原型几乎重合）
                            .trigger(PopupTrigger::new(|_| {
                                div().id("add-pop-anchor").size(px(0.0)).into_any_element()
                            }))
                            .content(move |_, _, _| {
                                let (state, weak, tid) =
                                    (add_state.clone(), add_weak.clone(), add_tid.clone());
                                let mut pop =
                                    overlay_shell("session-add-pop").w(px(280.0)).p(px(4.0));
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
                                pop = pop.child(action_row(
                                    "add-pop-shell",
                                    IconName::Terminal,
                                    "新建 Shell",
                                    move |window, cx| {
                                        let _ = weak_shell.update(cx, |v, cx| {
                                            v.add_popover_open = false;
                                            cx.notify();
                                        });
                                        let r = state.update(cx, |s, cx| {
                                            let r = s.add_session_shell(&tid, cx);
                                            cx.emit(StateChanged);
                                            r
                                        });
                                        if let Err(e) = r {
                                            window.push_notification(
                                                Notification::error(format!(
                                                    "新建 Shell 失败：{e}"
                                                )),
                                                cx,
                                            );
                                        }
                                    },
                                ));
                                // 「打开文件」子标题（原型 .sa-sub：10.5/500 muted）
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
                                    // 浮层自身不滚，列表是唯一滚动区（同 notif 列表）
                                    let mut list = div()
                                        .id("sa-files")
                                        .max_h(px(220.0))
                                        .overflow_y_scroll()
                                        .flex()
                                        .flex_col();
                                    for f in add_files.iter() {
                                        let (path, pick_weak) = (f.path.clone(), weak.clone());
                                        list = list.child(sa_file_row(f, move |_, cx| {
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
                        h_flex()
                            .min_w_0()
                            .child(SessionTabs::new(
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
                            ))
                            .child(add_popover)
                            .into_any_element()
                    }
                    (Some(_), None) => {
                        // chat / acp：单态页签（kind 图标 + 标题）
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

        let state = self.state.clone();
        v_flex()
            .key_context(CTX_WORKSPACE)
            .on_action(cx.listener(|this, _: &ToggleSettings, window, cx| {
                this.toggle_settings(cx);
                if this.settings_open {
                    if this.settings_view.is_none() {
                        let state = this.state.clone();
                        this.settings_view =
                            Some(cx.new(|cx| settings::SettingsView::new(state, window, cx)));
                    }
                    if let Some(view) = &this.settings_view {
                        view.update(cx, |view, _| view.focus_search());
                    }
                }
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &CloseSettings, _, cx| {
                this.settings_open = false;
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
                move |_: &SearchThreads, window, cx| search_threads::open(state.clone(), window, cx)
            })
            .on_action(move |_: &OpenGitGraph, window, cx| {
                git_graph::open(state.clone(), window, cx)
            })
            .size_full()
            .bg(cx.theme().background)
            // ── 顶栏主行（原型 #titlebar-main：44px；TitleBar 自带拖拽/红绿灯让位/三键）──
            .child(
                TitleBar::new()
                    .h(px(sizes::TOOLBAR_HEIGHT))
                    .bg(hex(colors::TITLEBAR))
                    .border_color(hex(colors::BORDER_SUBTLE))
                    // 窄屏汉堡钮（W4）/ 宽屏侧栏收起态的恢复钮（原型 ToolButton 28×28 r8）
                    .when(narrow || !self.sidebar_open, |tb| {
                        let this = cx.entity().downgrade();
                        let (ic, on) = if narrow {
                            (IconName::Menu, self.sidebar_open)
                        } else {
                            (IconName::PanelLeft, false)
                        };
                        tb.child(
                            div()
                                .id("titlebar-sidebar-toggle")
                                .flex()
                                .items_center()
                                .justify_center()
                                .size(px(28.0))
                                .rounded(px(8.0))
                                .ml(px(6.0))
                                .mr(px(2.0))
                                .flex_shrink_0()
                                .cursor_pointer()
                                .when(on, |d| d.bg(hex(colors::SURFACE_ACTIVE)))
                                .when(!on, |d| d.hover(|h| h.bg(hex(colors::SURFACE))))
                                .child(icon(
                                    ic,
                                    16.0,
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
                        )
                    })
                    .child(
                        // 上下文块（原型 .tb-context：icon 13 muted + 名 12/550 + cwd 11.5 faint）
                        h_flex()
                            .h_full()
                            .items_center()
                            .gap(px(7.0))
                            .pl(px(12.0))
                            .pr(px(12.0))
                            .min_w_0()
                            .child(icon(ctx_icon, 13.0, hex(colors::MUTED)))
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .text_color(hex(colors::TEXT))
                                    .whitespace_nowrap()
                                    .child(ctx_label.clone()),
                            )
                            .when(!narrow, |d| {
                                d.when_some(ctx_cwd.clone(), |d, cwd| {
                                    d.child(
                                        div()
                                            .max_w(px(420.0))
                                            .min_w_0()
                                            .overflow_hidden()
                                            .whitespace_nowrap()
                                            .text_ellipsis()
                                            .text_size(px(11.5))
                                            .text_color(hex(colors::FAINT))
                                            .child(cwd),
                                    )
                                })
                            }),
                    )
                    .child(div().flex_1().min_w(px(12.0)))
                    // ── 分支钮（原型 .tb-cell.tb-branch-btn：tile 底 + borderSubtle 边
                    //    + mono 分支名 + caret；窄屏 / 非 repo 不渲染）。点击弹 Git 菜单 ──
                    .when(!narrow, |tb| {
                        tb.when_some(self.branch.clone(), |tb, branch| {
                            tb.child(branch_menu(branch, &self.state, cx))
                        })
                    })
                    // 搜索入口（原型：仅窄屏 / 侧栏收起时显示，其余在侧栏）
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
                    // 工作面板开关（原型 #btn-panel：panelRight 15；on = surfaceActive + 提亮）
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
                    }),
            )
            // ── 顶栏第二行（#tb-tabs：38px 全宽 tab 条）──
            .child(tabs_row)
            .child(if narrow {
                narrow_body(
                    sidebar,
                    body_column,
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
                // workbench：主面 + 工作面板。≥1100 是可拖宽右栏；<1100 时面板转
                // absolute 浮层（gpui 按树序绘制——面板后画，盖住主面右缘）
                let workbench = if panel_overlay {
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
                            // 内存态：原型 ui.panelWidth 同样不落盘
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
                                    // visible(false) 不渲染内容；仅占位
                                    None => div().into_any_element(),
                                }),
                        )
                        .into_any_element()
                };
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
                                    .child(sidebar),
                            )
                            .child(resizable_panel().child(workbench)),
                    )
                    .into_any_element()
            })
    }
}

/// 空态（对应旧 EmptyPresets）：列出全部预设，点一个即在当前工作区新建会话。
/// 立即启动 PTY 的规则在 `AppState::spawn_from_preset`（已有 gpui 测试）。
/// V6 原型 home-card 渐变卡对齐，实现移 [`crate::views::empty_presets`]。
fn empty_presets(state: &Entity<AppState>, narrow: bool, cx: &mut Context<RootView>) -> AnyElement {
    empty_presets::empty_pane(state, narrow, cx)
}

pub fn apply_group_action(
    state: &Entity<AppState>,
    workspace_id: &str,
    action: GroupAction,
    cx: &mut App,
) {
    state.update(cx, |s, cx| {
        match action {
            GroupAction::ToggleExpanded => s.threads.toggle_workspace_expanded(workspace_id),
            GroupAction::SetShowAll(show) => s.threads.set_workspace_show_all(workspace_id, show),
            GroupAction::SetPinned(pin) => s.threads.set_workspace_pinned(workspace_id, pin),
            GroupAction::Rename => {} // 在视图层拦截（rename::open_workspace）
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
            cx.new(|_| RootView {
                state,
                terminal: None,
                conversation: None,
                settings_open: true,
                settings_view: None,
                sidebar_width: 260.0,
                split,
                sidebar_open: true,
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
        .on_click(move |e, w, cx| on_click(e, w, cx))
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
            MenuEntry::item("graph", "打开 Git 图（Ctrl-Shift-G）"),
            MenuEntry::item("changes", "查看变更（工作面板）"),
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
                .when(lit, |d| d.bg(gpui::rgba(0x61AFEF40)))
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
        .child(icon(IconName::GitBranch, 14.0, hex(colors::MUTED)))
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
                &jagent_core::threads::ActiveTarget::Thread(a)
            );
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
}
