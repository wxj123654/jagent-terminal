/**
 * surfaces/listEditorParts.tsx — 结构性列表分区（Presets / ACP Agents）共享
 * 编辑器小件（T3+.1 从 PresetsSection 提取；卡片外壳/错误条/新增行同收此）。
 *
 * FieldRow：label 列（名称 + mono 字段名 + 字段级蓝点）+ 控件。
 * LinesField：行式字段（args 每行一项 / env 每行 KEY=VALUE）——**即时提交**
 * （onChange → parse → store，行级归一在 store 层）+ draft 只管显示；onBlur
 * 仅归一显示。blur 不可依赖：TestGpuixRenderer 路径不派发 React focus/blur
 * 事件（T3.1 实测，T2.6 autoFocus 同源限制）。
 * ModDot：modified 蓝点（原型 .mod-dot）。
 * ListEditorCard：收起 head + 展开编辑器的外壳（冒泡抑制内建）。
 * ListEditorError / ListEditorEmpty / ListEditorAdd：分区级惯用法。
 */

import { useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { Icon, Textarea, COLORS, FONT } from '@jagent/ui'

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
 * 列表编辑器卡片外壳：收起态 head（chevron + label + mono 摘要 + 徽章槽 +
 * 动作钮槽）+ 展开态编辑器槽。Presets/ACP Agents 共用。
 *
 * 冒泡抑制内建：行内按钮 click 会冒到 head 的 onClick（T3.1 实测——子元素
 * 自带 listener 时沿链冒泡，JS 无 stopPropagation 面），actions 经 render
 * prop 拿 suppress()，按钮 handler 先置位、head 查后消费。
 */
export function ListEditorCard({
  testIdPrefix,
  id,
  label,
  summary,
  expanded,
  onToggle,
  badges,
  actions,
  children,
}: {
  /** testId 前缀（'preset' | 'agent'）：card/head/editor 三件套 */
  testIdPrefix: string
  id: string
  label: string
  /** head 行 mono 摘要（命令一行） */
  summary: string
  expanded: boolean
  onToggle: () => void
  /** 摘要右侧徽章区（ModDot/Badge 等），可空 */
  badges?: ReactNode
  /** 行尾动作钮；入参 suppress = 冒泡抑制（先置位再动作） */
  actions?: (suppress: () => void) => ReactNode
  /** 展开态编辑器内容 */
  children?: ReactNode
}): ReactElement {
  const suppressHead = useRef(false)
  const suppress = () => {
    suppressHead.current = true
  }

  return (
    <div
      testId={`${testIdPrefix}-card-${id}`}
      style={{
        borderWidth: 1,
        borderColor: expanded ? COLORS.borderSubtle : COLORS.border,
        borderRadius: 6,
        marginBottom: 8,
        backgroundColor: COLORS.sidebar,
      }}
    >
      {/* head：命中容器（显式 backgroundColor；装饰 pe:none 穿透） */}
      <div
        testId={`${testIdPrefix}-head-${id}`}
        tabIndex={0}
        onClick={() => {
          if (suppressHead.current) {
            suppressHead.current = false
            return
          }
          onToggle()
        }}
        onKeyDown={(e) => {
          if (e.key === 'enter' || e.key === 'space') onToggle()
        }}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 38,
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 12,
          paddingRight: 8,
          borderTopLeftRadius: 6,
          borderTopRightRadius: 6,
          backgroundColor: COLORS.sidebar,
          cursor: 'pointer',
          hover: { backgroundColor: COLORS.surfaceHover },
        }}
      >
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} color={COLORS.muted} />
        <text
          style={{
            fontSize: 13,
            fontFamily: FONT.ui,
            color: COLORS.textBright,
            flexShrink: 0,
            pointerEvents: 'none',
          }}
        >
          {label}
        </text>
        <text
          style={{
            flexGrow: 1,
            minWidth: 0,
            fontSize: 11.5,
            fontFamily: FONT.mono,
            color: COLORS.muted,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {summary}
        </text>
        {badges}
        {actions ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 2,
              flexShrink: 0,
            }}
          >
            {actions(suppress)}
          </div>
        ) : null}
      </div>

      {expanded ? (
        <div
          testId={`${testIdPrefix}-editor-${id}`}
          style={{
            borderTopWidth: 1,
            borderColor: COLORS.border,
            padding: 12,
            paddingLeft: 14,
            paddingBottom: 14,
            backgroundColor: COLORS.app,
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** 分区写错误红条：err.path 命中本分区谓词时显示（回滚已由 store 层完成） */
export function ListEditorError({
  err,
  hit,
}: {
  err: { path: string; message: string } | null
  hit: (path: string) => boolean
}): ReactElement | null {
  if (!err || !hit(err.path)) return null
  return (
    <text
      testId="writeerror"
      style={{ fontSize: 11, fontFamily: FONT.mono, color: COLORS.bell, marginBottom: 6 }}
    >
      {`写入失败：${err.message}`}
    </text>
  )
}

/** 搜索无命中占位行（query 非空且列表过滤为空时由调用方渲染） */
export function ListEditorEmpty({ text }: { text: string }): ReactElement {
  return (
    <text
      testId="settings-empty-hits"
      style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted, padding: 8 }}
    >
      {text}
    </text>
  )
}

/** 「新增」行（原型 .btn-add；click + enter/space 同触发） */
export function ListEditorAdd({
  testId,
  label,
  onAdd,
}: {
  testId: string
  label: string
  onAdd: () => void
}): ReactElement {
  return (
    <div
      testId={testId}
      tabIndex={0}
      onClick={onAdd}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onAdd()
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        height: 30,
        paddingLeft: 12,
        paddingRight: 12,
        marginTop: 2,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 4,
        cursor: 'pointer',
        hover: { borderColor: COLORS.accent, color: COLORS.textBright },
      }}
    >
      <Icon name="plus" size={12} color={COLORS.muted} />
      <text
        style={{
          fontSize: 12.5,
          fontFamily: FONT.ui,
          color: COLORS.muted,
          pointerEvents: 'none',
        }}
      >
        {label}
      </text>
    </div>
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
