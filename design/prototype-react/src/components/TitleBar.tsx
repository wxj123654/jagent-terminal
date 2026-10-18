import { useState } from 'react'
import { useStore } from '@/store'
import { threadById, wsById, rowTitle, statusDot, KIND_ICON } from '@/model'
import { Icon } from '@/icons'
import { DropMenu } from '@/components/ui/menu'
import { Pop } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Thread } from '@/types'

/**
 * 单行 40px 融合顶栏（TitleBar）
 * - 消除旧版「#titlebar-main (44px) + #tb-tabs (38px) + conv-head (44px)」三层横栏堆叠；
 * - 左侧显示工作区 / 会话面包屑 + 对话连接状态胶囊；
 * - 中部内联渲染会话内副视图胶囊组（SessionTabs）；
 * - 右侧显示 Git 分支下拉胶囊、错误指示器与右侧工作面板开关。
 */
export function TitleBar({ narrow, sidebarHidden }: { narrow: boolean; sidebarHidden: boolean }) {
  const s = useStore()
  const branch = s.worktree.branch
  const showSearch = narrow || sidebarHidden
  const ctxCwd = contextCwd()
  const ctxLabel = contextLabel()
  const thread = s.route?.type === 'thread' ? threadById(s.threads, s.route.id) : null
  const isConv = thread && (thread.kind === 'chat' || thread.kind === 'acp')

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
            title="展开侧栏（⌘B / Ctrl-B）"
            aria-label="展开侧栏"
            onClick={() => s.toggleSidebar()}
          >
            <Icon name="panelLeft" size={16} />
          </button>
        ) : null}

        {/* ── 左侧面包屑 + 会话连接状态胶囊 ── */}
        <div
          className="tb-context"
          title={ctxCwd ?? ctxLabel}
          style={{ cursor: 'pointer' }}
          onClick={() => {
            const wsId = thread?.workspaceId ?? (s.route?.type === 'workspace' ? s.route.id : s.workspaces[0]?.id)
            if (wsId) {
              useStore.setState(d => {
                const w = wsById(d.workspaces, wsId)
                if (w) w.paneTab = 'home'
                d.route = { type: 'workspace', id: wsId }
              })
            }
          }}
        >
          <span style={{ color: 'var(--accentHover)', display: 'flex' }}>
            <Icon name="folder" size={13.5} />
          </span>
          <span className="tb-context-name">{ctxLabel}</span>
          {!narrow && !thread && ctxCwd && <span className="cwd">{ctxCwd}</span>}
        </div>

        {/* ── 中部内联副视图胶囊组（SessionTabs 合一，不再占第二行）── */}
        {thread && (
          <div className="tb-inline-tabs" role="tablist">
            <SessionTabs t={thread} narrow={narrow} />
          </div>
        )}

        {/* ── AI 对话 / ACP 连接状态胶囊（替代原 conv-head 独立栏）── */}
        {isConv && !narrow && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              height: 22,
              padding: '0 8px',
              borderRadius: 999,
              fontSize: 10.5,
              fontWeight: 500,
              background: thread.pendingReply ? 'rgba(251,191,36,.14)' : 'rgba(52,211,153,.14)',
              color: thread.pendingReply ? 'var(--statusRunning)' : 'var(--statusDone)',
              border: `1px solid ${thread.pendingReply ? 'rgba(251,191,36,.3)' : 'rgba(52,211,153,.3)'}`,
            }}
          >
            <span className={cn('dot', thread.pendingReply ? 'running' : 'done')} style={{ width: 6, height: 6 }} />
            <span>{thread.pendingReply ? '正在回复…' : thread.kind === 'acp' ? '已连接 ACP' : '在线'}</span>
          </span>
        )}

        <div className="tb-fill" />

        {!narrow && branch && (
          <DropMenu
            items={[
              { id: 'graph', label: '打开 Git 提交图谱（Ctrl-Shift-G）' },
              { id: 'changes', label: '查看工作区变更（右侧面板）' },
            ]}
            onPick={branchPick}
            side="bottom"
            trigger={
              <button
                type="button"
                className="tb-cell tb-branch-btn"
                title="Git：打开提交图谱 / 查看变更"
                aria-label="Git 分支"
              >
                <span style={{ color: 'var(--accentHover)', display: 'flex' }}>
                  <Icon name="gitBranch" size={13.5} />
                </span>
                <span className="bt">{branch}</span>
                <Icon name="chevronDown" size={11} />
              </button>
            }
          />
        )}

        {showSearch && (
          <button
            type="button"
            className="tb-cell tb-icon-btn"
            title="搜索会话（⌘K / Ctrl-K）"
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
          title="工作区变更与文件面板"
          aria-label="工作面板"
          onClick={() => useStore.setState(d => void (d.ui.panelOpen = !d.ui.panelOpen))}
        >
          <Icon name="panelRight" size={15} />
        </button>
      </div>
    </div>
  )
}

