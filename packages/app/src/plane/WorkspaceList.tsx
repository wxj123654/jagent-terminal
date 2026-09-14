/**
 * WorkspaceList — 侧栏列表（codex-sidebar-v2 方案 C；原型 codex-sidebar-v2）。
 *
 * 结构（原型 .scroll）：
 * - nav 行组：全宽文字行「新建会话 / 搜索」（图标 + label；替代 v2 头部
 *   图标条——头部只剩收起钮）。
 * - 「工作区」区：pin 排序的工作区分组（箭头 toggle / 点名激活恢复
 *   lastSession / ＋ 新建会话 / 「…」+ 右键项目菜单）。当前工作区
 *   （含活跃会话或起始页激活）= 4% 白底 + 名后 5px 状态点。
 * - 「未归属」虚拟组：无工作区会话归入（替代 v2 独立「会话」区）；有
 *   内容才渲染，无 … 菜单（虚拟组不可 pin/rename/remove）。
 * - 组内会话：priority 排序（pin > run > queue > unread > recency，
 *   workspaces.sortThreads）+ 默认前 4 条 + Show more/less；
 *   active/focus 行不被截断（lim 自动扩展包含它）。
 *
 * 上下文菜单（方案 C）：行内 hover 「…」与右键同一面菜单——
 * 会话：Pin / Rename… / Mark as unread / Remove；项目：Pin project /
 * Rename… / Remove project。Rename… → RenameDialog（DialogHost）。
 *
 * 事件命中模型（T3.1）：GPUIX 子元素自带 listener 时冒泡到父 listener
 * （deepest-first）——箭头/＋/「…」钮与行 onClick 的冲突用「抑制 ref」。
 */

import { useRef, useState } from 'react'

import { Icon, COLORS, FONT } from '@jagent/ui'
import { useActiveTarget } from '../router'
import type { ThreadStore } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { sortThreads, sortWorkspaces } from '../threads/workspaces'
import { SIZES } from '../tokens'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import type { DialogOpener } from './DialogHost'
import { ThreadRow } from './ThreadRow'

/** 原生目录选择 seam（W3）：resolve(path) / resolve(null) = 取消或不可用 */
export type DirectoryPicker = () => Promise<string | null>

/** 组内默认可见条数（方案 C：4 条 + Show more/less；active/focus 不被截断） */
const GROUP_LIMIT = 4

/** 上下文菜单目标（会话行 / 工作区行；未归属虚拟组无菜单） */
type MenuState =
  | { kind: 'thread'; id: string; x: number; y: number }
  | { kind: 'workspace'; id: string; x: number; y: number }

