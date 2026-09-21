/**
 * canvas/native.ts — Canvas seam 的 native 函数面。
 *
 * Rust 侧 canvas* napi 函数的 TS 投影 + 进程级绑定。app/UI 代码不直接
 * import @jagent/native（architecture.md §1.2）：main.tsx / e2e 在 seam
 * 装配期 installCanvasNative() 注入真 .node 模块；单测注入录制 fake。
 */

type NativeModule = typeof import('@jagent/native')

/** GpuixCanvas / Canvas2dContext 使用的 canvas* 函数全集。 */
export type CanvasNative = Pick<
  NativeModule,
  | 'canvasArc'
  | 'canvasBeginPath'
  | 'canvasBezierTo'
  | 'canvasCheckColor'
  | 'canvasClearRect'
  | 'canvasClip'
  | 'canvasClosePath'
  | 'canvasCreate'
  | 'canvasDestroy'
  | 'canvasDrawImage'
  | 'canvasEncodePng'
  | 'canvasFill'
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
  | 'canvasStrokeRect'
  | 'canvasStrokeText'
  | 'canvasTransform'
>

let binding: CanvasNative | null = null

/** seam 装配期调用。surface 注册表与窗口无关，renderer 创建前/后均可。 */
export function installCanvasNative(native: CanvasNative): void {
  binding = native
}

export function canvasNative(): CanvasNative {
  if (!binding) {
    throw new Error(
      'canvas native not installed — installCanvasNative() must run during seam assembly',
    )
  }
  return binding
}
