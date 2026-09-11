/**
 * WorkspaceList — v2 双区侧栏列表（Phase D1；原型 desktop-plane-v2）。
 *
 * 结构：
 * - 「会话」区：无归属临时会话（workspaceId 未设），时间分组 + 默认前 10 条
 *   + 「展开其余 N 个」；区头 ＋ = 新建临时会话（工具弹窗无目标工作区）。
 * - 「工作区」区：工作区分组（箭头 toggle / 点行激活恢复 lastSession /
 *   ＋ 新建会话 / hover 移除），组内时间分组 + load more，同会话区。
 * - 搜索态由 Sidebar 传入 query：非空时整树切换为跨工作区结果列表。
 *
 * 事件命中模型（T3.1）：GPUIX 子元素自带 listener 时冒泡到父 listener
 * （deepest-first）——箭头/＋/移除钮与行 onClick 的冲突用「抑制 ref」。
 */

import { useRef, useState } from 'react'

import type { SettingsStore } from '../settings/store'
import type { ThreadStore } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import {
  searchThreads,
  TIME_GROUP_LABELS,
  timeGroupsOf,
  type TimeGroup,
} from '../threads/workspaces'
import { Icon } from '../ui/Icon'
import { COLORS, FONT, SIZES } from '../ui/tokens'
import type { DialogOpener } from './DialogHost'
import { ThreadRow } from './ThreadRow'

/** 会话行在分组下的缩进（视觉分组） */
const SESSION_INDENT = 12

/** 原生目录选择 seam（W3）：resolve(path) / resolve(null) = 取消或不可用 */
export type DirectoryPicker = () => Promise<string | null>

/** 时间分组默认展开条数（原型：默认前 10 条 + 展开其余） */
const GROUP_LIMIT = 10

export function WorkspaceList({
  store,
  settings,
  query,
  dialog,
}: {
  store: ThreadStore
  settings: SettingsStore
  query: string
  /** 弹窗入口（W7）：行 ＋ / 空组引导 → 新建会话弹窗；底部 → 添加工作区弹窗 */
  dialog: DialogOpener
}) {
  const workspaces = useThreadStore(store, (s) => s.workspaces)
  const trimmed = query.trim()

  if (trimmed !== '') {
    return <SearchResultsWithDialog store={store} settings={settings} query={trimmed} dialog={dialog} />
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, overflowY: 'scroll' }}>
      {/* ── 会话区（无归属临时会话）── */}
      <TempSessionsSection store={store} dialog={dialog} />
      {/* ── 工作区区 ── */}
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
        <SectionHeader label="工作区">
          <GhostButton
            testId="add-workspace"
            label="添加工作区"
            onClick={() => dialog.openAddWorkspace()}
          />
        </SectionHeader>
        {workspaces.map((ws) => (
          <WorkspaceGroup key={ws.id} store={store} workspaceId={ws.id} dialog={dialog} />
        ))}
      </div>
    </div>
  )
}

// ── 区头（v2 sec-head：label + ghost ＋）────────────────────────────

function SectionHeader({
  label,
  children,
}: {
  label: string
  children?: React.ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        minHeight: 26,
        paddingLeft: 8,
        paddingRight: 6,
        paddingBottom: 4,
        paddingTop: 2,
      }}
    >
      <text
        style={{
          fontSize: 12,
          fontFamily: FONT.ui,
          fontWeight: '500',
          color: COLORS.muted,
          pointerEvents: 'none',
        }}
      >
        {label}
      </text>
      {children}
    </div>
  )
}

/** 区头 ghost 钮（v2 .ghost：22px 圆；区头内常显 85%） */
function GhostButton({
  testId,
  label: _label,
  onClick,
}: {
  testId: string
  label: string
  onClick: () => void
}) {
  return (
    <div
      tabIndex={0}
      testId={testId}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onClick()
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: 9999,
        color: COLORS.muted,
        cursor: 'pointer',
        hover: { backgroundColor: COLORS.surface, color: COLORS.textBright },
      }}
    >
      <Icon name="plus" size={13} />
    </div>
  )
}

// ── 时间分组 + load more（会话区/工作区组共用）─────────────────────

