//! Git 图的像素几何（与旧 `packages/app/src/git/graphSvg.ts` 同构）。
//!
//! 纯函数，无 gpui 依赖：视图只负责把这些数值交给绘制层。数值与旧版逐一对应，
//! 测试锁死这些常量，防止改动时连线与行错位。

use super::graph::{CommitLine, LaneSegment};

/// 行高（px）。旧版 `ROW_HEIGHT`。
pub const ROW_HEIGHT: f32 = 30.0;
/// lane 宽（px）。旧版 `LANE_WIDTH`。
pub const LANE_WIDTH: f32 = 13.0;
/// graph 列左右内边距（px）。旧版 `PAD_X`。
pub const PAD_X: f32 = 8.0;
/// graph 列至少预留的 lane 数（旧版 `MIN_LANES`）。
pub const MIN_LANES: usize = 6;

/// lane 中心 x（px）。与 Zed `lane_center_x` 同构。
pub fn lane_x(lane: usize) -> f32 {
    PAD_X + lane as f32 * LANE_WIDTH + LANE_WIDTH / 2.0
}

/// graph 列宽（px）：至少 [`MIN_LANES`] 条 lane，加两侧内边距与 6px 尾距。
pub fn graph_column_width(max_lanes: usize) -> f32 {
    LANE_WIDTH * max_lanes.max(MIN_LANES) as f32 + PAD_X * 2.0 + 6.0
}

/// 三次曲线的四个点（px）：起点、两个控制点、终点。与 `PathBuilder::cubic_bezier_to` 的参数对应。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Arc {
    pub start: (f32, f32),
    pub control_a: (f32, f32),
    pub control_b: (f32, f32),
    pub end: (f32, f32),
}

/// 行内连线的圆弧：从行顶 `(x0, 0)` 弯到行中 `(x1, MID)`。与旧版 `arcPath` 同构。
pub fn arc(x0: f32, x1: f32) -> Arc {
    let mid = ROW_HEIGHT / 2.0;
    let quarter = ROW_HEIGHT / 4.0;
    Arc { start: (x0, 0.0), control_a: (x0, quarter), control_b: (x1, quarter), end: (x1, mid) }
}

/// 线在第 `row` 行的进入列：沿线段顺序，最后一个在 `row` 之前完成的弯曲决定列；没有则为起始列。
/// 与旧版 `enterColumn` 同构。
pub fn enter_column(line: &CommitLine, row: usize) -> usize {
    line.segments
        .iter()
        .filter_map(|s| match s {
            LaneSegment::Curve { to_column, on_row, .. } if *on_row < row => Some(*to_column),
            _ => None,
        })
        .last()
        .unwrap_or(line.child_column)
}

/// 行内要画的一段（像素坐标）。视图把它交给 `PathBuilder`。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Stroke {
    /// 竖直线段：从 `(x, y0)` 到 `(x, y1)`
    Vertical { x: f32, y0: f32, y1: f32 },
    /// 行内弧
    Arc(Arc),
}

