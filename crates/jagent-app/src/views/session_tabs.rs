//! 会话内副页签条（对应旧 `plane/SessionTabs.tsx`，顶栏第二行 #tb-tabs 的内容）：
//! 主面 tab（kind 图标 + 状态点 + 标题，不可关）+ 各 SessionView tab（可关，
//! 中键或 ×）+「+」。
//!
//! 规则在 core（`activate_session_view` / `close_session_view` /
//! `begin|finish_add_session_shell`）；这里只把 `ThreadCommon` 投影成
//! [`TabModel`]，并把点击翻译成回调。
//!
//! 与旧版的差异（记入 gpui-rewrite.md）：「+」直接新建 Shell，不再弹
//! 「打开 Git 图 / 新建 Shell / 打开文件」浮层（浮层系统待接）。

use std::rc::Rc;

use gpui::{
    App, ElementId, InteractiveElement, IntoElement, MouseButton, ParentElement, Pixels,
    RenderOnce, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_component::h_flex;
use jagent_core::threads::{MAIN_VIEW_ID, RunStatus, SessionView, Thread};

use crate::icons::{IconName, icon};
use crate::theme::{Tokens, colors, hex};

/// tab 头图标（thread kind × SessionView kind）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabIcon {
    Terminal,
    Chat,
    Acp,
    Git,
    File,
}
impl TabIcon {
    fn of_thread(t: &Thread) -> Self {
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
            Self::Git => IconName::GitBranch,
            Self::File => IconName::File,
        }
    }
}

/// tab 状态点（主面 tab 复用侧栏 D12 语义；idle/exited 不画）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabDot {
    Running,
    Need,
    Unread,
}
impl TabDot {
    fn color(self, tokens: &Tokens) -> gpui::Hsla {
        match self {
            Self::Running => tokens.status_running,
            Self::Need => tokens.status_need,
            Self::Unread => hex(colors::MUTED),
        }
    }
    /// 进行中/待确认 = 7px + 3px 光晕；unread = 7px muted 实心
    fn size(self) -> Pixels {
        px(7.0)
    }
}

/// 一个 tab 的展示数据（纯数据，便于测试）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabModel {
    /// `MAIN_VIEW_ID` 或 SessionView 的 id
    pub id: String,
    pub title: String,
    pub icon: TabIcon,
    pub dot: Option<TabDot>,
    pub active: bool,
    /// 主面不可关
    pub closable: bool,
    /// 退出的 shell：标题压灰
    pub exited: bool,
}

/// 主面 tab 的状态点（ThreadRow 的 statusDot 同语义）
fn thread_dot(t: &Thread) -> Option<TabDot> {
    match t {
        Thread::Terminal(term) => {
            if term.status == RunStatus::Exited {
                None
            } else if term.has_bell {
                Some(TabDot::Need)
            } else if t.common().unread {
                Some(TabDot::Unread)
            } else {
                None
            }
        }
        Thread::Chat(c) => {
            if c.pending_reply {
                Some(TabDot::Running)
            } else if t.common().unread {
                Some(TabDot::Unread)
            } else {
                None
            }
        }
        Thread::Acp(a) => {
            if a.pending_reply {
                Some(TabDot::Running)
            } else if t.common().unread {
                Some(TabDot::Unread)
            } else {
                None
            }
        }
    }
}

/// 顶栏内联副视图最大直接展示数量（不含主视图 tab）；超出项折叠进 `[+N ▾]` 胶囊。
pub const MAX_INLINE_VIEWS: usize = 2;

