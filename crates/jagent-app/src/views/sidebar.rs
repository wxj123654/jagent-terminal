//! 侧栏视图：仅渲染 core 给出的分组/排序/截断结果，交互通过回调交给装配层。
//!
//! 视觉契约 = React 原型 `#sidebar`（旧 gpuix `sidebar/Sidebar.tsx` /
//! `WorkspaceList.tsx` / `ThreadRow.tsx`，R4 对齐）：
//! - 头 46px（mac 红绿灯让位 + 收起钮）+ nav 行组（新建/搜索）+ 区头「工作区」
//!   固定不滚；滚动区只装分组；脚（齿轮/铃铛·通知中心浮层锚点/版本号）。
//! - 行件全部走 lucide 图标（[`crate::icons`]），hover 提亮/ghost 显隐用
//!   gpui `group`/`group_hover`（无 JS 态）。
use gpui::{
    App, ClickEvent, ElementId, InteractiveElement, IntoElement, MouseButton, ParentElement,
    RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_base::Popover;
use gpui_component::{ActiveTheme, h_flex, v_flex};
use jagent_core::threads::{Thread, Workspace, sort_threads, sort_workspaces};

use crate::icons::{IconName, icon};
use crate::theme::{Tokens, colors, hex, sizes};
use crate::views::notif_center::NotifSlot;
use crate::views::popup::{MenuEntry, PickFn, PopupTrigger, menu_surface};

type ClickFn = std::rc::Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;
/// 菜单开合回调（受控浮层：trigger 左键 / 右键 / 点外 / Esc / 选中项都会走这里）
type MenuOpenFn = std::rc::Rc<dyn Fn(bool, &mut Window, &mut App)>;
/// 侧栏菜单受控回调：`(目标, 开/关, window, app)`——装配层据此维护唯一开合态
pub type MenuToggleFn = std::rc::Rc<dyn Fn(MenuTarget, bool, &mut Window, &mut App)>;

/// 无参动作回调（设置 / 新建会话 / 搜索 / 添加工作区）。
pub type WindowActionFn = std::rc::Rc<dyn Fn(&mut Window, &mut App)>;
/// 单 id 动作回调（选中会话）。
pub type SelectFn = std::rc::Rc<dyn Fn(&str, &mut Window, &mut App)>;
/// 行动作回调（置顶 / 重命名 / 移除 …）。
pub type RowActionFn = std::rc::Rc<dyn Fn(&str, RowAction, &mut Window, &mut App)>;
/// 工作区分组动作回调。
pub type GroupActionFn = std::rc::Rc<dyn Fn(&str, GroupAction, &mut Window, &mut App)>;

/// 当前打开的侧栏菜单（行「…」/ 工作区「…」），受控态挂在 RootView 上。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuTarget {
    Row(String),
    Workspace(String),
}

/// 行菜单条目（原型 `threadMenuItems`：pin/rename/unread/sep/remove(danger)）。
pub fn thread_menu_entries(pinned: bool, unread: bool) -> Vec<MenuEntry> {
    vec![
        MenuEntry::item("pin", if pinned { "取消置顶" } else { "置顶" }),
        MenuEntry::item("rename", "重命名…"),
        MenuEntry::item(
            "unread",
            if unread {
                "标记为已读"
            } else {
                "标记为未读"
            },
        ),
        MenuEntry::Separator,
        MenuEntry::danger("remove", "移除"),
    ]
}

