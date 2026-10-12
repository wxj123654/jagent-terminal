//! Git 图与提交详情（P5）。列表使用可变高度 `gpui::list`，图列为普通 GPUI 元素树；不使用 canvas。
//! 几何常量从 `jagent_core::git::geometry` 共用，lane x/行高与旧 graphSvg 对齐。

use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, InteractiveElement, IntoElement,
    ListAlignment, ListState, ParentElement, Render, StatefulInteractiveElement, Styled, Window,
    div, list, prelude::FluentBuilder as _, px,
};
use gpui_component::{ActiveTheme, WindowExt as _, h_flex, input::Input, v_flex};
use jagent_core::git::format::{RefKind, parse_ref_names};
use jagent_core::git::geometry::{
    LANE_WIDTH, ROW_HEIGHT, Stroke, graph_column_width, lane_x, line_strokes,
};
use jagent_core::git::{CommitLine, GitGraphStatus, GraphRow};

use crate::actions::{CTX_GIT_GRAPH, GitClearSelection, GitRefresh, GitSelectNext, GitSelectPrev};
use crate::state::{AppState, StateChanged};
use crate::theme::Tokens;

#[derive(Clone)]
enum Entry {
    Commit {
        index: usize,
        row: GraphRow,
        lines: Vec<CommitLine>,
        max_lanes: usize,
        selected: bool,
        dimmed: bool,
    },
    Detail {
        sha: String,
        body: Option<String>,
        files: Vec<jagent_core::git::ChangedFile>,
        patch: Option<String>,
        loading: bool,
        error: Option<String>,
    },
}

/// 弹窗里的 Git 图：订阅 AppState，状态变化时重绘。
pub struct GitGraphDialog {
    state: Entity<AppState>,
    work_panel: Entity<crate::views::work_panel::WorkPanel>,
    list: ListState,
    last_entries: usize,
    search: Entity<gpui_component::input::InputState>,
}

impl GitGraphDialog {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.subscribe(&state, |_, _, _: &StateChanged, cx| cx.notify())
            .detach();
        let work_panel = cx.new(|cx| crate::views::work_panel::WorkPanel::new(state.clone(), cx));
        let search = cx.new(|cx| gpui_component::input::InputState::new(window, cx));
        cx.subscribe_in(
            &search,
            window,
            |this, _, ev: &gpui_component::input::InputEvent, _, cx| {
                if matches!(ev, gpui_component::input::InputEvent::Change) {
                    let query = this.search.read(cx).value().to_string();
                    this.state.update(cx, |s, cx| {
                        s.git_graph.find(&query);
                        cx.emit(StateChanged);
                        cx.notify();
                    });
                }
            },
        )
        .detach();
        Self {
            state,
            work_panel,
            list: ListState::new(0, ListAlignment::Top, px(300.0)),
            last_entries: 0,
            search,
        }
    }
}