/// 将完整的 tab 列表切分为「顶栏直接可见的 tabs」与「折叠进 [+N ▾] 的溢出 tabs」。
/// 规则：
/// - 主视图（`tabs[0]`）始终在可见列表首位；
/// - 若副视图数量 `<= max_inline_views`，全部直接展示，溢出列表为空；
/// - 若副视图数量 `> max_inline_views`，默认取前 `max_inline_views` 个；
///   若当前激活的副视图不在前 `max_inline_views` 个中，则将其置换到可见列表最后一个槽位。
pub fn visible_and_overflow_tabs(
    tabs: &[TabModel],
    max_inline_views: usize,
) -> (Vec<TabModel>, Vec<TabModel>) {
    if tabs.len() <= 1 + max_inline_views {
        return (tabs.to_vec(), Vec::new());
    }
    let main_tab = tabs[0].clone();
    let views = &tabs[1..];
    let mut visible_views: Vec<TabModel> = views.iter().take(max_inline_views).cloned().collect();
    if max_inline_views > 0
        && let Some(active_view) = views.iter().find(|t| t.active)
        && !visible_views.iter().any(|t| t.id == active_view.id)
    {
        visible_views[max_inline_views - 1] = active_view.clone();
    }
    let overflow_views: Vec<TabModel> = views
        .iter()
        .filter(|t| !visible_views.iter().any(|v| v.id == t.id))
        .cloned()
        .collect();
    let mut visible = Vec::with_capacity(1 + visible_views.len());
    visible.push(main_tab);
    visible.extend(visible_views);
    (visible, overflow_views)
}

/// 从会话投影出 tab 列表：主面第一，其后按创建序排列各视图。
pub fn tab_models(thread: &Thread) -> Vec<TabModel> {
    let c = thread.common();
    let active = c.active_view_id.as_deref().unwrap_or(MAIN_VIEW_ID);
    let mut out = vec![TabModel {
        id: MAIN_VIEW_ID.to_owned(),
        title: thread.title(),
        icon: TabIcon::of_thread(thread),
        dot: thread_dot(thread),
        active: active == MAIN_VIEW_ID,
        closable: false,
        exited: thread
            .as_terminal()
            .is_some_and(|t| t.status == RunStatus::Exited),
    }];
    out.extend(c.views.iter().map(|v| {
        let (icon, dot, exited) = match v {
            SessionView::Git { .. } => (TabIcon::Git, None, false),
            SessionView::File { .. } => (TabIcon::File, None, false),
            SessionView::Shell(s) => (
                TabIcon::Terminal,
                s.has_bell.then_some(TabDot::Need),
                s.status == RunStatus::Exited,
            ),
        };
        TabModel {
            id: v.id().to_owned(),
            title: v.title().to_owned(),
            icon,
            dot,
            active: active == v.id(),
            closable: true,
            exited,
        }
    }));
    out
}

type TabFn = Rc<dyn Fn(&str, &mut Window, &mut App)>;
type AddFn = Rc<dyn Fn(&mut Window, &mut App)>;

