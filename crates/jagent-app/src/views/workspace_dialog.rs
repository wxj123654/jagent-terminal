//! 「添加工作区」弹窗（对应原型 `Dialogs.tsx` 的 `WorkspaceDialog`）。
//!
//! 校验与错误文案在 `jagent_core::threads::validate_workspace_form`；视图层渲染：
//! 1. 项目目录路径输入框 + 右侧「浏览…」联体按钮；
//! 2. 常用路径快速填入胶囊；
//! 3. 自定义显示名称输入框（留空自动推导目录名）；
//! 4. 名称自动推导与 Git 状态实时预览卡；
//! 5. 底部取消/添加工作区按钮。

use gpui::{
    App, AppContext as _, Context, Entity, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement, PathPromptOptions, Render, StatefulInteractiveElement as _, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_component::{
    ActiveTheme, WindowExt as _,
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{InputEvent, InputState},
    v_flex,
};
use jagent_core::threads::{
    ActiveTarget, WorkspaceDirStatus, WorkspaceFormError, discover_suggested_workspace_dirs,
    expand_workspace_path, inspect_workspace_dir, validate_workspace_form_on_disk,
    workspace_display_name,
};

use crate::icons::{IconName, icon};
use crate::state::AppState;
use crate::theme::{colors, hex, rgba_css};
use crate::ui_scale::fs;
use crate::views::field;

pub struct WorkspaceDialogView {
    state: Entity<AppState>,
    name: Entity<InputState>,
    path: Entity<InputState>,
    suggested_paths: Vec<String>,
    error: Option<WorkspaceFormError>,
}

impl WorkspaceDialogView {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let name = cx.new(|cx| InputState::new(window, cx).placeholder("留空则自动使用目录名"));
        let path =
            cx.new(|cx| InputState::new(window, cx).placeholder("/Users/you/Projects/my-app"));
        let suggested_paths = discover_suggested_workspace_dirs(state.read(cx).workspaces(), 3);
        cx.subscribe_in(
            &name,
            window,
            |this, _, ev: &InputEvent, window, cx| match ev {
                InputEvent::Change => {
                    this.error = None;
                    cx.notify();
                }
                InputEvent::PressEnter { .. } => this.submit(window, cx),
                _ => {}
            },
        )
        .detach();
        cx.subscribe_in(
            &path,
            window,
            |this, _, ev: &InputEvent, window, cx| match ev {
                InputEvent::Change => {
                    this.error = None;
                    cx.notify();
                }
                InputEvent::PressEnter { .. } => this.submit(window, cx),
                _ => {}
            },
        )
        .detach();
        Self {
            state,
            name,
            path,
            suggested_paths,
            error: None,
        }
    }

    fn browse(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("选择工作区目录".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await
                && let Some(chosen) = paths.first()
            {
                let chosen_str = chosen.to_string_lossy().into_owned();
                let _ = this.update_in(cx, |this, window, cx| {
                    this.error = None;
                    this.path.update(cx, |inp, cx| {
                        inp.set_value(chosen_str, window, cx);
                    });
                    cx.notify();
                });
            }
        })
        .detach();
    }

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

fn shorten_home_path(path: &str) -> String {
    if let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
    {
        let home_trimmed = home.trim_end_matches(['/', '\\']);
        if path == home_trimmed {
            return "~".to_owned();
        }
        if let Some(rest) = path.strip_prefix(home_trimmed)
            && (rest.starts_with('/') || rest.starts_with('\\'))
        {
            return format!("~{rest}");
        }
    }
    path.to_owned()
}

