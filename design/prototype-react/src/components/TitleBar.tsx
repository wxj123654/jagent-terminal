import { useState } from 'react'
import { useStore } from '@/store'
import { threadById, wsById, tabInfo, rowTitle, statusDot, KIND_ICON } from '@/model'
import { Icon } from '@/icons'
import { DropMenu } from '@/components/ui/menu'
import { Pop } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Thread } from '@/types'

export function TitleBar({ narrow, sidebarHidden }: { narrow: boolean; sidebarHidden: boolean }) {
  const s = useStore()
  const branch = s.worktree.branch
  const showSearch = narrow || sidebarHidden
  const ctxCwd = contextCwd()
  const ctxLabel = contextLabel()
  const thread = s.route?.type === 'thread' ? threadById(s.threads, s.route.id) : null

  const branchPick = (id: string) => {
    if (id === 'graph') s.openGitGraph()
    else if (id === 'changes')
      useStore.setState(d => {
        d.ui.panelTab = 'changes'
        d.ui.panelOpen = true
      })
  }

  return (
    <div id="titlebar">
      <div id="titlebar-main">
        {narrow ? (
          <button
            type="button"
            className={cn('tb-cell tb-icon-btn', s.ui.drawerOpen && 'on')}
            title="会话列表"
            aria-label="会话列表"
            onClick={() => s.toggleDrawer()}
          >
            <Icon name="menu" size={16} />
          </button>
        ) : sidebarHidden ? (
          <button
            type="button"
            className="tb-cell tb-icon-btn"
            title="展开侧栏（Ctrl-B）"
            aria-label="展开侧栏"
            onClick={() => s.toggleSidebar()}
          >
            <Icon name="panelLeft" size={16} />
          </button>
        ) : null}
        <div className="tb-context" title={ctxCwd ?? ctxLabel}>
          <Icon name={s.route?.type === 'settings' ? 'gear' : 'folder'} size={13} />
          <span className="tb-context-name">{ctxLabel}</span>
          {!narrow && ctxCwd && <span className="cwd">{ctxCwd}</span>}
        </div>
        <div className="tb-fill" />
        {!narrow && branch && (
          <DropMenu
            items={[
              { id: 'graph', label: '打开 Git 图（Ctrl-Shift-G）' },
              { id: 'changes', label: '查看变更（工作面板）' },
            ]}
            onPick={branchPick}
            side="bottom"
            trigger={
              <button
                type="button"
                className="tb-cell tb-branch-btn"
                title="Git：切换分支 / 打开图 / 查看变更"
                aria-label="Git 分支"
              >
                <Icon name="gitBranch" size={14} />
                <span className="bt">{branch}</span>
                <Icon name="chevronDown" size={12} />
              </button>
            }
          />
        )}
        {showSearch && (
          <button
            type="button"
            className="tb-cell tb-icon-btn"
            title="搜索会话（Ctrl-K）"
            aria-label="搜索会话"
            onClick={() => s.openSearchDialog()}
          >
            <Icon name="search" size={15} />
          </button>
        )}
        {s.errors.length > 0 && (
          <button
            type="button"
            className="tb-cell tb-error-btn"
            title="错误历史"
            aria-label="错误历史"
            onClick={() => useStore.setState(d => void (d.ui.dialog = { kind: 'errors' }))}
          >
            <Icon name="alert" size={13} />
            <span className="err-n">{s.errors.length}</span>
          </button>
        )}
        {s.settings.advanced.perfHud && (
          <span id="perf-hud">60fps · draw 2.1/4.8ms · term 0.6/1.2ms · cpu 3% · mem 214MB</span>
        )}
        <button
          type="button"
          className={cn('tb-cell tb-icon-btn', s.ui.panelOpen && 'on')}
          title="工作面板"
          aria-label="工作面板"
          onClick={() => useStore.setState(d => void (d.ui.panelOpen = !d.ui.panelOpen))}
        >
          <Icon name="panelRight" size={15} />
        </button>
        <div className="win-ctl">
          <button
            type="button"
            className="wb"
            title="最小化"
            aria-label="最小化"
            onClick={() => s.toast('最小化（原型占位）')}
          >
            &#xE921;
          </button>
          <button
            type="button"
            className="wb"
            title="最大化"
            aria-label="最大化"
            onClick={() => s.toast('最大化/还原（原型占位）')}
          >
            &#xE922;
          </button>
          <button
            type="button"
            className="wb close"
            title="关闭"
            aria-label="关闭"
            onClick={() => s.toast('关闭窗口（原型占位）')}
          >
            &#xE8BB;
          </button>
        </div>
      </div>
      <div id="tb-tabs" role="tablist">
        {thread ? <SessionTabs t={thread} /> : <ContextTab />}
      </div>
    </div>
  )
}

