/**
 * settings/ui/AcpAgentsSection.tsx — 设置 ACP Agents 分区（settings-ui.md §6
 * acpAgents；T3+.1 实装，占位卡下岗）。
 *
 * 结构同 Presets 分区（列表 CRUD），但无 builtin/modified 概念——默认 2 项
 * （codex --acp / claude-code-acp）也只是可删改的示例（preset 的「内置」是
 * 工厂数据，agent 的「默认」是建议）。行收起态：label + mono 命令摘要 +
 * 删除钮；展开态三字段编辑器（label / command / args）。
 *
 * 规则单点在 settings/store.ts（addAcpAgent/updateAcpAgent/deleteAcpAgent）；
 * 本文件纯展示层。凭证走 shell 环境（§15 第 11 条：无 API key 输入框）。
 * writeError：path === 'acpAgents' → 分区顶部红条（回滚已由 store 层完成）。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { IconButton, TextInput, COLORS, FONT } from '@jagent/ui'
import { acpAgentCommandSummary, type AcpAgent } from '../schema'
import type { SettingsStore } from '../store'
import { useSettings } from '../useSettings'
import {
  FieldRow,
  LinesField,
  ListEditorAdd,
  ListEditorCard,
  ListEditorEmpty,
  ListEditorError,
} from './listEditorParts'

/** 搜索命中（label / command / args 子串，不区分大小写） */
export function acpAgentMatches(a: AcpAgent, q: string): boolean {
  const lower = q.toLowerCase()
  return (
    a.label.toLowerCase().includes(lower) ||
    a.command.toLowerCase().includes(lower) ||
    a.args.some((x) => x.toLowerCase().includes(lower))
  )
}

export function AcpAgentsSection({
  settings,
  query,
}: {
  settings: SettingsStore
  /** 搜索子串（行级过滤；null = 不过滤） */
  query: string | null
}): ReactElement {
  const snap = useSettings(settings)
  const agents = snap.acpAgents
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const err = settings.writeError()

  const visible = query ? agents.filter((a) => acpAgentMatches(a, query)) : agents

  return (
    // minWidth 0：覆盖 flex item 的 min-width:auto，否则描述 text 的
    // max-content 会把整条 column 链撑宽（卡片/按钮超出 content 右缘被裁），
    // text 自身也拿不到确定宽而不 wrap
    <div style={{ minWidth: 0 }}>
      <text
        style={{
          fontSize: 11.5,
          fontFamily: FONT.ui,
          color: COLORS.muted,
          lineHeight: 16,
          marginBottom: 8,
          whiteSpace: 'normal',
          pointerEvents: 'none',
        }}
      >
        ACP（Agent Client Protocol）JSON-RPC 子进程：每个 agent 作为独立会话线程运行， 凭证走 shell
        环境——此处不出现 API key 输入框。
      </text>

      <ListEditorError err={err} hit={(p) => p === 'acpAgents'} />

      {visible.length === 0 && query ? (
        <ListEditorEmpty text="无匹配 agent" />
      ) : (
        visible.map((a) => (
          <AgentCard
            key={a.id}
            a={a}
            settings={settings}
            expanded={expandedId === a.id}
            onToggle={() => setExpandedId(expandedId === a.id ? null : a.id)}
            onDeleted={() => setExpandedId(null)}
          />
        ))
      )}

      <ListEditorAdd
        testId="add-acp-agent"
        label="新增 Agent"
        onAdd={() => setExpandedId(settings.addAcpAgent({ label: `Agent ${agents.length + 1}` }))}
      />
    </div>
  )
}

// ── agent 卡（收起态 head + 可选展开编辑器）────────────────────────

function AgentCard({
  a,
  settings,
  expanded,
  onToggle,
  onDeleted,
}: {
  a: AcpAgent
  settings: SettingsStore
  expanded: boolean
  onToggle: () => void
  onDeleted: () => void
}): ReactElement {
  return (
    <ListEditorCard
      testIdPrefix="agent"
      id={a.id}
      label={a.label}
      summary={acpAgentCommandSummary(a)}
      expanded={expanded}
      onToggle={onToggle}
      actions={(suppress) => (
        <IconButton
          name="trash"
          danger
          label={`删除 agent ${a.label}`}
          testId={`agent-delete-${a.id}`}
          onClick={() => {
            suppress()
            settings.deleteAcpAgent(a.id)
            onDeleted()
          }}
        />
      )}
    >
      <AgentEditor a={a} settings={settings} />
    </ListEditorCard>
  )
}

/** 展开态编辑器：label / command / args（无 cwd——会话 cwd 恒为项目根） */
function AgentEditor({ a, settings }: { a: AcpAgent; settings: SettingsStore }): ReactElement {
  const update = (patch: Parameters<SettingsStore['updateAcpAgent']>[1]) =>
    settings.updateAcpAgent(a.id, patch)

  return (
    <div>
      <FieldRow label="Label" name="label" modified={false}>
        <TextInput
          testId={`agent-field-label-${a.id}`}
          value={a.label}
          placeholder="显示名"
          onChange={(v) => update({ label: v })}
        />
      </FieldRow>
      <FieldRow label="Command" name="command" modified={false}>
        <TextInput
          testId={`agent-field-command-${a.id}`}
          mono
          value={a.command}
          placeholder="可执行文件名或绝对路径，如 codex / claude-code-acp"
          onChange={(v) => update({ command: v })}
        />
      </FieldRow>
      <FieldRow label="Args" name="args[]" modified={false}>
        <LinesField
          testId={`agent-field-args-${a.id}`}
          placeholder="每行一个参数，如 --acp"
          serialize={() => a.args.join('\n')}
          parse={(text) => text.split('\n')}
          commit={(v) => update({ args: v as string[] })}
        />
      </FieldRow>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 6, marginTop: 10 }}>
        <text style={{ fontSize: 11.5, fontFamily: FONT.ui, color: COLORS.muted, lineHeight: 16 }}>
          会话工作目录 = 项目根；agent 通过 shell 环境读取凭证。存量线程不追配置变更（新线程生效）。
        </text>
      </div>
    </div>
  )
}
