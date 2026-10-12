//! lane 分配状态机。
//!
//! Zed `git_ui/src/git_graph.rs` 的 `GraphData::add_commits` + `LaneState::to_commit_lines` 的移植
//! （经旧 TS 实现逐行对照）。语义保持一致：
//! - 输入顺序 = git log 顺序（新 → 旧，HEAD 在前）；
//! - commit_lane = 等待本 sha 的活跃 lane 最小值，否则复用 / 新开空 lane；
//! - parent0 继承本 lane（直线段），parent1.. 各开一条 merge 曲线支线；
//! - 支线收尾时按 would_overlap 修正曲线落点，避免穿越本 lane 上的提交；
//! - lane 颜色按 lane 下标缓存、色板轮转。
//!
//! 零 IO（输入是已解析的 [`GraphCommit`]）。

use std::collections::HashMap;

use super::types::GraphCommit;

/// Zed `usize::MAX` 的「未定」哨兵。
pub const UNSET: usize = usize::MAX;

/// 直线段：垂直线覆盖 `[产生行, to_row]`；曲线段：在 `on_row` 行从上一位置弯到 `to_column`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaneSegment {
    Straight { to_row: usize },
    Curve { to_column: usize, on_row: usize, merge: bool },
}

/// 一条完整的连接线（child 列出发 → parent 列到达），行区间为闭区间。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitLine {
    pub child_column: usize,
    pub row_span: (usize, usize),
    pub color_idx: usize,
    pub segments: Vec<LaneSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphRow {
    pub commit: GraphCommit,
    pub lane: usize,
    pub color_idx: usize,
}

#[derive(Debug)]
struct ActiveLane {
    parent: String,
    #[allow(dead_code)] // 与 Zed 的字段对齐；收尾逻辑不读它
    child: String,
    /// `None` = merge 支线（收尾时继承 parent 提交所在 lane 的色）
    color: Option<usize>,
    starting_row: usize,
    starting_col: usize,
    destination_column: Option<usize>,
    segments: Vec<LaneSegment>,
}

pub struct GitGraphData {
    pub rows: Vec<GraphRow>,
    pub lines: Vec<CommitLine>,
    /// 行号 → 覆盖该行的线（渲染时按行取用，避免全量扫 `lines`）
    pub lines_by_row: HashMap<usize, Vec<CommitLine>>,
    pub max_lanes: usize,

    lane_states: Vec<Option<ActiveLane>>,
    lane_colors: HashMap<usize, usize>,
    parent_to_lanes: HashMap<String, Vec<usize>>,
    next_color: usize,
    palette_size: usize,
}

impl GitGraphData {
    /// `palette_size` 默认 = 图色板长度（8）；可注入小色板测轮转。
    pub fn new(palette_size: usize) -> Self {
        Self {
            rows: vec![],
            lines: vec![],
            lines_by_row: HashMap::new(),
            max_lanes: 0,
            lane_states: vec![],
            lane_colors: HashMap::new(),
            parent_to_lanes: HashMap::new(),
            next_color: 0,
            palette_size,
        }
    }

    pub fn clear(&mut self) {
        self.rows.clear();
        self.lines.clear();
        self.lines_by_row.clear();
        self.lane_states.clear();
        self.lane_colors.clear();
        self.parent_to_lanes.clear();
        self.next_color = 0;
        self.max_lanes = 0;
    }

