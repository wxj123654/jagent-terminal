//! 「重命名会话」弹窗（对应旧 sidebar 的 rename 交互）。
//!
//! 规则在 `ThreadStore::rename`（空串忽略、终端写 customTitle 后冻结）；这里只画输入框，
//! 回车或点「确定」时把输入交给 store，然后关闭弹窗。

use gpui::{
    App, AppContext as _, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, div,
    px,
};
use gpui_component::{
    ActiveTheme, WindowExt as _,
    button::{Button, ButtonVariants as _},
    input::{Input, InputEvent, InputState},
    v_flex,
};

use crate::state::{AppState, StateChanged};

/// 重命名目标：会话或工作区（同一弹窗形态）
#[derive(Clone, Debug)]
pub enum RenameTarget {
    Thread(String),
    Workspace(String),
}

pub struct RenameView {
    state: Entity<AppState>,
    target: RenameTarget,
    input: Entity<InputState>,
}

impl RenameView {
    pub fn new(
        state: Entity<AppState>,
        target: RenameTarget,
        current: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx));
        input.update(cx, |s, cx| s.set_value(current, window, cx));
        cx.subscribe_in(&input, window, |this, _, ev: &InputEvent, window, cx| {
            if matches!(ev, InputEvent::PressEnter { .. }) {
                this.commit(window, cx);
            }
        })
        .detach();
        Self {
            state,
            target,
            input,
        }
    }

    /// 提交：规则在 [`commit_rename`]；无论如何关弹窗。
    fn commit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let title = self.input.read(cx).value().to_string();
        commit_rename(&self.state, &self.target, &title, cx);
        window.close_dialog(cx);
    }
}

impl Render for RenameView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let this = cx.entity();
        v_flex()
            .gap_3()
            .child(Input::new(&self.input))
            .child(
                div().flex().flex_row().justify_end().child(
                    Button::new("rename-ok").primary().label("确定").on_click(
                        move |_, window, cx| {
                            this.update(cx, |v, cx| v.commit(window, cx));
                        },
                    ),
                ),
            )
            .text_color(cx.theme().foreground)
    }
}

/// 提交重命名：空串由 store 忽略；成功后落盘并通知视图。
pub fn commit_rename(state: &Entity<AppState>, target: &RenameTarget, title: &str, cx: &mut App) {
    state.update(cx, |s, cx| {
        match target {
            RenameTarget::Thread(id) => s.threads.rename(id, title),
            RenameTarget::Workspace(id) => s.threads.rename_workspace(id, title),
        }
        s.flush(cx);
        cx.emit(StateChanged);
    });
}

/// 打开重命名弹窗（会话）。`current` 是当前显示标题，作为初始值。
pub fn open(
    state: Entity<AppState>,
    thread_id: String,
    current: String,
    window: &mut Window,
    cx: &mut App,
) {
    let view = cx.new(|cx| {
        RenameView::new(
            state,
            RenameTarget::Thread(thread_id),
            current,
            window,
            cx,
        )
    });
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.title("重命名会话").w(px(420.0)).child(view.clone())
    });
}

/// 打开重命名弹窗（工作区）。
pub fn open_workspace(
    state: Entity<AppState>,
    workspace_id: String,
    current: String,
    window: &mut Window,
    cx: &mut App,
) {
    let view = cx.new(|cx| {
        RenameView::new(
            state,
            RenameTarget::Workspace(workspace_id),
            current,
            window,
            cx,
        )
    });
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.title("重命名工作区").w(px(420.0)).child(view.clone())
    });
}

#[cfg(test)]
mod tests {
    use gpui::TestAppContext;

    use super::*;
    use crate::state::init;

    #[gpui::test]
    fn committing_a_rename_updates_the_store_and_empty_titles_are_ignored(cx: &mut TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        cx.update(|cx| {
            let state = init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let ws = state.read(cx).workspaces()[0].id.clone();
            let id = state.update(cx, |s, cx| s.create_chat(Some(&ws), cx).unwrap());
            commit_rename(&state, &RenameTarget::Thread(id.clone()), "新标题", cx);
            assert_eq!(
                state.read(cx).threads.thread(&id).unwrap().title(),
                "新标题"
            );
            commit_rename(&state, &RenameTarget::Thread(id.clone()), "   ", cx);
            assert_eq!(
                state.read(cx).threads.thread(&id).unwrap().title(),
                "新标题",
                "空串忽略"
            );
        });
    }
}
