/**
 * ui/NumberInput.tsx — 数值输入（architecture.md §7；settings-ui.md §5.2
 * 「宽范围数值 → number stepper」）。
 *
 * GPUIX input 是纯文本编辑器（无 number 类型/原生 stepper）：文本框 + 右侧
 * ↑↓ 步进钮 + ↑↓ 键步进自绘。输入即时解析：合法（且在 min/max 内）立即
 * onChange（即时生效契约）；中间态（空串/越界）只留 draft 不回调，失焦回显
 * 最后生效值——既不丢打字过程，也不产生假 modified。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { Icon } from './Icon'
import { inputFocus } from './keyboard'
import { controlText } from './style'
import { COLORS } from './tokens'

export function NumberInput({
  value,
  min,
  max,
  step = 1,
  disabled = false,
  onChange,
  testId,
}: {
  value: number
  min: number
  max: number
  step?: number
  disabled?: boolean
  onChange: (next: number) => void
  testId: string
}): ReactElement {
  // null = 未在编辑，回显 props.value（受控）
  const [draft, setDraft] = useState<string | null>(null)

  const clamp = (n: number) => Math.min(max, Math.max(min, n))

  const applyDraft = (raw: string) => {
    setDraft(raw)
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed >= min && parsed <= max && parsed !== value) {
      onChange(parsed)
    }
  }

  const nudge = (dir: 1 | -1) => {
    if (disabled) return
    const next = clamp(value + dir * step)
    if (next !== value) onChange(next)
    setDraft(null)
  }

  return (
    <div
      testId={testId}
      style={{
        display: 'flex',
        flexDirection: 'row',
        // 一行文字的 input 垂直居中（native input 文字元素是 measured 一行高，
        // stretch 会把它顶在盒顶 → 文字贴顶；同 TextInput/gpuix 官方 composer）
        alignItems: 'center',
        width: 220,
        height: 28,
        borderRadius: 4,
        backgroundColor: COLORS.inputBg,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'text',
      }}
    >
      <input
        testId={`${testId}-input`}
        autoFocus={false}
        value={draft ?? String(value)}
        readOnly={disabled}
        onChange={(e) => applyDraft(e.value ?? '')}
        onFocus={() => inputFocus.acquire()}
        onBlur={() => {
          setDraft(null)
          inputFocus.release()
        }}
        onKeyDown={(e) => {
          if (e.key === 'up') nudge(1)
          else if (e.key === 'down') nudge(-1)
        }}
        style={{
          flexGrow: 1,
          minWidth: 0,
          paddingLeft: 9,
          paddingRight: 4,
          ...controlText(),
        }}
      />
      {/* 步进钮列：↑/↓，各 22×~13；alignSelf stretch 铺满壳高（外层改 center 后需显式声明） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: 22,
          alignSelf: 'stretch',
          flexShrink: 0,
        }}
      >
        <StepperButton
          testId={`${testId}-inc`}
          icon="chevronUp"
          disabled={disabled}
          onClick={() => nudge(1)}
        />
        <StepperButton
          testId={`${testId}-dec`}
          icon="chevronDown"
          disabled={disabled}
          onClick={() => nudge(-1)}
        />
      </div>
    </div>
  )
}

function StepperButton({
  icon,
  disabled,
  onClick,
  testId,
}: {
  icon: 'chevronUp' | 'chevronDown'
  disabled: boolean
  onClick: () => void
  testId: string
}): ReactElement {
  return (
    <div
      testId={testId}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexGrow: 1,
        flexShrink: 0,
        cursor: disabled ? 'default' : 'pointer',
        hover: disabled ? undefined : { backgroundColor: COLORS.surfaceHover },
      }}
      onClick={() => {
        if (!disabled) onClick()
      }}
    >
      <Icon name={icon} size={10} color={COLORS.muted} />
    </div>
  )
}
