/**
 * canvas/context.ts — CanvasRenderingContext2D 形态封装。
 *
 * 每个方法转发对应 canvas* napi 调用；getter 返回 JS shadow state（save/
 * restore 快照用，Rust 侧另有权威栈）。规范语义差异见
 * docs/canvas-2d-standard-research.md；逐条兼容状态见
 * docs/canvas-conformance.json。
 *
 * 明确不在子集内：createImageData(PNG)、DOMMatrix、ellipse/arcTo、
 * isPointInPath、direction/letterSpacing、CanvasPattern.setTransform 等。
 * 调用不存在的方法自然抛 TypeError（库自行 feature-detect）。
 */

import { parseFontShorthand } from './font'
import { GpuixCanvas } from './gpuixCanvas'
import { CanvasGradient, CanvasPattern, type PaintStyle, type PatternRepetition } from './gradient'
import type { CanvasNative } from './native'

export type LineCap = 'butt' | 'round' | 'square'
export type LineJoin = 'bevel' | 'round' | 'miter'
export type FillRule = 'nonzero' | 'evenodd'
export type TextAlign = 'left' | 'right' | 'center' | 'start' | 'end'
export type TextBaseline = 'top' | 'hanging' | 'middle' | 'alphabetic' | 'ideographic' | 'bottom'

/** Rust 侧支持的合成算子全集（backend.rs CompositeOp）。 */
export type CompositeOp =
  | 'source-over'
  | 'source-atop'
  | 'source-in'
  | 'source-out'
  | 'destination-over'
  | 'destination-atop'
  | 'destination-in'
  | 'destination-out'
  | 'lighter'
  | 'copy'
  | 'xor'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'
  | 'clear'
  | 'plus'

const COMPOSITE_OPS = new Set<string>([
  'source-over',
  'source-atop',
  'source-in',
  'source-out',
  'destination-over',
  'destination-atop',
  'destination-in',
  'destination-out',
  'lighter',
  'copy',
  'xor',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'clear',
  'plus',
])
const LINE_CAPS = new Set<string>(['butt', 'round', 'square'])
const LINE_JOINS = new Set<string>(['bevel', 'round', 'miter'])
const TEXT_ALIGNS = new Set<string>(['left', 'right', 'center', 'start', 'end'])
const TEXT_BASELINES = new Set<string>([
  'top',
  'hanging',
  'middle',
  'alphabetic',
  'ideographic',
  'bottom',
])
const FILL_RULES = new Set<string>(['nonzero', 'evenodd'])

/** `getImageData` / `putImageData` / `createImageData` 的返回形态。 */
export interface ImageDataLike {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
  readonly colorSpace: 'srgb'
}

export interface TextMetricsLike {
  readonly width: number
  readonly actualBoundingBoxLeft: number
  readonly actualBoundingBoxRight: number
  readonly actualBoundingBoxAscent: number
  readonly actualBoundingBoxDescent: number
  readonly fontBoundingBoxAscent: number
  readonly fontBoundingBoxDescent: number
  readonly alphabeticBaseline: number
  readonly ideographicBaseline: number
  readonly hangingBaseline: number
}

/** save/restore 快照的 JS shadow（Rust 侧另有权威栈，两边同步维护）。 */
interface CtxState {
  fillStyle: PaintStyle
  strokeStyle: PaintStyle
  globalAlpha: number
  compositeOp: CompositeOp
  lineWidth: number
  lineCap: LineCap
  lineJoin: LineJoin
  miterLimit: number
  lineDash: number[]
  lineDashOffset: number
  font: string
  textAlign: TextAlign
  textBaseline: TextBaseline
  imageSmoothingEnabled: boolean
}

function defaultState(): CtxState {
  return {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    compositeOp: 'source-over',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    lineDash: [],
    lineDashOffset: 0,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    imageSmoothingEnabled: true,
  }
}

function finite(v: number): boolean {
  return Number.isFinite(v)
}

function finiteAll(...vs: Array<number | undefined>): boolean {
  return vs.every((v) => Number.isFinite(v))
}

