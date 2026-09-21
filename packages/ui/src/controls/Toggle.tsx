/**
 * ui/Toggle.tsx — boolean 开关（architecture.md §7；settings-ui.md §5.2
 * 「boolean → toggle 开关」）。
 *
 * 契约 §11 说「toggle 用真 checkbox（role 正确）」——GPUIX 无 checkbox 元素
 * 与 aria 面，等价物：div + tabIndex 0 + 键盘 space/enter + testId，状态由
 * props.checked 外部可见（不依赖颜色读值）。原型 .toggle（第二段覆盖）：
 * 34×20 轨道 + 16px knob（关=surfaceHover 轨 + faint 钮；开=accent 轨 +
 * #fff 钮；GPUIX 无 transform 过渡，left 定位直跳）。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { focusRing } from '../theme/style'
import { COLORS } from '../theme/tokens'

export function Toggle({
  checked,
  disabled = false,
  onChange,
  testId,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  testId: string
}): ReactElement {
  const [focused, setFocused] = useState(false)

  const toggle = () => {
    if (!disabled) onChange(!checked)
  }

  return (
    <div
      testId={testId}
      tabIndex={disabled ? -1 : 0}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === 'space' || e.key === 'enter') toggle()
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        position: 'relative',
        width: 34,
        height: 20,
        borderRadius: 999,
        flexShrink: 0,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        boxShadow: focused ? focusRing() : undefined,
      }}
    >
      {/* 轨道：关 = surfaceHover 实底；开 = accent 实底（原型 .toggle/.on，
          无边框）。pointerEvents none：装饰层不挡 hit-test（GPUIX 事件不冒泡，
          命中 deepest 元素——handler 宿主必须是可命中的容器本身） */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          borderRadius: 999,
          backgroundColor: checked ? COLORS.accent : COLORS.surfaceHover,
          pointerEvents: 'none',
        }}
      />
      {/* knob：16px 圆，左 2 ↔ 左 16（34-16-2）；关 faint / 开 #fff */}
      <div
        style={{
          position: 'absolute',
          left: checked ? 16 : 2,
          top: 2,
          width: 16,
          height: 16,
          borderRadius: 999,
          backgroundColor: checked ? '#ffffff' : COLORS.faint,
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
