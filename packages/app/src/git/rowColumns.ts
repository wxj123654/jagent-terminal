/**
 * git/rowColumns.ts — `<git-graph-row>` 行文本列规格（JS 侧）。
 *
 * 行内 4 列文本（subject/author/date/sha）不再走 `<text>` 元素，而是打包
 * 成一份规格交给 canvas 自绘的 `<git-graph-row>` custom element（terminal
 * 同构；性能归因见 docs/perf-analysis.md 模块 9）：GPUIX 每帧重建元素树，
 * 145 个 text 节点每帧重跑 taffy 测量闭包是滚动帧 65% 的成本；custom
 * element 内 ShapedLine 直接 paint，零测量闭包。
 *
 * 颜色统一转 #RRGGBBAA（gpui::rgba 解析；主题 token 是 '#rrggbb'，
 * muted 行的透明度折叠进 alpha）。规格对象由调用方 useMemo——GPUIX 对
 * custom props 按引用 diff，每次新对象都会触发 set_prop + 缓存清空。
 */

import { COLORS, FONT } from '@jagent/ui'

import { ROW_HEIGHT, COL_AUTHOR, COL_DATE, COL_SHA } from './graphSvg'

/** CSS 颜色 → '#RRGGBBAA'（支持 #rgb/#rrggbb/#rrggbbaa/rgb()/rgba()）。 */
export function cssToHex8(color: string, alpha = 1): string {
  const s = color.trim()
  if (s.startsWith('#')) {
    const hex = s.slice(1)
    let r = 0
    let g = 0
    let b = 0
    let a = 1
    if (hex.length === 3) {
      r = parseInt(hex[0]! + hex[0]!, 16)
      g = parseInt(hex[1]! + hex[1]!, 16)
      b = parseInt(hex[2]! + hex[2]!, 16)
    } else if (hex.length === 6) {
      r = parseInt(hex.slice(0, 2), 16)
      g = parseInt(hex.slice(2, 4), 16)
      b = parseInt(hex.slice(4, 6), 16)
    } else if (hex.length === 8) {
      r = parseInt(hex.slice(0, 2), 16)
      g = parseInt(hex.slice(2, 4), 16)
      b = parseInt(hex.slice(4, 6), 16)
      a = parseInt(hex.slice(6, 8), 16) / 255
    } else {
      return '#ABB2BFFF'
    }
    return toHex8(r, g, b, a * alpha)
  }
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(s)
  if (m) {
    const r = Number(m[1])
    const g = Number(m[2])
    const b = Number(m[3])
    let a = 1
    if (m[4] !== undefined) {
      a = m[4]!.endsWith('%') ? Number(m[4]!.slice(0, -1)) / 100 : Number(m[4])
    }
    return toHex8(r, g, b, a * alpha)
  }
  return '#ABB2BFFF'
}

function toHex8(r: number, g: number, b: number, a: number): string {
  const c = (n: number) =>
    Math.min(255, Math.max(0, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  const alpha = Math.min(1, Math.max(0, a))
  // alpha 量化到 255 后回写两位 hex；0.45×255≈114.75 → 73
  return `#${c(r)}${c(g)}${c(b)}${c(alpha * 255)}`
}

export interface RowColumnSpec {
  text: string
  color: string
  fontFamily: string
  fontSize: number
  weight?: number
  /** 固定列宽；缺省 = 弹性列（subject，吃剩余宽度） */
  width?: number
  marginLeft?: number
  alignRight?: boolean
  ellipsis?: boolean
}

export interface RowSpec {
  rowHeight: number
  columns: RowColumnSpec[]
}

export function buildRowColumns(input: {
  subject: string
  subjectColor: string
  subjectWeight: number
  dim: number
  author: string
  date: string
  sha: string
}): RowSpec {
  const muted = cssToHex8(COLORS.muted, input.dim)
  return {
    rowHeight: ROW_HEIGHT,
    columns: [
      {
        text: input.subject,
        color: cssToHex8(input.subjectColor, input.dim),
        fontFamily: FONT.ui,
        fontSize: 13,
        weight: input.subjectWeight,
        ellipsis: true,
      },
      {
        text: input.author,
        color: muted,
        fontFamily: FONT.ui,
        fontSize: 11,
        width: COL_AUTHOR,
        marginLeft: 8,
        ellipsis: true,
      },
      {
        text: input.date,
        color: muted,
        fontFamily: FONT.ui,
        fontSize: 11,
        width: COL_DATE,
        marginLeft: 8,
        alignRight: true,
      },
      {
        text: input.sha,
        color: muted,
        fontFamily: FONT.mono,
        fontSize: 11,
        width: COL_SHA,
        marginLeft: 8,
      },
    ],
  }
}
