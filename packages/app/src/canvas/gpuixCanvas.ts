/**
 * canvas/canvas.ts — GpuixCanvas：HTMLCanvasElement 形态对象。
 *
 * 持有一块 Rust surface（backing store），getContext('2d') 返回同一块
 * Canvas2dContext。React 侧由 <Canvas>（Canvas.tsx）包装成
 * <canvas surface={id} rev={n}> 挂载；离屏用法直接 createCanvas()。
 *
 * 规范子集：width/height 是 backing 像素尺寸（非 CSS）；改属性 =
 * resize = 清空 bitmap + 重置 context 状态（Rust 已实现）。DOM 事件 /
 * style / getBoundingClientRect 不在子集内（C8 视需要再加）。
 */

import { Canvas2dContext } from './context'
import { canvasNative, type CanvasNative } from './native'

const DEFAULT_WIDTH = 300
const DEFAULT_HEIGHT = 150
const MAX_SIZE = 65535

function checkedSize(v: number, name: string): number {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n) || n < 1 || n > MAX_SIZE) {
    throw new RangeError(`canvas ${name} must be in [1, ${MAX_SIZE}], got ${v}`)
  }
  return n
}

export class GpuixCanvas {
  private readonly native: CanvasNative
  private _surfaceId = 0
  private _ctx: Canvas2dContext | null = null
  private _width: number
  private _height: number
  private _rev = 0
  /** resizeDevice 记的 base transform 系数；destroy 后 revive 时重放。 */
  private pixelRatio = 1
  private listeners = new Set<() => void>()

  constructor(width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, native = canvasNative()) {
    this.native = native
    this._width = checkedSize(width, 'width')
    this._height = checkedSize(height, 'height')
    this._surfaceId = native.canvasCreate(this._width, this._height)
  }

  /** 当前 backing surface id；destroy 后为 0（再次 getContext 会重建）。 */
  get surfaceId(): number {
    return this._surfaceId
  }

  get destroyed(): boolean {
    return this._surfaceId === 0
  }

  get width(): number {
    return this._width
  }
  set width(v: number) {
    this.resize(v, this._height)
  }

  get height(): number {
    return this._height
  }
  set height(v: number) {
    this.resize(this._width, v)
  }

  /** React rev：每次像素变更 +1，<Canvas> 订阅它触发重渲染。 */
  get revision(): number {
    return this._rev
  }

  /** resizeDevice 最近设置的 dpr（<Canvas> 用来看 props 变化是否已落）。 */
  get appliedPixelRatio(): number {
    return this.pixelRatio
  }

  /**
   * 规范 getContext：'2d' 返回同一 ctx；其他模式返回 null。
   * surface 已 destroy 时先按记录尺寸/pixelRatio 重建（离屏 revive）。
   */
  getContext(mode: '2d' | string, _options?: unknown): Canvas2dContext | null {
    if (mode !== '2d') return null
    this.ensureAlive()
    return (this._ctx ??= new Canvas2dContext(this.native, this))
  }

  /**
   * 规范语义 resize：清空 bitmap + 重置全部 context 状态（transform 回
   * identity）。像素尺寸入参；调用方负责 CSS→backing 换算。
   */
  resize(width: number, height: number): void {
    const w = checkedSize(width, 'width')
    const h = checkedSize(height, 'height')
    this.ensureAlive()
    this.native.canvasResize(this._surfaceId, w, h)
    this._width = w
    this._height = h
    this._ctx?._resetShadow()
    this.notifyDirty()
  }

  /**
   * 组件用：resize 到设备像素并把 base transform 重设为 scale(dpr)。
   * backing 尺寸 = CSS 尺寸 × dpr；绘制代码全程用 CSS 坐标。
   */
  resizeDevice(width: number, height: number, dpr: number): void {
    this.resize(width, height)
    this.pixelRatio = dpr
    if (dpr !== 1) {
      this.native.canvasSetTransform(this._surfaceId, dpr, 0, 0, dpr, 0, 0)
    }
  }

  /**
   * 释放 backing surface。已挂载的 <canvas surface> 不再更新；
   * 之后再 getContext/绘制会按记录尺寸自动 revive。
   */
  destroy(): void {
    if (this._surfaceId === 0) return
    this.native.canvasDestroy(this._surfaceId)
    this._surfaceId = 0
    this.listeners.clear()
  }

  /** <Canvas> 的 useSyncExternalStore 订阅口。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 规范 toDataURL：默认 'image/png'；不支持的 type 回退 PNG（规范行为）。
   * 仅 PNG 编码（Rust 侧 image crate）。
   */
  toDataURL(type = 'image/png'): string {
    this.ensureAlive()
    void type // 子集只实现 PNG；规范对不支持的 type 同样回退 image/png
    const png = this.native.canvasEncodePng(this._surfaceId)
    return `data:image/png;base64,${png.toString('base64')}`
  }

  /** ctx mutating 调用后的像素变更通知（internal）。 */
  notifyDirty(): void {
    this._rev++
    for (const l of this.listeners) l()
  }

  private ensureAlive(): void {
    if (this._surfaceId !== 0) return
    this._surfaceId = this.native.canvasCreate(this._width, this._height)
    this._ctx?._resetShadow()
    if (this.pixelRatio !== 1) {
      this.native.canvasSetTransform(this._surfaceId, this.pixelRatio, 0, 0, this.pixelRatio, 0, 0)
    }
  }
}

/** document.createElement('canvas') 对应物：新建 GpuixCanvas（可离屏）。 */
export function createCanvas(width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT): GpuixCanvas {
  return new GpuixCanvas(width, height)
}
