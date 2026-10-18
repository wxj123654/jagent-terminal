import { useRef, useState } from 'react'
import { useStore } from '@/store'
import { PANEL_OVERLAY_W } from '@/seed'
import { Icon } from '@/icons'
import { cn } from '@/lib/utils'
import type { WtFile } from '@/types'

const BADGE: Record<string, [string, string, string]> = {
  m: ['M', 'var(--statusRunning)', 'rgba(251,191,36,.14)'],
  a: ['A', 'var(--statusDone)', 'rgba(52,211,153,.14)'],
  d: ['D', 'var(--statusError)', 'rgba(248,113,113,.14)'],
}

const PROJECT_TREE: { dir: string; files: string[] }[] = [
  {
    dir: 'packages/app/src/plane',
    files: [
      'packages/app/src/plane/Sidebar.tsx',
      'packages/app/src/plane/WorkspaceList.tsx',
      'packages/app/src/plane/TitleBar.tsx',
      'packages/app/src/plane/WorkPanel.tsx',
    ],
  },
  {
    dir: 'packages/app/src',
    files: [
      'packages/app/src/tokens.ts',
      'packages/ui/src/display/Icon.tsx',
    ],
  },
  {
    dir: 'crates/jagent-terminal/src',
    files: [
      'crates/jagent-terminal/src/pool.rs',
      'crates/jagent-terminal/src/view/element.rs',
    ],
  },
  {
    dir: 'design',
    files: [
      'design/DESIGN.md',
      'design/j-agent-prototype.html',
    ],
  },
]

/**
 * 右侧专职导航栏（WorkPanel）：
 * - 解耦空间争夺：右栏专职承担「工作区变更树」与「项目文件树」导航，不再在 296px 窄栏内硬塞 Diff 代码框；
 * - 点击任意文件：直接在左侧宽敞的主画布副页签中打开 FileSurface（支持 Unified Diff / 并排对比 / 完整源码切换）。
 */