export function WorkspaceList({
  store,
  dialog,
  onNewSession,
}: {
  store: ThreadStore
  /** 弹窗入口（W7）：行 ＋ / 空组引导 → 新建会话弹窗；底部 → 添加工作区弹窗 */
  dialog: DialogOpener
  /** nav「新建会话」：目标工作区由调用方算（当前上下文；同 ⌘N） */
  onNewSession?: () => void
}) {
  const workspaces = useThreadStore(store, (s) => s.workspaces)
  const unassigned = useThreadStore(store, (s) =>
    s.threads
      .filter((t) => t.workspaceId == null)
      .map((t) => t.id)
      .join(','),
  )
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** 聚焦行 id（截断豁免：focus 行不被 Show more 截断） */
  const [focusTid, setFocusTid] = useState<string | null>(null)
  const active = useActiveTarget()
  const keepId = (active?.type === 'thread' ? active.id : null) ?? focusTid

  const unassignedIds = unassigned === '' ? [] : unassigned.split(',')

  const menuItems = (m: MenuState): ContextMenuItem[] => {
    if (m.kind === 'thread') {
      const t = store.getState().threads.find((x) => x.id === m.id)
      if (!t) return []
      return [
        { id: 'pin', label: t.pin ? '取消置顶' : '置顶' },
        { id: 'rename', label: '重命名…' },
        { id: 'unread', label: t.unread ? '标记为已读' : '标记为未读' },
        'sep',
        { id: 'remove', label: '移除', danger: true },
      ]
    }
    const ws = store.getState().workspaces.find((w) => w.id === m.id)
    if (!ws) return []
    return [
      { id: 'pin', label: ws.pin ? '取消置顶' : '置顶工作区' },
      { id: 'rename', label: '重命名…' },
      'sep',
      { id: 'remove', label: '移除工作区', danger: true },
    ]
  }

  const runMenu = (m: MenuState, id: string) => {
    if (m.kind === 'thread') {
      if (id === 'pin') {
        const t = store.getState().threads.find((x) => x.id === m.id)
        if (t) store.setThreadPinned(m.id, !t.pin)
      } else if (id === 'unread') {
        const t = store.getState().threads.find((x) => x.id === m.id)
        if (t) store.setThreadUnread(m.id, !t.unread)
      } else if (id === 'rename') dialog.openRename({ type: 'thread', id: m.id })
      else if (id === 'remove') store.close(m.id)
      return
    }
    if (id === 'pin') {
      const ws = store.getState().workspaces.find((w) => w.id === m.id)
      if (ws) store.setWorkspacePinned(m.id, !ws.pin)
    } else if (id === 'rename') dialog.openRename({ type: 'workspace', id: m.id })
    else if (id === 'remove') store.removeWorkspace(m.id)
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        overflowY: 'scroll',
        // 原型 .scroll：padding 2px 8px 8px——行不再自携水平外距
        paddingLeft: SIZES.rowMarginX,
        paddingRight: SIZES.rowMarginX,
        paddingTop: 2,
        paddingBottom: 8,
      }}
    >
      {/* ── nav 行组（方案 C：全宽文字行替代头部图标条）── */}
      <NavRow testId="nav-new-chat" icon="plus" label="新建会话" onClick={() => onNewSession?.()} />
      <NavRow testId="nav-search" icon="search" label="搜索" onClick={() => dialog.openSearch()} />

      {/* ── 工作区区（pin 排序；未归属虚拟组排最后）── */}
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
        <SectionHeader label="工作区">
          {(hovered) => (
            <GhostButton
              testId="add-workspace"
              label="添加工作区"
              icon="plus"
              visible={hovered}
              onClick={() => dialog.openAddWorkspace()}
            />
          )}
        </SectionHeader>
        {sortWorkspaces(workspaces).map((ws) => (
          <WorkspaceGroup
            key={ws.id}
            store={store}
            workspaceId={ws.id}
            dialog={dialog}
            keepId={keepId}
            onFocusRow={setFocusTid}
            onMenu={(pos) => setMenu({ kind: 'workspace', id: ws.id, ...pos })}
            onThreadMenu={(tid, pos) => setMenu({ kind: 'thread', id: tid, ...pos })}
          />
        ))}
        {unassignedIds.length > 0 ? (
          <UnassignedGroup
            store={store}
            dialog={dialog}
            keepId={keepId}
            onFocusRow={setFocusTid}
            onThreadMenu={(tid, pos) => setMenu({ kind: 'thread', id: tid, ...pos })}
          />
        ) : null}
      </div>

      {/* 上下文菜单（行内 「…」与右键同一面；anchored 到点击点） */}
      {menu ? (
        <ContextMenu
          position={{ x: menu.x, y: menu.y }}
          items={menuItems(menu)}
          onPick={(id) => runMenu(menu, id)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}

// ── nav 行（原型 .nav：全宽文字行，图标 16px 槽 + label）────────────

function NavRow({
  testId,
  icon,
  label,
  onClick,
}: {
  testId: string
  icon: 'plus' | 'search'
  label: string
  onClick: () => void
}) {
  // 原型 .nav:hover：底色 + 文字/图标 t2→t1 提亮
  const [hovered, setHovered] = useState(false)
  return (
    <div
      testId={testId}
      tabIndex={0}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onClick()
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        height: 30,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: SIZES.rowRadius,
        cursor: 'pointer',
        hover: { backgroundColor: COLORS.surface },
      }}
    >
      <div
        style={{
          width: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          pointerEvents: 'none',
        }}
      >
        <Icon name={icon} size={14} color={hovered ? COLORS.textBright : COLORS.muted} />
      </div>
      <text
        style={{
          fontSize: 13,
          fontFamily: FONT.ui,
          color: hovered ? COLORS.textBright : COLORS.text,
          pointerEvents: 'none',
        }}
      >
        {label}
      </text>
    </div>
  )
}

