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
import { TextInput } from '../ui/TextInput'
import { COLORS, FONT, SIZES } from '../ui/tokens'
import { ThreadRow } from './ThreadRow'
import { ToolMenu } from './ToolMenu'

/** 会话行在分组下的缩进（视觉分组） */
const SESSION_INDENT = 12

/** 原生目录选择 seam（W3）：resolve(path) / resolve(null) = 取消或不可用 */
export type DirectoryPicker = () => Promise<string | null>

export function WorkspaceList({
  store,
  settings,
  query,
  pickDirectory,
}: {
  store: ThreadStore
  settings: SettingsStore
  query: string
  pickDirectory?: DirectoryPicker
}) {
  const workspaces = useThreadStore(store, (s) => s.workspaces)
  const trimmed = query.trim()

  if (trimmed !== '') {
    return <SearchResults store={store} settings={settings} query={trimmed} />
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, overflowY: 'scroll' }}>
      {workspaces.map((ws) => (
        <WorkspaceGroup key={ws.id} store={store} settings={settings} workspaceId={ws.id} />
      ))}
      <AddWorkspaceForm store={store} pickDirectory={pickDirectory} />
    </div>
  )
}

// ── 工作区分组 ───────────────────────────────────────────────────────

function WorkspaceGroup({
  store,
  settings,
  workspaceId,
}: {
  store: ThreadStore
  settings: SettingsStore
  workspaceId: string
}) {
  const ws = useThreadStore(store, (s) => s.workspaces.find((w) => w.id === workspaceId))
  // 会话 id 串（顺序/增删粒度）；行内容 ThreadRow 自订
  const sessionIds = useThreadStore(store, (s) =>
    s.threads
      .filter((t) => t.workspaceId === workspaceId)
      .map((t) => t.id)
      .join(','),
  )
  const [menuOpen, setMenuOpen] = useState(false)
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
        {/* ＋：工具菜单（目标工作区；抑制行激活） */}
        <div
          tabIndex={0}
          testId={`new-menu-${ws.id}`}
          onClick={() => {
            skipRow.current = true
            setMenuOpen(!menuOpen)
          }}
          onKeyDown={(e) => {
            if (e.key === 'enter' || e.key === 'space') setMenuOpen(!menuOpen)
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

      {menuOpen ? (
        <ToolMenu
          store={store}
          settings={settings}
          workspace={ws}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}

      {ws.expanded ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {sessions.map((id) => (
            <ThreadRow key={id} id={id} store={store} indent={SESSION_INDENT} />
          ))}
          {sessions.length === 0 ? (
            <text
              style={{
                marginLeft: SIZES.rowMarginX + SESSION_INDENT + SIZES.rowPaddingX,
                marginTop: 2,
                marginBottom: 2,
                fontSize: 10,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                pointerEvents: 'none',
              }}
            >
              空工作区——点 ＋ 新建会话
            </text>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ── 添加工作区（内联表单；「浏览…」目录选择 = W3）───────────────────

function AddWorkspaceForm({
  store,
  pickDirectory,
}: {
  store: ThreadStore
  pickDirectory?: DirectoryPicker
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [picking, setPicking] = useState(false)

  /** 「浏览…」：原生目录选择 → 填 path +（名称空时）自动填 basename（原型契约） */
  const browse = () => {
    if (!pickDirectory || picking) return
    setPicking(true)
    pickDirectory()
      .then((picked) => {
        if (picked) {
          setPath(picked)
          if (!name.trim()) {
            const base = picked.split(/[\\/]/).filter(Boolean).pop()
            if (base) setName(base)
          }
        }
      })
      .finally(() => setPicking(false))
  }

  const submit = () => {
    if (!path.trim()) return // 目录必填；名称空 → basename 兜底（store 单点）
    store.addWorkspace(name.trim(), path.trim())
    setOpen(false)
    setName('')
    setPath('')
  }

  if (!open) {
    return (
      <div
        tabIndex={0}
        testId="add-workspace"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'enter' || e.key === 'space') setOpen(true)
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

  return (
    <div
      testId="add-workspace-form"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        marginTop: 6,
        marginLeft: SIZES.rowMarginX,
        marginRight: SIZES.rowMarginX,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 8,
        paddingBottom: 8,
        backgroundColor: COLORS.surface,
        borderRadius: 6,
      }}
    >
      <text style={{ fontSize: 10, fontFamily: FONT.ui, color: COLORS.muted }}>
        名称（空 = 目录名）
      </text>
      <TextInput
        testId="add-workspace-name"
        value={name}
        onChange={setName}
        placeholder="my-project"
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <text style={{ fontSize: 10, fontFamily: FONT.ui, color: COLORS.muted }}>
          目录（绝对路径）
        </text>
        {pickDirectory ? (
          <div
            tabIndex={0}
            testId="browse-directory"
            onClick={browse}
            onKeyDown={(e) => {
              if (e.key === 'enter' || e.key === 'space') browse()
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 16,
              paddingLeft: 6,
              paddingRight: 6,
              borderRadius: 3,
              cursor: 'pointer',
              opacity: picking ? 0.5 : 1,
              hover: { backgroundColor: COLORS.surfaceHover },
            }}
          >
            <text
              style={{
                fontSize: 10,
                fontFamily: FONT.ui,
                color: COLORS.accent,
                pointerEvents: 'none',
              }}
            >
              浏览…
            </text>
          </div>
        ) : null}
      </div>
      <TextInput
        testId="add-workspace-path"
        value={path}
        onChange={setPath}
        onSubmit={submit}
        placeholder="/Users/you/project"
        mono
      />
      <div style={{ display: 'flex', flexDirection: 'row', gap: 6 }}>
        <div
          tabIndex={0}
          testId="add-workspace-submit"
          onClick={submit}
          onKeyDown={(e) => {
            if (e.key === 'enter' || e.key === 'space') submit()
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 22,
            paddingLeft: 10,
            paddingRight: 10,
            borderRadius: 4,
            backgroundColor: path.trim() ? COLORS.accent : COLORS.surfaceHover,
            cursor: path.trim() ? 'pointer' : 'default',
          }}
        >
          <text
            style={{
              fontSize: 11,
              fontFamily: FONT.ui,
              color: COLORS.textBright,
              pointerEvents: 'none',
            }}
          >
            添加
          </text>
        </div>
        <div
          tabIndex={0}
          testId="add-workspace-cancel"
          onClick={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'enter' || e.key === 'space') setOpen(false)
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 22,
            paddingLeft: 10,
            paddingRight: 10,
            borderRadius: 4,
            hover: { backgroundColor: COLORS.surfaceHover },
            cursor: 'pointer',
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
            取消
          </text>
        </div>
      </div>
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
