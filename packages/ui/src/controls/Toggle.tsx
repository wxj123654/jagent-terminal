/**
 * ui/Toggle.tsx — boolean 开关（architecture.md §7；settings-ui.md §5.2
 * 「boolean → toggle 开关」）。
 *
 * 契约 §11 说「toggle 用真 checkbox（role 正确）」——GPUIX 无 checkbox 元素
 * 与 aria 面，等价物：div + tabIndex 0 + 键盘 space/enter + testId，状态由
 * props.checked 外部可见（不依赖颜色读值）。原型 .switch：34×20 轨道 +
 * 14px knob（GPUIX 无 transform 过渡，left 定位直跳）。
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
  scale = 1,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  testId: string
  /** 原型 transform:scale 的等价物（GPUIX 无 transform——直接缩放几何，
      如 git 工具条 scale(.85)：34×20 → ~29×17） */
  scale?: number
}): ReactElement {
  const [focused, setFocused] = useState(false)
  const w = Math.round(34 * scale * 2) / 2
  const h = Math.round(20 * scale * 2) / 2
  const knob = Math.round(14 * scale * 2) / 2
  const inset = Math.round(3 * scale * 2) / 2

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
        width: w,
        height: h,
        borderRadius: 999,
        flexShrink: 0,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        boxShadow: focused ? focusRing() : undefined,
      }}
    >
      {/* 轨道：关 = 凹陷底 subtle 边；开 = accent 软底 accent 边（原型 checked）。
          pointerEvents none：装饰层不挡 hit-test（GPUIX 事件不冒泡，命中
          deepest 元素——handler 宿主必须是可命中的容器本身） */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          borderRadius: 999,
          backgroundColor: checked ? COLORS.accentSoft : COLORS.inputBg,
          borderWidth: 1,
          borderColor: checked ? COLORS.accent : COLORS.borderSubtle,
          pointerEvents: 'none',
        }}
      />
      {/* knob：14px 圆，左 3 ↔ 左 17（34-14-3）；scale 同步缩放 */}
      <div
        style={{
          position: 'absolute',
          left: checked ? w - knob - inset : inset,
          top: inset,
          width: knob,
          height: knob,
          borderRadius: 999,
          backgroundColor: checked ? COLORS.accent : COLORS.muted,
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
