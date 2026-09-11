/**
 * ui/SettingRow.tsx — 设置行（architecture.md §7；settings-ui.md §5.1 行结构：
 * 左 label + description（label 后固定 reset 槽），右侧仅放控件）。
 *
 * D7 声明式渲染的展示原子：def 只作类型来源（type-only import，编译期擦除，
 * 运行时零耦合——ui/ 不依赖任何人的运行时依赖不变），值与回调全由上层
 * （SettingsView）注入，自身不碰 store——纯受控组件，测试面干净。
 *
 * 可见性规则（§5.1 + §11 折中）：
 * - modified 蓝点常显（键盘可发现）；
 * - 可用行始终保留 18×18 reset 槽，槽内始终挂载同一个 IconButton：
 *   modified 只切 opacity / pointerEvents / tabIndex，不增删布局节点，因此
 *   恢复图标出现或消失不会推动 label 或右侧控件；
 * - Undo 图标视觉尺寸 10px，modified 时常显且可聚焦（避免 hover-only）；
 * - def.phase 项：控件 disabled + PhaseBadge（§5.3「可见但 disabled」）。
 */

import type { ReactElement } from 'react'

import {
  IconButton,
  NumberInput,
  RangeInput,
  SelectField,
  Textarea,
  TextInput,
  Toggle,
  COLORS,
  FONT,
} from '@jagent/ui'
import type { SettingDef } from '../settings/schema'
import { PhaseBadge } from './PhaseBadge'

export type SettingValue = boolean | string | number

export function SettingRow({
  def,
  value,
  modified,
  onChange,
  onReset,
  highlightQuery,
}: {
  def: SettingDef
  value: SettingValue
  modified: boolean
  onChange: (next: SettingValue) => void
  onReset: () => void
  /** 搜索子串：label/description 高亮（settings-ui.md §9；GPUIX 无 <mark>，
   * 用 highlight wash，原型 amber 底） */
  highlightQuery?: string | null
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
            highlight={
              highlightQuery ? { query: highlightQuery, color: 'rgba(229, 192, 123, 0.28)' } : null
            }
          >
            {def.label}
          </text>
          {/* label 后固定 18px reset 槽：按钮始终挂载，只切可见/交互状态，
              避免 modified 切换时重排。Phase 行本身不可修改，不占槽。 */}
          {!disabled ? (
            <div
              testId={`reset-slot-${def.path}`}
              style={{
                width: 18,
                height: 18,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                opacity: modified ? 1 : 0,
                pointerEvents: modified ? 'auto' : 'none',
              }}
            >
              <IconButton
                name="reset"
                size={10}
                hitSize={18}
                label={`恢复默认：${def.label}`}
                disabled={!modified}
                onClick={onReset}
                testId={modified ? `reset-${def.path}` : `reset-inactive-${def.path}`}
              />
            </div>
          ) : null}
          {def.phase !== undefined ? (
            <PhaseBadge phase={def.phase} testId={`phase-${def.path}`} />
          ) : null}
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
            highlight={
              highlightQuery ? { query: highlightQuery, color: 'rgba(229, 192, 123, 0.28)' } : null
            }
          >
            {def.description}
          </text>
        ) : null}
      </div>

      {/* 右列只放控件；reset 属于设置项状态，放在左侧 label 后。 */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        {control()}
      </div>
    </div>
  )
}
