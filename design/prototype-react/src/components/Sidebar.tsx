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

function wsMenuItems(ws: Workspace): MenuItem[] {
  return [
    { id: 'pin', label: ws.pin ? '取消置顶' : '置顶工作区' },
    { id: 'rename', label: '重命名…' },
    'sep',
    { id: 'remove', label: '移除工作区', danger: true },
  ]
}

export function Sidebar() {
  const width = useStore(s => s.settings.appearance.sidebarWidth)
  const unread = useStore(s => s.notices.length - s.noticesRead)
  const workspaces = useStore(s => s.workspaces)
  const threads = useStore(s => s.threads)
  const route = useStore(s => s.route)
  const notifOpen = useStore(s => s.ui.notifOpen)
  const notices = useStore(s => s.notices)
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
      <div className="sb-head">
        <div className="lead" />
        <div
          className="ibtn"
          title="收起侧栏（Ctrl-B）"
          onClick={() => useStore.getState().toggleSidebar()}
        >
          <Icon name="panelLeft" size={16} />
        </div>
      </div>
      <div className="sb-nav">
        <div
          className="nav-row"
          onClick={() => useStore.getState().openToolDialog(newSessionWorkspace())}
        >
          <span className="ic">
            <Icon name="plus" size={14} />
          </span>
          <span className="lbl">新建会话</span>
        </div>
        <div className="nav-row" onClick={() => useStore.getState().openSearchDialog()}>
          <span className="ic">
            <Icon name="search" size={14} />
          </span>
          <span className="lbl">搜索</span>
        </div>
      </div>
      <div className="sec-head">
        <span className="t">工作区</span>
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
      <div className="sb-foot">
        <div
          className="ibtn"
          title="设置（Ctrl-,）"
          onClick={() => useStore.getState().openSettings()}
        >
          <Icon name="gear" size={16} />
        </div>
        <Pop
          open={notifOpen}
          onOpenChange={o => useStore.setState(d => void (d.ui.notifOpen = o))}
          side="top"
          align="start"
          sideOffset={10}
          className="notif-pop"
          anchor={
            <div className="ibtn" title="通知">
              <Icon name="bell" size={16} />
              {unread > 0 && <span className="badge-dot" />}
            </div>
          }
        >
          <div className="notif-head">
            <span className="t">通知</span>
            <span
              className="notif-clear"
              onClick={() => useStore.setState(d => void (d.noticesRead = d.notices.length))}
            >
              <Icon name="check" size={12} /> 全部已读
            </span>
          </div>
          <div className="notif-list">
            {!notices.length ? (
              <div className="notif-empty">暂无通知</div>
            ) : (
              [...notices].reverse().map(n => (
                <div className="notif-item" key={n.id}>
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
                  <span>
                    <div className="nt">{n.title}</div>
                    <div className="ns">
                      {n.sub} · {relTime(n.at)}
                    </div>
                  </span>
                </div>
              ))
            )}
          </div>
        </Pop>
        <span className="ver">v0.1</span>
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
  const sorted = sortThreads(sessions)
  const keepId = route?.type === 'thread' ? route.id : null
  const shown = ws.showAll
    ? sorted
    : sorted.slice(0, Math.max(GROUP_LIMIT, sorted.findIndex(t => t.id === keepId) + 1 || 0))
  const hidden = sorted.length - shown.length

  const pick = (item: string) => {
    const st = useStore.getState()
    if (item === 'pin') useStore.setState(d => void ((wsById(d.workspaces, ws.id)!).pin = !ws.pin))
    else if (item === 'rename')
      useStore.setState(d => void (d.ui.dialog = { kind: 'rename', target: { type: 'workspace', id: ws.id } }))
    else if (item === 'remove') st.wsRemove(ws.id)
  }

  return (
    <div className="ws-group">
      <div className="ws-head">
        <CtxMenu items={wsMenuItems(ws)} onPick={pick}>
          <div
            className="ws-row"
            role="button"
            tabIndex={0}
            aria-expanded={ws.expanded}
            title={ws.path}
            onClick={e => {
              if (e.detail > 1) return
              useStore.setState(d => void ((wsById(d.workspaces, ws.id)!).expanded = !ws.expanded))
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                useStore.setState(d => void ((wsById(d.workspaces, ws.id)!).expanded = !ws.expanded))
                e.preventDefault()
              } else if (e.key === 'ArrowRight' && !ws.expanded) {
                useStore.setState(d => void ((wsById(d.workspaces, ws.id)!).expanded = true))
                e.preventDefault()
              } else if (e.key === 'ArrowLeft' && ws.expanded) {
                useStore.setState(d => void ((wsById(d.workspaces, ws.id)!).expanded = false))
                e.preventDefault()
              }
            }}
          >
            <span className="ws-mark"><Icon name="folder" size={13} /></span>
            <span className="name">{ws.name}</span>
          </div>
        </CtxMenu>
        <span className="acts">
          <DropMenu
            items={wsMenuItems(ws)}
            onPick={pick}
            trigger={
              <span className="ghost" title="工作区菜单" onClick={e => e.stopPropagation()}>
                <Icon name="more" size={12} />
              </span>
            }
          />
          <span
            className="ghost"
            title="新建会话"
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
          <Icon name={KIND_ICON[t.kind]} size={12} />
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
            <span className="menu-btn" onClick={e => e.stopPropagation()}>
              <Icon name="more" size={12} />
            </span>
          }
        />
      </div>
    </CtxMenu>
  )
}
