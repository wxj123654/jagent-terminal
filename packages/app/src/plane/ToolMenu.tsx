/**
 * ToolMenu — 工作区「＋」工具选择菜单（Phase W2；布局契约 = 原型
 * design/workspace-plane.md「点击工作区右侧 ＋，选择工具；菜单会明确展示
 * 目标工作区与 cwd」）。
 *
 * T3.2/T3+.1 的 NewThreadButton 菜单演化：菜单项不变（预设 + New Chat +
 * ACP agents），新增 ① 目标工作区参数（spawn/create 全带 workspaceId——
 * cwd 继承链在 store 单点）② 头部目标工作区行（名称 + mono cwd）。
 * 顶部常驻 NewThreadButton 移除：新建入口唯一化到工作区行 ＋（无「当前
 * 工作区」歧义）；全局空态兜底仍是 Pane 的 EmptyPresets。
 *
 * 浮层：anchored deferred（画在列表之上——GPUI 树序绘制无 stacking，
 * 见 memory #2）；trigger = 工作区行（side=bottom 展开于行下）。
 */

import { useState } from 'react'

import type { AcpAgent } from '../settings/schema'
import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import { presetCommandSummary } from '../threads/presets'
import type { ThreadStore, Workspace } from '../threads/store'
import { workspaceDisplayName } from '../threads/workspaces'
import { Icon } from '../ui/Icon'
import { inputFocus } from '../ui/keyboard'
import { COLORS, FONT, SIZES } from '../ui/tokens'

function agentCommandSummary(a: AcpAgent): string {
  return [a.command, ...a.args].filter(Boolean).join(' ')
}

export function ToolMenu({
  store,
  settings,
  workspace,
  onClose,
}: {
  store: ThreadStore
  settings: SettingsStore
  workspace: Workspace
  onClose: () => void
}) {
  const snap = useSettings(settings)
  // 工具筛选（W5；原型清单「工具筛选」）：label/command/args 子串命中
  const [filter, setFilter] = useState('')
  const lower = filter.trim().toLowerCase()
  const hit = (...xs: (string | undefined)[]) =>
    lower === '' || xs.some((x) => x?.toLowerCase().includes(lower))
  const presets = snap.presets.items.filter((p) =>
    hit(p.label, p.program, p.initCommand, ...(p.args ?? [])),
  )
  const acpAgents = snap.acpAgents.filter((a) => hit(a.label, a.command, ...(a.args ?? [])))

  const pick = (fn: () => void) => () => {
    onClose()
    fn()
  }

  return (
    <anchored
      side="bottom"
      align="start"
      gap={2}
      deferred
      occlude
      style={{
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: COLORS.inputBg,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 6,
        padding: 4,
        // anchored 不支持 inset 拉伸：内容宽 + 上限 = 侧栏内宽
        minWidth: SIZES.sidebarWidth - SIZES.rowMarginX * 2,
        maxWidth: SIZES.sidebarWidth - SIZES.rowMarginX * 2,
      }}
    >
      {/* 头部：目标工作区 + cwd（原型契约：菜单明确展示目标工作区与 cwd） */}
      <div
        testId="tool-menu-target"
        style={{
          display: 'flex',
          flexDirection: 'column',
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 4,
          paddingBottom: 4,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="folder" size={11} color={COLORS.accent} />
          <text
            style={{
              fontSize: 11,
              fontFamily: FONT.ui,
              fontWeight: '600',
              color: COLORS.textBright,
              pointerEvents: 'none',
            }}
          >
            {workspaceDisplayName(workspace.path)}
          </text>
        </div>
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
          {workspace.path}
        </text>
      </div>

      {/* 筛选框（W5）：工具多时快速过滤；Esc 清空（层级内消费） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          marginLeft: 4,
          marginRight: 4,
          marginBottom: 4,
          borderWidth: 1,
          borderColor: COLORS.borderSubtle,
          borderRadius: 4,
          height: 24,
          paddingLeft: 6,
          paddingRight: 6,
          backgroundColor: COLORS.app,
        }}
      >
        <Icon name="search" size={10} color={COLORS.muted} />
        <input
          testId="tool-menu-filter"
          value={filter}
          placeholder="筛选工具…"
          onChange={(e) => setFilter(e.value ?? '')}
          onFocus={() => inputFocus.acquire()}
          onBlur={() => inputFocus.release()}
          onKeyDown={(e) => {
            if (e.key === 'escape' && filter) setFilter('')
          }}
          style={{
            flexGrow: 1,
            fontSize: 11,
            fontFamily: FONT.ui,
            color: COLORS.text,
          }}
        />
      </div>

      {presets.map((p) => (
        <div
          key={p.id}
          tabIndex={0}
          testId={`tool-preset-${p.id}`}
          onClick={pick(() => void store.spawnFromPreset(p.id, workspace.id))}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            height: 26,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 4,
            cursor: 'pointer',
            hover: { backgroundColor: COLORS.surface },
          }}
        >
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
            {presetCommandSummary(p)}
          </text>
        </div>
      ))}

      {presets.length === 0 && acpAgents.length === 0 ? (
        <text
          style={{
            fontSize: 11,
            fontFamily: FONT.ui,
            color: COLORS.muted,
            paddingLeft: 8,
            paddingRight: 8,
            paddingTop: 6,
            paddingBottom: 6,
          }}
        >
          无匹配工具
        </text>
      ) : null}

      <div
        style={{
          height: 1,
          backgroundColor: COLORS.borderSubtle,
          marginTop: 4,
          marginBottom: 4,
        }}
      />
      <div
        tabIndex={0}
        testId="new-chat"
        onClick={pick(() => store.createChat(workspace.id))}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          height: 26,
          paddingLeft: 8,
          paddingRight: 8,
          borderRadius: 4,
          cursor: 'pointer',
          hover: { backgroundColor: COLORS.surface },
        }}
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

      {acpAgents.length > 0 ? (
        <div
          style={{
            height: 1,
            backgroundColor: COLORS.borderSubtle,
            marginTop: 4,
            marginBottom: 4,
          }}
        />
      ) : null}
      {acpAgents.map((a) => (
        <div
          key={a.id}
          tabIndex={0}
          testId={`new-acp-${a.id}`}
          onClick={pick(() => store.createAcpThread(a.id, a.label, workspace.id))}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            height: 26,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 4,
            cursor: 'pointer',
            hover: { backgroundColor: COLORS.surface },
          }}
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
    </anchored>
  )
}
