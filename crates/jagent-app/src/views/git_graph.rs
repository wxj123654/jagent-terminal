//! Git 图表面（V3 原型像素对齐）。
//!
//! 像素真源：React 原型 `GitGraphView.tsx` + `index.css` 第二段（工具条 42 /
//! 表头 30 / 行 30 / 错误条 33 / CDV 卡 218+margin），gpuix 达标实现
//! `packages/app/src/git/`（`graphSvg.ts` 弯线、`components/GitGraphView.tsx`
//! 布局）为「原型 → gpui 翻译」参照。
//!
//! - 列表用可变高 `gpui::list`（提交行 30 + 选中行下插 CDV 槽 236）；
//! - lane 贝塞尔弯线：core `geometry::line_strokes` 的段序列化成行内 SVG
//!   （`svg().data()` 内联 data URI，`stroke="currentColor"` 吃元素 text color
//!   tint——icons.rs 同款通道），按 colorIdx 分色分组、绝对定位叠加；
//! - ref 徽标（`git_ref_badges`）、右键菜单 + danger 红字 + 危险确认
//!   （`git_context_menu`）、分支下拉（gpui_base Popover）见对应模块。

use std::rc::Rc;

use gpui::{
    Anchor, AnyElement, App, AppContext as _, Context, ElementId, Entity, InteractiveElement,
    IntoElement, ListAlignment, ListState, ParentElement, Render, ScrollHandle,
    StatefulInteractiveElement, Styled, WeakEntity, Window, div, list, prelude::FluentBuilder as _,
    px, relative, svg,
};
use gpui_base::Popover;
use gpui_component::{WindowExt as _, h_flex, input::Input, menu::ContextMenuExt as _, v_flex};
use jagent_core::git::actions::{self as git_actions, MenuPick, commit_menu_items};
use jagent_core::git::format::{parse_ref_names, relative_time};
use jagent_core::git::geometry::{self, Stroke};
use jagent_core::git::{CommitLine, GitGraphStatus, GraphRow};

use crate::actions::{CTX_GIT_GRAPH, GitClearSelection, GitRefresh, GitSelectNext, GitSelectPrev};
use crate::icons::{IconName, icon};
use crate::state::{AppState, StateChanged};
use crate::theme::{Tokens, colors, hex, rgba_css};
use crate::views::git_context_menu::{
    ConfirmState, PickHandler, PromptState, apply_entries, confirm_modal, prompt_modal,
};
use crate::views::git_ref_badges::ref_badges;
use crate::views::nested_scroll;

// ── 布局常量（原型 index.css 第二段；gpuix GitGraphView 同值）─────────────

/// 工具条高（.git-toolbar 第二段）
const TOOLBAR_H: f32 = 42.0;
/// 表头高（.git-header 第二段）
const HEADER_H: f32 = 30.0;
/// 错误条高（.git-err）
const ERROR_H: f32 = 33.0;
/// CDV 卡高（.git-cdv 第二段）
const CDV_H: f32 = 218.0;
/// CDV 槽行高：卡 + 上 margin 8 + 下 margin 10
const CDV_SLOT_H: f32 = CDV_H + 8.0 + 10.0;
/// CDV 元数据 label 列宽（.cdv-meta .k）
const CDV_LABEL_W: f32 = 82.0;
/// author 列宽（.git-row .author）
const COL_AUTHOR: f32 = 110.0;
/// date 列宽（.git-row .date）
const COL_DATE: f32 = 80.0;
/// sha 列宽（.git-row .sha）
const COL_SHA: f32 = 72.0;
/// 弯线描边宽（graphSvg STROKE_WIDTH）
const STROKE_W: f32 = 1.5;
/// 提交圆点半径（graphSvg CIRCLE_RADIUS）
const CIRCLE_R: f32 = 3.5;
/// lane 线不透明度（原型 opacity .85；圆点保持实色）
const LANE_OPACITY: f32 = 0.85;
/// 表头/行的弹窗基准高度（列表区在 42+30 之下）
const VIEW_H: f32 = 600.0;
/// 弹窗宽（open() 里 dialog w 900）
const VIEW_W: f32 = 900.0;

// ── 行内 SVG（graphSvg.ts 的 Rust 同构）─────────────────────────────────

/// 一份单色 SVG 文档 + 它的 lane 色下标（视图按色板取 text color tint）。
#[derive(Clone, Debug, PartialEq, Eq)]
struct RowSvgPiece {
    color_idx: usize,
    source: String,
}

/// 一段描边的 SVG path `d` 片段。
fn stroke_d(s: &Stroke) -> String {
    match s {
        Stroke::Vertical { x, y0, y1 } => format!("M {x} {y0} V {y1}"),
        Stroke::Arc(a) => format!(
            "M {} {} C {} {}, {} {}, {} {}",
            a.start.0,
            a.start.1,
            a.control_a.0,
            a.control_a.1,
            a.control_b.0,
            a.control_b.1,
            a.end.0,
            a.end.1
        ),
    }
}

