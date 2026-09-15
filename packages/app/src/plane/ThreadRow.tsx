/**
 * ThreadRow — 列表行（布局契约 §4；architecture.md §5；codex-sidebar-v2）。
 *
 * zustand 按粒度订阅：只订自己那行（immer 结构共享 → 引用不变即跳过渲染）。
 * 局部态（hover / rename 编辑）useState，不上 store。
 *
 * 方案 C 契约要点：
 * - 13px 标题，单行 ellipsis；行高 28，圆角 6（--r-nav），选中 = 10% 白底
 * - unread 一等状态：标题加粗亮色 + 状态点（7px muted）；打开即已读
 *   （store.activate 清），菜单可手动标回（待办语义）
 * - pin：标题前 10px 图钉图标（faint）；排序在 WorkspaceList.sortThreads
 * - 状态点（D12，诚实语义）：chat/acp pendingReply = 进行中（橙呼吸光晕）；
 *   hasBell = 等待注意（紫光晕）；消息 error = 红；exited = 无点 + 灰字；
 *   idle = 无点，仅选中行显 9px 空心环（g300）。terminal「存活」不显示
 *   running——PTY 活着 ≠ agent 在工作（不伪造完成/等待态）。
 * - 「…」菜单槽固定 22px 宽（占位不位移）；图标 hover/focus/active 可见；
 *   「…」与右键（onAuxClick）开同一面上下文菜单（onMenu 回调，坐标定位）
 * - 双击标题 → 行内 rename；Delete/Backspace 关闭；Enter 激活
 *
 * 事件命中模型：GPUIX/gpui 事件不冒泡——命中 deepest 有 handler 的元素。
 * 行内装饰一律 pointerEvents 'none' 穿透到行容器；「…」钮命中自身。
 */

import { useRef, useState } from 'react'

import { Icon, COLORS, FONT } from '@jagent/ui'
import { useActiveTarget } from '../router'
import type { ThreadStore, Thread } from '../threads/store'
import { displayTitle } from '../threads/terminal'
import { useThreadStore } from '../threads/useThreadStore'
import { SIZES } from '../tokens'

/** 行标题：terminal 走 displayTitle 四级兜底；chat/acp 用 title */
export function rowTitle(thread: Thread): string {
  return thread.kind === 'terminal' ? displayTitle(thread) : thread.title
}

/** 状态点视觉（v2 .st；退出 = 灰文字无点；idle-on = 选中空闲空心环；
 *  unread = 7px muted 点——方案 C 一等未读态） */
export type DotState =
  | 'running'
  | 'need'
  | 'done'
  | 'error'
  | 'exited'
  | 'unread'
  | 'idle'
  | 'idle-on'

/**
 * 会话 → 状态点（纯函数，测试面；D12 诚实映射）：
 * - terminal：exited → 'exited'；hasBell → 'need'（等待注意）；unread →
 *   'unread'；存活 → 'idle'（不显示 running——只有进程存活信息，不能伪造
 *   「正在执行」）
 * - chat/acp：pendingReply → 'running'（agent 真在工作）；末条 error →
 *   'error'；unread → 'unread'
 */
export function statusDot(thread: Thread): DotState {
  if (thread.kind === 'terminal') {
    if (thread.status === 'exited') return 'exited'
    if (thread.hasBell) return 'need'
    if (thread.unread) return 'unread'
    return 'idle'
  }
  if (thread.pendingReply) return 'running'
  const last = thread.messages.at(-1)
  if (last && last.role === 'assistant' && last.error) return 'error'
  if (thread.unread) return 'unread'
  return 'idle'
}

function Dot({ state }: { state: DotState }) {
  // 无点态占位（exited / 非选中 idle）：槽位保留防标题位移
  if (state === 'exited' || state === 'idle') return null
  if (state === 'idle-on')
    return (
      <div
        testId="dot-idle-on"
        style={{
          width: 9,
          height: 9,
          borderRadius: 9999,
          // v2 idle 选中：9px 空心环（g300 描边、透明心）
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderColor: COLORS.g300,
          flexShrink: 0,
        }}
      />
    )
  if (state === 'unread')
    // 原型 .dot.unr：7px muted 实心点（无光晕——未读是标记不是活动态）
    return (
      <div
        testId="dot-unread"
        style={{
          width: 7,
          height: 7,
          borderRadius: 9999,
          backgroundColor: COLORS.muted,
          flexShrink: 0,
        }}
      />
    )
  const bg =
    state === 'running'
      ? COLORS.statusRunning
      : state === 'need'
        ? COLORS.statusNeed
        : state === 'error'
          ? COLORS.statusError
          : COLORS.statusDone
  // 进行中/待确认 = 7px + 3px 光晕（原型呼吸动画的静态近似——GPUIX 无动画原语）；
  // done/error = 8px 无光晕
  const pulse = state === 'running' || state === 'need'
  return (
    <div
      testId={`dot-${state}`}
      style={{
        width: pulse ? 7 : 8,
        height: pulse ? 7 : 8,
        borderRadius: 9999,
        backgroundColor: bg,
        boxShadow: pulse
          ? { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 3, color: `${bg}26` }
          : undefined,
        flexShrink: 0,
      }}
    />
  )
}

