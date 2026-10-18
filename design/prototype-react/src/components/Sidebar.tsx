import { useRef } from 'react'
import { useStore } from '@/store'
import { wsById, threadById, rowTitle, sortThreads, sortWorkspaces, statusDot, relTime, KIND_ICON } from '@/model'
import { GROUP_LIMIT } from '@/seed'
import { Icon } from '@/icons'
import { CtxMenu, DropMenu, type MenuItem } from '@/components/ui/menu'
import { Pop } from '@/components/ui/popover'
import type { Thread, Workspace } from '@/types'
import { cn } from '@/lib/utils'

function threadMenuItems(t: Thread): MenuItem[] {
  return [
    { id: 'pin', label: t.pin ? '取消置顶' : '置顶' },
    { id: 'rename', label: '重命名…' },
    { id: 'unread', label: t.unread ? '标记为已读' : '标记为未读' },
    'sep',
    { id: 'remove', label: '移除', danger: true },
  ]
}

function wsMenuItems(ws: Workspace, sessionCount: number, exitedCount: number): MenuItem[] {
  return [
    { id: 'pin', label: ws.pin ? '取消置顶' : '置顶工作区' },
    { id: 'rename', label: '重命名…' },
    ...(exitedCount > 0 ? ([{ id: 'clear-exited', label: `清理已退出会话 (${exitedCount})` }] as MenuItem[]) : []),
    ...(sessionCount > 0 ? ([{ id: 'clear-all', label: `清空工作区会话 (${sessionCount})`, danger: true }] as MenuItem[]) : []),
    'sep',
    { id: 'remove', label: '移除工作区', danger: true },
  ]
}

