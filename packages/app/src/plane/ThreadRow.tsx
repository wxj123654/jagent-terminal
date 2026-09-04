/**
 * ThreadRow — 列表行（布局契约 §4；architecture.md §5）。
 *
 * zustand 按粒度订阅：只订自己那行（immer 结构共享 → 引用不变即跳过渲染）。
 * 局部态（hover / rename 编辑）useState，不上 store。
 *
 * 契约要点：
 * - 图标 SVG：terminal ▌(绿) / chat 圆环 / acp 折线(紫)
 * - 标题四级兜底（displayTitle），单行 ellipsis（完整标题 tooltip → Phase 2 ui/Tooltip）
 * - hasBell && 非 active → 红点；exited → 灰行 + exited 微标签
 * - 关闭钮：hover / focus-within / active 可见（键盘可达性，契约 §10）
 * - 双击标题（clickCount===2）→ 行内 rename → customTitle 冻结
 * - active 行左缘 2px accent 指示条（贴行外侧，不占文字宽）
 *
 * 事件冒泡注记：GPUIX/gpui 的 mouse 事件会命中祖先路径，点击行内关闭钮
 * 可能同时触发行的 onClick。JS 侧无 stopPropagation 面，用 mouseDown 抑制
 * 标志（ref，同步可变）挡一次：关闭钮在 mouseDown 即动作，行 onClick 若
 * 跟随到达则被标志吞掉（一次性，无条件重置——即使冒泡不发生也无残留危害）。
 */

import { useRef, useState } from 'react'

import type { ThreadStore, Thread } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { displayTitle } from '../threads/terminal'
import { useActiveTarget } from '../router'
import { Icon } from '../ui/Icon'
import { COLORS, FONT, SIZES } from './tokens'

/** 行标题：terminal 走 displayTitle 四级兜底；chat/acp 用 title */
export function rowTitle(thread: Thread): string {
  return thread.kind === 'terminal' ? displayTitle(thread) : thread.title
}

export function ThreadRow({ id, store }: { id: string; store: ThreadStore }) {
  const thread = useThreadStore(store, (s) => s.threads.find((t) => t.id === id))
  const active = useActiveTarget()
  const [hovered, setHovered] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const suppressClick = useRef(false)

  if (!thread) return null
  const isActive = active?.type === 'thread' && active.id === id
  const isTerminal = thread.kind === 'terminal'
  const exited = isTerminal && thread.status === 'exited'
  const showBell = isTerminal && thread.hasBell && !isActive
  const showClose = hovered || isActive || editing

  const kindColor =
    thread.kind === 'terminal' ? COLORS.terminalKind : thread.kind === 'acp' ? COLORS.acpKind : COLORS.accent
  const titleColor = exited ? COLORS.exited : isActive ? COLORS.textBright : COLORS.text

  const startRename = () => {
    setDraft(thread.kind === 'terminal' ? (thread.customTitle ?? thread.oscTitle ?? '') : thread.title)
    setEditing(true)
  }

  const commitRename = () => {
    setEditing(false)
    store.rename(id, draft)
  }

  return (
    <div
      tabIndex={0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      onClick={(e) => {
        // 一次性抑制（见文件头冒泡注记）
        const suppressed = suppressClick.current
        suppressClick.current = false
        if (suppressed || editing) return
        if (e.clickCount === 2) {
          startRename()
          return
        }
        store.activate({ type: 'thread', id })
      }}
      onKeyDown={(e) => {
        // Delete/Backspace（行聚焦）→ 关闭；Enter → 激活（契约 §4 交互表）
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
        marginLeft: SIZES.rowMarginX,
        marginRight: SIZES.rowMarginX,
        paddingLeft: SIZES.rowPaddingX,
        paddingRight: SIZES.rowPaddingX - 2,
        borderRadius: SIZES.rowRadius,
        backgroundColor: isActive ? '#2c313a' : 'transparent',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {/* active 指示条：贴行左缘外（布局契约 §3，绝对定位于 margin 区） */}
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
            fontFamily: FONT.ui,
            color: COLORS.textBright,
            backgroundColor: '#1b1d23',
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
          }}
        >
          {rowTitle(thread)}
        </text>
      )}

      {showBell ? (
        <div
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: COLORS.bell,
            flexShrink: 0,
            marginRight: showClose ? 2 : 4,
          }}
        />
      ) : null}

      {exited && !editing ? (
        <text
          style={{
            fontSize: 10,
            fontFamily: FONT.mono,
            color: COLORS.exited,
            flexShrink: 0,
            marginRight: showClose ? 2 : 4,
          }}
        >
          exited
        </text>
      ) : null}

      {showClose ? (
        <div
          testId={`close-thread-${id}`}
          onMouseDown={() => {
            suppressClick.current = true
            store.close(id)
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: 3,
            flexShrink: 0,
            hover: { backgroundColor: '#3a3f4b' },
          }}
        >
          <Icon name="close" size={11} color={COLORS.muted} />
        </div>
      ) : (
        <div style={{ width: 0, height: 18, flexShrink: 0 }} />
      )}
    </div>
  )
}
