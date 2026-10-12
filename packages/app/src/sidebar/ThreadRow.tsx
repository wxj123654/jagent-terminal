/**
 * ThreadRow — 列表行（React 原型 .t-row；布局契约 §4；architecture.md §5）。
 *
 * zustand 按粒度订阅：只订自己那行（immer 结构共享 → 引用不变即跳过渲染）。
 * 局部态（hover/menuHover）useState，不上 store。
 *
 * 原型行契约要点：
 * - h32 / r8 / pad 0 3·0 5 / gap 6；active 底 surfaceActive，hover 3.5% 白
 * - 行头 .thread-kind tile：20×20 r5（2.5% 白底，kind 色 12px 图标——
 *   terminal 绿 / chat accent / acp 紫）；状态点缩成 tile 右下角角标
 *   （6px 点 + 1.5px sidebar 描边半出外缘；idle-on = surfaceActive + g300）
 * - 12.5px 标题单行 ellipsis；unread = 600 + textBright；exited = 压灰
 *   （exited tile 转 transparent + 图标同色灰）；active 提亮
 * - pin：标题后右缘 12px 图钉（faint）；排序在 workspaces.sortThreads
 * - 「…」菜单槽固定 22px（不占位→位移；r8，hover 底 closeHover + 图标提
 *   亮）；「…」与右键（onAuxClick）开同一面上下文菜单：「…」钮下缘右对齐、
 *   右键行下缘左对齐（菜单挂在触发器内部，不走全局坐标）；菜单项执行经 onPick 回调
 * - 状态点（D12，诚实语义）：chat/acp pendingReply = 橙（running）；hasBell
 *   = 紫（need）；error = 红；done 绿预留；unread = muted 点；exited/idle
 *   无点。terminal「存活」不显示 running——PTY 活着 ≠ agent 在工作。
 * - 重命名走上下文菜单 Rename… → RenameDialog；Delete/Backspace 关闭；Enter 激活
 *
 * 事件命中模型：GPUIX/gpui 事件不冒泡——命中 deepest 有 handler 的元素。
 * 行内装饰一律 pointerEvents 'none' 穿透到行容器；「…」钮命中自身。
 */

import { useState } from 'react'

import { Icon, COLORS, FONT } from '@jagent/ui'
import { useActiveTarget } from '../router'
import type { ThreadStore, Thread } from '../threads/store'
import { displayTitle } from '../threads/terminal'
import { useThreadStore } from '../threads/useThreadStore'
import { SIZES } from '../tokens'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

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

/** 行头 kind 图标（原型 KIND_ICON：terminal/chat/acp） */
const KIND_ICON = { terminal: 'terminal', chat: 'chat', acp: 'acp' } as const

/** tile 右下角状态角标（原型 .t-row .thread-kind .dot：6px 点 + 1.5px
 *  sidebar 色描边，半出 tile 右下外缘；idle-on = 7px surfaceActive +
 *  g300 描边。exited/idle 无点）。原型 border-box 盒 6/7 = 视觉总宽；
 *  GPUIX 定高盒 border 同样计盒内——直接写 6/7。 */
function TileDot({ state }: { state: DotState }) {
  if (state === 'exited' || state === 'idle') return null
  const idleOn = state === 'idle-on'
  const bg = idleOn
    ? COLORS.surfaceActive
    : state === 'running'
      ? COLORS.statusRunning
      : state === 'need'
        ? COLORS.statusNeed
        : state === 'done'
          ? COLORS.statusDone
          : state === 'error'
            ? COLORS.statusError
            : COLORS.muted // unread
  return (
    <div
      testId={idleOn ? 'dot-idle-on' : `dot-${state}`}
      style={{
        position: 'absolute',
        right: -2,
        bottom: -2,
        width: idleOn ? 7 : 6,
        height: idleOn ? 7 : 6,
        borderRadius: 9999,
        backgroundColor: bg,
        borderWidth: 1.5,
        borderColor: idleOn ? COLORS.g300 : COLORS.sidebar,
        flexShrink: 0,
      }}
    />
  )
}

