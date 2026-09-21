/**
 * WorkspaceList — 侧栏列表（React 原型 design/prototype-react Sidebar.tsx；
 * R4 严格对齐——替代 codex-sidebar-v2 方案 C 的激活模型）。
 *
 * 结构（原型 #sidebar 中段）：
 * - .sb-nav（固定不滚 + 底部分隔线）：全宽文字行「新建会话 / 搜索」。
 * - .sec-head「工作区」（固定不滚）：10px/600 标签 + ＋ ghost（.75→hover 1）。
 * - .sb-scroll：pin 排序的工作区分组（.ws-row 整行点击 = 折叠/展开——
 *   原型无独立箭头钮、不激活工作区；ws-mark 文件夹标 + 名字 +
 *   .acts ghost 组 hover/focus-within 显隐 + 右键/「…」同一面项目菜单）
 *   + 「未归属会话」虚拟组（inbox 标，纯展示恒展开，无 ghost/菜单）。
 * - 组内会话：priority 排序（pin > run > queue > unread > recency，
 *   workspaces.sortThreads）+ 默认前 4 条 + 「显示另外 N 个/收起会话」；
 *   active/focus 行不被截断（lim 自动扩展包含它）。.ws-body 缩进 +
 *   1px 引导线（6% 白，看板 R4 项——React 原型 margin 1 0 5 12 无线，
 *   保留线作归属锚点）。
 *
 * 上下文菜单：行内 hover 「…」与右键同一面菜单（原型 CtxMenu/DropMenu
 * 同项）——会话：置顶 / 重命名… / 标记为未读 / 移除；工作区：置顶工作区 /
 * 重命名… / 移除工作区。Rename… → RenameDialog（DialogHost）。
 *
 * 事件命中模型：GPUIX/gpui 鼠标事件不冒泡——命中 deepest 有 handler 的
 * 元素；ghost 组未 hover 时 pointerEvents:none，右缘保留带点击穿透给
 * ws-row 折叠（原型 .acts opacity 0 + pointer-events:none 同款）。
 */

import { useRef, useState } from 'react'

import { Icon, COLORS, FONT } from '@jagent/ui'
import type { DialogOpener } from '../dialogs/DialogHost'
import { useActiveTarget } from '../router'
import type { ThreadStore } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { sortThreads, sortWorkspaces } from '../threads/workspaces'
import { SIZES } from '../tokens'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
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
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
      {/* ── nav 行组（原型 .sb-nav：固定不滚 + 底部分隔线）── */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          padding: 8,
          borderBottomWidth: 1,
          borderColor: COLORS.borderSubtle,
          flexShrink: 0,
        }}
      >
        <NavRow
          testId="nav-new-chat"
          icon="plus"
          label="新建会话"
          onClick={() => onNewSession?.()}
        />
        <NavRow
          testId="nav-search"
          icon="search"
          label="搜索"
          onClick={() => dialog.openSearch()}
        />
      </div>

      {/* ── 区头「工作区」（原型 .sec-head：固定不滚；＋ ghost .75→hover 1）── */}
      <SectionHeader label="工作区">
        {(hovered) => (
          <GhostButton
            testId="add-workspace"
            label="添加工作区"
            icon="plus"
            restingOpacity={0.75}
            visible={hovered}
            onClick={() => dialog.openAddWorkspace()}
          />
        )}
      </SectionHeader>

      {/* ── 滚动区（原型 .sb-scroll：padding 2px 8px 8px；只装分组）── */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          minHeight: 0,
          overflowY: 'scroll',
          paddingLeft: SIZES.rowMarginX,
          paddingRight: SIZES.rowMarginX,
          paddingTop: 2,
          paddingBottom: 8,
        }}
      >
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
        // 原型 .nav-row（第二段）：h34 r8 pad 0 9；hover 底 surface
        height: 34,
        paddingLeft: 9,
        paddingRight: 9,
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
  /** render-prop：原型 .sec-head:hover .ghost——ghost 钮区头 hover 时全亮 */
  children?: (hovered: boolean) => React.ReactNode
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        flexShrink: 0,
        // 原型 .sec-head（第二段）：margin-top 12 + padding 6 5 4 9 + min-h 28
        minHeight: 28,
        marginTop: 12,
        paddingLeft: 9,
        paddingRight: 5,
        paddingTop: 6,
        paddingBottom: 4,
      }}
    >
      <text
        style={{
          // 原型 .sec-head .t（第二段）：10px/600 大写追踪（CJK 无大小写，
          // letter-spacing .1em 无 GPUIX 面——不映射）
          fontSize: 10,
          fontFamily: FONT.ui,
          fontWeight: '600',
          color: COLORS.muted,
          pointerEvents: 'none',
        }}
      >
        {label}
      </text>
      {/* ghost 钮推到行右缘（原型 justify-content:space-between） */}
      <div style={{ flexGrow: 1 }} />
      {children?.(hovered)}
    </div>
  )
}