function SessionTabs({ t }: { t: Thread }) {
  const s = useStore()
  const [addOpen, setAddOpen] = useState(false)
  const views = t.views ?? []
  const activeId = views.some(v => v.id === t.activeViewId) ? t.activeViewId! : 'main'
  const dot0 = statusDot(t)
  const dot = dot0 && !['idle', 'idle-on', 'exited'].includes(dot0) ? dot0 : null
  const exited = t.kind === 'terminal' && t.status === 'exited'
  const viewIcon = (k: string) => (k === 'git' ? 'gitBranch' : k === 'file' ? 'file' : 'terminal')
  return (
    <>
      <div
        role="tab"
        aria-selected={activeId === 'main'}
        className={cn('tab', activeId === 'main' && 'active', exited && 'exited')}
        title={rowTitle(t)}
        onClick={() => s.activateSessionView(t.id, 'main')}
      >
        <span className="tic">
          <Icon name={KIND_ICON[t.kind]} size={13} />
        </span>
        {dot && <span className={`dot ${dot}`} />}
        <span className="ttl">{rowTitle(t)}</span>
      </div>
      {views.map(v => (
        <div
          key={v.id}
          role="tab"
          aria-selected={activeId === v.id}
          className={cn('tab', activeId === v.id && 'active')}
          title={v.kind === 'file' ? v.path : v.kind === 'shell' ? v.cwd : v.label}
          onClick={() => s.activateSessionView(t.id, v.id)}
          onMouseDown={e => {
            if (e.button === 1) {
              e.preventDefault()
              s.closeSessionView(t.id, v.id)
            }
          }}
        >
          <span className="tic">
            <Icon name={viewIcon(v.kind)} size={13} />
          </span>
          <span className="ttl">{v.label}</span>
          <span
            className="tx"
            onClick={e => {
              e.stopPropagation()
              s.closeSessionView(t.id, v.id)
            }}
          >
            <Icon name="close" size={11} />
          </span>
        </div>
      ))}
      <Pop
        open={addOpen}
        onOpenChange={setAddOpen}
        className="session-add-pop"
        anchor={
          <button
            type="button"
            className="tb-cell tb-icon-btn tb-add-btn"
            title="添加到当前 Session"
            aria-label="添加到当前 Session"
            onClick={() => setAddOpen(v => !v)}
          >
            <Icon name="plus" size={15} />
          </button>
        }
      >
        <div
          className="sa-act"
          onClick={() => {
            setAddOpen(false)
            s.openGitGraph()
          }}
        >
          <Icon name="gitBranch" size={13} />
          <span>打开 Git 图</span>
        </div>
        <div
          className="sa-act"
          onClick={() => {
            setAddOpen(false)
            s.addSessionShell(t.id)
          }}
        >
          <Icon name="terminal" size={13} />
          <span>新建 Shell</span>
        </div>
        <div className="sa-sub">打开文件</div>
        <div className="sa-files">
          {s.worktree.files.map(f => (
            <div
              className="sa-file"
              key={f.path}
              onClick={() => {
                setAddOpen(false)
                s.openSessionFile(t.id, f.path)
              }}
            >
              <span className="nm">{f.path.split('/').pop()}</span>
              <span className="p">{f.path}</span>
            </div>
          ))}
        </div>
      </Pop>
    </>
  )
}

function ContextTab() {
  const s = useStore()
  const r = s.route
  const info = r && r.type !== 'thread' ? tabInfo(s.threads, s.workspaces, r) : null
  return (
    <div className="tab active" role="tab" aria-selected="true" title={info?.tip ?? '主页'}>
      <span className="tic">
        <Icon name={info?.icon ?? 'home'} size={13} />
      </span>
      <span className="ttl">{info?.label ?? '主页'}</span>
    </div>
  )
}

function contextLabel() {
  const s = useStore.getState()
  const r = s.route
  if (r?.type === 'thread') {
    const t = threadById(s.threads, r.id)
    return wsById(s.workspaces, t?.workspaceId)?.name ?? '未归属 Session'
  }
  if (r?.type === 'workspace') return wsById(s.workspaces, r.id)?.name ?? 'j-agent'
  if (r?.type === 'settings') return '设置'
  return 'j-agent'
}

function contextCwd() {
  const s = useStore.getState()
  const r = s.route
  if (r?.type === 'thread') {
    const t = threadById(s.threads, r.id)
    if (!t) return null
    if (t.kind === 'terminal') return t.cwd
    return wsById(s.workspaces, t.workspaceId)?.path ?? null
  }
  if (r?.type === 'workspace') return wsById(s.workspaces, r.id)?.path ?? null
  return null
}