/// 工作区菜单条目（原型 `wsMenuItems`：pin/rename/sep/remove(danger)）。
pub fn ws_menu_entries(pinned: bool) -> Vec<MenuEntry> {
    vec![
        MenuEntry::item(
            "pin",
            if pinned {
                "取消置顶工作区"
            } else {
                "置顶工作区"
            },
        ),
        MenuEntry::item("rename", "重命名…"),
        MenuEntry::Separator,
        MenuEntry::danger("remove", "移除工作区"),
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowAction {
    SetPinned(bool),
    Rename,
    /// 原型是切换语义（unread ? 标为已读 : 标为未读）
    SetUnread(bool),
    Remove,
}

pub type RowPick = std::rc::Rc<dyn Fn(RowAction, &mut Window, &mut App)>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupAction {
    ToggleExpanded,
    SetShowAll(bool),
    SetPinned(bool),
    Rename,
    Remove,
}

/// 会话 kind（行头 tile 图标与配色）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowKind {
    Terminal,
    Chat,
    Acp,
}
impl RowKind {
    fn of(t: &Thread) -> Self {
        match t {
            Thread::Terminal(_) => Self::Terminal,
            Thread::Chat(_) => Self::Chat,
            Thread::Acp(_) => Self::Acp,
        }
    }
    fn icon(self) -> IconName {
        match self {
            Self::Terminal => IconName::Terminal,
            Self::Chat => IconName::Chat,
            Self::Acp => IconName::Acp,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RowModel {
    pub id: String,
    pub title: SharedString,
    pub kind: RowKind,
    pub dot: RowDot,
    pub active: bool,
    pub pinned: bool,
    pub unread: bool,
    pub exited: bool,
}

/// 状态点（D12 诚实语义）：terminal 存活 ≠ 在工作——不显示 running；
/// chat/acp pendingReply 才是 running。`IdleOn` 由渲染层按 active+idle 补。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowDot {
    None,
    Running,
    Need,
    Unread,
    Exited,
}
impl RowDot {
    fn of(t: &Thread) -> Self {
        if let Some(term) = t.as_terminal() {
            if term.status == jagent_core::threads::RunStatus::Exited {
                Self::Exited
            } else if term.has_bell {
                Self::Need
            } else if t.common().unread {
                Self::Unread
            } else {
                Self::None
            }
        } else {
            // chat / acp：pendingReply 才是 running（agent 真在工作）
            let pending = match t {
                Thread::Chat(c) => c.pending_reply,
                Thread::Acp(a) => a.pending_reply,
                Thread::Terminal(_) => unreachable!("terminal 走上一分支"),
            };
            if pending {
                Self::Running
            } else if t.common().unread {
                Self::Unread
            } else {
                Self::None
            }
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
    /// 「未归属会话」虚拟组：恒展开、无折叠/菜单
    pub unassigned: bool,
}
pub const COLLAPSED_ROWS: usize = 4;

pub fn build_groups(
    workspaces: &[Workspace],
    threads: &[Thread],
    active_thread: Option<&str>,
) -> Vec<GroupModel> {
    let mut groups: Vec<GroupModel> = sort_workspaces(workspaces)
        .into_iter()
        .map(|w| {
            let mine: Vec<Thread> = threads
                .iter()
                .filter(|t| t.workspace_id() == Some(&w.id))
                .cloned()
                .collect();
            group_model(
                &w.id,
                &w.name,
                w.expanded,
                w.pin,
                w.show_all,
                &mine,
                active_thread,
                false,
            )
        })
        .collect();
    let orphans: Vec<Thread> = threads
        .iter()
        .filter(|t| t.workspace_id().is_none())
        .cloned()
        .collect();
    if !orphans.is_empty() {
        groups.push(group_model(
            "__unassigned__",
            "未归属会话",
            true,
            false,
            false,
            &orphans,
            active_thread,
            true,
        ));
    }
    groups
}

#[allow(clippy::too_many_arguments)]
fn group_model(
    id: &str,
    name: &str,
    expanded: bool,
    pinned: bool,
    show_all: bool,
    mine: &[Thread],
    active_thread: Option<&str>,
    unassigned: bool,
) -> GroupModel {
    let sorted = sort_threads(mine);
    let total = sorted.len();
    let shown = if show_all {
        total
    } else {
        total.min(COLLAPSED_ROWS)
    };
    // active/focus 行不被截断（原型：lim 扩展到包含它）
    let mut shown = shown;
    if let Some(ix) = active_thread.and_then(|a| sorted.iter().position(|t| t.id() == a))
        && ix >= shown
    {
        shown = ix + 1;
    }
    let rows = sorted
        .into_iter()
        .take(shown)
        .map(|t| RowModel {
            id: t.id().to_owned(),
            title: t.title().into(),
            kind: RowKind::of(t),
            dot: RowDot::of(t),
            active: active_thread == Some(t.id()),
            pinned: t.common().pin,
            unread: t.common().unread,
            exited: t
                .as_terminal()
                .is_some_and(|x| x.status == jagent_core::threads::RunStatus::Exited),
        })
        .collect();
    GroupModel {
        id: id.to_owned(),
        name: name.to_owned(),
        expanded,
        pinned,
        rows,
        hidden: total - shown,
        unassigned,
    }
}

/// 原型 3.5% 白 hover 底 / 2.5% tile 底 / 6% 引导线 / 2.5% more-link hover。
fn white(alpha: f32) -> gpui::Hsla {
    gpui::Rgba {
        r: 1.0,
        g: 1.0,
        b: 1.0,
        a: alpha,
    }
    .into()
}

#[derive(IntoElement)]
pub struct ThreadRow {
    model: RowModel,
    /// 本行「…」菜单浮层是否展开（受控态在 RootView）
    menu_open: bool,
    on_menu: MenuOpenFn,
    on_click: ClickFn,
    on_pick: RowPick,
}
impl ThreadRow {
    pub fn new(
        model: RowModel,
        menu_open: bool,
        on_menu: MenuOpenFn,
        on_click: ClickFn,
        on_pick: RowPick,
    ) -> Self {
        Self {
            model,
            menu_open,
            on_menu,
            on_click,
            on_pick,
        }
    }
}
impl RenderOnce for ThreadRow {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let tokens = cx.global::<Tokens>().clone();
        let theme = cx.theme();
        let Self {
            model,
            menu_open,
            on_menu,
            on_click,
            on_pick,
        } = self;
        let m = &model;
        let exited = m.exited;
        let unread = !exited && m.unread;
        // tile 面色按 kind（terminal 绿 / chat accent / acp 紫）；exited 压灰 + tile 透明
        let kind_color = if exited {
            tokens.exited
        } else {
            match m.kind {
                RowKind::Terminal => tokens.terminal_kind,
                RowKind::Chat => hex(colors::ACCENT),
                RowKind::Acp => tokens.acp_kind,
            }
        };
        let title_color = if exited {
            tokens.exited
        } else if m.active || unread {
            hex(colors::TEXT_BRIGHT)
        } else {
            theme.sidebar_foreground
        };
        let active_bg = theme.sidebar_accent;
        let group: SharedString = format!("row-{}", m.id).into();
        let id: SharedString = format!("row-{}", m.id).into();

        // tile 右下角状态角标：6px 点 + 1.5px sidebar 描边半出外缘（9px 盒）；
        // active 空闲 = 10px surfaceActive + g300 描边空心环；exited/idle 无点
        let (dot_bg, dot_border, dot_size) = match m.dot {
            RowDot::Running => (tokens.status_running, theme.sidebar, px(9.)),
            RowDot::Need => (tokens.status_need, theme.sidebar, px(9.)),
            RowDot::Unread => (theme.muted_foreground, theme.sidebar, px(9.)),
            RowDot::None if m.active => (theme.sidebar_accent, hex(colors::G300), px(10.)),
            _ => (gpui::transparent_black(), gpui::transparent_black(), px(0.)),
        };

        h_flex()
            .id(ElementId::Name(id))
            .group(group.clone())
            .h(px(sizes::ROW_HEIGHT))
            .pl(px(5.0))
            .pr(px(3.0))
            .gap(px(6.0))
            .items_center()
            .relative()
            .rounded(px(sizes::ROW_RADIUS))
            .cursor_pointer()
            .when_else(
                m.active,
                |d| d.bg(active_bg),
                |d| d.hover(|h| h.bg(white(0.035))),
            )
            .on_click(move |e, w, cx| (on_click)(e, w, cx))
            // kind tile：20×20 r5，2.5% 白底（exited 透明），kind 色 12px 图标
            .child(
                div()
                    .relative()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(20.0))
                    .rounded(px(5.0))
                    .when(!exited, |d| d.bg(white(0.025)))
                    .child(icon(m.kind.icon(), 12.0, kind_color))
                    // 状态角标：右下角半出外缘（-2,-2；overflow 默认可见）
                    .child(
                        div()
                            .absolute()
                            .right(px(-2.0))
                            .bottom(px(-2.0))
                            .size(dot_size)
                            .rounded_full()
                            .when(dot_size > px(0.), |d| {
                                d.bg(dot_bg).border_1().border_color(dot_border)
                            }),
                    ),
            )
            // 标题：12.5px；unread 600 + bright；exited 压灰；active 提亮
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .text_size(px(12.5))
                    .text_color(title_color)
                    .when(unread, |d| d.font_weight(gpui::FontWeight::SEMIBOLD))
                    .child(m.title.clone()),
            )
            // pin 图钉：标题后右缘 faint 12px
            .when(m.pinned, |d| {
                d.child(icon(IconName::Pin, 12.0, hex(colors::FAINT)))
            })
            // 「…」菜单槽固定 22px（不占位→位移；r8，hover 底 closeHover + 提亮；
            // 行 hover/active 时显示）。左键 / 右键都弹同一统一浮层菜单（原型
            // DropMenu + CtxMenu 同条目；受控态在 RootView，见 root.rs）
            .child({
                let entries = thread_menu_entries(m.pinned, m.unread);
                let (pinned, unread) = (m.pinned, m.unread);
                let on_menu_change = on_menu.clone();
                let menu_slot: SharedString = format!("menu-{}", m.id).into();
                let row_active = m.active;
                let trigger_group = group.clone();
                let muted_fg = theme.muted_foreground;
                Popover::new(ElementId::Name(format!("row-menu-{}", m.id).into()))
                    .open(menu_open)
                    .anchor(gpui::Anchor::TopLeft)
                    .offset(px(4.0))
                    .on_open_change(move |open, window, cx| on_menu_change(*open, window, cx))
                    .trigger(PopupTrigger::new(move |open| {
                        let on_menu_right = on_menu.clone();
                        div()
                            .id(ElementId::Name(menu_slot.clone()))
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(22.0))
                            .rounded(px(8.0))
                            .flex_shrink_0()
                            .opacity(0.0)
                            .hover(|h| h.bg(hex(colors::CLOSE_HOVER)))
                            .group_hover(trigger_group.clone(), |s| s.opacity(1.0))
                            .when(row_active, |d| d.opacity(1.0))
                            .child(
                                icon(IconName::More, 12.0, muted_fg)
                                    .hover(|s| s.text_color(hex(colors::TEXT_BRIGHT)))
                                    .when(open, |s| s.text_color(hex(colors::TEXT_BRIGHT))),
                            )
                            // 右键 = 左键同一菜单（原型行右键 CtxMenu）
                            .on_mouse_down(MouseButton::Right, move |_, window, cx| {
                                on_menu_right(true, window, cx)
                            })
                            .into_any_element()
                    }))
                    .content(move |_, _, cx| {
                        let popover = cx.entity();
                        let pick = on_pick.clone();
                        let pick_fn: PickFn = std::rc::Rc::new(move |id, w, cx| match id {
                            "pin" => pick(RowAction::SetPinned(!pinned), w, cx),
                            "rename" => pick(RowAction::Rename, w, cx),
                            "unread" => pick(RowAction::SetUnread(!unread), w, cx),
                            "remove" => pick(RowAction::Remove, w, cx),
                            _ => {}
                        });
                        menu_surface(&entries, &pick_fn, &popover).into_any_element()
                    })
            })
    }
}

#[derive(IntoElement)]
pub struct Sidebar {
    groups: Vec<GroupModel>,
    version: SharedString,
    /// 通知中心（铃铛浮层 + 未读徽标 + 动作回调），装配层投影注入
    notif: NotifSlot,
    /// 当前展开的侧栏菜单（行 / 工作区「…」），受控态在 RootView
    open_menu: Option<MenuTarget>,
    on_menu: MenuToggleFn,
    on_select: SelectFn,
    on_row: RowActionFn,
    on_add_workspace: WindowActionFn,
    on_settings: WindowActionFn,
    on_group: GroupActionFn,
    on_new_session: WindowActionFn,
    on_search: WindowActionFn,
    on_collapse: std::rc::Rc<dyn Fn(&mut App)>,
}
impl Sidebar {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        groups: Vec<GroupModel>,
        notif: NotifSlot,
        version: &str,
        open_menu: Option<MenuTarget>,
        on_menu: impl Fn(MenuTarget, bool, &mut Window, &mut App) + 'static,
        on_select: impl Fn(&str, &mut Window, &mut App) + 'static,
        on_row: impl Fn(&str, RowAction, &mut Window, &mut App) + 'static,
        on_add_workspace: impl Fn(&mut Window, &mut App) + 'static,
        on_settings: impl Fn(&mut Window, &mut App) + 'static,
        on_group: impl Fn(&str, GroupAction, &mut Window, &mut App) + 'static,
        on_new_session: impl Fn(&mut Window, &mut App) + 'static,
        on_search: impl Fn(&mut Window, &mut App) + 'static,
        on_collapse: impl Fn(&mut App) + 'static,
    ) -> Self {
        Self {
            groups,
            version: format!("v{version}").into(),
            notif,
            open_menu,
            on_menu: std::rc::Rc::new(on_menu),
            on_select: std::rc::Rc::new(on_select),
            on_row: std::rc::Rc::new(on_row),
            on_add_workspace: std::rc::Rc::new(on_add_workspace),
            on_settings: std::rc::Rc::new(on_settings),
            on_group: std::rc::Rc::new(on_group),
            on_new_session: std::rc::Rc::new(on_new_session),
            on_search: std::rc::Rc::new(on_search),
            on_collapse: std::rc::Rc::new(on_collapse),
        }
    }
}

