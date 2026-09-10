/**
 * ui/Tooltip.tsx — 提示气泡（architecture.md §7；settings-ui.md §11
 * 「modified 状态 tooltip 说明」）。
 *
 * 薄封装 @gpuix/react 的 shadcn 形态 Tooltip（anchored 定位 + hover/focus
 * 触发 + Esc 关闭已内建），只补 One Dark 深底样式与统一 API：
 * `<Tip label="…">{trigger}</Tip>`，trigger 必须是单个可挂事件的元素。
 */

import { Tooltip as GpuixTooltip, TooltipContent, TooltipTrigger } from '@gpuix/react'
import type { ReactElement, ReactNode } from 'react'

import { COLORS, FONT } from './tokens'

export function Tip({
  label,
  children,
  side = 'top',
  testId,
}: {
  label: ReactNode
  children: ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  testId?: string
}): ReactElement {
  return (
    <GpuixTooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={6}
        testId={testId}
        style={{
          backgroundColor: COLORS.border,
          borderRadius: 4,
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 8,
          paddingRight: 8,
          maxWidth: 260,
        }}
      >
        <text style={{ fontSize: 11, fontFamily: FONT.ui, color: COLORS.textBright }}>{label}</text>
      </TooltipContent>
    </GpuixTooltip>
  )
}
