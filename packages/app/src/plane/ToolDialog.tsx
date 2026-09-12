/**
 * plane/ToolDialog.tsx — 新建会话弹窗（Phase W7；原型 tool-dialog）。
 *
 * 对齐原型：工作区选择（Select + cwd 展示）→ 工具筛选 → 工具列表
 * （预设 + New Chat + ACP agents + 自定义命令说明）。替代 W2 的
 * ToolMenu anchored 菜单形态（入口不变：工作区行 ＋ / 空组引导 /
 * 起始页「选择其他工具」，全部改为打开本弹窗）。
 *
 * 快捷 pi 直启（起始页 primary）不走本弹窗——原型 quick-tool 同语义。
 */

import { useState } from 'react'

import {
  Icon,
  Modal,
  ModalBody,
  ModalHeading,
  SelectField,
  TextInput,
  COLORS,
  FONT,
} from '@jagent/ui'
import type { AcpAgent } from '../settings/schema'
import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import type { ThreadStore, Workspace } from '../threads/store'

function agentCommandSummary(a: AcpAgent): string {
  return [a.command, ...a.args].filter(Boolean).join(' ')
}

export function ToolDialog({
  store,
  settings,
  workspaces,
  initialWorkspaceId,
  onClose,
}: {
  store: ThreadStore
  settings: SettingsStore
  workspaces: Workspace[]
  /** 打开时的目标工作区（调用方入口自带归属） */
  initialWorkspaceId: string
  onClose: () => void
}) {
  const snap = useSettings(settings)
  // 空串 = 未归属临时会话（会话区＋入口）；select 首项为「（未归属 · 临时会话）」
  // ——不再回退 workspaces[0]，否则临时入口误归属首个工作区（D06）。
  // Chat/ACP 是应用内非终端表面，无工作区上下文时禁用（cwd 无意义）。
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId)
  const [filter, setFilter] = useState('')
  const includeTemp = initialWorkspaceId === ''
  const workspace = workspaces.find((w) => w.id === workspaceId)

  const lower = filter.trim().toLowerCase()
  const hit = (...xs: (string | undefined)[]) =>
    lower === '' || xs.some((x) => x?.toLowerCase().includes(lower))
  const presets = snap.presets.items.filter((p) =>
    hit(p.label, p.program, p.initCommand, ...(p.args ?? [])),
  )
  const acpAgents = snap.acpAgents.filter((a) => hit(a.label, a.command, ...(a.args ?? [])))
  const empty = presets.length === 0 && acpAgents.length === 0

  const pick = (fn: () => void) => () => {
    onClose()
    fn()
  }

  // 分组（原型 option-group-label）：AI 编程 = agent 类预设（initCommand/
  // program 且非 shell）；终端工具 = 其余 + 自定义。分组仅展示层语义。
  const agentPresets = presets.filter((p) => p.id !== 'shell')
  const termPresets = presets.filter((p) => p.id === 'shell')
  const showAgentGroup = presets.some((p) => p.id !== 'shell')

  return (
    // 原型 #tool-dialog：内容自适应高（无固定高；超高时 Modal maxHeight
    // 钳制 + 列表区滚动），width min(92vw,420)
    <Modal width={420} onClose={onClose}>
      <ModalHeading title="新建会话" onClose={onClose} />
      <ModalBody>
        {/* 目标工作区 + cwd（原型 tool-context：48px label 列 + 撑满 select；
            cwd 缩进对齐 select 内容列） */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            marginBottom: 4,
          }}
        >
          {workspaces.length > 1 || includeTemp ? (
            <SelectField
              testId="tool-dialog-workspace"
              value={workspaceId}
              options={[
                ...(includeTemp ? [{ value: '', label: '（未归属 · 临时会话）' }] : []),
                ...workspaces.map((w) => ({ value: w.id, label: w.name })),
              ]}
              onChange={setWorkspaceId}
              width="fill"
            />
          ) : workspace ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                minWidth: 0,
              }}
            >
              <Icon name="folder" size={12} color={COLORS.accent} />
              <text
                style={{
                  fontSize: 12,
                  fontFamily: FONT.ui,
                  color: COLORS.textBright,
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                }}
              >
                {workspace.name}
              </text>
            </div>
          ) : null}
        </div>
        {workspace ? (
          <text
            style={{
              fontSize: 11.5,
              fontFamily: FONT.mono,
              color: COLORS.faint,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              overflow: 'hidden',
            }}
          >
            cwd {workspace.path}
          </text>
        ) : (
          <text
            style={{
              fontSize: 11.5,
              fontFamily: FONT.mono,
              color: COLORS.faint,
            }}
          >
            （无项目目录）
          </text>
        )}

        {/* 筛选（原型 tool-search：全宽，24px 侧距） */}
        <TextInput
          testId="tool-dialog-filter"
          value={filter}
          onChange={setFilter}
          placeholder="搜索工具…"
          width="fill"
        />

        {/* 工具列表（原型 .tool-list：gap 1px 纵向列表） */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flexGrow: 1,
            minHeight: 0,
            overflowY: 'scroll',
            gap: 1,
          }}
        >
          {showAgentGroup ? <GroupLabel label="AI 编程" /> : null}
          {agentPresets.map((p) => (
            <ToolRow
              key={p.id}
              testId={`tool-preset-${p.id}`}
              icon="terminal"
              name={p.label}
              description={p.description}
              command={
                [p.program, ...(p.args ?? [])].filter(Boolean).join(' ') || p.initCommand || ''
              }
              recommended={p.id === 'pi'}
              onPick={pick(() => void store.spawnFromPreset(p.id, workspace?.id))}
            />
          ))}

          {termPresets.length > 0 || !showAgentGroup ? <GroupLabel label="终端工具" /> : null}
          {termPresets.map((p) => (
            <ToolRow
              key={p.id}
              testId={`tool-preset-${p.id}`}
              icon="terminal"
              name={p.label}
              description={p.description}
              command={
                [p.program, ...(p.args ?? [])].filter(Boolean).join(' ') || p.initCommand || ''
              }
              onPick={pick(() => void store.spawnFromPreset(p.id, workspace?.id))}
            />
          ))}

          {/* New Chat + ACP：归「终端工具」组尾（原型自定义命令位 = footer；ACP 是其原生对应物）。
              未归属（无 workspace）时不渲染：chat/acp 是应用内表面，没有可继承的 cwd 上下文 */}
          {workspace ? (
            <ToolRow
              testId="new-chat"
              icon="chat"
              name="New Chat"
              description="应用内对话面（非终端）"
              onPick={pick(() => store.createChat(workspace.id))}
            />
          ) : null}
          {workspace
            ? acpAgents.map((a) => (
                <ToolRow
                  key={a.id}
                  testId={`new-acp-${a.id}`}
                  icon="acp"
                  name={a.label}
                  description="ACP agent"
                  command={agentCommandSummary(a)}
                  onPick={pick(() => store.createAcpThread(a.id, a.label, workspace.id))}
                />
              ))
            : null}

          {empty ? (
            <text
              style={{
                fontSize: 11,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                paddingLeft: 12,
                paddingRight: 12,
                paddingTop: 16,
                paddingBottom: 16,
                textAlign: 'center',
              }}
            >
              没有匹配工具。自定义命令可在设置的 ACP 分区添加。
            </text>
          ) : null}
        </div>
        {/* 底注（原型 .hint：「选一项即创建会话，Esc 取消」） */}
        <text
          style={{
            fontSize: 11.5,
            fontFamily: FONT.ui,
            color: COLORS.faint,
            pointerEvents: 'none',
          }}
        >
          选一项即创建会话，Esc 取消
        </text>
      </ModalBody>
    </Modal>
  )
}