/// 一条连线在第 `row` 行的绘制段（与旧版 `buildRowGraphics` 的分支一一对应）。
///
/// - 起点行：圆点下半竖线（merge 曲线最早也要下一行才弯）；
/// - 弯曲行：弧从行顶进入列到目标列的中线；非终点行再补目标列的下半竖线；
/// - 穿行：竖线全高；收尾行只到中线接圆点。
///
/// 只读 `CommitLine`：`child_column` / `row_span` 给出起点与区间，`segments` 给出弯曲。
pub fn line_strokes(line: &CommitLine, row: usize) -> Vec<Stroke> {
    let (child_row, end_row) = line.row_span;
    let mid = ROW_HEIGHT / 2.0;
    if row == child_row {
        return vec![Stroke::Vertical { x: lane_x(line.child_column), y0: mid, y1: ROW_HEIGHT }];
    }
    let enter = lane_x(enter_column(line, row));
    let active = line.segments.iter().find_map(|s| match s {
        LaneSegment::Curve { to_column, on_row, .. } if *on_row == row => Some(*to_column),
        _ => None,
    });
    match active {
        Some(to_column) => {
            let to = lane_x(to_column);
            let mut out = vec![Stroke::Arc(arc(enter, to))];
            if row != end_row {
                out.push(Stroke::Vertical { x: to, y0: mid, y1: ROW_HEIGHT });
            }
            out
        }
        None => {
            let y1 = if row == end_row { mid } else { ROW_HEIGHT };
            vec![Stroke::Vertical { x: enter, y0: 0.0, y1 }]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一条连线：从 `child_column` 在 `row_span.0` 行出发，到 `row_span.1` 行结束。
    fn line(child_column: usize, row_span: (usize, usize), curves: &[(usize, usize)]) -> CommitLine {
        let segments = curves
            .iter()
            .map(|&(to_column, on_row)| LaneSegment::Curve { to_column, on_row, merge: false })
            .collect();
        CommitLine { child_column, row_span, color_idx: 0, segments }
    }

    #[test]
    fn the_child_row_draws_only_the_lower_half_of_its_own_lane() {
        assert_eq!(line_strokes(&line(2, (4, 9), &[]), 4), vec![Stroke::Vertical { x: lane_x(2), y0: 15.0, y1: 30.0 }]);
    }

    #[test]
    fn a_pass_through_row_draws_a_full_height_vertical() {
        assert_eq!(line_strokes(&line(1, (4, 9), &[]), 6), vec![Stroke::Vertical { x: lane_x(1), y0: 0.0, y1: 30.0 }]);
    }

    #[test]
    fn the_end_row_stops_at_mid_height_so_the_dot_caps_it() {
        assert_eq!(line_strokes(&line(1, (4, 9), &[]), 9), vec![Stroke::Vertical { x: lane_x(1), y0: 0.0, y1: 15.0 }]);
    }

    #[test]
    fn a_curve_row_draws_the_arc_then_the_target_lower_half_unless_it_ends_there() {
        // 线从列 0 在第 6 行弯到列 3
        let strokes = line_strokes(&line(0, (4, 9), &[(3, 6)]), 6);
        assert_eq!(strokes[0], Stroke::Arc(arc(lane_x(0), lane_x(3))));
        assert_eq!(strokes[1], Stroke::Vertical { x: lane_x(3), y0: 15.0, y1: 30.0 });
    }

    #[test]
    fn a_curve_on_the_end_row_draws_only_the_arc() {
        let strokes = line_strokes(&line(0, (4, 9), &[(3, 9)]), 9);
        assert_eq!(strokes.len(), 1, "终点行不补下半竖线");
        assert!(matches!(strokes[0], Stroke::Arc(_)));
    }

    #[test]
    fn the_arc_leaves_the_top_of_the_row_and_lands_mid_row_through_quarter_controls() {
        let a = arc(20.0, 33.0);
        assert_eq!(a.start, (20.0, 0.0));
        assert_eq!(a.control_a, (20.0, 7.5));
        assert_eq!(a.control_b, (33.0, 7.5));
        assert_eq!(a.end, (33.0, 15.0));
    }

    #[test]
    fn a_line_with_no_curve_stays_in_its_child_column() {
        assert_eq!(enter_column(&line(3, (0, 9), &[]), 5), 3);
    }

    #[test]
    fn only_curves_bent_before_the_row_move_the_entry_column() {
        // 第 2 行才弯到列 4；第 7 行才弯到列 1。第 5 行只看得到第一次弯曲。
        let l = line(0, (0, 9), &[(4, 2), (1, 7)]);
        assert_eq!(enter_column(&l, 1), 0, "弯曲尚未发生");
        assert_eq!(enter_column(&l, 5), 4);
        assert_eq!(enter_column(&l, 9), 1, "后面的弯曲覆盖前面的");
    }

    #[test]
    fn row_and_lane_constants_match_the_legacy_graph_svg() {
        assert_eq!(ROW_HEIGHT, 30.0);
        assert_eq!(LANE_WIDTH, 13.0);
        assert_eq!(MIN_LANES, 6);
    }

    #[test]
    fn lane_centres_step_by_one_lane_width_from_the_padding() {
        assert_eq!(lane_x(0), 8.0 + 6.5);
        assert_eq!(lane_x(3), 8.0 + 3.0 * 13.0 + 6.5);
    }

    #[test]
    fn the_column_is_never_narrower_than_six_lanes() {
        assert_eq!(graph_column_width(0), graph_column_width(MIN_LANES));
        assert_eq!(graph_column_width(2), 13.0 * 6.0 + 16.0 + 6.0);
    }

    #[test]
    fn the_column_grows_with_more_lanes_than_the_minimum() {
        assert_eq!(graph_column_width(9), 13.0 * 9.0 + 16.0 + 6.0);
    }
}
