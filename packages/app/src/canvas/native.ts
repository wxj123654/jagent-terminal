/**
 * canvas/native.ts — Canvas seam 的 native 函数面。
 *
 * Rust 侧 canvas* napi 函数的 TS 投影 + 进程级绑定。app/UI 代码不直接
 * import @jagent/native（architecture.md §1.2）：main.tsx / e2e 在 seam
 * 装配期 installCanvasNative() 注入真 .node 模块；单测注入录制 fake。
 */

import { Path2D } from './path2d'

type NativeModule = typeof import('@jagent/native')

/** GpuixCanvas / Canvas2dContext / Path2D 使用的 canvas* 函数全集。 */
export type CanvasNative = Pick<
  NativeModule,
  | 'canvasArc'
  | 'canvasBeginPath'
  | 'canvasBezierTo'
  | 'canvasCheckColor'
  | 'canvasClearRect'
  | 'canvasClip'
  | 'canvasClipPath'
  | 'canvasClosePath'
  | 'canvasCreate'
  | 'canvasDestroy'
  | 'canvasDrawImage'
  | 'canvasEncodePng'
  | 'canvasFill'
  | 'canvasFillPath'
  | 'canvasFillRect'
  | 'canvasFillText'
  | 'canvasGetImageData'
  | 'canvasLineTo'
  | 'canvasMeasureText'
  | 'canvasMoveTo'
  | 'canvasPutImageData'
  | 'canvasQuadraticTo'
  | 'canvasRect'
  | 'canvasReset'
  | 'canvasResetTransform'
  | 'canvasResize'
  | 'canvasRestore'
  | 'canvasRevision'
  | 'canvasRoundRect'
  | 'canvasSave'
  | 'canvasSetCompositeOp'
  | 'canvasSetFillPattern'
  | 'canvasSetFillStyle'
  | 'canvasSetFont'
  | 'canvasSetGlobalAlpha'
  | 'canvasSetImageSmoothing'
  | 'canvasSetLineCap'
  | 'canvasSetLineDash'
  | 'canvasSetLineJoin'
  | 'canvasSetLineWidth'
  | 'canvasSetMiterLimit'
  | 'canvasSetStrokePattern'
  | 'canvasSetStrokeStyle'
  | 'canvasSetTextAlign'
  | 'canvasSetTextBaseline'
  | 'canvasSetTransform'
  | 'canvasStroke'
  | 'canvasStrokePath'
  | 'canvasStrokeRect'
  | 'canvasStrokeText'
  | 'canvasTransform'
>

let binding: CanvasNative | null = null

/**
 * seam 装配期调用。surface 注册表与窗口无关，renderer 创建前/后均可。
 * 同时把 Path2D 挂到 globalThis——canvas 库按 `typeof Path2D ===
 * 'function'` 探测（uPlot 直接 new，Chart.js usePath2D 分支）。
 */
export function installCanvasNative(native: CanvasNative): void {
  binding = native
  const g = globalThis as unknown as { Path2D?: typeof Path2D }
  g.Path2D ??= Path2D
}

export function canvasNative(): CanvasNative {
  if (!binding) {
    throw new Error(
      'canvas native not installed — installCanvasNative() must run during seam assembly',
    )
  }
  return binding
}
