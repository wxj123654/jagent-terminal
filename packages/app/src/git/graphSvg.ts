/**
 * git/graphSvg.ts — 行内 lane 几何（docs/git-graph.md §3.2）。
 *
 * 把 graph.ts 的 CommitLine 重放成单行的绘制原语，按 colorIdx 分组聚合成
 * `<svg source>`（gpuix svg 是单色叶子，stroke=currentColor 由外层
 * style.color 上色——Icon.tsx 同款模式）。
 *
 * 行内坐标（高 26，中线 13）：
 *  - child 行：圆点向下竖线 (childCol, 13→26)
 *  - 中间行：全高竖线；有 curve(on_row=本行) 时上半弧 + 从中线续下半竖线
 *  - 收尾行（parent 行）：上半竖线/弧接到 parent 圆点中线（弧落后不再画竖线）
 *  - 弧：三次贝塞尔 M x0 0 C x0 6.5, x1 6.5, x1 13
 */

import type { CommitLine } from './graph'

export const ROW_HEIGHT = 26
/** 行内固定列宽（header 与 <git-graph-row> 规格/rowColumns.ts 共用） */
export const COL_AUTHOR = 110
export const COL_DATE = 80
export const COL_SHA = 72
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

function svgSource(width: number, height: number, d: string, circle: string | null): string {
  const shapes = `${d ? `<path d="${d}"/>` : ''}${circle ?? ''}`
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
  /** 行内详情高度：选中行把下半竖线延长穿过 CDV */
  extraBelow?: number
  /** HEAD 空心圆（fill=none，描边即 lane 色） */
  hollow?: boolean
}): RowSvgPiece[] {
  const { row, lines, commitLane, commitColorIdx, maxLanes, extraBelow = 0, hollow = false } = args
  const height = ROW_HEIGHT + extraBelow
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
      // 起点行：圆点下半竖线（merge 曲线最早也要下一行才弯）；选中时穿过 CDV
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
    pieces.push({ colorIdx, source: svgSource(width, height, ds.join(' '), null) })
  }
  const cx = laneX(commitLane)
  const fill = hollow ? ' fill="none"' : ''
  pieces.push({
    colorIdx: commitColorIdx,
    source: svgSource(
      width,
      height,
      '',
      `<circle cx="${cx}" cy="${MID}" r="${CIRCLE_RADIUS}"${fill}/>`,
    ),
  })
  return pieces
}

/** 选中行下方的详情槽：只画穿过该槽的竖线（无圆点），高度 = CDV。 */
export function buildGapGraphics(args: {
  afterRow: number
  lines: readonly CommitLine[]
  maxLanes: number
  height: number
}): RowSvgPiece[] {
  const { afterRow, lines, maxLanes, height } = args
  const width = graphColumnWidth(maxLanes)
  const byColor = new Map<number, string[]>()
  const push = (colorIdx: number, d: string) => {
    const arr = byColor.get(colorIdx)
    if (arr) arr.push(d)
    else byColor.set(colorIdx, [d])
  }
  for (const line of lines) {
    if (afterRow < line.rowSpan[0] || afterRow >= line.rowSpan[1]) continue
    const col = laneX(enterColumn(line, afterRow + 1))
    push(line.colorIdx, `M ${col} 0 V ${height}`)
  }
  const pieces: RowSvgPiece[] = []
  for (const [colorIdx, ds] of byColor) {
    pieces.push({ colorIdx, source: svgSource(width, height, ds.join(' '), null) })
  }
  return pieces
}