    /// 流式增量追加（可多次调用；分块喂入与一次喂入结果一致）。
    pub fn add_commits(&mut self, chunk: &[GraphCommit]) {
        for commit in chunk {
            let commit_row = self.rows.len();
            let waiting = self.parent_to_lanes.get(&commit.sha).cloned();
            let commit_lane = match &waiting {
                Some(w) => *w.iter().min().expect("非空"),
                None => self.first_empty_lane_idx(),
            };
            let commit_color = self.get_lane_color(commit_lane);

            // ① 收尾：所有等着本 sha 的 lane 生成 CommitLine（含 merge 曲线重叠修正）
            if let Some(waiting) = waiting {
                self.parent_to_lanes.remove(&commit.sha);
                for lane_column in waiting {
                    // merge 曲线落点修正
                    let fix = self.lane_states[lane_column].as_ref().and_then(|state| {
                        match state.segments.first() {
                            Some(LaneSegment::Curve { merge: true, .. }) if lane_column != commit_lane => {
                                let curve_row = state.starting_row + 1;
                                let would_overlap = curve_row < commit_row
                                    && self.rows[curve_row..commit_row].iter().any(|r| r.lane == commit_lane);
                                would_overlap.then_some(())
                            }
                            _ => None,
                        }
                    });
                    if fix.is_some()
                        && let Some(state) = self.lane_states[lane_column].as_mut()
                        && let Some(LaneSegment::Curve { to_column, .. }) = state.segments.first_mut()
                    {
                        *to_column = lane_column;
                    }
                    if let Some(line) = self.lane_to_commit_line(lane_column, commit_row, commit_lane, commit_color) {
                        // 索引到覆盖的每一行（闭区间）
                        for r in line.row_span.0..=line.row_span.1 {
                            self.lines_by_row.entry(r).or_default().push(line.clone());
                        }
                        self.lines.push(line);
                    }
                }
            }

            // ② 开支：parent0 继承本 lane（直线）；parent1.. 各开 merge 曲线支线
            if let Some(p0) = commit.parents.first() {
                self.lane_states[commit_lane] = Some(ActiveLane {
                    parent: p0.clone(),
                    child: commit.sha.clone(),
                    color: Some(commit_color),
                    starting_row: commit_row,
                    starting_col: commit_lane,
                    destination_column: None,
                    segments: vec![LaneSegment::Straight { to_row: UNSET }],
                });
                self.push_parent_lane(p0, commit_lane);
                for p in &commit.parents[1..] {
                    let nl = self.first_empty_lane_idx();
                    self.lane_states[nl] = Some(ActiveLane {
                        parent: p.clone(),
                        child: commit.sha.clone(),
                        color: None,
                        starting_row: commit_row,
                        starting_col: commit_lane,
                        destination_column: None,
                        segments: vec![LaneSegment::Curve { to_column: UNSET, on_row: UNSET, merge: true }],
                    });
                    self.push_parent_lane(p, nl);
                }
            }

            self.max_lanes = self.max_lanes.max(self.lane_states.len());
            self.rows.push(GraphRow { commit: commit.clone(), lane: commit_lane, color_idx: commit_color });
        }
    }

    // ── 内部 ─────────────────────────────────────────────────────

    fn first_empty_lane_idx(&mut self) -> usize {
        if let Some(i) = self.lane_states.iter().position(Option::is_none) {
            return i;
        }
        self.lane_states.push(None);
        self.lane_states.len() - 1
    }

    fn get_lane_color(&mut self, lane_idx: usize) -> usize {
        if let Some(&c) = self.lane_colors.get(&lane_idx) {
            return c;
        }
        let c = self.next_color;
        self.next_color = (self.next_color + 1) % self.palette_size;
        self.lane_colors.insert(lane_idx, c);
        c
    }

    fn push_parent_lane(&mut self, parent: &str, lane: usize) {
        self.parent_to_lanes.entry(parent.to_owned()).or_default().push(lane);
    }

    /// lane 收尾（parent 提交到达，行号 = `ending_row`）。对齐 Zed `to_commit_lines`：
    /// 只 finalize 最后一段——直线的「∞」截断到 ending_row；曲线的 on_row / to_column 落定，
    /// 必要时补一段直线 + checkout 曲线接驳到 parent 所在列。
    fn lane_to_commit_line(
        &mut self,
        lane_column: usize,
        ending_row: usize,
        parent_column: usize,
        parent_color: usize,
    ) -> Option<CommitLine> {
        let state = self.lane_states[lane_column].take()?;
        let final_destination = state.destination_column.unwrap_or(parent_column);
        let final_color = state.color.unwrap_or(parent_color);
        let starting_row = state.starting_row;
        let mut segments = state.segments;

        let checkout = |to_column| LaneSegment::Curve { to_column, on_row: ending_row, merge: false };

        match segments.last().cloned() {
            Some(LaneSegment::Straight { to_row: UNSET }) => {
                let last = segments.len() - 1;
                if final_destination != lane_column {
                    let to_row = ending_row.wrapping_sub(1);
                    segments[last] = LaneSegment::Straight { to_row };
                    if to_row == starting_row {
                        segments[last] = checkout(final_destination);
                    } else {
                        segments.push(checkout(final_destination));
                    }
                } else {
                    segments[last] = LaneSegment::Straight { to_row: ending_row };
                }
            }
            Some(LaneSegment::Curve { to_column, on_row, merge }) => {
                let last = segments.len() - 1;
                if on_row == UNSET {
                    let to_column = if to_column == UNSET { final_destination } else { to_column };
                    if merge {
                        let on_row = starting_row + 1;
                        segments[last] = LaneSegment::Curve { to_column, on_row, merge };
                        if on_row < ending_row {
                            if to_column != final_destination {
                                segments.push(LaneSegment::Straight { to_row: ending_row - 1 });
                                segments.push(checkout(final_destination));
                            } else {
                                segments.push(LaneSegment::Straight { to_row: ending_row });
                            }
                        } else if to_column != final_destination {
                            segments.push(checkout(final_destination));
                        }
                    } else {
                        segments[last] = LaneSegment::Curve { to_column, on_row: ending_row, merge };
                        if to_column != final_destination {
                            segments.push(LaneSegment::Straight { to_row: ending_row });
                            segments.push(checkout(final_destination));
                        }
                    }
                } else if on_row < ending_row {
                    if to_column != final_destination {
                        segments.push(LaneSegment::Straight { to_row: ending_row - 1 });
                        segments.push(checkout(final_destination));
                    } else {
                        segments.push(LaneSegment::Straight { to_row: ending_row });
                    }
                } else if to_column != final_destination {
                    segments.push(checkout(final_destination));
                }
            }
            _ => {}
        }

        let _ = state.parent;
        Some(CommitLine {
            child_column: state.starting_col,
            row_span: (starting_row, ending_row),
            color_idx: final_color,
            segments,
        })
    }
}

