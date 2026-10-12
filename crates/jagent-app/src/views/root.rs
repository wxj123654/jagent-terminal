//! 根视图：标题栏 + 侧栏 + 主面（对应旧 `plane/AgentPlane.tsx`）。
//!
//! 窄屏（< 760px）侧栏收成抽屉的分支在 P3 接入；此处先固定布局，把"状态 → 画面"的链路打通。

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    MouseButton, MouseDownEvent, ParentElement, Render, SharedString, StatefulInteractiveElement as _,
    Styled, Window, div, hsla,
    prelude::FluentBuilder as _, px,
};
use gpui_component::button::Button;
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
use crate::views::session_tabs::{ContextTab, SessionTabs, tab_models};
use crate::views::sidebar::{GroupAction, RowAction, Sidebar, build_groups};
use crate::views::terminal_pane::view_for_session;
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
}

impl RootView {
    pub fn new(state: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        cx.subscribe(&state, |_, _, _: &StateChanged, cx| cx.notify())
            .detach();
        let sidebar_width = state.read(cx).settings.get().appearance.sidebar_width as f32;
        let split = cx.new(|_| ResizableState::default());
        Self {
            state,
            terminal: None,
            conversation: None,
            settings_open: false,
            settings_view: None,
            sidebar_width,
            split,
            sidebar_open: true,
            was_narrow: false,
        }
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
            self.conversation = chat_id.map(|id| {
                let view = cx.new(|cx| ConversationView::new(state, id.clone(), window, cx));
                (id, view)
            });
        }

        let want = self.active_terminal_session(cx);
        let key = want.as_ref().map(|(t, v, _)| (t.clone(), v.clone()));
        if self.terminal.as_ref().map(|(k, _)| k) != key.as_ref() {
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
        let narrow = is_narrow(f32::from(window.viewport_size().width));
        if narrow != self.was_narrow {
            self.was_narrow = narrow;
            self.sidebar_open = !narrow;
        }

        let this = cx.entity().downgrade();
        let state_for_rows = self.state.clone();
        let unread_notices = self.state.read(cx).threads.unread_notice_count();
        let sidebar = Sidebar::new(
            groups,
            unread_notices,
            env!("CARGO_PKG_VERSION"),
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
            None => empty_presets(&self.state, cx),
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
                        let (st_a, st_c, st_n) = (st.clone(), st.clone(), st);
                        let (tid_a, tid_c, tid_n) = (tid.clone(), tid.clone(), tid);
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
                            move |window, cx| {
                                let r = st_n.update(cx, |s, cx| {
                                    let r = s.add_session_shell(&tid_n, cx);
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
                        )
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
                                .child(icon(ic, 16.0, if on { hex(colors::TEXT_BRIGHT) } else { hex(colors::MUTED) }))
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
                    .child(div().flex_1().min_w(px(12.0))),
            )
            // ── 顶栏第二行（#tb-tabs：38px 全宽 tab 条）──
            .child(tabs_row)
            .child(if narrow {
                narrow_body(
                    sidebar,
                    body_column,
                    self.sidebar_open,
                    self.sidebar_width,
                    cx,
                )
            } else {
                div()
                    .flex()
                    .flex_row()
                    .flex_1()
                    .min_h_0()
                    .child(
                        h_resizable("main-split")
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
                            .child(
                                resizable_panel().child(
                                    div()
                                        .size_full()
                                        .min_w_0()
                                        .bg(cx.theme().colors.list)
                                        .child(body_column),
                                ),
                            ),
                    )
                    .into_any_element()
            })
    }
}

/// 空态（对应旧 EmptyPresets）：列出全部预设，点一个即在当前工作区新建会话。
/// 立即启动 PTY 的规则在 `AppState::spawn_from_preset`（已有 gpui 测试）。
fn empty_presets(state: &Entity<AppState>, cx: &mut Context<RootView>) -> AnyElement {
    let (presets, ws) = {
        let s = state.read(cx);
        (
            s.settings.get().presets.items.clone(),
            s.active_workspace_id(),
        )
    };
    let st = state.clone();
    let add_session = Button::new("add-session").label("＋ 新建会话").on_click({
        let state = state.clone();
        move |_, window, cx| crate::views::new_session::open(state.clone(), window, cx)
    });
    v_flex()
        .size_full()
        .items_center()
        .justify_center()
        .gap_2()
        .text_color(cx.theme().muted_foreground)
        .child(div().child("选择一个预设开始会话"))
        .child(add_session)
        .children(presets.into_iter().map(|p| {
            let (st, id, ws) = (st.clone(), p.id.clone(), ws.clone());
            Button::new(format!("preset-{}", p.id))
                .label(p.label.clone())
                .on_click(move |_, window, cx| {
                    let ws_opt = (!ws.is_empty()).then_some(ws.as_str());
                    let r = st.update(cx, |s, cx| s.spawn_from_preset(&id, ws_opt, cx).map(|_| ()));
                    if let Err(e) = r {
                        window.push_notification(Notification::error(e.to_string()), cx);
                    }
                })
        }))
        .into_any_element()
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
            RowAction::MarkUnread => s.threads.set_thread_unread(thread_id, true),
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

/// 拖动结束后把侧栏宽度写回 `appearance.sidebarWidth`（越界值由 core 容错回默认，这里不再钳位）。
pub fn persist_sidebar_width(state: &Entity<AppState>, width: f32, cx: &mut App) {
    let w = width.round() as i64;
    state.update(cx, |s, cx| {
        s.settings
            .patch("appearance.sidebarWidth", serde_json::json!(w));
        s.flush(cx);
    });
}

/// 窄屏布局：主面全宽；侧栏作为左侧覆盖层抽屉，带遮罩。点遮罩关闭。
fn narrow_body(
    sidebar: Sidebar,
    body: AnyElement,
    open: bool,
    width: f32,
    cx: &mut Context<RootView>,
) -> AnyElement {
    let backdrop = div()
        .absolute()
        .inset_0()
        .bg(hsla(0.0, 0.0, 0.0, 0.4))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, _: &MouseDownEvent, _, cx| {
                this.sidebar_open = false;
                cx.notify();
            }),
        );
    let drawer = div()
        .absolute()
        .top_0()
        .bottom_0()
        .left_0()
        .w(px(width))
        .child(sidebar);
    div()
        .relative()
        .flex_1()
        .min_h_0()
        .size_full()
        .child(body)
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
            apply_row_action(&state, &id, RowAction::MarkUnread, cx);
            assert!(
                state.read(cx).threads.thread(&id).unwrap().common().unread,
                "标记未读写入 store"
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