const MAX_INLINE_VIEWS = 2

function SessionTabs({ t, narrow }: { t: Thread; narrow?: boolean }) {
  const s = useStore()
  const [addOpen, setAddOpen] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [filterQ, setFilterQ] = useState('')
  const views = t.views ?? []
  const activeId = views.some(v => v.id === t.activeViewId) ? t.activeViewId! : 'main'
  const dot0 = statusDot(t)
  const dot = dot0 && !['idle', 'idle-on', 'exited'].includes(dot0) ? dot0 : null
  const exited = t.kind === 'terminal' && t.status === 'exited'
  const viewIcon = (k: string) => (k === 'git' ? 'gitBranch' : k === 'file' ? 'file' : 'terminal')
  const maxInline = narrow ? 1 : MAX_INLINE_VIEWS

  // 定数上限：顶栏最多展示 maxInline 个副页签；若当前激活项在溢出区，自动置换到最后一个可见槽
  let visibleViews = views.slice(0, maxInline)
  if (views.length > maxInline && activeId !== 'main') {
    const activeView = views.find(v => v.id === activeId)
    if (activeView && !visibleViews.some(v => v.id === activeId)) {
      visibleViews = [...views.slice(0, maxInline - 1), activeView]
    }
  }
  const overflowCount = Math.max(0, views.length - visibleViews.length)
  const q = filterQ.trim().toLowerCase()
  const filteredViews = q
    ? views.filter(v =>
        `${v.label} ${v.kind === 'file' ? v.path : ''}`.toLowerCase().includes(q),
      )
    : views

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
          <Icon name={KIND_ICON[t.kind]} size={12.5} />
        </span>
        {dot && <span className={`dot ${dot}`} />}
        <span className="ttl">{rowTitle(t)}</span>
      </div>
      {visibleViews.map(v => (
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
            <Icon name={viewIcon(v.kind)} size={12.5} />
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

      {/* 溢出收纳胶囊 [+N ▾] */}
      {overflowCount > 0 && (
        <Pop
          open={overflowOpen}
          onOpenChange={o => {
            setOverflowOpen(o)
            if (!o) setFilterQ('')
          }}
          className="session-add-pop"
          align="end"
          anchor={
            <button
              type="button"
              className={cn('tb-overflow-btn', overflowOpen && 'on')}
              title={`还有 ${overflowCount} 个已打开的副视图（点击展开管理）`}
              aria-label="更多副视图"
              onClick={() => setOverflowOpen(v => !v)}
            >
              <span>+{overflowCount}</span>
              <Icon name="chevronDown" size={10.5} />
            </button>
          }
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 28,
              padding: '0 8px',
              marginBottom: 4,
              borderRadius: 6,
              background: 'var(--inputBg)',
              border: '1px solid var(--borderSubtle)',
              color: 'var(--muted)',
            }}
          >
            <Icon name="search" size={12} />
            <input
              autoFocus
              placeholder={`过滤已打开视图 (${views.length})…`}
              value={filterQ}
              onChange={e => setFilterQ(e.target.value)}
              style={{
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                border: 'none',
                fontSize: 11.5,
                color: 'var(--textBright)',
              }}
            />
          </div>
          <div className="sa-sub" style={{ paddingTop: 2 }}>
            当前会话副视图 ({views.length}) · 顶栏上限 {MAX_INLINE_VIEWS} 项
          </div>
          <div className="sa-files" style={{ maxHeight: 210 }}>
            {filteredViews.map(v => {
              const isAct = activeId === v.id
              const isInBar = visibleViews.some(x => x.id === v.id)
              return (
                <div
                  key={v.id}
                  className="sa-act"
                  style={{
                    height: 30,
                    justifyContent: 'space-between',
                    background: isAct ? 'var(--surfaceActive)' : undefined,
                  }}
                  onClick={() => {
                    setOverflowOpen(false)
                    s.activateSessionView(t.id, v.id)
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, flex: 1 }}>
                    <span style={{ color: isAct ? 'var(--accentHover)' : 'var(--muted)', display: 'flex' }}>
                      <Icon name={viewIcon(v.kind)} size={12.5} />
                    </span>
                    <span
                      style={{
                        color: isAct ? 'var(--textBright)' : 'var(--text)',
                        fontWeight: isAct ? 600 : 400,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {v.label}
                    </span>
                    {!isInBar && (
                      <span
                        style={{
                          fontSize: 9.5,
                          fontFamily: 'var(--font-mono)',
                          padding: '0 5px',
                          borderRadius: 4,
                          background: 'rgba(99,102,241,.14)',
                          color: 'var(--accentHover)',
                        }}
                      >
                        已收纳
                      </span>
                    )}
                  </span>
                  <span
                    className="mini-btn danger"
                    style={{ height: 20, padding: '0 4px' }}
                    title={`关闭 ${v.label}`}
                    onClick={e => {
                      e.stopPropagation()
                      s.closeSessionView(t.id, v.id)
                    }}
                  >
                    <Icon name="close" size={11} />
                  </span>
                </div>
              )
            })}
          </div>
          <div
            style={{
              marginTop: 4,
              paddingTop: 4,
              borderTop: '1px solid var(--borderSubtle)',
            }}
          >
            <div
              className="sa-act"
              style={{ color: 'var(--bell)' }}
              onClick={() => {
                setOverflowOpen(false)
                useStore.setState(d => {
                  const tt = threadById(d.threads, t.id)
                  if (tt) {
                    tt.views = []
                    tt.activeViewId = 'main'
                  }
                })
                s.toast('已关闭全部副视图')
              }}
            >
              <Icon name="trash" size={12.5} />
              <span>关闭全部副视图 ({views.length})</span>
            </div>
          </div>
        </Pop>
      )}

      <Pop
        open={addOpen}
        onOpenChange={setAddOpen}
        className="session-add-pop"
        anchor={
          <button
            type="button"
            className="tb-cell tb-icon-btn tb-add-btn"
            title="添加伴随视图（Git 图谱 / 新建 Shell / 文件预览）"
            aria-label="添加到当前 Session"
            onClick={() => setAddOpen(v => !v)}
          >
            <Icon name="plus" size={13.5} />
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
          <span>新建伴随 Shell</span>
        </div>
        <div className="sa-sub">在会话内打开文件</div>
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

function contextLabel() {
  const s = useStore.getState()
  const r = s.route
  if (r?.type === 'thread') {
    const t = threadById(s.threads, r.id)
    return wsById(s.workspaces, t?.workspaceId)?.name ?? '未归属会话'
  }
  if (r?.type === 'workspace') return wsById(s.workspaces, r.id)?.name ?? 'j-agent'
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
