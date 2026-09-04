/**
 * ui/IconButton.tsx — icon-only 按钮（architecture.md §7；settings-ui.md §11
 * 「icon-only 按钮必须有 aria-label」——GPUIX 无 aria 面，等价物 = 强制 label
 * prop，落到 Tooltip 文案 + testId，且键盘 enter/space 可触发）。
 *
 * 24×24、圆角 4；hover 抬底（原型 .icon-btn）；danger 变体 hover 红。
 * GPUIX 无 button 元素：div + onClick + onKeyDown + tabIndex 0。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { Icon, type IconName } from './Icon'
import { focusRing } from './style'
import { COLORS } from './tokens'
import { Tip } from './Tooltip'

export function IconButton({
  name,
  label,
  size = 13,
  danger = false,
  disabled = false,
  onClick,
  testId,
}: {
  name: IconName
  /** 强制：tooltip 文案（aria-label 等价物） */
  label: string
  size?: number
  danger?: boolean
  disabled?: boolean
  onClick: () => void
  testId: string
}): ReactElement {
  const [focused, setFocused] = useState(false)
  const color = disabled ? COLORS.exited : danger ? COLORS.bell : COLORS.muted

  return (
    <Tip label={label}>
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
          width: 24,
          height: 24,
          borderRadius: 4,
          flexShrink: 0,
          cursor: disabled ? 'default' : 'pointer',
          boxShadow: focused ? focusRing() : undefined,
          hover: disabled ? undefined : { backgroundColor: COLORS.surfaceHover },
        }}
      >
        <Icon name={name} size={size} color={color} />
      </div>
    </Tip>
  )
}