function TimeGroupedSessions({
  store,
  threadIds,
  indent,
  onManage,
}: {
  store: ThreadStore
  /** 本组会话 id（创建序） */
  threadIds: string[]
  indent: number
  onManage?: (threadId: string) => void
}) {
  // 展开态：默认收 10 条；「展开其余 N 个」置全展开（本组件局部态，不持久化）
  const [expanded, setExpanded] = useState(false)
  // uSES 纪律：selector 必须返回稳定引用——订整个 threads（immer 结构共享），
  // 过滤在渲染期现算（新数组会炸 getSnapshot 缓存检查）
  const allThreads = useThreadStore(store, (s) => s.threads)
  const idSet = new Set(threadIds)
  const threads = allThreads.filter((t) => idSet.has(t.id))
  const groups = timeGroupsOf(threads)
  const order: TimeGroup[] = ['today', 'yesterday', 'week', 'earlier']
  const limit = expanded ? Infinity : GROUP_LIMIT

  // 先按 limit 算出「可见组 + 各组可见条数」，再逐组渲染（D13：超限后
  // 不再为完全隐藏的组渲染孤立日期标签——原型是先取前 10 条再分组）。
  let cursor = 0
  const visible: { group: TimeGroup; slice: typeof threads; hidden: number }[] = []
  for (const g of order) {
    const list = groups.get(g) ?? []
    if (list.length === 0) continue
    const room = Math.max(0, limit - cursor)
    const slice = list.slice(0, room)
    cursor += slice.length
    const hidden = list.length - slice.length
    if (slice.length > 0) visible.push({ group: g, slice, hidden })
    if (cursor >= limit) break
  }
  // 隐藏总数（含被 break 跳过的后续组）
  const hiddenTotal =
    limit === Infinity
      ? 0
      : Math.max(
          0,
          threads.length - visible.reduce((n, v) => n + v.slice.length, 0),
        )

  return (
    <>
      {visible.map(({ group: g, slice, hidden }) => (
        <div key={g} style={{ display: 'flex', flexDirection: 'column' }}>
          <text
            style={{
              fontSize: 11,
              fontFamily: FONT.ui,
              fontWeight: '500',
              color: COLORS.muted,
              paddingLeft: indent + 20,
              paddingTop: 6,
              paddingBottom: 2,
              pointerEvents: 'none',
            }}
          >
            {TIME_GROUP_LABELS[g]}
          </text>
          {slice.map((t) => (
            <ThreadRow key={t.id} id={t.id} store={store} indent={indent} onManage={onManage} />
          ))}
          {/* 「展开其余」：最后一个可见组下方，仅当还有隐藏条目（合计全组剩余） */}
          {hidden > 0 || (hiddenTotal > 0 && g === visible.at(-1)?.group) ? (
            <div
              tabIndex={0}
              testId={`load-more-${g}`}
              onClick={() => setExpanded(true)}
              onKeyDown={(e) => {
                if (e.key === 'enter' || e.key === 'space') setExpanded(true)
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                height: 22,
                marginLeft: indent + 6,
                marginRight: SIZES.rowMarginX,
                paddingLeft: 14,
                borderRadius: SIZES.rowRadius,
                cursor: 'pointer',
                hover: { backgroundColor: COLORS.surface },
              }}
            >
              <text
                style={{
                  fontSize: 11.5,
                  fontFamily: FONT.ui,
                  color: COLORS.muted,
                  pointerEvents: 'none',
                }}
              >
                展开其余 {hiddenTotal} 个
              </text>
            </div>
          ) : null}
        </div>
      ))}
    </>
  )
}

// ── 会话区（无归属）─────────────────────────────────────────────────

function TempSessionsSection({
  store,
  dialog,
}: {
  store: ThreadStore
  dialog: DialogOpener
}) {
  // 无归属会话 id 串（稳定订阅粒度：增删/顺序）
  const threadIds = useThreadStore(store, (s) =>
    s.threads
      .filter((t) => t.workspaceId == null)
      .map((t) => t.id)
      .join(','),
  )
  const ids = threadIds === '' ? [] : threadIds.split(',')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
      <SectionHeader label="会话">
        <GhostButton
          testId="new-temp-session"
          label="新建临时会话"
          onClick={() => dialog.openToolMenu('')}
        />
      </SectionHeader>
      {ids.length === 0 ? (
        <text
          style={{
            paddingLeft: 8,
            paddingBottom: 4,
            fontSize: 12,
            fontFamily: FONT.ui,
            color: COLORS.exited,
            pointerEvents: 'none',
          }}
        >
          暂无未归属会话
        </text>
      ) : (
        <TimeGroupedSessions
          store={store}
          threadIds={ids}
          indent={0}
          onManage={dialog.openManageSession}
        />
      )}
    </div>
  )
}

