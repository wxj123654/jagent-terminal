/**
 * ui/SettingRow.tsx — 设置行（architecture.md §7；settings-ui.md §5.1 行结构：
 * 左 label + description，右 控件 + modified 蓝点 + reset）。
 *
 * D7 声明式渲染的展示原子：def 只作类型来源（type-only import，编译期擦除，
 * 运行时零耦合——ui/ 不依赖任何人的运行时依赖不变），值与回调全由上层
 * （SettingsView）注入，自身不碰 store——纯受控组件，测试面干净。
 *
 * 可见性规则（§5.1 + §11 折中）：
 * - modified 蓝点常显（键盘可发现）；
 * - reset 按钮 modified 时始终渲染且 tabIndex 0（GPUIX 无 :focus-within，
 *   hover-only 显隐会伤键盘可达），常态半透明、行 hover 时全显；
 * - def.phase 项：控件 disabled + PhaseBadge（§5.3「可见但 disabled」）。
 */

import type { ReactElement } from 'react'

import type { SettingDef } from '../settings/schema'
import { PhaseBadge } from './PhaseBadge'
import { IconButton } from './IconButton'
import { NumberInput } from './NumberInput'
import { RangeInput } from './RangeInput'
import { SelectField } from './Select'
import { Textarea } from './Textarea'
import { TextInput } from './TextInput'
import { Toggle } from './Toggle'
import { COLORS, FONT } from './tokens'

export type SettingValue = boolean | string | number

export function SettingRow({
  def,
  value,
  modified,
  onChange,
  onReset,
}: {
  def: SettingDef
  value: SettingValue
  modified: boolean
  onChange: (next: SettingValue) => void
  onReset: () => void
}): ReactElement {
  const disabled = def.phase !== undefined
  const c = def.control

  const control = (): ReactElement => {
    switch (c.type) {
      case 'toggle':
        return (
          <Toggle
            checked={value as boolean}
            disabled={disabled}
            onChange={onChange}
            testId={`setting-${def.path}`}
          />
        )
      case 'select':
        return (
          <SelectField
            value={value as string}
            options={c.options}
            disabled={disabled}
            onChange={onChange}
            testId={`setting-${def.path}`}
          />
        )
      case 'number':
        return (
          <NumberInput
            value={value as number}
            min={c.min}
            max={c.max}
            step={c.step ?? 1}
            disabled={disabled}
            onChange={onChange}
            testId={`setting-${def.path}`}
          />
        )
      case 'range':
        return (
          <RangeInput
            value={value as number}
            min={c.min}
            max={c.max}
            step={c.step ?? 1}
            disabled={disabled}
            onChange={onChange}
            testId={`setting-${def.path}`}
          />
        )
      case 'text':
        return (
          <TextInput
            value={value as string}
            mono={c.mono}
            disabled={disabled}
            onChange={onChange}
            testId={`setting-${def.path}`}
          />
        )
      case 'textarea':
        return (
          <Textarea
            value={value as string}
            minRows={c.rows}
            disabled={disabled}
            onChange={onChange}
            testId={`setting-${def.path}`}
          />
        )
    }
  }

  return (
    <div
      testId={`row-${def.path}`}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 20,
        paddingTop: 11,
        paddingBottom: 11,
        paddingLeft: 2,
        paddingRight: 2,
        borderBottomWidth: 1,
        borderColor: COLORS.border,
      }}
    >
      {/* 左列：label（+蓝点+PhaseBadge） / description */}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flexGrow: 1 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          {/* modified 蓝点：常显；未修改 = 空心圈（原型 .mod-dot） */}
          <div
            testId={`moddot-${def.path}`}
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              flexShrink: 0,
              backgroundColor: modified ? COLORS.accent : 'transparent',
              borderWidth: 1,
              borderColor: modified ? COLORS.accent : COLORS.borderSubtle,
            }}
          />
          <text
            style={{
              fontSize: 13,
              fontFamily: FONT.ui,
              color: COLORS.textBright,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {def.label}
          </text>
          {def.phase !== undefined ? <PhaseBadge phase={def.phase} testId={`phase-${def.path}`} /> : null}
        </div>
        {def.description ? (
          <text
            style={{
              marginTop: 3,
              fontSize: 12,
              fontFamily: FONT.ui,
              color: COLORS.muted,
              whiteSpace: 'normal',
              lineHeight: 17,
            }}
          >
            {def.description}
          </text>
        ) : null}
      </div>

      {/* 右列：控件 + reset（modified 时） */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {control()}
        {modified ? (
          <IconButton
            name="reset"
            label={`恢复默认：${def.label}`}
            onClick={onReset}
            testId={`reset-${def.path}`}
          />
        ) : null}
      </div>
    </div>
  )
}
