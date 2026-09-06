/**
 * git/graphSvg.ts — 行内 lane 几何（docs/git-graph.md §3.2）。
 *
 * 把 graph.ts 的 CommitLine 重放成单行的绘制原语，按 colorIdx 分组聚合成
 * `<svg source>`（gpuix svg 是单色叶子，stroke=currentColor 由外层
 * style.color 上色——Icon.tsx 同款模式）。
 *
 * 行内坐标（高 26，中线 13）：
 *  - child 行：圆点向下竖线 (childCol, 13→26)
 *  - 中间行：全高竖线；有 curve(on_row=本行) 时上半弧 + 下半竖线
 *  - 收尾行（parent 行）：上半竖线/弧接到 parent 圆点中线
 *  - 弧：三次贝塞尔 M x0 0 C x0 6.5, x1 6.5, x1 13
 */

import type { CommitLine } from './graph'

export const ROW_HEIGHT = 26
const MID = ROW_HEIGHT / 2
const QUARTER = ROW_HEIGHT / 4
export const LANE_WIDTH = 13
const PAD_X = 3
export const MIN_LANES = 6

/** graph 列宽（Zed：LANE_WIDTH * max(6, maxLanes) + 左右 padding） */
export function graphColumnWidth(maxLanes: number): number {
  return LANE_WIDTH * Math.max(MIN_LANES, maxLanes) + PAD_X * 2
}

/** lane 中心 x（Zed lane_center_x 同构） */
export function laneX(lane: number): number {
  return PAD_X + lane * LANE_WIDTH + LANE_WIDTH / 2
}

/** 圆点半径/描边（Zed COMMIT_CIRCLE_RADIUS / STROKE_WIDTH） */
export const CIRCLE_RADIUS = 3.5
export const STROKE_WIDTH = 1.5

export interface RowSvgPiece {
  colorIdx: number
  source: string
}

/** 行 r 上「进入时的列」：最后一个 on_row < r 的 curve 落点（无则起点列） */
function enterColumn(line: CommitLine, row: number): number {
  let col = line.childColumn
  for (const seg of line.segments) {
    if (seg.kind === 'curve' && seg.onRow < row) col = seg.toColumn
  }
  return col
}

function arcPath(x0: number, x1: number): string {
  return `M ${x0} 0 C ${x0} ${QUARTER}, ${x1} ${QUARTER}, ${x1} ${MID}`
}

function svgSource(width: number, d: string, circle: string | null): string {
  const shapes = `<path d="${d}"/>${circle ?? ''}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${ROW_HEIGHT}" ` +
    `width="${width}" height="${ROW_HEIGHT}" fill="none" stroke="currentColor" ` +
    `stroke-width="${STROKE_WIDTH}" stroke-linecap="round">${shapes}</svg>`
  )
}

/**
 * 行 r 的 svg 分组。lines = 覆盖 r 的连接线（store.linesByRow）。
 * 圆点（提交本体）单独一组画在其 lane 上（色 = 提交 colorIdx）。
 */
export function buildRowGraphics(args: {
  row: number
  lines: readonly CommitLine[]
  commitLane: number
  commitColorIdx: number
  maxLanes: number
}): RowSvgPiece[] {
  const { row, lines, commitLane, commitColorIdx, maxLanes } = args
  const width = graphColumnWidth(maxLanes)
  const byColor = new Map<number, string[]>()

  const push = (colorIdx: number, d: string) => {
    const arr = byColor.get(colorIdx)
    if (arr) arr.push(d)
    else byColor.set(colorIdx, [d])
  }

  for (const line of lines) {
    const isChildRow = row === line.rowSpan[0]
    const isEndRow = row === line.rowSpan[1]
    if (isChildRow) {
      // 起点行：圆点下半竖线（merge 曲线最早也要下一行才弯）
      push(line.colorIdx, `M ${laneX(line.childColumn)} ${MID} V ${ROW_HEIGHT}`)
      continue
    }
    const enter = laneX(enterColumn(line, row))
    const activeCurve = line.segments.find((s) => s.kind === 'curve' && s.onRow === row)
    let col: number
    if (activeCurve && activeCurve.kind === 'curve') {
      const to = laneX(activeCurve.toColumn)
      push(line.colorIdx, arcPath(enter, to))
      col = to
    } else {
      col = enter
    }
    // 穿行竖线全高；收尾行只到中线接圆点
    push(line.colorIdx, isEndRow ? `M ${col} 0 V ${MID}` : `M ${col} 0 V ${ROW_HEIGHT}`)
  }

  // 圆点（覆盖在同色线上方——同组内后画的形状盖先画的）
  const pieces: RowSvgPiece[] = []
  for (const [colorIdx, ds] of byColor) {
    pieces.push({ colorIdx, source: svgSource(width, ds.join(' '), null) })
  }
  const cx = laneX(commitLane)
  pieces.push({
    colorIdx: commitColorIdx,
    source: svgSource(width, '', `<circle cx="${cx}" cy="${MID}" r="${CIRCLE_RADIUS}"/>`),
  })
  return pieces
}
