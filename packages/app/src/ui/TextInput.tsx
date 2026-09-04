/**
 * ui/TextInput.tsx — 字符串输入（architecture.md §7；settings-ui.md §5.2
 * 「字符串 → text input，命令类 mono」）。220×28，受控即时 onChange（即时
 * 生效契约）。GPUIX input 无 disabled prop → readOnly + 压灰。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { inputFocus } from './keyboard'
import { controlBox, controlText } from './style'

export function TextInput({
  value,
  placeholder,
  mono = false,
  disabled = false,
  onChange,
  onSubmit,
  testId,
  width = 220,
}: {
  value: string
  placeholder?: string
  mono?: boolean
  disabled?: boolean
  onChange: (next: string) => void
  /** enter 提交（命令类输入） */
  onSubmit?: (next: string) => void
  testId: string
  width?: number
}): ReactElement {
  const [focused, setFocused] = useState(false)

  return (
    <input
      testId={testId}
      autoFocus={false}
      value={value}
      placeholder={placeholder}
      readOnly={disabled}
      onChange={(e) => onChange(e.value ?? '')}
      onKeyDown={(e) => {
        if (e.key === 'enter') onSubmit?.(value)
      }}
      onFocus={() => {
        setFocused(true)
        inputFocus.acquire()
      }}
      onBlur={() => {
        setFocused(false)
        inputFocus.release()
      }}
      style={{
        width,
        height: 28,
        paddingLeft: 9,
        paddingRight: 9,
        ...controlBox(focused, disabled),
        ...controlText(mono),
        cursor: disabled ? 'default' : 'text',
      }}
    />
  )
}