/// 单个内联胶囊 tab（h26 / max-w 200 / r6 pad 0 9（closable 右 5）；
/// active = surfaceActive + borderSubtle 边；hover = surface）
fn tab(
    t: TabModel,
    tokens: &Tokens,
    on_activate: TabFn,
    on_close: Option<TabFn>,
) -> impl IntoElement {
    let group: gpui::SharedString = format!("tab-{}", t.id).into();
    let active_icon_color = match t.icon {
        TabIcon::Terminal => tokens.terminal_kind,
        TabIcon::Chat => hex(colors::ACCENT),
        TabIcon::Acp => tokens.acp_kind,
        TabIcon::Git => hex(colors::ACCENT_HOVER),
        TabIcon::File => hex(colors::CYAN),
    };
    let el = h_flex()
        .id(ElementId::Name(format!("tab-{}", t.id).into()))
        .group(group.clone())
        .h(px(24.0))
        .max_w(px(190.0))
        .min_w_0()
        .flex_shrink(1.)
        .pl(px(9.0))
        .pr(px(if t.closable { 5.0 } else { 9.0 }))
        .gap(px(5.0))
        .items_center()
        .rounded(px(5.0))
        .cursor_pointer()
        .when_else(
            t.active,
            |d| d.bg(hex(colors::SURFACE_ACTIVE)),
            |d| d.hover(|h| h.bg(hex(colors::SURFACE))),
        )
        // 图标 12.5：active 取语义色 / 其余 muted
        .child(icon(
            t.icon.icon(),
            12.5,
            if t.active {
                active_icon_color
            } else {
                hex(colors::MUTED)
            },
        ))
        // 状态点
        .when_some(t.dot, |d, dot| {
            d.child(div().size(dot.size()).rounded_full().bg(dot.color(tokens)))
        })
        // 标题 11.5px：exited 压灰 / active 提亮 / muted；hover text 由 group_hover
        .child(
            div()
                .min_w_0()
                .flex_1()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_size(px(11.5))
                .when(t.active, |d| d.font_weight(gpui::FontWeight::MEDIUM))
                .text_color(if t.exited {
                    tokens.exited
                } else if t.active {
                    hex(colors::TEXT_BRIGHT)
                } else {
                    hex(colors::MUTED)
                })
                .group_hover(group.clone(), |s| {
                    if t.active || t.exited {
                        s
                    } else {
                        s.text_color(hex(colors::TEXT))
                    }
                })
                .child(t.title.clone()),
        );
    let tab_id = t.id.clone();
    let el = crate::views::root::stop_titlebar_drag(el)
        .on_click(move |_, w, cx| on_activate(&tab_id, w, cx));
    // 中键关闭（原型 onMouseDown button===1）

    if t.closable {
        let on_close = on_close.expect("closable tab 必须带关闭回调");
        let (on_mid, on_x) = (on_close.clone(), on_close);
        let mid_id = t.id.clone();
        let x_id = t.id.clone();
        el.on_mouse_down(MouseButton::Middle, move |_, w, cx| {
            cx.stop_propagation();
            on_mid(&mid_id, w, cx);
        })
        // × 钮（原型 .tx：20×20 r4；hover/active 显；hover 底 closeHover）
        .child(crate::views::root::stop_titlebar_drag(
            div()
                .id(ElementId::Name(format!("tab-close-{}", t.id).into()))
                .flex()
                .items_center()
                .justify_center()
                .size(px(20.0))
                .rounded(px(4.0))
                .flex_shrink_0()
                .opacity(0.0)
                .hover(|h| h.bg(hex(colors::CLOSE_HOVER)))
                .group_hover(group, |s| s.opacity(1.0))
                .when(t.active, |d| d.opacity(1.0))
                .child(
                    icon(IconName::Close, 11.0, hex(colors::MUTED))
                        .hover(|s| s.text_color(hex(colors::TEXT_BRIGHT))),
                )
                .on_click(move |_, w, cx| {
                    cx.stop_propagation();
                    on_x(&x_id, w, cx);
                }),
        ))
    } else {
        el
    }
}

/// 副页签条。回调只携带 view id；调用方负责落到 AppState。
#[derive(IntoElement)]
pub struct SessionTabs {
    tabs: Vec<TabModel>,
    on_activate: TabFn,
    on_close: TabFn,
    on_add: AddFn,
    on_overflow: Option<AddFn>,
}

impl SessionTabs {
    pub fn new(
        tabs: Vec<TabModel>,
        on_activate: impl Fn(&str, &mut Window, &mut App) + 'static,
        on_close: impl Fn(&str, &mut Window, &mut App) + 'static,
        on_add: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            tabs,
            on_activate: Rc::new(on_activate),
            on_close: Rc::new(on_close),
            on_add: Rc::new(on_add),
            on_overflow: None,
        }
    }

    pub fn with_on_overflow(
        mut self,
        on_overflow: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_overflow = Some(Rc::new(on_overflow));
        self
    }
}

impl RenderOnce for SessionTabs {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let tokens = cx.global::<Tokens>().clone();
        let (on_activate, on_close, on_add, on_overflow) = (
            self.on_activate,
            self.on_close,
            self.on_add,
            self.on_overflow,
        );
        let (visible_tabs, overflow_tabs) = visible_and_overflow_tabs(&self.tabs, MAX_INLINE_VIEWS);
        let overflow_count = overflow_tabs.len();
        let next_overflow_id = overflow_tabs.first().map(|t| t.id.clone());
        let on_activate_overflow = on_activate.clone();
        let on_add_overflow = on_add.clone();