/** 区头/工作区行 ghost 钮（原型 .ghost：24×24 r8；sec-head 内常态 .75，
 *  ws-head 内 0→hover 1；槽位常驻防位移） */
function GhostButton({
  testId,
  label: _label,
  icon,
  restingOpacity = 0,
  visible = true,
  onClick,
}: {
  testId: string
  label: string
  icon: 'plus' | 'more'
  /** 未 hover 时的基线透明度（sec-head .75 / ws-head 0） */
  restingOpacity?: number
  /** 父行 hover/focus 时 true → opacity 1 */
  visible?: boolean
  onClick: () => void
}) {
  // GPUIX SVG tint 只读元素自身 style.color——hover 提亮要本地态换色
  const [hovered, setHovered] = useState(false)
  return (
    <div
      tabIndex={0}
      testId={testId}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onClick()
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        borderRadius: 8,
        cursor: 'pointer',
        opacity: visible ? 1 : restingOpacity,
        hover: { backgroundColor: COLORS.surface },
      }}
    >
      <Icon name={icon} size={12} color={hovered ? COLORS.textBright : COLORS.muted} />
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
        <MoreLink testId={moreTestId} icon="chevronDown" onClick={onToggleShowAll}>
          显示另外 {hidden} 个
        </MoreLink>
      ) : showAll && sorted.length > GROUP_LIMIT ? (
        <MoreLink testId={moreTestId} icon="chevronUp" onClick={onToggleShowAll}>
          收起会话
        </MoreLink>
      ) : null}
    </>
  )
}

/** 「显示另外 N 个/收起会话」行内链接（原型 .more-link：h27 padl 7 gap 5 r5
 *  11px muted + chevron 11；hover 2.5% 白底 + text）。
 *  children 走 JSX 插值分片（数字是独立 text 节点——测试按相邻节点断言） */
function MoreLink({
  testId,
  icon,
  children,
  onClick,
}: {
  testId: string
  icon: 'chevronDown' | 'chevronUp'
  children: React.ReactNode
  onClick: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      tabIndex={0}
      testId={testId}
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
        gap: 5,
        height: 27,
        paddingLeft: 7,
        paddingRight: 7,
        borderRadius: 5,
        cursor: 'pointer',
        hover: { backgroundColor: 'rgba(255,255,255,0.025)' },
      }}
    >
      <Icon name={icon} size={11} color={hovered ? COLORS.text : COLORS.muted} />
      <text
        style={{
          // 插值分片（「显示另外 {n} 个」= 3 个 text 子节点）默认 column
          // 堆叠会竖排折行——flex row 让它们横排成一行
          display: 'flex',
          flexDirection: 'row',
          fontSize: 11,
          fontFamily: FONT.ui,
          color: hovered ? COLORS.text : COLORS.muted,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}
      >
        {children}
      </text>
    </div>
  )
}

// ── 未归属虚拟组（原型 .ws-row.unassigned：inbox 标 + 恒展开纯展示，
//  无折叠/点击/ghost/菜单）────────────────────────────────────────────

