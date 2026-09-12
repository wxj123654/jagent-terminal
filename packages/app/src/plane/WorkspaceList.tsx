/**
 * WorkspaceList — v2 双区侧栏列表（Phase D1；原型 desktop-plane-v2）。
 *
 * 结构：
 * - 「会话」区：无归属临时会话（workspaceId 未设），平铺创建序（原型
 *   tmp-sessions 无时间分组/截断）；区头 ＋ = 新建临时会话。
 * - 「工作区」区：工作区分组（箭头 toggle / 点行激活恢复 lastSession /
 *   ＋ 新建会话 / 「…」管理弹窗）。当前工作区（含活跃会话或起始页激活）
 *   = 4% 白底 + 名后 5px 状态点。组内会话挂 ws-body（左缩进 13 + 9 padding
 *   + 1px 竖线），时间分组 + 默认前 10 条（ws.showAll 持久化切换）。
 * - 搜索态由 Sidebar 传入 query：非空时整树切换为跨工作区结果列表
 *   （未归属行标注「未归属」）。
 *
 * 事件命中模型（T3.1）：GPUIX 子元素自带 listener 时冒泡到父 listener
 * （deepest-first）——箭头/＋/「…」钮与行 onClick 的冲突用「抑制 ref」。
 */

import { useRef, useState } from 'react'

import { Icon, COLORS, FONT } from '@jagent/ui'
import { useActiveTarget } from '../router'
import type { SettingsStore } from '../settings/store'
import type { ThreadStore } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import {
  searchThreads,
  TIME_GROUP_LABELS,
  timeGroupsOf,
  type TimeGroup,
} from '../threads/workspaces'
import { SIZES } from '../tokens'
import type { DialogOpener } from './DialogHost'
import { ThreadRow } from './ThreadRow'

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
    return (
      <SearchResultsWithDialog store={store} settings={settings} query={trimmed} dialog={dialog} />
    )
  }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        overflowY: 'scroll',
        // 原型 .sb-scroll：padding 2px 8px 8px——行不再自携水平外距
        paddingLeft: SIZES.rowMarginX,
        paddingRight: SIZES.rowMarginX,
        paddingTop: 2,
        paddingBottom: 8,
      }}
    >
      {/* ── 会话区（无归属临时会话）── */}
      <TempSessionsSection store={store} dialog={dialog} />
      {/* ── 工作区区 ── */}
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }}>
        <SectionHeader label="工作区">
          <GhostButton
            testId="add-workspace"
            label="添加工作区"
            icon="plus"
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

function SectionHeader({ label, children }: { label: string; children?: React.ReactNode }) {
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

/** 区头/工作区行 ghost 钮（v2 .ghost：22px 圆；无 icons 时 opacity 0） */
function GhostButton({
  testId,
  label: _label,
  icon,
  onClick,
}: {
  testId: string
  label: string
  icon: 'plus' | 'more'
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
      <Icon name={icon} size={13} />
    </div>
  )
}

// ── 时间分组 + load more（工作区组内；expanded = ws.showAll 持久化）───

function TimeGroupedSessions({
  store,
  workspaceId,
  threadIds,
  onManage,
}: {
  store: ThreadStore
  workspaceId: string
  /** 本组会话 id（创建序） */
  threadIds: string[]
  onManage?: (threadId: string) => void
}) {
  // 展开态 = ws.showAll（D10/D13：原型 ws 菜单「显示全部/最近 10 个」+
  // 行尾「展开其余/只显示最近」链接同义切换；持久化，重启恢复）
  const showAll = useThreadStore(
    store,
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.showAll ?? false,
  )
  // uSES 纪律：selector 必须返回稳定引用——订整个 threads（immer 结构共享），
  // 过滤在渲染期现算（新数组会炸 getSnapshot 缓存检查）
  const allThreads = useThreadStore(store, (s) => s.threads)
  const idSet = new Set(threadIds)
  const threads = allThreads.filter((t) => idSet.has(t.id))
  const groups = timeGroupsOf(threads)
  const order: TimeGroup[] = ['today', 'yesterday', 'week', 'earlier']
  const limit = showAll ? Infinity : GROUP_LIMIT

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
      : Math.max(0, threads.length - visible.reduce((n, v) => n + v.slice.length, 0))

  const toggle = () => store.setWorkspaceShowAll(workspaceId, !showAll)

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
              paddingLeft: 20,
              paddingTop: 6,
              paddingBottom: 2,
              pointerEvents: 'none',
            }}
          >
            {TIME_GROUP_LABELS[g]}
          </text>
          {slice.map((t) => (
            <ThreadRow key={t.id} id={t.id} store={store} onManage={onManage} />
          ))}
          {/* 「展开其余」/「只显示最近」：最后一个可见组下方（合计全组剩余） */}
          {hidden > 0 || (hiddenTotal > 0 && g === visible.at(-1)?.group) ? (
            <MoreLink testId={`load-more-${g}`} onClick={toggle}>
              展开其余 {hiddenTotal} 个
            </MoreLink>
          ) : showAll && threads.length > GROUP_LIMIT && g === visible.at(-1)?.group ? (
            <MoreLink testId="load-more-collapse" onClick={toggle}>
              只显示最近 10 个
            </MoreLink>
          ) : null}
        </div>
      ))}
    </>
  )
}