        crate::views::root::stop_titlebar_drag(
            h_flex()
                .id("session-tabs")
                .p(px(2.0))
                .gap(px(2.0))
                .items_center()
                .overflow_x_hidden()
                .rounded(px(7.0))
                .bg(hex(colors::INPUT_BG))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE)),
        )
        .children(visible_tabs.into_iter().map(|t| {
            let (act, close) = (on_activate.clone(), on_close.clone());
            let closable = t.closable;
            tab(t, &tokens, act, closable.then_some(close))
        }))
        // 溢出收纳胶囊 [+N ▾]
        .when(overflow_count > 0, |d| {
            d.child(crate::views::root::stop_titlebar_drag(
                h_flex()
                    .id("session-tabs-overflow")
                    .h(px(22.0))
                    .pl(px(7.0))
                    .pr(px(6.0))
                    .gap(px(3.0))
                    .items_center()
                    .rounded(px(5.0))
                    .flex_shrink_0()
                    .cursor_pointer()
                    .bg(crate::theme::accent_alpha(0.16))
                    .border_1()
                    .border_color(crate::theme::accent_alpha(0.38))
                    .hover(|h| {
                        h.bg(crate::theme::accent_alpha(0.28))
                            .border_color(hex(colors::ACCENT_HOVER))
                    })
                    .child(
                        div()
                            .font_family("monospace")
                            .text_size(px(10.5))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(hex(colors::ACCENT_HOVER))
                            .child(format!("+{overflow_count}")),
                    )
                    .child(icon(IconName::ChevronDown, 10.5, hex(colors::ACCENT_HOVER)))
                    .on_click(move |_, w, cx| {
                        if let Some(ref cb) = on_overflow {
                            cb(w, cx);
                        } else if let Some(ref vid) = next_overflow_id {
                            on_activate_overflow(vid, w, cx);
                        } else {
                            on_add_overflow(w, cx);
                        }
                    }),
            ))
        })
        // 「+」（内联副视图新建钮：24×24 r5；plus 13.5；hover surface）
        .child(crate::views::root::stop_titlebar_drag(
            div()
                .id("session-add")
                .group("tab-add")
                .flex()
                .items_center()
                .justify_center()
                .size(px(24.0))
                .rounded(px(5.0))
                .flex_shrink_0()
                .cursor_pointer()
                .hover(|h| h.bg(hex(colors::SURFACE)))
                .child(
                    icon(IconName::Plus, 13.5, hex(colors::MUTED))
                        .group_hover("tab-add", |s| s.text_color(hex(colors::TEXT_BRIGHT))),
                )
                .on_click(move |_, w, cx| on_add(w, cx)),
        ))
    }
}

/// 非终端路由的内联上下文胶囊（settings / chat / acp / home 上下文）。
#[derive(IntoElement)]
pub struct ContextTab {
    icon: IconName,
    label: gpui::SharedString,
}
impl ContextTab {
    pub fn new(icon: IconName, label: impl Into<gpui::SharedString>) -> Self {
        Self {
            icon,
            label: label.into(),
        }
    }
}
impl RenderOnce for ContextTab {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let tokens = cx.global::<Tokens>().clone();
        let ic_color = match self.icon {
            IconName::Terminal => tokens.terminal_kind,
            IconName::Chat => hex(colors::ACCENT),
            IconName::Acp => tokens.acp_kind,
            _ => hex(colors::ACCENT_HOVER),
        };
        crate::views::root::stop_titlebar_drag(
            h_flex()
                .id("tab-context")
                .h(px(26.0))
                .max_w(px(200.0))
                .min_w_0()
                .pl(px(9.0))
                .pr(px(9.0))
                .gap(px(5.0))
                .items_center()
                .rounded(px(6.0))
                .bg(hex(colors::SURFACE_ACTIVE))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .shadow_sm(),
        )
        .child(icon(self.icon, 13.0, ic_color))
        .child(
            div()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_size(px(12.0))
                .text_color(hex(colors::TEXT_BRIGHT))
                .child(self.label),
        )
    }
}

#[cfg(test)]
mod tests {
    use jagent_core::threads::*;

    use super::*;

    fn shell(id: &str, status: RunStatus) -> SessionView {
        SessionView::Shell(ShellView {
            id: id.into(),
            label: format!("Shell {id}"),
            session_id: 9,
            cwd: "/".into(),
            osc_title: None,
            has_bell: false,
            status,
            exit_code: None,
        })
    }