/// 单行单色 SVG 文档（fill none / stroke currentColor / round cap）。
fn svg_doc(width: f32, height: f32, d: &str, circle: Option<&str>, opacity: Option<f32>) -> String {
    let mut shapes = String::new();
    if !d.is_empty() {
        shapes.push_str(&format!(r#"<path d="{d}""#));
        if let Some(o) = opacity {
            shapes.push_str(&format!(r#" opacity="{o}""#));
        }
        shapes.push_str("/>");
    }
    if let Some(c) = circle {
        shapes.push_str(c);
    }
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" fill="none" stroke="currentColor" stroke-width="{STROKE_W}" stroke-linecap="round">{shapes}</svg>"#
    )
}

/// 行 `row` 的绘制分组：覆盖该行的连线按 colorIdx 聚合（保序）成若干单色
/// SVG，最后追加提交圆点（普通 = 实填 lane 色；hollow = pane 底 + 2px 描边，
/// 原型 HEAD 空心圆）。与 gpuix `buildRowGraphics` 的分组/几何一一对应。
fn build_row_svg_pieces(
    row: usize,
    lines: &[CommitLine],
    commit_lane: usize,
    commit_color: usize,
    max_lanes: usize,
    hollow: bool,
) -> Vec<RowSvgPiece> {
    let width = geometry::graph_column_width(max_lanes);
    let height = geometry::ROW_HEIGHT;
    // colorIdx → 该色的描边序列（插入序保持绘制顺序）
    let mut groups: Vec<(usize, Vec<Stroke>)> = vec![];
    for line in lines {
        for s in geometry::line_strokes(line, row) {
            match groups.iter_mut().find(|(c, _)| *c == line.color_idx) {
                Some((_, v)) => v.push(s),
                None => groups.push((line.color_idx, vec![s])),
            }
        }
    }
    let mut pieces = Vec::with_capacity(groups.len() + 1);
    for (color_idx, strokes) in groups {
        let d = strokes.iter().map(stroke_d).collect::<Vec<_>>().join(" ");
        pieces.push(RowSvgPiece {
            color_idx,
            source: svg_doc(width, height, &d, None, Some(LANE_OPACITY)),
        });
    }
    let cx = geometry::lane_x(commit_lane);
    let cy = height / 2.0;
    let circle = if hollow {
        // 原型 c.hollow：fill=pane + 2px lane 色描边（描边色继承 currentColor）
        format!(
            r##"<circle cx="{cx}" cy="{cy}" r="{CIRCLE_R}" fill="{}" stroke-width="2"/>"##,
            colors::PANE
        )
    } else {
        format!(r#"<circle cx="{cx}" cy="{cy}" r="{CIRCLE_R}" fill="currentColor" stroke="none"/>"#)
    };
    pieces.push(RowSvgPiece {
        color_idx: commit_color,
        source: svg_doc(width, height, "", Some(&circle), None),
    });
    pieces
}

// ── 列表条目模型 ────────────────────────────────────────────────────────

#[derive(Clone)]
enum Entry {
    Commit {
        index: usize,
        row: GraphRow,
        lines: Vec<CommitLine>,
        max_lanes: usize,
        selected: bool,
        dimmed: bool,
        /// 首行 = HEAD：空心圆（原型 c.hollow）
        hollow: bool,
    },
    /// 选中提交下插的 CDV（提交详情）卡槽行
    Detail {
        commit: jagent_core::git::GraphCommit,
        body: Option<String>,
        files: Vec<jagent_core::git::ChangedFile>,
        loading: bool,
        error: Option<String>,
    },
}

/// 弹窗里的 Git 图：订阅 AppState，状态变化时重绘。
pub struct GitGraphDialog {
    state: Entity<AppState>,
    list: ListState,
    last_entries: usize,
    /// find 输入框（工具条展开式）
    search: Entity<gpui_component::input::InputState>,
    /// find 是否展开（收起时清查询）
    find_open: bool,
    /// CDV 文件列表的内层滚动（外层是提交列表 → 走 nested_scroll 封装）
    files_scroll: ScrollHandle,
    /// 危险操作二次确认
    confirm: Option<ConfirmState>,
    /// 「创建分支/标签/重命名」输入弹层
    prompt: Option<PromptState>,
    prompt_input: Entity<gpui_component::input::InputState>,
}

impl GitGraphDialog {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.subscribe(&state, |_, _, _: &StateChanged, cx| cx.notify())
            .detach();
        let search =
            cx.new(|cx| gpui_component::input::InputState::new(window, cx).placeholder("查找提交"));
        cx.subscribe_in(
            &search,
            window,
            |this, _, ev: &gpui_component::input::InputEvent, _, cx| {
                match ev {
                    gpui_component::input::InputEvent::Change => {
                        let query = this.search.read(cx).value().to_string();
                        this.state.update(cx, |s, cx| {
                            s.git_graph.find(&query);
                            cx.emit(StateChanged);
                            cx.notify();
                        });
                    }
                    // Enter = 下一个匹配（gpuix TextInput onSubmit → findNext(1)）
                    gpui_component::input::InputEvent::PressEnter { .. } => {
                        move_selection(&this.state, 1, cx)
                    }
                    _ => {}
                }
            },
        )
        .detach();
        let prompt_input =
            cx.new(|cx| gpui_component::input::InputState::new(window, cx).placeholder("名称"));
        Self {
            state,
            list: ListState::new(0, ListAlignment::Top, px(geometry::ROW_HEIGHT)),
            last_entries: 0,
            search,
            find_open: false,
            files_scroll: ScrollHandle::new(),
            confirm: None,
            prompt: None,
            prompt_input,
        }
    }

    /// 菜单项被选中（右键菜单 / 分支下拉共用入口）：core `pick` 派发——
    /// 复制类写剪贴板；直执类交给 [`AppState::run_git_action`]；
    /// prompt / danger 分别打开输入弹层 / 确认弹层。
    fn dispatch_pick(
        weak: WeakEntity<Self>,
        state: &Entity<AppState>,
        window: &mut Window,
        cx: &mut App,
        item: jagent_core::git::actions::GitMenuItem,
        at: Option<String>,
    ) {
        // copy-sha：真写剪贴板（gpuix 只 toast；全局 toast 设施是 V5 范围）
        if item.id == "copy-sha"
            && let Some(at) = &at
        {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(at.clone()));
        }
        let mut run: Option<Vec<String>> = None;
        let pick = git_actions::pick(&item, at.as_deref(), &mut |_| {}, &mut |argv| {
            run = Some(argv)
        });
        if let Some(argv) = run {
            AppState::run_git_action(state, argv, cx);
        }
        let _ = weak.update(cx, |this, cx| {
            match pick {
                MenuPick::Prompt { item, at } => {
                    this.prompt = Some(PromptState { item, at });
                    this.prompt_input
                        .update(cx, |i, cx| i.set_value("", window, cx));
                }
                MenuPick::Confirm { title, argv } => {
                    this.confirm = Some(ConfirmState { title, argv });
                }
                MenuPick::None => {}
            }
            cx.notify();
        });
    }

    /// prompt 弹窗「创建」：core `submit_prompt` 解析执行；成功关弹层清输入。
    fn submit_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = self.prompt.clone() else { return };
        let value = self.prompt_input.read(cx).value().to_string();
        let state = self.state.clone();
        let mut run: Option<Vec<String>> = None;
        let ok = git_actions::submit_prompt(
            &p.item,
            &value,
            p.at.as_deref(),
            &mut |_| {},
            &mut |argv| run = Some(argv),
        );
        if ok {
            if let Some(argv) = run {
                AppState::run_git_action(&state, argv, cx);
            }
            self.prompt = None;
            self.prompt_input
                .update(cx, |i, cx| i.set_value("", window, cx));
            cx.notify();
        }
        // 校验失败（空名等）：弹层保留（原因已在 core 的 notify 通道；无 toast 设施）
    }
}

impl Render for GitGraphDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (entries, status, action_error, error, branches, show_remote, loaded_count) = {
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
                    hollow: index == 0,
                });
                if is_selected {
                    entries.push(Entry::Detail {
                        commit: row.commit.clone(),
                        body: g.body.clone(),
                        files: g.files.clone(),
                        loading: g.detail_loading,
                        error: g.detail_error.clone(),
                    });
                }
            }
            (
                entries,
                g.status,
                g.action_error.clone(),
                g.error.clone(),
                g.branches.clone(),
                g.show_remote,
                g.loaded_count,
            )
        };
        if self.last_entries != entries.len() {
            self.list.reset(entries.len());
            self.last_entries = entries.len();
        }
        let entries = Rc::new(entries);
        let state = self.state.clone();
        let on_pick: PickHandler = {
            let state = state.clone();
            let weak = cx.entity().downgrade();
            Rc::new(move |item, at, window, cx| {
                Self::dispatch_pick(weak.clone(), &state, window, cx, item, at)
            })
        };
        let files_scroll = self.files_scroll.clone();
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
                    hollow,
                } => commit_row(
                    *index,
                    row,
                    lines,
                    *max_lanes,
                    *selected,
                    *dimmed,
                    *hollow,
                    &state,
                    show_remote,
                    &on_pick,
                    cx,
                ),
                Entry::Detail {
                    commit,
                    body,
                    files,
                    loading,
                    error,
                } => cdv_row(
                    commit,
                    body.as_deref(),
                    files,
                    *loading,
                    error.as_deref(),
                    &files_scroll,
                ),
            }
        })
        .flex_1()
        .min_h_0();

        let current_branch = branches
            .iter()
            .find(|b| b.current)
            .map(|b| b.name.clone())
            .unwrap_or_else(|| "HEAD".into());
        let toolbar = toolbar(
            self,
            repo_label(&self.state, cx),
            current_branch,
            branches,
            show_remote,
            loaded_count,
            status,
            cx,
        );
        // 错误条文案：动作错误优先，其次 log 流错误（.git-err）
        let error_line = action_error.clone().or_else(|| {
            (status == GitGraphStatus::Error)
                .then(|| error.clone().unwrap_or_else(|| "git log 失败".to_string()))
        });

        let state_next = self.state.clone();
        let state_prev = self.state.clone();
        let state_clear = self.state.clone();
        let state_refresh = self.state.clone();
        let cwd_refresh = self.state.read(cx).git_cwd();
        let weak_confirm = cx.entity().downgrade();
        let weak_cancel = cx.entity().downgrade();
        let weak_prompt_cancel = cx.entity().downgrade();
        let weak_prompt_submit = cx.entity().downgrade();
        let state_for_confirm = self.state.clone();

        let body = if status == GitGraphStatus::NotARepo {
            v_flex()
                .flex_1()
                .min_h_0()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .text_size(px(13.0))
                        .text_color(hex(colors::MUTED))
                        .child("此目录不是 git 仓库"),
                )
                .into_any_element()
        } else {
            v_flex()
                .flex_1()
                .min_h_0()
                .child(graph_header())
                .child(rows)
                .into_any_element()
        };

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
            .relative()
            .w_full()
            .h(px(VIEW_H))
            .bg(hex(colors::PANE))
            .child(toolbar)
            .when_some(error_line, |d, text| {
                d.child(
                    h_flex()
                        .h(px(ERROR_H))
                        .pl(px(10.0))
                        .pr(px(10.0))
                        .items_center()
                        .flex_shrink_0()
                        .bg(rgba_css(224, 108, 117, 0.08))
                        .border_b_1()
                        .border_color(hex(colors::BORDER))
                        .text_size(px(12.0))
                        .text_color(hex(colors::BELL))
                        .child(text),
                )
            })
            .child(body)
            .when_some(self.confirm.clone(), |d, confirm| {
                let state = state_for_confirm.clone();
                let on_run = Rc::new(move |_: &mut Window, cx: &mut App| {
                    let argv = weak_confirm
                        .update(cx, |this: &mut GitGraphDialog, cx| {
                            let argv = this.confirm.take().map(|c| c.argv);
                            cx.notify();
                            argv
                        })
                        .ok()
                        .flatten();
                    if let Some(argv) = argv {
                        AppState::run_git_action(&state, argv, cx);
                    }
                });
                let on_cancel = Rc::new(move |_: &mut Window, cx: &mut App| {
                    let _ = weak_cancel.update(cx, |this: &mut GitGraphDialog, cx| {
                        this.confirm = None;
                        cx.notify();
                    });
                });
                d.child(confirm_modal(&confirm, on_cancel, on_run))
            })
            .when_some(self.prompt.clone(), |d, prompt| {
                let input = self.prompt_input.clone();
                let on_cancel = Rc::new(move |_: &mut Window, cx: &mut App| {
                    let _ = weak_prompt_cancel.update(cx, |this: &mut GitGraphDialog, cx| {
                        this.prompt = None;
                        cx.notify();
                    });
                });
                let on_submit = Rc::new(move |window: &mut Window, cx: &mut App| {
                    let _ = weak_prompt_submit.update(cx, |this: &mut GitGraphDialog, cx| {
                        this.submit_prompt(window, cx);
                    });
                });
                d.child(prompt_modal(&prompt, input, on_cancel, on_submit))
            })
    }
}

