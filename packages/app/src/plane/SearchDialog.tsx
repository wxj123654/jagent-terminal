/**
 * plane/SearchDialog.tsx — 搜索会话弹窗（Phase W7；原型 search-dialog）。
 *
 * ⌘K/Ctrl-K 全局入口（keybindings.searchThreads 从「聚焦侧栏搜索框」改为
 * 「打开本弹窗」，原型语义）。跨工作区命中（searchThreads：标题/工具/
 * 目录/工作区名）；↑↓ 键盘导航 + Enter 激活；Esc 清空/关闭（TextInput
 * 自理 Esc 清空时 onKeyDown 放行到 Modal 卡片 → 关闭，原型同款层级）。
 */

import { useMemo, useState } from 'react'

import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import type { ThreadStore } from '../threads/store'
import type { Thread } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { searchThreads } from '../threads/workspaces'
import { Icon } from '../ui/Icon'
import { inputFocus } from '../ui/keyboard'
import { Modal, ModalBody, ModalHeading } from '../ui/Modal'
import { COLORS, FONT } from '../ui/tokens'
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
    <Modal width={480} onClose={onClose}>
      <ModalHeading title="搜索会话" onClose={onClose} />
      <ModalBody>
        {/* 搜索框（原型：输入即筛选；Esc 清空——空时放行 Modal 关闭） */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            height: 30,
            paddingLeft: 9,
            paddingRight: 9,
            marginBottom: 8,
            borderRadius: 4,
            backgroundColor: COLORS.app,
            borderWidth: 1,
            borderColor: COLORS.borderSubtle,
          }}
        >
          <Icon name="search" size={12} color={COLORS.muted} />
          <input
            autoFocus
            testId="search-dialog-input"
            value={query}
            placeholder="搜索会话、工具或工作区…"
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
            style={{ flexGrow: 1, fontSize: 12, fontFamily: FONT.ui, color: COLORS.text }}
          />
        </div>

        {/* 结果列表（↑↓ 光标行 + 行内高亮） */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            overflowY: 'scroll',
            maxHeight: 300,
            minHeight: 80,
          }}
        >
          {q !== '' && results.length === 0 ? (
            <text style={{ fontSize: 11, fontFamily: FONT.ui, color: COLORS.muted, padding: 8 }}>
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
      </ModalBody>
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
  const kindColor =
    thread.kind === 'terminal'
      ? COLORS.terminalKind
      : thread.kind === 'acp'
        ? COLORS.acpKind
        : COLORS.accent
  return (
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
        gap: 8,
        height: 30,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 4,
        backgroundColor: selected ? COLORS.surface : 'transparent',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', width: 16, justifyContent: 'center', flexShrink: 0 }}>
        <Icon name={thread.kind} size={12} color={kindColor} />
      </div>
      <text
        style={{
          fontSize: 12,
          fontFamily: FONT.ui,
          color: COLORS.text,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
          pointerEvents: 'none',
        }}
      >
        {rowTitle(thread)}
      </text>
      <text
        style={{
          fontSize: 10,
          fontFamily: FONT.mono,
          color: COLORS.muted,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
          flexGrow: 1,
          textAlign: 'right',
          pointerEvents: 'none',
        }}
      >
        {workspaceName ?? ''}
      </text>
    </div>
  )
}
