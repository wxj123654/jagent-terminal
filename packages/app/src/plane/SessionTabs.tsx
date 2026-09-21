/**
 * SessionTabs — 顶栏第二行 tab 条（最新原型 #tb-tabs，40d30e8）。
 *
 * thread 路由 → 主面 tab（kind 图标 + 状态点 + 标题）+ 各 SessionView
 * tab（git/file/shell；中键或 × 关闭）+「+」添加浮层（打开 Git 图 /
 * 新建 Shell / 打开文件=当前工作区变更文件列表）。
 * 非 thread 路由 → ContextTab（单态页签：workspace/settings/home 上下文）。
 *
 * 点击/关闭全走 ThreadStore 会话视图 API——router 不感知（视图是会话
 * 内态，非路由态）。GPUIX 事件命中 deepest 有 handler 的元素（ThreadRow
 * 同款模型）：× 钮的 onClick 不会到父 tab，装饰子元素一律 pe:none。
 */

import { useRef, useState } from 'react'

import { useGpuix } from '@gpuix/react'
import type { PublicInstance } from '@gpuix/react'

import { Icon, Popover, COLORS, FONT } from '@jagent/ui'
import type { IconName } from '@jagent/ui'
import { useWorktree } from '../git/useWorktree'
import type { WorktreeStore } from '../git/worktree'
import { Dot, statusDot, type DotState } from '../sidebar/ThreadRow'
import type { SessionView, Thread, ThreadStore } from '../threads/store'
import { sessionViewTitle } from '../threads/store'
import { displayTitle } from '../threads/terminal'

const KIND_ICON: Record<Thread['kind'], IconName> = {
  terminal: 'terminal',
  chat: 'chat',
  acp: 'acp',
}

const VIEW_ICON: Record<SessionView['kind'], IconName> = {
  git: 'gitBranch',
  file: 'file',
  shell: 'terminal',
}

/** 单个 tab（原型 .tab：h28 / max-w 210 / r8 pad 0 10 /
 *  active = surfaceActive + borderSubtle 边 + 1px 阴影） */
function Tab({
  testId,
  icon,
  label,
  active,
  exited,
  dot,
  onActivate,
  onClose,
}: {
  testId: string
  icon: IconName
  label: string
  active: boolean
  /** terminal/shell exited：标题压灰（原型 .tab.exited .ttl） */
  exited?: boolean
  /** 状态点（主面 tab / shell 视图 bell；idle/exited 不画） */
  dot?: DotState
  onActivate?: () => void
  onClose?: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [txHovered, setTxHovered] = useState(false)
  return (
    <div
      testId={testId}
      tabIndex={0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={() => onActivate?.()}
      onMouseDown={(e) => {
        // 中键关闭（原型 onMouseDown button===1）
        if (e.button === 1) onClose?.()
      }}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onActivate?.()
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 28,
        minWidth: 0,
        maxWidth: 210,
        flexShrink: 1,
        paddingLeft: 10,
        // 右内距收窄留给 × 钮（负 margin 会让 Taffy 把容器宽度塌成 0——实测坑；
        // 原型是 pad 10 + .tx margin-right:-4，净效 = pad 6 + 20px 钮）
        paddingRight: onClose ? 6 : 10,
        borderWidth: 1,
        borderColor: active ? COLORS.borderSubtle : 'transparent',
        borderRadius: 8,
        backgroundColor: active ? COLORS.surfaceActive : 'transparent',
        color: active ? COLORS.textBright : COLORS.muted,
        cursor: onActivate ? 'pointer' : 'default',
        userSelect: 'none',
        // win 整条顶栏是 HTCAPTION drag 区：tab 必须 occlude 才可点
        pointerEvents: 'auto',
        boxShadow: active
          ? { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: 'rgba(0,0,0,0.3)' }
          : undefined,
        hover: {
          backgroundColor: active ? COLORS.surfaceActive : 'rgba(255,255,255,0.035)',
        },
      }}
    >
      <Icon name={icon} size={13} color={active ? COLORS.text : COLORS.muted} />
      {dot ? <Dot state={dot} /> : null}
      <text
        style={{
          minWidth: 0,
          fontSize: 12,
          fontFamily: FONT.ui,
          // 原型 .tab:hover{color:var(--text)}——hover 提亮到 text（非 textBright）
          color: exited
            ? COLORS.exited
            : active
              ? COLORS.textBright
              : hovered
                ? COLORS.text
                : COLORS.muted,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
          pointerEvents: 'none',
        }}
      >
        {label}
      </text>
      {onClose ? (
        <div
          testId={`${testId}-close`}
          onClick={onClose}
          onMouseEnter={() => setTxHovered(true)}
          onMouseLeave={() => setTxHovered(false)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            borderRadius: 4,
            flexShrink: 0,
            // 原型 .tx：hover/active/focus-within 才显
            opacity: hovered || active || focused ? 1 : 0,
            color: COLORS.muted,
            hover: { backgroundColor: COLORS.closeHover },
          }}
        >
          {/* GPUIX svg 只读自身 style.color（不继承父级）——tx 悬停态显式给色 */}
          <Icon name="close" size={11} color={txHovered ? COLORS.textBright : COLORS.muted} />
        </div>
      ) : null}
    </div>
  )
}