    fn thread_with(views: Vec<SessionView>, active: Option<&str>) -> Thread {
        Thread::Terminal(TerminalThread {
            id: "t1".into(),
            session_id: 1,
            preset: None,
            cwd: "/".into(),
            init_command: Some("zsh".into()),
            osc_title: None,
            custom_title: None,
            status: RunStatus::Running,
            exit_code: None,
            has_bell: false,
            created_at: 0,
            common: ThreadCommon {
                views,
                active_view_id: active.map(str::to_owned),
                ..Default::default()
            },
        })
    }

    #[test]
    fn main_tab_comes_first_is_unclosable_and_the_active_view_is_marked() {
        let t = thread_with(
            vec![
                shell("shell:1", RunStatus::Running),
                shell("shell:2", RunStatus::Exited),
            ],
            Some("shell:2"),
        );
        let tabs = tab_models(&t);
        assert_eq!(
            tabs.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
            [MAIN_VIEW_ID, "shell:1", "shell:2"]
        );
        assert!(!tabs[0].closable && tabs[1].closable && tabs[2].closable);
        assert_eq!(
            tabs.iter().map(|x| x.active).collect::<Vec<_>>(),
            [false, false, true]
        );
        assert_eq!(
            tabs.iter().map(|x| x.exited).collect::<Vec<_>>(),
            [false, false, true],
            "退出的 shell 标题压灰"
        );
        assert_eq!(tabs[0].icon, TabIcon::Terminal);
        assert_eq!(tabs[1].icon, TabIcon::Terminal);
    }
    #[test]
    fn no_active_view_means_the_main_tab_is_active() {
        let t = thread_with(vec![shell("shell:1", RunStatus::Running)], None);
        assert_eq!(
            tab_models(&t).iter().map(|x| x.active).collect::<Vec<_>>(),
            [true, false]
        );
    }

    #[test]
    fn a_shell_tab_shows_its_osc_title_before_its_fallback_label() {
        let mut v = match shell("shell:1", RunStatus::Running) {
            SessionView::Shell(s) => s,
            _ => unreachable!(),
        };
        v.osc_title = Some("htop".into());
        let t = thread_with(vec![SessionView::Shell(v)], None);
        assert_eq!(tab_models(&t)[1].title, "htop");
    }
    #[test]
    fn terminal_main_tab_hides_the_dot_while_alive_but_shows_need_on_bell() {
        let t = thread_with(vec![], None);
        assert_eq!(tab_models(&t)[0].dot, None, "存活 ≠ 在工作，无点");
        let mut bell = thread_with(vec![], None);
        if let Thread::Terminal(term) = &mut bell {
            term.has_bell = true;
        }
        assert_eq!(tab_models(&bell)[0].dot, Some(TabDot::Need));
        let mut exited = thread_with(vec![], None);
        if let Thread::Terminal(term) = &mut exited {
            term.status = RunStatus::Exited;
        }
        assert_eq!(tab_models(&exited)[0].dot, None);
        assert!(tab_models(&exited)[0].exited);
    }
    #[test]
    fn shell_view_tab_dot_is_need_only_with_bell() {
        let mut v = match shell("shell:1", RunStatus::Running) {
            SessionView::Shell(s) => s,
            _ => unreachable!(),
        };
        v.has_bell = true;
        let t = thread_with(vec![SessionView::Shell(v)], None);
        assert_eq!(tab_models(&t)[1].dot, Some(TabDot::Need));
    }

    #[test]
    fn overflow_tabs_cap_inline_views_and_promote_active_view() {
        let t = thread_with(
            vec![
                shell("s1", RunStatus::Running),
                shell("s2", RunStatus::Running),
                shell("s3", RunStatus::Running),
                shell("s4", RunStatus::Running),
            ],
            Some("s4"),
        );
        let models = tab_models(&t);
        let (vis, over) = visible_and_overflow_tabs(&models, 2);
        assert_eq!(
            vis.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
            [MAIN_VIEW_ID, "s1", "s4"],
            "激活的溢出项 s4 自动置换到可见槽末位"
        );
        assert_eq!(
            over.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
            ["s2", "s3"]
        );
    }
}
