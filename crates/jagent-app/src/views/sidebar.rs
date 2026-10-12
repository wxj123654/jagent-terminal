//! 侧栏视图：仅渲染 core 给出的分组/排序/截断结果，交互通过回调交给装配层。
use gpui::{
    App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement, RenderOnce,
    SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_component::menu::{ContextMenuExt, PopupMenuItem};
use gpui_component::{ActiveTheme, h_flex, v_flex};
use jagent_core::threads::{Thread, Workspace, sort_threads, sort_workspaces};

use crate::theme::{Tokens, sizes};

type ClickFn = std::rc::Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowAction {
    SetPinned(bool),
    Rename,
    MarkUnread,
    Remove,
}

pub type RowPick = std::rc::Rc<dyn Fn(RowAction, &mut Window, &mut App)>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupAction {
    ToggleExpanded,
    SetShowAll(bool),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RowModel {
    pub id: String,
    pub title: SharedString,
    pub dot: RowDot,
    pub active: bool,
    pub pinned: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowDot {
    None,
    Running,
    Bell,
    Unread,
    Exited,
}
impl RowDot {
    fn of(t: &Thread) -> Self {
        if let Some(term) = t.as_terminal() {
            if term.has_bell {
                Self::Bell
            } else if term.status == jagent_core::threads::RunStatus::Exited {
                Self::Exited
            } else if t.common().unread {
                Self::Unread
            } else if term.status == jagent_core::threads::RunStatus::Running {
                Self::Running
            } else {
                Self::None
            }
        } else if t.common().unread {
            Self::Unread
        } else {
            Self::None
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupModel {
    pub id: String,
    pub name: String,
    pub expanded: bool,
    pub pinned: bool,
    pub rows: Vec<RowModel>,
    pub hidden: usize,
}
pub const COLLAPSED_ROWS: usize = 4;

pub fn build_groups(
    workspaces: &[Workspace],
    threads: &[Thread],
    active_thread: Option<&str>,
) -> Vec<GroupModel> {
    sort_workspaces(workspaces)
        .into_iter()
        .map(|w| {
            let mine: Vec<Thread> = threads
                .iter()
                .filter(|t| t.workspace_id() == Some(&w.id))
                .cloned()
                .collect();
            let sorted = sort_threads(&mine);
            let total = sorted.len();
            let shown = if w.show_all {
                total
            } else {
                total.min(COLLAPSED_ROWS)
            };
            let rows = sorted
                .into_iter()
                .take(shown)
                .map(|t| RowModel {
                    id: t.id().to_owned(),
                    title: t.title().into(),
                    dot: RowDot::of(&t),
                    active: active_thread == Some(t.id()),
                    pinned: t.common().pin,
                })
                .collect();
            GroupModel {
                id: w.id.clone(),
                name: w.name.clone(),
                expanded: w.expanded,
                pinned: w.pin,
                rows,
                hidden: total - shown,
            }
        })
        .collect()
}

#[derive(IntoElement)]
pub struct ThreadRow {
    model: RowModel,
    on_click: ClickFn,
    on_pick: RowPick,
}
impl ThreadRow {
    pub fn new(model: RowModel, on_click: ClickFn, on_pick: RowPick) -> Self {
        Self {
            model,
            on_click,
            on_pick,
        }
    }
}
impl RenderOnce for ThreadRow {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let tokens = cx.global::<Tokens>().clone();
        let theme = cx.theme();
        let dot = match self.model.dot {
            RowDot::Running => Some(tokens.status_done),
            RowDot::Bell => Some(tokens.status_error),
            RowDot::Unread => Some(theme.primary),
            RowDot::Exited | RowDot::None => None,
        };
        let id: SharedString = format!("row-{}", self.model.id).into();
        let (fg, active_bg, hover_bg) = (
            theme.sidebar_foreground,
            theme.sidebar_accent,
            theme.list_hover,
        );
        let exited = self.model.dot == RowDot::Exited;
        h_flex()
            .id(ElementId::Name(id))
            .h(px(sizes::ROW_HEIGHT))
            .mx(px(sizes::ROW_MARGIN_X))
            .px_2()
            .gap_2()
            .items_center()
            .rounded(px(sizes::ROW_RADIUS))
            .text_sm()
            .cursor_pointer()
            .text_color(if exited { tokens.exited } else { fg })
            .when_else(
                self.model.active,
                |d| d.bg(active_bg),
                |d| d.hover(|h| h.bg(hover_bg)),
            )
            .on_click(move |e, w, cx| (self.on_click)(e, w, cx))
            .child(
                div()
                    .size(px(8.0))
                    .rounded_full()
                    .when_some(dot, |d, c| d.bg(c)),
            )
            .child(
                div()
                    .flex_1()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .child(self.model.title),
            )
            .context_menu(move |menu, _, _| {
                let pick = self.on_pick.clone();
                let pinned = self.model.pinned;
                let pin = PopupMenuItem::new(if pinned { "取消置顶" } else { "置顶" }).on_click({
                    let pick = pick.clone();
                    move |_, w, cx| pick(RowAction::SetPinned(!pinned), w, cx)
                });
                let rename = PopupMenuItem::new("重命名…").on_click({
                    let pick = pick.clone();
                    move |_, w, cx| pick(RowAction::Rename, w, cx)
                });
                let unread = PopupMenuItem::new("标记为未读").on_click({
                    let pick = pick.clone();
                    move |_, w, cx| pick(RowAction::MarkUnread, w, cx)
                });
                let remove = PopupMenuItem::new("移除")
                    .on_click(move |_, w, cx| pick(RowAction::Remove, w, cx));
                menu.item(pin)
                    .item(rename)
                    .item(unread)
                    .separator()
                    .item(remove)
            })
    }
}

#[derive(IntoElement)]
pub struct Sidebar {
    groups: Vec<GroupModel>,
    on_select: std::rc::Rc<dyn Fn(&str, &mut Window, &mut App)>,
    on_row: std::rc::Rc<dyn Fn(&str, RowAction, &mut Window, &mut App)>,
    on_add_workspace: std::rc::Rc<dyn Fn(&mut Window, &mut App)>,
    on_settings: std::rc::Rc<dyn Fn(&mut Window, &mut App)>,
    on_group: std::rc::Rc<dyn Fn(&str, GroupAction, &mut App)>,
}
impl Sidebar {
    pub fn new(
        groups: Vec<GroupModel>,
        on_select: impl Fn(&str, &mut Window, &mut App) + 'static,
        on_row: impl Fn(&str, RowAction, &mut Window, &mut App) + 'static,
        on_add_workspace: impl Fn(&mut Window, &mut App) + 'static,
        on_settings: impl Fn(&mut Window, &mut App) + 'static,
        on_group: impl Fn(&str, GroupAction, &mut App) + 'static,
    ) -> Self {
        Self {
            groups,
            on_select: std::rc::Rc::new(on_select),
            on_row: std::rc::Rc::new(on_row),
            on_add_workspace: std::rc::Rc::new(on_add_workspace),
            on_settings: std::rc::Rc::new(on_settings),
            on_group: std::rc::Rc::new(on_group),
        }
    }
}
impl RenderOnce for Sidebar {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let (bg, border, muted, fg) = (
            theme.sidebar,
            theme.sidebar_border,
            theme.muted_foreground,
            theme.sidebar_foreground,
        );
        v_flex()
            .id("sidebar")
            .w_full()
            .h_full()
            .flex_shrink_0()
            .bg(bg)
            .border_r_1()
            .border_color(border)
            .overflow_y_scroll()
            .children(self.groups.into_iter().map(|g| {
                let id = g.id.clone();
                let on_group = self.on_group.clone();
                let toggle = div()
                    .id(ElementId::Name(format!("ws-toggle-{}", g.id).into()))
                    .px_1()
                    .cursor_pointer()
                    .text_color(muted)
                    .hover(|d| d.text_color(fg))
                    .child(if g.expanded { "⌄" } else { "›" })
                    .on_click({
                        let id = id.clone();
                        let cb = on_group.clone();
                        move |_, _, cx| cb(&id, GroupAction::ToggleExpanded, cx)
                    });
                let add = div()
                    .id(ElementId::Name(format!("ws-add-{}", g.id).into()))
                    .px_1()
                    .cursor_pointer()
                    .text_color(muted)
                    .hover(|d| d.text_color(fg))
                    .child("+")
                    .on_click({
                        let cb = self.on_add_workspace.clone();
                        move |_, w, cx| cb(w, cx)
                    });
                let header = h_flex()
                    .px_3()
                    .h(px(28.0))
                    .items_center()
                    .text_xs()
                    .text_color(muted)
                    .child(
                        div()
                            .flex_1()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .child(g.name.clone()),
                    )
                    .child(toggle)
                    .child(add);
                let mut group = v_flex().py_1().child(header);
                if g.expanded {
                    let on_select = self.on_select.clone();
                    let on_row = self.on_row.clone();
                    let expanded_row_count = g.rows.len();
                    group = group.children(g.rows.into_iter().map(move |r| {
                        let sid = r.id.clone();
                        let rid = sid.clone();
                        let on_select = on_select.clone();
                        let on_row = on_row.clone();
                        let pick: RowPick =
                            std::rc::Rc::new(move |a, w, cx| on_row(&rid, a, w, cx));
                        ThreadRow::new(
                            r,
                            std::rc::Rc::new(move |_, w, cx| on_select(&sid, w, cx)),
                            pick,
                        )
                    }));
                    if g.hidden > 0 {
                        let id = g.id.clone();
                        let cb = self.on_group.clone();
                        group = group.child(
                            div()
                                .id(ElementId::Name(format!("ws-show-all-{}", g.id).into()))
                                .px_4()
                                .h(px(24.0))
                                .text_xs()
                                .text_color(muted)
                                .cursor_pointer()
                                .hover(|d| d.text_color(fg))
                                .child(format!("还有 {} 个会话 · 显示全部", g.hidden))
                                .on_click(move |_, _, cx| {
                                    cb(&id, GroupAction::SetShowAll(true), cx)
                                }),
                        );
                    }
                    if g.hidden == 0 && expanded_row_count > COLLAPSED_ROWS {
                        let id = g.id.clone();
                        let cb = self.on_group.clone();
                        group = group.child(
                            div()
                                .id(ElementId::Name(format!("ws-show-fewer-{}", g.id).into()))
                                .px_4()
                                .h(px(24.0))
                                .text_xs()
                                .text_color(muted)
                                .cursor_pointer()
                                .child("收起会话列表")
                                .on_click(move |_, _, cx| {
                                    cb(&id, GroupAction::SetShowAll(false), cx)
                                }),
                        );
                    }
                }
                group
            }))
            .child(div().flex_1())
            .child(
                div()
                    .id("sidebar-settings")
                    .mx_2()
                    .my_2()
                    .px_3()
                    .py_2()
                    .rounded(px(6.0))
                    .cursor_pointer()
                    .text_xs()
                    .text_color(muted)
                    .hover(|d| d.bg(theme.list_hover).text_color(fg))
                    .child("⚙ 设置  Ctrl-,")
                    .on_click(move |_, w, cx| (self.on_settings)(w, cx)),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jagent_core::threads::*;
    fn ws(id: &str, name: &str, created: i64) -> Workspace {
        Workspace {
            name: name.into(),
            ..default_workspace(id.into(), "/p", created)
        }
    }
    fn term(id: &str, ws_id: &str, created: i64, f: impl FnOnce(&mut TerminalThread)) -> Thread {
        let mut t = TerminalThread {
            id: id.into(),
            session_id: 1,
            preset: None,
            cwd: "/".into(),
            init_command: Some(format!("cmd-{id}")),
            osc_title: None,
            custom_title: None,
            status: RunStatus::Running,
            exit_code: None,
            has_bell: false,
            created_at: created,
            common: ThreadCommon {
                workspace_id: Some(ws_id.into()),
                ..Default::default()
            },
        };
        f(&mut t);
        Thread::Terminal(t)
    }
    #[test]
    fn groups_follow_workspace_sort_pinned_first_and_rows_follow_thread_priority() {
        let workspaces = vec![
            ws("a", "A", 1),
            Workspace {
                pin: true,
                ..ws("b", "B", 2)
            },
        ];
        let threads = vec![
            term("t-old", "a", 1, |_| {}),
            term("t-bell", "a", 2, |t| t.has_bell = true),
            term("t-b", "b", 3, |_| {}),
        ];
        let g = build_groups(&workspaces, &threads, Some("t-old"));
        assert_eq!(
            g.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(),
            ["B", "A"]
        );
        let a = &g[1];
        assert_eq!(
            a.rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["t-bell", "t-old"]
        );
        assert_eq!(a.rows[0].dot, RowDot::Bell);
        assert!(a.rows[1].active && !a.rows[0].active);
    }
    #[test]
    fn collapsed_group_reports_hidden_and_show_all_state() {
        let workspaces = vec![ws("a", "A", 1)];
        let threads: Vec<Thread> = (0..7)
            .map(|i| term(&format!("t{i}"), "a", i, |_| {}))
            .collect();
        let g = build_groups(&workspaces, &threads, None);
        assert_eq!((g[0].rows.len(), g[0].hidden), (COLLAPSED_ROWS, 3));
        let mut w = workspaces[0].clone();
        w.show_all = true;
        let g = build_groups(&[w], &threads, None);
        assert_eq!((g[0].rows.len(), g[0].hidden), (7, 0));
    }
    #[gpui::test]
    fn group_toggle_and_show_all_actions_persist_workspace_state(cx: &mut gpui::TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        cx.update(|cx| {
            let state = crate::state::init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let ws_id = state.read(cx).workspaces()[0].id.clone();
            crate::views::root::apply_group_action(&state, &ws_id, GroupAction::ToggleExpanded, cx);
            assert!(!state.read(cx).threads.workspace(&ws_id).unwrap().expanded);
            crate::views::root::apply_group_action(&state, &ws_id, GroupAction::ToggleExpanded, cx);
            assert!(state.read(cx).threads.workspace(&ws_id).unwrap().expanded);
            crate::views::root::apply_group_action(
                &state,
                &ws_id,
                GroupAction::SetShowAll(true),
                cx,
            );
            assert!(state.read(cx).threads.workspace(&ws_id).unwrap().show_all);
            crate::views::root::apply_group_action(
                &state,
                &ws_id,
                GroupAction::SetShowAll(false),
                cx,
            );
            assert!(!state.read(cx).threads.workspace(&ws_id).unwrap().show_all);
        });
    }

    #[test]
    fn threads_from_other_workspaces_and_unattached_ones_do_not_leak() {
        let workspaces = vec![ws("a", "A", 1)];
        let mut orphan = term("orphan", "a", 1, |_| {});
        orphan.common_mut().workspace_id = None;
        let threads = vec![term("a", "a", 1, |_| {}), term("b", "b", 2, |_| {}), orphan];
        let g = build_groups(&workspaces, &threads, None);
        assert_eq!(
            g[0].rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["a"]
        );
    }
    #[test]
    fn row_dot_priority_is_stable() {
        let dot = |f: &dyn Fn(&mut TerminalThread)| RowDot::of(&term("t", "a", 0, |t| f(t)));
        assert_eq!(dot(&|_| {}), RowDot::Running);
        assert_eq!(dot(&|t| t.status = RunStatus::Exited), RowDot::Exited);
        assert_eq!(dot(&|t| t.common.unread = true), RowDot::Unread);
        assert_eq!(
            dot(&|t| {
                t.has_bell = true;
                t.status = RunStatus::Exited
            }),
            RowDot::Bell
        );
    }
    #[test]
    fn chat_dot_only_shows_unread() {
        let chat = |unread| {
            Thread::Chat(ChatThread {
                id: "c".into(),
                title: "Chat".into(),
                created_at: 0,
                messages: vec![],
                pending_reply: false,
                common: ThreadCommon {
                    unread,
                    ..Default::default()
                },
            })
        };
        assert_eq!(RowDot::of(&chat(false)), RowDot::None);
        assert_eq!(RowDot::of(&chat(true)), RowDot::Unread);
    }
    #[test]
    fn terminal_title_uses_osc_then_init_command() {
        let g = build_groups(
            &[ws("a", "A", 1)],
            &[term("t", "a", 0, |t| t.osc_title = Some("vim".into()))],
            None,
        );
        assert_eq!(g[0].rows[0].title, "vim");
        let g = build_groups(&[ws("a", "A", 1)], &[term("t", "a", 0, |_| {})], None);
        assert_eq!(g[0].rows[0].title, "cmd-t");
    }
}