export function Sidebar() {
  const width = useStore(s => s.settings.appearance.sidebarWidth)
  const notices = useStore(s => s.notices)
  const unread = notices.filter(n => !n.read).length
  const workspaces = useStore(s => s.workspaces)
  const threads = useStore(s => s.threads)
  const route = useStore(s => s.route)
  const notifOpen = useStore(s => s.ui.notifOpen)
  const settingsWinOpen = useStore(s => s.ui.settingsWindowOpen)
  const resizing = useRef(false)

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    resizing.current = true
    const app = document.getElementById('app')!
    const move = (ev: MouseEvent) => {
      const r = app.getBoundingClientRect()
      const w = Math.round(Math.min(400, Math.max(200, ev.clientX - r.left)))
      useStore.setState(d => void (d.settings.appearance.sidebarWidth = w))
    }
    const up = () => {
      resizing.current = false
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div id="sidebar" style={{ width }}>
      <div className="sb-resize" onMouseDown={startDrag} />

      {/* ── 左悬浮岛 40px 顶栏（与右悬浮岛 40px 顶栏严格镜像对齐） ── */}
      <div className="sb-head">
        <div className="traffic-lights">
          <span className="tl r" />
          <span className="tl y" />
          <span className="tl g" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className="tb-cell tb-branch-btn"
            style={{ height: 24, padding: '0 7px', fontSize: 11, gap: 4 }}
            title="全局搜索会话（⌘K / Ctrl-K）"
            onClick={() => useStore.getState().openSearchDialog()}
          >
            <Icon name="search" size={12} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted)' }}>⌘K</span>
          </button>
          <div
            className="ibtn"
            style={{ width: 26, height: 26 }}
            title="收起导航岛（⌘B / Ctrl-B）"
            onClick={() => useStore.getState().toggleSidebar()}
          >
            <Icon name="panelLeft" size={14} />
          </div>
        </div>
      </div>

      {/* ── 同源内嵌主动作条：「＋ 新建会话」+ 快捷键徽标 ── */}
      <div className="sb-actions-bar">
        <button
          type="button"
          className="sb-btn-primary"
          onClick={() => useStore.getState().openToolDialog(newSessionWorkspace())}
        >
          <span style={{ color: 'var(--accentHover)', display: 'flex' }}>
            <Icon name="plus" size={13} />
          </span>
          <span>新建会话</span>
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--muted)',
              padding: '1px 5px',
              borderRadius: 4,
              background: 'rgba(255,255,255,.04)',
              border: '1px solid var(--borderSubtle)',
            }}
          >
            ⌘N
          </span>
        </button>
      </div>

      <div className="sec-head">
        <span className="t">工作区 ({workspaces.length})</span>
        <div
          className="ghost"
          title="添加工作区"
          onClick={() =>
            useStore.setState(d => void (d.ui.dialog = { kind: 'addWorkspace' }))
          }
        >
          <Icon name="plus" size={12} />
        </div>
      </div>

      <div className="sb-scroll">
        {sortWorkspaces(workspaces).map(ws => (
          <WorkspaceGroup key={ws.id} ws={ws} threads={threads} route={route} />
        ))}
        <Unassigned threads={threads} route={route} />
      </div>

      {/* ── 底栏：通知中心浮层 + 版本状态 + 独立设置窗口入口 ── */}
      <div className="sb-foot">
        <Pop
          open={notifOpen}
          onOpenChange={o => useStore.setState(d => void (d.ui.notifOpen = o))}
          side="top"
          align="start"
          sideOffset={10}
          className="notif-pop"
          anchor={
            <div className="ibtn" title="通知中心">
              <Icon name="bell" size={15} />
              {unread > 0 && <span className="badge-dot" />}
            </div>
          }
        >
          <div className="notif-head">
            <span className="t" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>通知中心</span>
              {unread > 0 && (
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    padding: '0 6px',
                    borderRadius: 999,
                    background: 'var(--accentSoft)',
                    color: 'var(--accentHover)',
                    border: '1px solid rgba(99,102,241,.35)',
                  }}
                >
                  {unread} 未读
                </span>
              )}
            </span>
            <span
              className="notif-clear"
              onClick={() =>
                useStore.setState(d => {
                  d.notices.forEach(n => (n.read = true))
                  d.noticesRead = d.notices.length
                })
              }
            >
              <Icon name="check" size={12} /> 全部已读
            </span>
          </div>
          <div className="notif-list">
            {!notices.length ? (
              <div className="notif-empty">暂无通知</div>
            ) : (
              [...notices].reverse().map(n => (
                <div
                  className="notif-item"
                  key={n.id}
                  style={{
                    cursor: 'pointer',
                    background: n.read ? 'transparent' : 'rgba(99,102,241,.07)',
                    borderRadius: 7,
                    margin: '2px 6px',
                    padding: '8px 10px',
                  }}
                  onClick={() => {
                    useStore.setState(d => {
                      const target = d.notices.find(x => x.id === n.id)
                      if (target) target.read = true
                      d.ui.notifOpen = false
                    })
                    if (n.threadId) {
                      useStore.getState().activate({ type: 'thread', id: n.threadId })
                    }
                  }}
                >
                  <span
                    className="nd"
                    style={{
                      background:
                        n.tone === 'ok'
                          ? 'var(--statusDone)'
                          : n.tone === 'warn'
                            ? 'var(--statusRunning)'
                            : 'var(--statusError)',
                    }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div className="nt" style={{ fontWeight: n.read ? 400 : 600, color: n.read ? 'var(--text)' : 'var(--textBright)' }}>
                      {n.title}
                    </div>
                    <div className="ns" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      <span>{n.sub} · {relTime(n.at)}</span>
                      {n.threadId && (
                        <span style={{ color: 'var(--accentHover)', fontSize: 10 }}>跳转 →</span>
                      )}
                    </div>
                  </span>
                </div>
              ))
            )}
          </div>
        </Pop>

        <span className="ver" style={{ margin: '0 auto', fontFamily: 'var(--font-mono)' }}>
          v0.4.0 · GPUI
        </span>

        <div
          className={cn('ibtn', settingsWinOpen && 'on')}
          title="打开独立设置窗口（⌘, / Ctrl-,）"
          onClick={() => useStore.getState().openSettings()}
        >
          <Icon name="gear" size={15} />
        </div>
      </div>
    </div>
  )
}

function newSessionWorkspace() {
  const s = useStore.getState()
  const r = s.route
  if (r?.type === 'thread') {
    const t = threadById(s.threads, r.id)
    if (t?.workspaceId) return t.workspaceId
  }
  if (r?.type === 'workspace') return r.id
  return s.workspaces[0]?.id ?? ''
}