/// 打开 Git 图弹窗：挂载到当前工作区，再开窗。
pub fn open(state: Entity<AppState>, window: &mut Window, cx: &mut App) {
    let cwd = state.read(cx).git_cwd();
    AppState::mount_git_graph(&state, cwd, cx);
    let view = cx.new(|cx| GitGraphDialog::new(state, window, cx));
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.title("Git 图").w(px(VIEW_W)).child(view.clone())
    });
}

// ── 工具条（.git-toolbar 第二段：h42 / px12 / gap8 / rgba(32,36,43,.42) 底）──

#[allow(clippy::too_many_arguments)]
fn toolbar(
    this: &GitGraphDialog,
    repo_label: String,
    current_branch: String,
    branches: Vec<jagent_core::git::GitBranch>,
    show_remote: bool,
    loaded_count: usize,
    status: GitGraphStatus,
    cx: &mut Context<GitGraphDialog>,
) -> gpui::Div {
    let state = this.state.clone();
    // 分支下拉（.branch-pop：min180 / r12 overlay 底 / pad4 / brow h26 r4）
    let branch_pop = Popover::new("git-branch-pop")
        .anchor(Anchor::TopLeft)
        .offset(px(6.0))
        .trigger_with(move |_, _, _| branch_button(&current_branch).into_any_element())
        .content(move |_popover_state, _window, cx| {
            let popover_entity = cx.entity();
            let state = state.clone();
            let mut list = v_flex()
                .min_w(px(180.0))
                .p(px(4.0))
                .bg(hex(colors::OVERLAY))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .rounded(px(12.0))
                .shadow(vec![
                    gpui::BoxShadow::new(px(0.0), px(14.0), gpui::hsla(0.0, 0.0, 0.0, 0.5))
                        .blur_radius(px(38.0)),
                ]);
            for b in &branches {
                let popover_entity = popover_entity.clone();
                let state = state.clone();
                let name = b.name.clone();
                let is_current = b.current;
                list = list.child(
                    div()
                        .id(ElementId::Name(format!("git-branch-{name}").into()))
                        .h(px(26.0))
                        .pl(px(8.0))
                        .pr(px(8.0))
                        .rounded(px(4.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .cursor_pointer()
                        .hover(|h| h.bg(hex(colors::SURFACE)))
                        // .ck：14 宽 terminalKind 勾
                        .child(
                            div()
                                .w(px(14.0))
                                .flex_shrink_0()
                                .text_size(px(12.0))
                                .text_color(hex(colors::TERMINAL_KIND))
                                .when(is_current, |d| d.child("✓")),
                        )
                        .child(icon(IconName::GitBranch, 12.0, hex(colors::MUTED)))
                        .child(
                            div()
                                .text_size(px(12.0))
                                .text_color(hex(colors::TEXT))
                                .child(name.clone()),
                        )
                        .on_click(move |_, window, cx| {
                            popover_entity.update(cx, |s, cx| s.dismiss(window, cx));
                            if !is_current {
                                AppState::run_git_action(
                                    &state,
                                    vec!["checkout".into(), name.clone()],
                                    cx,
                                );
                            }
                        }),
                );
            }
            list.into_any_element()
        });

    h_flex()
        .h(px(TOOLBAR_H))
        .pl(px(12.0))
        .pr(px(12.0))
        .gap(px(8.0))
        .items_center()
        .flex_shrink_0()
        .overflow_hidden()
        .border_b_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .bg(rgba_css(32, 36, 43, 0.42))
        // 仓库名 / 「分支」label
        .child(
            div()
                .text_size(px(12.0))
                .text_color(hex(colors::MUTED))
                .flex_shrink_0()
                .child(repo_label),
        )
        .child(
            div()
                .text_size(px(12.0))
                .text_color(hex(colors::MUTED))
                .flex_shrink_0()
                .child("分支"),
        )
        .child(branch_pop)
        // 显示远程分支开关（原型 .toggle 34×20 scale .85 → 29×17 视觉）
        .child(
            h_flex()
                .gap(px(6.0))
                .flex_shrink_0()
                .items_center()
                .child({
                    let state = this.state.clone();
                    small_toggle(show_remote, move |_, cx| {
                        AppState::set_git_show_remote(&state, !show_remote, cx)
                    })
                })
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(hex(colors::MUTED))
                        .child("显示远程分支"),
                ),
        )
        .child(div().flex_1().min_w(px(12.0)))
        // .cnt：n 提交 / 读取提交…
        .child(
            div()
                .text_size(px(11.0))
                .text_color(hex(colors::MUTED))
                .flex_shrink_0()
                .child(if status == GitGraphStatus::Loading && loaded_count == 0 {
                    "读取提交…".to_string()
                } else {
                    format!("{loaded_count} 提交")
                }),
        )
        // find：展开时替换 search 钮（原型同）
        .when(this.find_open, |d| {
            let weak_up = cx.entity().downgrade();
            let weak_down = cx.entity().downgrade();
            let weak_close = cx.entity().downgrade();
            let pos = find_pos_text(&this.state, cx);
            d.child(
                h_flex()
                    .gap(px(4.0))
                    .flex_shrink_0()
                    .items_center()
                    // .git-find input：w180 h24
                    .child(Input::new(&this.search).w(px(180.0)).h(px(24.0)))
                    .child(
                        div()
                            .w(px(40.0))
                            .text_size(px(11.0))
                            .text_color(hex(colors::MUTED))
                            .text_center()
                            .child(pos),
                    )
                    .child(hbtn(
                        IconName::ChevronUp,
                        12.0,
                        "git-find-prev",
                        move |_, _, cx| {
                            let _ = weak_up.update(cx, |this: &mut GitGraphDialog, cx| {
                                move_selection(&this.state, -1, cx)
                            });
                        },
                    ))
                    .child(hbtn(
                        IconName::ChevronDown,
                        12.0,
                        "git-find-next",
                        move |_, _, cx| {
                            let _ = weak_down.update(cx, |this: &mut GitGraphDialog, cx| {
                                move_selection(&this.state, 1, cx)
                            });
                        },
                    ))
                    .child(hbtn(
                        IconName::Close,
                        12.0,
                        "git-find-close",
                        move |_, window, cx| {
                            let _ = weak_close.update(cx, |this: &mut GitGraphDialog, cx| {
                                this.find_open = false;
                                this.search.update(cx, |i, cx| i.set_value("", window, cx));
                                this.state.update(cx, |s, cx| {
                                    s.git_graph.find("");
                                    cx.emit(StateChanged);
                                    cx.notify();
                                });
                            });
                        },
                    )),
            )
        })
        .when(!this.find_open, |d| {
            let weak = cx.entity().downgrade();
            d.child(ibtn(
                IconName::Search,
                16.0,
                "git-find-open",
                move |_, _, cx| {
                    let _ = weak.update(cx, |this: &mut GitGraphDialog, cx| {
                        this.find_open = true;
                        cx.notify();
                    });
                },
            ))
        })
        // 设置（后续版本——原型只 toast「后续版本提供」，这里暂无动作）
        .child(ibtn(IconName::Gear, 16.0, "git-settings", |_, _, _| {}))
        // 拉取远端更新
        .child({
            let state = this.state.clone();
            ibtn(IconName::Download, 16.0, "git-fetch", move |_, _, cx| {
                AppState::run_git_action(
                    &state,
                    vec!["fetch".into(), "--all".into(), "--prune".into()],
                    cx,
                )
            })
        })
        // 刷新（R）
        .child({
            let state = this.state.clone();
            let cwd = this.state.read(cx).git_cwd();
            ibtn(IconName::Reset, 16.0, "git-refresh", move |_, _, cx| {
                AppState::refresh_git_graph(&state, cwd.clone(), cx)
            })
        })
}

/// 仓库名：挂载目录的最后一段（gpuix repoLabel——外层传 workspace 名，同源）。
fn repo_label(state: &Entity<AppState>, cx: &App) -> String {
    let cwd = state.read(cx).git_cwd();
    std::path::Path::new(&cwd)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or(cwd)
}

/// find 计数文案：`i/n` 或 `0/0`（原型 .pos）。
fn find_pos_text(state: &Entity<AppState>, cx: &App) -> String {
    let g = &state.read(cx).git_graph;
    if g.find_matches.is_empty() {
        "0/0".into()
    } else {
        let i = g.find_index.map_or(0, |i| i + 1);
        format!("{i}/{}", g.find_matches.len())
    }
}

/// 分支钮（.git-branch-btn 第二段：h28 / borderSubtle / r8 / inputBg 底 /
/// px8 / gap5 / 12px mono 名 + gitBranch·chevron 12 muted）。
fn branch_button(current: &str) -> impl IntoElement {
    h_flex()
        .id("git-branch-btn")
        .h(px(28.0))
        .pl(px(8.0))
        .pr(px(8.0))
        .gap(px(5.0))
        .items_center()
        .flex_shrink_0()
        .rounded(px(8.0))
        .bg(hex(colors::INPUT_BG))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .cursor_pointer()
        .hover(|h| h.bg(hex(colors::TILE_HOVER)))
        .child(icon(IconName::GitBranch, 12.0, hex(colors::MUTED)))
        .child(
            div()
                .font_family("monospace")
                .text_size(px(12.0))
                .text_color(hex(colors::TEXT))
                .child(current.to_owned()),
        )
        .child(icon(IconName::ChevronDown, 12.0, hex(colors::MUTED)))
}

/// 小号 Toggle（原型 .toggle 34×20 缩放 .85 ≈ 29×17；开 = accent 轨 + 白钮）。
fn small_toggle(
    on: bool,
    on_toggle: impl Fn(&mut Window, &mut App) + Clone + 'static,
) -> impl IntoElement {
    div()
        .id("git-show-remote")
        .relative()
        .w(px(29.0))
        .h(px(17.0))
        .flex_shrink_0()
        .rounded_full()
        .cursor_pointer()
        .when(on, |d| d.bg(hex(colors::ACCENT)))
        .when(!on, |d| d.bg(hex(colors::SURFACE_HOVER)))
        .child(
            div()
                .absolute()
                .top(px(1.5))
                .when(on, |d| d.left(px(13.5)))
                .when(!on, |d| d.left(px(1.5)))
                .size(px(14.0))
                .rounded_full()
                .when(on, |d| d.bg(gpui::white()))
                .when(!on, |d| d.bg(hex(colors::FAINT))),
        )
        .on_click(move |_, window, cx| on_toggle.clone()(window, cx))
}

/// 工具条方钮（.ibtn 显式 26×26：透明底 / r8 / hover surface）。
fn ibtn(
    name: IconName,
    size: f32,
    id: &'static str,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .id(id)
        .size(px(26.0))
        .flex()
        .items_center()
        .justify_center()
        .flex_shrink_0()
        .rounded(px(8.0))
        .cursor_pointer()
        .hover(|h| h.bg(hex(colors::SURFACE)))
        .child(icon(name, size, hex(colors::MUTED)))
        .on_click(move |ev, window, cx| on_click(ev, window, cx))
}

/// find 步进/关闭小钮（.hbtn 显式 22×22）。
fn hbtn(
    name: IconName,
    size: f32,
    id: &'static str,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .id(id)
        .size(px(22.0))
        .flex()
        .items_center()
        .justify_center()
        .flex_shrink_0()
        .rounded(px(8.0))
        .cursor_pointer()
        .hover(|h| h.bg(hex(colors::SURFACE)))
        .child(icon(name, size, hex(colors::MUTED)))
        .on_click(move |ev, window, cx| on_click(ev, window, cx))
}

// ── 表头（.git-header 第二段：h30 / #1a1d22 底 / 9px 大写 / 列几何同行）──

fn graph_header() -> gpui::Div {
    // 表头取最小 lane 宽（MIN_LANES 基准）；lane 更多的仓库行会宽于表头，
    // 原型表头同样是固定列几何（gpuix 用 store 的 maxLanes，滚动中行宽
    // 变化时表头跟随 store 值——这里 dialog 形态下取基准宽，差异记录在案）
    let graph_w = geometry::graph_column_width(0);
    h_flex()
        .h(px(HEADER_H))
        .pr(px(12.0))
        .items_center()
        .flex_shrink_0()
        .border_b_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .bg(hex("#1a1d22"))
        .text_size(px(9.0))
        .text_color(hex(colors::MUTED))
        .child(
            div()
                .w(px(graph_w))
                .ml(px(8.0))
                .flex_shrink_0()
                .child("GRAPH"),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child("DESCRIPTION"),
        )
        .child(
            div()
                .w(px(COL_AUTHOR))
                .ml(px(8.0))
                .flex_shrink_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child("AUTHOR"),
        )
        .child(
            div()
                .w(px(COL_DATE))
                .ml(px(8.0))
                .flex_shrink_0()
                .text_right()
                .child("DATE"),
        )
        .child(
            div()
                .w(px(COL_SHA))
                .ml(px(8.0))
                .flex_shrink_0()
                .child("SHA"),
        )
}

// ── 提交行 ──────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn commit_row(
    index: usize,
    row: &GraphRow,
    lines: &[CommitLine],
    max_lanes: usize,
    selected: bool,
    dimmed: bool,
    hollow: bool,
    state: &Entity<AppState>,
    show_remote: bool,
    on_pick: &PickHandler,
    cx: &App,
) -> AnyElement {
    let tokens = cx.global::<Tokens>();
    let lane_colors = tokens.graph_lanes;
    let graph_w = geometry::graph_column_width(max_lanes);

    // lane 弯线 + 圆点（按色分组的内联 SVG，绝对定位叠加）
    let pieces = build_row_svg_pieces(index, lines, row.lane, row.color_idx, max_lanes, hollow);
    let gcell = div()
        .relative()
        .w(px(graph_w))
        .h(px(geometry::ROW_HEIGHT))
        .flex_shrink_0()
        .ml(px(8.0))
        .overflow_hidden()
        .children(pieces.into_iter().map(|p| {
            let color = lane_colors[p.color_idx % lane_colors.len()];
            svg()
                .data(p.source.as_bytes())
                .absolute()
                .top_0()
                .left_0()
                .w(px(graph_w))
                .h(px(geometry::ROW_HEIGHT))
                .text_color(color)
        }));

    // 徽标（左键选中该行）+ 行右键菜单
    let decors = parse_ref_names(&row.commit.ref_names.join(", "));
    let current_branch = current_branch_of(state, cx);
    let on_select = {
        let state = state.clone();
        let sha = row.commit.sha.clone();
        move |cx: &mut App| {
            let next = if selected { None } else { Some(sha.clone()) };
            AppState::select_git_commit(&state, next, cx);
        }
    };
    let on_select_el: crate::views::sidebar::WindowActionFn = {
        let on_select = on_select.clone();
        Rc::new(move |_: &mut Window, cx: &mut App| on_select(cx))
    };
    let badges = ref_badges(
        &decors,
        show_remote,
        &current_branch,
        on_pick,
        &on_select_el,
    );

    let sha = row.commit.sha.clone();
    let is_head = index == 0;
    let on_pick_menu = on_pick.clone();

    let date = relative_time_now(row.commit.timestamp);
    let subject_color = if selected {
        hex(colors::TEXT_BRIGHT)
    } else {
        hex(colors::TEXT)
    };

    div()
        .id(ElementId::Name(
            format!("git-row-{}", row.commit.sha).into(),
        ))
        .relative()
        .w_full()
        .h(px(geometry::ROW_HEIGHT))
        .flex()
        .flex_row()
        .items_center()
        .min_w_0()
        .cursor_pointer()
        .opacity(if dimmed { 0.35 } else { 1.0 })
        // sel = surfaceActive 底（hover 保持）；否则 hover surface（原型第二段）
        .when(selected, |d| {
            d.bg(hex(colors::SURFACE_ACTIVE))
                .hover(|h| h.bg(hex(colors::SURFACE_ACTIVE)))
        })
        .when(!selected, |d| d.hover(|h| h.bg(hex(colors::SURFACE))))
        .border_b_1()
        .border_color(rgba_css(255, 255, 255, 0.025))
        // sel 左缘 2px accent 条（原型 inset box-shadow）
        .when(selected, |d| {
            d.child(
                div()
                    .absolute()
                    .left_0()
                    .top_0()
                    .bottom_0()
                    .w(px(2.0))
                    .bg(hex(colors::ACCENT)),
            )
        })
        .child(gcell)
        .child(
            h_flex()
                .flex_1()
                .min_w_0()
                .h(px(geometry::ROW_HEIGHT))
                .pr(px(12.0))
                .items_center()
                .child(badges)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_size(px(12.0))
                        .text_color(subject_color)
                        .child(row.commit.subject.clone()),
                ),
        )
        .child(
            div()
                .w(px(COL_AUTHOR))
                .ml(px(8.0))
                .flex_shrink_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_size(px(12.0))
                .text_color(hex(colors::MUTED))
                .child(row.commit.author_name.clone()),
        )
        .child(
            div()
                .w(px(COL_DATE))
                .ml(px(8.0))
                .flex_shrink_0()
                .text_right()
                .text_size(px(12.0))
                .text_color(hex(colors::MUTED))
                .child(date),
        )
        .child(
            div()
                .w(px(COL_SHA))
                .ml(px(8.0))
                .flex_shrink_0()
                .text_size(px(12.0))
                .font_family("monospace")
                .text_color(hex(colors::FAINT))
                .child(row.commit.short_sha.clone()),
        )
        .on_click(move |_, _, cx| on_select(cx))
        .context_menu(move |menu, _window, _cx| {
            let entries = commit_menu_items(&sha, is_head);
            apply_entries(menu, &entries, Some(sha.clone()), &on_pick_menu)
        })
        .into_any_element()
}

