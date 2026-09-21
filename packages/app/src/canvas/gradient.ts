/**
 * canvas/gradient.ts — CanvasGradient / CanvasPattern。
 *
 * fillStyle/strokeStyle 的非颜色形态。两者都是「创建时刻的不可变快照」：
 * gradient 存几何 + stop 表（序列化后经 canvasSetFillStyle 传 Rust 的
 * parse_paint_value）；pattern 存 unpremultiplied RGBA8 像素（
 * createPattern 时刻对源 surface 的 getImageData 快照），经
 * canvasSetFillPattern 专用通道进 Rust。
 */

import type { CanvasNative } from './native'

/** Rust `parse_gradient` 认识的序列化形态（serde_json::Value 入参）。 */
export type GradientSpec =
  | {
      kind: 'linear'
      x0: number
      y0: number
      x1: number
      y1: number
      stops: ColorStopSpec[]
    }
  | {
      kind: 'radial'
      x0: number
      y0: number
      r0: number
      x1: number
      y1: number
      r1: number
      stops: ColorStopSpec[]
    }
  | {
      kind: 'conic'
      angle: number
      x: number
      y: number
      stops: ColorStopSpec[]
    }

export interface ColorStopSpec {
  offset: number
  color: string
}

export class CanvasGradient {
  /** 内部 spec：stops 由 addColorStop 追加，序列化时 Rust 侧排序。 */
  constructor(
    readonly spec: GradientSpec,
    private readonly native: CanvasNative,
  ) {}

  /**
   * 规范：offset 非有限 → TypeError；<0 或 >1 → IndexSizeError；
   * color 不可解析 → SyntaxError。
   */
  addColorStop(offset: number, color: string): void {
    const o = Number(offset)
    if (!Number.isFinite(o)) throw new TypeError('addColorStop offset must be finite')
    if (o < 0 || o > 1) {
      throw new DOMException('addColorStop offset must be in [0, 1]', 'IndexSizeError')
    }
    const css = String(color)
    if (!this.native.canvasCheckColor(css)) {
      throw new DOMException(`unparseable color '${css}'`, 'SyntaxError')
    }
    this.spec.stops.push({ offset: o, color: css })
  }
}

export type PatternRepetition = 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat'

export class CanvasPattern {
  constructor(
    /** unpremultiplied RGBA8 快照（createPattern 时刻）。 */
    readonly pixels: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
    readonly repetition: PatternRepetition,
  ) {}
}

/** fillStyle/strokeStyle 的可赋值联合。 */
export type PaintStyle = string | CanvasGradient | CanvasPattern
