/**
 * ThreadRow — 列表行（布局契约 §4；architecture.md §5）。
 *
 * zustand 按粒度订阅：只订自己那行（immer 结构共享 → 引用不变即跳过渲染）。
 * 局部态（hover / rename 编辑）useState，不上 store。
 *
 * 契约要点：
 * - 图标 SVG：terminal ▌(绿) / chat 圆环 / acp 折线(紫)
 * - 标题四级兜底（displayTitle），单行 ellipsis（完整标题 tooltip → Phase 2 ui/Tooltip）
 * - hasBell && 非 active → bell 图标（Phase W 对齐原型 session-state；早期红点形态废弃）
 * - exited → 灰行 + 已退出微标签
 * - 「…」按钮：hover/focus/active 可见（键盘可达性，契约 §10）→ 打开
 *   管理会话弹窗（W7 SessionDialog，重命名/移除）；键盘 Delete 直删保留
 * - 双击标题（clickCount===2）→ 行内 rename → customTitle 冻结
 * - active 行左缘 2px accent 指示条（贴行外侧，不占文字宽）
 *
 * 事件命中模型（2026-09-04 实测修正）：GPUIX/gpui 事件**不冒泡**——
 * hit-test 命中 deepest 有 paint 的元素，handler 只在命中元素上找。
 * 因此行内装饰（标题/bell 图标/exited 标签/指示条）一律 pointerEvents
 * 'none' 让命中穿透到行容器；行内「…」钮命中自身（不冒泡 → 不会
 * 误触行 onClick，无需抑制标志）。
 */

import { useState } from 'react'

import { useActiveTarget } from '../router'
import type { ThreadStore, Thread } from '../threads/store'
import { displayTitle } from '../threads/terminal'
import { useThreadStore } from '../threads/useThreadStore'
import { Icon } from '../ui/Icon'
import { COLORS, FONT, SIZES } from '../ui/tokens'

/** 行标题：terminal 走 displayTitle 四级兜底；chat/acp 用 title */
export function rowTitle(thread: Thread): string {
  return thread.kind === 'terminal' ? displayTitle(thread) : thread.title
}

export function ThreadRow({
  id,
  store,
  indent = 0,
  suffix,
  onManage,
}: {
  id: string
  store: ThreadStore
  /** 左缩进（工作区分组下的会话行；搜索结果行不缩） */
  indent?: number
  /** 尾部附注（搜索结果行显示工作区名；静默装饰） */
  suffix?: string
  /** 「…」→ 管理会话弹窗（W7；WorkspaceGroup 传 dialog.openManageSession） */
  onManage?: (threadId: string) => void
}) {
  const thread = useThreadStore(store, (s) => s.threads.find((t) => t.id === id))
  const active = useActiveTarget()
  const [hovered, setHovered] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  if (!thread) return null
  const isActive = active?.type === 'thread' && active.id === id
  const isTerminal = thread.kind === 'terminal'
  const exited = isTerminal && thread.status === 'exited'
  const showBell = isTerminal && thread.hasBell && !isActive
  const showMenu = hovered || isActive || editing

  const kindColor =
    thread.kind === 'terminal'
      ? COLORS.terminalKind
      : thread.kind === 'acp'
        ? COLORS.acpKind
        : COLORS.accent
  const titleColor = exited ? COLORS.exited : isActive ? COLORS.textBright : COLORS.text

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

  return (
    <div
      testId={`row-${id}`}
      tabIndex={0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      onClick={(e) => {
        if (editing) return
        if (e.clickCount === 2) {
          startRename()
          return
        }
        store.activate({ type: 'thread', id })
      }}
      onKeyDown={(e) => {
        // Delete/Backspace（行聚焦）→ 关闭；Enter → 激活（契约 §4 交互表）；
        // Esc：管理菜单开 → 先关菜单；编辑态 → 取消
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
        marginLeft: SIZES.rowMarginX + indent,
        marginRight: SIZES.rowMarginX,
        paddingLeft: SIZES.rowPaddingX,
        paddingRight: SIZES.rowPaddingX - 2,
        borderRadius: SIZES.rowRadius,
        backgroundColor: isActive ? COLORS.surface : 'transparent',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {/* active 指示条：贴行左缘外（布局契约 §3，绝对定位于 margin 区）。
          装饰层：pe none 不挡命中（见文件头） */}
      {isActive ? (
        <div
          style={{
            position: 'absolute',
            left: -SIZES.rowMarginX,
            top: 6,
            bottom: 6,
            width: SIZES.activeBarWidth,
            backgroundColor: COLORS.accent,
            borderRadius: 1,
            pointerEvents: 'none',
          }}
        />
      ) : null}

      <div style={{ display: 'flex', width: 18, justifyContent: 'center', flexShrink: 0 }}>
        <Icon name={thread.kind} size={13} color={exited ? COLORS.exited : kindColor} />
      </div>

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
            marginLeft: 6,
            marginRight: 4,
            height: 20,
            fontSize: 12,
            lineHeight: 16,
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
          style={{
            flexGrow: 1,
            marginLeft: 6,
            marginRight: 4,
            fontSize: 12,
            fontFamily: FONT.ui,
            color: titleColor,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            pointerEvents: 'none',
          }}
        >
          {rowTitle(thread)}
        </text>
      )}

      {suffix ? (
        <text
          style={{
            fontSize: 10,
            fontFamily: FONT.mono,
            color: COLORS.muted,
            flexShrink: 0,
            marginRight: 2,
            pointerEvents: 'none',
          }}
        >
          {suffix}
        </text>
      ) : null}

      {showBell ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            marginRight: showMenu ? 2 : 4,
            flexShrink: 0,
          }}
        >
          <Icon name="bell" size={11} color={COLORS.bell} />
        </div>
      ) : null}

      {exited && !editing ? (
        <text
          style={{
            fontSize: 10,
            fontFamily: FONT.mono,
            color: COLORS.exited,
            flexShrink: 0,
            marginRight: showMenu ? 2 : 4,
            pointerEvents: 'none',
          }}
        >
          已退出
        </text>
      ) : null}

      {/* 「…」→ 管理会话弹窗（W7）；hover/active 可见（键盘可达性） */}
      {showMenu ? (
        <div
          testId={`manage-thread-${id}`}
          tabIndex={0}
          onClick={() => onManage?.(id)}
          onKeyDown={(e) => {
            if (e.key === 'enter' || e.key === 'space') onManage?.(id)
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: 3,
            flexShrink: 0,
            hover: { backgroundColor: COLORS.closeHover },
          }}
        >
          <Icon name="more" size={12} color={COLORS.muted} />
        </div>
      ) : (
        <div style={{ width: 0, height: 18, flexShrink: 0 }} />
      )}
    </div>
  )
}
