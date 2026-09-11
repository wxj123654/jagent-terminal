/**
 * ui/Textarea.tsx — 多行输入（architecture.md §7；settings-ui.md §5.2
 * 「string[] / Record → textarea 行式语法：args 每行一个；env 每行 KEY=VALUE」）。
 * 预设编辑器 args/env 用；值即原始多行文本，行式拆分由消费方做。
 * T3.1：透传 onBlur（行式字段的 draft 提交点，NumberInput 同款中间态纪律）。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { inputFocus } from '../keyboard'
import { controlBox, controlText } from '../theme/style'

export function Textarea({
  value,
  placeholder,
  mono = true,
  disabled = false,
  minRows = 3,
  onChange,
  onBlur,
  testId,
  width = 220,
}: {
  value: string
  placeholder?: string
  mono?: boolean
  disabled?: boolean
  minRows?: number
  onChange: (next: string) => void
  /** 失焦回调（draft 提交点；内部 inputFocus 登记仍执行） */
  onBlur?: () => void
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
      onFocus={() => {
        setFocused(true)
        inputFocus.acquire()
      }}
      onBlur={() => {
        setFocused(false)
        inputFocus.release()
        onBlur?.()
      }}
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
