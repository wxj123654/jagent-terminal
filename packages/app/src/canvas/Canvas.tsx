/**
 * canvas/Canvas.tsx — <Canvas> React 组件。
 *
 * 挂载 GpuixCanvas：<canvas surface={id} rev={n}>。width/height 是 CSS
 * 逻辑尺寸；backing store = 尺寸 × pixelRatio（默认
 * globalThis.devicePixelRatio ?? 1，test 环境传定值）。ctx 全程用 CSS
 * 坐标——resizeDevice 把 base transform 设为 scale(dpr)。
 *
 * ref 暴露 GpuixCanvas（React 19 ref-as-prop），调法：
 *   const ref = useRef<GpuixCanvas>(null)
 *   <Canvas ref={ref} width={300} height={150} />
 *   ref.current?.getContext('2d')?.fillRect(0, 0, 10, 10)
 *
 * 每个像素变更 op → GpuixCanvas.notifyDirty → rev+1 → 重渲染 → 挂载元素
 * 的 paint 闭包从 Rust revision 检出 dirty 并重传纹理。路径/样式等
 * 非像素 op 不 bump（改了也不该重传）。
 */

import type { StyleDesc } from '@gpuix/react'
import { createElement, useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { Ref } from 'react'
import { createCanvas, type GpuixCanvas } from './gpuixCanvas'

export interface CanvasProps extends Record<string, unknown> {
  /** CSS 逻辑宽（backing = width × pixelRatio）。 */
  width: number
  /** CSS 逻辑高。 */
  height: number
  /** backing = CSS 尺寸 × pixelRatio；默认 devicePixelRatio ?? 1。 */
  pixelRatio?: number
  style?: StyleDesc
  /** ref 拿到 GpuixCanvas（对应 DOM 的 HTMLCanvasElement）。 */
  ref?: Ref<GpuixCanvas>
}

function devicePixelRatioDefault(): number {
  const dpr = (globalThis as { devicePixelRatio?: number }).devicePixelRatio
  return typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0 ? dpr : 1
}

export function Canvas(props: CanvasProps) {
  const { width, height, pixelRatio, style, ref, ...rest } = props
  const dpr = pixelRatio ?? devicePixelRatioDefault()

  // lazy ref init：render 期创建一次（ref 跨 render 持久，StrictMode 双调不重复建）
  const canvasRef = useRef<GpuixCanvas | null>(null)
  if (canvasRef.current === null) {
    canvasRef.current = createCanvas(
      Math.max(1, Math.round(width * dpr)),
      Math.max(1, Math.round(height * dpr)),
    )
    if (dpr !== 1)
      canvasRef.current.resizeDevice(canvasRef.current.width, canvasRef.current.height, dpr)
  }
  const canvas = canvasRef.current

  // 对外暴露 GpuixCanvas（React 19：callback ref 可返回 cleanup）
  useEffect(() => {
    if (typeof ref === 'function') {
      const cleanup = ref(canvas)
      if (typeof cleanup === 'function') return cleanup
      return () => {
        ref(null)
      }
    }
    if (ref && typeof ref === 'object') {
      ref.current = canvas
      return () => {
        ref.current = null
      }
    }
    return undefined
  }, [ref, canvas])

  // CSS 尺寸/DPR 变化 → backing resize + base transform 重设
  useEffect(() => {
    const bw = Math.max(1, Math.round(width * dpr))
    const bh = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== bw || canvas.height !== bh || canvas.appliedPixelRatio !== dpr) {
      canvas.resizeDevice(bw, bh, dpr)
    }
  }, [canvas, width, height, dpr])

  // 像素变更 → 重渲染（rev prop 变化驱动挂载元素重传纹理）
  const rev = useSyncExternalStore(
    useCallback((cb: () => void) => canvas.subscribe(cb), [canvas]),
    () => canvas.revision,
  )

  // unmount → 释放 backing surface
  useEffect(() => () => canvas.destroy(), [canvas])

  // createElement 而非 JSX：IntrinsicElements.canvas 已声明为通用 Props，
  // surface/rev 走 custom prop 通道（gpuix host-config 对非内建元素全量转发）。
  return createElement('canvas', {
    ...rest,
    surface: canvas.surfaceId,
    rev,
    style: { width, height, ...style },
  })
}