/** 分组标签（原型 .g-lab：11px text-4，padding 8 8 3） */
function GroupLabel({ label }: { label: string }) {
  return (
    <text
      style={{
        fontSize: 11,
        fontFamily: FONT.ui,
        color: COLORS.faint,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 8,
        paddingBottom: 3,
        pointerEvents: 'none',
      }}
    >
      {label}
    </text>
  )
}

/** 工具行（原型 .tool 三列：16 图标 | 名称+描述（minWidth 0）| 右侧命令码。
 *  padding 7 8、radius 6、gap 10；图标统一 16px text-3，hover 抬底） */
function ToolRow({
  testId,
  icon,
  name,
  description,
  command,
  recommended = false,
  onPick,
}: {
  testId: string
  icon: 'terminal' | 'chat' | 'acp'
  name: string
  description?: string
  command?: string
  recommended?: boolean
  onPick: () => void
}) {
  return (
    <div
      tabIndex={0}
      testId={testId}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onPick()
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingTop: 7,
        paddingBottom: 7,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 6,
        cursor: 'pointer',
        color: COLORS.text,
        hover: { backgroundColor: COLORS.surface, color: COLORS.textBright },
      }}
    >
      <div style={{ display: 'flex', width: 16, justifyContent: 'center', flexShrink: 0 }}>
        <Icon name={icon} size={16} color={COLORS.muted} />
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          flexGrow: 1,
          gap: 1,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
          }}
        >
          <text
            style={{
              fontSize: 12,
              fontFamily: FONT.ui,
              color: COLORS.textBright,
              flexShrink: 0,
              pointerEvents: 'none',
            }}
          >
            {name}
          </text>
          {recommended ? (
            <text
              style={{
                fontSize: 10,
                fontFamily: FONT.ui,
                color: COLORS.accent,
                flexShrink: 0,
                pointerEvents: 'none',
              }}
            >
              默认
            </text>
          ) : null}
        </div>
        {description ? (
          <text
            style={{
              fontSize: 11.5,
              fontFamily: FONT.ui,
              color: COLORS.faint,
              whiteSpace: 'normal',
              minWidth: 0,
              pointerEvents: 'none',
            }}
          >
            {description}
          </text>
        ) : null}
      </div>
      {command ? (
        <text
          style={{
            fontSize: 10.5,
            fontFamily: FONT.mono,
            color: COLORS.faint,
            whiteSpace: 'nowrap',
            flexShrink: 0,
            maxWidth: 120,
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {command}
        </text>
      ) : null}
    </div>
  )
}
