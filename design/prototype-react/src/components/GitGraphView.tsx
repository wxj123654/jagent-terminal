import { useState, type ReactNode } from 'react'
import { useStore } from '@/store'
import {
  GIT_COMMITS, LANE_COLORS, LANE_W, PAD_X, MIN_LANES,
} from '@/seed'
import { Icon } from '@/icons'
import { CtxMenu, type MenuItem } from '@/components/ui/menu'
import { Pop } from '@/components/ui/popover'
import { Toggle } from '@/components/ui/controls'
import { cn } from '@/lib/utils'
import type { GitCommit, GitRef, Workspace } from '@/types'

const ROW_H = 32
const laneX = (l: number) => PAD_X + l * LANE_W + LANE_W / 2
const maxLanes = Math.max(...GIT_COMMITS.map(c => Math.max(...c.lanes) + 1), MIN_LANES)
const gw = LANE_W * Math.max(MIN_LANES, maxLanes) + PAD_X * 2

function gitMenuItems(): MenuItem[] {
  return [
    { id: 'copy-sha', label: '复制提交 SHA' },
    { id: 'checkout', label: 'Checkout 此提交' },
    { id: 'branch-here', label: '在此创建新分支…' },
    'sep',
    { id: 'reset-hard', label: 'Reset 到此提交 (--hard)', danger: true },
  ]
}

function RefChip({ d }: { d: GitRef }) {
  const map: Record<string, { cls: string; sq: string; t: string }> = {
    head: { cls: 'head', sq: 'var(--accent)', t: d.t },
    branch: { cls: 'branch', sq: 'var(--terminalKind)', t: d.t },
    remote: {
      cls: 'remote',
      sq: 'var(--cyan)',
      t: 'origin/' + (d.t.startsWith('origin/') ? d.t.slice(7) : d.t),
    },
    tag: { cls: 'tag', sq: 'var(--amber)', t: d.t },
  }
  const m = map[d.k] ?? map.branch
  return (
    <span className={`ref-chip ${m.cls}`}>
      <span className="sq" style={{ background: m.sq }} />
      <span>{m.t}</span>
    </span>
  )
}

/**
 * 单行拓扑 SVG：绘制贯穿轨道线、Merge 曲线与节点圆点
 */
function RowGraph({
  c,
  isFirst,
  isLast,
  selected,
}: {
  c: GitCommit
  isFirst: boolean
  isLast: boolean
  selected: boolean
}) {
  const H = ROW_H
  const MID = H / 2
  const els: ReactNode[] = []

  for (const l of c.lanes) {
    const col = LANE_COLORS[l % LANE_COLORS.length]
    const y1 = isFirst && l === c.lane ? MID : 0
    const y2 = isLast && l === c.lane ? MID : H
    els.push(
      <line
        key={`l${l}`}
        x1={laneX(l)}
        y1={y1}
        x2={laneX(l)}
        y2={y2}
        stroke={col}
        strokeWidth={1.75}
        opacity={0.88}
      />,
    )
  }

  if (c.merge) {
    const col = LANE_COLORS[c.merge.from % LANE_COLORS.length]
    els.push(
      <path
        key="m"
        d={`M ${laneX(c.merge.from)} 0 C ${laneX(c.merge.from)} ${MID}, ${laneX(c.merge.to)} ${MID - 2}, ${laneX(c.merge.to)} ${MID}`}
        stroke={col}
        strokeWidth={1.75}
        fill="none"
      />,
    )
  }

  const cx = laneX(c.lane)
  const cy = MID
  const col = LANE_COLORS[c.lane % LANE_COLORS.length]
  const isHead = c.refs?.some(r => r.k === 'head')

  if (selected || isHead) {
    els.push(
      <circle
        key="halo"
        cx={cx}
        cy={cy}
        r={6.5}
        fill={col}
        opacity={selected ? 0.28 : 0.18}
      />,
    )
  }

  els.push(
    c.hollow ? (
      <circle key="n" cx={cx} cy={cy} r={4} fill="var(--pane)" stroke={col} strokeWidth={2} />
    ) : (
      <circle key="n" cx={cx} cy={cy} r={4} fill={col} stroke="var(--pane)" strokeWidth={1.5} />
    ),
  )

  return (
    <svg className="gcell" width={gw + 6} height={H} style={{ marginLeft: 8 }}>
      {els}
    </svg>
  )
}

