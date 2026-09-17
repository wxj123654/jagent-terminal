import { useState, type ReactNode } from 'react'
import { useStore } from '@/store'
import {
  GIT_COMMITS, LANE_COLORS, LANE_W, PAD_X, MIN_LANES, GIT_ROW_H,
} from '@/seed'
import { Icon } from '@/icons'
import { CtxMenu, type MenuItem } from '@/components/ui/menu'
import { Pop } from '@/components/ui/popover'
import { Toggle } from '@/components/ui/controls'
import { cn } from '@/lib/utils'
import type { GitCommit, GitRef, Workspace } from '@/types'

const laneX = (l: number) => PAD_X + l * LANE_W + LANE_W / 2
const maxLanes = Math.max(...GIT_COMMITS.map(c => Math.max(...c.lanes) + 1), MIN_LANES)
const gw = LANE_W * Math.max(MIN_LANES, maxLanes) + PAD_X * 2

function gitMenuItems(): MenuItem[] {
  return [
    { id: 'copy-sha', label: '复制 SHA' },
    { id: 'checkout', label: 'Checkout 此提交' },
    { id: 'branch-here', label: '在此创建分支…' },
    'sep',
    { id: 'reset-hard', label: 'Reset 到此提交（hard）', danger: true },
  ]
}

function RefChip({ d }: { d: GitRef }) {
  const map: Record<string, { cls: string; sq: string; t: string }> = {
    head: { cls: 'head', sq: 'var(--accent)', t: d.t },
    branch: { cls: '', sq: 'var(--terminalKind)', t: d.t },
    remote: {
      cls: '',
      sq: 'var(--muted)',
      t: 'origin/' + (d.t.startsWith('origin/') ? d.t.slice(7) : d.t),
    },
    tag: { cls: 'tag', sq: 'var(--amber)', t: d.t },
  }
  const m = map[d.k] ?? map.branch
  return (
    <span className={`ref-chip ${m.cls}`}>
      <span className="sq" style={{ background: m.sq }} />
      {m.t}
    </span>
  )
}

function RowGraph({ c }: { c: GitCommit }) {
  const H = GIT_ROW_H
  const MID = H / 2
  const els: ReactNode[] = []
  for (const l of c.lanes) {
    const col = LANE_COLORS[l % 8]
    els.push(
      <line key={`l${l}`} x1={laneX(l)} y1={0} x2={laneX(l)} y2={H} stroke={col} strokeWidth={1.5} opacity={0.85} />,
      <line key={`t${l}`} x1={laneX(l)} y1={-4} x2={laneX(l)} y2={0} stroke={col} strokeWidth={1.5} opacity={0.85} />,
    )
  }
  if (c.merge) {
    const col = LANE_COLORS[c.merge.from % 8]
    els.push(
      <path
        key="m"
        d={`M ${laneX(c.merge.from)} 0 C ${laneX(c.merge.from)} ${MID}, ${laneX(c.merge.to)} ${MID}, ${laneX(c.merge.to)} ${MID + 2}`}
        stroke={col}
        strokeWidth={1.5}
        fill="none"
      />,
    )
  }
  const cx = laneX(c.lane)
  const cy = MID
  const col = LANE_COLORS[c.lane % 8]
  els.push(
    c.hollow ? (
      <circle key="n" cx={cx} cy={cy} r={3.5} fill="var(--pane)" stroke={col} strokeWidth={2} />
    ) : (
      <circle key="n" cx={cx} cy={cy} r={3.5} fill={col} />
    ),
  )
  return (
    <svg className="gcell" width={gw + 6} height={26} style={{ marginLeft: 8 }}>
      {els}
    </svg>
  )
}

