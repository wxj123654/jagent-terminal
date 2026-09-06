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

import type { AcpAgent } from '../settings/schema'
import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import type { ThreadStore, Workspace } from '../threads/store'
import { Icon } from '../ui/Icon'
import { Modal, ModalBody, ModalHeading } from '../ui/Modal'
import { SelectField } from '../ui/Select'
import { TextInput } from '../ui/TextInput'
import { COLORS, FONT } from '../ui/tokens'

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
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId)
  const [filter, setFilter] = useState('')
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0]

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

  const rowStyle = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 8,
    paddingRight: 8,
    borderRadius: 4,
    cursor: 'pointer',
    hover: { backgroundColor: COLORS.surface },
  } as const

  return (
    <Modal width={440} onClose={onClose}>
      <ModalHeading title="新建会话" onClose={onClose} />
      <ModalBody>
        {/* 目标工作区 + cwd（原型契约：菜单明确展示目标工作区与 cwd） */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
          {workspaces.length > 1 ? (
            <SelectField
              testId="tool-dialog-workspace"
              value={workspace?.id ?? ''}
              options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
              onChange={setWorkspaceId}
            />
          ) : null}
          {workspace ? (
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Icon name="folder" size={11} color={COLORS.accent} />
              <text
                style={{
                  fontSize: 10,
                  fontFamily: FONT.mono,
                  color: COLORS.muted,
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                }}
              >
                cwd {workspace.path}
              </text>
            </div>
          ) : null}
        </div>

        {/* 筛选 */}
        <div style={{ marginBottom: 8 }} testId="tool-dialog-filter-row">
          <TextInput
            testId="tool-dialog-filter"
            value={filter}
            onChange={setFilter}
            placeholder="搜索工具…"
          />
        </div>

        {/* 工具列表（滚动区） */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            overflowY: 'scroll',
            minHeight: 120,
            maxHeight: 260,
          }}
        >
          {presets.map((p) => (
            <div
              key={p.id}
              tabIndex={0}
              testId={`tool-preset-${p.id}`}
              onClick={pick(() => void store.spawnFromPreset(p.id, workspace?.id))}
              style={{ ...rowStyle, height: 30 }}
            >
              <Icon name="terminal" size={12} color={COLORS.terminalKind} />
              <text
                style={{
                  fontSize: 12,
                  fontFamily: FONT.ui,
                  color: COLORS.text,
                  flexShrink: 0,
                  pointerEvents: 'none',
                }}
              >
                {p.label}
              </text>
              <text
                style={{
                  fontSize: 10,
                  fontFamily: FONT.mono,
                  color: COLORS.muted,
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                  pointerEvents: 'none',
                }}
              >
                {[p.program, ...(p.args ?? [])].filter(Boolean).join(' ') || p.initCommand || ''}
              </text>
            </div>
          ))}

          {!empty ? (
            <div
              style={{
                height: 1,
                backgroundColor: COLORS.borderSubtle,
                marginTop: 4,
                marginBottom: 4,
              }}
            />
          ) : null}

          <div
            tabIndex={0}
            testId="new-chat"
            onClick={pick(() => workspace && store.createChat(workspace.id))}
            style={{ ...rowStyle, height: 30 }}
          >
            <Icon name="chat" size={12} color={COLORS.accent} />
            <text
              style={{
                fontSize: 12,
                fontFamily: FONT.ui,
                color: COLORS.textBright,
                pointerEvents: 'none',
              }}
            >
              New Chat
            </text>
          </div>

          {acpAgents.map((a) => (
            <div
              key={a.id}
              tabIndex={0}
              testId={`new-acp-${a.id}`}
              onClick={pick(() => workspace && store.createAcpThread(a.id, a.label, workspace.id))}
              style={{ ...rowStyle, height: 30 }}
            >
              <Icon name="acp" size={12} color={COLORS.acpKind} />
              <text
                style={{
                  fontSize: 12,
                  fontFamily: FONT.ui,
                  color: COLORS.text,
                  flexShrink: 0,
                  pointerEvents: 'none',
                }}
              >
                {a.label}
              </text>
              <text
                style={{
                  fontSize: 10,
                  fontFamily: FONT.mono,
                  color: COLORS.muted,
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                  pointerEvents: 'none',
                }}
              >
                {agentCommandSummary(a)}
              </text>
            </div>
          ))}

          {empty ? (
            <text
              style={{
                fontSize: 11,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                padding: 8,
              }}
            >
              没有匹配工具。自定义命令可在设置的 ACP 分区添加。
            </text>
          ) : null}
        </div>
      </ModalBody>
    </Modal>
  )
}
