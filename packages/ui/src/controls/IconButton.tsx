/**
 * ui/IconButton.tsx — icon-only 按钮（architecture.md §7；settings-ui.md §11
 * 「icon-only 按钮必须有 aria-label」——GPUIX 无 aria 面，等价物 = 强制 label
 * prop，落到 Tooltip 文案 + testId，且键盘 enter/space 可触发）。
 *
 * 默认 24×24、圆角 8（原型第二段 .ibtn/.hbtn → var(--radius)）；hover 底
 * surface + 图标提亮 hoverColor（原型 .ibtn:hover）。danger 变体图标恒红。
 * hitSize 允许桌面紧凑位缩小透明命中盒（图标视觉尺寸仍由 size 独立控制）。
 * GPUIX 无 button 元素：div + onClick + onKeyDown + tabIndex 0。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { Icon, type IconName } from '../display/Icon'
import { Tip } from '../overlays/Tooltip'
import { focusRing } from '../theme/style'
import { COLORS } from '../theme/tokens'

export function IconButton({
  name,
  label,
  size = 13,
  hitSize = 24,
  danger = false,
  disabled = false,
  tooltip = true,
  radius = 8,
  hoverColor,
  onClick,
  testId,
}: {
  name: IconName
  /** 强制：tooltip 文案（aria-label 等价物）；tooltip=false 时不渲染气泡 */
  label: string
  size?: number
  /** 透明命中盒边长；桌面紧凑位可小于默认 24px。 */
  hitSize?: number
  danger?: boolean
  /** V2 圆形 icon-btn（9999）；默认 8（原型 .ibtn/.hbtn → var(--radius)）。 */
  radius?: number
  /** hover 时图标色（原型 .ibtn:hover→textBright；.hbtn:hover 不提亮 →
      传 COLORS.muted；.srow .reset:hover→text 处传 COLORS.text） */
  hoverColor?: string
  disabled?: boolean
  /** 缺省 true。顶栏等贴边位置可关，避免气泡挡住按钮。 */
  tooltip?: boolean
  onClick: () => void
  testId: string
}): ReactElement {
  const [focused, setFocused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const base = disabled ? COLORS.exited : danger ? COLORS.bell : COLORS.muted
  // 原型 .ibtn:hover 图标提亮 textBright；GPUIX svg 色不随父级 hover 变，
  // 需显式换 Icon color（danger 恒红不提亮）
  const color = hovered && !disabled && !danger ? (hoverColor ?? COLORS.textBright) : base

  const button = (
    <div
      testId={testId}
      tabIndex={disabled ? -1 : 0}
      onClick={() => {
        if (!disabled) onClick()
      }}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'enter' || e.key === 'space') onClick()
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: hitSize,
        height: hitSize,
        borderRadius: radius,
        flexShrink: 0,
        cursor: disabled ? 'default' : 'pointer',
        boxShadow: focused ? focusRing() : undefined,
        // 原型 .ibtn:hover / .hbtn:hover：底 surface（非 surfaceHover）
        hover: disabled ? undefined : { backgroundColor: COLORS.surface },
      }}
    >
      <Icon name={name} size={size} color={color} />
    </div>
  )
  return tooltip ? <Tip label={label}>{button}</Tip> : button
}