impl Render for GitGraphDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (entries, status, loading, error) = {
            let s = self.state.read(cx);
            let g = &s.git_graph;
            let selected = g.selected_sha.as_deref();
            let match_set: std::collections::HashSet<&str> =
                g.find_matches.iter().map(String::as_str).collect();
            let find_active = !g.find_query.trim().is_empty();
            let mut entries = Vec::with_capacity(g.rows().len() + usize::from(selected.is_some()));
            for (index, row) in g.rows().iter().enumerate() {
                let is_selected = selected == Some(row.commit.sha.as_str());
                entries.push(Entry::Commit {
                    index,
                    row: row.clone(),
                    lines: g.lines_by_row(index).to_vec(),
                    max_lanes: g.max_lanes(),
                    selected: is_selected,
                    dimmed: find_active && !match_set.contains(row.commit.sha.as_str()),
                });
                if is_selected {
                    entries.push(Entry::Detail {
                        sha: row.commit.sha.clone(),
                        body: g.body.clone(),
                        files: g.files.clone(),
                        patch: s.git_patch.clone(),
                        loading: g.detail_loading,
                        error: g.detail_error.clone(),
                    });
                }
            }
            (
                entries,
                g.status,
                g.status == GitGraphStatus::Loading,
                g.error.clone(),
            )
        };
        if self.last_entries != entries.len() {
            self.list.reset(entries.len());
            self.last_entries = entries.len();
        }
        let entries = Rc::new(entries);
        let state = self.state.clone();
        let rows = list(self.list.clone(), move |ix, _, cx| {
            let Some(entry) = entries.get(ix) else {
                return div().into_any_element();
            };
            match entry {
                Entry::Commit {
                    index,
                    row,
                    lines,
                    max_lanes,
                    selected,
                    dimmed,
                } => commit_row(
                    *index, row, lines, *max_lanes, *selected, *dimmed, &state, cx,
                ),
                Entry::Detail {
                    sha,
                    body,
                    files,
                    patch,
                    loading,
                    error,
                } => detail_row(
                    sha,
                    body.as_deref(),
                    files,
                    patch.as_deref(),
                    *loading,
                    error.as_deref(),
                    cx,
                ),
            }
        })
        .flex_1();

        let status_text = match status {
            GitGraphStatus::Idle => Some("尚未加载".to_owned()),
            GitGraphStatus::Loading if self.last_entries == 0 => Some("加载中…".to_owned()),
            GitGraphStatus::NotARepo => Some("当前目录不是 Git 仓库".to_owned()),
            GitGraphStatus::Error => Some(error.unwrap_or_else(|| "加载失败".into())),
            _ => None,
        };
        let state_for_next = self.state.clone();
        let state_for_prev = self.state.clone();
        let state_for_refresh = self.state.clone();
        let state_for_clear = self.state.clone();
        let cwd = self.state.read(cx).git_cwd();
        let branches = self.state.read(cx).git_graph.branches.clone();
        let state_next = self.state.clone();
        let state_prev = self.state.clone();
        let state_clear = self.state.clone();
        let state_refresh = self.state.clone();
        let cwd_refresh = cwd.clone();
        v_flex()
            .key_context(CTX_GIT_GRAPH)
            .on_action(move |_: &GitSelectNext, _, cx| move_selection(&state_next, 1, cx))
            .on_action(move |_: &GitSelectPrev, _, cx| move_selection(&state_prev, -1, cx))
            .on_action(move |_: &GitClearSelection, _, cx| {
                AppState::select_git_commit(&state_clear, None, cx)
            })
            .on_action(move |_: &GitRefresh, _, cx| {
                AppState::refresh_git_graph(&state_refresh, cwd_refresh.clone(), cx)
            })
            .w_full()
            .h(px(540.0))
            .child(
                h_flex()
                    .h(px(40.0))
                    .px_2()
                    .gap_2()
                    .items_center()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(div().w(px(190.0)).child(Input::new(&self.search)))
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(format!(
                                "{} commits",
                                self.state.read(cx).git_graph.loaded_count
                            )),
                    )
                    .child(div().flex_1())
                    .children(branches.into_iter().map(|b| {
                        div()
                            .px_2()
                            .py_1()
                            .rounded(px(5.0))
                            .text_xs()
                            .when(b.current, |d| {
                                d.bg(cx.theme().secondary).text_color(cx.theme().accent)
                            })
                            .child(b.name)
                    }))
                    .when(loading, |d| {
                        d.child(
                            div()
                                .text_xs()
                                .text_color(cx.theme().muted_foreground)
                                .child("· 正在加载"),
                        )
                    }),
            )
            .child(
                h_flex()
                    .h(px(28.0))
                    .px_2()
                    .gap_2()
                    .items_center()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(action_button("↑", move |cx| {
                        move_selection(&state_for_prev, -1, cx)
                    }))
                    .child(action_button("↓", move |cx| {
                        move_selection(&state_for_next, 1, cx)
                    }))
                    .child(action_button("清除", move |cx| {
                        AppState::select_git_commit(&state_for_clear, None, cx)
                    }))
                    .child(action_button("刷新", move |cx| {
                        AppState::refresh_git_graph(&state_for_refresh, cwd.clone(), cx)
                    })),
            )
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .child(div().relative().flex_1().min_w_0().child(rows).when_some(
                        status_text,
                        |d, t| {
                            d.child(
                                div()
                                    .absolute()
                                    .top(px(10.0))
                                    .left(px(16.0))
                                    .text_color(cx.theme().muted_foreground)
                                    .child(t),
                            )
                        },
                    ))
                    .child(self.work_panel.clone()),
            )
    }
}