export class Canvas2dContext {
  private readonly native: CanvasNative
  private readonly owner: GpuixCanvas
  private state: CtxState = defaultState()
  private stack: CtxState[] = []

  constructor(native: CanvasNative, owner: GpuixCanvas) {
    this.native = native
    this.owner = owner
  }

  /** surface id 动态取——destroy 后 owner 可能 revive 出新 surface。 */
  private get id(): number {
    return this.owner.surfaceId
  }

  /** 像素变更通知 → React rev bump（由 owner 转发订阅者）。 */
  private dirty(): void {
    this.owner.notifyDirty()
  }

  /** owner resize/reset/revive 后调用：shadow 回到默认值。 */
  _resetShadow(): void {
    this.state = defaultState()
    this.stack = []
  }

  get canvas(): GpuixCanvas {
    return this.owner
  }

  // ── fill/stroke 样式 ────────────────────────────────────────────

  get fillStyle(): PaintStyle {
    return this.state.fillStyle
  }
  set fillStyle(value: PaintStyle) {
    const applied = this.applyPaint(value, 'fill')
    if (applied !== undefined) this.state.fillStyle = applied
  }

  get strokeStyle(): PaintStyle {
    return this.state.strokeStyle
  }
  set strokeStyle(value: PaintStyle) {
    const applied = this.applyPaint(value, 'stroke')
    if (applied !== undefined) this.state.strokeStyle = applied
  }

  /**
   * 规范赋值路径：字符串 → CSS 颜色；CanvasGradient → spec 对象；
   * CanvasPattern → 像素快照专用通道。非法值静默忽略（surface 已死
   * 才是真错误）。返回实际生效的值，undefined = 忽略。
   */
  private applyPaint(value: PaintStyle, which: 'fill' | 'stroke'): PaintStyle | undefined {
    const fill = which === 'fill'
    try {
      if (value instanceof CanvasGradient) {
        if (fill) this.native.canvasSetFillStyle(this.id, value.spec)
        else this.native.canvasSetStrokeStyle(this.id, value.spec)
        return value
      }
      if (value instanceof CanvasPattern) {
        const pixels = Buffer.from(
          value.pixels.buffer,
          value.pixels.byteOffset,
          value.pixels.byteLength,
        )
        if (fill)
          this.native.canvasSetFillPattern(
            this.id,
            pixels,
            value.width,
            value.height,
            value.repetition,
          )
        else
          this.native.canvasSetStrokePattern(
            this.id,
            pixels,
            value.width,
            value.height,
            value.repetition,
          )
        return value
      }
      const css = String(value)
      if (fill) this.native.canvasSetFillStyle(this.id, css)
      else this.native.canvasSetStrokeStyle(this.id, css)
      return css
    } catch (e) {
      if (this.owner.destroyed) throw e
      return undefined
    }
  }

  // ── gradient / pattern ──────────────────────────────────────────