// ── 区头（v2 sec-head：label + ghost ＋）────────────────────────────

function SectionHeader({
  label,
  children,
}: {
  label: string
  /** render-prop：原型 .sec:hover .gh——ghost 钮只在区头 hover 时显 */
  children?: (hovered: boolean) => React.ReactNode
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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
      {children?.(hovered)}
    </div>
  )
}

/** 区头/工作区行 ghost 钮（v2 .ghost：22px 圆；无 icons 时 opacity 0） */
function GhostButton({
  testId,
  label: _label,
  icon,
  visible = true,
  onClick,
}: {
  testId: string
  label: string
  icon: 'plus' | 'more'
  /** 原型 .gh：默认 opacity 0，父行 hover/focus-visible 才显（槽位常驻防位移） */
  visible?: boolean
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
        opacity: visible ? 1 : 0,
        hover: { backgroundColor: COLORS.surface, color: COLORS.textBright },
      }}
    >
      <Icon name={icon} size={13} />
    </div>
  )
}

// ── 组内会话：priority 排序 + 截断（方案 C：4 条 + Show more/less）───

function SessionRows({
  store,
  threadIds,
  showAll,
  onToggleShowAll,
  keepId,
  onFocusRow,
  onThreadMenu,
  moreTestId,
}: {
  store: ThreadStore
  /** 本组会话 id（创建序；排序在渲染期现算） */
  threadIds: string[]
  showAll: boolean
  onToggleShowAll: () => void
  /** active/focus 行 id（不被截断——lim 自动扩展包含它） */
  keepId: string | null
  onFocusRow: (threadId: string) => void
  onThreadMenu: (threadId: string, pos: { x: number; y: number }) => void
  moreTestId: string
}) {
  // uSES 纪律：selector 必须返回稳定引用——订整个 threads（immer 结构共享），
  // 过滤在渲染期现算（新数组会炸 getSnapshot 缓存检查）
  const allThreads = useThreadStore(store, (s) => s.threads)
  const idSet = new Set(threadIds)
  const sorted = sortThreads(allThreads.filter((t) => idSet.has(t.id)))

  let limit = showAll ? sorted.length : GROUP_LIMIT
  // active/focus 行不被截断（原型：lim 扩展到包含 keepId）
  if (keepId) {
    const ix = sorted.findIndex((t) => t.id === keepId)
    if (ix >= limit) limit = ix + 1
  }
  const visible = sorted.slice(0, limit)
  const hidden = sorted.length - visible.length

  return (
    <>
      {visible.map((t) => (
        <ThreadRow
          key={t.id}
          id={t.id}
          store={store}
          onMenu={onThreadMenu}
          onFocusRow={onFocusRow}
        />
      ))}
      {hidden > 0 ? (
        <MoreLink testId={moreTestId} onClick={onToggleShowAll}>
          展开其余 {hidden} 个
        </MoreLink>
      ) : showAll && sorted.length > GROUP_LIMIT ? (
        <MoreLink testId={moreTestId} onClick={onToggleShowAll}>
          只显示前 {GROUP_LIMIT} 个
        </MoreLink>
      ) : null}
    </>
  )
}