/// ghost 钮（原型 .ghost：24×24 r8；ws-head 内 0→hover 1）。
/// `resting_opacity`：sec-head 内 0.75，ws-head 内 0。
#[allow(clippy::too_many_arguments)]
fn ghost_cell(
    id: SharedString,
    ic: IconName,
    group: SharedString,
    resting_opacity: f32,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .id(ElementId::Name(id))
        .flex()
        .items_center()
        .justify_center()
        .size(px(24.0))
        .rounded(px(8.0))
        .cursor_pointer()
        .opacity(resting_opacity)
        .hover(|h| h.bg(hex(colors::SURFACE)))
        .group_hover(group, |s| s.opacity(1.0))
        .child(icon(ic, 12.0, hex(colors::MUTED)))
        .on_click(move |_, w, cx| on_click(w, cx))
}

/// 「显示另外 N 个/收起会话」行内链接（原型 .more-link：h27 padl 7 gap 5 r5）
fn more_link(
    id: SharedString,
    expanded: bool,
    hidden: usize,
    group_id: &str,
    on_group: &GroupActionFn,
) -> impl IntoElement {
    let cb = on_group.clone();
    let gid = group_id.to_owned();
    h_flex()
        .id(ElementId::Name(id))
        .h(px(27.0))
        .pl(px(7.0))
        .pr(px(7.0))
        .gap(px(5.0))
        .items_center()
        .rounded(px(5.0))
        .cursor_pointer()
        .hover(|h| h.bg(white(0.025)))
        .child(icon(
            if expanded {
                IconName::ChevronUp
            } else {
                IconName::ChevronDown
            },
            11.0,
            hex(colors::MUTED),
        ))
        .child(
            div()
                .text_size(px(11.0))
                .text_color(hex(colors::MUTED))
                .child(if expanded {
                    SharedString::from("收起会话")
                } else {
                    format!("显示另外 {hidden} 个").into()
                }),
        )
        .on_click(move |_, window, cx| {
            cb(&gid, GroupAction::SetShowAll(!expanded), window, cx);
        })
}

