import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useStore } from '@/store'
import { presetIcon, relTime, rowTitle } from '@/model'
import { DIFFS, PREVIEWS, seedSettings } from '@/seed'
import { Icon } from '@/icons'
import { cn } from '@/lib/utils'
import type { Msg, SessionView, Thread, Workspace } from '@/types'
import { GitGraphView } from './GitGraphView'

/* ═══ Bento 启动台（HomePane & WorkspaceEmpty 共享的 Bento Launchpad 架构）═══ */
export function HomePane() {
  const workspaces = useStore(s => s.workspaces)
  const first = workspaces[0]
  if (first) return <BentoLaunchpad ws={first} />
  return null
}

export function WorkspacePage({ ws }: { ws: Workspace }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
      {ws.paneTab === 'git' ? <GitGraphView ws={ws} /> : <BentoLaunchpad ws={ws} />}
    </div>
  )
}

function BentoLaunchpad({ ws }: { ws: Workspace }) {
  const presets = useStore(s => s.settings.presets.items)
  const threads = useStore(s => s.threads)
  const wt = useStore(s => s.worktree)
  const wsThreads = threads.filter(t => t.workspaceId === ws.id)
  const runningCount = wsThreads.filter(t => t.kind !== 'terminal' || t.status === 'running').length
  const exitedCount = wsThreads.filter(t => t.kind === 'terminal' && t.status === 'exited').length
  const bellOrUnread = wsThreads.filter(t => t.hasBell || t.unread).length
  const addLines = wt.files.reduce((n, f) => n + (f.added ?? 0), 0)
  const delLines = wt.files.reduce((n, f) => n + (f.deleted ?? 0), 0)

  return (
    <div className="bento-launchpad">
      <div className="bento-wrap">
        {/* 顶部居中对称工作区 Hero 信息头 */}
        <div className="bento-hero">
          <div className="bento-hero-icon">
            <Icon name="folder" size={18} />
          </div>
          <div style={{ fontSize: 18, fontWeight: 650, color: 'var(--textBright)', letterSpacing: '-0.01em' }}>
            {ws.name}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexWrap: 'wrap',
              gap: 8,
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              color: 'var(--muted)',
            }}
          >
            <span>{ws.path}</span>
            <span
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--borderSubtle)',
                padding: '1px 8px',
                borderRadius: 5,
                color: wsThreads.length > 0 ? 'var(--textBright)' : 'var(--muted)',
              }}
            >
              {wsThreads.length > 0
                ? `● ${wsThreads.length} 个会话（${runningCount} 活跃${exitedCount ? ` · ${exitedCount} 已退出` : ''}）`
                : '○ 暂无活跃会话'}
            </span>
            {bellOrUnread > 0 && (
              <span
                style={{
                  background: 'rgba(192,132,252,.15)',
                  border: '1px solid rgba(192,132,252,.35)',
                  padding: '1px 8px',
                  borderRadius: 5,
                  color: 'var(--acpKind)',
                }}
              >
                🔔 {bellOrUnread} 待处理
              </span>
            )}
            <button
              type="button"
              className="tb-cell tb-branch-btn"
              style={{ height: 22, padding: '0 8px', fontSize: 11 }}
              onClick={() => useStore.getState().openGitGraph()}
              title="打开 Git 提交图谱"
            >
              <span style={{ color: 'var(--accentHover)', display: 'flex' }}>
                <Icon name="gitBranch" size={12} />
              </span>
              <span>{wt.branch || 'main'} · Git 图谱</span>
            </button>
            {wt.files.length > 0 && (
              <button
                type="button"
                className="tb-cell tb-branch-btn"
                style={{ height: 22, padding: '0 8px', fontSize: 11, gap: 5 }}
                onClick={() =>
                  useStore.setState(d => {
                    d.ui.panelTab = 'changes'
                    d.ui.panelOpen = true
                  })
                }
                title="在右侧面板查看工作区变更"
              >
                <span>{wt.files.length} 变更</span>
                <span style={{ color: 'var(--statusDone)' }}>+{addLines}</span>
                <span style={{ color: 'var(--statusError)' }}>−{delLines}</span>
              </button>
            )}
          </div>
        </div>

        {/* 第一层：双列横向紧凑主动作卡（高 64px，始终可用，即使预设删空也可直接启动） */}
        <div className="bento-primary-grid">
          <button
            type="button"
            className="bento-card featured"
            onClick={() => useStore.getState().createAcp('acp-claude', 'Claude (ACP)', ws.id)}
          >
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: 'rgba(192,132,252,.16)',
                color: 'var(--acpKind)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Icon name="acp" size={17} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--textBright)' }}>
                启动 AI Coding Agent
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
                Claude Code / Codex ACP 代理
              </div>
            </div>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                color: 'var(--muted)',
                background: 'rgba(255,255,255,.05)',
                border: '1px solid var(--borderSubtle)',
                padding: '2px 6px',
                borderRadius: 5,
                flexShrink: 0,
              }}
            >
              ⌘N
            </span>
          </button>

          <button
            type="button"
            className="bento-card"
            onClick={() => useStore.getState().spawnFromPreset('shell', ws.id)}
          >
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: 'rgba(52,211,153,.15)',
                color: 'var(--terminalKind)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Icon name="terminal" size={17} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--textBright)' }}>
                新建交互式终端
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
                打开原生 GPU 加速 PTY 会话
              </div>
            </div>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                color: 'var(--muted)',
                background: 'rgba(255,255,255,.05)',
                border: '1px solid var(--borderSubtle)',
                padding: '2px 6px',
                borderRadius: 5,
                flexShrink: 0,
              }}
            >
              ⌘T
            </span>
          </button>
        </div>

        {/* 第二层：预设矩阵（支持满配、删减后自适应列宽、以及删空后的引导态） */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            终端与 Agent 预设 ({presets.length})
          </span>
          <span
            style={{ fontSize: 11.5, color: 'var(--accentHover)', cursor: 'pointer' }}
            onClick={() => {
              useStore.setState(d => {
                d.ui.settingsSection = 'presets'
                d.ui.settingsWindowOpen = true
              })
            }}
          >
            管理预设 →
          </span>
        </div>

        {presets.length === 0 ? (
          <div
            style={{
              padding: '12px 16px',
              borderRadius: 9,
              border: '1px dashed var(--borderSubtle)',
              background: 'rgba(24,28,39,.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              预设工具已全部移除。仍可使用上方两张主入口卡启动会话，或恢复默认预设。
            </span>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button
                type="button"
                className="tb-cell tb-branch-btn"
                style={{ height: 26, padding: '0 10px', fontSize: 11.5 }}
                onClick={() => {
                  useStore.setState(d => {
                    d.settings.presets.items = seedSettings().presets.items
                  })
                  useStore.getState().toast('已恢复 5 个默认预设')
                }}
              >
                <Icon name="reset" size={11.5} /> 恢复默认预设
              </button>
              <button
                type="button"
                className="sb-btn-primary"
                style={{ flex: 'none', height: 26, padding: '0 10px', fontSize: 11.5 }}
                onClick={() => {
                  useStore.setState(d => {
                    d.ui.settingsSection = 'presets'
                    d.ui.settingsWindowOpen = true
                  })
                }}
              >
                <Icon name="plus" size={11.5} /> 添加预设
              </button>
            </div>
          </div>
        ) : (
          <div
            className="bento-preset-grid"
            style={{
              gridTemplateColumns:
                presets.length === 1
                  ? 'repeat(2, minmax(0, 1fr))'
                  : 'repeat(3, minmax(0, 1fr))',
            }}
          >
            {presets.map(p => (
              <button
                type="button"
                className="pill"
                key={p.id}
                onClick={() => useStore.getState().spawnFromPreset(p.id, ws.id)}
              >
                <span className="pill-icon">
                  <Icon name={presetIcon(p)} size={14} />
                </span>
                <span className="t">{p.label}</span>
                <Icon name="arrowRight" size={12} />
              </button>
            ))}
            <button
              type="button"
              className="pill"
              onClick={() => useStore.getState().openToolDialog(ws.id)}
            >
              <span className="pill-icon">
                <Icon name="plus" size={14} />
              </span>
              <span className="t">更多工具…</span>
              <Icon name="arrowRight" size={12} />
            </button>
          </div>
        )}

        {/* 第三层：会话列表（支持 0 会话空态、常规恢复、以及 20+ 多会话滚动与批量清理） */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            工作区会话 ({wsThreads.length})
          </span>
          {wsThreads.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {exitedCount > 0 && (
                <span
                  style={{ fontSize: 11.5, color: 'var(--muted)', cursor: 'pointer' }}
                  onClick={() => useStore.getState().clearExitedSessions(ws.id)}
                >
                  清理已退出 ({exitedCount})
                </span>
              )}
              <span
                style={{ fontSize: 11.5, color: 'var(--bell)', cursor: 'pointer' }}
                onClick={() => {
                  useStore.setState(d => {
                    d.threads = d.threads.filter(t => t.workspaceId !== ws.id)
                  })
                  useStore.getState().toast(`已清空「${ws.name}」下的全部会话`)
                }}
              >
                清空本工作区会话
              </span>
            </div>
          )}
        </div>

        {wsThreads.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div
              style={{
                padding: '18px 20px',
                borderRadius: 9,
                border: '1px dashed var(--borderSubtle)',
                background: 'rgba(24,28,39,.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: 'var(--faint)' }}>
                  <Icon name="terminal" size={16} />
                </span>
                <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  当前工作区暂无活跃会话。点击上方卡片即可创建新会话。
                </span>
              </div>
              <button
                type="button"
                className="tb-cell tb-branch-btn"
                style={{ height: 26, padding: '0 10px', fontSize: 11.5, flexShrink: 0 }}
                onClick={() => useStore.getState().spawnFromPreset('shell', ws.id)}
              >
                <Icon name="plus" size={11.5} /> 快速启动终端
              </button>
            </div>
            {/* 0 会话空态下的全局快捷键速查导览条 */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                gap: 8,
              }}
            >
              {[
                ['⌘N / Ctrl-Shift-N', '打开工具命令面板'],
                ['⌘K / Ctrl-K', '全局搜索与跳转会话'],
                ['⌘, / Ctrl-,', '打开独立设置窗口'],
                ['Ctrl-Shift-G', '查看 Git 提交图谱'],
              ].map(([k, lbl]) => (
                <div
                  key={k}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 7,
                    background: 'rgba(24,28,39,.35)',
                    border: '1px solid var(--border)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--accentHover)' }}>
                    {k}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>{lbl}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div
            className="nested-scroll"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              maxHeight: 204,
              paddingRight: 4,
            }}
          >
            {wsThreads.map(t => {
              const isExited = t.kind === 'terminal' && t.status === 'exited'
              return (
                <div
                  key={t.id}
                  onClick={() => useStore.getState().activate({ type: 'thread', id: t.id })}
                  style={{
                    height: 32,
                    padding: '0 10px',
                    borderRadius: 7,
                    background: 'rgba(24,28,39,.55)',
                    border: '1px solid var(--border)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12.5,
                    cursor: 'pointer',
                    flexShrink: 0,
                    opacity: isExited ? 0.65 : 1,
                  }}
                >
                  <span style={{ color: isExited ? 'var(--faint)' : t.kind === 'terminal' ? 'var(--terminalKind)' : t.kind === 'acp' ? 'var(--acpKind)' : 'var(--accentHover)' }}>
                    <Icon name={t.kind === 'terminal' ? 'terminal' : t.kind === 'acp' ? 'acp' : 'chat'} size={13} />
                  </span>
                  <span style={{ color: isExited ? 'var(--muted)' : 'var(--textBright)', fontWeight: t.unread ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {rowTitle(t)}
                  </span>
                  {t.pin && (
                    <span style={{ color: 'var(--faint)', display: 'flex' }} title="已置顶">
                      <Icon name="pin" size={11} />
                    </span>
                  )}
                  {t.pendingReply && (
                    <span style={{ fontSize: 10, padding: '0 6px', borderRadius: 4, background: 'rgba(251,191,36,.14)', color: 'var(--statusRunning)', border: '1px solid rgba(251,191,36,.3)' }}>
                      思考中…
                    </span>
                  )}
                  {t.hasBell && (
                    <span style={{ fontSize: 10, padding: '0 6px', borderRadius: 4, background: 'rgba(192,132,252,.14)', color: 'var(--acpKind)', border: '1px solid rgba(192,132,252,.3)' }}>
                      🔔 等待注意
                    </span>
                  )}
                  {!isExited && t.unread && !t.pendingReply && (
                    <span style={{ fontSize: 10, padding: '0 5px', borderRadius: 4, background: 'var(--accentSoft)', color: 'var(--accentHover)' }}>
                      未读
                    </span>
                  )}
                  {isExited && (
                    <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--faint)' }}>
                      [已退出]
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', color: 'var(--faint)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
                    {relTime(t.createdAt)} · {t.views?.length ? `${t.views.length + 1} 视图` : t.kind.toUpperCase()}
                  </span>
                  <button
                    type="button"
                    className="mini-btn danger"
                    title="移除此会话"
                    style={{ height: 22, padding: '0 5px' }}
                    onClick={e => {
                      e.stopPropagation()
                      useStore.getState().closeThread(t.id)
                    }}
                  >
                    <Icon name="close" size={11.5} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/* ═══ 终端表面（含 12px 呼吸内边距 + 底部 26px 状态条）═══ */
export function TerminalSurface({ t }: { t: Thread }) {
  const term = useStore(s => s.terms[t.id])
  const fontSize = useStore(s => s.settings.terminal.fontSize)
  const fontFamily = useStore(s => s.settings.terminal.fontFamily)
  const cursorBlink = useStore(s => s.settings.terminal.cursorBlink)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    useStore.getState().ensureTerm(t.id)
  }, [t.id])

  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [term?.lines.length, term?.draft])

  useEffect(() => {
    const st = useStore.getState()
    const ae = document.activeElement
    const inputBusy = /INPUT|TEXTAREA|SELECT/.test(ae?.tagName ?? '')
    if (st.ui.dialog.kind === 'none' && !st.ui.settingsWindowOpen && !inputBusy) ref.current?.focus()
  }, [t.id])

  return (
    <div className="term-surface">
      <div
        ref={ref}
        className={cn('term', !cursorBlink && 'noblink')}
        tabIndex={0}
        style={{ fontSize, fontFamily: `'${fontFamily}',monospace` }}
        onKeyDown={e => {
          if (e.ctrlKey || e.metaKey || e.altKey) return
          if (e.key === 'Enter' || e.key === 'Backspace' || e.key.length === 1) {
            useStore.getState().termKey(t.id, e)
            e.preventDefault()
          }
        }}
      >
        {(term?.lines ?? []).map((l, i) => (
          <div className="ln" key={i}>
            {l.spans.map((sp, j) => (
              <span key={j} className={sp.cls}>
                {sp.text}
              </span>
            ))}
          </div>
        ))}
        {t.status !== 'exited' && (
          <div className="ln">
            <span className="c-green">❯</span> <span>{term?.draft ?? ''}</span>
            <span className="cursor" />
          </div>
        )}
      </div>

      {/* 底部 26px 轻量终端状态条 */}
      <div className="term-statusbar">
        <div style={{ display: 'flex', gap: 14 }}>
          <span>
            <strong style={{ color: t.status === 'exited' ? 'var(--faint)' : 'var(--terminalKind)' }}>
              ● {t.status === 'exited' ? '进程已退出' : 'PTY 活跃'}
            </strong>{' '}
            · session #{t.sessionId ?? 100}
          </span>
          <span>cwd: {t.cwd ?? '~'}</span>
        </div>
        <div style={{ display: 'flex', gap: 14 }}>
          <span>{fontFamily} {fontSize}px</span>
          <span>UTF-8</span>
        </div>
      </div>
    </div>
  )
}

export function FileSurface({ path }: { path: string }) {
  const wt = useStore(s => s.worktree)
  const changed = wt.files.find(f => f.path === path)
  const patch = DIFFS[path]
  const hasDiff = !!patch && changed?.status !== 'a'
  const [mode, setMode] = useState<'diff' | 'split' | 'source'>(hasDiff ? 'diff' : 'source')

  // 当切换文件时，若新文件有 Diff 则保持或切到 diff，若无 Diff 则自动切回 source
  useEffect(() => {
    if (!hasDiff && mode !== 'source') setMode('source')
  }, [path, hasDiff, mode])

  const code =
    PREVIEWS[path] ??
    `// ${path}\nimport { useStore } from '@/store'\n\nexport function ModulePreview() {\n  return null\n}`
  const lines = code.split('\n')
  const patchLines = (patch ?? '').split('\n')

  // 构造并排对比 (Side-by-Side) 行数据
  const leftLines: { no: number | ''; text: string; cls: string }[] = []
  const rightLines: { no: number | ''; text: string; cls: string }[] = []
  if (hasDiff) {
    let lNo = 44
    let rNo = 44
    for (const pl of patchLines) {
      if (pl.startsWith('@@')) {
        leftLines.push({ no: '', text: pl, cls: 'hunk' })
        rightLines.push({ no: '', text: pl, cls: 'hunk' })
      } else if (pl.startsWith('-')) {
        leftLines.push({ no: lNo++, text: pl.slice(1), cls: 'del' })
        rightLines.push({ no: '', text: '', cls: 'empty' })
      } else if (pl.startsWith('+')) {
        leftLines.push({ no: '', text: '', cls: 'empty' })
        rightLines.push({ no: rNo++, text: pl.slice(1), cls: 'add' })
      } else {
        const clean = pl.startsWith(' ') ? pl.slice(1) : pl
        leftLines.push({ no: lNo++, text: clean, cls: '' })
        rightLines.push({ no: rNo++, text: clean, cls: '' })
      }
    }
  }

  const parts = path.split('/')
  const fileName = parts.pop() ?? path
  const dirPrefix = parts.length ? parts.join(' / ') + ' / ' : ''

  return (
    <div className="file-surface">
      {/* 顶部宽幅文件与 Diff 模式切换栏 */}
      <div className="file-pathbar" style={{ justifyContent: 'space-between', height: 38, padding: '0 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ color: 'var(--accentHover)', display: 'flex' }}>
            <Icon name="file" size={13} />
          </span>
          <span className="p" style={{ fontSize: 12 }}>
            {dirPrefix && <span style={{ color: 'var(--muted)' }}>{dirPrefix}</span>}
            <strong style={{ color: 'var(--textBright)', fontWeight: 600 }}>{fileName}</strong>
          </span>
          {changed ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 10.5,
                fontFamily: 'var(--font-mono)',
                padding: '1px 7px',
                borderRadius: 5,
                background: 'var(--surface)',
                border: '1px solid var(--borderSubtle)',
              }}
            >
              <strong
                style={{
                  color:
                    changed.status === 'm'
                      ? 'var(--statusRunning)'
                      : changed.status === 'a'
                        ? 'var(--statusDone)'
                        : 'var(--statusError)',
                }}
              >
                {changed.status === 'm' ? 'Modified' : changed.status === 'a' ? 'Added' : 'Deleted'}
              </strong>
              {changed.added != null && <span style={{ color: 'var(--statusDone)' }}>+{changed.added}</span>}
              {changed.deleted != null && <span style={{ color: 'var(--statusError)' }}>−{changed.deleted}</span>}
            </span>
          ) : (
            <span
              style={{
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
                padding: '1px 6px',
                borderRadius: 4,
                background: 'var(--surface)',
                color: 'var(--muted)',
                border: '1px solid var(--borderSubtle)',
              }}
            >
              只读源码
            </span>
          )}
        </div>

        {/* 右侧分段视图切换器：Unified Diff | 并排对比 | 完整源码 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {hasDiff && (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 2,
                padding: 2,
                borderRadius: 7,
                background: 'var(--inputBg)',
                border: '1px solid var(--borderSubtle)',
              }}
            >
              {(
                [
                  ['diff', 'Unified Diff'],
                  ['split', '并排对比'],
                  ['source', '完整源码'],
                ] as const
              ).map(([k, lbl]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setMode(k)}
                  style={{
                    height: 22,
                    padding: '0 9px',
                    borderRadius: 5,
                    fontSize: 11,
                    fontWeight: mode === k ? 600 : 400,
                    background: mode === k ? 'var(--surfaceActive)' : 'transparent',
                    color: mode === k ? 'var(--textBright)' : 'var(--muted)',
                    cursor: 'pointer',
                  }}
                >
                  {lbl}
                </button>
              ))}
            </div>
          )}
          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>
            {lines.length} lines · UTF-8
          </span>
        </div>
      </div>

      {/* 主画布宽幅内容区 */}
      {mode === 'diff' && hasDiff ? (
        <div className="code-view" style={{ padding: '10px 0' }}>
          {patchLines.map((l, i) => {
            let bg = 'transparent'
            let col = 'var(--text)'
            let tag = ' '
            if (l.startsWith('@@')) {
              bg = 'rgba(56,189,248,.1)'
              col = 'var(--cyan)'
              tag = '@@'
            } else if (l.startsWith('+')) {
              bg = 'rgba(52,211,153,.12)'
              col = 'var(--statusDone)'
              tag = '+'
            } else if (l.startsWith('-')) {
              bg = 'rgba(248,113,113,.12)'
              col = 'var(--statusError)'
              tag = '−'
            }
            return (
              <div
                className="cl"
                key={i}
                style={{
                  background: bg,
                  color: col,
                  padding: '2px 14px 2px 0',
                  borderLeft:
                    tag === '+'
                      ? '3px solid var(--statusDone)'
                      : tag === '−'
                        ? '3px solid var(--statusError)'
                        : '3px solid transparent',
                }}
              >
                <span className="ln-no" style={{ width: 42 }}>
                  {l.startsWith('@@') ? '⋯' : 43 + i}
                </span>
                <span style={{ width: 20, color: 'var(--muted)', userSelect: 'none' }}>{tag}</span>
                <span>{l.startsWith('+') || l.startsWith('-') ? l.slice(1) : l}</span>
              </div>
            )
          })}
        </div>
      ) : mode === 'split' && hasDiff ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* 顶部固定双栏对比 Sticky 表头（不随下方代码滚动消失） */}
          <div
            style={{
              height: 28,
              flexShrink: 0,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              background: 'rgba(18,21,30,.92)',
              borderBottom: '1px solid var(--border)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--muted)',
            }}
          >
            <div
              style={{
                padding: '0 14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderRight: '1px solid var(--borderSubtle)',
              }}
            >
              <span>HEAD (变更前基准)</span>
              <span style={{ color: 'var(--statusError)' }}>−{changed?.deleted ?? 0} 行移除</span>
            </div>
            <div
              style={{
                padding: '0 14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>Working Tree (当前修改)</span>
              <span style={{ color: 'var(--statusDone)' }}>+{changed?.added ?? 0} 行新增</span>
            </div>
          </div>

          {/* 下方单轴同步滚动双栏代码区 */}
          <div
            className="isolated-scroll"
            style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr' }}
          >
            {/* 左栏：变更前 HEAD */}
            <div className="code-view" style={{ borderRight: '1px solid var(--borderSubtle)', padding: '6px 0', overflow: 'hidden' }}>
              {leftLines.map((item, i) => (
                <div
                  className="cl"
                  key={i}
                  style={{
                    background:
                      item.cls === 'del'
                        ? 'rgba(248,113,113,.13)'
                        : item.cls === 'hunk'
                          ? 'rgba(56,189,248,.08)'
                          : item.cls === 'empty'
                            ? 'rgba(0,0,0,.18)'
                            : 'transparent',
                    color:
                      item.cls === 'del'
                        ? 'var(--statusError)'
                        : item.cls === 'hunk'
                          ? 'var(--cyan)'
                          : 'var(--text)',
                    padding: '2px 10px 2px 0',
                  }}
                >
                  <span className="ln-no">{item.no}</span>
                  <span>{item.text || ' '}</span>
                </div>
              ))}
            </div>

            {/* 右栏：当前工作区 Working Tree */}
            <div className="code-view" style={{ padding: '6px 0', overflow: 'hidden' }}>
              {rightLines.map((item, i) => (
                <div
                  className="cl"
                  key={i}
                  style={{
                    background:
                      item.cls === 'add'
                        ? 'rgba(52,211,153,.13)'
                        : item.cls === 'hunk'
                          ? 'rgba(56,189,248,.08)'
                          : item.cls === 'empty'
                            ? 'rgba(0,0,0,.18)'
                            : 'transparent',
                    color:
                      item.cls === 'add'
                        ? 'var(--statusDone)'
                        : item.cls === 'hunk'
                          ? 'var(--cyan)'
                          : 'var(--textBright)',
                    padding: '2px 10px 2px 0',
                  }}
                >
                  <span className="ln-no">{item.no}</span>
                  <span>{item.text || ' '}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="code-view" style={{ padding: '10px 0' }}>
          {lines.map((l, i) => (
            <div className="cl" key={i} style={{ padding: '1px 14px 1px 0' }}>
              <span className="ln-no" style={{ width: 42 }}>{i + 1}</span>
              <span style={{ color: l.trim().startsWith('//') || l.trim().startsWith('/*') ? 'var(--muted)' : 'var(--textBright)' }}>
                {l || ' '}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function SessionShell({
  threadId,
  view,
}: {
  threadId: string
  view: Extract<SessionView, { kind: 'shell' }>
}) {
  const fontSize = useStore(s => s.settings.terminal.fontSize)
  const fontFamily = useStore(s => s.settings.terminal.fontFamily)
  const cursorBlink = useStore(s => s.settings.terminal.cursorBlink)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [view.lines.length, view.draft])

  return (
    <div className="term-surface">
      <div
        ref={ref}
        className={cn('term', !cursorBlink && 'noblink')}
        tabIndex={0}
        style={{ fontSize, fontFamily: `'${fontFamily}',monospace` }}
        onKeyDown={e => {
          if (e.ctrlKey || e.metaKey || e.altKey) return
          if (e.key === 'Enter' || e.key === 'Backspace' || e.key.length === 1) {
            useStore.getState().sessionShellKey(threadId, view.id, e)
            e.preventDefault()
          }
        }}
      >
        {view.lines.map((l, i) => (
          <div className="ln" key={i}>
            {l.spans.map((sp, j) => (
              <span key={j} className={sp.cls}>
                {sp.text}
              </span>
            ))}
          </div>
        ))}
        <div className="ln">
          <span className="c-green">❯</span> <span>{view.draft}</span>
          <span className="cursor" />
        </div>
      </div>
      <div className="term-statusbar">
        <span><strong style={{ color: 'var(--terminalKind)' }}>● 伴随 Shell</strong> · {view.label}</span>
        <span>cwd: {view.cwd}</span>
      </div>
    </div>
  )
}

/* ═══ AI 对话 / ACP 主面（已移除重复的 44px conv-head，内嵌工具调用链 + 多功能 Composer 舱）═══ */
export function ConversationView({ t }: { t: Thread }) {
  const ph = t.kind === 'acp' ? '向 Coding Agent 发送指令（Enter 发送，Shift+Enter 换行）…' : '输入消息，或使用 @ 引用工作区文件…'
  const listRef = useRef<HTMLDivElement>(null)
  const [traceOpen, setTraceOpen] = useState(true)
  const [model, setModel] = useState(t.kind === 'acp' ? 'gpt-5-codex' : 'claude-sonnet-4.5')
  const msgCount = t.messages?.length ?? 0

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgCount, t.pendingReply])

  const send = (text: string) => {
    if (text.trim() && !t.pendingReply) useStore.getState().sendChat(t.id, text)
  }

  return (
    <div className="conv">
      {/* 彻底移除了旧版重复的 44px .conv-head，连接状态已并入 40px 融合顶栏 */}
      <div className="conv-msgs" ref={listRef}>
        <div className="conv-msgs-in">
          {(t.messages ?? []).map((m, idx) => (
            <div key={m.id}>
              {m.role === 'assistant' && idx === 1 && (
                /* Agent 工具调用执行链卡片 */
                <div
                  style={{
                    marginBottom: 14,
                    borderRadius: 9,
                    border: '1px solid var(--borderSubtle)',
                    background: 'var(--inputBg)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    onClick={() => setTraceOpen(o => !o)}
                    style={{
                      height: 32,
                      padding: '0 12px',
                      background: 'rgba(24,28,39,.75)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: 11.5,
                      color: 'var(--muted)',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ color: 'var(--statusDone)', display: 'flex' }}>
                        <Icon name="check" size={12.5} />
                      </span>
                      <span style={{ color: 'var(--textBright)', fontWeight: 550 }}>
                        Agent 已执行 2 个工具调用
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--faint)' }}>
                        Read · Edit · 0.6s
                      </span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span>{traceOpen ? '收起详情' : '展开详情'}</span>
                      <Icon name={traceOpen ? 'chevronUp' : 'chevronDown'} size={12} />
                    </span>
                  </div>
                  {traceOpen && (
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      {[
                        { path: 'packages/app/src/plane/Sidebar.tsx', add: 42, del: 18 },
                        { path: 'packages/app/src/plane/WorkspaceList.tsx', add: 96, del: 31 },
                      ].map(item => (
                        <div
                          key={item.path}
                          onClick={() =>
                            useStore.setState(d => {
                              d.ui.panelOpen = true
                              d.ui.panelTab = 'changes'
                              d.worktree.selected = item.path
                            })
                          }
                          style={{
                            height: 29,
                            padding: '0 12px',
                            borderTop: '1px solid var(--border)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11,
                            cursor: 'pointer',
                          }}
                        >
                          <span
                            style={{
                              fontSize: 9.5,
                              padding: '0 5px',
                              borderRadius: 4,
                              background: 'rgba(99,102,241,.16)',
                              color: 'var(--accentHover)',
                              border: '1px solid rgba(99,102,241,.3)',
                            }}
                          >
                            EDIT
                          </span>
                          <span style={{ color: 'var(--textBright)' }}>{item.path}</span>
                          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ color: 'var(--statusDone)' }}>+{item.add}</span>
                            <span style={{ color: 'var(--statusError)' }}>−{item.del}</span>
                            <span style={{ color: 'var(--faint)', fontSize: 10.5 }}>查看 Diff →</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <MsgView m={m} model={model} />
            </div>
          ))}
          {t.pendingReply && (
            <div className="thinking">
              <span className="thinking-dot" />
              正在思考…
            </div>
          )}
        </div>
      </div>

      {/* 底部 Composer 舱：与上方 .conv-msgs-in 严格共享 760px 中轴容器，100% 居中对齐 */}
      <div className="composer">
        <div className="composer-inner">
          <div className="composer-shell" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, padding: '9px 12px' }}>
            {/* 上排：上下文文件胶囊与模型选择条 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  onClick={() =>
                    useStore.setState(d => {
                      d.ui.panelOpen = true
                      d.worktree.selected = 'packages/app/src/plane/Sidebar.tsx'
                    })
                  }
                  title="点击查看关联文件 Diff"
                  style={{
                    height: 22,
                    padding: '0 7px',
                    borderRadius: 5,
                    background: 'var(--surface)',
                    border: '1px solid var(--borderSubtle)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--textBright)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ color: 'var(--accentHover)', display: 'flex' }}>
                    <Icon name="file" size={11} />
                  </span>
                  <span>@Sidebar.tsx</span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    useStore.setState(d => {
                      d.ui.panelOpen = true
                      d.ui.panelTab = 'files'
                    })
                  }
                  style={{
                    height: 22,
                    padding: '0 7px',
                    borderRadius: 5,
                    border: '1px dashed var(--borderSubtle)',
                    fontSize: 11,
                    color: 'var(--muted)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    cursor: 'pointer',
                  }}
                >
                  <Icon name="plus" size={10.5} />
                  <span>添加上下文</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  const next = model === 'claude-sonnet-4.5' ? 'gpt-5-codex' : 'claude-sonnet-4.5'
                  setModel(next)
                  useStore.getState().toast(`已切换对话模型为 ${next}`)
                }}
                style={{
                  height: 22,
                  padding: '0 8px',
                  borderRadius: 5,
                  background: 'rgba(99,102,241,.12)',
                  border: '1px solid rgba(99,102,241,.32)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10.5,
                  color: 'var(--accentHover)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  cursor: 'pointer',
                }}
                title="点击切换模型"
              >
                <Icon name="acp" size={11} />
                <span>{model}</span>
                <Icon name="chevronDown" size={10.5} />
              </button>
            </div>

            {/* 下排：输入框 + 发送按钮 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <textarea
                placeholder={ph}
                rows={1}
                style={{ flex: 1 }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    const el = e.target as HTMLTextAreaElement
                    send(el.value)
                    el.value = ''
                  }
                }}
              />

              <button
                type="button"
                className={cn('send-btn', t.pendingReply && 'disabled')}
                disabled={t.pendingReply}
                aria-label="发送消息"
                onClick={e => {
                  const ta = e.currentTarget.closest('.composer-shell')?.querySelector('textarea')
                  if (ta) {
                    send(ta.value)
                    ta.value = ''
                  }
                }}
              >
                <Icon name="arrowRight" size={14} />
              </button>
            </div>
          </div>
          <div className="composer-hint">
            <span>@ 引用工作区文件 · / 执行快捷指令 · 点击代码块可复制</span>
            <span>Enter 发送 · Shift + Enter 换行</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function inlineMd(s: string): ReactNode[] {
  return s.split(/`([^`\n]+)`/g).map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))
}

function MdLite({ text }: { text: string }) {
  const out: ReactNode[] = []
  let k = 0
  const codeRe = /```(\w*)\n([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  const segs: { type: 'code' | 'text'; text: string }[] = []
  while ((m = codeRe.exec(text))) {
    if (m.index > last) segs.push({ type: 'text', text: text.slice(last, m.index) })
    segs.push({ type: 'code', text: m[2] })
    last = codeRe.lastIndex
  }
  if (last < text.length) segs.push({ type: 'text', text: text.slice(last) })
  for (const seg of segs) {
    if (seg.type === 'code') {
      out.push(<pre key={k++}>{seg.text}</pre>)
      continue
    }
    for (const para of seg.text.split(/\n{2,}/)) {
      if (!para.trim()) continue
      const lines = para.split('\n')
      let listRun: string[] = []
      let textRun: string[] = []
      const flush = () => {
        if (textRun.length) {
          const ls = textRun
          out.push(
            <p key={k++}>
              {ls.map((l, i) => (
                <span key={i}>
                  {i > 0 && <br />}
                  {inlineMd(l)}
                </span>
              ))}
            </p>,
          )
          textRun = []
        }
        if (listRun.length) {
          const items = listRun
          out.push(
            <ul key={k++}>
              {items.map((l, i) => (
                <li key={i}>{inlineMd(l)}</li>
              ))}
            </ul>,
          )
          listRun = []
        }
      }
      for (const l of lines) {
        if (l.startsWith('- ')) {
          if (textRun.length) flush()
          listRun.push(l.slice(2))
        } else {
          if (listRun.length) flush()
          textRun.push(l)
        }
      }
      flush()
    }
  }
  return <>{out}</>
}

function MsgView({ m, model }: { m: Msg; model?: string }) {
  if (m.role === 'user')
    return (
      <div className="msg user">
        <div className="bubble">
          {m.text.split('\n').map((l, i) => (
            <span key={i}>
              {i > 0 && <br />}
              {l}
            </span>
          ))}
        </div>
      </div>
    )
  return (
    <div className="msg">
      <div>
        <div className={cn('role', m.error && 'err')} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: m.error ? 'var(--bell)' : 'var(--terminalKind)', display: 'flex' }}>
            <Icon name={m.error ? 'alert' : 'acp'} size={12} />
          </span>
          <span>{m.error ? 'ERROR' : 'ASSISTANT'}</span>
          {!m.error && model && (
            <span style={{ color: 'var(--faint)', fontWeight: 400 }}>· {model}</span>
          )}
        </div>
        <div className="body" style={m.error ? { color: 'var(--bell)' } : undefined}>
          <MdLite text={m.text} />
        </div>
      </div>
    </div>
  )
}
