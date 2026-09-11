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
 * 定位：本期只做 `position={{ x, y }}`（Git 右键 / 绝对坐标场景）。相对
 * 触发器的 side/align 留给后续。
 */

import type { StyleDesc } from '@gpuix/react'
import type { ReactNode } from 'react'

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
  onClose,
  children,
  style,
  minWidth = 220,
  testId = 'popover',
  anchor = 'topLeft',
}: {
  /** 浮层左上角（或 `anchor` 指定角）的窗口坐标 */
  position: { x: number; y: number }
  /** 点外部 / Esc → 关闭（调用方通常 setOpen(false)） */
  onClose: () => void
  children: ReactNode
  /** 覆盖默认 One Dark 壳样式 */
  style?: StyleDesc
  /** 默认最小宽（anchored 宽 = 内容宽，需钳制） */
  minWidth?: number
  testId?: string
  /** position 锚在浮层哪一角；默认 topLeft = 坐标即左上角 */
  anchor?: PopoverAnchor
}) {
  return (
    <anchored position={position} anchor={anchor} deferred occlude>
      {/*
        onMouseDownOutside 挂内层内容盒（对齐 gpuix events.test anchored
        dialog）：外点命中以内容 bounds 为准，不挂在 <anchored> 自定义元
        素上——后者的 hit 盒在 deferred 布局下偶发偏大。
      */}
      <div
        testId={testId}
        tabIndex={0}
        onMouseDownOutside={onClose}
        onKeyDown={(e) => {
          if (e.key === 'escape') onClose()
        }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth,
          backgroundColor: COLORS.inputBg,
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