function UnassignedGroup({
  store,
  keepId,
  onFocusRow,
  onThreadMenu,
}: {
  store: ThreadStore
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
  // 虚拟组：showAll 是本地态（无工作区实体可持久化）
  const [showAll, setShowAll] = useState(false)

  const sessions = sessionIds === '' ? [] : sessionIds.split(',')
  if (sessions.length === 0) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 3 }}>
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'row', flexShrink: 0 }}>
        {/* 原型 .ws-row.unassigned：h34 pad 0 5，cursor default（纯分组标，
            不折叠不激活） */}
        <div
          testId="workspace-unassigned"
          style={{
            display: 'flex',
            flexDirection: 'row',
            flexGrow: 1,
            minWidth: 0,
            alignItems: 'center',
            height: 34,
            paddingLeft: 5,
            paddingRight: 5,
            gap: 7,
            borderRadius: SIZES.rowRadius,
            cursor: 'default',
            userSelect: 'none',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              flexShrink: 0,
              borderRadius: 5,
              pointerEvents: 'none',
            }}
          >
            <Icon name="inbox" size={13} color={COLORS.muted} />
          </div>
          <text
            testId="workspace-name-unassigned"
            style={{
              flexGrow: 1,
              minWidth: 0,
              fontSize: 12.5,
              fontFamily: FONT.ui,
              fontWeight: '550',
              color: COLORS.text,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              pointerEvents: 'none',
            }}
          >
            未归属会话
          </text>
        </div>
      </div>

      {/* ws-body：margin 1 0 5 12（原型值）+ 1px 竖引导线（6% 白——看板
          R4 项，React 原型无线，保留作归属锚点；线占原型行左缘那 1px，
          行 x/w 与原型一致：x=21 w=235 vs 原型 x=20 w=235） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          marginLeft: 12,
          marginTop: 1,
          marginBottom: 5,
          borderLeftWidth: 1,
          borderColor: 'rgba(255,255,255,0.06)',
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
  const [hovered, setHovered] = useState(false)
  /** 行上最后一次指针位置（键盘打开菜单的定位兜底） */
  const lastPointer = useRef({ x: 0, y: 0 })

  if (!ws) return null
  const sessions = sessionIds === '' ? [] : sessionIds.split(',')

  return (
    // 原型 .ws-group：组间距 margin-bottom 3
    <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 3 }}>
      {/* 原型 .ws-head：relative（.acts 绝对定位的锚）。右键 = 「…」同一面
          项目菜单；hover/focus-within 亮 ghost（.ghost 0→1 + pe 恢复） */}
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
          position: 'relative',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          flexShrink: 0,
          userSelect: 'none',
        }}
      >
        {/* 原型 .ws-row：h34 pad 0 50 0 5 gap 7 r8——整行点击 = 折叠/展开
            （React 原型无独立箭头钮、不激活工作区；Enter/Space toggle，
            ArrowRight 展开、ArrowLeft 收起。GPUI key 名 = left/right，
            兼容 DOM 风格 arrowleft/arrowright） */}
        <div
          testId={`workspace-${ws.id}`}
          tabIndex={0}
          onClick={() => store.toggleWorkspaceExpanded(ws.id)}
          onKeyDown={(e) => {
            if (e.key === 'enter' || e.key === 'space') store.toggleWorkspaceExpanded(ws.id)
            else if ((e.key === 'right' || e.key === 'arrowright') && !ws.expanded)
              store.toggleWorkspaceExpanded(ws.id)
            else if ((e.key === 'left' || e.key === 'arrowleft') && ws.expanded)
              store.toggleWorkspaceExpanded(ws.id)
          }}
          style={{
            display: 'flex',
            flexDirection: 'row',
            flexGrow: 1,
            minWidth: 0,
            alignItems: 'center',
            height: 34,
            paddingLeft: 5,
            paddingRight: 50,
            gap: 7,
            borderRadius: SIZES.rowRadius,
            cursor: 'pointer',
            hover: { backgroundColor: 'rgba(255,255,255,0.035)' },
          }}
        >
          {/* .ws-mark：22×22 槽位 folder 13，行 hover muted→text */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              flexShrink: 0,
              borderRadius: 5,
              pointerEvents: 'none',
            }}
          >
            <Icon name="folder" size={13} color={hovered ? COLORS.text : COLORS.muted} />
          </div>
          <text
            testId={`workspace-name-${ws.id}`}
            style={{
              flexGrow: 1,
              minWidth: 0,
              // 原型 .ws-row .name：12.5px/550
              fontSize: 12.5,
              fontFamily: FONT.ui,
              fontWeight: '550',
              color: COLORS.text,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              pointerEvents: 'none',
            }}
          >
            {ws.name}
          </text>
        </div>
        {/* 原型 .ws-head .acts：absolute right 3 top 5——「…」项目菜单 + ＋
            新建会话（ghost 24×24）；未 hover 时 opacity 0 + pe:none
            （右缘 50px 保留带内点击穿透给 ws-row 折叠） */}
        <div
          style={{
            position: 'absolute',
            right: 3,
            top: 5,
            display: 'flex',
            flexDirection: 'row',
            flexShrink: 0,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? 'auto' : 'none',
          }}
        >
          <GhostButton
            testId={`menu-workspace-${ws.id}`}
            label="工作区菜单"
            icon="more"
            onClick={() => onMenu(lastPointer.current)}
          />
          <GhostButton
            testId={`new-menu-${ws.id}`}
            label="新建会话"
            icon="plus"
            onClick={() => dialog.openToolMenu(ws.id)}
          />
        </div>
      </div>

      {ws.expanded ? (
        // .ws-body：margin 1 0 5 12（原型值）+ 1px 竖引导线（6% 白——看板
        // R4 项，React 原型无线，保留作归属锚点；线占原型行左缘那 1px，
        // 行 x/w 与原型一致：x=21 w=235 vs 原型 x=20 w=235）
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            marginLeft: 12,
            marginTop: 1,
            marginBottom: 5,
            borderLeftWidth: 1,
            borderColor: 'rgba(255,255,255,0.06)',
          }}
        >
          {sessions.length === 0 ? (
            /* 空组引导（原型 .ws-empty-hint：h28 pad 0 7 gap 6 r5 +
               plus 11 + 11.5px muted「启动第一个会话」） */
            <div
              tabIndex={0}
              testId={`workspace-create-first-${ws.id}`}
              onClick={() => dialog.openToolMenu(ws.id)}
              onKeyDown={(e) => {
                if (e.key === 'enter' || e.key === 'space') dialog.openToolMenu(ws.id)
              }}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                height: 28,
                paddingLeft: 7,
                paddingRight: 7,
                borderRadius: 5,
                cursor: 'pointer',
                hover: { backgroundColor: 'rgba(255,255,255,0.035)' },
              }}
            >
              <Icon name="plus" size={11} color={COLORS.muted} />
              <text
                style={{
                  fontSize: 11.5,
                  fontFamily: FONT.ui,
                  color: COLORS.muted,
                  pointerEvents: 'none',
                }}
              >
                启动第一个会话
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
