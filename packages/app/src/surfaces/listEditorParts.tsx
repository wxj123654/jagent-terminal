/**
 * surfaces/listEditorParts.tsx — 结构性列表分区（Presets / ACP Agents）共享
 * 编辑器小件（T3+.1 从 PresetsSection 提取）。
 *
 * FieldRow：label 列（名称 + mono 字段名 + 字段级蓝点）+ 控件。
 * LinesField：行式字段（args 每行一项 / env 每行 KEY=VALUE）——**即时提交**
 * （onChange → parse → store，行级归一在 store 层）+ draft 只管显示；onBlur
 * 仅归一显示。blur 不可依赖：TestGpuixRenderer 路径不派发 React focus/blur
 * 事件（T3.1 实测，T2.6 autoFocus 同源限制）。
 * ModDot：modified 蓝点（原型 .mod-dot）。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { Textarea } from '../ui/Textarea'
import { COLORS, FONT } from '../ui/tokens'

/** 编辑器字段行：label 列（名称 + key + 字段级蓝点）+ 控件 */
export function FieldRow({
  label,
  name,
  modified,
  children,
}: {
  label: string
  /** 字段名 mono 小字（原型 .f-key） */
  name: string
  modified: boolean
  children: ReactElement
}): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', marginBottom: 9 }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          width: 130,
          minWidth: 0,
          flexShrink: 0,
        }}
      >
        <text
          style={{
            fontSize: 12.5,
            fontFamily: FONT.ui,
            color: COLORS.text,
            pointerEvents: 'none',
          }}
        >
          {label}
        </text>
        <text
          style={{
            fontSize: 10.5,
            fontFamily: FONT.mono,
            color: COLORS.muted,
            // 超宽截断（如 InitCommand + initCommand > 130px）：ellipsis 而非
            // 溢出盖到右侧控件上（web 原型里溢出被 input 不透明背景盖住，
            // GPUIX 绘制顺序不同，必须自己截）
            minWidth: 0,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            pointerEvents: 'none',
          }}
        >
          {name}
        </text>
        {modified ? <ModDot /> : null}
      </div>
      {children}
    </div>
  )
}

/** modified 蓝点（原型 .mod-dot；形状区别于颜色——行级徽章旁 + 字段行尾） */
export function ModDot({ testId }: { testId?: string }): ReactElement {
  return (
    <div
      testId={testId}
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        backgroundColor: COLORS.accent,
        flexShrink: 0,
      }}
    />
  )
}

/**
 * 行式字段：即时提交 + draft 只管显示（编辑中间态的尾随换行/空行不回写
 * 受控值，无光标跳动）；onBlur 仅归一显示（draft → committed）。
 */
export function LinesField({
  testId,
  placeholder,
  serialize,
  parse,
  commit,
}: {
  testId: string
  placeholder: string
  /** 当前 store 值 → 规范文本 */
  serialize: () => string
  /** 提交文本 → store 值（行级过滤在 store 层） */
  parse: (text: string) => string[] | Record<string, string>
  /** 即时提交 */
  commit: (parsed: string[] | Record<string, string>) => void
}): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const committed = serialize()

  return (
    <Textarea
      testId={testId}
      value={draft ?? committed}
      placeholder={placeholder}
      minRows={2}
      onChange={(v) => {
        setDraft(v)
        commit(parse(v))
      }}
      onBlur={() => setDraft(null)}
    />
  )
}