/**
 * 行内 CDV 展开时的左侧拓扑穿透走廊：
 * 保证分支轨道线在展开 210px 详情卡期间全程不断裂，并延伸一条水平虚线指向右侧详情卡
 */
function RowCdvPassThrough({ c, isLast }: { c: GitCommit; isLast: boolean }) {
  const passLanes = isLast ? [] : c.lanes
  const activeCol = LANE_COLORS[c.lane % LANE_COLORS.length]
  const cx = laneX(c.lane)

  return (
    <div
      className="git-cdv-corridor"
      style={{
        width: gw + 6,
        marginLeft: 8,
        flexShrink: 0,
        position: 'relative',
        alignSelf: 'stretch',
      }}
    >
      <svg width={gw + 6} height="100%" style={{ display: 'block', height: '100%' }}>
        {passLanes.map(l => {
          const col = LANE_COLORS[l % LANE_COLORS.length]
          return (
            <line
              key={`pass-${l}`}
              x1={laneX(l)}
              y1={0}
              x2={laneX(l)}
              y2="100%"
              stroke={col}
              strokeWidth={1.75}
              opacity={0.85}
            />
          )
        })}
        {/* 从当前提交轨道引出一条精致拐角连接线指向右侧 CDV 详情舱 */}
        <line
          x1={cx}
          y1={0}
          x2={cx}
          y2={22}
          stroke={activeCol}
          strokeWidth={1.75}
        />
        <line
          x1={cx}
          y1={22}
          x2={gw + 6}
          y2={22}
          stroke={activeCol}
          strokeWidth={1.5}
          strokeDasharray="3 2"
          opacity={0.85}
        />
        <circle cx={cx} cy={22} r={2.5} fill={activeCol} />
      </svg>
    </div>
  )
}