function WorkspaceGroup({
  ws,
  threads,
  route,
}: {
  ws: Workspace
  threads: Thread[]
  route: ReturnType<typeof useStore.getState>['route']
}) {
  const sessions = threads.filter(t => t.workspaceId === ws.id)
  const exitedCount = sessions.filter(t => t.kind === 'terminal' && t.status === 'exited').length
  const sorted = sortThreads(sessions)
  const keepId = route?.type === 'thread' ? route.id : null
  const shown = ws.showAll
    ? sorted
    : sorted.slice(0, Math.max(GROUP_LIMIT, sorted.findIndex(t => t.id === keepId) + 1 || 0))
  const hidden = sorted.length - shown.length
  const isWsActive = route?.type === 'workspace' && route.id === ws.id

  const pick = (item: string) => {
    const st = useStore.getState()
    if (item === 'pin') useStore.setState(d => void ((wsById(d.workspaces, ws.id)!).pin = !ws.pin))
    else if (item === 'rename')
      useStore.setState(d => void (d.ui.dialog = { kind: 'rename', target: { type: 'workspace', id: ws.id } }))
    else if (item === 'clear-exited') st.clearExitedSessions(ws.id)
    else if (item === 'clear-all') {
      useStore.setState(d => {
        d.threads = d.threads.filter(t => t.workspaceId !== ws.id)
      })
      st.toast(`已清空「${ws.name}」下的全部会话`)
    } else if (item === 'remove') st.wsRemove(ws.id)
  }

  return (
    <div className="ws-group">
      <div className="ws-head">
        <CtxMenu items={wsMenuItems(ws, sessions.length, exitedCount)} onPick={pick}>
          <div
            className="ws-row"
            role="button"
            tabIndex={0}
            aria-expanded={ws.expanded}
            title={`${ws.name} · ${ws.path}`}
            style={isWsActive ? { background: 'rgba(99,102,241,.14)', color: 'var(--textBright)' } : undefined}
            onClick={() => {
              useStore.setState(d => {
                const w = wsById(d.workspaces, ws.id)
                if (w) {
                  w.expanded = true
                  w.paneTab = 'home'
                }
                d.route = { type: 'workspace', id: ws.id }
              })
            }}
          >
            <span
              className="ws-mark"
              style={{ color: isWsActive ? 'var(--accentHover)' : 'var(--muted)' }}
              onClick={e => {
                e.stopPropagation()
                useStore.setState(d => void ((wsById(d.workspaces, ws.id)!).expanded = !ws.expanded))
              }}
              title={ws.expanded ? '收起工作区会话' : '展开工作区会话'}
            >
              <Icon name="folder" size={13.5} />
            </span>
            <span className="name" style={isWsActive ? { color: 'var(--textBright)', fontWeight: 600 } : undefined}>
              {ws.name}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                color: 'var(--faint)',
                marginLeft: 4,
              }}
            >
              {sessions.length}
            </span>
          </div>
        </CtxMenu>
        <span className="acts">
          <DropMenu
            items={wsMenuItems(ws, sessions.length, exitedCount)}
            onPick={pick}
            trigger={
              <span className="ghost" title="工作区菜单" onClick={e => e.stopPropagation()}>
                <Icon name="more" size={12} />
              </span>
            }
          />
          <span
            className="ghost"
            title="在此工作区新建会话"
            onClick={e => {
              e.stopPropagation()
              useStore.getState().openToolDialog(ws.id)
            }}
          >
            <Icon name="plus" size={12} />
          </span>
        </span>
      </div>
      <div
        className={cn('ws-collapse', ws.expanded && 'open')}
        aria-hidden={!ws.expanded}
        inert={!ws.expanded}
      >
        <div className="ws-collapse-inner">
          <div className="ws-body">
            {sessions.length === 0 ? (
              <div
                className="ws-empty-hint"
                onClick={() => useStore.getState().openToolDialog(ws.id)}
              >
                <Icon name="plus" size={11} />
                启动第一个会话
              </div>
            ) : (
              <>
                {shown.map(t => (
                  <ThreadRow key={t.id} t={t} route={route} />
                ))}
                {hidden > 0 && (
                  <div
                    className="more-link"
                    onClick={() => useStore.setState(d => void ((wsById(d.workspaces, ws.id)!).showAll = true))}
                  >
                    <Icon name="chevronDown" size={11} />
                    显示另外 {hidden} 个
                  </div>
                )}
                {ws.showAll && sorted.length > GROUP_LIMIT && (
                  <div
                    className="more-link"
                    onClick={() => useStore.setState(d => void ((wsById(d.workspaces, ws.id)!).showAll = false))}
                  >
                    <Icon name="chevronUp" size={11} />
                    收起会话
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Unassigned({
  threads,
  route,
}: {
  threads: Thread[]
  route: ReturnType<typeof useStore.getState>['route']
}) {
  const showAll = useStore(s => s.unassignedShowAll)
  const list = threads.filter(t => t.workspaceId == null)
  if (!list.length) return null
  const sorted = sortThreads(list)
  const keepId = route?.type === 'thread' ? route.id : null
  const shown = showAll
    ? sorted
    : sorted.slice(0, Math.max(GROUP_LIMIT, sorted.findIndex(t => t.id === keepId) + 1 || 0))
  const hidden = sorted.length - shown.length
  return (
    <div className="ws-group">
      <div className="ws-head">
        <div className="ws-row unassigned" title="不属于任何工作区的会话">
          <span className="ws-mark"><Icon name="inbox" size={13} /></span>
          <span className="name">未归属会话</span>
        </div>
      </div>
      <div className="ws-body">
        {shown.map(t => (
          <ThreadRow key={t.id} t={t} route={route} />
        ))}
        {hidden > 0 && (
          <div
            className="more-link"
            onClick={() => useStore.setState(d => void (d.unassignedShowAll = true))}
          >
            <Icon name="chevronDown" size={11} />
            显示另外 {hidden} 个
          </div>
        )}
        {showAll && sorted.length > GROUP_LIMIT && (
          <div
            className="more-link"
            onClick={() => useStore.setState(d => void (d.unassignedShowAll = false))}
          >
            <Icon name="chevronUp" size={11} />
            收起会话
          </div>
        )}
      </div>
    </div>
  )
}

export function ThreadRow({
  t,
  route,
}: {
  t: Thread
  route: ReturnType<typeof useStore.getState>['route']
}) {
  const isActive = route?.type === 'thread' && route.id === t.id
  const exited = t.kind === 'terminal' && t.status === 'exited'
  const unread = !exited && !!t.unread
  let dot = statusDot(t)
  if (dot === 'idle' && isActive) dot = 'idle-on'
  const kindLabel = t.kind === 'terminal' ? '终端' : t.kind === 'chat' ? '对话' : 'ACP agent'

  const pick = (item: string) => {
    const st = useStore.getState()
    if (item === 'pin') useStore.setState(d => void ((threadById(d.threads, t.id)!).pin = !t.pin))
    else if (item === 'unread')
      useStore.setState(d => void ((threadById(d.threads, t.id)!).unread = !t.unread))
    else if (item === 'rename')
      useStore.setState(d => void (d.ui.dialog = { kind: 'rename', target: { type: 'thread', id: t.id } }))
    else if (item === 'remove') st.closeThread(t.id)
  }

  return (
    <CtxMenu items={threadMenuItems(t)} onPick={pick}>
      <div
        className={cn('t-row', isActive && 'active')}
        tabIndex={0}
        onClick={() => useStore.getState().activate({ type: 'thread', id: t.id })}
        onKeyDown={e => {
          if ((e.target as HTMLElement).tagName === 'INPUT') return
          if (e.key === 'Delete' || e.key === 'Backspace') {
            useStore.getState().closeThread(t.id)
            e.preventDefault()
          } else if (e.key === 'Enter') {
            useStore.getState().activate({ type: 'thread', id: t.id })
            e.preventDefault()
          }
        }}
      >
        <span className={cn('thread-kind', t.kind, exited && 'exited')} title={kindLabel}>
          <Icon name={KIND_ICON[t.kind]} size={12.5} />
          {dot !== 'exited' && dot !== 'idle' && <span className={`dot ${dot}`} />}
        </span>
        <span className={cn('ttl', exited && 'exited', unread && 'unread')}>{rowTitle(t)}</span>
        {t.pin && (
          <span className="pin-ic">
            <Icon name="pin" size={12} />
          </span>
        )}
        <DropMenu
          items={threadMenuItems(t)}
          onPick={pick}
          trigger={
            <span className="menu-btn" title="更多操作" onClick={e => e.stopPropagation()}>
              <Icon name="more" size={12} />
            </span>
          }
        />
        <span
          className="menu-btn"
          title={`移除会话「${rowTitle(t)}」`}
          aria-label={`移除会话 ${rowTitle(t)}`}
          onClick={e => {
            e.stopPropagation()
            useStore.getState().closeThread(t.id)
          }}
        >
          <Icon name="close" size={11.5} />
        </span>
      </div>
    </CtxMenu>
  )
}