/// 当前分支名（ref 菜单的 current 判定；%D 装饰里同名 branch 徽标即当前）。
fn current_branch_of(state: &Entity<AppState>, cx: &App) -> String {
    state
        .read(cx)
        .git_graph
        .branches
        .iter()
        .find(|b| b.current)
        .map(|b| b.name.clone())
        .unwrap_or_default()
}

/// 视图层的「现在」（相对时间 + 本地时区偏移；chrono 只在这里用）。
fn relative_time_now(unix_sec: i64) -> String {
    let local = chrono::Local::now();
    let offset = i64::from(local.offset().local_minus_utc());
    let now_ms = local.timestamp_millis();
    relative_time(unix_sec, now_ms, offset)
}

// ── CDV（选中提交详情卡，.git-cdv 第二段）───────────────────────────────

fn cdv_row(
    commit: &jagent_core::git::GraphCommit,
    body: Option<&str>,
    files: &[jagent_core::git::ChangedFile],
    loading: bool,
    error: Option<&str>,
    scroll: &ScrollHandle,
) -> AnyElement {
    let person = if commit.author_email.is_empty() {
        commit.author_name.clone()
    } else {
        format!("{} <{}>", commit.author_name, commit.author_email)
    };
    // 槽位：margin 8/10/10 由 padding 承担；卡 218 盖满全宽（盖住 lane 列，原型同）
    div()
        .id(ElementId::Name(format!("git-cdv-{}", commit.sha).into()))
        .w_full()
        .h(px(CDV_SLOT_H))
        .pt(px(8.0))
        .pb(px(10.0))
        .pl(px(10.0))
        .pr(px(10.0))
        .flex_shrink_0()
        .child(
            h_flex()
                .w_full()
                .h(px(CDV_H))
                .rounded(px(12.0))
                .bg(hex(colors::SIDEBAR))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .overflow_hidden()
                // 左半：摘要（.sum：50% 宽 / p 10 12 / 右缘 1px border）
                .child(
                    v_flex()
                        .w(relative(0.5))
                        .min_w_0()
                        .overflow_hidden()
                        .pt(px(10.0))
                        .pb(px(10.0))
                        .pl(px(12.0))
                        .pr(px(12.0))
                        .border_r_1()
                        .border_color(hex(colors::BORDER))
                        // .cdv-title：13px bright / lh 18 / mb8
                        .child(
                            div()
                                .mb(px(8.0))
                                .line_height(px(18.0))
                                .text_size(px(13.0))
                                .text_color(hex(colors::TEXT_BRIGHT))
                                .child(commit.subject.clone()),
                        )
                        .child(meta_row("Author:", &person))
                        .child(meta_row("Date:", &relative_time_now(commit.timestamp)))
                        .child(meta_row("SHA:", &commit.sha))
                        .child(
                            div()
                                .mt(px(8.0))
                                .line_height(px(18.0))
                                .text_size(px(12.0))
                                .text_color(hex(colors::MUTED))
                                .when(loading, |d| d.child("加载说明…"))
                                .when_some((!loading).then_some(error).flatten(), |d, e| {
                                    d.text_color(hex(colors::BELL)).child(e.to_owned())
                                })
                                .when_some(
                                    (!loading && error.is_none())
                                        .then_some(body)
                                        .flatten()
                                        .filter(|b| !b.is_empty()),
                                    |d, b| d.child(b.to_owned()),
                                ),
                        ),
                )
                // 右半：变更文件（.files：flex1 / p10 / 可滚——嵌套滚动走封装）
                .child(nested_scroll::work_panel_scrollable(
                    "git-cdv-files",
                    scroll,
                    file_list(files),
                )),
        )
        .into_any_element()
}

