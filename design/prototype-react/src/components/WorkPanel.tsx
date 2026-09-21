import { useRef } from 'react'
import { useStore } from '@/store'
import { DIFFS, PREVIEWS, PANEL_OVERLAY_W } from '@/seed'
import { Icon } from '@/icons'
import { cn } from '@/lib/utils'
import type { WtFile } from '@/types'

const BADGE: Record<string, [string, string]> = {
  m: ['M', 'var(--statusRunning)'],
  a: ['A', 'var(--statusDone)'],
  d: ['D', 'var(--statusError)'],
}

export function WorkPanel() {
  const panelWidth = useStore(s => s.ui.panelWidth)
  const winW = useStore(s => s.ui.winW)
  const tab = useStore(s => s.ui.panelTab)
  const wt = useStore(s => s.worktree)
  const dragging = useRef(false)

  const overlay = winW < PANEL_OVERLAY_W
  const w = overlay ? Math.min(panelWidth, Math.min(420, winW)) : panelWidth
  const files = wt.files
  const addT = files.reduce((n, f) => n + (f.added ?? 0), 0)
  const delT = files.reduce((n, f) => n + (f.deleted ?? 0), 0)
  const sel = files.find(f => f.path === wt.selected) ?? null

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const app = document.getElementById('app')!
    const move = (ev: MouseEvent) => {
      const r = app.getBoundingClientRect()
      const pw = Math.round(Math.min(720, Math.max(244, r.right - ev.clientX)))
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

  return (
    <div id="work-panel" className={cn(overlay && 'overlay')} style={{ width: w }}>
      {!overlay && <div className="wp-resize" onMouseDown={startDrag} />}
      <div className="wp-head">
        <div
          className={cn('ptab', tab === 'changes' && 'active')}
          onClick={() => useStore.setState(d => void (d.ui.panelTab = 'changes'))}
        >
          <Icon name="gitBranch" size={12} /> 变更
        </div>
        <div
          className={cn('ptab', tab === 'files' && 'active')}
          onClick={() => useStore.setState(d => void (d.ui.panelTab = 'files'))}
        >
          <Icon name="file" size={12} /> 文件
        </div>
        <div style={{ flex: 1 }} />
        <div
          className="hbtn"
          title="刷新"
          onClick={() => useStore.getState().toast('已刷新工作区状态')}
        >
          <Icon name="reset" size={16} />
        </div>
        <div
          className="hbtn"
          title="关闭面板"
          onClick={() => useStore.setState(d => void (d.ui.panelOpen = false))}
        >
          <Icon name="close" size={16} />
        </div>
      </div>
      <div className="wp-body">
        {tab === 'changes' ? (
          <>
            <div className="wp-sum">
              <span className="t">工作区变更</span>
              <span className="n">
                {files.length} 个文件 +{addT} −{delT}
              </span>
            </div>
            {files.length === 0 ? (
              <div className="hint">工作区干净，没有变更。</div>
            ) : (
              files.map(f => <ChangeRow key={f.path} f={f} sel={wt.selected} />)
            )}
            {sel && <Diff f={sel} />}
          </>
        ) : (
          <>
            {files.length === 0 ? (
              <div className="hint">工作区没有文件。</div>
            ) : (
              files.map(f => <FileRow key={f.path} f={f} sel={wt.selected} />)
            )}
            {sel ? (
              <>
                <div className="wp-file-head">
                  <Icon name="file" size={12} /> {sel.path}
                </div>
                <Preview f={sel} />
              </>
            ) : (
              <div className="hint">选择一个文件查看内容。</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function splitPath(path: string) {
  const sl = path.lastIndexOf('/')
  return sl >= 0 ? { dir: path.slice(0, sl), nm: path.slice(sl + 1) } : { dir: '', nm: path }
}

function ChangeRow({ f, sel }: { f: WtFile; sel: string | null }) {
  const { dir, nm } = splitPath(f.path)
  const b = BADGE[f.status]
  return (
    <div
      className={cn('file-row', f.path === sel && 'sel')}
      onClick={() => useStore.setState(d => void (d.worktree.selected = f.path))}
    >
      <span className="bdg" style={{ color: b[1] }}>
        {b[0]}
      </span>
      <span className="nm">
        {nm}
        {dir && <span className="dir">{'  ' + dir}</span>}
      </span>
      {f.added != null && <span className="add">+{f.added}</span>}
      {f.deleted != null && <span className="del">−{f.deleted}</span>}
    </div>
  )
}

function FileRow({ f, sel }: { f: WtFile; sel: string | null }) {
  const { dir, nm } = splitPath(f.path)
  return (
    <div
      className={cn('file-row', f.path === sel && 'sel')}
      onClick={() => useStore.setState(d => void (d.worktree.selected = f.path))}
    >
      <span className="bdg" style={{ color: 'var(--muted)' }}>
        <Icon name="file" size={12} />
      </span>
      <span className="nm">
        {nm}
        {dir && <span className="dir">{'  ' + dir}</span>}
      </span>
    </div>
  )
}

function Diff({ f }: { f: WtFile }) {
  const patch = DIFFS[f.path]
  if (f.status === 'a' || !patch)
    return <div className="hint">未跟踪文件——无 diff，在「文件」页查看内容。</div>
  return (
    <div className="diff">
      {patch.split('\n').map((l, i) => {
        let cls = ''
        if (l.startsWith('@@')) cls = 'hunk'
        else if (l.startsWith('+')) cls = 'add'
        else if (l.startsWith('-')) cls = 'del'
        else if (l.startsWith('diff') || l.startsWith('index')) cls = 'meta'
        return (
          <div className={`dl ${cls}`} key={i}>
            {l || ' '}
          </div>
        )
      })}
    </div>
  )
}

function Preview({ f }: { f: WtFile }) {
  const code = PREVIEWS[f.path] ?? `// ${f.path}\n// （原型预览占位）`
  return (
    <div className="code-view">
      {code.split('\n').map((l, i) => (
        <div className="cl" key={i}>
          <span className="ln-no">{i + 1}</span>
          <span>{l || ' '}</span>
        </div>
      ))}
    </div>
  )
}
