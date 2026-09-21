/**
 * dialogs/ToolDialog.tsx — 新建会话弹窗（Phase W7；原型 tool-dialog）。
 *
 * 对齐原型：工作区上下文条（.tool-ctx：「工作区」label + 行内 select +
 * 右侧 mono cwd 同行）→ 工具筛选（.tool-filter：search 图标 + input）
 * → 分组工具列表（.tool-list：AI 编程 / 终端工具 / 对话 + 44px 行：
 * 28px 图标块 + 双行 + cmd 徽章）。替代 W2 的 ToolMenu anchored 菜单形态
 * （入口不变：工作区行 ＋ / 空组引导 / 起始页「选择其他工具」）。
 *
 * 快捷 pi 直启（起始页 primary）不走本弹窗——原型 quick-tool 同语义。
 */

import { useState } from 'react'

import { Icon, Modal, ModalHeading, SelectField, inputFocus, COLORS, FONT } from '@jagent/ui'
import { acpAgentCommandSummary } from '../settings/schema'
import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import type { ThreadStore, Workspace } from '../threads/store'

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
  const showChatGroup = workspace != null || acpAgents.length > 0

  return (
    // 原型 #tool-dialog：440px 宽、内容自适应高（超高时 Modal maxHeight
    // 钳制 + 列表区滚动）
    <Modal width={440} onClose={onClose}>
      <ModalHeading title="新建会话" onClose={onClose} />
      {/* 原型 .modal-body：padding 12 14 16（无 gap——子项自携 margin） */}
      <div
        testId="modal-body"
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          paddingLeft: 14,
          paddingRight: 14,
          paddingTop: 12,
          paddingBottom: 16,
          flexGrow: 1,
        }}
      >
        {/* 工作区上下文条（原型 .tool-ctx：30px 高 inputBg 壳，
            「工作区」label + 行内 select + 右侧 mono cwd 同行） */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            height: 30,
            paddingLeft: 10,
            paddingRight: 10,
            backgroundColor: COLORS.inputBg,
            borderWidth: 1,
            borderColor: COLORS.borderSubtle,
            borderRadius: 6,
            marginBottom: 8,
            flexShrink: 0,
          }}
        >
          <text
            style={{
              fontSize: 11,
              fontFamily: FONT.ui,
              color: COLORS.muted,
              flexShrink: 0,
              pointerEvents: 'none',
            }}
          >
            工作区
          </text>
          <div style={{ flexGrow: 1, minWidth: 0, display: 'flex' }}>
            <SelectField
              testId="tool-dialog-workspace"
              value={workspaceId}
              options={[
                ...(includeTemp ? [{ value: '', label: '（未归属 · 临时会话）' }] : []),
                ...workspaces.map((w) => ({ value: w.id, label: w.name })),
              ]}
              onChange={setWorkspaceId}
              width="fill"
              bare
            />
          </div>
          <text
            style={{
              fontSize: 10.5,
              fontFamily: FONT.mono,
              color: COLORS.faint,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              maxWidth: 180,
              flexShrink: 0,
              pointerEvents: 'none',
            }}
          >
            {workspace?.path ?? '（无项目目录）'}
          </text>
        </div>

        {/* 筛选（原型 .tool-filter：30px 高 inputBg 壳 + search 图标 + input） */}
        <ToolFilter value={filter} onChange={setFilter} />

        {/* 工具列表（原型 .tool-list：margin 0 -6 / padding 0 6，
            max-height 320 滚动） */}
        <div
          testId="tool-list"
          style={{
            display: 'flex',
            flexDirection: 'column',
            flexGrow: 1,
            minHeight: 60,
            maxHeight: 320,
            overflowY: 'scroll',
            marginLeft: -6,
            marginRight: -6,
            paddingLeft: 6,
            paddingRight: 6,
          }}
        >
          {showAgentGroup ? <GroupLabel label="AI 编程" first /> : null}
          {agentPresets.map((p) => (
            <ToolRow
              key={p.id}
              testId={`tool-preset-${p.id}`}
              icon="agent"
              name={p.label}
              description={p.description}
              command={
                [p.program, ...(p.args ?? [])].filter(Boolean).join(' ') || p.initCommand || ''
              }
              recommended={p.id === 'pi'}
              onPick={pick(() => void store.spawnFromPreset(p.id, workspace?.id))}
            />
          ))}

          {termPresets.length > 0 ? <GroupLabel label="终端工具" /> : null}
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

          {/* 「对话」组（原型：New Chat + ACP agents）。未归属（无 workspace）
              时不渲染 New Chat/ACP——应用内表面没有可继承的 cwd 上下文 */}
          {showChatGroup ? <GroupLabel label="对话" /> : null}
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
                  command={acpAgentCommandSummary(a)}
                  onPick={pick(() => store.createAcpThread(a.id, a.label, workspace.id))}
                />
              ))
            : null}

          {empty ? (
            <text
              style={{
                fontSize: 11,
                fontFamily: FONT.ui,
                color: COLORS.faint,
                paddingTop: 10,
                paddingBottom: 16,
                textAlign: 'center',
                pointerEvents: 'none',
              }}
            >
              没有匹配工具。自定义命令可在设置的 ACP 分区添加。
            </text>
          ) : null}
        </div>
        {/* 底注（原型 .mhint：11px faint 居中） */}
        <text
          style={{
            fontSize: 11,
            fontFamily: FONT.ui,
            color: COLORS.faint,
            paddingTop: 10,
            paddingBottom: 16,
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          选一项即创建会话，Esc 取消
        </text>
      </div>
    </Modal>
  )
}