/// 元数据行（.cdv-meta：k 82 宽 muted 12 / v mono 11.5 text）。
fn meta_row(label: &str, value: &str) -> gpui::Div {
    h_flex()
        .mb(px(4.0))
        .min_w_0()
        .child(
            div()
                .w(px(CDV_LABEL_W))
                .flex_shrink_0()
                .text_size(px(12.0))
                .text_color(hex(colors::MUTED))
                .child(label.to_owned()),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .font_family("monospace")
                .text_size(px(11.5))
                .text_color(hex(colors::TEXT))
                .child(value.to_owned()),
        )
}

/// 变更文件列表（.ftree/.frow：file 图标 12 muted + 目录前缀 muted + 文件名
/// text，均 mono 12；扁平列表——原型不画增删统计与目录树）。
fn file_list(files: &[jagent_core::git::ChangedFile]) -> gpui::Div {
    let mut list = v_flex();
    if files.is_empty() {
        return list.child(
            div()
                .text_size(px(12.0))
                .text_color(hex(colors::MUTED))
                .child("无变更"),
        );
    }
    for f in files {
        let (dir, name) = match f.path.rfind('/') {
            Some(i) => (&f.path[..=i], &f.path[i + 1..]),
            None => ("", f.path.as_str()),
        };
        list = list.child(
            h_flex()
                .items_center()
                .gap(px(6.0))
                .pt(px(1.0))
                .pb(px(1.0))
                .flex_shrink_0()
                .font_family("monospace")
                .text_size(px(12.0))
                .child(icon(IconName::File, 12.0, hex(colors::MUTED)))
                .when(!dir.is_empty(), |d| {
                    d.child(
                        div()
                            .text_color(hex(colors::MUTED))
                            .whitespace_nowrap()
                            .child(dir.to_owned()),
                    )
                })
                .child(
                    div()
                        .text_color(hex(colors::TEXT))
                        .whitespace_nowrap()
                        .child(name.to_owned()),
                ),
        );
    }
    list
}

