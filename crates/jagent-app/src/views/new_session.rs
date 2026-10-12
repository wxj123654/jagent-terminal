//! 「新建会话」弹窗（对应旧 `dialogs/ToolDialog.tsx`）。
//!
//! 规则全在 `jagent_core::new_session::build`；这里只做三件事：
//! 1. 画 `Model`（分组、工作区下拉、筛选框、空态）；
//! 2. 把点击翻译成 `Pick` 并交给 [`AppState`] 落到 store 上；
//! 3. 关闭弹窗。

use gpui::{
    App, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, ParentElement,
    Render, StatefulInteractiveElement as _, Styled, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_component::{
    ActiveTheme, WindowExt as _,
    input::{Input, InputEvent, InputState},
    notification::Notification,
    v_flex,
};
use jagent_core::new_session::{self, Group, Model, Pick, RowIcon, ToolRow};

use crate::state::AppState;

pub struct NewSessionView {
    state: Entity<AppState>,
    /// 打开弹窗时的归属（空串 = 临时入口）。决定工作区下拉是否带「临时会话」首项。
    initial_workspace: String,
    /// 当前选中的工作区（空串 = 未归属）。
    selected_workspace: String,
    filter: Entity<InputState>,
}

impl NewSessionView {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let initial_workspace = state.read(cx).active_workspace_id();
        let filter = cx.new(|cx| InputState::new(window, cx));
        cx.subscribe_in(&filter, window, |_, _, ev: &InputEvent, _, cx| {
            if matches!(ev, InputEvent::Change) {
                cx.notify();
            }
        })
        .detach();
        Self {
            state,
            selected_workspace: initial_workspace.clone(),
            initial_workspace,
            filter,
        }
    }

    fn model(&self, cx: &App) -> Model {
        let s = self.state.read(cx);
        let settings = s.settings.get();
        let filter = self.filter.read(cx).value().to_string();
        new_session::build(
            &settings.presets.items,
            &settings.acp_agents,
            s.workspaces(),
            &self.initial_workspace,
            &self.selected_workspace,
            &filter,
        )
    }
}

impl Render for NewSessionView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let model = self.model(cx);
        let this = cx.entity();

        let workspace_bar = h_row(model.workspace_options.iter().map(|opt| {
            let value = opt.value.clone();
            let active = opt.value == self.selected_workspace;
            let this = this.clone();
            chip(&opt.label, active, cx, move |_, _, cx| {
                this.update(cx, |v, cx| {
                    v.selected_workspace = value.clone();
                    cx.notify();
                });
            })
        }));

        let body: Vec<_> = if model.empty {
            vec![
                div()
                    .p_4()
                    .text_color(cx.theme().muted_foreground)
                    .child("没有匹配的工具")
                    .into_any_element(),
            ]
        } else {
            model
                .groups
                .iter()
                .map(|g| group_view(g, &self.state, cx))
                .collect()
        };

        v_flex()
            .gap_3()
            .child(workspace_bar)
            .child(Input::new(&self.filter))
            .when_some(model.cwd.clone(), |el, cwd| {
                el.child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(format!("目录：{cwd}")),
                )
            })
            .when(model.cwd.is_none(), |el| {
                el.child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("（无项目目录）"),
                )
            })
            .children(body)
    }
}

/// 打开「新建会话」弹窗。
pub fn open(state: Entity<AppState>, window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| NewSessionView::new(state, window, cx));
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.title("新建会话").w(px(560.0)).child(view.clone())
    });
}

fn group_view(g: &Group, state: &Entity<AppState>, cx: &App) -> gpui::AnyElement {
    v_flex()
        .gap_1()
        .child(
            div()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child(g.label),
        )
        .children(g.rows.iter().map(|row| row_view(row, state, cx)))
        .into_any_element()
}

fn row_view(row: &ToolRow, state: &Entity<AppState>, cx: &App) -> gpui::AnyElement {
    let state = state.clone();
    let pick = row.pick.clone();
    let badges = h_row(
        [
            (!row.command.is_empty()).then(|| {
                div()
                    .font_family("monospace")
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(row.command.clone())
                    .into_any_element()
            }),
            row.recommended.then(|| {
                div()
                    .text_xs()
                    .text_color(cx.theme().accent)
                    .child("默认")
                    .into_any_element()
            }),
        ]
        .into_iter()
        .flatten(),
    );

    div()
        .id(row.id.clone())
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .gap_3()
        .px_3()
        .py_2()
        .rounded(px(6.0))
        .cursor_pointer()
        .hover(|s| s.bg(cx.theme().secondary))
        .child(
            v_flex()
                .min_w_0()
                .child(div().child(format!("{}{}", icon_glyph(row.icon), row.name)))
                .when_some(row.description.clone(), |el, d| {
                    el.child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(d),
                    )
                }),
        )
        .child(badges)
        .on_click(move |_, window, cx| {
            apply(&state, &pick, window, cx);
            window.close_dialog(cx);
        })
        .into_any_element()
}

/// 把一次选择落到 store 上。失败以 Toast 提示（不再只写 stderr）。
fn apply(state: &Entity<AppState>, pick: &Pick, window: &mut Window, cx: &mut App) {
    let result = match pick {
        Pick::SpawnPreset {
            preset_id,
            workspace_id,
        } => state.update(cx, |s, cx| {
            s.spawn_from_preset(preset_id, workspace_id.as_deref(), cx)
                .map(|_| ())
                .map_err(|e| e.to_string())
        }),
        Pick::NewChat { workspace_id } => state.update(cx, |s, cx| {
            s.create_chat(Some(workspace_id), cx)
                .map(|_| ())
                .map_err(|e| e.to_string())
        }),
        Pick::NewAcp {
            agent_id,
            label,
            workspace_id,
        } => state.update(cx, |s, cx| {
            s.create_acp(agent_id, label, workspace_id.as_deref(), cx)
                .map(|_| ())
                .map_err(|e| e.to_string())
        }),
    };
    if let Err(e) = result {
        window.push_notification(Notification::error(format!("新建会话失败：{e}")), cx);
    }
}

fn icon_glyph(icon: RowIcon) -> &'static str {
    match icon {
        RowIcon::Agent => "◆ ",
        RowIcon::Terminal => "▸ ",
        RowIcon::Chat => "✎ ",
        RowIcon::Acp => "◇ ",
    }
}

fn h_row(children: impl Iterator<Item = gpui::AnyElement>) -> gpui::AnyElement {
    div()
        .flex()
        .flex_row()
        .flex_wrap()
        .gap_2()
        .children(children)
        .into_any_element()
}

fn chip(
    label: &str,
    active: bool,
    cx: &App,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> gpui::AnyElement {
    div()
        .id(label.to_owned())
        .px_2()
        .py_1()
        .rounded(px(6.0))
        .text_sm()
        .cursor_pointer()
        .when(active, |el| el.bg(cx.theme().secondary))
        .hover(|s| s.bg(cx.theme().secondary))
        .child(label.to_owned())
        .on_click(on_click)
        .into_any_element()
}
