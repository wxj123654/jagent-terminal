//! 会话内副页签条（对应旧 `plane/SessionTabs.tsx`）：主面 tab（不可关）+ 各 SessionView tab（可关）+「+」新建 Shell。
//!
//! 规则在 core（`activate_session_view` / `close_session_view` / `begin|finish_add_session_shell`）；
//! 这里只把 `ThreadCommon` 投影成 [`TabModel`]，并把点击翻译成回调。
//!
//! 与旧版的差异（记入 gpui-rewrite.md）：「+」直接新建 Shell，不再弹出「打开 Git 图 / 新建 Shell」浮层；
//! 中键关闭未做。

use std::rc::Rc;

use gpui::{
    App, ElementId, InteractiveElement, IntoElement, ParentElement, RenderOnce,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_component::{ActiveTheme, h_flex};
use jagent_core::threads::{MAIN_VIEW_ID, RunStatus, SessionView, Thread};

use crate::theme::Tokens;

/// 一个 tab 的展示数据（纯数据，便于测试）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabModel {
    /// `MAIN_VIEW_ID` 或 SessionView 的 id
    pub id: String,
    pub title: String,
    pub active: bool,
    /// 主面不可关
    pub closable: bool,
    /// 退出的 shell：标题压灰
    pub exited: bool,
}

/// 从会话投影出 tab 列表：主面第一，其后按创建序排列各视图。
pub fn tab_models(thread: &Thread) -> Vec<TabModel> {
    let c = thread.common();
    let active = c.active_view_id.as_deref().unwrap_or(MAIN_VIEW_ID);
    let mut out = vec![TabModel {
        id: MAIN_VIEW_ID.to_owned(),
        title: thread.title(),
        active: active == MAIN_VIEW_ID,
        closable: false,
        exited: false,
    }];
    out.extend(c.views.iter().map(|v| TabModel {
        id: v.id().to_owned(),
        title: v.title().to_owned(),
        active: active == v.id(),
        closable: true,
        exited: matches!(v, SessionView::Shell(s) if s.status == RunStatus::Exited),
    }));
    out
}

type TabFn = Rc<dyn Fn(&str, &mut Window, &mut App)>;
type AddFn = Rc<dyn Fn(&mut Window, &mut App)>;

/// 副页签条。回调只携带 view id；调用方负责落到 AppState。
#[derive(IntoElement)]
pub struct SessionTabs {
    tabs: Vec<TabModel>,
    on_activate: TabFn,
    on_close: TabFn,
    on_add: AddFn,
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
        }
    }
}

impl RenderOnce for SessionTabs {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let (fg, muted, active_bg, hover_bg, border) = (
            theme.foreground,
            theme.muted_foreground,
            theme.secondary,
            theme.list_hover,
            theme.border,
        );
        let exited_color = cx.global::<Tokens>().exited;
        let (on_activate, on_close, on_add) = (self.on_activate, self.on_close, self.on_add);

        h_flex()
            .id("session-tabs")
            .w_full()
            .h(px(32.0))
            .px_1()
            .gap_1()
            .items_center()
            .border_b_1()
            .border_color(border)
            .overflow_x_hidden()
            .children(self.tabs.into_iter().map(|t| {
                let (tab_id, close_id) = (t.id.clone(), t.id.clone());
                let (on_activate, on_close) = (on_activate.clone(), on_close.clone());
                h_flex()
                    .id(ElementId::Name(format!("tab-{}", t.id).into()))
                    .h(px(26.0))
                    .px_2()
                    .gap_1()
                    .items_center()
                    .rounded(px(6.0))
                    .text_xs()
                    .cursor_pointer()
                    .text_color(if t.exited {
                        exited_color
                    } else if t.active {
                        fg
                    } else {
                        muted
                    })
                    .when(t.active, |d| d.bg(active_bg))
                    .hover(|d| d.bg(hover_bg))
                    .on_click(move |_, w, cx| on_activate(&tab_id, w, cx))
                    .child(t.title)
                    .when(t.closable, |d| {
                        d.child(
                            div()
                                .id(ElementId::Name(format!("tab-close-{}", close_id).into()))
                                .px_1()
                                .text_color(muted)
                                .child("×")
                                .on_click(move |_, w, cx| on_close(&close_id, w, cx)),
                        )
                    })
            }))
            .child(
                div()
                    .id("tab-add")
                    .px_2()
                    .cursor_pointer()
                    .text_color(muted)
                    .child("+")
                    .on_click(move |_, w, cx| on_add(w, cx)),
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
}
