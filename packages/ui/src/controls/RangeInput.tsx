/**
 * ui/RangeInput.tsx — 窄范围滑条 + 实时数值（architecture.md §7；settings-ui.md
 * §5.2「窄范围数值 → slider + 实时数值」，原型 .range-wrap：180px 轨道 +
 * 38px mono 数值）。
 *
 * GPUIX 无 input[type=range]：自绘轨道 + 拇指。定位策略（两级降级）：
 * 1. 比例定位——renderer 实例有 getElementBounds（GpuixRenderer 与
 *    TestGpuixRenderer 都实现；仅 NativeRenderer TS 接口未列，鸭子调用）
 *    → mouseDown 即跳到点击比例位，拖拽全程绝对定位；
 * 2. 无 bounds（假设性环境）→ 记录按下点 startX/startValue，move 时按
 *    deltaX / trackWidth 折算增量。
 * 键盘：←/↓/→/↑ 步进 step，home/end 到边界（§11 键盘可达）。
 * 拖出轨道自然停在最后值（GPUIX mouseMove 只发给 hover 元素，无窗口级捕获）。
 */

import { useGpuix, type PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { focusRing } from '../theme/style'
import { COLORS, FONT } from '../theme/tokens'

type Bounds = { left: number; width: number }

/** 拖动中 onChange 合帧窗口（≤60Hz；帧率上限本就 60Hz，视觉无差） */
const FRAME_MS = 16

/** 鸭子调用 renderer.getElementBounds（NativeRenderer 接口未列，两个实现都有） */
function trackBounds(renderer: unknown, id: number | undefined): Bounds | null {
  if (!renderer || id == null) return null
  const get = (renderer as { getElementBounds?: (id: number) => number[] | null }).getElementBounds
  if (typeof get !== 'function') return null
  const b = get.call(renderer, id)
  if (!Array.isArray(b) || b.length < 4 || b[2] <= 0) return null
  return { left: b[0] as number, width: b[2] as number }
}

export function RangeInput({
  value,
  min,
  max,
  step,
  disabled = false,
  onChange,
  testId,
  width = 180,
  format,
}: {
  value: number
  min: number
  max: number
  step: number
  disabled?: boolean
  onChange: (next: number) => void
  testId: string
  /** 轨道像素宽（原型 180） */
  width?: number
  /** 数值显示格式（如 v => `${v}px`） */
  format?: (v: number) => string
}): ReactElement {
  const { renderer } = useGpuix()
  const hitRef = useRef<PublicInstance | null>(null)
  const dragRef = useRef<{ startX: number; startValue: number } | null>(null)
  const [focused, setFocused] = useState(false)
  const [dragging, setDragging] = useState(false)

  // ── 拖动提交合帧（Windows 拖滑块卡顿修复）──
  // mouseMove 按鼠标采样率到达（500–1000Hz 常见），每次 onChange 都触发
  // React 提交 + native 全帧重建（GPUIX immediate-mode 每帧全量 build +
  // layout + paint）。把拖动中的 onChange 合帧到 ≤60Hz，尾缘 flush 保证
  // 最后值不丢（快速拖到边界仍能停准）。同理 onDown 缓存一次轨道
  // bounds：拖动中 hit 区几何不变，逐 move 的 getElementBounds napi
  // 往返是纯浪费。
  const boundsRef = useRef<Bounds | null>(null)
  const lastEmitRef = useRef(-Infinity)
  const pendingRef = useRef<{ value: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })
  // 卸载清 pending timer（回调面已死，flush 无意义）
  useEffect(
    () => () => {
      if (pendingRef.current) clearTimeout(pendingRef.current.timer)
    },
    [],
  )

  const flushPending = () => {
    const p = pendingRef.current
    if (!p) return
    clearTimeout(p.timer)
    pendingRef.current = null
    lastEmitRef.current = performance.now()
    onChangeRef.current(p.value)
  }

  /** 拖动中合帧提交：帧窗外立即发，窗内挂 pending（新值覆盖），尾缘 flush */
  const emitDrag = (next: number) => {
    if (next === value) return
    const since = performance.now() - lastEmitRef.current
    if (since >= FRAME_MS) {
      lastEmitRef.current = performance.now()
      onChangeRef.current(next)
      return
    }
    if (pendingRef.current) {
      pendingRef.current.value = next
    } else {
      const timer = setTimeout(() => {
        flushPending()
      }, FRAME_MS - since)
      pendingRef.current = { value: next, timer }
    }
  }

  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  const quantize = (n: number) => clamp(Math.round(n / step) * step)

  /** x（窗口坐标）→ 值；bounds 模式下由比例（onDown 缓存），delta 模式由增量 */
  const valueFromX = (x: number): number | null => {
    const bounds = boundsRef.current ?? trackBounds(renderer, hitRef.current?.id)
    if (bounds) {
      const ratio = Math.min(1, Math.max(0, (x - bounds.left) / bounds.width))
      return quantize(min + ratio * (max - min))
    }
    const d = dragRef.current
    if (d) return quantize(d.startValue + ((x - d.startX) / width) * (max - min))
    return null
  }

  const onDown = (x: number) => {
    if (disabled) return
    boundsRef.current = trackBounds(renderer, hitRef.current?.id)
    dragRef.current = { startX: x, startValue: value }
    const next = valueFromX(x)
    // down 首值即时（lastEmitRef=-Infinity 必走立即分支）
    if (next != null) emitDrag(next)
    setDragging(true)
  }

  const onMove = (x: number, pressedButton?: number) => {
    if (disabled || pressedButton !== 0) return
    const next = valueFromX(x)
    if (next != null) emitDrag(next)
  }

  /** 松手 / 拖出轨道：落定 pending 值 + 清拖动态 */
  const endDrag = () => {
    flushPending()
    dragRef.current = null
    boundsRef.current = null
    setDragging(false)
  }

  const nudge = (dir: 1 | -1) => {
    if (disabled) return
    const next = clamp(value + dir * step)
    if (next !== value) onChange(next)
  }

  const ratio = (value - min) / (max - min)
  const thumbLeft = ratio * (width - 12)

  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {/* hit 区：高 16 易点；视觉轨道 4px 居中 */}
      <div
        ref={hitRef}
        testId={testId}
        tabIndex={disabled ? -1 : 0}
        onMouseDown={(e) => onDown(e.x ?? 0)}
        onMouseUp={endDrag}
        onMouseMove={(e) => onMove(e.x ?? 0, e.pressedButton)}
        onMouseLeave={endDrag}
        onKeyDown={(e) => {
          if (e.key === 'left' || e.key === 'down') nudge(-1)
          else if (e.key === 'right' || e.key === 'up') nudge(1)
          else if (e.key === 'home') onChange(min)
          else if (e.key === 'end') onChange(max)
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          position: 'relative',
          width,
          height: 16,
          flexShrink: 0,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          boxShadow: focused ? focusRing() : undefined,
          borderRadius: 999,
        }}
      >
        {/* 底轨 / 填充 / 拇指：装饰层，pointerEvents none 不挡 hit-test
            （GPUIX 事件不冒泡，onMouseDown 宿主必须是 hit 容器本身） */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 6,
            bottom: 6,
            borderRadius: 999,
            backgroundColor: COLORS.inputBg,
            borderWidth: 1,
            borderColor: COLORS.borderSubtle,
            pointerEvents: 'none',
          }}
        />
        {/* 填充 */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 6,
            bottom: 6,
            width: Math.max(0, Math.min(width, ratio * width)),
            borderRadius: 999,
            backgroundColor: COLORS.accent,
            pointerEvents: 'none',
          }}
        />
        {/* 拇指：12px，dragging/focused 放大感（GPUIX 无 scale，用边框加粗） */}
        <div
          style={{
            position: 'absolute',
            left: thumbLeft,
            top: 2,
            width: 12,
            height: 12,
            borderRadius: 999,
            backgroundColor: COLORS.textBright,
            borderWidth: 1,
            borderColor: dragging || focused ? COLORS.focusBorder : COLORS.borderSubtle,
            pointerEvents: 'none',
          }}
        />
      </div>
      {/* 实时数值（mono 右对齐，原型 .range-val） */}
      <text
        testId={`${testId}-val`}
        style={{
          minWidth: 38,
          textAlign: 'right',
          fontSize: 12,
          fontFamily: FONT.mono,
          color: COLORS.textBright,
        }}
      >
        {format ? format(value) : String(value)}
      </text>
    </div>
  )
}