export function GitGraphView({ ws }: { ws: Workspace }) {
  const g = useStore(s => s.git)
  const findOpen = useStore(s => s.ui.gitFindOpen)
  const findDraft = useStore(s => s.ui.gitFindDraft)
  const [branchOpen, setBranchOpen] = useState(false)
  const q = findDraft.trim().toLowerCase()
  const matches = q
    ? GIT_COMMITS.map((c, i) => ({ c, i })).filter(
        x => x.c.msg.toLowerCase().includes(q) || x.c.sha.startsWith(q),
      )
    : []
  const matchSet = new Set(matches.map(x => x.i))
  const cur = g.branches.find(b => b.current)?.name ?? 'HEAD'

  const pickGit = (sha: string, item: string) => {
    const toast = useStore.getState().toast
    if (item === 'copy-sha') toast(`已复制 ${sha}`)
    else if (item === 'checkout') toast(`checkout ${sha}（原型模拟）`)
    else if (item === 'branch-here') toast('创建分支（原型模拟）')
    else if (item === 'reset-hard') toast(`reset --hard ${sha}（原型模拟）`)
  }

  return (
    <div className="git-view">
      <div className="git-toolbar">
        <span className="lbl">{ws.name}</span>
        <span className="lbl">分支</span>
        <Pop
          open={branchOpen}
          onOpenChange={setBranchOpen}
          className="branch-pop"
          sideOffset={6}
          anchor={
            <div className="git-branch-btn" onClick={() => setBranchOpen(v => !v)}>
              <Icon name="gitBranch" size={12} /> {cur} <Icon name="chevronDown" size={12} />
            </div>
          }
        >
          {g.branches.map(b => (
            <div
              key={b.name}
              className="brow"
              onClick={() => {
                useStore.getState().checkoutBranch(b.name)
                setBranchOpen(false)
              }}
            >
              <span className="ck">{b.current ? '✓' : ''}</span>
              <Icon name="gitBranch" size={12} /> {b.name}
              {b.up && <span className="up">{b.up}</span>}
            </div>
          ))}
        </Pop>
        <Toggle
          checked={g.showRemote}
          onChange={v => useStore.setState(d => void (d.git.showRemote = v))}
          style={{ transform: 'scale(.85)' }}
        />
        <span className="lbl">显示远程分支</span>
        <span className="cnt">{GIT_COMMITS.length} 提交</span>
        {findOpen ? (
          <span className="git-find">
            <input
              autoFocus
              placeholder="查找提交"
              value={findDraft}
              onChange={e =>
                useStore.setState(d => {
                  d.ui.gitFindDraft = e.target.value
                  d.git.findIdx = 0
                })
              }
            />
            <span className="pos">
              {matches.length ? `${(g.findIdx % matches.length) + 1}/${matches.length}` : '0/0'}
            </span>
            <span
              className="hbtn"
              style={{ width: 22, height: 22 }}
              onClick={() => useStore.getState().gitFindStep(-1)}
            >
              <Icon name="chevronUp" size={12} />
            </span>
            <span
              className="hbtn"
              style={{ width: 22, height: 22 }}
              onClick={() => useStore.getState().gitFindStep(1)}
            >
              <Icon name="chevronDown" size={12} />
            </span>
            <span
              className="hbtn"
              style={{ width: 22, height: 22 }}
              onClick={() =>
                useStore.setState(d => {
                  d.ui.gitFindOpen = false
                  d.ui.gitFindDraft = ''
                })
              }
            >
              <Icon name="close" size={12} />
            </span>
          </span>
        ) : (
          <div
            className="ibtn"
            style={{ width: 26, height: 26 }}
            title="查找提交"
            onClick={() => useStore.setState(d => void (d.ui.gitFindOpen = true))}
          >
            <Icon name="search" size={16} />
          </div>
        )}
        <div
          className="ibtn"
          style={{ width: 26, height: 26 }}
          title="设置（后续版本）"
          onClick={() => useStore.getState().toast('设置面板：后续版本提供')}
        >
          <Icon name="gear" size={16} />
        </div>
        <div
          className="ibtn"
          style={{ width: 26, height: 26 }}
          title="拉取远端更新"
          onClick={() => useStore.getState().toast('git fetch --all --prune（原型模拟）')}
        >
          <Icon name="download" size={16} />
        </div>
        <div
          className="ibtn"
          style={{ width: 26, height: 26 }}
          title="刷新（R）"
          onClick={() => useStore.getState().toast('已刷新')}
        >
          <Icon name="reset" size={16} />
        </div>
      </div>
      <div className="git-header">
        <span style={{ width: gw + 6, marginLeft: 8 }}>Graph</span>
        <span style={{ flex: 1 }}>Description</span>
        <span style={{ width: 110, marginLeft: 8 }}>Author</span>
        <span style={{ width: 80, marginLeft: 8, textAlign: 'right' }}>Date</span>
        <span style={{ width: 72, marginLeft: 8 }}>SHA</span>
      </div>
      <div className="git-list">
        {GIT_COMMITS.map((c, i) => {
          const sel = c.sha === g.selectedSha
          const dim = q !== '' && !matchSet.has(i)
          return (
            <div key={c.sha}>
              <CtxMenu items={gitMenuItems()} onPick={item => pickGit(c.sha, item)}>
                <div
                  className={cn('git-row', sel && 'sel')}
                  style={dim ? { opacity: 0.35 } : undefined}
                  onClick={() => useStore.getState().gitSelect(c.sha)}
                >
                  <RowGraph c={c} />
                  <span className="desc">
                    {(c.refs ?? []).map((r, j) => (
                      <RefChip key={j} d={r} />
                    ))}
                    <span className="msg">{c.msg}</span>
                  </span>
                  <span className="author">{c.author}</span>
                  <span className="date">{c.time}</span>
                  <span className="sha">{c.sha}</span>
                </div>
              </CtxMenu>
              {sel && (
                <div className="git-cdv">
                  <div className="git-cdv-sum sum">
                    <div className="cdv-title">{c.msg}</div>
                    <div className="cdv-meta">
                      <span className="k">Author:</span>
                      <span className="v">{c.author} &lt;you@local&gt;</span>
                    </div>
                    <div className="cdv-meta">
                      <span className="k">Date:</span>
                      <span className="v">{c.time}</span>
                    </div>
                    <div className="cdv-meta">
                      <span className="k">SHA:</span>
                      <span className="v">{c.sha}</span>
                    </div>
                    {c.body && <div className="cdv-body">{c.body}</div>}
                  </div>
                  <div className="git-cdv-files files">
                    <div className="ftree">
                      {c.files.map(f => {
                        const sl = f.lastIndexOf('/')
                        return (
                          <div className="frow" key={f}>
                            <Icon name="file" size={12} />
                            {sl >= 0 && <span className="fdir">{f.slice(0, sl + 1)}</span>}
                            {sl >= 0 ? f.slice(sl + 1) : f}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