/** 「展开其余/只显示前 N 个」行内链接（原型 .more）。
 *  children 走 JSX 插值分片（数字是独立 text 节点——测试按相邻节点断言） */
function MoreLink({
  testId,
  children,
  onClick,
}: {
  testId: string
  children: React.ReactNode
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
        height: 26,
        paddingLeft: 20,
        paddingRight: 6,
        borderRadius: SIZES.rowRadius,
        cursor: 'pointer',
        hover: { backgroundColor: COLORS.surface },
      }}
    >
      <text
        style={{
          // 插值分片（「展开其余 {n} 个」= 3 个 text 子节点）默认 column
          // 堆叠会竖排折行——flex row 让它们横排成一行
          display: 'flex',
          flexDirection: 'row',
          fontSize: 11.5,
          fontFamily: FONT.ui,
          color: COLORS.muted,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}
      >
        {children}
      </text>
    </div>
  )
}

// ── 未归属虚拟组（无工作区会话；有内容才渲染，无 … 菜单）─────────────

function UnassignedGroup({
  store,
  dialog,
  keepId,
  onFocusRow,
  onThreadMenu,
}: {
  store: ThreadStore
  dialog: DialogOpener
  keepId: string | null
  onFocusRow: (threadId: string) => void
  onThreadMenu: (threadId: string, pos: { x: number; y: number }) => void
}) {
  const sessionIds = useThreadStore(store, (s) =>
    s.threads
      .filter((t) => t.workspaceId == null)
      .map((t) => t.id)
      .join(','),
  )
  // 虚拟组：expanded/showAll 是本地态（无工作区实体可持久化）
  const [expanded, setExpanded] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const [hovered, setHovered] = useState(false)
  const skipRow = useRef(false)

  const sessions = sessionIds === '' ? [] : sessionIds.split(',')
  if (sessions.length === 0) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          height: 28,
          paddingLeft: 2,
          paddingRight: 2,
          borderRadius: SIZES.rowRadius,
          // 原型 .ws-head:hover 整行高亮
          hover: { backgroundColor: COLORS.surface },
          userSelect: 'none',
        }}
      >
        <div
          testId="workspace-unassigned"
          tabIndex={0}
          onClick={() => {
            if (skipRow.current) {
              skipRow.current = false
              return
            }
            // 点组名 = 激活组内最高优先级会话（原型 ws-name 语义）
            const first = sortThreads(
              store.getState().threads.filter((t) => t.workspaceId == null),
            )[0]
            if (first) store.activate({ type: 'thread', id: first.id })
          }}
          onKeyDown={(e) => {
            if (e.key === 'enter') {
              const first = sortThreads(
                store.getState().threads.filter((t) => t.workspaceId == null),
              )[0]
              if (first) store.activate({ type: 'thread', id: first.id })
            }
          }}
          style={{
            display: 'flex',
            flexDirection: 'row',
            flexGrow: 1,
            minWidth: 0,
            alignItems: 'center',
            height: 26,
            paddingLeft: 6,
            paddingRight: 6,
            gap: 5,
            borderRadius: SIZES.rowRadius,
            cursor: 'pointer',
          }}
        >
          <div
            testId="workspace-toggle-unassigned"
            onClick={() => {
              skipRow.current = true
              setExpanded((v) => !v)
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 12,
              height: 12,
              flexShrink: 0,
              borderRadius: 3,
              hover: { backgroundColor: COLORS.surfaceHover },
            }}
          >
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} color={COLORS.faint} />
          </div>
          <Icon name="folder" size={14} color={COLORS.muted} />
          <text
            testId="workspace-name-unassigned"
            style={{
              flexGrow: 1,
              minWidth: 0,
              fontSize: 13,
              fontFamily: FONT.ui,
              fontWeight: '500',
              color: COLORS.text,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              pointerEvents: 'none',
            }}
          >
            未归属
          </text>
        </div>
        {/* ＋：新建会话弹窗（未归属目标；抑制行激活）。无 … 菜单——
            虚拟组不可 pin/rename/remove */}
        <div
          tabIndex={0}
          testId="new-menu-unassigned"
          onClick={() => {
            skipRow.current = true
            dialog.openToolMenu('')
          }}
          onKeyDown={(e) => {
            if (e.key === 'enter' || e.key === 'space') dialog.openToolMenu('')
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            flexShrink: 0,
            borderRadius: 9999,
            opacity: hovered ? 1 : 0,
            hover: { backgroundColor: COLORS.surfaceHover },
          }}
        >
          <Icon name="plus" size={12} color={COLORS.muted} />
        </div>
      </div>

      {expanded ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            marginLeft: 13,
            paddingLeft: 9,
            borderLeftWidth: 1,
            borderColor: COLORS.borderSubtle,
          }}
        >
          <SessionRows
            store={store}
            threadIds={sessions}
            showAll={showAll}
            onToggleShowAll={() => setShowAll((v) => !v)}
            keepId={keepId}
            onFocusRow={onFocusRow}
            onThreadMenu={onThreadMenu}
            moreTestId="load-more-unassigned"
          />
        </div>
      ) : null}
    </div>
  )
}

