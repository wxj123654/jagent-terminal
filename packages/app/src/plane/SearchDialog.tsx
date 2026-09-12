/**
 * plane/SearchDialog.tsx — 搜索会话弹窗（Phase W7；原型 search-dialog）。
 *
 * ⌘K/Ctrl-K 全局入口（keybindings.searchThreads 从「聚焦侧栏搜索框」改为
 * 「打开本弹窗」，原型语义）。跨工作区命中（searchThreads：标题/工具/
 * 目录/工作区名）；↑↓ 键盘导航 + Enter 激活；Esc 清空/关闭（TextInput
 * 自理 Esc 清空时 onKeyDown 放行到 Modal 卡片 → 关闭，原型同款层级）。
 */

import { useMemo, useState } from 'react'

import { Icon, inputFocus, Modal, COLORS, FONT } from '@jagent/ui'
import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import type { ThreadStore } from '../threads/store'
import type { Thread } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { searchThreads } from '../threads/workspaces'
import { rowTitle } from './ThreadRow'

export function SearchDialog({
  store,
  settings,
  onClose,
}: {
  store: ThreadStore
  settings: SettingsStore
  onClose: () => void
}) {
  // 稳定引用订阅 + 渲染期现算（uSES 快照纪律，SearchResults 同款）
  const threads = useThreadStore(store, (s) => s.threads)
  const workspaces = useThreadStore(store, (s) => s.workspaces)
  const snap = useSettings(settings)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)

  const q = query.trim()
  const results = useMemo(
    () =>
      q === ''
        ? []
        : searchThreads(
            threads,
            workspaces,
            q,
            (pid) => snap.presets.items.find((p) => p.id === pid)?.label,
          ),
    [q, threads, workspaces, snap],
  )

  const moveCursor = (delta: number) => {
    if (results.length === 0) return
    setCursor((c) => (c + delta + results.length) % results.length)
  }
  const activateAt = (i: number) => {
    const hit = results[i]
    if (!hit) return
    // 先导航后关弹窗：activate 的 zustand set 会同步触发订阅者渲染，
    // onClose 的 setState 排在其后不被同一批丢弃（W7 TestRenderer 实测）
    store.activate({ type: 'thread', id: hit.thread.id })
    onClose()
  }

  return (
    // 原型 #search-dialog：min(92vw,560) + r-xl；命令面板形态——
    // 顶部 .search-in 输入行（无标题栏），下接 .sr-list 结果区
    <Modal width={560} radius={20} onClose={onClose}>
      {/* 搜索行（原型 .search-in：icon 16 + input 14px，padding 12 14，底部分隔线） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingLeft: 14,
          paddingRight: 14,
          paddingTop: 12,
          paddingBottom: 12,
          borderBottomWidth: 1,
          borderColor: COLORS.border,
          flexShrink: 0,
        }}
      >
        <Icon name="search" size={16} color={COLORS.faint} />
        <input
          autoFocus
          testId="search-dialog-input"
          value={query}
          placeholder="搜索会话、工作区、命令…"
          onChange={(e) => {
            setQuery(e.value ?? '')
            setCursor(0)
          }}
          onFocus={() => inputFocus.acquire()}
          onBlur={() => inputFocus.release()}
          onKeyDown={(e) => {
            if (e.key === 'arrowdown') moveCursor(1)
            else if (e.key === 'arrowup') moveCursor(-1)
            else if (e.key === 'enter') activateAt(cursor)
            else if (e.key === 'escape' && query) setQuery('')
          }}
          style={{
            flexGrow: 1,
            fontSize: 14,
            fontFamily: FONT.ui,
            color: COLORS.textBright,
          }}
        />
      </div>

      {/* 结果列表（原型 .sr-list：padding 6，max-height 340；↑↓ 光标行） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'scroll',
          maxHeight: 340,
          minHeight: 80,
          padding: 6,
        }}
      >
        {q !== '' && results.length === 0 ? (
          <text
            style={{
              fontSize: 12,
              fontFamily: FONT.ui,
              color: COLORS.faint,
              paddingTop: 28,
              paddingBottom: 28,
              textAlign: 'center',
            }}
          >
            没有匹配的会话。试试项目名或工具名。
          </text>
        ) : null}
        {results.map(({ thread, workspace }, i) => (
          <SearchRow
            key={thread.id}
            thread={thread}
            workspaceName={workspace?.name}
            selected={i === cursor}
            onHover={() => setCursor(i)}
            onPick={() => activateAt(i)}
          />
        ))}
      </div>
    </Modal>
  )
}

function SearchRow({
  thread,
  workspaceName,
  selected,
  onHover,
  onPick,
}: {
  thread: Thread
  workspaceName?: string
  selected: boolean
  onHover: () => void
  onPick: () => void
}) {
  return (
    // 原型 .sr：grid 16|1fr|auto，padding 8 10，radius 6，图标 16 text-3
    <div
      tabIndex={0}
      testId={`search-hit-${thread.id}`}
      onMouseEnter={onHover}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === 'enter') onPick()
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 6,
        backgroundColor: selected ? COLORS.surface : 'transparent',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', width: 16, justifyContent: 'center', flexShrink: 0 }}>
        <Icon name={thread.kind} size={16} color={COLORS.muted} />
      </div>
      <text
        style={{
          fontSize: 13,
          fontFamily: FONT.ui,
          color: COLORS.text,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
          flexGrow: 1,
          minWidth: 0,
          pointerEvents: 'none',
        }}
      >
        {rowTitle(thread)}
      </text>
      <text
        style={{
          fontSize: 11,
          fontFamily: FONT.mono,
          color: COLORS.faint,
          whiteSpace: 'nowrap',
          flexShrink: 0,
          pointerEvents: 'none',
        }}
      >
        {workspaceName ?? ''}
      </text>
    </div>
  )
}