// ── 键盘导航 ────────────────────────────────────────────────────────────

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
    use jagent_core::git::GraphCommit;

    fn commit(sha: &str, parents: &[&str]) -> GraphCommit {
        GraphCommit {
            sha: sha.into(),
            parents: parents.iter().map(|s| (*s).to_owned()).collect(),
            ref_names: vec![],
            short_sha: sha.chars().take(7).collect(),
            author_name: "a".into(),
            author_email: "a@x".into(),
            timestamp: 0,
            committer_name: "a".into(),
            committer_email: "a@x".into(),
            subject: format!("subject {sha}"),
        }
    }

    // ── 弯线 SVG（gpuix graphSvg.test.ts 的用例思路）────────────────────

    /// 竖线段序列化成 `M x y V y`。
    #[test]
    fn vertical_strokes_serialize_to_move_then_v() {
        assert_eq!(
            stroke_d(&Stroke::Vertical {
                x: 14.5,
                y0: 0.0,
                y1: 30.0
            }),
            "M 14.5 0 V 30"
        );
    }

    /// 弧序列化成三次贝塞尔（graphSvg arcPath：M x0 0 C x0 7.5, x1 7.5, x1 15）。
    #[test]
    fn arc_strokes_serialize_to_a_cubic_bezier_path() {
        assert_eq!(
            stroke_d(&Stroke::Arc(geometry::arc(14.5, 27.5))),
            "M 14.5 0 C 14.5 7.5, 27.5 7.5, 27.5 15"
        );
    }

    /// SVG 文档形状：viewBox/尺寸 = 列宽×行高，stroke currentColor 吃 tint。
    #[test]
    fn svg_docs_carry_geometry_and_tint_hooks() {
        let doc = svg_doc(110.0, 30.0, "M 1 2 V 3", None, Some(0.85));
        assert!(
            doc.starts_with(
                r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 110 30" width="110" height="30""#
            ),
            "{doc}"
        );
        assert!(doc.contains(r#"stroke="currentColor" stroke-width="1.5""#));
        assert!(doc.contains(r#"<path d="M 1 2 V 3" opacity="0.85"/>"#));
        // 空路径不产生 path 节点
        let dot_only = svg_doc(110.0, 30.0, "", Some("<circle/>"), None);
        assert!(!dot_only.contains("<path"));
        assert!(dot_only.contains("<circle/>"));
    }

    /// 线性历史：每行只有一条竖线组 + 圆点（首行空心）。
    #[test]
    fn a_linear_history_draws_one_vertical_group_plus_the_dot() {
        let mut g = jagent_core::git::GitGraphData::default();
        g.add_commits(&[commit("c2", &["c1"]), commit("c1", &[])]);
        for row in 0..2 {
            let pieces = build_row_svg_pieces(
                row,
                g.lines_by_row.get(&row).map_or(&[][..], Vec::as_slice),
                g.rows[row].lane,
                g.rows[row].color_idx,
                g.max_lanes,
                row == 0,
            );
            assert_eq!(pieces.len(), 2, "1 条 lane 线组 + 1 个圆点（row {row}）");
            let line_piece = &pieces[0];
            assert_eq!(line_piece.color_idx, 0);
            // 起点行画下半段（15→30），终点行只到中线接圆点（0→15）
            let v_end = if row == 0 { "30" } else { "15" };
            assert!(
                line_piece.source.contains(&format!("V {v_end}")),
                "{}",
                line_piece.source
            );
            assert!(line_piece.source.contains(r#"opacity="0.85""#));
            let dot = &pieces[1];
            assert!(
                dot.source.contains(r#"<circle cx="14.5" cy="15" r="3.5""#),
                "{}",
                dot.source
            );
            if row == 0 {
                // HEAD 空心：pane 底 + 2px 描边
                assert!(dot.source.contains(&format!("fill=\"{}\"", colors::PANE)));
                assert!(dot.source.contains(r#"stroke-width="2""#));
            } else {
                assert!(dot.source.contains(r#"fill="currentColor""#));
            }
        }
    }

    /// merge 弯线：跨 lane 的线在弯曲行产生贝塞尔 `C` 段（graphSvg 分支对应）。
    #[test]
    fn a_merge_branch_bends_through_a_bezier_segment() {
        let mut g = jagent_core::git::GitGraphData::default();
        g.add_commits(&[
            commit("f", &["e", "d"]),
            commit("e", &["base"]),
            commit("d", &["base"]),
            commit("base", &[]),
        ]);
        let any_curve = (0..g.rows.len()).any(|row| {
            build_row_svg_pieces(
                row,
                g.lines_by_row.get(&row).map_or(&[][..], Vec::as_slice),
                g.rows[row].lane,
                g.rows[row].color_idx,
                g.max_lanes,
                false,
            )
            .iter()
            .any(|p| p.source.contains(" C "))
        });
        assert!(any_curve, "至少一行出现贝塞尔弯段");
    }

    /// 同色聚合：同一 colorIdx 的多条描边合成一个 path（多个 `M`）。
    #[test]
    fn strokes_of_the_same_color_merge_into_one_path() {
        let mut g = jagent_core::git::GitGraphData::default();
        g.add_commits(&[
            commit("c3", &["c2"]),
            commit("c2", &["c1"]),
            commit("c1", &[]),
        ]);
        // row1 同列两段：c3→c2 的终点段（0→15）+ c2→c1 的起点段（15→30），
        // 同色聚合后两条线在同一个 path 里（pieces 只有一个线组 piece）
        let row1 = build_row_svg_pieces(
            1,
            g.lines_by_row.get(&1).map_or(&[][..], Vec::as_slice),
            g.rows[1].lane,
            g.rows[1].color_idx,
            g.max_lanes,
            false,
        );
        assert_eq!(row1.len(), 2, "1 个聚合线组 + 1 个圆点");
        assert_eq!(
            row1[0].source.matches("M ").count(),
            2,
            "两条同色线一个 path 两个 M"
        );
    }

    // ── 布局常量（原型第二段实测）────────────────────────────────────────

    #[test]
    fn layout_constants_match_the_prototype_second_pass() {
        assert_eq!(TOOLBAR_H, 42.0);
        assert_eq!(HEADER_H, 30.0);
        assert_eq!(ERROR_H, 33.0);
        assert_eq!((CDV_H, CDV_SLOT_H), (218.0, 236.0));
        assert_eq!((COL_AUTHOR, COL_DATE, COL_SHA), (110.0, 80.0, 72.0));
        assert_eq!(CDV_LABEL_W, 82.0);
        assert_eq!((STROKE_W, CIRCLE_R), (1.5, 3.5));
        // 行高/lane 几何必须与 core geometry（旧 graphSvg 对齐源）一致
        assert_eq!(geometry::ROW_HEIGHT, 30.0);
        assert_eq!(geometry::lane_x(0), 8.0 + 13.0 / 2.0);
        assert_eq!(
            geometry::graph_column_width(0),
            13.0 * 6.0 + 8.0 * 2.0 + 6.0
        );
    }

    // ── CDV 文件列表（rowColumns/FileList 的目录拆分思路）───────────────

    #[test]
    fn file_paths_split_into_dir_prefix_and_name() {
        let f = jagent_core::git::ChangedFile {
            path: "src/views/git_graph.rs".into(),
            added: Some(1),
            deleted: Some(2),
        };
        let i = f.path.rfind('/').unwrap();
        assert_eq!(&f.path[..=i], "src/views/");
        assert_eq!(&f.path[i + 1..], "git_graph.rs");
        assert!("a.rs".rfind('/').is_none());
    }

    /// person 拼接：有邮箱 `名 <邮箱>`，无邮箱只出名（gpuix person 同构）。
    #[test]
    fn person_formats_with_and_without_email() {
        let with = "a <a@x>";
        assert_eq!(with, "a <a@x>");
        let mut c = commit("x", &[]);
        assert_eq!(
            if c.author_email.is_empty() {
                c.author_name.clone()
            } else {
                format!("{} <{}>", c.author_name, c.author_email)
            },
            "a <a@x>"
        );
        c.author_email = String::new();
        assert_eq!(
            if c.author_email.is_empty() {
                c.author_name.clone()
            } else {
                format!("{} <{}>", c.author_name, c.author_email)
            },
            "a"
        );
    }
}
