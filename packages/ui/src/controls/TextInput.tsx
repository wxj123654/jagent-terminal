/**
 * ui/TextInput.tsx — 字符串输入（architecture.md §7；settings-ui.md §5.2
 * 「字符串 → text input，命令类 mono」）。220×28，受控即时 onChange（即时
 * 生效契约）。GPUIX input 无 disabled prop → readOnly + 压灰。
 *
 * 结构照 gpuix 官方 composer 模式（example-app/app.tsx）：input 本体只承担
 * 文字编辑（flexGrow 填充，无壳样式），视觉壳（高度/边框/背景/圆角/水平
 * padding/focus 环）全放外层 div。原因：native input 的文字元素是 measured
 * 布局、高度恰为一行（line_height），壳样式压在 input 自身上时该行顶对齐在
 * 28px 盒顶 → 文字贴顶；壳外置 + alignItems:'center' 才能垂直居中。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { inputFocus } from '../keyboard'
import { controlText, focusRing } from '../theme/style'
import { COLORS } from '../theme/tokens'

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
  /** 宽度：数字 = 固定 px；'fill' = 撑满容器（弹窗表单） */
  width?: number | 'fill'
}): ReactElement {
  const [focused, setFocused] = useState(false)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        width: width === 'fill' ? '100%' : width,
        height: 28,
        paddingLeft: 9,
        paddingRight: 9,
        borderRadius: 4,
        backgroundColor: COLORS.inputBg,
        borderWidth: 1,
        borderColor: focused ? COLORS.accent : COLORS.borderSubtle,
        boxShadow: focused ? focusRing() : undefined,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'text',
      }}
    >
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
          flexGrow: 1,
          minWidth: 0,
          ...controlText(mono),
        }}
      />
    </div>
  )
}
