/**
 * ui/Select.tsx — 枚举下拉（architecture.md §7；settings-ui.md §5.2「枚举 →
 * select 下拉」）。
 *
 * 封装 @gpuix/react 的 shadcn 形态 Select 族（anchored 悬浮层、外点关闭、
 * ↑↓/enter/esc 键盘导航均内建），补 One Dark 样式。命名 SelectField 避免
 * 与上游 Select 混淆。触发器 220×28；菜单项 26 高，highlight 抬底、
 * 选中项 accent 色。
 */

import {
  Select as GpuixSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@gpuix/react'
import { useState } from 'react'
import type { ReactElement } from 'react'

import { Icon } from './Icon'
import { inputFocus } from './keyboard'
import { controlText, focusRing } from './style'
import { COLORS } from './tokens'

export type SelectOption = { value: string; label: string }

export function SelectField({
  value,
  options,
  disabled = false,
  onChange,
  testId,
}: {
  value: string
  options: SelectOption[]
  disabled?: boolean
  onChange: (next: string) => void
  testId: string
}): ReactElement {
  const [focused, setFocused] = useState(false)
  const current = options.find((o) => o.value === value)

  return (
    <GpuixSelect value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        testId={testId}
        onFocus={() => {
          setFocused(true)
          inputFocus.acquire()
        }}
        onBlur={() => {
          setFocused(false)
          inputFocus.release()
        }}
        style={({ open }) => ({
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: 220,
          height: 28,
          paddingLeft: 9,
          paddingRight: 6,
          borderRadius: 4,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          backgroundColor: COLORS.inputBg,
          borderWidth: 1,
          borderColor: open || focused ? COLORS.accent : COLORS.borderSubtle,
          boxShadow: focused && !open ? focusRing() : undefined,
          hover: disabled ? undefined : { borderColor: COLORS.accent },
        })}
      >
        <SelectValue placeholder="—">
          <text
            style={{
              ...controlText(),
              color: disabled ? COLORS.muted : COLORS.textBright,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {current?.label ?? value}
          </text>
        </SelectValue>
        <Icon name="chevronDown" size={13} color={COLORS.muted} />
      </SelectTrigger>

      <SelectContent
        side="bottom"
        sideOffset={4}
        align="start"
        testId={`${testId}-menu`}
        style={{
          minWidth: 220,
          paddingTop: 4,
          paddingBottom: 4,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: COLORS.borderSubtle,
        }}
      >
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value}
            testId={`${testId}-item-${o.value}`}
            style={({ selected, highlighted }) => ({
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              height: 26,
              paddingLeft: 10,
              paddingRight: 10,
              borderRadius: 4,
              ...controlText(),
              color: selected ? COLORS.accent : COLORS.text,
              backgroundColor: highlighted ? COLORS.surfaceHover : 'transparent',
            })}
          >
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </GpuixSelect>
  )
}