export function WorkPanel() {
  const panelWidth = useStore(s => s.ui.panelWidth)
  const winW = useStore(s => s.ui.winW)
  const tab = useStore(s => s.ui.panelTab)
  const wt = useStore(s => s.worktree)
  const [filterQ, setFilterQ] = useState('')
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({
    'packages/app/src/plane': true,
    'packages/app/src': true,
    'crates/jagent-terminal/src': true,
    design: true,
  })
  const dragging = useRef(false)

  const overlay = winW < PANEL_OVERLAY_W
  const w = overlay ? Math.min(panelWidth, Math.min(360, winW)) : panelWidth
  const files = wt.files
  const addT = files.reduce((n, f) => n + (f.added ?? 0), 0)
  const delT = files.reduce((n, f) => n + (f.deleted ?? 0), 0)
  const selPath = wt.selected ?? files[0]?.path ?? null

  const q = filterQ.trim().toLowerCase()
  const filteredChanges = q ? files.filter(f => f.path.toLowerCase().includes(q)) : files

  const modFiles = filteredChanges.filter(f => f.status === 'm')
  const addFiles = filteredChanges.filter(f => f.status === 'a')
  const delFiles = filteredChanges.filter(f => f.status === 'd')

  const openInMainCanvas = (path: string) => {
    const st = useStore.getState()
    useStore.setState(d => {
      d.worktree.selected = path
    })
    const r = st.route
    const tid =
      r?.type === 'thread'
        ? r.id
        : st.threads.find(t => t.workspaceId === 'ws-jt')?.id ?? st.threads[0]?.id
    if (tid) {
      st.openSessionFile(tid, path)
      if (r?.type !== 'thread' || r.id !== tid) {
        st.activate({ type: 'thread', id: tid })
      }
    }
  }

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const app = document.getElementById('app')!
    const move = (ev: MouseEvent) => {
      const r = app.getBoundingClientRect()
      const pw = Math.round(Math.min(480, Math.max(240, r.right - ev.clientX)))
      useStore.setState(d => void (d.ui.panelWidth = pw))
    }
    const up = () => {
      dragging.current = false
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const totalStat = Math.max(1, addT + delT)
  const addPct = Math.round((addT / totalStat) * 100)

  return (
    <div
      id="work-panel"
      className={cn(overlay && 'overlay')}
      style={{ width: w, display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      {!overlay && <div className="wp-resize" onMouseDown={startDrag} />}

      {/* 顶部页签切换头 */}
      <div className="wp-head">
        <div
          className={cn('ptab', tab === 'changes' && 'active')}
          onClick={() => useStore.setState(d => void (d.ui.panelTab = 'changes'))}
        >
          <Icon name="gitBranch" size={12} /> 变更 ({files.length})
        </div>
        <div
          className={cn('ptab', tab === 'files' && 'active')}
          onClick={() => useStore.setState(d => void (d.ui.panelTab = 'files'))}
        >
          <Icon name="folder" size={12} /> 文件树
        </div>
        <div style={{ flex: 1 }} />
        <div
          className="hbtn"
          title="刷新工作区状态"
          onClick={() => useStore.getState().toast('已刷新工作区变更与文件树')}
        >
          <Icon name="reset" size={14} />
        </div>
        <div
          className="hbtn"
          title="关闭右侧导航栏"
          onClick={() => useStore.setState(d => void (d.ui.panelOpen = false))}
        >
          <Icon name="close" size={14} />
        </div>
      </div>

      {/* 搜索过滤条 */}
      <div style={{ padding: '8px 10px 4px', flexShrink: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            padding: '0 9px',
            borderRadius: 7,
            background: 'var(--inputBg)',
            border: '1px solid var(--borderSubtle)',
            color: 'var(--muted)',
          }}
        >
          <Icon name="search" size={12} />
          <input
            placeholder={tab === 'changes' ? '过滤变更文件…' : '搜索项目文件…'}
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
          {filterQ && (
            <span
              style={{ cursor: 'pointer', display: 'flex' }}
              onClick={() => setFilterQ('')}
            >
              <Icon name="close" size={11} />
            </span>
          )}
        </div>
      </div>

      {/* 全高独立滚动树列表（不再被下方 Diff 框挤压，且滚轮隔离不串扰主画布） */}
      <div className="wp-body isolated-scroll" style={{ padding: '6px 8px 10px', gap: 10 }}>
        {tab === 'changes' ? (
          <>
            {/* 变更统计摘要卡 */}
            <div
              style={{
                padding: '9px 11px',
                borderRadius: 8,
                background: 'var(--inputBg)',
                border: '1px solid var(--borderSubtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                flexShrink: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11.5 }}>
                <span style={{ color: 'var(--textBright)', fontWeight: 600 }}>
                  工作区未提交变更 ({files.length})
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, display: 'flex', gap: 6 }}>
                  <span style={{ color: 'var(--statusDone)' }}>+{addT}</span>
                  <span style={{ color: 'var(--statusError)' }}>−{delT}</span>
                </span>
              </div>
              <div
                style={{
                  height: 4,
                  borderRadius: 999,
                  background: 'rgba(248,113,113,.35)',
                  overflow: 'hidden',
                  display: 'flex',
                }}
              >
                <span style={{ width: `${addPct}%`, background: 'var(--statusDone)' }} />
              </div>
            </div>

            {filteredChanges.length === 0 ? (
              <div className="hint">没有匹配的变更文件。</div>
            ) : (
              <>
                {modFiles.length > 0 && (
                  <ChangeGroup
                    title={`已修改 · Modified (${modFiles.length})`}
                    items={modFiles}
                    sel={selPath}
                    onSelect={openInMainCanvas}
                  />
                )}
                {addFiles.length > 0 && (
                  <ChangeGroup
                    title={`新增未跟踪 · Untracked (${addFiles.length})`}
                    items={addFiles}
                    sel={selPath}
                    onSelect={openInMainCanvas}
                  />
                )}
                {delFiles.length > 0 && (
                  <ChangeGroup
                    title={`已删除 · Deleted (${delFiles.length})`}
                    items={delFiles}
                    sel={selPath}
                    onSelect={openInMainCanvas}
                  />
                )}
              </>
            )}
          </>
        ) : (
          /* 项目完整文件目录树 */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {PROJECT_TREE.map(group => {
              const matched = q
                ? group.files.filter(f => f.toLowerCase().includes(q))
                : group.files
              if (!matched.length) return null
              const isOpen = openDirs[group.dir] ?? true
              return (
                <div key={group.dir} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div
                    onClick={() =>
                      setOpenDirs(prev => ({ ...prev, [group.dir]: !isOpen }))
                    }
                    style={{
                      height: 26,
                      padding: '0 6px',
                      borderRadius: 6,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: 'var(--muted)',
                      cursor: 'pointer',
                    }}
                  >
                    <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={11} />
                    <span style={{ color: 'var(--accentHover)', display: 'flex' }}>
                      <Icon name="folder" size={12.5} />
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {group.dir}
                    </span>
                  </div>
                  {isOpen &&
                    matched.map(path => {
                      const nm = path.split('/').pop() ?? path
                      const changed = files.find(x => x.path === path)
                      const isSel = path === selPath
                      return (
                        <div
                          key={path}
                          className={cn('file-row', isSel && 'sel')}
                          style={{ paddingLeft: 22 }}
                          onClick={() => openInMainCanvas(path)}
                        >
                          <span style={{ color: isSel ? 'var(--accentHover)' : 'var(--muted)', display: 'flex' }}>
                            <Icon name="file" size={12} />
                          </span>
                          <span className="nm" style={{ color: isSel ? 'var(--textBright)' : 'var(--text)' }}>
                            {nm}
                          </span>
                          {changed && (
                            <span
                              style={{
                                fontSize: 10,
                                fontFamily: 'var(--font-mono)',
                                fontWeight: 700,
                                color: BADGE[changed.status][1],
                              }}
                            >
                              {BADGE[changed.status][0]}
                            </span>
                          )}
                        </div>
                      )
                    })}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 底部轻量操作说明条 */}
      <div
        style={{
          height: 28,
          padding: '0 10px',
          borderTop: '1px solid var(--borderSubtle)',
          background: 'rgba(13,15,21,.55)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 10.5,
          color: 'var(--muted)',
          flexShrink: 0,
        }}
      >
        <span>点击文件在主画布宽幅查看 Diff / 源码</span>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accentHover)' }}>主画布联动</span>
      </div>
    </div>
  )
}

function ChangeGroup({
  title,
  items,
  sel,
  onSelect,
}: {
  title: string
  items: WtFile[]
  sel: string | null
  onSelect: (path: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          color: 'var(--muted)',
          padding: '2px 6px 3px',
          letterSpacing: '0.03em',
        }}
      >
        {title}
      </div>
      {items.map(f => (
        <ChangeRow key={f.path} f={f} sel={sel} onSelect={onSelect} />
      ))}
    </div>
  )
}

function splitPath(path: string) {
  const sl = path.lastIndexOf('/')
  return sl >= 0 ? { dir: path.slice(0, sl), nm: path.slice(sl + 1) } : { dir: '', nm: path }
}

function ChangeRow({
  f,
  sel,
  onSelect,
}: {
  f: WtFile
  sel: string | null
  onSelect: (path: string) => void
}) {
  const { dir, nm } = splitPath(f.path)
  const b = BADGE[f.status]
  const active = f.path === sel
  return (
    <div
      className={cn('file-row', active && 'sel')}
      style={{ height: 34, padding: '0 8px' }}
      onClick={() => onSelect(f.path)}
      title={`${f.path}（点击在左侧主画布打开宽幅视图）`}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: 4,
          background: b[2],
          color: b[1],
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {b[0]}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0 }}>
        <span
          style={{
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            color: active ? 'var(--textBright)' : 'var(--text)',
            fontWeight: active ? 600 : 450,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            lineHeight: 1.25,
          }}
        >
          {nm}
        </span>
        {dir && (
          <span
            style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              color: 'var(--muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              lineHeight: 1.2,
            }}
          >
            {dir}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {f.added != null && f.added > 0 && <span className="add">+{f.added}</span>}
        {f.deleted != null && f.deleted > 0 && <span className="del">−{f.deleted}</span>}
      </div>
    </div>
  )
}