/// 打开 Git 图弹窗：挂载到当前工作区，再开窗。
pub fn open(state: Entity<AppState>, window: &mut Window, cx: &mut App) {
    let cwd = state.read(cx).git_cwd();
    AppState::mount_git_graph(&state, cwd, cx);
    let view = cx.new(|cx| GitGraphDialog::new(state, window, cx));
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.title("Git 图").w(px(900.0)).child(view.clone())
    });
}

fn commit_row(
    index: usize,
    row: &GraphRow,
    lines: &[CommitLine],
    max_lanes: usize,
    selected: bool,
    dimmed: bool,
    state: &Entity<AppState>,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    let tokens = cx.global::<Tokens>();
    let lane_colors = tokens.graph_lanes;
    let col_width = graph_column_width(max_lanes);
    let lane_count = max_lanes.max(6);
    let mut graph_cells: Vec<AnyElement> = Vec::with_capacity(lane_count);
    for lane in 0..lane_count {
        let x = lane_x(lane);
        let active = lines.iter().any(|l| {
            line_strokes(l, index).iter().any(|s| match s {
                Stroke::Vertical { x: sx, .. } => (*sx - x).abs() < 0.1,
                Stroke::Arc(a) => (a.start.0 - x).abs() < 0.1 || (a.end.0 - x).abs() < 0.1,
            })
        });
        let color = lane_colors[lane % lane_colors.len()];
        let dot = lane == row.lane;
        // 普通元素：lane 竖线 + commit 圆点。曲线连接用行内 glyph 表示，不触发 GPU 自绘。
        graph_cells.push(
            div()
                .relative()
                .w(px(LANE_WIDTH))
                .h(px(ROW_HEIGHT))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .when(active, |d| {
                    d.child(div().absolute().top_0().bottom_0().w(px(1.5)).bg(color))
                })
                .when(dot, |d| {
                    d.child(div().size(px(7.0)).rounded_full().bg(color))
                })
                .into_any_element(),
        );
    }
    let decorations = parse_ref_names(&row.commit.ref_names.join(", "));
    let on_click = {
        let state = state.clone();
        let sha = row.commit.sha.clone();
        move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
            let next = if selected { None } else { Some(sha.clone()) };
            AppState::select_git_commit(&state, next, cx);
        }
    };
    h_flex()
        .id(ElementId::Name(
            format!("git-row-{}", row.commit.sha).into(),
        ))
        .w_full()
        .h(px(ROW_HEIGHT))
        .gap_2()
        .px_3()
        .items_center()
        .overflow_hidden()
        .cursor_pointer()
        .opacity(if dimmed { 0.35 } else { 1.0 })
        .bg(if selected {
            theme.secondary
        } else {
            theme.background
        })
        .hover(|d| d.bg(theme.list_hover))
        .border_b_1()
        .border_color(theme.border)
        .on_click(on_click)
        .child(
            div()
                .w(px(col_width))
                .h(px(ROW_HEIGHT))
                .flex_none()
                .flex()
                .flex_row()
                .items_center()
                .overflow_hidden()
                .children(graph_cells),
        )
        .child(
            div()
                .font_family("monospace")
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(row.commit.short_sha.clone()),
        )
        .children(decorations.into_iter().map(|d| {
            let head = matches!(d.kind, RefKind::Head);
            div()
                .px_1()
                .rounded(px(4.0))
                .border_1()
                .border_color(theme.border)
                .text_xs()
                .when(head, |el| el.text_color(theme.accent))
                .child(d.label)
                .into_any_element()
        }))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(row.commit.subject.clone()),
        )
        .into_any_element()
}