export function SessionTabs({
  store,
  thread,
  worktree,
}: {
  store: ThreadStore
  thread: Thread
  worktree: WorktreeStore
}) {
  const views = thread.views ?? []
  const activeId = views.some((v) => v.id === thread.activeViewId) ? thread.activeViewId! : 'main'
  const dot0 = statusDot(thread)
  const dot = dot0 === 'idle' || dot0 === 'idle-on' || dot0 === 'exited' ? undefined : dot0
  const exited = thread.kind === 'terminal' && thread.status === 'exited'
  const title = thread.kind === 'terminal' ? displayTitle(thread) : thread.title
  const [addAt, setAddAt] = useState<{ x: number; y: number } | null>(null)
  const [addHovered, setAddHovered] = useState(false)
  const addBtnRef = useRef<PublicInstance | null>(null)
  const { renderer } = useGpuix()
  const lastPointer = useRef({ x: 0, y: 0 })
  // 原型 Pop（Radix side=bottom align=start sideOffset=4）：
  // 浮层左上角 = 按钮左下 +4；bounds 读不到时兜底点击点
  const addAnchor = (fallback: { x: number; y: number }) => {
    const b = addBtnRef.current ? renderer?.getElementBounds?.(addBtnRef.current.id) : null
    return b ? { x: b.x, y: b.y + b.height + 4 } : fallback
  }

  return (
    <>
      {/* 主面 tab（不可关；'main' 是虚拟 id） */}
      <Tab
        testId="tab-main"
        icon={KIND_ICON[thread.kind]}
        label={title}
        active={activeId === 'main'}
        exited={exited}
        dot={dot}
        onActivate={() => store.activateSessionView(thread.id, 'main')}
      />
      {views.map((v) => (
        <Tab
          key={v.id}
          testId={`tab-${v.id}`}
          icon={VIEW_ICON[v.kind]}
          // R1 语义：shell tab = oscTitle ?? label（OSC 标题改写）；
          // 非前台 BEL → hasBell 紫点；exit → 灰题
          label={sessionViewTitle(v)}
          active={activeId === v.id}
          exited={v.kind === 'shell' && v.status === 'exited'}
          dot={v.kind === 'shell' && v.hasBell ? 'need' : undefined}
          onActivate={() => store.activateSessionView(thread.id, v.id)}
          onClose={() => store.closeSessionView(thread.id, v.id)}
        />
      ))}
      {/* 「+」添加到当前 Session（原型 .tb-cell.tb-add-btn → session-add-pop） */}
      <div
        ref={addBtnRef}
        testId="session-add"
        tabIndex={0}
        onClick={(e) => setAddAt(addAnchor({ x: e.x ?? 0, y: (e.y ?? 0) + 10 }))}
        onMouseMove={(e) => {
          lastPointer.current = { x: e.x ?? 0, y: e.y ?? 0 }
        }}
        onKeyDown={(e) => {
          if (e.key === 'enter' || e.key === 'space')
            setAddAt(addAnchor({ x: lastPointer.current.x, y: lastPointer.current.y + 10 }))
        }}
        onMouseEnter={() => setAddHovered(true)}
        onMouseLeave={() => setAddHovered(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: 8,
          flexShrink: 0,
          alignSelf: 'center',
          cursor: 'pointer',
          pointerEvents: 'auto',
          color: COLORS.muted,
          hover: { backgroundColor: COLORS.surface },
        }}
      >
        {/* svg 不继承父级 color——悬停提亮显式给 */}
        <Icon name="plus" size={15} color={addHovered ? COLORS.textBright : COLORS.muted} />
      </div>
      {addAt ? (
        <AddPopover
          store={store}
          thread={thread}
          worktree={worktree}
          position={addAt}
          onClose={() => setAddAt(null)}
        />
      ) : null}
    </>
  )
}