export function GitGraphView({ ws }: { ws: Workspace }) {
  const g = useStore(s => s.git)
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
    if (item === 'copy-sha') toast(`已复制提交 SHA: ${sha}`)
    else if (item === 'checkout') toast(`已检出提交 ${sha}（原型模拟）`)
    else if (item === 'branch-here') toast('在此提交创建分支（原型模拟）')
    else if (item === 'reset-hard') toast(`reset --hard ${sha}（原型模拟）`)
  }

  const openFileInMainCanvas = (path: string) => {
    const st = useStore.getState()
    const r = st.route
    const tid = r?.type === 'thread' ? r.id : st.threads.find(t => t.workspaceId === ws.id)?.id ?? st.threads[0]?.id
    if (tid) {
      st.openSessionFile(tid, path)
      st.activate({ type: 'thread', id: tid })
      st.toast(`已在主画布打开 ${path.split('/').pop()} 的 Diff 与源码对比视图`)
    }
  }

  return (
    <div className="git-view">
      {/* 精简现代过滤条（不与上方 40px 融合顶栏重复显示工作区名） */}
      <div className="git-toolbar">
        <Pop
          open={branchOpen}
          onOpenChange={setBranchOpen}
          className="branch-pop"
          sideOffset={6}
          anchor={
            <button type="button" className="git-branch-btn" onClick={() => setBranchOpen(v => !v)}>
              <span style={{ color: 'var(--accentHover)', display: 'flex' }}>
                <Icon name="gitBranch" size={12.5} />
              </span>
              <span style={{ color: 'var(--textBright)', fontWeight: 600 }}>{cur}</span>
              <Icon name="chevronDown" size={11} />
            </button>
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

        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 24,
            padding: '0 8px',
            borderRadius: 6,
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            background: 'var(--surface)',
            border: '1px solid var(--borderSubtle)',
            color: 'var(--text)',
          }}
          title="相对远端分支同步状态"
        >
          <span style={{ color: 'var(--statusDone)', fontWeight: 600 }}>↑2</span>
          <span style={{ color: 'var(--muted)' }}>↓0</span>
          <span style={{ color: 'var(--faint)' }}>origin/{cur}</span>
        </span>

        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            color: 'var(--muted)',
            cursor: 'pointer',
            marginLeft: 4,
          }}
        >
          <Toggle
            checked={g.showRemote}
            onChange={v => useStore.setState(d => void (d.git.showRemote = v))}
            style={{ transform: 'scale(.82)' }}
          />
          <span>显示远程分支</span>
        </label>

        <span className="cnt" style={{ fontFamily: 'var(--font-mono)' }}>
          共 {GIT_COMMITS.length} 个提交 · 点击任意行展开详情
        </span>

        <span className="git-find">
          <Icon name="search" size={12} />
          <input
            placeholder="过滤提交说明或 SHA…"
            value={findDraft}
            onChange={e =>
              useStore.setState(d => {
                d.ui.gitFindDraft = e.target.value
                d.git.findIdx = 0
              })
            }
          />
          {q && (
            <>
              <span className="pos">
                {matches.length ? `${(g.findIdx % matches.length) + 1}/${matches.length}` : '0/0'}
              </span>
              <span
                className="hbtn"
                style={{ width: 20, height: 20 }}
                onClick={() => useStore.getState().gitFindStep(-1)}
              >
                <Icon name="chevronUp" size={11} />
              </span>
              <span
                className="hbtn"
                style={{ width: 20, height: 20 }}
                onClick={() => useStore.getState().gitFindStep(1)}
              >
                <Icon name="chevronDown" size={11} />
              </span>
              <span
                className="hbtn"
                style={{ width: 20, height: 20 }}
                onClick={() =>
                  useStore.setState(d => {
                    d.ui.gitFindDraft = ''
                  })
                }
              >
                <Icon name="close" size={11} />
              </span>
            </>
          )}
        </span>

        <div
          className="ibtn"
          style={{ width: 26, height: 26 }}
          title="拉取远端更新 (git fetch --all --prune)"
          onClick={() => useStore.getState().toast('git fetch --all --prune（原型模拟）')}
        >
          <Icon name="download" size={14} />
        </div>
        <div
          className="ibtn"
          style={{ width: 26, height: 26 }}
          title="刷新提交图谱（R）"
          onClick={() => useStore.getState().toast('已刷新提交图谱')}
        >
          <Icon name="reset" size={14} />
        </div>
      </div>

      {/* 表头：与下方数据行严格 1:1 像素对齐 */}
      <div className="git-header">
        <span style={{ width: gw + 6, marginLeft: 8 }}>拓扑</span>
        <span style={{ flex: 1 }}>提交说明与分支引用</span>
        <span style={{ width: 110, marginLeft: 8 }}>作者</span>
        <span style={{ width: 84, marginLeft: 8, textAlign: 'right' }}>时间</span>
        <span style={{ width: 76, marginLeft: 8, textAlign: 'right' }}>SHA</span>
      </div>

      <div className="git-list">
        {GIT_COMMITS.map((c, i) => {
          const sel = c.sha === g.selectedSha
          const dim = q !== '' && !matchSet.has(i)
          const isFirst = i === 0
          const isLast = i === GIT_COMMITS.length - 1
          const visibleRefs = (c.refs ?? []).filter(r => g.showRemote || r.k !== 'remote')

          return (
            <div key={c.sha} className="git-item-group">
              <CtxMenu items={gitMenuItems()} onPick={item => pickGit(c.sha, item)}>
                <div
                  className={cn('git-row', sel && 'sel')}
                  style={dim ? { opacity: 0.35 } : undefined}
                  onClick={() => useStore.getState().gitSelect(c.sha)}
                >
                  <RowGraph c={c} isFirst={isFirst} isLast={isLast && !sel} selected={sel} />
                  <span className="desc">
                    {visibleRefs.map((r, j) => (
                      <RefChip key={j} d={r} />
                    ))}
                    <span className="msg">{c.msg}</span>
                  </span>
                  <span className="author" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 999,
                        background: 'rgba(99,102,241,.22)',
                        border: '1px solid rgba(99,102,241,.4)',
                        color: 'var(--accentHover)',
                        fontSize: 9.5,
                        fontWeight: 600,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {c.author.slice(0, 1).toUpperCase()}
                    </span>
                    <span>{c.author}</span>
                  </span>
                  <span className="date">{c.time}</span>
                  <span className="sha">
                    <span className="sha-pill">{c.sha}</span>
                  </span>
                </div>
              </CtxMenu>

              {/* 行内展开 CDV：左侧保留拓扑走廊使竖线贯穿不断裂，右侧内嵌圆角双栏详情舱 */}
              {sel && (
                <div className="git-cdv-row">
                  <RowCdvPassThrough c={c} isLast={isLast} />
                  <div className="git-cdv">
                    <div className="git-cdv-sum sum">
                      <div className="cdv-title">{c.msg}</div>
                      <div className="cdv-meta">
                        <span className="k">Commit:</span>
                        <span className="v" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span>{c.sha}f8e2b9104d3c</span>
                          <button
                            type="button"
                            className="mini-btn"
                            style={{ height: 18, padding: '0 5px', fontSize: 10 }}
                            onClick={e => {
                              e.stopPropagation()
                              useStore.getState().toast(`已复制完整 SHA: ${c.sha}f8e2b9104d3c`)
                            }}
                          >
                            <Icon name="copy" size={10} /> 复制
                          </button>
                        </span>
                      </div>
                      <div className="cdv-meta">
                        <span className="k">Parents:</span>
                        <span className="v" style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap' }}>
                          {(c.parents ?? []).length ? (
                            c.parents!.map(p => (
                              <span
                                key={p}
                                onClick={e => {
                                  e.stopPropagation()
                                  useStore.setState(d => void (d.git.selectedSha = p))
                                }}
                                style={{
                                  padding: '0 6px',
                                  borderRadius: 4,
                                  background: 'var(--inputBg)',
                                  border: '1px solid var(--borderSubtle)',
                                  color: 'var(--accentHover)',
                                  cursor: 'pointer',
                                  fontSize: 11,
                                }}
                                title={`跳转到父提交 ${p}`}
                              >
                                {p}
                              </span>
                            ))
                          ) : (
                            <span>— (root commit)</span>
                          )}
                        </span>
                      </div>
                      <div className="cdv-meta">
                        <span className="k">Author:</span>
                        <span className="v">{c.author} &lt;you@j-agent.dev&gt;</span>
                      </div>
                      <div className="cdv-meta">
                        <span className="k">Date:</span>
                        <span className="v">{c.time}</span>
                      </div>
                      {c.body && <div className="cdv-body nested-scroll">{c.body}</div>}
                    </div>
                    <div className="git-cdv-files files">
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: 8,
                          paddingBottom: 6,
                          borderBottom: '1px solid var(--border)',
                          fontSize: 11,
                          color: 'var(--muted)',
                          flexShrink: 0,
                        }}
                      >
                        <span style={{ fontWeight: 600, color: 'var(--textBright)' }}>
                          变更文件 ({c.files.length})
                        </span>
                        <span style={{ fontSize: 10.5, color: 'var(--accentHover)' }}>
                          点击文件在主画布打开宽幅 Diff 视图 →
                        </span>
                      </div>
                      <div className="ftree nested-scroll">
                        {c.files.map(f => {
                          const sl = f.lastIndexOf('/')
                          const st = c.fileStats?.[f]
                          return (
                            <div
                              className="frow"
                              key={f}
                              onClick={() => openFileInMainCanvas(f)}
                            >
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  color: 'var(--statusRunning)',
                                  width: 14,
                                  flexShrink: 0,
                                }}
                              >
                                M
                              </span>
                              <Icon name="file" size={12} />
                              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {sl >= 0 && <span className="fdir">{f.slice(0, sl + 1)}</span>}
                                <span style={{ color: 'var(--textBright)', fontWeight: 500 }}>
                                  {sl >= 0 ? f.slice(sl + 1) : f}
                                </span>
                              </span>
                              {st && (
                                <span style={{ display: 'flex', gap: 6, fontSize: 11, flexShrink: 0 }}>
                                  <span style={{ color: 'var(--statusDone)' }}>+{st[0]}</span>
                                  <span style={{ color: 'var(--statusError)' }}>−{st[1]}</span>
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
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