impl RenderOnce for Sidebar {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let muted = theme.muted_foreground;
        let fg = theme.sidebar_foreground;
        let border_subtle = hex(colors::BORDER_SUBTLE);

        // ── 头（原型 .sb-head：46px + 底 1px 3.5% 白分隔线；mac 红绿灯让位 78 + 收起钮）──
        let header = h_flex()
            .id("sidebar-header")
            .h(px(sizes::SIDEBAR_HEAD_HEIGHT))
            .flex_shrink_0()
            .items_center()
            .bg(theme.sidebar)
            .border_b_1()
            .border_color(white(0.035))
            .pl(px(78.0))
            .child(
                div()
                    .id("sidebar-collapse")
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(28.0))
                    .rounded(px(8.0))
                    .cursor_pointer()
                    .hover(|h| h.bg(hex(colors::SURFACE)))
                    .child(icon(IconName::PanelLeft, 16.0, muted))
                    .on_click({
                        let cb = self.on_collapse.clone();
                        move |_, _, cx| cb(cx)
                    }),
            );

        // ── nav 行组（原型 .sb-nav：pad 8 gap 2 + 底部分隔线，固定不滚）──
        let on_new = self.on_new_session.clone();
        let on_search = self.on_search.clone();
        let nav = v_flex()
            .flex_shrink_0()
            .gap(px(2.0))
            .p(px(8.0))
            .border_b_1()
            .border_color(border_subtle)
            .child(
                h_flex()
                    .id("nav-new-chat")
                    .group("nav-new")
                    .h(px(34.0))
                    .pl(px(9.0))
                    .pr(px(9.0))
                    .gap(px(8.0))
                    .items_center()
                    .rounded(px(sizes::ROW_RADIUS))
                    .cursor_pointer()
                    .hover(|h| h.bg(hex(colors::SURFACE)))
                    .child(
                        div()
                            .w(px(16.0))
                            .flex()
                            .justify_center()
                            .flex_shrink_0()
                            .child(
                                icon(IconName::Plus, 14.0, muted).group_hover("nav-new", |s| {
                                    s.text_color(hex(colors::TEXT_BRIGHT))
                                }),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(fg)
                            .group_hover("nav-new", |s| s.text_color(hex(colors::TEXT_BRIGHT)))
                            .child("新建会话"),
                    )
                    .on_click(move |_, w, cx| on_new(w, cx)),
            )
            .child(
                h_flex()
                    .id("nav-search")
                    .group("nav-search")
                    .h(px(34.0))
                    .pl(px(9.0))
                    .pr(px(9.0))
                    .gap(px(8.0))
                    .items_center()
                    .rounded(px(sizes::ROW_RADIUS))
                    .cursor_pointer()
                    .hover(|h| h.bg(hex(colors::SURFACE)))
                    .child(
                        div()
                            .w(px(16.0))
                            .flex()
                            .justify_center()
                            .flex_shrink_0()
                            .child(
                                icon(IconName::Search, 14.0, muted)
                                    .group_hover("nav-search", |s| {
                                        s.text_color(hex(colors::TEXT_BRIGHT))
                                    }),
                            ),
                    )
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(fg)
                            .group_hover("nav-search", |s| s.text_color(hex(colors::TEXT_BRIGHT)))
                            .child("搜索"),
                    )
                    .on_click(move |_, w, cx| on_search(w, cx)),
            );

        // ── 区头「工作区」（原型 .sec-head：mt 12 pad 6 5 4 9 min-h 28；10px/600 + ghost ＋）──
        let section = h_flex()
            .id("section-workspaces")
            .group("sec-head")
            .flex_shrink_0()
            .min_h(px(28.0))
            .mt(px(12.0))
            .pl(px(9.0))
            .pr(px(5.0))
            .pt(px(6.0))
            .pb(px(4.0))
            .items_center()
            .child(
                div()
                    .text_size(px(10.0))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(muted)
                    .child("工作区"),
            )
            .child(div().flex_1())
            .child(
                div()
                    .id("add-workspace")
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(24.0))
                    .rounded(px(8.0))
                    .cursor_pointer()
                    .opacity(0.75)
                    .hover(|h| h.bg(hex(colors::SURFACE)))
                    .group_hover("sec-head", |s| s.opacity(1.0))
                    .child(icon(IconName::Plus, 12.0, muted))
                    .on_click({
                        let cb = self.on_add_workspace.clone();
                        move |_, w, cx| cb(w, cx)
                    }),
            );

        // ── 滚动区（原型 .sb-scroll：pad 2 8 8；只装分组）──
        let scroll = v_flex()
            .id("sb-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .pl(px(sizes::ROW_MARGIN_X))
            .pr(px(sizes::ROW_MARGIN_X))
            .pt(px(2.0))
            .pb(px(8.0))
            .children(self.groups.into_iter().map(|g| {
                let group_key: SharedString = format!("ws-{}", g.id).into();
                let ws_row = h_flex()
                    .id(ElementId::Name(format!("workspace-{}", g.id).into()))
                    .group(group_key.clone())
                    .h(px(34.0))
                    .pl(px(5.0))
                    .pr(px(50.0))
                    .gap(px(7.0))
                    .items_center()
                    .flex_1()
                    .min_w_0()
                    .rounded(px(sizes::ROW_RADIUS))
                    .cursor_pointer()
                    .hover(|h| h.bg(white(0.035)))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(22.0))
                            .rounded(px(5.0))
                            .flex_shrink_0()
                            .child(
                                icon(
                                    if g.unassigned {
                                        IconName::Inbox
                                    } else {
                                        IconName::Folder
                                    },
                                    13.0,
                                    muted,
                                )
                                .group_hover(group_key.clone(), |s| s.text_color(fg)),
                            ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_size(px(12.5))
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .text_color(fg)
                            .child(g.name.clone()),
                    );

                let (ws_row, acts) = if g.unassigned {
                    // 未归属虚拟组：纯展示恒展开，无折叠/ghost/菜单
                    (ws_row.cursor_default(), None)
                } else {
                    let gid = g.id.clone();
                    let on_group = self.on_group.clone();
                    let row = ws_row.on_click(move |_, window, cx| {
                        on_group(&gid, GroupAction::ToggleExpanded, window, cx)
                    });
                    // 行本体右键 = 「…」同一菜单（原型 ws-row CtxMenu）
                    let (gid_right, on_menu_right) = (g.id.clone(), self.on_menu.clone());
                    let row = row.on_mouse_down(MouseButton::Right, move |_, window, cx| {
                        on_menu_right(MenuTarget::Workspace(gid_right.clone()), true, window, cx)
                    });
                    // .acts：absolute right 3 top 5——「…」工作区菜单 + ＋ 新建会话。
                    // 「…」左键 / 右键弹统一浮层（受控态在 RootView）
                    let on_new_in_ws = self.on_new_session.clone();
                    let ws_menu_open = self.open_menu == Some(MenuTarget::Workspace(g.id.clone()));
                    let (entries, pinned) = (ws_menu_entries(g.pinned), g.pinned);
                    let (on_menu_change, on_menu_right_btn) =
                        (self.on_menu.clone(), self.on_menu.clone());
                    let (menu_gid, menu_gid2) = (g.id.clone(), g.id.clone());
                    let trigger_group = group_key.clone();
                    let menu_cell =
                        Popover::new(ElementId::Name(format!("ws-menu-{}", g.id).into()))
                            .open(ws_menu_open)
                            .anchor(gpui::Anchor::TopLeft)
                            .offset(px(4.0))
                            .on_open_change({
                                let on_menu = on_menu_change.clone();
                                let gid = menu_gid.clone();
                                move |open, window, cx| {
                                    on_menu(MenuTarget::Workspace(gid.clone()), *open, window, cx)
                                }
                            })
                            .trigger(PopupTrigger::new(move |open| {
                                div()
                                    .id(ElementId::Name(
                                        format!("menu-workspace-{}", menu_gid2).into(),
                                    ))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .size(px(24.0))
                                    .rounded(px(8.0))
                                    .cursor_pointer()
                                    .opacity(if open { 1.0 } else { 0.0 })
                                    .hover(|h| h.bg(hex(colors::SURFACE)))
                                    .group_hover(trigger_group.clone(), |s| s.opacity(1.0))
                                    .child(icon(
                                        IconName::More,
                                        12.0,
                                        if open {
                                            hex(colors::TEXT_BRIGHT)
                                        } else {
                                            hex(colors::MUTED)
                                        },
                                    ))
                                    .on_mouse_down(MouseButton::Right, {
                                        let on_menu = on_menu_right_btn.clone();
                                        let gid = menu_gid.clone();
                                        move |_, window, cx| {
                                            on_menu(
                                                MenuTarget::Workspace(gid.clone()),
                                                true,
                                                window,
                                                cx,
                                            )
                                        }
                                    })
                                    .into_any_element()
                            }))
                            .content({
                                let on_group = self.on_group.clone();
                                let gid = g.id.clone();
                                move |_, _, cx| {
                                    let popover = cx.entity();
                                    let (on_group, gid) = (on_group.clone(), gid.clone());
                                    let pick_fn: PickFn =
                                        std::rc::Rc::new(move |id: &str, window, cx| match id {
                                            "pin" => on_group(
                                                &gid,
                                                GroupAction::SetPinned(!pinned),
                                                window,
                                                cx,
                                            ),
                                            "rename" => {
                                                on_group(&gid, GroupAction::Rename, window, cx)
                                            }
                                            "remove" => {
                                                on_group(&gid, GroupAction::Remove, window, cx)
                                            }
                                            _ => {}
                                        });
                                    menu_surface(&entries, &pick_fn, &popover).into_any_element()
                                }
                            });
                    let acts = div()
                        .absolute()
                        .right(px(3.0))
                        .top(px(5.0))
                        .flex()
                        .flex_shrink_0()
                        .child(menu_cell)
                        .child(ghost_cell(
                            format!("new-menu-{}", g.id).into(),
                            IconName::Plus,
                            group_key.clone(),
                            0.0,
                            move |w, cx| on_new_in_ws(w, cx),
                        ));
                    (row, Some(acts))
                };

                let ws_head = div()
                    .relative()
                    .flex()
                    .flex_shrink_0()
                    .child(ws_row)
                    .when_some(acts, |d, a| d.child(a));

                let mut group = v_flex().mb(px(3.0)).child(ws_head);
                if g.expanded {
                    // .ws-body：margin 1 0 5 12 + 左 1px 6% 白引导线
                    let mut body = v_flex()
                        .ml(px(12.0))
                        .mt(px(1.0))
                        .mb(px(5.0))
                        .border_l_1()
                        .border_color(white(0.06));
                    if g.rows.is_empty() && !g.unassigned {
                        // 空组引导（原型 .ws-empty-hint：h28 pad 0 7 gap 6 r5）
                        let on_new_in_ws = self.on_new_session.clone();
                        body = body.child(
                            h_flex()
                                .id(ElementId::Name(
                                    format!("workspace-create-first-{}", g.id).into(),
                                ))
                                .h(px(28.0))
                                .pl(px(7.0))
                                .pr(px(7.0))
                                .gap(px(6.0))
                                .items_center()
                                .rounded(px(5.0))
                                .cursor_pointer()
                                .hover(|h| h.bg(white(0.035)))
                                .child(icon(IconName::Plus, 11.0, muted))
                                .child(
                                    div()
                                        .text_size(px(11.5))
                                        .text_color(muted)
                                        .child("启动第一个会话"),
                                )
                                .on_click(move |_, w, cx| on_new_in_ws(w, cx)),
                        );
                    } else {
                        let rows_len = g.rows.len();
                        let on_select = self.on_select.clone();
                        let on_row = self.on_row.clone();
                        let on_menu_rows = self.on_menu.clone();
                        let open_menu = self.open_menu.clone();
                        body = body.children(g.rows.into_iter().map(move |r| {
                            let sid = r.id.clone();
                            let rid = sid.clone();
                            let on_select = on_select.clone();
                            let on_row = on_row.clone();
                            let pick: RowPick =
                                std::rc::Rc::new(move |a, w, cx| on_row(&rid, a, w, cx));
                            let menu_open = matches!(open_menu,
                                Some(MenuTarget::Row(ref id)) if *id == r.id);
                            let on_menu_row: MenuOpenFn = {
                                let (on_menu_rows, mid) = (on_menu_rows.clone(), r.id.clone());
                                std::rc::Rc::new(move |open, w, cx| {
                                    on_menu_rows(MenuTarget::Row(mid.clone()), open, w, cx)
                                })
                            };
                            ThreadRow::new(
                                r,
                                menu_open,
                                on_menu_row,
                                std::rc::Rc::new(move |_, w, cx| on_select(&sid, w, cx)),
                                pick,
                            )
                        }));
                        if g.hidden > 0 {
                            body = body.child(more_link(
                                format!("load-more-{}", g.id).into(),
                                false,
                                g.hidden,
                                &g.id,
                                &self.on_group,
                            ));
                        } else if rows_len > COLLAPSED_ROWS && g.expanded && !g.unassigned {
                            body = body.child(more_link(
                                format!("load-more-{}", g.id).into(),
                                true,
                                0,
                                &g.id,
                                &self.on_group,
                            ));
                        }
                    }
                    group = group.child(body);
                }
                group
            }));

        // ── 脚（原型 .sb-foot：pad 8 gap 2 + 顶部分隔线）：齿轮 + 铃铛（未读红点）+ 版本号 ──
        let foot = h_flex()
            .flex_shrink_0()
            .gap(px(2.0))
            .p(px(8.0))
            .border_t_1()
            .border_color(border_subtle)
            .items_center()
            .child(
                div()
                    .id("open-settings")
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(28.0))
                    .rounded(px(8.0))
                    .cursor_pointer()
                    .hover(|h| h.bg(hex(colors::SURFACE)))
                    .child(icon(IconName::Gear, 16.0, muted))
                    .on_click({
                        let cb = self.on_settings.clone();
                        move |_, w, cx| cb(w, cx)
                    }),
            )
            // 铃铛 = 通知中心浮层锚点（V2 · D8：向上弹出，浮层与数据在 notif_center）
            .child(crate::views::notif_center::bell_popover(
                crate::views::notif_center::NotifSlot {
                    models: self.notif.models,
                    unread: self.notif.unread,
                    on_open: self.notif.on_open,
                    on_read_all: self.notif.on_read_all,
                },
            ))
            .child(div().flex_1())
            .child(
                div()
                    .text_size(px(11.0))
                    .text_color(hex(colors::FAINT))
                    .child(self.version.clone()),
            );

        v_flex()
            .id("sidebar")
            .w_full()
            .h_full()
            .flex_shrink_0()
            .bg(theme.sidebar)
            .border_r_1()
            .border_color(border_subtle)
            .child(header)
            .child(nav)
            .child(section)
            .child(scroll)
            .child(foot)
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
        assert_eq!(a.rows[0].dot, RowDot::Need);
        assert!(a.rows[1].active && !a.rows[0].active);
        assert_eq!(a.rows[1].kind, RowKind::Terminal);
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
    #[test]
    fn active_row_beyond_the_limit_is_never_truncated() {
        let workspaces = vec![ws("a", "A", 1)];
        let threads: Vec<Thread> = (0..7)
            .map(|i| term(&format!("t{i}"), "a", i, |_| {}))
            .collect();
        // 排序为新→旧：t0 排末位。默认前 4 条不含 t0——active 时 lim 扩展包含它
        let g = build_groups(&workspaces, &threads, Some("t0"));
        assert!(g[0].rows.iter().any(|r| r.id == "t0"), "active 行不被截断");
        assert_eq!(g[0].rows.len(), 7);
        let inactive = build_groups(&workspaces, &threads, None);
        assert_eq!(inactive[0].rows.len(), COLLAPSED_ROWS);
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
    fn unattached_threads_form_the_unassigned_virtual_group_last() {
        let workspaces = vec![ws("a", "A", 1)];
        let mut orphan = term("orphan", "a", 1, |_| {});
        orphan.common_mut().workspace_id = None;
        let threads = vec![term("a", "a", 1, |_| {}), orphan];
        let g = build_groups(&workspaces, &threads, None);
        assert_eq!(g.len(), 2);
        assert_eq!(
            g[0].rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["a"]
        );
        let u = &g[1];
        assert!(u.unassigned && u.expanded);
        assert_eq!(
            u.rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["orphan"]
        );
    }
    #[test]
    fn row_dot_priority_is_stable() {
        let dot = |f: &dyn Fn(&mut TerminalThread)| RowDot::of(&term("t", "a", 0, |t| f(t)));
        // terminal 存活 ≠ 在工作：running 不显示点
        assert_eq!(dot(&|_| {}), RowDot::None);
        assert_eq!(dot(&|t| t.status = RunStatus::Exited), RowDot::Exited);
        assert_eq!(dot(&|t| t.common.unread = true), RowDot::Unread);
        assert_eq!(
            dot(&|t| {
                t.has_bell = true;
                t.status = RunStatus::Exited
            }),
            RowDot::Exited
        );
        assert_eq!(dot(&|t| t.has_bell = true), RowDot::Need);
    }
    #[test]
    fn chat_dot_covers_pending_reply_and_unread() {
        let chat = |unread, pending| {
            Thread::Chat(ChatThread {
                id: "c".into(),
                title: "Chat".into(),
                created_at: 0,
                messages: vec![],
                pending_reply: pending,
                common: ThreadCommon {
                    unread,
                    ..Default::default()
                },
            })
        };
        assert_eq!(RowDot::of(&chat(false, false)), RowDot::None);
        assert_eq!(RowDot::of(&chat(false, true)), RowDot::Running);
        assert_eq!(RowDot::of(&chat(true, false)), RowDot::Unread);
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

    /// 菜单条目与原型 threadMenuItems / wsMenuItems 逐项对齐：
    /// pin/unread 文案随状态翻转，remove 是 danger，中间一条分隔线。
    #[test]
    fn thread_and_ws_menu_entries_match_the_prototype_items() {
        use crate::views::popup::MenuEntry;
        let entries = thread_menu_entries(false, false);
        assert_eq!(entries.len(), 5);
        assert_eq!(entries[0], MenuEntry::item("pin", "置顶"));
        assert_eq!(entries[2], MenuEntry::item("unread", "标记为未读"));
        assert_eq!(entries[3], MenuEntry::Separator);
        match &entries[4] {
            MenuEntry::Item(m) => {
                assert_eq!(m.id, "remove");
                assert!(m.danger, "移除是 danger 项");
            }
            other => panic!("末项应为条目：{other:?}"),
        } // 状态翻转：pin 过 → 取消置顶；未读 → 标记为已读
        assert_eq!(
            thread_menu_entries(true, true)[0],
            MenuEntry::item("pin", "取消置顶")
        );
        assert_eq!(
            thread_menu_entries(true, true)[2],
            MenuEntry::item("unread", "标记为已读")
        );

        let ws = ws_menu_entries(false);
        assert_eq!(ws[0], MenuEntry::item("pin", "置顶工作区"));
        assert_eq!(ws[3], MenuEntry::danger("remove", "移除工作区"));
        assert_eq!(
            ws_menu_entries(true)[0],
            MenuEntry::item("pin", "取消置顶工作区")
        );
    }
}