impl Render for WorkspaceDialogView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let this = cx.entity();
        let this_browse = this.clone();
        let danger = cx.theme().danger;
        let cur_name = self.name.read(cx).value().to_string();
        let cur_path = self.path.read(cx).value().to_string();
        let expanded_preview_path = expand_workspace_path(&cur_path);
        let derived_name = if !cur_name.trim().is_empty() {
            cur_name.trim().to_owned()
        } else if expanded_preview_path.is_empty() {
            "my-project".to_owned()
        } else {
            workspace_display_name(&expanded_preview_path)
        };
        let (badge_bg, badge_border, badge_fg, badge_text) = match inspect_workspace_dir(&cur_path)
        {
            WorkspaceDirStatus::GitRepo => (
                rgba_css(52, 211, 153, 0.14),
                rgba_css(52, 211, 153, 0.30),
                hex(colors::STATUS_DONE),
                "● Git 仓库就绪",
            ),
            WorkspaceDirStatus::PlainDirectory => (
                rgba_css(99, 102, 241, 0.14),
                rgba_css(99, 102, 241, 0.32),
                hex(colors::ACCENT_HOVER),
                "● 本地目录就绪",
            ),
            WorkspaceDirStatus::Empty => (
                rgba_css(148, 163, 184, 0.10),
                hex(colors::BORDER_SUBTLE),
                hex(colors::MUTED),
                "○ 待选择目录",
            ),
            WorkspaceDirStatus::NotAbsolute => (
                rgba_css(251, 191, 36, 0.14),
                rgba_css(251, 191, 36, 0.30),
                hex(colors::STATUS_RUNNING),
                "○ 需绝对路径",
            ),
            WorkspaceDirStatus::NotFound => (
                rgba_css(224, 108, 117, 0.14),
                rgba_css(224, 108, 117, 0.30),
                hex(colors::STATUS_ERROR),
                "○ 目录不存在",
            ),
            WorkspaceDirStatus::NotADirectory => (
                rgba_css(224, 108, 117, 0.14),
                rgba_css(224, 108, 117, 0.30),
                hex(colors::STATUS_ERROR),
                "✕ 非文件夹",
            ),
        };
        let suggestions = self.suggested_paths.clone();

        v_flex()
            .gap(px(8.0))
            .child(
                div()
                    .text_size(fs(11.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(hex(colors::MUTED))
                    .child("项目目录路径"),
            )
            .child(
                h_flex()
                    .gap(px(8.0))
                    .items_center()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(field::mono_input(&self.path)),
                    )
                    .child(
                        h_flex()
                            .id("ws-browse-btn")
                            .h(px(field::FIELD_H))
                            .px(px(10.0))
                            .gap(px(5.0))
                            .items_center()
                            .flex_shrink_0()
                            .rounded(px(field::FIELD_RADIUS))
                            .bg(hex(colors::SURFACE))
                            .border_1()
                            .border_color(hex(colors::BORDER_SUBTLE))
                            .cursor_pointer()
                            .hover(|h| h.bg(hex(colors::SURFACE_HOVER)))
                            .child(icon(IconName::Folder, 12.0, hex(colors::MUTED)))
                            .child(
                                div()
                                    .text_size(fs(12.0))
                                    .text_color(hex(colors::TEXT_BRIGHT))
                                    .child("浏览…"),
                            )
                            .on_click(move |_, window, cx| {
                                this_browse.update(cx, |v, cx| v.browse(window, cx));
                            }),
                    ),
            )
            // 本机真实候选项目目录快速填入胶囊
            .when(!suggestions.is_empty(), |el| {
                let this_pick = this.clone();
                el.child(
                    h_flex()
                        .gap(px(6.0))
                        .flex_wrap()
                        .items_center()
                        .child(
                            div()
                                .text_size(fs(10.5))
                                .text_color(hex(colors::FAINT))
                                .child("快速选择:"),
                        )
                        .children(
                            suggestions
                                .into_iter()
                                .enumerate()
                                .map(move |(idx, sample)| {
                                    let label = shorten_home_path(&sample);
                                    let this_item = this_pick.clone();
                                    div()
                                        .id(("ws-suggest", idx))
                                        .px(px(7.0))
                                        .py(px(2.0))
                                        .rounded(px(4.0))
                                        .bg(hex(colors::INPUT_BG))
                                        .border_1()
                                        .border_color(hex(colors::BORDER_SUBTLE))
                                        .font_family("monospace")
                                        .text_size(fs(10.5))
                                        .text_color(hex(colors::MUTED))
                                        .cursor_pointer()
                                        .hover(|h| h.bg(hex(colors::SURFACE)))
                                        .child(label)
                                        .on_click(move |_, window, cx| {
                                            let sample = sample.clone();
                                            this_item.update(cx, |v, cx| {
                                                v.error = None;
                                                v.path.update(cx, |inp, cx| {
                                                    inp.set_value(sample, window, cx);
                                                });
                                                cx.notify();
                                            });
                                        })
                                }),
                        ),
                )
            })
            .child(
                div()
                    .mt(px(4.0))
                    .text_size(fs(11.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(hex(colors::MUTED))
                    .child("自定义显示名称（留空则自动使用目录名）"),
            )
            .child(field::text_input(&self.name))
            // 名称自动推导与 Git 状态实时预览卡
            .child(
                h_flex()
                    .mt(px(4.0))
                    .py(px(10.0))
                    .px(px(12.0))
                    .gap(px(10.0))
                    .items_center()
                    .justify_between()
                    .rounded(px(8.0))
                    .bg(hex(colors::INPUT_BG))
                    .border_1()
                    .border_color(hex(colors::BORDER_SUBTLE))
                    .child(
                        h_flex()
                            .gap(px(8.0))
                            .items_center()
                            .min_w_0()
                            .child(icon(IconName::Folder, 14.0, hex(colors::ACCENT_HOVER)))
                            .child(
                                v_flex()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .text_size(fs(12.0))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(hex(colors::TEXT_BRIGHT))
                                            .child(derived_name),
                                    )
                                    .child(
                                        div()
                                            .overflow_hidden()
                                            .whitespace_nowrap()
                                            .text_ellipsis()
                                            .font_family("monospace")
                                            .text_size(fs(10.5))
                                            .text_color(hex(colors::MUTED))
                                            .child(if expanded_preview_path.is_empty() {
                                                "未指定路径".to_owned()
                                            } else {
                                                expanded_preview_path
                                            }),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .px(px(7.0))
                            .py(px(2.0))
                            .rounded_full()
                            .flex_shrink_0()
                            .bg(badge_bg)
                            .border_1()
                            .border_color(badge_border)
                            .font_family("monospace")
                            .text_size(fs(10.0))
                            .text_color(badge_fg)
                            .child(badge_text),
                    ),
            )
            .when_some(self.error.as_ref().map(|e| e.message()), |el, msg| {
                el.child(div().text_xs().text_color(danger).child(msg))
            })
            .child(
                div()
                    .mt(px(4.0))
                    .flex()
                    .flex_row()
                    .justify_end()
                    .gap(px(8.0))
                    .child(
                        Button::new("ws-cancel")
                            .label("取消")
                            .on_click(|_, window, cx| window.close_dialog(cx)),
                    )
                    .child(
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

/// 校验并添加工作区（成功时落盘并切换到新工作区，返回新 id）。规则全在 core。
pub fn commit_workspace(
    state: &Entity<AppState>,
    name: &str,
    path: &str,
    cx: &mut App,
) -> Result<String, WorkspaceFormError> {
    let existing = state.read(cx).workspaces().to_vec();
    let canonical_path = validate_workspace_form_on_disk(name, path, &existing)?;
    let id = state.update(cx, |s, cx| {
        let id = s.threads.add_workspace(name.trim(), &canonical_path);
        s.activate(ActiveTarget::Workspace(id.clone()), cx);
        id
    });
    Ok(id)
}

/// 打开「添加工作区」弹窗。
pub fn open(state: Entity<AppState>, window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| WorkspaceDialogView::new(state, window, cx));
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.title("添加工作区").w(px(460.0)).child(view.clone())
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

            let other_dir = dir.path().join("other");
            let other = other_dir.to_string_lossy().into_owned();
            assert_eq!(
                commit_workspace(&state, "", &other, cx),
                Err(WorkspaceFormError::DirectoryNotFound),
                "不存在的目录拒绝添加"
            );
            assert_eq!(state.read(cx).workspaces().len(), 1, "失败不落库");

            std::fs::create_dir_all(&other_dir).unwrap();
            let id = commit_workspace(&state, "", &other, cx).unwrap();
            let s = state.read(cx);
            assert_eq!(s.workspaces().len(), 2);
            assert_eq!(
                s.workspaces().iter().find(|w| w.id == id).unwrap().name,
                "other",
                "名称空时用目录 basename"
            );
            assert_eq!(
                s.threads.active(),
                &ActiveTarget::Workspace(id),
                "添加工作区后自动激活切换到新工作区"
            );
            assert!(dir.path().join("state.json").exists(), "落盘");
        });
    }

    #[gpui::test]
    fn browse_prompts_for_directory_and_fills_input_when_selected(cx: &mut TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        let chosen_dir = dir.path().join("picked-workspace");
        std::fs::create_dir_all(&chosen_dir).unwrap();

        let state = cx.update(|cx| {
            gpui_component::init(cx);
            let _ = crate::theme::install(cx);
            init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let (view, vcx) =
            cx.add_window_view(|window, cx| WorkspaceDialogView::new(state, window, cx));

        vcx.update(|window, app| {
            view.update(app, |v, cx| v.browse(window, cx));
        });
        assert!(
            vcx.did_prompt_for_paths(),
            "点击浏览按钮应弹出系统目录选择对话框"
        );
        vcx.simulate_path_prompt_response(|options| {
            assert!(options.directories && !options.files, "仅允许选择目录");
            Some(vec![chosen_dir.clone()])
        });
        vcx.run_until_parked();

        vcx.read(|app| {
            let v = view.read(app);
            assert_eq!(
                v.path.read(app).value().as_ref(),
                chosen_dir.to_string_lossy().as_ref(),
                "系统文件夹选择器返回的路径应填入路径输入框"
            );
        });
    }
}