/** 状态点（SessionTabs 主面 tab 复用同一视觉——无点态返回 null） */
export function Dot({ state }: { state: DotState }) {
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

/** 会话行菜单项（置顶 / 重命名 / 已读未读 / 移除）。标签随 thread 状态现算。 */
export function threadMenuItems(t: Thread): ContextMenuItem[] {
  return [
    { id: 'pin', label: t.pin ? '取消置顶' : '置顶' },
    { id: 'rename', label: '重命名…' },
    { id: 'unread', label: t.unread ? '标记为已读' : '标记为未读' },
    'sep',
    { id: 'remove', label: '移除', danger: true },
  ]
}

export function ThreadRow({
  id,
  store,
  onPick,
  onFocusRow,
}: {
  id: string
  store: ThreadStore
  /** 菜单项执行回调（pin/unread/rename/remove；由列表层持有 dialog 与 store 动作） */
  onPick?: (threadId: string, itemId: string) => void
  /** 行聚焦上报（截断豁免：focus 行不被 Show more 截断） */
  onFocusRow?: (threadId: string) => void
}) {
  const thread = useThreadStore(store, (s) => s.threads.find((t) => t.id === id))
  const active = useActiveTarget()
  const [hovered, setHovered] = useState(false)
  const [menuHovered, setMenuHover] = useState(false)
  /** 菜单来源：button=「…」钮下缘；row=右键行下缘；null=关 */
  const [menuSource, setMenuSource] = useState<'button' | 'row' | null>(null)
  const menuOpen = menuSource !== null

  if (!thread) return null
  const isActive = active?.type === 'thread' && active.id === id
  const exited = thread.kind === 'terminal' && thread.status === 'exited'
  const unread = !exited && !!thread.unread
  const rawDot = statusDot(thread)
  const dot: DotState = rawDot === 'idle' && isActive ? 'idle-on' : rawDot
  // 菜单开着时钮必须可见：opacity 乘积继承，钮 opacity:0 会连带隐去内嵌菜单
  const showMenu = hovered || menuHovered || isActive || menuOpen

  // 原型 .thread-kind：tile 面色按 kind（terminal 绿 / chat accent / acp 紫）；
  // exited 图标同色压灰 + tile 透明
  const kindColor = exited
    ? COLORS.exited
    : thread.kind === 'terminal'
      ? COLORS.terminalKind
      : thread.kind === 'chat'
        ? COLORS.accent
        : COLORS.acpKind
  // unread：标题加粗提亮（原型 .ttl.unread：600 + textBright）；exited 压灰优先
  const titleColor = exited ? COLORS.exited : isActive || unread ? COLORS.textBright : COLORS.text

  const closeMenu = () => setMenuSource(null)
  const menuItems = threadMenuItems(thread)
  const pick = (itemId: string) => onPick?.(id, itemId)

  return (
    <div
      testId={`row-${id}`}
      tabIndex={0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => {
        setHovered(true)
        onFocusRow?.(id)
      }}
      onBlur={() => setHovered(false)}
      onClick={() => {
        store.activate({ type: 'thread', id })
      }}
      onAuxClick={(e) => {
        // 右键 = 「…」同一面菜单（方案 C：同一面，不分两套）；锚定行下缘
        if (e.isRightClick) setMenuSource('row')
      }}
      onKeyDown={(e) => {
        // 菜单开着时按键冒泡上来（gpuix 不阻断冒泡）——交给菜单，行不处理
        if (menuOpen) return
        // Delete/Backspace（行聚焦）→ 关闭；Enter → 激活（契约 §4 交互表）
        if (e.key === 'delete' || e.key === 'backspace') store.close(id)
        else if (e.key === 'enter') store.activate({ type: 'thread', id })
      }}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        // 原型 .t-row（第二段）：h32 r8 pad 0 3/0 5 gap 6；active 底
        // surfaceActive；hover 3.5% 白（active 行 hover 仍是 surfaceActive）
        gap: 6,
        height: SIZES.rowHeight,
        paddingLeft: 5,
        paddingRight: 3,
        borderRadius: SIZES.rowRadius,
        backgroundColor: isActive ? COLORS.surfaceActive : 'transparent',
        hover: {
          backgroundColor: isActive ? COLORS.surfaceActive : 'rgba(255,255,255,0.035)',
        },
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {/* .thread-kind tile（20×20 r5，2.5% 白底，kind 色图标 12）——状态点
          缩成 tile 右下角角标（6px 点 + 1.5px sidebar 色描边半出外缘） */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          borderRadius: 5,
          flexShrink: 0,
          backgroundColor: exited ? 'transparent' : 'rgba(255,255,255,0.025)',
          pointerEvents: 'none',
        }}
      >
        <Icon name={KIND_ICON[thread.kind]} size={12} color={kindColor} />
        <TileDot state={dot} />
      </div>

      <text
        style={{
          flexGrow: 1,
          minWidth: 0,
          // 原型 .ttl：12.5px；unread 600 textBright；exited 压灰；active 提亮
          fontSize: 12.5,
          fontFamily: FONT.ui,
          fontWeight: unread ? '600' : undefined,
          color: titleColor,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
          pointerEvents: 'none',
        }}
      >
        {rowTitle(thread)}
      </text>

      {/* pin 图钉（原型 .pin-ic：标题后右缘，faint 12px） */}
      {thread.pin ? (
        <div style={{ display: 'flex', flexShrink: 0, pointerEvents: 'none' }}>
          <Icon name="pin" size={12} color={COLORS.faint} />
        </div>
      ) : null}

      {/* 「…」菜单槽固定 22px（不占位→位移；图标 hover/active/focus 显；
          原型 .menu-btn r8，hover 底 closeHover + 图标提亮）。
          点击开上下文菜单：菜单挂在钮内部，贴钮下缘右对齐 */}
      <div
        testId={`menu-thread-${id}`}
        tabIndex={0}
        onClick={() => setMenuSource('button')}
        onKeyDown={(e) => {
          // 菜单开着时钮的键盘事件是菜单冒泡上来的，不得再开菜单
          if (menuOpen) return
          if (e.key === 'enter' || e.key === 'space') setMenuSource('button')
        }}
        onMouseEnter={() => setMenuHover(true)}
        onMouseLeave={() => setMenuHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          borderRadius: 8,
          flexShrink: 0,
          opacity: showMenu ? 1 : 0,
          hover: { backgroundColor: COLORS.closeHover },
        }}
      >
        <Icon name="more" size={12} color={menuHovered ? COLORS.textBright : COLORS.muted} />
        {menuSource === 'button' ? (
          <ContextMenu
            side="bottom"
            align="end"
            items={menuItems}
            onPick={pick}
            onClose={closeMenu}
          />
        ) : null}
      </div>
      {menuSource === 'row' ? (
        <ContextMenu
          side="bottom"
          align="start"
          items={menuItems}
          onPick={pick}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  )
}
