/**
 * ui/IconButton.tsx — icon-only 按钮（architecture.md §7；settings-ui.md §11
 * 「icon-only 按钮必须有 aria-label」——GPUIX 无 aria 面，等价物 = 强制 label
 * prop，落到 Tooltip 文案 + testId，且键盘 enter/space 可触发）。
 *
 * 默认 24×24、圆角 4；hover 抬底（原型 .icon-btn）；danger 变体 hover 红。
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
  disabled?: boolean
  /** 缺省 true。顶栏等贴边位置可关，避免气泡挡住按钮。 */
  tooltip?: boolean
  onClick: () => void
  testId: string
}): ReactElement {
  const [focused, setFocused] = useState(false)
  const color = disabled ? COLORS.exited : danger ? COLORS.bell : COLORS.muted

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
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: hitSize,
        height: hitSize,
        borderRadius: 4,
        flexShrink: 0,
        cursor: disabled ? 'default' : 'pointer',
        boxShadow: focused ? focusRing() : undefined,
        hover: disabled ? undefined : { backgroundColor: COLORS.surfaceHover },
      }}
    >
      <Icon name={name} size={size} color={color} />
    </div>
  )
  return tooltip ? <Tip label={label}>{button}</Tip> : button
}