// ── 工作区分组 ───────────────────────────────────────────────────────

function WorkspaceGroup({
  store,
  workspaceId,
  dialog,
}: {
  store: ThreadStore
  workspaceId: string
  dialog: DialogOpener
}) {
  const ws = useThreadStore(store, (s) => s.workspaces.find((w) => w.id === workspaceId))
  // 会话 id 串（顺序/增删粒度）；行内容 ThreadRow 自订
  const sessionIds = useThreadStore(store, (s) =>
    s.threads
      .filter((t) => t.workspaceId === workspaceId)
      .map((t) => t.id)
      .join(','),
  )
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [hovered, setHovered] = useState(false)
  /** 行内按钮 → 行 onClick 抑制（本行实例；同批 click 消费一次） */
  const skipRow = useRef(false)

  if (!ws) return null
  const sessions = sessionIds === '' ? [] : sessionIds.split(',')

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        testId={`workspace-${ws.id}`}
        tabIndex={0}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        onClick={(e) => {
          if (skipRow.current) {
            skipRow.current = false
            return
          }
          if (e.clickCount === 2) {
            setDraft(ws.name)
            setRenaming(true)
            return
          }
          if (renaming) return
          store.activateWorkspace(ws.id)
        }}
        onKeyDown={(e) => {
          if (e.key === 'enter' && !renaming) store.activateWorkspace(ws.id)
        }}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          height: 28,
          marginLeft: SIZES.rowMarginX,
          marginRight: SIZES.rowMarginX,
          paddingLeft: 4,
          paddingRight: 4,
          borderRadius: SIZES.rowRadius,
          cursor: 'pointer',
          userSelect: 'none',
          hover: { backgroundColor: COLORS.surface },
        }}
      >
        {/* 展开箭头：仅 toggle，不激活（原型：点箭头仅展开/收起） */}
        <div
          testId={`workspace-toggle-${ws.id}`}
          onClick={() => {
            skipRow.current = true
            store.toggleWorkspaceExpanded(ws.id)
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 16,
            height: 16,
            flexShrink: 0,
          }}
        >
          <Icon
            name={ws.expanded ? 'chevronDown' : 'chevronRight'}
            size={11}
            color={COLORS.muted}
          />
        </div>
        <Icon name="folder" size={12} color={COLORS.muted} />
        {renaming ? (
          <input
            autoFocus
            testId={`workspace-rename-${ws.id}`}
            value={draft}
            onChange={(e) => setDraft(e.value ?? draft)}
            onKeyDown={(e) => {
              if (e.key === 'enter') {
                store.renameWorkspace(ws.id, draft)
                setRenaming(false)
              } else if (e.key === 'escape') setRenaming(false)
            }}
            onBlur={() => {
              store.renameWorkspace(ws.id, draft)
              setRenaming(false)
            }}
            style={{
              flexGrow: 1,
              marginLeft: 6,
              height: 18,
              fontSize: 11,
              fontFamily: FONT.ui,
              color: COLORS.textBright,
              backgroundColor: COLORS.inputBg,
              borderWidth: 1,
              borderColor: COLORS.accent,
              borderRadius: 3,
              paddingLeft: 4,
              paddingRight: 4,
            }}
          />
        ) : (
          <text
            testId={`workspace-name-${ws.id}`}
            style={{
              flexGrow: 1,
              marginLeft: 6,
              marginRight: 4,
              fontSize: 12,
              fontFamily: FONT.ui,
              fontWeight: '500',
              color: COLORS.textBright,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              pointerEvents: 'none',
            }}
          >
            {ws.name}
          </text>
        )}
        <text
          style={{
            fontSize: 10,
            fontFamily: FONT.mono,
            color: COLORS.muted,
            flexShrink: 0,
            marginRight: 4,
            pointerEvents: 'none',
          }}
        >
          {sessions.length}
        </text>
        {/* ＋：新建会话弹窗（目标工作区；抑制行激活） */}
        <div
          tabIndex={0}
          testId={`new-menu-${ws.id}`}
          onClick={() => {
            skipRow.current = true
            dialog.openToolMenu(ws.id)
          }}
          onKeyDown={(e) => {
            if (e.key === 'enter' || e.key === 'space') dialog.openToolMenu(ws.id)
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            flexShrink: 0,
            borderRadius: 3,
            hover: { backgroundColor: COLORS.closeHover },
          }}
        >
          <Icon name="plus" size={11} color={COLORS.muted} />
        </div>
        {/* 移除工作区（hover 行可见；onMouseDown 避开抑制竞争——同步移除元素逃逸冒泡） */}
        {hovered || renaming ? (
          <div
            testId={`remove-workspace-${ws.id}`}
            onMouseDown={() => {
              skipRow.current = true
              store.removeWorkspace(ws.id)
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 16,
              height: 16,
              flexShrink: 0,
              borderRadius: 3,
              hover: { backgroundColor: COLORS.closeHover },
            }}
          >
            <Icon name="close" size={10} color={COLORS.muted} />
          </div>
        ) : null}
      </div>

      {ws.expanded ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {sessions.length === 0 ? (
            /* 空组引导（原型 empty-hint）：可点按钮直接开工具菜单 */
            <div
              tabIndex={0}
              testId={`workspace-create-first-${ws.id}`}
              onClick={() => dialog.openToolMenu(ws.id)}
              onKeyDown={(e) => {
                if (e.key === 'enter' || e.key === 'space') dialog.openToolMenu(ws.id)
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                height: 22,
                marginLeft: SIZES.rowMarginX + SESSION_INDENT,
                marginRight: SIZES.rowMarginX,
                paddingLeft: SIZES.rowPaddingX,
                paddingRight: SIZES.rowPaddingX,
                borderRadius: 4,
                cursor: 'pointer',
                hover: { backgroundColor: COLORS.surface },
              }}
            >
              <text
                style={{
                  fontSize: 11,
                  fontFamily: FONT.ui,
                  color: COLORS.muted,
                  pointerEvents: 'none',
                }}
              >
                创建第一个会话
              </text>
            </div>
          ) : (
            <TimeGroupedSessions
              store={store}
              threadIds={sessions}
              indent={SESSION_INDENT}
              onManage={dialog.openManageSession}
            />
          )}
        </div>
      ) : null}
    </div>
  )
}

