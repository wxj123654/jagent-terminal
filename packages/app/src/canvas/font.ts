/**
 * canvas/font.ts — ctx.font 的 CSS font shorthand 解析。
 *
 * WHATWG：font 必须是合法 shorthand（[style|variant|weight|stretch]* size
 * [/line-height] family+），非法值静默忽略（ctx 保留旧值）。本实现按
 * canvas-2d-standard-research.md 的兼容子集解析：font-variant /
 * font-stretch / line-height 识别后丢弃（FontSpec 无对应字段），family
 * 取逗号列表第一项（去引号、去首尾空白）。系统字体关键字（caption/menu
 * 等）不在子集内——按非法值忽略。
 */

/** 无 DOM 父级可继承：em/rem/%/larger/smaller 统一按浏览器默认 16px 解析。 */
const BASE_FONT_SIZE = 16

const STRETCH_KEYWORDS = new Set([
  'condensed',
  'expanded',
  'ultra-condensed',
  'extra-condensed',
  'semi-condensed',
  'semi-expanded',
  'extra-expanded',
  'ultra-expanded',
])

const ABSOLUTE_SIZES: Record<string, number> = {
  'xx-small': 9,
  'x-small': 10,
  small: 13,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32,
  'xxx-large': 48,
}

const LENGTH_RE = /^([+-]?[\d.]+(?:e[+-]?\d+)?)(px|pt|pc|in|cm|mm|q|em|rem|%)$/i

export interface ParsedFont {
  family: string
  size: number
  weight: number
  italic: boolean
}

/** 按空白切 token，引号内空白不切（family 可带空格：'Helvetica Neue'）。 */
function tokenize(input: string): string[] | null {
  const tokens: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const ch of input) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (/\s/.test(ch)) {
      if (cur.length) {
        tokens.push(cur)
        cur = ''
      }
    } else {
      cur += ch
    }
  }
  if (quote) return null // 未闭合引号 → 非法
  if (cur.length) tokens.push(cur)
  return tokens
}

function parseWeight(t: string): number | null {
  if (t === 'bold') return 700
  // bolder/lighter 相对父级；无父级可继承时按默认 400 上/下提一档
  if (t === 'bolder') return 700
  if (t === 'lighter') return 300
  const n = Number(t)
  if (Number.isInteger(n) && n >= 1 && n <= 1000) return n
  return null
}

function parseSize(t: string): number | null {
  const abs = ABSOLUTE_SIZES[t.toLowerCase()]
  if (abs != null) return abs
  const lower = t.toLowerCase()
  if (lower === 'larger') return BASE_FONT_SIZE * 1.2
  if (lower === 'smaller') return BASE_FONT_SIZE / 1.2
  const m = LENGTH_RE.exec(t)
  if (!m) return null
  const v = Number(m[1])
  if (!Number.isFinite(v) || v <= 0) return null
  switch (m[2]!.toLowerCase()) {
    case 'px':
      return v
    case 'pt':
      return (v * 96) / 72
    case 'pc':
      return v * 16
    case 'in':
      return v * 96
    case 'cm':
      return (v * 96) / 2.54
    case 'mm':
      return (v * 96) / 25.4
    case 'q':
      return (v * 96) / 101.6 // 1q = 0.25mm
    case 'em':
    case 'rem':
      return v * BASE_FONT_SIZE
    case '%':
      return (v * BASE_FONT_SIZE) / 100
  }
  return null
}

/** family 列表第一项：按逗号切（引号内逗号不切），去引号去空白。 */
function firstFamily(rest: string): string | null {
  let cur = ''
  let quote: string | null = null
  for (const ch of rest) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ',') {
      break
    } else {
      cur += ch
    }
  }
  const fam = cur.trim()
  return fam.length ? fam : null
}

/**
 * 解析 font shorthand；非法输入返回 null（调用方静默忽略）。
 * 语法：[style|variant|weight|stretch 关键字]* <size> [/line-height] <family>+
 */
export function parseFontShorthand(input: string): ParsedFont | null {
  const tokens = tokenize(input)
  if (!tokens || tokens.length < 2) return null

  let i = 0
  let weight = 400
  let italic = false
  let seenStyle = false
  let seenVariant = false
  let seenWeight = false
  let seenStretch = false

  // 前导可选槽位：style | variant | weight | stretch（各最多一次，可乱序）
  for (; i < tokens.length; i++) {
    const t = tokens[i]!.toLowerCase()
    if (t === 'normal') continue // normal 可出现在任意槽位
    if (!seenStyle && (t === 'italic' || t === 'oblique')) {
      italic = true
      seenStyle = true
      // 'oblique <angle>'：角度是可选第二 token
      if (t === 'oblique' && /^-?[\d.]+(deg|rad|grad|turn)$/.test(tokens[i + 1] ?? '')) i++
      continue
    }
    if (!seenVariant && t === 'small-caps') {
      seenVariant = true
      continue
    }
    if (!seenStretch && STRETCH_KEYWORDS.has(t)) {
      seenStretch = true
      continue
    }
    if (!seenWeight) {
      const w = parseWeight(t)
      if (w != null) {
        weight = w
        seenWeight = true
        continue
      }
    }
    break // 第一个非关键字 token = size
  }

  if (i >= tokens.length) return null
  const sizeToken = tokens[i]!
  const slash = sizeToken.indexOf('/')
  const size = parseSize(slash >= 0 ? sizeToken.slice(0, slash) : sizeToken)
  if (size == null) return null
  i++
  if (slash >= 0) {
    // '12px/1.5'（同 token）或 '12px/ 1.5'（下一 token 是 line-height）
    if (sizeToken.slice(slash + 1) === '') {
      if (i >= tokens.length) return null
      i++
    }
  } else if (i < tokens.length && tokens[i] === '/') {
    // '12px / 1.5' 三 token 形态
    i++
    if (i >= tokens.length) return null
    i++
  }

  const family = firstFamily(tokens.slice(i).join(' '))
  return family ? { family, size, weight, italic } : null
}