/** 「展开其余/只显示最近」行内链接（原型 .more-link）。
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
          fontSize: 11.5,
          fontFamily: FONT.ui,
          color: COLORS.muted,
          pointerEvents: 'none',
        }}
      >
        {children}
      </text>
    </div>
  )
}

// ── 会话区（无归属；原型平铺，无时间分组）───────────────────────────

function TempSessionsSection({ store, dialog }: { store: ThreadStore; dialog: DialogOpener }) {
  // 无归属会话 id 串（稳定订阅粒度：增删/顺序）
  const threadIds = useThreadStore(store, (s) =>
    s.threads
      .filter((t) => t.workspaceId == null)
      .map((t) => t.id)
      .join(','),
  )
  const ids = threadIds === '' ? [] : threadIds.split(',')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 4 }}>
      <SectionHeader label="会话">
        <GhostButton
          testId="new-temp-session"
          label="新建临时会话"
          icon="plus"
          onClick={() => dialog.openToolMenu('')}
        />
      </SectionHeader>
      {ids.length === 0 ? (
        <text
          style={{
            paddingLeft: 8,
            paddingTop: 5,
            paddingBottom: 8,
            fontSize: 12,
            fontFamily: FONT.ui,
            color: COLORS.faint,
            pointerEvents: 'none',
          }}
        >
          暂无未归属会话
        </text>
      ) : (
        ids.map((id) => (
          <ThreadRow key={id} id={id} store={store} onManage={dialog.openManageSession} />
        ))
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

  if (!ws) return null
  const sessions = sessionIds === '' ? [] : sessionIds.split(',')

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* 原型 .ws-head：padding 0 2，仅当前工作区 4% 底；hover 在 .ws-name 段 */}
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
          backgroundColor: isCurrent ? 'rgba(255,255,255,0.04)' : 'transparent',
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
              width: 12,
              height: 12,
              flexShrink: 0,
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
              {/* 当前工作区 5px 状态点（原型 .dot5） */}
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
        {/* 「…」管理（D10：重命名/显示全部/移除；hover 行可见，槽位常驻防位移） */}
        <div
          tabIndex={0}
          testId={`manage-workspace-${ws.id}`}
          onClick={() => {
            skipRow.current = true
            dialog.openManageWorkspace(ws.id)
          }}
          onKeyDown={(e) => {
            if (e.key === 'enter' || e.key === 'space') dialog.openManageWorkspace(ws.id)
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
            borderColor: 'rgba(255,255,255,0.06)',
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
            <TimeGroupedSessions
              store={store}
              workspaceId={ws.id}
              threadIds={sessions}
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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        overflowY: 'scroll',
        paddingLeft: SIZES.rowMarginX,
        paddingRight: SIZES.rowMarginX,
        paddingTop: 2,
      }}
    >
      {results.length === 0 ? (
        <text
          style={{
            marginTop: 12,
            marginLeft: 6,
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
            suffix={workspace?.name ?? '未归属'}
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
    <SearchResults
      store={store}
      settings={settings}
      query={query}
      onManage={dialog.openManageSession}
    />
  )
}