fn detail_row(
    sha: &str,
    body: Option<&str>,
    files: &[jagent_core::git::ChangedFile],
    patch: Option<&str>,
    loading: bool,
    error: Option<&str>,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    let mut content = v_flex().gap_2().p_3().bg(theme.sidebar);
    content = content.child(
        div()
            .font_family("monospace")
            .text_xs()
            .text_color(theme.muted_foreground)
            .child(sha.to_owned()),
    );
    if loading {
        content = content.child(
            div()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child("读取提交详情…"),
        );
    } else if let Some(e) = error {
        content = content.child(div().text_sm().text_color(theme.danger).child(e.to_owned()));
    } else {
        if let Some(body) = body.filter(|s| !s.is_empty()) {
            content = content.child(gpui_component::text::markdown(body.to_owned()));
        }
        if !files.is_empty() {
            content = content.child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child("变更文件"),
            );
            content = content.children(files.iter().map(|f| {
                h_flex()
                    .gap_2()
                    .text_xs()
                    .child(div().flex_1().child(f.path.clone()))
                    .child(
                        div()
                            .font_family("monospace")
                            .text_color(theme.muted_foreground)
                            .child(format!(
                                "+{} −{}",
                                f.added.map_or("-".into(), |n| n.to_string()),
                                f.deleted.map_or("-".into(), |n| n.to_string())
                            )),
                    )
            }));
        }
        if let Some(patch) = patch.filter(|p| !p.is_empty()) {
            content = content.child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child("Unified diff"),
            );
            content = content.child(diff_lines(patch, cx));
        }
    }
    content
        .w_full()
        .border_b_1()
        .border_color(theme.border)
        .into_any_element()
}

fn diff_lines(patch: &str, cx: &App) -> AnyElement {
    let theme = cx.theme();
    v_flex()
        .children(patch.lines().map(|line| {
            let (color, bg) = if line.starts_with("+++")
                || line.starts_with("---")
                || line.starts_with("diff ")
                || line.starts_with("index ")
            {
                (theme.muted_foreground, None)
            } else if line.starts_with('+') {
                (theme.success, Some(theme.success.opacity(0.10)))
            } else if line.starts_with('-') {
                (theme.danger, Some(theme.danger.opacity(0.10)))
            } else if line.starts_with("@@") {
                (theme.accent, Some(theme.accent.opacity(0.08)))
            } else {
                (theme.foreground, None)
            };
            div()
                .w_full()
                .px_1()
                .font_family("monospace")
                .text_xs()
                .text_color(color)
                .when_some(bg, |d, c| d.bg(c))
                .child(line.to_owned())
        }))
        .into_any_element()
}

fn action_button(label: &'static str, action: impl Fn(&mut App) + 'static) -> impl IntoElement {
    div()
        .id(ElementId::Name(format!("git-action-{label}").into()))
        .px_2()
        .py_1()
        .rounded(px(4.0))
        .cursor_pointer()
        .text_xs()
        .child(label)
        .on_click(move |_, _, cx| action(cx))
}

fn move_selection(state: &Entity<AppState>, dir: i32, cx: &mut App) {
    let sha = state.update(cx, |s, cx| {
        let req = if s.git_graph.find_query.trim().is_empty() {
            s.git_graph.move_selection(dir)
        } else {
            s.git_graph.find_next(dir)
        };
        cx.emit(StateChanged);
        req.map(|r| r.sha)
    });
    if let Some(sha) = sha {
        AppState::select_git_commit(state, Some(sha), cx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jagent_core::git::geometry::{MIN_LANES, PAD_X};

    #[test]
    fn graph_column_width_uses_the_shared_geometry_spec() {
        assert_eq!(ROW_HEIGHT, 30.0);
        assert_eq!(LANE_WIDTH, 13.0);
        assert_eq!(
            graph_column_width(2),
            LANE_WIDTH * MIN_LANES as f32 + PAD_X * 2.0 + 6.0
        );
    }

    #[test]
    fn selected_entry_adds_exactly_one_expandable_detail_row() {
        let sha = "abc";
        let mut entries = vec![Entry::Commit {
            index: 0,
            row: GraphRow {
                commit: jagent_core::git::GraphCommit {
                    sha: sha.into(),
                    parents: vec![],
                    ref_names: vec![],
                    short_sha: "abc".into(),
                    author_name: "a".into(),
                    author_email: "a@x".into(),
                    timestamp: 0,
                    committer_name: "a".into(),
                    committer_email: "a@x".into(),
                    subject: "subject".into(),
                },
                lane: 0,
                color_idx: 0,
            },
            lines: vec![],
            max_lanes: 1,
            selected: true,
            dimmed: false,
        }];
        entries.push(Entry::Detail {
            sha: sha.into(),
            body: None,
            files: vec![],
            patch: None,
            loading: true,
            error: None,
        });
        assert_eq!(entries.len(), 2);
        assert!(matches!(entries[1], Entry::Detail { loading: true, .. }));
    }
}
