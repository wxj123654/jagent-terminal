/**
 * git/graphSvg.ts — 行内 lane 几何（docs/git-graph.md §3.2）。
 *
 * 把 graph.ts 的 CommitLine 重放成单行的绘制原语，按 colorIdx 分组聚合成
 * `<svg source>`（gpuix svg 是单色叶子，stroke=currentColor 由外层
 * style.color 上色——Icon.tsx 同款模式）。
 *
 * 行内坐标（高 30，中线 15；React 原型 .git-row 第二段 30px）：
 *  - child 行：圆点向下竖线 (childCol, 15→30)
 *  - 中间行：全高竖线；有 curve(on_row=本行) 时上半弧 + 从中线续下半竖线
 *  - 收尾行（parent 行）：上半竖线/弧接到 parent 圆点中线（弧落后不再画竖线）
 *  - 弧：三次贝塞尔 M x0 0 C x0 7.5, x1 7.5, x1 15
 *  原型 svg 内容高 26 而 CSS 行高 30 → 原型 lane 线每行尾部有 4px 断口
 *  （原型自身不一致，非有意）；实现按 30 连续画——走向一致，断口不复制。
 */

import { COLORS } from '@jagent/ui'

import type { CommitLine } from './graph'

export const ROW_HEIGHT = 30
/** 行内固定列宽（header 与 <git-graph-row> 规格/rowColumns.ts 共用） */
export const COL_AUTHOR = 110
export const COL_DATE = 80
export const COL_SHA = 72
const MID = ROW_HEIGHT / 2
const QUARTER = ROW_HEIGHT / 4
export const LANE_WIDTH = 13
const PAD_X = 8
export const MIN_LANES = 6

/** graph 列宽（原型 gcell：LANE_WIDTH * max(6, maxLanes) + PAD_X*2 + 6 尾距） */
export function graphColumnWidth(maxLanes: number): number {
  return LANE_WIDTH * Math.max(MIN_LANES, maxLanes) + PAD_X * 2 + 6
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

function svgSource(
  width: number,
  height: number,
  d: string,
  circle: string | null,
  opacity?: number,
): string {
  const shapes = `${d ? `<path d="${d}"${opacity != null ? ` opacity="${opacity}"` : ''}/>` : ''}${circle ?? ''}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}" fill="none" stroke="currentColor" ` +
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
  /** HEAD 空心圆（原型 c.hollow：fill=pane + 2px lane 色描边） */
  hollow?: boolean
}): RowSvgPiece[] {
  const { row, lines, commitLane, commitColorIdx, maxLanes, hollow = false } = args
  const height = ROW_HEIGHT
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
      push(line.colorIdx, `M ${laneX(line.childColumn)} ${MID} V ${height}`)
      continue
    }
    const enter = laneX(enterColumn(line, row))
    const activeCurve = line.segments.find((s) => s.kind === 'curve' && s.onRow === row)
    if (activeCurve && activeCurve.kind === 'curve') {
      const to = laneX(activeCurve.toColumn)
      // 弧：行顶 enter → 中线 to。弧已覆盖上半，绝不能再从 y=0 画竖线，
      // 否则 to 列上半会冒出一截 orphan stub（合并点旁「多出来一截」）。
      push(line.colorIdx, arcPath(enter, to))
      if (!isEndRow) push(line.colorIdx, `M ${to} ${MID} V ${height}`)
    } else {
      // 穿行竖线全高；收尾行只到中线接圆点
      push(line.colorIdx, isEndRow ? `M ${enter} 0 V ${MID}` : `M ${enter} 0 V ${height}`)
    }
  }

  const pieces: RowSvgPiece[] = []
  for (const [colorIdx, ds] of byColor) {
    // 原型 lane 线 opacity .85（圆点不随，保持实色）
    pieces.push({ colorIdx, source: svgSource(width, height, ds.join(' '), null, 0.85) })
  }
  const cx = laneX(commitLane)
  // 原型节点 r3.5：普通 = 实填 lane 色无描边（根 fill="none" 会继承——
  // 必须显式 fill，否则所有圆点被描成空心）；hollow = pane 底 + 2px 描边
  const circle = hollow
    ? `<circle cx="${cx}" cy="${MID}" r="${CIRCLE_RADIUS}" fill="${COLORS.pane}" stroke-width="2"/>`
    : `<circle cx="${cx}" cy="${MID}" r="${CIRCLE_RADIUS}" fill="currentColor" stroke="none"/>`
  pieces.push({ colorIdx: commitColorIdx, source: svgSource(width, height, '', circle) })
  return pieces
}