// ── 跨工作区搜索结果 ────────────────────────────────────────────────

function SearchResults({
  store,
  settings,
  query,
  onManage,
}: {
  store: ThreadStore
  settings: SettingsStore
  query: string
  onManage?: (threadId: string) => void
}) {
  // 订阅稳定引用（immer 结构共享：threads/workspaces 未变则引用不变），
  // 命中列表渲染期现算（uSES 的 getSnapshot 必须返回稳定引用——新数组会炸）
  const threads = useThreadStore(store, (s) => s.threads)
  const workspaces = useThreadStore(store, (s) => s.workspaces)
  const results = searchThreads(
    threads,
    workspaces,
    query,
    (pid) => settings.get().presets.items.find((p) => p.id === pid)?.label,
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, overflowY: 'scroll' }}>
      {results.length === 0 ? (
        <text
          style={{
            marginTop: 12,
            marginLeft: SIZES.rowMarginX + 8,
            fontSize: 11,
            fontFamily: FONT.ui,
            color: COLORS.muted,
            pointerEvents: 'none',
          }}
        >
          无匹配会话
        </text>
      ) : (
        results.map(({ thread, workspace }) => (
          <ThreadRow
            key={thread.id}
            id={thread.id}
            store={store}
            suffix={workspace?.name}
            onManage={onManage}
          />
        ))
      )}
    </div>
  )
}

function SearchResultsWithDialog({
  store,
  settings,
  query,
  dialog,
}: {
  store: ThreadStore
  settings: SettingsStore
  query: string
  dialog: DialogOpener
}) {
  return (
    <SearchResults store={store} settings={settings} query={query} onManage={dialog.openManageSession} />
  )
}
