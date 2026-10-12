/**
 * ui/Select.tsx — 枚举下拉（architecture.md §7；settings-ui.md §5.2「枚举 →
 * select 下拉」）。
 *
 * 封装 @gpuix/react 的 shadcn 形态 Select 族（anchored 悬浮层、外点关闭、
 * ↑↓/enter/esc 键盘导航均内建），补 One Dark 样式。命名 SelectField 避免
 * 与上游 Select 混淆。触发器默认内容自适应（原型 .sel-trig min-width 120）；
 * 菜单项 min-h30 r6（原型第二段生效值），highlight 抬底、选中项 accent 色。
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

import { Icon } from '../display/Icon'
import { inputFocus, keyConsumed } from '../keyboard'
import { controlText, focusRing } from '../theme/style'
import { COLORS } from '../theme/tokens'

export type SelectOption = { value: string; label: string }

export function SelectField({
  value,
  options,
  disabled = false,
  onChange,
  testId,
  width = 'auto',
  bare = false,
}: {
  value: string
  options: SelectOption[]
  disabled?: boolean
  onChange: (next: string) => void
  testId: string
  /** 宽度：数字 = 固定 px；'fill' = 撑满容器（弹窗表单）；'auto' = 内容宽（min-width 120，原型 .sel-trig） */
  width?: number | 'fill' | 'auto'
  /** 裸触发器（原型 .tool-ctx select：无壳无底无边，嵌在自带壳的行内） */
  bare?: boolean
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
          gap: 8,
          ...(width === 'fill'
            ? { width: '100%' as const }
            : width === 'auto'
              ? { minWidth: 120 }
              : { width }),
          height: bare ? 24 : 30,
          paddingLeft: bare ? 0 : 10,
          // 原型 .sel-trig padding 0 26px 0 10px——右侧 26px 是 chevron 保留区
          paddingRight: bare ? 0 : 26,
          borderRadius: 8,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          backgroundColor: bare ? 'transparent' : COLORS.inputBg,
          borderWidth: bare ? 0 : 1,
          borderColor: open || focused ? COLORS.focusBorder : COLORS.borderSubtle,
          boxShadow: focused && !open && !bare ? focusRing() : undefined,
          hover: disabled || bare ? undefined : { borderColor: COLORS.focusBorder },
        })}
      >
        <SelectValue placeholder="—">
          <text
            style={{
              ...controlText(),
              // 原型 .sel-trig 是 <button> → 吃全局 button{font-weight:500}
              fontWeight: '500',
              color: disabled ? COLORS.muted : COLORS.textBright,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {current?.label ?? value}
          </text>
        </SelectValue>
        <Icon name="chevronDown" size={12} color={COLORS.muted} />
      </SelectTrigger>

      <SelectContent
        side="bottom"
        sideOffset={4}
        align="start"
        testId={`${testId}-menu`}
        // Esc 关弹层已消费（内建随后跑）——置标记防 root 键位层连坐（R11）
        onEscapeKeyDown={() => keyConsumed.mark()}
        style={{
          minWidth: 140,
          // 原型 .sel-pop 第二段：padding 4 四边 + overlay 底（缺
          // backgroundColor 会落到 FloatingLayer/anchored 的 #1A1A1A 兜底）
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 4,
          paddingRight: 4,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: COLORS.borderSubtle,
          backgroundColor: COLORS.overlay,
          boxShadow: {
            offsetX: 0,
            offsetY: 14,
            blurRadius: 38,
            spreadRadius: 0,
            color: 'rgba(0,0,0,0.5)',
          },
        }}
      >
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value}
            testId={`${testId}-item-${o.value}`}
            style={({ highlighted }) => ({
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              // 原型 .sel-item 第二段生效值：min-height 30 / r6
              minHeight: 30,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 6,
              backgroundColor: highlighted ? COLORS.surface : 'transparent',
            })}
          >
            {({ selected }) => (
              <>
                <div
                  style={{
                    width: 14,
                    flexShrink: 0,
                    display: 'flex',
                    color: COLORS.accent,
                    pointerEvents: 'none',
                  }}
                >
                  {selected ? <Icon name="check" size={12} /> : null}
                </div>
                <text style={{ ...controlText(), color: COLORS.text, pointerEvents: 'none' }}>
                  {o.label}
                </text>
              </>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </GpuixSelect>
  )
}
