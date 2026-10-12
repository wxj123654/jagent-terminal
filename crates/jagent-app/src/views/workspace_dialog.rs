//! 「添加工作区」弹窗（对应旧 `dialogs/WorkspaceDialog.tsx`）。
//!
//! 校验与错误文案在 `jagent_core::threads::validate_workspace_form`；这里只画两个输入框、
//! 展示第一条错误，通过后调用 store 的 `add_workspace` 并落盘。
//! 原生目录选择（「浏览…」）尚未接入，留给平台层（P7）。

use gpui::{
    App, AppContext as _, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_component::{
    ActiveTheme, WindowExt as _,
    button::{Button, ButtonVariants as _},
    input::{Input, InputEvent, InputState},
    v_flex,
};
use jagent_core::threads::{WorkspaceFormError, validate_workspace_form};

use crate::state::{AppState, StateChanged};

pub struct WorkspaceDialogView {
    state: Entity<AppState>,
    name: Entity<InputState>,
    path: Entity<InputState>,
    error: Option<WorkspaceFormError>,
}

impl WorkspaceDialogView {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let name = cx.new(|cx| InputState::new(window, cx));
        let path = cx.new(|cx| InputState::new(window, cx));
        // 回车在路径框里提交（与旧表单 onSubmit 一致）
        cx.subscribe_in(&path, window, |this, _, ev: &InputEvent, window, cx| {
            if matches!(ev, InputEvent::PressEnter { .. }) {
                this.submit(window, cx);
            }
        })
        .detach();
        Self {
            state,
            name,
            path,
            error: None,
        }
    }

    /// 校验 → 通过则交给 store（规则在 [`commit_workspace`]）；失败只更新错误文案，弹窗保持打开。
    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.name.read(cx).value().to_string();
        let path = self.path.read(cx).value().to_string();
        match commit_workspace(&self.state, &name, &path, cx) {
            Ok(_) => window.close_dialog(cx),
            Err(e) => {
                self.error = Some(e);
                cx.notify();
            }
        }
    }
}

impl Render for WorkspaceDialogView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let this = cx.entity();
        let muted = cx.theme().muted_foreground;
        let danger = cx.theme().danger;
        v_flex()
            .gap_2()
            .child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child("工作区名称（空 = 目录名）"),
            )
            .child(Input::new(&self.name))
            .child(
                div()
                    .text_xs()
                    .text_color(muted)
                    .child("项目目录（绝对路径）"),
            )
            .child(Input::new(&self.path))
            .when_some(self.error.as_ref().map(|e| e.message()), |el, msg| {
                el.child(div().text_xs().text_color(danger).child(msg))
            })
            .child(
                div().flex().flex_row().justify_end().gap_2().child(
                    Button::new("ws-add")
                        .primary()
                        .label("添加工作区")
                        .on_click(move |_, window, cx| {
                            this.update(cx, |v, cx| v.submit(window, cx));
                        }),
                ),
            )
    }
}

/// 校验并添加工作区（成功时落盘，返回新 id）。规则全在 core。
pub fn commit_workspace(
    state: &Entity<AppState>,
    name: &str,
    path: &str,
    cx: &mut App,
) -> Result<String, WorkspaceFormError> {
    let existing = state.read(cx).workspaces().to_vec();
    validate_workspace_form(name, path, &existing)?;
    let id = state.update(cx, |s, cx| {
        let id = s.threads.add_workspace(name.trim(), path.trim());
        s.flush(cx);
        cx.emit(StateChanged);
        id
    });
    Ok(id)
}

/// 打开「添加工作区」弹窗。
pub fn open(state: Entity<AppState>, window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| WorkspaceDialogView::new(state, window, cx));
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.title("添加工作区").w(px(440.0)).child(view.clone())
    });
}

#[cfg(test)]
mod tests {
    use gpui::TestAppContext;

    use super::*;
    use crate::state::init;

    #[gpui::test]
    fn adding_a_workspace_validates_first_then_persists(cx: &mut TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        cx.update(|cx| {
            let state = init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let default_path = state.read(cx).workspaces()[0].path.clone();
            assert_eq!(
                commit_workspace(&state, "", &default_path, cx),
                Err(WorkspaceFormError::DuplicatePath)
            );
            assert_eq!(
                commit_workspace(&state, "x", "relative", cx),
                Err(WorkspaceFormError::PathNotAbsolute)
            );
            assert_eq!(state.read(cx).workspaces().len(), 1, "失败不落库");

            let other = dir.path().join("other").to_string_lossy().into_owned();
            let id = commit_workspace(&state, "", &other, cx).unwrap();
            let s = state.read(cx);
            assert_eq!(s.workspaces().len(), 2);
            assert_eq!(
                s.workspaces().iter().find(|w| w.id == id).unwrap().name,
                "other",
                "名称空时用目录 basename"
            );
            assert!(dir.path().join("state.json").exists(), "落盘");
        });
    }
}
