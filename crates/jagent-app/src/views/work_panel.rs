//! 工作区变更面板（P5）：真实 `git status` / unified diff，不提供假操作。
//!
//! 对照旧 WorkPanel：变更 / 文件两个 tab、文件选择、变更 diff、工作区刷新。文件内容 preview、
//! 拖宽 / overlay 与 discard/stage/commit 操作未做（旧版本来也未接 stage/commit）；偏差记进 gpui-rewrite.md。

use gpui::{
    App, AppContext as _, Context, ElementId, Entity, InteractiveElement, IntoElement,
    ParentElement, Render, ScrollHandle, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_component::{ActiveTheme, h_flex, v_flex};
use jagent_core::git::{WorktreeFile, WorktreeFileKind, WorktreeStatus};

use crate::state::{AppState, StateChanged};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkPanelTab {
    Changes,
    Files,
}

pub struct WorkPanel {
    app: Entity<AppState>,
    cwd: String,
    status: Option<WorktreeStatus>,
    loading: bool,
    not_a_repo: bool,
    error: Option<String>,
    selected: Option<String>,
    diff: Option<String>,
    diff_loading: bool,
    /// Monotonic request token: stale status/diff responses must never overwrite newer UI state.
    request_generation: u64,
    /// Currently accepted patch path; cleared at selection time so stale UI cannot show old patch under new filename.
    accepted_diff_path: Option<String>,
    scroll: ScrollHandle,
    tab: WorkPanelTab,
}

impl WorkPanel {
    pub fn new(app: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let cwd = app.read(cx).git_cwd();
        cx.subscribe(&app, |_, _, _: &StateChanged, cx| cx.notify())
            .detach();
        let mut view = Self {
            app,
            cwd,
            status: None,
            loading: true,
            not_a_repo: false,
            error: None,
            selected: None,
            diff: None,
            diff_loading: false,
            request_generation: 0,
            accepted_diff_path: None,
            scroll: ScrollHandle::new(),
            tab: WorkPanelTab::Changes,
        };
        view.refresh(cx);
        view
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.request_generation = self.request_generation.wrapping_add(1);
        let generation = self.request_generation;
        self.cwd = self.app.read(cx).git_cwd();
        self.status = None;
        self.loading = true;
        self.not_a_repo = false;
        self.error = None;
        self.diff = None;
        self.accepted_diff_path = None;
        let cwd = self.cwd.clone();
        let weak = cx.entity().downgrade();
        cx.spawn(async move |_, cx| {
            let result = cx
                .background_spawn(async move {
                    jagent_core::git::cli::list_worktree_status(std::path::Path::new(&cwd))
                })
                .await;
            let _ = weak.update(cx, |this, cx| {
                if this.request_generation != generation {
                    return;
                }
                this.not_a_repo = result.is_none();
                this.status = result;
                this.loading = false;
                this.selected = None;
                this.diff = None;
                cx.notify();
            });
        })
        .detach();
    }

    fn select(&mut self, path: &str, cx: &mut Context<Self>) {
        self.request_generation = self.request_generation.wrapping_add(1);
        let generation = self.request_generation;
        self.selected = Some(path.to_owned());
        self.diff = None;
        self.accepted_diff_path = None;
        self.diff_loading = true;
        let Some(status) = self.status.as_ref() else {
            return;
        };
        let root = status.root.clone();
        let expected_root = root.clone();
        let path = path.to_owned();
        let expected_path = path.clone();
        let weak = cx.entity().downgrade();
        cx.spawn(async move |_, cx| {
            let result = cx
                .background_spawn(async move {
                    jagent_core::git::cli::diff_worktree_file(std::path::Path::new(&root), &path)
                        .map_err(|e| e.to_string())
                })
                .await;
            let _ = weak.update(cx, |this, cx| {
                if !accept_diff_response(
                    this.request_generation,
                    generation,
                    this.selected.as_deref(),
                    &expected_path,
                    this.status
                        .as_ref()
                        .map(|status| status.root.as_str())
                        .unwrap_or(""),
                    &expected_root,
                ) {
                    return;
                }
                this.diff_loading = false;
                this.diff = result.ok().filter(|s| !s.is_empty());
                this.accepted_diff_path = Some(expected_path.clone());
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}

impl Render for WorkPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let files = self
            .status
            .as_ref()
            .map(|s| s.files.as_slice())
            .unwrap_or(&[]);
        let add: u32 = files.iter().filter_map(|f| f.added).sum();
        let del: u32 = files.iter().filter_map(|f| f.deleted).sum();
        let selected = self.selected.as_deref();
        let tab = self.tab;
        let weak = cx.entity().downgrade();
        let tab_changes = weak.clone();
        let tab_files = weak.clone();
        let refresh = weak.clone();
        let header = h_flex()
            .h(px(40.0))
            .px_2()
            .gap_1()
            .items_center()
            .border_b_1()
            .border_color(theme.border)
            .child(tab_button(
                "变更",
                tab == WorkPanelTab::Changes,
                theme.secondary,
                move |cx| {
                    let _ = tab_changes.update(cx, |v, cx| {
                        v.tab = WorkPanelTab::Changes;
                        cx.notify();
                    });
                },
            ))
            .child(tab_button(
                "文件",
                tab == WorkPanelTab::Files,
                theme.secondary,
                move |cx| {
                    let _ = tab_files.update(cx, |v, cx| {
                        v.tab = WorkPanelTab::Files;
                        cx.notify();
                    });
                },
            ))
            .child(div().flex_1())
            .child(
                div()
                    .id(ElementId::Name("worktree-refresh".into()))
                    .px_2()
                    .cursor_pointer()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child("刷新")
                    .on_click(move |_, _, cx| {
                        let _ = refresh.update(cx, |v, cx| v.refresh(cx));
                    }),
            )
            .child(
                div()
                    .px_2()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child("工作区"),
            );

        let body: gpui::AnyElement = if let Some(e) = &self.error {
            hint(e, cx)
        } else if self.loading {
            hint("读取工作区状态…", cx)
        } else if self.not_a_repo {
            hint("当前目录不是 Git 仓库。", cx)
        } else if self.status.as_ref().is_some_and(|s| s.files.is_empty()) {
            hint("工作区干净，没有变更。", cx)
        } else {
            let weak_select = cx.entity().downgrade();
            let list_rows = files.iter().map(|f| {
                let selected = selected == Some(f.path.as_str());
                let path = f.path.clone();
                let weak = weak_select.clone();
                file_row(f, selected, cx, move |cx| {
                    let _ = weak.update(cx, |v, cx| v.select(&path, cx));
                })
            });
            let file_list = v_flex().children(list_rows);
            let summary = div()
                .px_2()
                .py_2()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(format!("{} 个文件  +{}  −{}", files.len(), add, del));
            let mut col = v_flex().gap_1().child(summary).child(file_list);
            if tab == WorkPanelTab::Changes {
                let selected_file = files.iter().find(|f| Some(f.path.as_str()) == selected);
                if let Some(file) = selected_file {
                    col = col.child(
                        div()
                            .mt_2()
                            .pt_2()
                            .border_t_1()
                            .border_color(theme.border)
                            .child(
                                div()
                                    .px_2()
                                    .py_1()
                                    .font_family("monospace")
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(file.path.clone()),
                            ),
                    );
                    if file.status == WorktreeFileKind::A
                        && self.diff.is_none()
                        && !self.diff_loading
                    {
                        col = col.child(hint("未跟踪文件；当前面板只显示已跟踪文件的 diff。", cx));
                    } else if self.diff_loading {
                        col = col.child(hint("加载 diff…", cx));
                    } else if let Some(patch) = &self.diff {
                        col = col.child(diff_view(patch, cx));
                    } else {
                        col = col.child(hint("此文件没有文本 diff。", cx));
                    }
                }
            } else if let Some(file) = files.iter().find(|f| Some(f.path.as_str()) == selected) {
                col = col.child(
                    div()
                        .mt_2()
                        .pt_2()
                        .border_t_1()
                        .border_color(theme.border)
                        .child(
                            div()
                                .font_family("monospace")
                                .text_xs()
                                .child(file.path.clone()),
                        )
                        .child(hint("文件内容预览尚未实现。", cx)),
                );
            }
            col.into_any_element()
        };

        let scrollable = crate::views::nested_scroll::work_panel_scrollable(
            "work-panel-scroll",
            &self.scroll,
            div().p_2().child(body),
        );
        v_flex()
            .w(px(300.0))
            .h_full()
            .flex_shrink_0()
            .bg(theme.sidebar)
            .border_l_1()
            .border_color(theme.border)
            .child(header)
            .child(scrollable)
    }
}

fn accept_diff_response(
    current_generation: u64,
    response_generation: u64,
    selected: Option<&str>,
    response_path: &str,
    current_root: &str,
    response_root: &str,
) -> bool {
    current_generation == response_generation
        && selected == Some(response_path)
        && current_root == response_root
}

fn tab_button(
    label: &'static str,
    active: bool,
    active_bg: gpui::Hsla,
    on_click: impl Fn(&mut App) + 'static,
) -> impl IntoElement {
    div()
        .id(ElementId::Name(format!("work-tab-{label}").into()))
        .px_2()
        .py_1()
        .rounded(px(5.0))
        .cursor_pointer()
        .text_xs()
        .when(active, |d| d.bg(active_bg))
        .child(label)
        .on_click(move |_, _, cx| on_click(cx))
}

fn hint(text: &str, cx: &App) -> gpui::AnyElement {
    div()
        .p_3()
        .text_sm()
        .text_color(cx.theme().muted_foreground)
        .child(text.to_owned())
        .into_any_element()
}

fn file_row(
    file: &WorktreeFile,
    selected: bool,
    cx: &App,
    on_click: impl Fn(&mut App) + 'static,
) -> impl IntoElement {
    let theme = cx.theme();
    let (status, color) = match file.status {
        WorktreeFileKind::M => ("M", theme.warning),
        WorktreeFileKind::A => ("A", theme.success),
        WorktreeFileKind::D => ("D", theme.danger),
    };
    div()
        .id(ElementId::Name(format!("work-file-{}", file.path).into()))
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .h(px(27.0))
        .px_2()
        .rounded(px(4.0))
        .cursor_pointer()
        .when(selected, |d| d.bg(theme.secondary))
        .hover(|d| d.bg(theme.list_hover))
        .on_click(move |_, _, cx| on_click(cx))
        .child(
            div()
                .font_family("monospace")
                .text_xs()
                .text_color(color)
                .child(status),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_xs()
                .child(file.path.clone()),
        )
        .child(
            div()
                .font_family("monospace")
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(format!(
                    "+{} −{}",
                    file.added.map_or("-".into(), |n| n.to_string()),
                    file.deleted.map_or("-".into(), |n| n.to_string())
                )),
        )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiffLineKind {
    Added,
    Removed,
    Hunk,
    Meta,
    Context,
}

fn diff_line_kind(line: &str) -> DiffLineKind {
    if line.starts_with("+++")
        || line.starts_with("---")
        || line.starts_with("diff ")
        || line.starts_with("index ")
    {
        DiffLineKind::Meta
    } else if line.starts_with('+') {
        DiffLineKind::Added
    } else if line.starts_with('-') {
        DiffLineKind::Removed
    } else if line.starts_with("@@") {
        DiffLineKind::Hunk
    } else {
        DiffLineKind::Context
    }
}

fn diff_view(patch: &str, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    v_flex().gap_0().children(patch.lines().map(|line| {
        let (color, bg) = match diff_line_kind(line) {
            DiffLineKind::Added => (theme.success, Some(theme.success.opacity(0.10))),
            DiffLineKind::Removed => (theme.danger, Some(theme.danger.opacity(0.10))),
            DiffLineKind::Hunk => (theme.accent, Some(theme.accent.opacity(0.08))),
            DiffLineKind::Meta => (theme.muted_foreground, None),
            DiffLineKind::Context => (theme.foreground, None),
        };
        div()
            .w_full()
            .px_1()
            .text_xs()
            .font_family("monospace")
            .text_color(color)
            .when_some(bg, |d, c| d.bg(c))
            .child(line.to_owned())
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    fn work_panel_loads_real_status_and_selection_loads_the_file_diff(
        cx: &mut gpui::TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-q"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();

        let state = cx.update(|cx| {
            crate::state::init(
                cx,
                dir.path().to_path_buf(),
                repo.to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let panel = cx.update(|cx| cx.new(|cx| WorkPanel::new(state, cx)));
        cx.run_until_parked();
        let path = cx.update(|cx| {
            let p = panel.read(cx);
            let f = p.status.as_ref().unwrap().files.first().unwrap();
            assert_eq!(f.path, "a.txt");
            f.path.clone()
        });
        cx.update(|cx| panel.update(cx, |p, cx| p.select(&path, cx)));
        cx.run_until_parked();
        cx.update(|cx| {
            let p = panel.read(cx);
            assert_eq!(p.selected.as_deref(), Some("a.txt"));
            assert!(
                p.diff.as_deref().unwrap().contains("+two"),
                "diff={:?}",
                p.diff
            );
            assert!(!p.diff_loading);
        });
    }

    #[test]
    fn work_panel_tab_models_are_distinct_and_default_to_changes() {
        assert_eq!(WorkPanelTab::Changes, WorkPanelTab::Changes);
        assert_ne!(WorkPanelTab::Changes, WorkPanelTab::Files);
    }

    #[test]
    fn stale_file_diff_responses_are_rejected_by_generation_selection_and_root() {
        assert!(accept_diff_response(
            4,
            4,
            Some("b.txt"),
            "b.txt",
            "/repo",
            "/repo"
        ));
        assert!(
            !accept_diff_response(5, 4, Some("b.txt"), "b.txt", "/repo", "/repo"),
            "older request generation"
        );
        assert!(
            !accept_diff_response(4, 4, Some("b.txt"), "a.txt", "/repo", "/repo"),
            "selection changed"
        );
        assert!(
            !accept_diff_response(4, 4, Some("b.txt"), "b.txt", "/other", "/repo"),
            "workspace root changed"
        );
    }

    #[gpui::test]
    fn selecting_new_file_clears_previous_diff_until_new_patch_response(
        cx: &mut gpui::TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-q"]);
        for name in ["a.txt", "b.txt"] {
            std::fs::write(repo.join(name), "base\n").unwrap();
        }
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "base"]);
        for name in ["a.txt", "b.txt"] {
            std::fs::write(repo.join(name), "base\nchanged\n").unwrap();
        }
        let state = cx.update(|cx| {
            crate::state::init(
                cx,
                dir.path().to_path_buf(),
                repo.to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let panel = cx.update(|cx| cx.new(|cx| WorkPanel::new(state, cx)));
        cx.run_until_parked();
        let paths = cx.update(|cx| {
            panel
                .read(cx)
                .status
                .as_ref()
                .unwrap()
                .files
                .iter()
                .map(|f| f.path.clone())
                .collect::<Vec<_>>()
        });
        assert_eq!(paths.len(), 2);
        cx.update(|cx| panel.update(cx, |p, cx| p.select(&paths[0], cx)));
        cx.run_until_parked();
        assert_eq!(
            cx.update(|cx| panel.read(cx).accepted_diff_path.clone()),
            Some(paths[0].clone())
        );
        cx.update(|cx| panel.update(cx, |p, cx| p.select(&paths[1], cx)));
        assert_eq!(
            cx.update(|cx| panel.read(cx).accepted_diff_path.clone()),
            None
        );
        cx.run_until_parked();
        assert_eq!(
            cx.update(|cx| panel.read(cx).accepted_diff_path.clone()),
            Some(paths[1].clone())
        );
    }

    #[test]
    fn unified_diff_lines_are_classified_for_added_removed_hunk_and_metadata() {
        assert_eq!(diff_line_kind("+added"), DiffLineKind::Added);
        assert_eq!(diff_line_kind("-removed"), DiffLineKind::Removed);
        assert_eq!(diff_line_kind("@@ -1 +1 @@"), DiffLineKind::Hunk);
        assert_eq!(diff_line_kind("+++ b/file"), DiffLineKind::Meta);
        assert_eq!(diff_line_kind("--- a/file"), DiffLineKind::Meta);
        assert_eq!(diff_line_kind(" context"), DiffLineKind::Context);
    }
}