/** 筛选行（原型 .tool-filter：inputBg 壳 + search 图标 + 无边框 input） */
function ToolFilter({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const [focused, setFocused] = useState(false)
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        height: 30,
        paddingLeft: 10,
        paddingRight: 10,
        backgroundColor: COLORS.inputBg,
        borderWidth: 1,
        borderColor: focused ? COLORS.focusBorder : COLORS.borderSubtle,
        borderRadius: 6,
        marginBottom: 8,
        flexShrink: 0,
        color: COLORS.muted,
      }}
    >
      <Icon name="search" size={14} color={COLORS.muted} />
      <input
        testId="tool-dialog-filter"
        value={value}
        placeholder="搜索工具…"
        onChange={(e) => onChange(e.value ?? '')}
        onFocus={() => {
          setFocused(true)
          inputFocus.acquire()
        }}
        onBlur={() => {
          setFocused(false)
          inputFocus.release()
        }}
        style={{
          flexGrow: 1,
          minWidth: 0,
          fontSize: 12,
          fontFamily: FONT.ui,
          color: COLORS.textBright,
        }}
      />
    </div>
  )
}

/** 分组标签（原型 .glabel：10.5px/500 muted，padding 10 8 4；首个 2px 顶距） */
function GroupLabel({ label, first = false }: { label: string; first?: boolean }) {
  return (
    <text
      style={{
        fontSize: 10.5,
        fontFamily: FONT.ui,
        fontWeight: '500',
        color: COLORS.muted,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: first ? 2 : 10,
        paddingBottom: 4,
        flexShrink: 0,
        pointerEvents: 'none',
      }}
    >
      {label}
    </text>
  )
}

/** 工具行（原型 .tool-row：padding 6 8 / radius 8 / gap 10；
 *  28px tile 底图标块（按类着色）+ 双行（名+「默认」徽章 / 描述）+
 *  右侧 cmd 徽章（tile 底 mono 10px，max-width 110）） */
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
  icon: 'terminal' | 'chat' | 'acp' | 'agent'
  name: string
  description?: string
  command?: string
  recommended?: boolean
  onPick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  // 原型 .ic 类着色：agent=accent / chat=cyan / acp=acpKind / 其余 muted
  const iconColor =
    icon === 'agent'
      ? COLORS.accent
      : icon === 'chat'
        ? COLORS.cyan
        : icon === 'acp'
          ? COLORS.acpKind
          : hovered
            ? COLORS.textBright
            : COLORS.muted
  return (
    <div
      tabIndex={0}
      testId={testId}
      onClick={onPick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onPick()
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 8,
        cursor: 'pointer',
        flexShrink: 0,
        hover: { backgroundColor: COLORS.surface },
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: 6,
          backgroundColor: COLORS.tile,
          flexShrink: 0,
        }}
      >
        <Icon name={icon} size={14} color={iconColor} />
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
              fontSize: 12.5,
              fontFamily: FONT.ui,
              color: COLORS.textBright,
              flexShrink: 0,
              pointerEvents: 'none',
            }}
          >
            {name}
          </text>
          {recommended ? (
            // 原型 .nm .rec：9px accent 描边徽章
            <text
              style={{
                fontSize: 9,
                fontFamily: FONT.ui,
                color: COLORS.accent,
                borderWidth: 1,
                borderColor: 'rgba(97, 175, 239, 0.4)',
                borderRadius: 3,
                paddingLeft: 4,
                paddingRight: 4,
                lineHeight: 14,
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
              fontSize: 11,
              fontFamily: FONT.ui,
              color: COLORS.muted,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              minWidth: 0,
              pointerEvents: 'none',
            }}
          >
            {description}
          </text>
        ) : null}
      </div>
      {command ? (
        // 原型 .cmd：tile 底徽章（mono 10px faint，max-width 110）
        <text
          style={{
            fontSize: 10,
            fontFamily: FONT.mono,
            color: COLORS.faint,
            whiteSpace: 'nowrap',
            flexShrink: 0,
            maxWidth: 110,
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            backgroundColor: COLORS.tile,
            borderRadius: 4,
            paddingTop: 2,
            paddingBottom: 2,
            paddingLeft: 6,
            paddingRight: 6,
            pointerEvents: 'none',
          }}
        >
          {command}
        </text>
      ) : null}
    </div>
  )
}
