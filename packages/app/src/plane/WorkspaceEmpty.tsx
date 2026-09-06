/**
 * WorkspaceEmpty — 工作区起始页（Phase W；原型 workspace-plane.md 体验
 * 路径 6「最后一个会话被移除后回到工作区起始页」/「空工作区默认引导
 * 创建 pi 会话」）。
 *
 * Pane 的路由分支（/workspace/$id），不是 thread kind 表面（不进
 * registry）。放 plane/（与 ToolMenu 同层）：菜单复用会破坏 surfaces →
 * plane 的依赖方向。
 *
 * 结构（原型 workspace-empty）：folder + 工作区名 + path + 引导文案 +
 * 「新建 pi 会话」primary +「选择其他工具」（复用 ToolMenu，anchored 到
 * 按钮）+ 其余预设快捷行。pi 预设被删时 primary 隐藏（防御，仅菜单）。
 */

import { useState } from 'react'

import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import type { ThreadStore, Workspace } from '../threads/store'
import { Icon } from '../ui/Icon'
import { COLORS, FONT } from '../ui/tokens'
import { ToolMenu } from './ToolMenu'

export function WorkspaceEmpty({
  store,
  settings,
  workspace,
}: {
  store: ThreadStore
  settings: SettingsStore
  workspace: Workspace
}) {
  const snap = useSettings(settings)
  const presets = snap.presets.items
  const pi = presets.find((p) => p.id === 'pi')
  const quickPicks = presets.filter((p) => p.id !== 'pi')
  const [menuOpen, setMenuOpen] = useState(false)

  const actionStyle = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 30,
    paddingLeft: 13,
    paddingRight: 13,
    borderRadius: 5,
    cursor: 'pointer',
  } as const

  return (
    <div
      testId={`workspace-empty-${workspace.id}`}
      style={{
        flexGrow: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: COLORS.pane,
        padding: 24,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          maxWidth: 380,
          minWidth: 0,
          gap: 8,
        }}
      >
        <Icon name="folder" size={30} color={COLORS.accent} />
        <text
          style={{
            fontSize: 15,
            fontFamily: FONT.ui,
            fontWeight: '600',
            color: COLORS.textBright,
          }}
        >
          {workspace.name}
        </text>
        <text
          style={{
            fontSize: 11,
            fontFamily: FONT.mono,
            color: COLORS.muted,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            maxWidth: 380,
          }}
        >
          {workspace.path}
        </text>
        <text
          style={{
            fontSize: 12,
            fontFamily: FONT.ui,
            color: COLORS.muted,
            whiteSpace: 'normal',
            textAlign: 'center',
          }}
        >
          这个工作区还没有会话。从 pi 开始一个任务，或打开你熟悉的终端工具。
        </text>

        <div style={{ display: 'flex', flexDirection: 'row', gap: 10, marginTop: 6 }}>
          {pi ? (
            <div
              tabIndex={0}
              testId={`workspace-new-pi-${workspace.id}`}
              onClick={() => void store.spawnFromPreset(pi.id, workspace.id)}
              onKeyDown={(e) => {
                if (e.key === 'enter' || e.key === 'space')
                  void store.spawnFromPreset(pi.id, workspace.id)
              }}
              style={{
                ...actionStyle,
                backgroundColor: COLORS.accent,
                hover: { backgroundColor: COLORS.accentHover },
              }}
            >
              <Icon name="plus" size={12} color={COLORS.textBright} />
              <text
                style={{
                  fontSize: 12,
                  fontFamily: FONT.ui,
                  color: COLORS.textBright,
                  pointerEvents: 'none',
                }}
              >
                新建 pi 会话
              </text>
            </div>
          ) : null}
          {/* 「选择其他工具」：anchored 到本容器（按钮 bounds）→ 复用
              ToolMenu（预设 + New Chat + ACP，全带 workspaceId 归属） */}
          <div style={{ display: 'flex' }}>
            <div
              tabIndex={0}
              testId={`workspace-more-tools-${workspace.id}`}
              onClick={() => setMenuOpen((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === 'enter' || e.key === 'space') setMenuOpen((v) => !v)
              }}
              style={{
                ...actionStyle,
                backgroundColor: COLORS.surface,
                borderWidth: 1,
                borderColor: COLORS.borderSubtle,
                hover: { backgroundColor: COLORS.surfaceHover },
              }}
            >
              <text
                style={{
                  fontSize: 12,
                  fontFamily: FONT.ui,
                  color: COLORS.text,
                  pointerEvents: 'none',
                }}
              >
                选择其他工具
              </text>
              <Icon name="chevronDown" size={11} color={COLORS.muted} />
            </div>
            {menuOpen ? (
              <ToolMenu
                store={store}
                settings={settings}
                workspace={workspace}
                onClose={() => setMenuOpen(false)}
              />
            ) : null}
          </div>
        </div>

        {quickPicks.length > 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              flexWrap: 'wrap',
              justifyContent: 'center',
              gap: 8,
              marginTop: 8,
            }}
          >
            {quickPicks.map((p) => (
              <div
                key={p.id}
                tabIndex={0}
                testId={`workspace-quick-${p.id}`}
                onClick={() => void store.spawnFromPreset(p.id, workspace.id)}
                onKeyDown={(e) => {
                  if (e.key === 'enter' || e.key === 'space')
                    void store.spawnFromPreset(p.id, workspace.id)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  height: 24,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 4,
                  borderWidth: 1,
                  borderColor: COLORS.borderSubtle,
                  cursor: 'pointer',
                  hover: { backgroundColor: COLORS.surface },
                }}
              >
                <text
                  style={{
                    fontSize: 11,
                    fontFamily: FONT.ui,
                    color: COLORS.text,
                    pointerEvents: 'none',
                  }}
                >
                  {p.label}
                </text>
              </div>
            ))}
          </div>
        ) : null}

        <text
          style={{
            fontSize: 10,
            fontFamily: FONT.ui,
            color: COLORS.muted,
            marginTop: 10,
          }}
        >
          所有工具从工作区目录启动
        </text>
      </div>
    </div>
  )
}