impl Default for GitGraphData {
    fn default() -> Self {
        Self::new(8)
    }
}

#[cfg(test)]
mod tests {
    use super::LaneSegment::{Curve, Straight};
    use super::*;

    /// 快捷构造：sha 用短代号，parents 引用其它代号。
    fn c(sha: &str, parents: &[&str]) -> GraphCommit {
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

    fn lanes(g: &GitGraphData) -> Vec<usize> {
        g.rows.iter().map(|r| r.lane).collect()
    }

    /// 与 `export_legacy.ts` 使用同一份 fixture，把结果写到 `GRAPH_EXPORT` 指定的路径，供对照旧版。
    /// 未设置环境变量时直接返回，不影响常规测试。
    #[test]
    fn export_fixture_for_legacy_comparison() {
        let Ok(path) = std::env::var("GRAPH_EXPORT") else { return };
        let fixture = [c("m1", &["m2", "f1"]), c("f1", &["m2"]), c("m2", &["m3"]), c("m3", &[])];
        let mut g = GitGraphData::new(8);
        g.add_commits(&fixture);
        let rows: Vec<_> = g
            .rows
            .iter()
            .map(|r| serde_json::json!({ "sha": r.commit.sha, "lane": r.lane, "colorIdx": r.color_idx }))
            .collect();
        let lines: Vec<_> = g
            .lines
            .iter()
            .map(|l| {
                let segments: Vec<_> = l
                    .segments
                    .iter()
                    .map(|s| match s {
                        Curve { to_column, on_row, merge } => {
                            serde_json::json!({ "kind": "curve", "toColumn": to_column, "onRow": on_row, "merge": merge })
                        }
                        Straight { to_row } => serde_json::json!({ "kind": "straight", "toRow": to_row }),
                    })
                    .collect();
                serde_json::json!({ "childColumn": l.child_column, "rowSpan": [l.row_span.0, l.row_span.1], "colorIdx": l.color_idx, "segments": segments })
            })
            .collect();
        let out = serde_json::json!({ "rows": rows, "lines": lines, "maxLanes": g.max_lanes });
        std::fs::write(path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
    }

    /// 与 `compare_draw.ts` 对照：每行的 `line_strokes` 输出，写到 `GRAPH_DRAW_EXPORT` 指定的路径。
    /// 未设置环境变量时直接返回。
    #[test]
    fn export_drawing_for_legacy_comparison() {
        let Ok(path) = std::env::var("GRAPH_DRAW_EXPORT") else { return };
        use crate::git::geometry::{Stroke, line_strokes};
        let fixture = [c("m1", &["m2", "f1"]), c("f1", &["m2"]), c("m2", &["m3"]), c("m3", &[])];
        let mut g = GitGraphData::new(8);
        g.add_commits(&fixture);
        let rows: Vec<_> = (0..g.rows.len())
            .map(|row| {
                let mut paths = vec![];
                let mut circles = vec![];
                for line in g.lines_by_row.get(&row).map_or(&[][..], Vec::as_slice) {
                    for s in line_strokes(line, row) {
                        let d = match s {
                            Stroke::Vertical { x, y0, y1 } => format!("M {x} {y0} V {y1}"),
                            Stroke::Arc(a) => format!(
                                "M {} {} C {} {}, {} {}, {} {}",
                                a.start.0, a.start.1, a.control_a.0, a.control_a.1, a.control_b.0, a.control_b.1, a.end.0, a.end.1
                            ),
                        };
                        paths.push(serde_json::json!({ "color": line.color_idx, "d": d }));
                    }
                }
                let r = &g.rows[row];
                circles.push(serde_json::json!({
                    "color": r.color_idx,
                    "c": [crate::git::geometry::lane_x(r.lane), crate::git::geometry::ROW_HEIGHT / 2.0]
                }));
                serde_json::json!({ "row": row, "paths": paths, "circles": circles })
            })
            .collect();
        std::fs::write(path, serde_json::to_string_pretty(&rows).unwrap()).unwrap();
    }

    // ── 线性历史 ──

    #[test]
    fn linear_history_stays_in_lane_zero_with_straight_segments() {
        let mut g = GitGraphData::default();
        g.add_commits(&[c("c3", &["c2"]), c("c2", &["c1"]), c("c1", &[])]);
        assert_eq!(lanes(&g), [0, 0, 0]);
        let spans: Vec<_> = g.lines.iter().map(|l| (l.child_column, l.row_span)).collect();
        assert_eq!(spans, [(0, (0, 1)), (0, (1, 2))]);
        assert_eq!(g.lines[0].segments, [Straight { to_row: 1 }]);
        assert_eq!(g.max_lanes, 1);
    }

    // ── fork + merge ──
    //   f(merge e,d)  row0 / e←c row1 lane0 / d←b row2 lane1 / c←b row3 lane0 / b←a row4 / a row5

    fn batch() -> Vec<GraphCommit> {
        vec![c("f", &["e", "d"]), c("e", &["c"]), c("d", &["b"]), c("c", &["b"]), c("b", &["a"]), c("a", &[])]
    }

    #[test]
    fn fork_and_merge_assign_lanes_curves_and_checkout() {
        let mut g = GitGraphData::default();
        g.add_commits(&batch());
        assert_eq!(lanes(&g), [0, 0, 1, 0, 0, 0]);
        assert_eq!(g.max_lanes, 2);
        assert_eq!(g.lines.len(), 6);

        // f→d 支线：从 f 的 col0 出发，row1 弯到 col1（merge），直线到 row2
        let d_line = &g.lines[1];
        assert_eq!((d_line.child_column, d_line.row_span), (0, (0, 2)));
        assert_eq!(d_line.segments[0], Curve { to_column: 1, on_row: 1, merge: true });
        assert_eq!(d_line.segments[1], Straight { to_row: 2 });
        assert_eq!(d_line.color_idx, g.rows[2].color_idx, "merge 支线色 = parent 所在 lane 的色");

        // b 到达时 waiting 顺序 = push 顺序 [lane1(from d), lane0(from c)]
        let b_join = &g.lines[3];
        assert_eq!((b_join.child_column, b_join.row_span), (1, (2, 4)));
        assert_eq!(b_join.segments, [Straight { to_row: 3 }, Curve { to_column: 0, on_row: 4, merge: false }]);
    }

    #[test]
    fn chunked_feeding_equals_feeding_everything_at_once() {
        let b = batch();
        let mut whole = GitGraphData::default();
        whole.add_commits(&b);
        let mut split = GitGraphData::default();
        split.add_commits(&b[..3]);
        split.add_commits(&b[3..4]);
        split.add_commits(&b[4..]);
        assert_eq!(split.rows, whole.rows);
        assert_eq!(split.lines, whole.lines);
        assert_eq!(split.max_lanes, whole.max_lanes);
    }

    #[test]
    fn freed_lanes_are_reused_after_a_merge() {
        let mut g = GitGraphData::default();
        g.add_commits(&batch());
        g.add_commits(&[c("h", &["a", "x"]), c("x", &[])]);
        assert_eq!(g.rows[6].lane, 0);
        let x_line = g.lines.iter().find(|l| l.row_span.0 == 6 && l.child_column == 0).unwrap();
        assert_eq!(x_line.segments[0], Curve { to_column: 1, on_row: 7, merge: true });
        assert_eq!(g.max_lanes, 2);
    }

    // ── would_overlap 修正 ──

    #[test]
    fn curve_landing_blocked_by_a_middle_commit_falls_back_to_its_own_column() {
        //   h(merge g,e) row0 / g←e row1 lane0（挡在 e 的直线路径上）/ e←d row2 / d row3
        let mut g = GitGraphData::default();
        g.add_commits(&[c("h", &["g", "e"]), c("g", &["e"]), c("e", &["d"]), c("d", &[])]);
        let e_line = g.lines.iter().find(|l| l.row_span == (0, 2)).expect("h→e");
        assert_eq!(e_line.segments[0], Curve { to_column: 1, on_row: 1, merge: true });
        assert_eq!(e_line.segments[1], Straight { to_row: 1 });
        assert_eq!(e_line.segments[2], Curve { to_column: 0, on_row: 2, merge: false });
    }

    #[test]
    fn unobstructed_curves_are_not_corrected() {
        let mut g = GitGraphData::default();
        g.add_commits(&[c("h3", &["g3", "e3"]), c("e3", &["d3"]), c("g3", &["d3"]), c("d3", &[])]);
        let e3 = g.lines.iter().find(|l| l.row_span == (0, 1)).unwrap();
        assert_eq!(e3.segments, [Curve { to_column: 1, on_row: 1, merge: true }]);
    }

    // ── 颜色 ──

    #[test]
    fn lane_colors_are_cached_and_the_palette_wraps() {
        let mut g = GitGraphData::new(2);
        g.add_commits(&[c("j", &["i1", "i2", "i3"]), c("i1", &["r"]), c("i2", &["r"]), c("i3", &["r"]), c("r", &[])]);
        assert_eq!(g.max_lanes, 3);
        assert_eq!(g.rows[0].color_idx, 0);
        let from_j: Vec<_> = g.lines.iter().filter(|l| l.row_span.0 == 0).collect();
        assert_eq!(from_j.len(), 3);
        let mut colors: Vec<_> = from_j.iter().map(|l| l.color_idx).collect();
        colors.sort_unstable();
        assert_eq!(colors, [0, 0, 1], "lane0/1/2 → 色 0/1/0（轮转）");
    }

    #[test]
    fn merge_branch_inherits_the_parent_color_on_arrival() {
        let mut g = GitGraphData::default();
        g.add_commits(&[c("f", &["e", "d"]), c("e", &["r"]), c("d", &["r"]), c("r", &[])]);
        let d_line = g.lines.iter().find(|l| l.row_span.1 == 2).unwrap();
        assert_eq!(d_line.color_idx, g.rows[2].color_idx);
    }

    // ── 边界 ──

    #[test]
    fn an_empty_chunk_has_no_side_effects() {
        let mut g = GitGraphData::default();
        g.add_commits(&[c("a", &[])]);
        g.add_commits(&[]);
        assert_eq!((g.rows.len(), g.max_lanes), (1, 1));
    }

    #[test]
    fn max_lanes_is_monotonic_and_clear_resets_everything() {
        let mut g = GitGraphData::default();
        g.add_commits(&[c("f", &["e", "d"]), c("e", &[]), c("d", &[])]);
        assert_eq!(g.max_lanes, 2);
        g.add_commits(&[]);
        assert_eq!(g.max_lanes, 2);
        g.clear();
        assert_eq!((g.rows.len(), g.lines.len(), g.max_lanes), (0, 0, 0));
        assert!(g.lines_by_row.is_empty());
    }

    #[test]
    fn a_root_commit_does_not_extend_its_lane() {
        let mut g = GitGraphData::default();
        g.add_commits(&[c("b", &["a"]), c("a", &[])]);
        assert_eq!(lanes(&g), [0, 0]);
        assert_eq!(g.lines.len(), 1);
        assert_eq!(g.lines[0].row_span, (0, 1));
    }

    #[test]
    fn lines_by_row_indexes_every_row_in_the_closed_span() {
        let mut g = GitGraphData::default();
        g.add_commits(&batch());
        // f→d 线覆盖 row 0..=2
        for r in 0..=2 {
            assert!(g.lines_by_row[&r].iter().any(|l| l.row_span == (0, 2)), "row {r}");
        }
        assert!(g.lines_by_row.values().flatten().all(|l| l.row_span.0 <= l.row_span.1));
    }

    #[test]
    fn lanes_whose_parent_has_not_arrived_yet_stay_open_without_producing_a_line() {
        // 手推演（前 3 行 f / e / d）：
        //   row0 f(parents e,d)：lane0→e 直线，lane1→d merge 曲线；尚无线
        //   row1 e：等 e 的 lane0 收尾 → 线 f→e（1 条）；e 的 parent c 重新占 lane0
        //   row2 d：等 d 的 lane1 收尾 → 线 f→d（2 条）；d 的 parent b 占 lane1
        // 此刻 e→c（lane0）与 d→b（lane1）的 parent 都未到达：保持开放，不产生线。
        let mut g = GitGraphData::default();
        g.add_commits(&batch()[..3]);
        assert_eq!(g.lines.len(), 2);
        let spans: Vec<_> = g.lines.iter().map(|l| l.row_span).collect();
        assert_eq!(spans, [(0, 1), (0, 2)], "f→e、f→d");
        assert_eq!(g.max_lanes, 2);
        assert!(!g.lines_by_row.contains_key(&3), "还没有线覆盖到 row3");
    }
}