// ── 工作区分组 ───────────────────────────────────────────────────────

function WorkspaceGroup({
  store,
  workspaceId,
  dialog,
  keepId,
  onFocusRow,
  onMenu,
  onThreadMenu,
}: {
  store: ThreadStore
  workspaceId: string
  dialog: DialogOpener
  keepId: string | null
  onFocusRow: (threadId: string) => void
  /** 「…」/ 右键 → 项目菜单（Pin/Rename/Remove） */
  onMenu: (pos: { x: number; y: number }) => void
  onThreadMenu: (threadId: string, pos: { x: number; y: number }) => void
}) {
  const ws = useThreadStore(store, (s) => s.workspaces.find((w) => w.id === workspaceId))
  // 会话 id 串（顺序/增删粒度）；行内容 ThreadRow 自订
  const sessionIds = useThreadStore(store, (s) =>
    s.threads
      .filter((t) => t.workspaceId === workspaceId)
      .map((t) => t.id)
      .join(','),
  )
  // 当前工作区（D10 4% 底 + 5px 点）：起始页激活 or 活跃会话归属
  const active = useActiveTarget()
  const isCurrent = useThreadStore(store, (s) => {
    if (active?.type === 'workspace') return active.id === workspaceId
    if (active?.type === 'thread')
      return s.threads.find((t) => t.id === active.id)?.workspaceId === workspaceId
    return false
  })
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [hovered, setHovered] = useState(false)
  /** 行内按钮 → 行 onClick 抑制（本行实例；同批 click 消费一次） */
  const skipRow = useRef(false)
  /** 行上最后一次指针位置（键盘打开菜单的定位兜底） */
  const lastPointer = useRef({ x: 0, y: 0 })

  if (!ws) return null
  const sessions = sessionIds === '' ? [] : sessionIds.split(',')

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* 原型 .ws-head：padding 0 2，仅当前工作区 4% 底；hover 在 .ws-name 段。
          右键 = 「…」同一面项目菜单 */}
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onMouseMove={(e) => {
          lastPointer.current = { x: e.x ?? 0, y: e.y ?? 0 }
        }}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        onAuxClick={(e) => {
          if (e.isRightClick) onMenu({ x: e.x ?? 0, y: e.y ?? 0 })
        }}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          height: 28,
          paddingLeft: 2,
          paddingRight: 2,
          borderRadius: SIZES.rowRadius,
          backgroundColor: isCurrent ? COLORS.tile : 'transparent',
          // 原型 .ws-head:hover 整行高亮；.cur:hover 保持 cur 底不再叠加
          hover: { backgroundColor: isCurrent ? COLORS.tile : COLORS.surface },
          userSelect: 'none',
        }}
      >
        {/* .ws-name（chev + folder + 名 + dot5）：点行激活，双击重命名 */}
        <div
          testId={`workspace-${ws.id}`}
          tabIndex={0}
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
            flexGrow: 1,
            minWidth: 0,
            alignItems: 'center',
            height: 26,
            paddingLeft: 6,
            paddingRight: 6,
            gap: 5,
            borderRadius: SIZES.rowRadius,
            cursor: 'pointer',
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
              width: 12,
              height: 12,
              flexShrink: 0,
              borderRadius: 3,
              hover: { backgroundColor: COLORS.surfaceHover },
            }}
          >
            <Icon
              name={ws.expanded ? 'chevronDown' : 'chevronRight'}
              size={12}
              color={COLORS.faint}
            />
          </div>
          <Icon name="folder" size={14} color={COLORS.muted} />
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
                height: 18,
                fontSize: 11,
                fontFamily: FONT.ui,
                color: COLORS.textBright,
                backgroundColor: COLORS.inputBg,
                borderWidth: 1,
                borderColor: COLORS.focusBorder,
                borderRadius: 3,
                paddingLeft: 4,
                paddingRight: 4,
              }}
            />
          ) : (
            <>
              <text
                testId={`workspace-name-${ws.id}`}
                style={{
                  flexGrow: 1,
                  minWidth: 0,
                  fontSize: 13,
                  fontFamily: FONT.ui,
                  fontWeight: '500',
                  color: COLORS.text,
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                  pointerEvents: 'none',
                }}
              >
                {ws.name}
              </text>
              {/* 当前工作区 5px 状态点（原型 .cur-dot） */}
              {isCurrent ? (
                <div
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 9999,
                    backgroundColor: COLORS.g300,
                    flexShrink: 0,
                  }}
                />
              ) : null}
            </>
          )}
        </div>
        {/* 「…」项目菜单（方案 C：Pin/Rename/Remove；hover 行可见，槽位常驻防位移） */}
        <div
          tabIndex={0}
          testId={`menu-workspace-${ws.id}`}
          onClick={(e) => {
            skipRow.current = true
            onMenu({ x: e.x ?? lastPointer.current.x, y: e.y ?? lastPointer.current.y })
          }}
          onKeyDown={(e) => {
            if (e.key === 'enter' || e.key === 'space') onMenu(lastPointer.current)
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            flexShrink: 0,
            borderRadius: 9999,
            opacity: hovered || renaming ? 1 : 0,
            hover: { backgroundColor: COLORS.surfaceHover },
          }}
        >
          <Icon name="more" size={12} color={COLORS.muted} />
        </div>
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
            width: 22,
            height: 22,
            flexShrink: 0,
            borderRadius: 9999,
            opacity: hovered || renaming ? 1 : 0,
            hover: { backgroundColor: COLORS.surfaceHover },
          }}
        >
          <Icon name="plus" size={12} color={COLORS.muted} />
        </div>
      </div>

      {ws.expanded ? (
        // 原型 .ws-body：左缩进 13 + 9 padding + 1px 竖线
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            marginLeft: 13,
            paddingLeft: 9,
            borderLeftWidth: 1,
            borderColor: COLORS.borderSubtle,
          }}
        >
          {sessions.length === 0 ? (
            /* 空组引导（原型 empty-hint）：可点按钮直接开工具弹窗 */
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
                marginLeft: 4,
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
            <SessionRows
              store={store}
              threadIds={sessions}
              showAll={ws.showAll ?? false}
              onToggleShowAll={() => store.setWorkspaceShowAll(ws.id, !(ws.showAll ?? false))}
              keepId={keepId}
              onFocusRow={onFocusRow}
              onThreadMenu={onThreadMenu}
              moreTestId={`load-more-${ws.id}`}
            />
          )}
        </div>
      ) : null}
    </div>
  )
}
