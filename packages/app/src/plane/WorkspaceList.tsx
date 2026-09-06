/**
 * WorkspaceList — 侧栏工作区分组树（Phase W2；原型 workspace-plane.md）。
 *
 * 结构：WorkspaceRow（箭头/folder+名称/会话数/＋/移除）+ 展开时的归属会话行
 * （ThreadRow indent）+ 底部「添加工作区」内联表单。搜索态由 Sidebar 传入
 * query：非空时整树切换为跨工作区结果列表（标题/工具/目录匹配，行尾标注
 * 工作区名，见 threads/workspaces.ts searchThreads）。
 *
 * 事件命中模型（T3.1 结论）：GPUIX 子元素自带 listener 时冒泡到父 listener
 * （deepest-first）——箭头/＋/移除钮与行 onClick 的冲突用「抑制 ref」模式：
 * 按钮 handler 先置位（useRef，React 同批可靠），行 handler 消费后跳过。
 *
 * 交互（原型契约）：点行 = 激活工作区（恢复上次会话）；点箭头 = 仅展开/
 * 收起；双击行 = 重命名（与 ThreadRow 双击 rename 同构）；「浏览…」目录
 * 选择是 W3（目录选择 seam）；W2 表单先手输路径。
 */

import { useRef, useState } from 'react'

import type { SettingsStore } from '../settings/store'
import type { ThreadStore } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { searchThreads } from '../threads/workspaces'
import { Icon } from '../ui/Icon'
import { COLORS, FONT, SIZES } from '../ui/tokens'
import type { DialogOpener } from './DialogHost'
import { ThreadRow } from './ThreadRow'

/** 会话行在分组下的缩进（视觉分组） */
const SESSION_INDENT = 12

/** 原生目录选择 seam（W3）：resolve(path) / resolve(null) = 取消或不可用 */
export type DirectoryPicker = () => Promise<string | null>

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
    return <SearchResults store={store} settings={settings} query={trimmed} />
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, overflowY: 'scroll' }}>
      {workspaces.map((ws) => (
        <WorkspaceGroup key={ws.id} store={store} workspaceId={ws.id} dialog={dialog} />
      ))}
      <AddWorkspaceEntry onOpen={() => dialog.openAddWorkspace()} />
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
    <div style={{ display: 'flex', flexDirection: 'column', marginTop: 4 }}>
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
          height: 26,
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
        <Icon name="folder" size={12} color={COLORS.accent} />
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
              fontSize: 11,
              fontFamily: FONT.ui,
              fontWeight: '600',
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
          {sessions.map((id) => (
            <ThreadRow
              key={id}
              id={id}
              store={store}
              indent={SESSION_INDENT}
              onManage={dialog.openManageSession}
            />
          ))}
          {sessions.length === 0 ? (
            /* 空组引导（原型 empty-group）：可点按钮直接开工具菜单，
               不止文案提示「点 ＋」（对齐原型「创建第一个会话」） */
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
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ── 添加工作区（入口行；表单 = W7 添加工作区弹窗）──────────────────

function AddWorkspaceEntry({ onOpen }: { onOpen: () => void }) {
  return (
    <div
      tabIndex={0}
      testId="add-workspace"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onOpen()
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 26,
        marginTop: 4,
        marginBottom: 4,
        marginLeft: SIZES.rowMarginX,
        marginRight: SIZES.rowMarginX,
        paddingLeft: 4 + 16 + 12,
        borderRadius: SIZES.rowRadius,
        cursor: 'pointer',
        hover: { backgroundColor: COLORS.surface },
      }}
    >
      <Icon name="plus" size={11} color={COLORS.muted} />
      <text
        style={{
          fontSize: 11,
          fontFamily: FONT.ui,
          color: COLORS.muted,
          pointerEvents: 'none',
        }}
      >
        添加工作区
      </text>
    </div>
  )
}

// ── 跨工作区搜索结果 ────────────────────────────────────────────────

{
  /* 搜索结果（跨工作区：标题/工具/目录命中，行尾标工作区名） */
}
function SearchResults({
  store,
  settings,
  query,
}: {
  store: ThreadStore
  settings: SettingsStore
  query: string
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
          <ThreadRow key={thread.id} id={thread.id} store={store} suffix={workspace?.name} />
        ))
      )}
    </div>
  )
}
