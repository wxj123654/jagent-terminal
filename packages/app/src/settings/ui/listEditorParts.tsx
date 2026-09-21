/**
 * settings/ui/listEditorParts.tsx — 结构性列表分区（Presets / ACP Agents）共享
 * 编辑器小件（T3+.1 从 PresetsSection 提取；卡片外壳/错误条/新增行同收此）。
 *
 * FieldRow：原型 .field-row——96px label 列（+字段级蓝点）+ flex:1 控件列。
 * LinesField：行式字段（args 每行一项 / env 每行 KEY=VALUE）——**即时提交**
 * （onChange → parse → store，行级归一在 store 层）+ draft 只管显示；onBlur
 * 仅归一显示。blur 不可依赖：TestGpuixRenderer 路径不派发 React focus/blur
 * 事件（T3.1 实测，T2.6 autoFocus 同源限制）。
 * ModDot：modified 蓝点（原型 .moddot）。
 * ListEditorCard：原型 .le-card/.le-head/.le-body（收起 head + 展开编辑器，
 * 冒泡抑制内建；行尾动作 hover 显隐走 mouseEnter/Leave 态）。
 * HeadBadge / MiniButton：原型 .le-head .bdg / .mini-btn。
 * ListEditorError / ListEditorEmpty / ListEditorAdd：分区级惯用法。
 */

import { useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { Icon, Textarea, COLORS, FONT } from '@jagent/ui'
import type { IconName } from '@jagent/ui'

/** 编辑器字段行（原型 .field-row：96px muted label 列 + flex:1 控件列） */
export function FieldRow({
  label,
  modified,
  children,
}: {
  label: string
  /** 字段级 modified 蓝点（label 后；原型 .moddot 借用） */
  modified: boolean
  children: ReactElement
}): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        marginTop: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
          width: 96,
          paddingTop: 5,
          minWidth: 0,
          flexShrink: 0,
        }}
      >
        <text
          style={{
            fontSize: 11.5,
            fontFamily: FONT.ui,
            color: COLORS.muted,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            minWidth: 0,
            pointerEvents: 'none',
          }}
        >
          {label}
        </text>
        {modified ? <ModDot /> : null}
      </div>
      {/* fc：flex:1 + minWidth 0（长 placeholder/值不撑破卡片右缘） */}
      <div style={{ flexGrow: 1, minWidth: 0, display: 'flex' }}>{children}</div>
    </div>
  )
}

/** modified 蓝点（原型 .moddot；6px accent 实点，只在 modified 时挂载） */
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

/** 原型 .le-head .bdg：10px muted 细边小方签（内置/自定义/ACP） */
export function HeadBadge({ text, testId }: { text: string; testId?: string }): ReactElement {
  return (
    <div
      testId={testId}
      style={{
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 5,
        paddingRight: 5,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 3,
        flexShrink: 0,
        pointerEvents: 'none',
      }}
    >
      <text
        style={{
          fontSize: 10,
          fontFamily: FONT.ui,
          color: COLORS.muted,
          pointerEvents: 'none',
        }}
      >
        {text}
      </text>
    </div>
  )
}

/**
 * 原型 .mini-btn：22px 高小按钮（icon 12 + 可选文字），muted；hover surface +
 * text；danger hover bell。行内动作与 kb「恢复」共用。
 */
export function MiniButton({
  icon,
  text,
  danger = false,
  onClick,
  testId,
}: {
  icon: IconName
  /** 可省（纯图标钮）；原型 kb-row「↺ 恢复」用 icon+text */
  text?: string
  danger?: boolean
  onClick: () => void
  testId: string
}): ReactElement {
  const [hovered, setHovered] = useState(false)
  const color = hovered ? (danger ? COLORS.bell : COLORS.text) : COLORS.muted
  return (
    <div
      testId={testId}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onClick()
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        height: 22,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 5,
        cursor: 'pointer',
        flexShrink: 0,
        backgroundColor: hovered ? COLORS.surface : 'transparent',
      }}
    >
      <Icon name={icon} size={12} color={color} />
      {text ? (
        <text style={{ fontSize: 11, fontFamily: FONT.ui, color, pointerEvents: 'none' }}>
          {text}
        </text>
      ) : null}
    </div>
  )
}