  /** 规范：参数必须有限，否则 TypeError。 */
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
    const n = [x0, y0, x1, y1].map(Number)
    if (!finiteAll(...n)) throw new TypeError('createLinearGradient arguments must be finite')
    return new CanvasGradient(
      { kind: 'linear', x0: n[0]!, y0: n[1]!, x1: n[2]!, y1: n[3]!, stops: [] },
      this.native,
    )
  }

  /** 规范：参数必须有限；r0/r1 为负 → IndexSizeError。 */
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): CanvasGradient {
    const n = [x0, y0, r0, x1, y1, r1].map(Number)
    if (!finiteAll(...n)) throw new TypeError('createRadialGradient arguments must be finite')
    if (n[2]! < 0 || n[5]! < 0) {
      throw new DOMException('createRadialGradient radius must be non-negative', 'IndexSizeError')
    }
    return new CanvasGradient(
      {
        kind: 'radial',
        x0: n[0]!,
        y0: n[1]!,
        r0: n[2]!,
        x1: n[3]!,
        y1: n[4]!,
        r1: n[5]!,
        stops: [],
      },
      this.native,
    )
  }

  createConicGradient(startAngle: number, x: number, y: number): CanvasGradient {
    const n = [startAngle, x, y].map(Number)
    if (!finiteAll(...n)) throw new TypeError('createConicGradient arguments must be finite')
    return new CanvasGradient(
      { kind: 'conic', angle: n[0]!, x: n[1]!, y: n[2]!, stops: [] },
      this.native,
    )
  }

  /**
   * 规范：源为无位图/已销毁 canvas → 返回 null；repetition 为 null/''/
   * 非四值 → 归一化为 'repeat'。像素取创建时刻的快照（getImageData）。
   */
  createPattern(source: GpuixCanvas, repetition: string | null = 'repeat'): CanvasPattern | null {
    if (!(source instanceof GpuixCanvas)) {
      throw new TypeError('createPattern source must be a canvas')
    }
    if (source.destroyed) return null
    const rep: PatternRepetition =
      repetition === 'repeat-x' || repetition === 'repeat-y' || repetition === 'no-repeat'
        ? repetition
        : 'repeat'
    const data = this.native.canvasGetImageData(source.surfaceId, 0, 0, source.width, source.height)
    return new CanvasPattern(
      new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      source.width,
      source.height,
      rep,
    )
  }

  // ── 合成与透明度 ────────────────────────────────────────────────

  get globalAlpha(): number {
    return this.state.globalAlpha
  }
  set globalAlpha(v: number) {
    const n = Number(v)
    if (!finite(n) || n < 0 || n > 1) return
    this.native.canvasSetGlobalAlpha(this.id, n)
    this.state.globalAlpha = n
  }

  get globalCompositeOperation(): CompositeOp {
    return this.state.compositeOp
  }
  set globalCompositeOperation(v: CompositeOp) {
    if (!COMPOSITE_OPS.has(v)) return
    this.native.canvasSetCompositeOp(this.id, v)
    this.state.compositeOp = v
  }

  // ── 线型 ────────────────────────────────────────────────────────

  get lineWidth(): number {
    return this.state.lineWidth
  }
  set lineWidth(v: number) {
    const n = Number(v)
    if (!finite(n) || n <= 0) return
    this.native.canvasSetLineWidth(this.id, n)
    this.state.lineWidth = n
  }

  get lineCap(): LineCap {
    return this.state.lineCap
  }
  set lineCap(v: LineCap) {
    if (!LINE_CAPS.has(v)) return
    this.native.canvasSetLineCap(this.id, v)
    this.state.lineCap = v
  }

  get lineJoin(): LineJoin {
    return this.state.lineJoin
  }
  set lineJoin(v: LineJoin) {
    if (!LINE_JOINS.has(v)) return
    this.native.canvasSetLineJoin(this.id, v)
    this.state.lineJoin = v
  }

  get miterLimit(): number {
    return this.state.miterLimit
  }
  set miterLimit(v: number) {
    const n = Number(v)
    if (!finite(n) || n <= 0) return
    this.native.canvasSetMiterLimit(this.id, n)
    this.state.miterLimit = n
  }

  get lineDashOffset(): number {
    return this.state.lineDashOffset
  }
  set lineDashOffset(v: number) {
    const n = Number(v)
    if (!finite(n)) return
    this.native.canvasSetLineDash(this.id, this.state.lineDash, n)
    this.state.lineDashOffset = n
  }

  /** 规范：奇数段复制成偶数；非数/负数 → 整表丢弃（setter 静默）。 */
  setLineDash(segments: number[] | ArrayLike<number>): void {
    const segs = Array.from(segments ?? [], Number)
    if (segs.some((n) => !finite(n) || n < 0)) return
    const list = segs.length % 2 === 1 ? [...segs, ...segs] : segs
    this.native.canvasSetLineDash(this.id, list, this.state.lineDashOffset)
    this.state.lineDash = list
  }

  getLineDash(): number[] {
    return [...this.state.lineDash]
  }

  // ── 文本属性 ────────────────────────────────────────────────────

  get font(): string {
    return this.state.font
  }
  set font(v: string) {
    const css = String(v)
    const parsed = parseFontShorthand(css)
    if (!parsed) return
    this.native.canvasSetFont(this.id, parsed.family, parsed.size, parsed.weight, parsed.italic)
    this.state.font = css
  }

  get textAlign(): TextAlign {
    return this.state.textAlign
  }
  set textAlign(v: TextAlign) {
    if (!TEXT_ALIGNS.has(v)) return
    this.native.canvasSetTextAlign(this.id, v)
    this.state.textAlign = v
  }

  get textBaseline(): TextBaseline {
    return this.state.textBaseline
  }
  set textBaseline(v: TextBaseline) {
    if (!TEXT_BASELINES.has(v)) return
    this.native.canvasSetTextBaseline(this.id, v)
    this.state.textBaseline = v
  }

  /** 规范默认 true（双线性）。false → 最近邻。 */
  get imageSmoothingEnabled(): boolean {
    return this.state.imageSmoothingEnabled
  }
  set imageSmoothingEnabled(v: boolean) {
    const b = Boolean(v)
    this.native.canvasSetImageSmoothing(this.id, b)
    this.state.imageSmoothingEnabled = b
  }

  // ── 状态栈 ──────────────────────────────────────────────────────

  save(): void {
    this.stack.push({ ...this.state, lineDash: [...this.state.lineDash] })
    this.native.canvasSave(this.id)
  }

  restore(): void {
    if (this.stack.length === 0) return
    this.state = this.stack.pop()!
    this.native.canvasRestore(this.id)
  }

  /** 规范 ctx.reset()：清空 bitmap + 全部状态（含路径/transform/clip）。 */
  reset(): void {
    this.native.canvasReset(this.id)
    this._resetShadow()
    this.dirty()
  }

  // ── transform（状态调用：不动像素，不 bump rev）─────────────────

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const m = [a, b, c, d, e, f].map(Number)
    if (!finiteAll(...m)) return
    this.native.canvasTransform(this.id, m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!)
  }

  setTransform(
    a:
      | number
      | {
          a?: number
          b?: number
          c?: number
          d?: number
          e?: number
          f?: number
        },
    b?: number,
    c?: number,
    d?: number,
    e?: number,
    f?: number,
  ): void {
    const m =
      typeof a === 'object' && a !== null
        ? [a.a ?? 1, a.b ?? 0, a.c ?? 0, a.d ?? 1, a.e ?? 0, a.f ?? 0].map(Number)
        : [a, b, c, d, e, f].map(Number)
    if (!finiteAll(...m)) return
    this.native.canvasSetTransform(this.id, m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!)
  }

  resetTransform(): void {
    this.native.canvasResetTransform(this.id)
  }

  translate(x: number, y: number): void {
    this.transform(1, 0, 0, 1, x, y)
  }
  scale(x: number, y: number): void {
    this.transform(x, 0, 0, y, 0, 0)
  }
  rotate(angle: number): void {
    const r = Number(angle)
    if (!finite(r)) return
    this.transform(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0)
  }

  // ── path 构建（非像素操作）──────────────────────────────────────

  beginPath(): void {
    this.native.canvasBeginPath(this.id)
  }
  closePath(): void {
    this.native.canvasClosePath(this.id)
  }
  moveTo(x: number, y: number): void {
    if (finiteAll(x, y)) this.native.canvasMoveTo(this.id, Number(x), Number(y))
  }
  lineTo(x: number, y: number): void {
    if (finiteAll(x, y)) this.native.canvasLineTo(this.id, Number(x), Number(y))
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (finiteAll(cx, cy, x, y))
      this.native.canvasQuadraticTo(this.id, Number(cx), Number(cy), Number(x), Number(y))
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (finiteAll(c1x, c1y, c2x, c2y, x, y))
      this.native.canvasBezierTo(
        this.id,
        Number(c1x),
        Number(c1y),
        Number(c2x),
        Number(c2y),
        Number(x),
        Number(y),
      )
  }

  arc(x: number, y: number, radius: number, start: number, end: number, ccw = false): void {
    const n = [x, y, radius, start, end].map(Number)
    if (!finiteAll(...n)) return
    if (n[2]! < 0) throw new DOMException('arc radius must be non-negative', 'IndexSizeError')
    this.native.canvasArc(this.id, n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, Boolean(ccw))
  }

  rect(x: number, y: number, w: number, h: number): void {
    if (finiteAll(x, y, w, h))
      this.native.canvasRect(this.id, Number(x), Number(y), Number(w), Number(h))
  }

  roundRect(x: number, y: number, w: number, h: number, radius = 0): void {
    const n = [x, y, w, h, radius].map(Number)
    if (!finiteAll(...n)) return
    this.native.canvasRoundRect(this.id, n[0]!, n[1]!, n[2]!, n[3]!, Math.max(0, n[4]!))
  }

  // ── 绘制（像素变更 → rev bump）──────────────────────────────────

  fill(rule: FillRule = 'nonzero'): void {
    if (!FILL_RULES.has(rule)) throw new TypeError(`invalid fillRule: ${rule}`)
    this.native.canvasFill(this.id, rule)
    this.dirty()
  }

  stroke(): void {
    this.native.canvasStroke(this.id)
    this.dirty()
  }

  clip(rule: FillRule = 'nonzero'): void {
    if (!FILL_RULES.has(rule)) throw new TypeError(`invalid fillRule: ${rule}`)
    this.native.canvasClip(this.id, rule)
    // clip 是状态不是像素：下一次绘制 op 才生效——不 bump
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const n = [x, y, w, h].map(Number)
    if (!finiteAll(...n) || n[2] === 0 || n[3] === 0) return
    this.native.canvasFillRect(this.id, n[0]!, n[1]!, n[2]!, n[3]!)
    this.dirty()
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    const n = [x, y, w, h].map(Number)
    if (!finiteAll(...n) || n[2] === 0 || n[3] === 0) return
    this.native.canvasStrokeRect(this.id, n[0]!, n[1]!, n[2]!, n[3]!)
    this.dirty()
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    const n = [x, y, w, h].map(Number)
    if (!finiteAll(...n) || n[2] === 0 || n[3] === 0) return
    this.native.canvasClearRect(this.id, n[0]!, n[1]!, n[2]!, n[3]!)
    this.dirty()
  }

  fillText(text: string, x: number, y: number): void {
    const s = String(text)
    if (s === '' || !finiteAll(x, y)) return
    this.native.canvasFillText(this.id, s, Number(x), Number(y))
    this.dirty()
  }

  strokeText(text: string, x: number, y: number): void {
    const s = String(text)
    if (s === '' || !finiteAll(x, y)) return
    this.native.canvasStrokeText(this.id, s, Number(x), Number(y))
    this.dirty()
  }

  /** Rust 返回首行 width + font bounding box；其余字段按文档化近似补齐。 */
  measureText(text: string): TextMetricsLike {
    const m = this.native.canvasMeasureText(this.id, String(text))
    return {
      width: m.width,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: m.width,
      actualBoundingBoxAscent: m.fontBoundingBoxAscent,
      actualBoundingBoxDescent: m.fontBoundingBoxDescent,
      fontBoundingBoxAscent: m.fontBoundingBoxAscent,
      fontBoundingBoxDescent: m.fontBoundingBoxDescent,
      alphabeticBaseline: 0,
      ideographicBaseline: -m.fontBoundingBoxDescent,
      hangingBaseline: m.fontBoundingBoxAscent * 0.8,
    }
  }

  /**
   * drawImage(source, dx, dy) / (dx, dy, dw, dh) / (sx, sy, sw, sh, dx, dy, dw, dh)。
   * 规范：非有限参数静默返回；退化矩形 no-op；源矩形出界按比例收缩 dst；
   * 负 dw/dh = 镜像（Rust 侧实现）。source 只能是 GpuixCanvas（离屏/已挂载）。
   */
  drawImage(source: GpuixCanvas, ...args: number[]): void {
    if (!(source instanceof GpuixCanvas)) {
      throw new TypeError('drawImage source must be a canvas')
    }
    if (source.destroyed) return
    const n = args.map(Number)
    let rect: number[]
    switch (n.length) {
      case 2:
        rect = [0, 0, source.width, source.height, n[0]!, n[1]!, source.width, source.height]
        break
      case 4:
        rect = [0, 0, source.width, source.height, n[0]!, n[1]!, n[2]!, n[3]!]
        break
      case 8:
        rect = n
        break
      default:
        throw new TypeError('drawImage expects 3, 5 or 9 arguments')
    }
    if (!finiteAll(...rect)) return
    const changed = this.native.canvasDrawImage(
      this.id,
      source.surfaceId,
      rect[0]!,
      rect[1]!,
      rect[2]!,
      rect[3]!,
      rect[4]!,
      rect[5]!,
      rect[6]!,
      rect[7]!,
    )
    if (changed) this.dirty()
  }

  // ── 像素 I/O ────────────────────────────────────────────────────

  /** 规范：sw/sh 为 0 抛 IndexSizeError；非有限抛 TypeError。 */
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageDataLike {
    const n = [sx, sy, sw, sh].map(Number)
    if (!finiteAll(...n)) throw new TypeError('getImageData arguments must be finite')
    const [x, y, w, h] = n.map(Math.trunc)
    if (w === 0 || h === 0)
      throw new DOMException('getImageData width/height must be non-zero', 'IndexSizeError')
    const buf = this.native.canvasGetImageData(this.id, x!, y!, w!, h!)
    return {
      data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength),
      width: w!,
      height: h!,
      colorSpace: 'srgb',
    }
  }

  createImageData(w: number, h: number): ImageDataLike {
    const n = [w, h].map(Number)
    if (!finiteAll(...n)) throw new TypeError('createImageData arguments must be finite')
    const [iw, ih] = n.map(Math.trunc)
    if (iw === 0 || ih === 0)
      throw new DOMException('createImageData size must be non-zero', 'IndexSizeError')
    return {
      data: new Uint8ClampedArray(Math.abs(iw!) * Math.abs(ih!) * 4),
      width: Math.abs(iw!),
      height: Math.abs(ih!),
      colorSpace: 'srgb',
    }
  }

  /**
   * putImageData(imageData, dx, dy [, dirtyX, dirtyY, dirtyW, dirtyH])。
   * dirty 矩形裁剪出源子区域写往 (dx+dirtyX, dy+dirtyY)。
   */
  putImageData(
    imageData: ImageDataLike,
    dx: number,
    dy: number,
    dirtyX = 0,
    dirtyY = 0,
    dirtyW?: number,
    dirtyH?: number,
  ): void {
    if (!imageData || !(imageData.data instanceof Uint8ClampedArray))
      throw new TypeError('putImageData requires an ImageData-like object')
    const { width: sw, height: sh, data } = imageData
    const [x, y] = [dx, dy].map((v) => Math.trunc(Number(v)))
    const [ox, oy, ow, oh] = [dirtyX, dirtyY, dirtyW ?? sw, dirtyH ?? sh].map((v) =>
      Math.trunc(Number(v)),
    )
    if (!finiteAll(x, y, ox, oy, ow, oh))
      throw new TypeError('putImageData arguments must be finite')
    // 规范：dirty 矩形裁剪到源尺寸
    const cx = Math.max(0, ox)
    const cy = Math.max(0, oy)
    const cw = Math.min(ow + Math.min(0, ox), sw - Math.max(0, ox))
    const ch = Math.min(oh + Math.min(0, oy), sh - Math.max(0, oy))
    if (cw <= 0 || ch <= 0) return
    // 全图写：零拷贝视图；dirty 子区：逐行 copy
    const bytes =
      cx === 0 && cy === 0 && cw === sw && ch === sh
        ? data.subarray(0, cw * ch * 4)
        : (() => {
            const sub = new Uint8ClampedArray(cw * ch * 4)
            for (let row = 0; row < ch; row++) {
              const srcOff = ((cy + row) * sw + cx) * 4
              sub.set(data.subarray(srcOff, srcOff + cw * 4), row * cw * 4)
            }
            return sub
          })()
    this.native.canvasPutImageData(
      this.id,
      x + cx,
      y + cy,
      cw,
      ch,
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    )
    this.dirty()
  }
}