/** 「+」浮层（原型 .session-add-pop：280px 卡 / r12 /
 *  shadow 0 14px 38px rgba(0,0,0,.5)；动作行 + 打开文件列表） */
function AddPopover({
  store,
  thread,
  worktree,
  position,
  onClose,
}: {
  store: ThreadStore
  thread: Thread
  worktree: WorktreeStore
  position: { x: number; y: number }
  onClose: () => void
}) {
  const files = useWorktree(worktree, (s) => s.files)
  const pick = (fn: () => void) => () => {
    onClose()
    fn()
  }
  return (
    <Popover
      testId="session-add-pop"
      position={position}
      onClose={onClose}
      minWidth={280}
      autoFocus
      // 原型 .session-add-pop：r12（--radius-lg）+ 0 14px 38px rgba(0,0,0,.5)
      style={{
        borderRadius: 12,
        boxShadow: {
          offsetX: 0,
          offsetY: 14,
          blurRadius: 38,
          spreadRadius: 0,
          color: 'rgba(0,0,0,0.5)',
        },
      }}
    >
      <AddAction
        testId="sa-git"
        icon="gitBranch"
        label="打开 Git 图"
        onPick={pick(() => store.openGitGraph())}
      />
      <AddAction
        testId="sa-shell"
        icon="terminal"
        label="新建 Shell"
        onPick={pick(() => void store.addSessionShell(thread.id))}
      />
      <text
        style={{
          fontSize: 10.5,
          fontWeight: '500',
          color: COLORS.muted,
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 8,
          paddingBottom: 4,
          pointerEvents: 'none',
        }}
      >
        打开文件
      </text>
      <div style={{ maxHeight: 220, overflowY: 'scroll' }}>
        {files.length === 0 ? (
          <text
            style={{
              fontSize: 11,
              color: COLORS.muted,
              paddingLeft: 8,
              paddingRight: 8,
              paddingBottom: 4,
              pointerEvents: 'none',
            }}
          >
            当前工作区无变更文件
          </text>
        ) : (
          files.map((f) => (
            <div
              key={f.path}
              testId={`sa-file-${f.path}`}
              onClick={pick(() => store.openSessionFile(thread.id, f.path))}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                paddingTop: 5,
                paddingBottom: 5,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 5,
                cursor: 'pointer',
                hover: { backgroundColor: COLORS.surface },
              }}
            >
              <text
                style={{
                  fontSize: 12,
                  color: COLORS.text,
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                  pointerEvents: 'none',
                }}
              >
                {f.path.split(/[\\/]/).pop()}
              </text>
              <text
                style={{
                  fontSize: 11,
                  fontFamily: FONT.mono,
                  color: COLORS.muted,
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                  pointerEvents: 'none',
                }}
              >
                {f.path}
              </text>
            </div>
          ))
        )}
      </div>
    </Popover>
  )
}

function AddAction({
  testId,
  icon,
  label,
  onPick,
}: {
  testId: string
  icon: IconName
  label: string
  onPick: () => void
}) {
  return (
    <div
      testId={testId}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onPick()
      }}
      tabIndex={0}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        height: 28,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 5,
        cursor: 'pointer',
        fontSize: 12,
        color: COLORS.text,
        hover: { backgroundColor: COLORS.surface },
      }}
    >
      <Icon name={icon} size={13} color={COLORS.muted} />
      <text style={{ pointerEvents: 'none' }}>{label}</text>
    </div>
  )
}

/** 非会话路由的单态页签（原型 ContextTab：workspace/settings/home 上下文） */
export function ContextTab({ icon, label }: { icon: IconName; label: string }) {
  return <Tab testId="tab-context" icon={icon} label={label} active />
}
