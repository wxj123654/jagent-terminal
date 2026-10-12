/**
 * ui/Popover.tsx — 坐标定位浮层原语。
 *
 * 用途：右键菜单、工具条旁绝对坐标浮层等「点一下外部就关」的轻量层。
 * 实现：`<anchored position deferred occlude>`（CONSTRAINTS #2：deferred 画在
 * 一切内容之上；occlude 吞命中）+ `onMouseDownOutside` 关层。
 *
 * 与 Modal 的差别：无半透明遮罩、不居中、不挡底下滚动命中——只在浮层外
 * mousedown 时关。调用方控制挂载（渲染 = 打开；onClose 里卸载）。
 *
 * 定位两种模式（二选一）：
 * - `position={{ x, y }}`：坐标锚定（右键 / 绝对坐标场景）。
 * - 省略 `position`，用 `side` / `align` / `gap`：贴「父元素」的边缘。gpuix
 *   `<anchored>` 无 position 时由 wrap_at_trigger 包一层绝对定位的 0 尺寸盒
 *   （anchored.rs:179），即相对 Popover 所在父节点的盒子定位。故触发器与
 *   Popover 须是父子关系（Popover 渲染在触发器内部）。此路径未经真窗口验证。
 */

import type { StyleDesc } from '@gpuix/react'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

import { keyConsumed, overlayEsc } from '../keyboard'
import { COLORS, FONT } from '../theme/tokens'

export type PopoverAnchor =
  | 'topLeft'
  | 'topCenter'
  | 'topRight'
  | 'rightCenter'
  | 'bottomRight'
  | 'bottomCenter'
  | 'bottomLeft'
  | 'leftCenter'

export function Popover({
  position,
  side,
  align,
  gap,
  fit,
  onClose,
  children,
  style,
  minWidth = 220,
  testId = 'popover',
  anchor,
  autoFocus = false,
}: {
  /** 浮层左上角（或 `anchor` 指定角）的窗口坐标；与 side/align 二选一 */
  position?: { x: number; y: number }
  /** 无 position 时：贴父元素哪一边（默认 bottom） */
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** 无 position 时：沿该边的对齐（默认 start） */
  align?: 'start' | 'center' | 'end'
  /** 无 position 时：与父元素边缘的间距 */
  gap?: number
  /** 无 position 时：放不下时的处理。默认 'switch'＝翻到对侧（Web 端 flip 语义）；
   *  'snap'＝整体夹回窗口内（会压住触发钮，仅在明确需要时用）。position 模式恒为 snap */
  fit?: 'switch' | 'snap'
  /** 点外部 / Esc → 关闭（调用方通常 setOpen(false)） */
  onClose: () => void
  children: ReactNode
  /** 覆盖默认 One Dark 壳样式 */
  style?: StyleDesc
  /** 默认最小宽（anchored 宽 = 内容宽，需钳制） */
  minWidth?: number
  testId?: string
  /** position 锚在浮层哪一角；省略时 position 模式默认 topLeft（坐标即左上角），
   *  side 模式由 side/align 推导（gpuix resolved_anchor：显式 anchor 优先） */
  anchor?: PopoverAnchor
  /** 挂载即聚焦内容盒（上下文菜单等需要 Esc/键盘命中的场景） */
  autoFocus?: boolean
}) {
  // anchored 的 Rust 兜底（anchored.rs）：元素自身 style 无不透明背景时
  // 强制填 #1A1A1A——而圆角卡片的角是透明的，兜底色会从四角透出黑色
  // 三角块。把卡片的面色（背景 + 圆角）同步到 anchored 上，兜底填充与
  // 卡片同色同形即不可见（Modal/GitGraphView 同款写法）。
  const surface: StyleDesc = {
    backgroundColor: style?.backgroundColor ?? COLORS.overlay,
    background: style?.background,
    borderRadius: style?.borderRadius ?? 6,
  }
  // 浮层 Esc 栈（R11）：挂载期间登记 close——焦点不在浮层内时 root 键位
  // 层也能关（原型 notifOpen/fontPicker 层语义：Radix 的 Esc 是 document
  // 级）。焦点在浮层内时下方元素级 Esc 先置 keyConsumed，root 层跳过
  // ——两条路径各关一次、不重复。
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => overlayEsc.push(() => closeRef.current()), [])
  return (
    <anchored
      position={position}
      side={position ? undefined : (side ?? 'bottom')}
      align={position ? undefined : (align ?? 'start')}
      gap={position ? undefined : gap}
      fit={position ? 'snap' : (fit ?? 'switch')}
      anchor={position ? (anchor ?? 'topLeft') : anchor}
      deferred
      occlude
      style={surface}
    >
      {/*
        onMouseDownOutside 挂内层内容盒（对齐 gpuix events.test anchored
        dialog）：外点命中以内容 bounds 为准，不挂在 <anchored> 自定义元
        素上——后者的 hit 盒在 deferred 布局下偶发偏大。
      */}
      <div
        testId={testId}
        tabIndex={0}
        autoFocus={autoFocus}
        onMouseDownOutside={onClose}
        onKeyDown={(e) => {
          if (e.key === 'escape') {
            keyConsumed.mark()
            onClose()
          }
        }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth,
          backgroundColor: COLORS.overlay,
          borderWidth: 1,
          borderColor: COLORS.borderSubtle,
          borderRadius: 6,
          padding: 4,
          color: COLORS.text,
          fontFamily: FONT.ui,
          ...style,
        }}
      >
        {children}
      </div>
    </anchored>
  )
}
