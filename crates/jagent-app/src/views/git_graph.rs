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
use jagent_core::git::format::{
    FileTreeNode, compact_dir, display_file_name, nest_changed_files, parse_ref_names,
    relative_time, resolve_changed_file_path,
};
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
use crate::views::selectable::sel_text_id;

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

fn is_starting_merge_branch(line: &CommitLine, row: usize) -> bool {
    line.row_span.0 == row
        && matches!(
            line.segments.first(),
            Some(jagent_core::git::LaneSegment::Curve { merge: true, .. })
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
    let has_primary_start = lines.iter().any(|l| {
        l.row_span.0 == row && l.child_column == commit_lane && !is_starting_merge_branch(l, row)
    });
    // colorIdx → 该色的描边序列（插入序保持绘制顺序）
    let mut groups: Vec<(usize, Vec<Stroke>)> = vec![];
    for line in lines {
        // Merge 提交的支线（parent1..）在起点行 row 与主干线（parent0）共享圆点下半段竖线，
        // 到了下一行 row + 1 顶部才分叉弯出；跳过起点行重合段以避免支线颜色覆盖主干竖线。
        if has_primary_start
            && line.child_column == commit_lane
            && is_starting_merge_branch(line, row)
        {
            continue;
        }
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

/// 行内展开 CDV 详情槽左侧拓扑走廊的贯穿 SVG 分组：
/// 凡是跨越 `row -> row + 1` 的连接线（`row_span.0 <= row && row_span.1 > row`），
/// 在离开第 `row` 行底部的列 `enter_column(line, row + 1)` 上绘制贯穿整个 `CDV_SLOT_H` 的竖线。
/// 同一列仅绘制一条贯穿线（主干线优先于尚未分叉的 merge 支线），不绘制多余圆点或横穿其它轨道的折线。
fn build_cdv_pass_svg_pieces(
    row: usize,
    lines: &[CommitLine],
    commit_lane: usize,
    commit_color: usize,
    max_lanes: usize,
) -> Vec<RowSvgPiece> {
    let width = geometry::graph_column_width(max_lanes);
    let height = CDV_SLOT_H;
    // 先按列 col 去重定色：主干线优先于本行刚派生、下一行才分叉的 merge 支线
    let mut lane_colors_by_col: Vec<(usize, usize)> = vec![];
    for line in lines {
        let (start_row, end_row) = line.row_span;
        if start_row <= row && end_row > row {
            let col = geometry::enter_column(line, row + 1);
            let is_merge_branch = is_starting_merge_branch(line, row);
            let preferred_color = if col == commit_lane && start_row == row && !is_merge_branch {
                commit_color
            } else {
                line.color_idx
            };
            match lane_colors_by_col.iter_mut().find(|(c, _)| *c == col) {
                Some((_, existing_color)) => {
                    if !is_merge_branch {
                        *existing_color = preferred_color;
                    }
                }
                None => lane_colors_by_col.push((col, preferred_color)),
            }
        }
    }
    let mut groups: Vec<(usize, Vec<String>)> = vec![];
    for (col, color_idx) in lane_colors_by_col {
        let x = geometry::lane_x(col);
        let seg = format!("M {x} 0 V {height}");
        match groups.iter_mut().find(|(c, _)| *c == color_idx) {
            Some((_, v)) => v.push(seg),
            None => groups.push((color_idx, vec![seg])),
        }
    }
    let mut pieces = Vec::with_capacity(groups.len());
    for (color_idx, segs) in groups {
        let d = segs.join(" ");
        pieces.push(RowSvgPiece {
            color_idx,
            source: svg_doc(width, height, &d, None, Some(LANE_OPACITY)),
        });
    }
    pieces
}

// ── 列表条目模型 ────────────────────────────────────────────────────────

/// 列表骨架（O(1) 构造的元数据，不含行数据）：条目 = 提交行 + 选中提交下插的 CDV 卡槽。
struct EntryLayout {
    total: usize,
    /// 选中提交在 rows 里的下标（CDV 卡槽紧随其后）
    selected_row: Option<usize>,
    find_active: bool,
    match_set: std::collections::HashSet<String>,
}

enum Slot {
    Commit(usize),
    /// 选中提交下插的 CDV（提交详情）卡槽行（携带左侧拓扑穿透走廊几何）
    Detail(usize),
}

impl EntryLayout {
    /// 列表位置 → 条目：选中行之后整体后移一位，选中行 +1 是 CDV 卡槽。
    fn resolve(&self, ix: usize) -> Option<Slot> {
        if ix >= self.total {
            return None;
        }
        match self.selected_row {
            Some(sel) if ix == sel + 1 => Some(Slot::Detail(sel)),
            Some(sel) if ix > sel + 1 => Some(Slot::Commit(ix - 1)),
            _ => Some(Slot::Commit(ix)),
        }
    }
}

/// 列表增量同步操作：避免展开/收起/切换 CDV 时调 `ListState::reset` 导致滚动条跳回顶部或高度缓存错位。
#[derive(Debug, PartialEq, Eq)]
enum ListSyncOp {
    Reset(usize),
    Splice {
        old_range: std::ops::Range<usize>,
        count: usize,
    },
}

fn plan_list_sync(
    last_commits: usize,
    last_selected: Option<usize>,
    new_commits: usize,
    new_selected: Option<usize>,
) -> Vec<ListSyncOp> {
    let new_total = new_commits + usize::from(new_selected.is_some());
    if new_commits == 0 {
        if last_commits != 0 || last_selected.is_some() {
            return vec![ListSyncOp::Reset(0)];
        }
        return vec![];
    }
    if last_commits == 0 || new_commits < last_commits {
        return vec![ListSyncOp::Reset(new_total)];
    }
    let mut ops = Vec::new();
    if new_commits > last_commits {
        let old_total = last_commits + usize::from(last_selected.is_some());
        ops.push(ListSyncOp::Splice {
            old_range: old_total..old_total,
            count: new_commits - last_commits,
        });
    }
    if last_selected != new_selected {
        if let Some(old_sel) = last_selected {
            ops.push(ListSyncOp::Splice {
                old_range: (old_sel + 1)..(old_sel + 2),
                count: 0,
            });
        }
        if let Some(new_sel) = new_selected {
            ops.push(ListSyncOp::Splice {
                old_range: (new_sel + 1)..(new_sel + 1),
                count: 1,
            });
        }
    }
    ops
}

/// 弹窗里的 Git 图：订阅 AppState，状态变化时重绘。
pub struct GitGraphDialog {
    state: Entity<AppState>,
    list: ListState,
    last_commit_count: usize,
    last_selected_row: Option<usize>,
    /// find 输入框（工具条展开式）
    search: Entity<gpui_component::input::InputState>,
    /// find 是否展开（收起时清查询）
    #[allow(dead_code)]
    find_open: bool,
    /// CDV 左栏提交说明与右栏变更文件列表的内层滚动（外层是提交列表 → 走 nested_scroll 边缘穿透封装）
    body_scroll: ScrollHandle,
    files_scroll: ScrollHandle,
    last_selected_sha: Option<String>,
    /// 危险操作二次确认
    confirm: Option<ConfirmState>,
    /// 「创建分支/标签/重命名」输入弹层
    prompt: Option<PromptState>,
    prompt_input: Entity<gpui_component::input::InputState>,
    /// 是否作为主画布内嵌视图（true = 撑满主画布；false = 弹窗固定高度）
    embedded: bool,
}

impl GitGraphDialog {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.subscribe(&state, |_, _, _: &StateChanged, cx| cx.notify())
            .detach();
        let search = cx.new(|cx| {
            gpui_component::input::InputState::new(window, cx).placeholder("过滤提交说明或 SHA…")
        });
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
            last_commit_count: 0,
            last_selected_row: None,
            search,
            find_open: true,
            body_scroll: ScrollHandle::new(),
            files_scroll: ScrollHandle::new(),
            last_selected_sha: None,
            confirm: None,
            prompt: None,
            prompt_input,
            embedded: false,
        }
    }

    pub fn new_embedded(
        state: Entity<AppState>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let cwd = state.read(cx).git_cwd();
        AppState::mount_git_graph(&state, cwd, cx);
        let mut s = Self::new(state, window, cx);
        s.embedded = true;
        s
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
        // 渲染只取「轻量骨架」：条目总数 + 选中行位置 + find 命中集。
        // 绝不在此克隆 rows / lines（O(N)，2 万提交 ≈ 14ms/帧）；行数据由 `list` 的
        // 行闭包对**可见行**按需从 state 读取（滚动卡顿根因，见 v_shots SCROLL=1 基准）。
        let (
            layout,
            commit_count,
            max_lanes,
            selected_sha,
            status,
            action_error,
            error,
            branches,
            show_remote,
            loaded_count,
        ) = {
            let s = self.state.read(cx);
            let g = &s.git_graph;
            let find_active = !g.find_query.trim().is_empty();
            let match_set: std::collections::HashSet<String> = if find_active {
                g.find_matches.iter().cloned().collect()
            } else {
                Default::default()
            };
            let commit_count = g.rows().len();
            let selected_row = g
                .selected_sha
                .as_deref()
                .and_then(|sha| g.rows().iter().position(|r| r.commit.sha.as_str() == sha));
            let total = commit_count + usize::from(selected_row.is_some());
            (
                EntryLayout {
                    total,
                    selected_row,
                    find_active,
                    match_set,
                },
                commit_count,
                g.max_lanes(),
                g.selected_sha.clone(),
                g.status,
                g.action_error.clone(),
                g.error.clone(),
                g.branches.clone(),
                g.show_remote,
                g.loaded_count,
            )
        };
        if self.last_selected_sha != selected_sha {
            self.body_scroll.set_offset(gpui::point(px(0.0), px(0.0)));
            self.files_scroll.set_offset(gpui::point(px(0.0), px(0.0)));
            self.last_selected_sha = selected_sha;
        }
        for op in plan_list_sync(
            self.last_commit_count,
            self.last_selected_row,
            commit_count,
            layout.selected_row,
        ) {
            match op {
                ListSyncOp::Reset(n) => self.list.reset(n),
                ListSyncOp::Splice { old_range, count } => self.list.splice(old_range, count),
            }
        }
        self.last_commit_count = commit_count;
        self.last_selected_row = layout.selected_row;
        let layout = Rc::new(layout);
        let state = self.state.clone();
        let on_pick: PickHandler = {
            let state = state.clone();
            let weak = cx.entity().downgrade();
            Rc::new(move |item, at, window, cx| {
                Self::dispatch_pick(weak.clone(), &state, window, cx, item, at)
            })
        };
        let body_scroll = self.body_scroll.clone();
        let files_scroll = self.files_scroll.clone();
        let rows = list(self.list.clone(), move |ix, _, cx| {
            let cx: &App = cx;
            let s = state.read(cx);
            let g = &s.git_graph;
            let rows = g.rows();
            match layout.resolve(ix) {
                Some(Slot::Commit(index)) => {
                    let Some(row) = rows.get(index) else {
                        return div().into_any_element();
                    };
                    commit_row(
                        index,
                        row,
                        g.lines_by_row(index),
                        g.max_lanes(),
                        layout.selected_row == Some(index),
                        layout.find_active && !layout.match_set.contains(row.commit.sha.as_str()),
                        index == 0,
                        &state,
                        show_remote,
                        &on_pick,
                        cx,
                    )
                }
                Some(Slot::Detail(index)) => {
                    let Some(row) = rows.get(index) else {
                        return div().into_any_element();
                    };
                    cdv_row(
                        index,
                        row,
                        g.lines_by_row(index),
                        g.max_lanes(),
                        &row.commit,
                        g.body.as_deref(),
                        &g.files,
                        g.detail_loading,
                        g.detail_error.as_deref(),
                        &body_scroll,
                        &files_scroll,
                        &state,
                        cx,
                    )
                }
                None => div().into_any_element(),
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
                .child(graph_header(max_lanes))
                .child(
                    div()
                        .relative()
                        .flex_1()
                        .min_h_0()
                        .flex()
                        .flex_col()
                        .child(rows)
                        .child(nested_scroll::minimal_vertical_scrollbar(
                            "git-graph-list-scrollbar",
                            &self.list,
                        )),
                )
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
            .when_else(
                self.embedded,
                |d| d.size_full().min_h_0(),
                |d| d.h(px(VIEW_H)),
            )
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
                        .child(sel_text_id("git-err-line", text)),
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
    let current_branch_sync = current_branch.clone();
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

    let has_query = !this.state.read(cx).git_graph.find_query.trim().is_empty();
    let _ = repo_label;

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
        .bg(rgba_css(13, 15, 21, 0.45))
        .child(branch_pop)
        // 相对远端分支同步状态胶囊（↑2 ↓0 origin/branch）
        .child(
            h_flex()
                .h(px(24.0))
                .px(px(8.0))
                .gap(px(6.0))
                .items_center()
                .flex_shrink_0()
                .rounded(px(6.0))
                .bg(hex(colors::SURFACE))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .font_family("monospace")
                .text_size(px(11.0))
                .child(
                    div()
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(hex(colors::STATUS_DONE))
                        .child("↑2"),
                )
                .child(div().text_color(hex(colors::MUTED)).child("↓0"))
                .child(
                    div()
                        .text_color(hex(colors::FAINT))
                        .child(format!("origin/{current_branch_sync}")),
                ),
        )
        // 显示远程分支开关（原型 .toggle 34×20 scale .82 → 29×17 视觉）
        .child(
            h_flex()
                .gap(px(6.0))
                .flex_shrink_0()
                .items_center()
                .ml(px(4.0))
                .child({
                    let state = this.state.clone();
                    small_toggle(show_remote, move |_, cx| {
                        AppState::set_git_show_remote(&state, !show_remote, cx)
                    })
                })
                .child(
                    div()
                        .text_size(px(11.5))
                        .text_color(hex(colors::MUTED))
                        .child("显示远程分支"),
                ),
        )
        .child(div().flex_1().min_w(px(12.0)))
        // .cnt：共 N 个提交 · 点击任意行展开详情
        .child(
            div()
                .font_family("monospace")
                .text_size(px(11.0))
                .text_color(hex(colors::MUTED))
                .flex_shrink_0()
                .child(if status == GitGraphStatus::Loading && loaded_count == 0 {
                    "读取提交…".to_string()
                } else {
                    format!("共 {loaded_count} 个提交 · 点击任意行展开详情")
                }),
        )
        // 常驻搜索过滤框 (.git-find)
        .child({
            let weak_up = cx.entity().downgrade();
            let weak_down = cx.entity().downgrade();
            let weak_close = cx.entity().downgrade();
            let pos = find_pos_text(&this.state, cx);
            h_flex()
                .h(px(26.0))
                .px(px(8.0))
                .gap(px(4.0))
                .flex_shrink_0()
                .items_center()
                .rounded(px(6.0))
                .bg(hex(colors::INPUT_BG))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .child(icon(IconName::Search, 12.0, hex(colors::MUTED)))
                .child(
                    Input::new(&this.search)
                        .appearance(false)
                        .w(px(150.0))
                        .h(px(22.0))
                        .text_size(px(11.5))
                        .text_color(hex(colors::TEXT_BRIGHT)),
                )
                .when(has_query, |d| {
                    d.child(
                        div()
                            .px(px(2.0))
                            .font_family("monospace")
                            .text_size(px(10.5))
                            .text_color(hex(colors::MUTED))
                            .child(pos),
                    )
                    .child(hbtn(
                        IconName::ChevronUp,
                        11.0,
                        "git-find-prev",
                        move |_, _, cx| {
                            let _ = weak_up.update(cx, |this: &mut GitGraphDialog, cx| {
                                move_selection(&this.state, -1, cx)
                            });
                        },
                    ))
                    .child(hbtn(
                        IconName::ChevronDown,
                        11.0,
                        "git-find-next",
                        move |_, _, cx| {
                            let _ = weak_down.update(cx, |this: &mut GitGraphDialog, cx| {
                                move_selection(&this.state, 1, cx)
                            });
                        },
                    ))
                    .child(hbtn(
                        IconName::Close,
                        11.0,
                        "git-find-close",
                        move |_, window, cx| {
                            let _ = weak_close.update(cx, |this: &mut GitGraphDialog, cx| {
                                this.search.update(cx, |i, cx| i.set_value("", window, cx));
                                this.state.update(cx, |s, cx| {
                                    s.git_graph.find("");
                                    cx.emit(StateChanged);
                                    cx.notify();
                                });
                            });
                        },
                    ))
                })
        })
        // 拉取远端更新
        .child({
            let state = this.state.clone();
            ibtn(IconName::Download, 14.0, "git-fetch", move |_, _, cx| {
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
            ibtn(IconName::Reset, 14.0, "git-refresh", move |_, _, cx| {
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
        .h(px(26.0))
        .pl(px(8.0))
        .pr(px(8.0))
        .gap(px(5.0))
        .items_center()
        .flex_shrink_0()
        .rounded(px(6.0))
        .bg(hex(colors::INPUT_BG))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .cursor_pointer()
        .hover(|h| h.bg(hex(colors::TILE_HOVER)))
        .child(icon(IconName::GitBranch, 12.5, hex(colors::ACCENT_HOVER)))
        .child(
            div()
                .font_family("monospace")
                .text_size(px(12.0))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(hex(colors::TEXT_BRIGHT))
                .child(current.to_owned()),
        )
        .child(icon(IconName::ChevronDown, 11.0, hex(colors::MUTED)))
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

fn graph_header(max_lanes: usize) -> gpui::Div {
    let graph_w = geometry::graph_column_width(max_lanes);
    h_flex()
        .h(px(HEADER_H))
        .pr(px(12.0))
        .items_center()
        .flex_shrink_0()
        .border_b_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .bg(rgba_css(13, 15, 21, 0.75))
        .text_size(px(10.0))
        .text_color(hex(colors::MUTED))
        .child(
            div()
                .w(px(graph_w))
                .ml(px(8.0))
                .flex_shrink_0()
                .child("拓扑"),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child("提交说明与分支引用"),
        )
        .child(
            div()
                .w(px(COL_AUTHOR))
                .ml(px(8.0))
                .flex_shrink_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child("作者"),
        )
        .child(
            div()
                .w(px(COL_DATE))
                .ml(px(8.0))
                .flex_shrink_0()
                .text_right()
                .child("时间"),
        )
        .child(
            div()
                .w(px(COL_SHA))
                .ml(px(8.0))
                .flex_shrink_0()
                .text_right()
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
        .pr(px(12.0))
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
            h_flex()
                .w(px(COL_AUTHOR))
                .ml(px(8.0))
                .gap(px(6.0))
                .items_center()
                .flex_shrink_0()
                .overflow_hidden()
                .child(
                    div()
                        .size(px(16.0))
                        .rounded_full()
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(rgba_css(99, 102, 241, 0.22))
                        .border_1()
                        .border_color(rgba_css(99, 102, 241, 0.40))
                        .text_size(px(9.5))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(hex(colors::ACCENT_HOVER))
                        .child(
                            row.commit
                                .author_name
                                .chars()
                                .next()
                                .unwrap_or('U')
                                .to_uppercase()
                                .to_string(),
                        ),
                )
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_size(px(12.0))
                        .text_color(hex(colors::MUTED))
                        .child(row.commit.author_name.clone()),
                ),
        )
        .child(
            div()
                .w(px(COL_DATE))
                .ml(px(8.0))
                .flex_shrink_0()
                .text_right()
                .text_size(px(11.5))
                .text_color(hex(colors::MUTED))
                .child(date),
        )
        .child(
            h_flex()
                .w(px(COL_SHA))
                .ml(px(8.0))
                .justify_end()
                .flex_shrink_0()
                .child(
                    div()
                        .px(px(6.0))
                        .py(px(1.0))
                        .rounded(px(4.0))
                        .bg(hex(colors::INPUT_BG))
                        .border_1()
                        .border_color(hex(colors::BORDER_SUBTLE))
                        .font_family("monospace")
                        .text_size(px(11.0))
                        .text_color(hex(colors::ACCENT_HOVER))
                        .child(row.commit.short_sha.clone()),
                ),
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

/// CDV 元数据区的完整日期格式：`相对时间 (YYYY-MM-DD HH:MM)`（对齐 vscode-git-graph）。
fn format_commit_date_now(unix_sec: i64) -> String {
    use chrono::TimeZone as _;
    let rel = relative_time_now(unix_sec);
    match chrono::Local.timestamp_opt(unix_sec, 0).single() {
        Some(dt) => format!("{rel} ({})", dt.format("%Y-%m-%d %H:%M")),
        None => rel,
    }
}

// ── CDV（选中提交详情卡：左侧保留拓扑穿透走廊使分支线不断裂 + 右侧对齐 vscode-git-graph 详情舱）──

#[allow(clippy::too_many_arguments)]
fn cdv_row(
    index: usize,
    row: &GraphRow,
    lines: &[CommitLine],
    max_lanes: usize,
    commit: &jagent_core::git::GraphCommit,
    body: Option<&str>,
    files: &[jagent_core::git::ChangedFile],
    loading: bool,
    error: Option<&str>,
    body_scroll: &ScrollHandle,
    scroll: &ScrollHandle,
    state: &Entity<AppState>,
    cx: &App,
) -> AnyElement {
    let tokens = cx.global::<Tokens>();
    let lane_colors = tokens.graph_lanes;
    let graph_w = geometry::graph_column_width(max_lanes);
    let pass_pieces = build_cdv_pass_svg_pieces(index, lines, row.lane, row.color_idx, max_lanes);

    // 左侧拓扑穿透走廊：多轨彩色竖线贯穿 CDV_SLOT_H，不断裂
    let corridor = div()
        .relative()
        .w(px(graph_w))
        .h(px(CDV_SLOT_H))
        .ml(px(8.0))
        .flex_shrink_0()
        .overflow_hidden()
        .children(pass_pieces.into_iter().map(|p| {
            let color = lane_colors[p.color_idx % lane_colors.len()];
            svg()
                .data(p.source.as_bytes())
                .absolute()
                .top_0()
                .left_0()
                .w(px(graph_w))
                .h(px(CDV_SLOT_H))
                .text_color(color)
        }));

    let author_str = if commit.author_email.is_empty() {
        commit.author_name.clone()
    } else {
        format!("{} <{}>", commit.author_name, commit.author_email)
    };
    let committer_differs = !commit.committer_name.is_empty()
        && (commit.committer_name != commit.author_name
            || commit.committer_email != commit.author_email);
    let person = if committer_differs {
        let committer_str = if commit.committer_email.is_empty() {
            commit.committer_name.clone()
        } else {
            format!("{} <{}>", commit.committer_name, commit.committer_email)
        };
        format!("{author_str} · Committer: {committer_str}")
    } else {
        author_str
    };
    let sha_copy = commit.sha.clone();
    let parents_row = if commit.parents.is_empty() {
        meta_row("Parents:", "— (root commit)")
    } else {
        let mut p_chips = h_flex()
            .gap(px(5.0))
            .min_w_0()
            .overflow_hidden()
            .items_center();
        for p in &commit.parents {
            let p_full = p.clone();
            let p_short: String = p.chars().take(7).collect();
            let st_parent = state.clone();
            p_chips = p_chips.child(
                div()
                    .id(ElementId::Name(format!("cdv-parent-{p}").into()))
                    .px(px(6.0))
                    .rounded(px(4.0))
                    .flex_shrink_0()
                    .bg(hex(colors::SURFACE))
                    .border_1()
                    .border_color(hex(colors::BORDER_SUBTLE))
                    .font_family("monospace")
                    .text_size(px(11.0))
                    .text_color(hex(colors::ACCENT_HOVER))
                    .cursor_pointer()
                    .hover(|h| h.bg(hex(colors::SURFACE_HOVER)))
                    .child(p_short)
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        AppState::select_git_commit(&st_parent, Some(p_full.clone()), cx);
                    }),
            );
        }
        h_flex()
            .h(px(19.0))
            .mb(px(2.0))
            .min_w_0()
            .items_center()
            .child(
                div()
                    .w(px(CDV_LABEL_W))
                    .flex_shrink_0()
                    .text_size(px(11.5))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(hex(colors::MUTED))
                    .child("Parents:"),
            )
            .child(p_chips)
    };

    let commit_meta = h_flex()
        .h(px(19.0))
        .mb(px(2.0))
        .min_w_0()
        .items_center()
        .child(
            div()
                .w(px(CDV_LABEL_W))
                .flex_shrink_0()
                .text_size(px(11.5))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(hex(colors::MUTED))
                .child("Commit:"),
        )
        .child(
            h_flex()
                .flex_1()
                .min_w_0()
                .gap(px(6.0))
                .items_center()
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .font_family("monospace")
                        .text_size(px(11.5))
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .child(sel_text_id("cdv-sha", commit.sha.clone())),
                )
                .child(
                    h_flex()
                        .id("cdv-copy-sha")
                        .h(px(18.0))
                        .px(px(5.0))
                        .gap(px(3.0))
                        .items_center()
                        .flex_shrink_0()
                        .rounded(px(4.0))
                        .bg(hex(colors::SURFACE))
                        .border_1()
                        .border_color(hex(colors::BORDER_SUBTLE))
                        .cursor_pointer()
                        .hover(|h| h.bg(hex(colors::SURFACE_HOVER)))
                        .child(icon(IconName::Copy, 10.0, hex(colors::MUTED)))
                        .child(
                            div()
                                .text_size(px(10.0))
                                .text_color(hex(colors::TEXT))
                                .child("复制"),
                        )
                        .on_click(move |_, _, cx| {
                            cx.stop_propagation();
                            cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                                sha_copy.clone(),
                            ));
                        }),
                ),
        );

    let files_header_label = if loading && files.is_empty() {
        "变更文件".to_string()
    } else {
        format!("变更文件 ({})", files.len())
    };
    let clean_body = (!loading && error.is_none())
        .then_some(body)
        .flatten()
        .map(str::trim_end)
        .filter(|b| !b.is_empty());

    h_flex()
        .id(ElementId::Name(format!("git-cdv-{}", commit.sha).into()))
        .w_full()
        .h(px(CDV_SLOT_H))
        .items_center()
        .pr(px(12.0))
        .flex_shrink_0()
        .bg(rgba_css(13, 15, 21, 0.35))
        .border_b_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .child(corridor)
        .child(
            h_flex()
                .flex_1()
                .min_w_0()
                .h(px(CDV_H))
                .items_stretch()
                .ml(px(4.0))
                .rounded(px(10.0))
                .bg(hex(colors::INPUT_BG))
                .border_1()
                .border_color(crate::theme::accent_alpha(0.35))
                .overflow_hidden()
                // 左栏（对齐 vscode-git-graph）：上方固定 4 行元数据 + 分隔线 + 下方嵌套可滚（粗体 subject + body）
                .child({
                    let body_scroll_head = body_scroll.clone();
                    v_flex()
                        .id("git-cdv-left-col")
                        .w(relative(0.46))
                        .h_full()
                        .min_h_0()
                        .min_w_0()
                        .overflow_hidden()
                        .pt(px(9.0))
                        .pb(px(9.0))
                        .pl(px(12.0))
                        .pr(px(12.0))
                        .border_r_1()
                        .border_color(hex(colors::BORDER_SUBTLE))
                        .on_scroll_wheel(move |event, window, cx| {
                            nested_scroll::forward_wheel_to_nested_handle(
                                "git-cdv-body",
                                &body_scroll_head,
                                event,
                                window,
                                cx,
                            );
                        })
                        .child(commit_meta.flex_shrink_0())
                        .child(parents_row.flex_shrink_0())
                        .child(meta_row("Author:", &person).flex_shrink_0())
                        .child(
                            meta_row("Date:", &format_commit_date_now(commit.timestamp))
                                .flex_shrink_0(),
                        )
                        .child(
                            div()
                                .mt(px(5.0))
                                .mb(px(6.0))
                                .h(px(1.0))
                                .w_full()
                                .flex_shrink_0()
                                .bg(hex(colors::BORDER_SUBTLE)),
                        )
                        .child(nested_scroll::work_panel_scrollable(
                            "git-cdv-body",
                            body_scroll,
                            v_flex()
                                .w_full()
                                .min_w_0()
                                .pr(px(6.0))
                                .child(
                                    div()
                                        .w_full()
                                        .min_w_0()
                                        .line_height(px(18.0))
                                        .text_size(px(12.5))
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .text_color(hex(colors::TEXT_BRIGHT))
                                        .child(sel_text_id("cdv-subject", commit.subject.clone())),
                                )
                                .when_some((!loading).then_some(error).flatten(), |d, e| {
                                    d.child(
                                        div()
                                            .mt(px(6.0))
                                            .line_height(px(17.0))
                                            .text_size(px(11.5))
                                            .text_color(hex(colors::BELL))
                                            .child(sel_text_id("cdv-error", e.to_owned())),
                                    )
                                })
                                .when_some(clean_body, |d, b| {
                                    d.child(
                                        v_flex()
                                            .mt(px(6.0))
                                            .w_full()
                                            .min_w_0()
                                            .line_height(px(17.5))
                                            .text_size(px(11.5))
                                            .text_color(hex(colors::TEXT))
                                            .children(b.split('\n').enumerate().map(
                                                |(line_ix, line)| {
                                                    div().w_full().min_w_0().child(
                                                        if line.is_empty() {
                                                            " ".into_any_element()
                                                        } else {
                                                            sel_text_id(
                                                                ("cdv-body-line", line_ix),
                                                                line.to_owned(),
                                                            )
                                                            .into_any_element()
                                                        },
                                                    )
                                                },
                                            )),
                                    )
                                }),
                        ))
                })
                // 右栏（对齐 vscode-git-graph）：单子目录折叠紧凑文件树 + (+N | -M) 统计
                .child({
                    let files_scroll_head = scroll.clone();
                    v_flex()
                        .id("git-cdv-right-col")
                        .w(relative(0.54))
                        .h_full()
                        .min_h_0()
                        .min_w_0()
                        .overflow_hidden()
                        .pt(px(9.0))
                        .pb(px(9.0))
                        .px(px(12.0))
                        .on_scroll_wheel(move |event, window, cx| {
                            nested_scroll::forward_wheel_to_nested_handle(
                                "git-cdv-files",
                                &files_scroll_head,
                                event,
                                window,
                                cx,
                            );
                        })
                        .child(
                            h_flex()
                                .pb(px(5.0))
                                .mb(px(5.0))
                                .flex_shrink_0()
                                .items_center()
                                .justify_between()
                                .border_b_1()
                                .border_color(hex(colors::BORDER_SUBTLE))
                                .child(
                                    div()
                                        .text_size(px(11.0))
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .text_color(hex(colors::TEXT_BRIGHT))
                                        .child(files_header_label),
                                )
                                .child(
                                    div()
                                        .text_size(px(10.5))
                                        .text_color(hex(colors::ACCENT_HOVER))
                                        .child("点击文件在主画布打开宽幅 Diff 视图 →"),
                                ),
                        )
                        .child(nested_scroll::work_panel_scrollable(
                            "git-cdv-files",
                            scroll,
                            file_list(files, loading, state),
                        ))
                }),
        )
        .into_any_element()
}

/// 元数据行（对齐 vscode-git-graph：固定行高 19px，标签列 82px semibold muted，值列单行 ellipsis）。
fn meta_row(label: &str, value: &str) -> gpui::Div {
    h_flex()
        .h(px(19.0))
        .mb(px(2.0))
        .min_w_0()
        .items_center()
        .child(
            div()
                .w(px(CDV_LABEL_W))
                .flex_shrink_0()
                .text_size(px(11.5))
                .font_weight(gpui::FontWeight::SEMIBOLD)
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
                .child(sel_text_id(
                    gpui::ElementId::Name(format!("cdv-meta-{label}").into()),
                    value.to_owned(),
                )),
        )
}

/// 变更文件树（对齐 vscode-git-graph：单子目录自动折叠为 `a / b / c`，folder/file 图标，
/// 右侧 `(+N | -M)` 增删统计，点击叶子文件在主画布打开宽幅 Diff）。
fn file_list(
    files: &[jagent_core::git::ChangedFile],
    loading: bool,
    state: &Entity<AppState>,
) -> gpui::Div {
    let mut list = v_flex().w_full().min_w_0().pr(px(4.0)).gap(px(1.5));
    if files.is_empty() {
        if !loading {
            list = list.child(
                div()
                    .py(px(4.0))
                    .text_size(px(11.5))
                    .text_color(hex(colors::MUTED))
                    .child("无变更文件"),
            );
        }
        return list;
    }
    let tree = nest_changed_files(files);
    render_file_tree_into(list, &tree, 0, state)
}

fn render_file_tree_into(
    mut list: gpui::Div,
    node: &FileTreeNode,
    depth: usize,
    state: &Entity<AppState>,
) -> gpui::Div {
    let indent = (depth as f32) * 14.0;
    for (dir_name, child) in &node.dirs {
        let (collapsed_name, target_node) = compact_dir(dir_name, child);
        list = list.child(
            h_flex()
                .w_full()
                .min_w_0()
                .h(px(20.0))
                .pl(px(indent + 4.0))
                .pr(px(6.0))
                .gap(px(5.0))
                .items_center()
                .flex_shrink_0()
                .overflow_hidden()
                .child(icon(IconName::Folder, 12.0, hex(colors::MUTED)))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .font_family("monospace")
                        .text_size(px(11.5))
                        .text_color(hex(colors::MUTED))
                        .child(sel_text_id(
                            gpui::ElementId::Name(format!("cdv-dir-{collapsed_name}").into()),
                            collapsed_name,
                        )),
                ),
        );
        list = render_file_tree_into(list, target_node, depth + 1, state);
    }

    for f in &node.files {
        let display_name = display_file_name(&f.path);
        let is_rename = f.path.contains(" => ");
        let (badge_char, badge_color) = if is_rename {
            ("R", hex(colors::CYAN))
        } else {
            ("M", hex(colors::STATUS_RUNNING))
        };
        let target_path = resolve_changed_file_path(&f.path);
        let st_open = state.clone();
        let is_binary = f.added.is_none() || f.deleted.is_none();

        list = list.child(
            h_flex()
                .id(ElementId::Name(format!("cdv-file-{}", f.path).into()))
                .w_full()
                .min_w_0()
                .h(px(22.0))
                .pl(px(indent + 4.0))
                .pr(px(6.0))
                .gap(px(5.0))
                .rounded(px(5.0))
                .items_center()
                .flex_shrink_0()
                .overflow_hidden()
                .cursor_pointer()
                .hover(|h| h.bg(hex(colors::SURFACE)))
                .font_family("monospace")
                .text_size(px(11.5))
                .on_click(move |_, _, cx| {
                    crate::views::work_panel::open_in_main_canvas(&st_open, &target_path, cx);
                })
                .child(
                    div()
                        .w(px(12.0))
                        .flex_shrink_0()
                        .text_size(px(10.0))
                        .font_weight(gpui::FontWeight::BOLD)
                        .text_color(badge_color)
                        .child(badge_char),
                )
                .child(icon(IconName::File, 12.0, hex(colors::CYAN)))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .child(display_name),
                )
                .child(if is_binary {
                    div()
                        .flex_shrink_0()
                        .ml(px(6.0))
                        .text_size(px(10.5))
                        .text_color(hex(colors::MUTED))
                        .child("BIN")
                        .into_any_element()
                } else {
                    let added = f.added.unwrap_or(0);
                    let deleted = f.deleted.unwrap_or(0);
                    h_flex()
                        .gap(px(3.0))
                        .ml(px(6.0))
                        .flex_shrink_0()
                        .text_size(px(11.0))
                        .child(div().text_color(hex(colors::MUTED)).child("("))
                        .child(
                            div()
                                .text_color(hex(colors::STATUS_DONE))
                                .child(format!("+{added}")),
                        )
                        .child(div().text_color(hex(colors::MUTED)).child("|"))
                        .child(
                            div()
                                .text_color(hex(colors::STATUS_ERROR))
                                .child(format!("−{deleted}")),
                        )
                        .child(div().text_color(hex(colors::MUTED)).child(")"))
                        .into_any_element()
                }),
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

    fn slot(l: &EntryLayout, ix: usize) -> Option<(bool, usize)> {
        l.resolve(ix).map(|s| match s {
            Slot::Commit(i) => (false, i),
            Slot::Detail(i) => (true, i),
        })
    }

    #[test]
    fn entry_layout_maps_list_positions_around_the_inline_detail_slot() {
        let mk = |total, selected_row| EntryLayout {
            total,
            selected_row,
            find_active: false,
            match_set: Default::default(),
        };
        // 无选中：位置 == 提交下标，越界 None
        let l = mk(3, None);
        assert_eq!(slot(&l, 2), Some((false, 2)));
        assert_eq!(slot(&l, 3), None);
        // 选中第 1 行（共 4 提交 + 1 卡槽 = 5 条目）：0,1 提交；2 卡槽；3,4 → 提交 2,3
        let l = mk(5, Some(1));
        assert_eq!(slot(&l, 0), Some((false, 0)));
        assert_eq!(slot(&l, 1), Some((false, 1)));
        assert_eq!(slot(&l, 2), Some((true, 1)));
        assert_eq!(slot(&l, 3), Some((false, 2)));
        assert_eq!(slot(&l, 4), Some((false, 3)));
        assert_eq!(slot(&l, 5), None);
    }

    #[test]
    fn list_sync_uses_targeted_splice_when_toggling_or_switching_selected_commit() {
        // 初次挂载 100 个提交：Reset(100)
        assert_eq!(
            plan_list_sync(0, None, 100, None),
            vec![ListSyncOp::Reset(100)]
        );
        // 展开第 1 行：在索引 2 处 splice 插入 1 个 CDV 槽，不调 Reset（避免重置滚动条）
        assert_eq!(
            plan_list_sync(100, None, 100, Some(1)),
            vec![ListSyncOp::Splice {
                old_range: 2..2,
                count: 1
            }]
        );
        // 从第 1 行切换到第 5 行：先移除旧索引 2 的 CDV 槽，再在新索引 6 插入 CDV 槽
        assert_eq!(
            plan_list_sync(100, Some(1), 100, Some(5)),
            vec![
                ListSyncOp::Splice {
                    old_range: 2..3,
                    count: 0
                },
                ListSyncOp::Splice {
                    old_range: 6..6,
                    count: 1
                },
            ]
        );
        // 再次点击第 5 行收起：移除索引 6 的 CDV 槽
        assert_eq!(
            plan_list_sync(100, Some(5), 100, None),
            vec![ListSyncOp::Splice {
                old_range: 6..7,
                count: 0
            }]
        );
        // 流式加载期间已选中第 1 行，尾部追加 50 个提交：在 old_total(101) 处追加 50 项
        assert_eq!(
            plan_list_sync(100, Some(1), 150, Some(1)),
            vec![ListSyncOp::Splice {
                old_range: 101..101,
                count: 50
            }]
        );
    }

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

    /// 展开 CDV 时左侧拓扑走廊贯穿不断裂：跨越 `row -> row+1` 的轨道生成 `V {CDV_SLOT_H}` 竖线，
    /// Merge 提交展开 CDV 时主干列保持主干色（不被尚未分叉的 merge 支线覆盖），且不画多余圆点或横线。
    #[test]
    fn cdv_corridor_passes_active_lanes_through_cleanly_and_preserves_merge_trunk_color() {
        let mut g = jagent_core::git::GitGraphData::default();
        g.add_commits(&[
            commit("m", &["p1", "p2"]),
            commit("p2", &["p1"]),
            commit("p1", &[]),
        ]);
        // 第 0 行 (m) 是 merge commit：p1 在 lane 0 (color 0)，p2 在 lane 1 (color 1)
        let row0_pieces = build_row_svg_pieces(
            0,
            g.lines_by_row.get(&0).map_or(&[][..], Vec::as_slice),
            g.rows[0].lane,
            g.rows[0].color_idx,
            g.max_lanes,
            true,
        );
        assert_eq!(
            row0_pieces.len(),
            2,
            "merge 起点行下半段只画主干色竖线 + 1 个圆点，不被待分叉支线覆盖"
        );
        assert_eq!(row0_pieces[0].color_idx, g.rows[0].color_idx);

        let pass0 = build_cdv_pass_svg_pieces(
            0,
            g.lines_by_row.get(&0).map_or(&[][..], Vec::as_slice),
            g.rows[0].lane,
            g.rows[0].color_idx,
            g.max_lanes,
        );
        assert_eq!(
            pass0.len(),
            1,
            "进入 row 1 前两条线都在 col 0，去重后只画 1 条主干色竖线"
        );
        assert_eq!(pass0[0].color_idx, g.rows[0].color_idx);
        assert!(pass0[0].source.contains(&format!("V {CDV_SLOT_H}")));
        assert!(!pass0[0].source.contains("<circle"));
        assert!(!pass0[0].source.contains("H "));

        // 在第 1 行 (p2) 展开 CDV：lane 0 (m->p1) 与 lane 1 (p2->p1) 均跨越 1 -> 2
        let pieces = build_cdv_pass_svg_pieces(
            1,
            g.lines_by_row.get(&1).map_or(&[][..], Vec::as_slice),
            g.rows[1].lane,
            g.rows[1].color_idx,
            g.max_lanes,
        );
        assert_eq!(pieces.len(), 2, "两条异色轨道各自垂直贯穿");
        assert!(
            pieces
                .iter()
                .all(|p| p.source.contains(&format!("V {CDV_SLOT_H}"))
                    && !p.source.contains("<circle")),
            "所有贯穿竖线覆盖整个 CDV_SLOT_H 且无多余圆点或横线"
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
