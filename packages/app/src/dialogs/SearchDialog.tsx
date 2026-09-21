/**
 * dialogs/SearchDialog.tsx — 搜索会话弹窗（Phase W7；原型 search-dialog）。
 *
 * ⌘K/Ctrl-K 全局入口（keybindings.searchThreads 从「聚焦侧栏搜索框」改为
 * 「打开本弹窗」，原型语义）。跨工作区命中（searchThreads：标题/工具/
 * 目录/工作区名）；↑↓ 键盘导航 + Enter 激活；Esc 清空/关闭（TextInput
 * 自理 Esc 清空时 onKeyDown 放行到 Modal 卡片 → 关闭，原型同款层级）。
 */

import { useMemo, useRef, useState } from 'react'

import { Icon, inputFocus, Modal, COLORS, FONT } from '@jagent/ui'
import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import { rowTitle } from '../sidebar/ThreadRow'
import type { ThreadStore } from '../threads/store'
import type { Thread } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { searchThreads } from '../threads/workspaces'

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
  // 空 query 列全部会话（R7 契约：原型 react 版有 `q ?` 门槛，HTML 原型
  // 与本清单均为空 query 列全部——对齐后者）
  const results = useMemo(
    () =>
      searchThreads(
        threads,
        workspaces,
        q,
        (pid) => snap.presets.items.find((p) => p.id === pid)?.label,
      ),
    [q, threads, workspaces, snap],
  )
  // 光标钳制到结果集（结果随 query 收缩时 cursor 状态可能越界——原型
  // cur = min(cursor, len-1) 同款）
  const cur = Math.min(cursor, Math.max(results.length - 1, 0))
  // Esc 两段式：输入框有内容时 Esc 只清空不关闭（GPUIX keydown 沿焦点链
  // 冒泡到 modal-card，JS 无 stopPropagation 面——用标志位吃掉同次冒泡）
  const escCleared = useRef(false)

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
    // 原型 #search-dialog：min(92vw,560) + .modal.r20（第二段 r=14）；
    // 命令面板形态——顶部 .search-in 输入行（无标题栏），下接 .sr-list 结果区
    <Modal
      width={560}
      radius={14}
      onClose={() => {
        if (escCleared.current) {
          escCleared.current = false
          return
        }
        onClose()
      }}
    >
      {/* 搜索行（原型 .search-in 第二段：icon 16 + input 14px，padding 14 16，borderSubtle 底线） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 14,
          paddingBottom: 14,
          borderBottomWidth: 1,
          borderColor: COLORS.borderSubtle,
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
            else if (e.key === 'enter') activateAt(cur)
            else if (e.key === 'escape' && query) {
              setQuery('')
              escCleared.current = true
            }
          }}
          style={{
            flexGrow: 1,
            fontSize: 14,
            fontFamily: FONT.ui,
            color: COLORS.textBright,
          }}
        />
      </div>

      {/* 结果列表（原型 .sr-list 第二段：padding 7，max-height 340；↑↓ 光标行） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'scroll',
          maxHeight: 340,
          minHeight: 80,
          padding: 7,
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
            selected={i === cur}
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
    // 原型 .sr-row：padding 8 10，radius 8（第二段），图标 16 muted
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
        borderRadius: 8,
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