export function ThreadRow({
  id,
  store,
  onMenu,
  onFocusRow,
}: {
  id: string
  store: ThreadStore
  /** 「…」/ 右键 → 上下文菜单（方案 C；坐标 = 点击点窗口坐标） */
  onMenu?: (threadId: string, pos: { x: number; y: number }) => void
  /** 行聚焦上报（截断豁免：focus 行不被 Show more 截断） */
  onFocusRow?: (threadId: string) => void
}) {
  const thread = useThreadStore(store, (s) => s.threads.find((t) => t.id === id))
  const active = useActiveTarget()
  const [hovered, setHovered] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  /** 行上最后一次指针位置（键盘打开菜单的定位兜底——GPUIX 无元素 bounds 读面） */
  const lastPointer = useRef({ x: 0, y: 0 })

  if (!thread) return null
  const isActive = active?.type === 'thread' && active.id === id
  const exited = thread.kind === 'terminal' && thread.status === 'exited'
  const unread = !exited && !!thread.unread
  const rawDot = statusDot(thread)
  const dot: DotState = rawDot === 'idle' && isActive ? 'idle-on' : rawDot
  const showMenu = hovered || isActive || editing

  // unread：标题加粗提亮（原型 .row.unread .ttl：t1 + 560）；exited 压灰优先
  const titleColor = exited ? COLORS.exited : isActive || unread ? COLORS.textBright : COLORS.text

  const startRename = () => {
    setDraft(
      thread.kind === 'terminal' ? (thread.customTitle ?? thread.oscTitle ?? '') : thread.title,
    )
    setEditing(true)
  }

  const commitRename = () => {
    setEditing(false)
    store.rename(id, draft)
  }

  const openMenu = (pos?: { x?: number; y?: number }) =>
    onMenu?.(id, { x: pos?.x ?? lastPointer.current.x, y: pos?.y ?? lastPointer.current.y })

  return (
    <div
      testId={`row-${id}`}
      tabIndex={0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseMove={(e) => {
        lastPointer.current = { x: e.x ?? 0, y: e.y ?? 0 }
      }}
      onFocus={() => {
        setHovered(true)
        onFocusRow?.(id)
      }}
      onBlur={() => setHovered(false)}
      onClick={(e) => {
        if (editing) return
        if (e.clickCount === 2) {
          startRename()
          return
        }
        store.activate({ type: 'thread', id })
      }}
      onAuxClick={(e) => {
        // 右键 = 「…」同一面菜单（方案 C：同一面，不分两套）
        if (e.isRightClick) openMenu(e)
      }}
      onKeyDown={(e) => {
        // Delete/Backspace（行聚焦）→ 关闭；Enter → 激活（契约 §4 交互表）；
        // Esc：编辑态 → 取消
        if (e.key === 'delete' || e.key === 'backspace') store.close(id)
        else if (e.key === 'enter') store.activate({ type: 'thread', id })
        else if (e.key === 'escape' && editing) setEditing(false)
      }}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        height: SIZES.rowHeight,
        paddingLeft: 4,
        paddingRight: 4,
        borderRadius: SIZES.rowRadius,
        backgroundColor: isActive ? COLORS.surfaceActive : 'transparent',
        hover: { backgroundColor: isActive ? COLORS.surfaceActive : COLORS.surface },
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {/* 状态点槽（原型 .stt 18px 盒）：dot 居中 */}
      <div
        style={{
          display: 'flex',
          width: 18,
          justifyContent: 'center',
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        <Dot state={dot} />
      </div>

      {/* pin 图钉（原型 .pin-ic：标题前 12px，faint） */}
      {thread.pin ? (
        <div style={{ display: 'flex', marginRight: 2, flexShrink: 0, pointerEvents: 'none' }}>
          <Icon name="pin" size={12} color={COLORS.faint} />
        </div>
      ) : null}

      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.value ?? draft)}
          onKeyDown={(e) => {
            if (e.key === 'enter') commitRename()
            else if (e.key === 'escape') setEditing(false)
          }}
          onBlur={commitRename}
          style={{
            flexGrow: 1,
            marginLeft: 4,
            marginRight: 4,
            height: 20,
            fontSize: 12,
            lineHeight: 16,
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
        <text
          style={{
            flexGrow: 1,
            marginLeft: 4,
            marginRight: 4,
            fontSize: 13,
            fontFamily: FONT.ui,
            fontWeight: unread ? '600' : undefined,
            color: titleColor,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            pointerEvents: 'none',
          }}
        >
          {rowTitle(thread)}
        </text>
      )}

      {/* 「…」菜单槽固定 22px（D11：不占位→位移；图标 hover/active/focus 显）。
          点击开上下文菜单（坐标 = 点击点）；键盘 enter/space 用 lastPointer 兜底 */}
      <div
        testId={`menu-thread-${id}`}
        tabIndex={0}
        onClick={(e) => openMenu(e)}
        onKeyDown={(e) => {
          if (e.key === 'enter' || e.key === 'space') openMenu()
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          borderRadius: 9999,
          flexShrink: 0,
          opacity: showMenu ? 1 : 0,
          hover: { backgroundColor: COLORS.closeHover },
        }}
      >
        <Icon name="more" size={12} color={COLORS.muted} />
      </div>
    </div>
  )
}