/**
 * 列表编辑器卡片外壳（原型 .le-card：inputBg 底 + subtle 边 + r8 + margin
 * 10/12）：收起态 head（chevron + label + mono 摘要 + 徽章槽 + 动作钮槽）+
 * 展开态编辑器槽。Presets/ACP Agents 共用。
 *
 * 冒泡抑制内建：行内按钮 click 会冒到 head 的 onClick（T3.1 实测——子元素
 * 自带 listener 时沿链冒泡，JS 无 stopPropagation 面），actions 经 render
 * prop 拿 suppress()，按钮 handler 先置位、head 查后消费。
 * 动作显隐（原型 .le-head:hover .acts）：GPUIX 无后代选择器，head 挂
 * onMouseEnter/Leave 翻本地态切 acts 透明度。
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
  /** 摘要右侧徽章区（ModDot/HeadBadge 等），可空 */
  badges?: ReactNode
  /** 行尾动作钮；入参 suppress = 冒泡抑制（先置位再动作） */
  actions?: (suppress: () => void) => ReactNode
  /** 展开态编辑器内容 */
  children?: ReactNode
}): ReactElement {
  const suppressHead = useRef(false)
  const [headHover, setHeadHover] = useState(false)
  const suppress = () => {
    suppressHead.current = true
  }

  return (
    <div
      testId={`${testIdPrefix}-card-${id}`}
      style={{
        marginTop: 10,
        marginBottom: 10,
        marginLeft: 12,
        marginRight: 12,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 8,
        backgroundColor: COLORS.inputBg,
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
        onMouseEnter={() => setHeadHover(true)}
        onMouseLeave={() => setHeadHover(false)}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          height: 44,
          paddingLeft: 10,
          paddingRight: 10,
          borderRadius: 8,
          backgroundColor: COLORS.inputBg,
          cursor: 'pointer',
          hover: { backgroundColor: COLORS.surface },
        }}
      >
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} color={COLORS.faint} />
        <text
          style={{
            fontSize: 12.5,
            fontWeight: 500,
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
            fontSize: 11,
            fontFamily: FONT.mono,
            color: COLORS.faint,
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
              // 原型 .le-head .acts{opacity:0} + :hover 显示（不可见仍可点，
              // CSS opacity 不摘命中——此处同语义）
              opacity: headHover || expanded ? 1 : 0,
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
            paddingTop: 4,
            paddingBottom: 12,
            paddingLeft: 12,
            paddingRight: 12,
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

/** 原型 .le-empty：搜索无命中占位（query 非空且列表过滤为空时由调用方渲染） */
export function ListEditorEmpty({ text }: { text: string }): ReactElement {
  return (
    <div
      testId="settings-empty-hits"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 14,
      }}
    >
      <text
        style={{
          fontSize: 12,
          fontFamily: FONT.ui,
          color: COLORS.muted,
          pointerEvents: 'none',
        }}
      >
        {text}
      </text>
    </div>
  )
}

/** 「新增」行（原型 .le-add：32px 虚线框居中；GPUIX 无 dashed 边框，实线近似） */
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
        justifyContent: 'center',
        gap: 6,
        height: 32,
        marginTop: 12,
        marginBottom: 12,
        marginLeft: 12,
        marginRight: 12,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 8,
        cursor: 'pointer',
        hover: { backgroundColor: COLORS.surface },
      }}
    >
      <Icon name="plus" size={12} color={COLORS.muted} />
      <text
        style={{
          fontSize: 12,
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
      width="fill"
      onChange={(v) => {
        setDraft(v)
        commit(parse(v))
      }}
      onBlur={() => setDraft(null)}
    />
  )
}
