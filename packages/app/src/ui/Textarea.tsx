/**
 * ui/Textarea.tsx — 多行输入（architecture.md §7；settings-ui.md §5.2
 * 「string[] / Record → textarea 行式语法：args 每行一个；env 每行 KEY=VALUE」）。
 * Phase 3 预设编辑器用；值即原始多行文本，行式拆分由消费方做。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { controlBox, controlText } from './style'
import { COLORS } from './tokens'

export function Textarea({
  value,
  placeholder,
  mono = true,
  disabled = false,
  minRows = 3,
  onChange,
  testId,
  width = 220,
}: {
  value: string
  placeholder?: string
  mono?: boolean
  disabled?: boolean
  minRows?: number
  onChange: (next: string) => void
  testId: string
  width?: number
}): ReactElement {
  const [focused, setFocused] = useState(false)

  return (
    <textarea
      testId={testId}
      autoFocus={false}
      value={value}
      placeholder={placeholder}
      readOnly={disabled}
      minRows={minRows}
      onChange={(e) => onChange(e.value ?? '')}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        width,
        paddingTop: 5,
        paddingBottom: 5,
        paddingLeft: 9,
        paddingRight: 9,
        ...controlBox(focused, disabled),
        ...controlText(mono),
        cursor: disabled ? 'default' : 'text',
      }}
    />
  )
}
