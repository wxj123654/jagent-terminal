import { useEffect, useRef, type ReactNode } from 'react'
import { useStore } from '@/store'
import { presetIcon } from '@/model'
import { PREVIEWS } from '@/seed'
import { Icon } from '@/icons'
import { cn } from '@/lib/utils'
import type { Msg, SessionView, Thread, Workspace } from '@/types'
import { GitGraphView } from './GitGraphView'

/* ═══ Home 空态 ═══ */
export function HomePane() {
  const workspaces = useStore(s => s.workspaces)
  const presets = useStore(s => s.settings.presets.items)
  const first = workspaces[0]
  return (
    <div className="home">
      <div className="home-card">
        <div className="home-mark"><Icon name="agent" size={20} /></div>
        <div className="home-kicker">J-AGENT WORKSPACE</div>
        <h1>想做点什么？</h1>
        <div className="sub">从左侧选择工作区，或直接开始一个新任务</div>
        <div className="ctx">
          <Icon name="folder" size={14} />
          <span className="p">{first?.path ?? '未归属 · 无项目目录'}</span>
        </div>
        <div className="home-section-head">
          <span>快速开始</span>
          <span>{presets.length} 个工具</span>
        </div>
        <div className="pills">
          {presets.map(p => (
            <button
              type="button"
              className="pill"
              key={p.id}
              onClick={() => useStore.getState().spawnFromPreset(p.id, workspaces[0]?.id)}
            >
              <span className="pill-icon"><Icon name={presetIcon(p)} size={14} /></span>
              <span className="t">{p.label}</span>
              <Icon name="arrowRight" size={12} />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ═══ 工作区页：paneTab==='git' 整页 Git 图，否则起始页 ═══ */
export function WorkspacePage({ ws }: { ws: Workspace }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {ws.paneTab === 'git' ? <GitGraphView ws={ws} /> : <WorkspaceEmpty ws={ws} />}
    </div>
  )
}

function WorkspaceEmpty({ ws }: { ws: Workspace }) {
  const presets = useStore(s => s.settings.presets.items)
  const pi = presets.find(p => p.id === 'pi')
  const rest = presets.filter(p => p.id !== 'pi')
  return (
    <div className="home">
      <div className="home-card">
        <div className="home-mark workspace"><Icon name="folder" size={20} /></div>
        <div className="home-kicker">WORKSPACE</div>
        <h1>{ws.name}</h1>
        <div className="sub">这个工作区还没有会话，选一个工具开始</div>
        <div className="ctx">
          <Icon name="folder" size={14} />
          <span className="p">{ws.path}</span>
        </div>
        <div className="home-section-head">
          <span>启动会话</span>
          <span>在当前工作区运行</span>
        </div>
        <div className="pills">
          {pi && (
            <button type="button" className="pill featured" onClick={() => useStore.getState().spawnFromPreset(pi.id, ws.id)}>
              <span className="pill-icon"><Icon name={presetIcon(pi)} size={14} /></span>
              <span className="t">{pi.label}</span>
              <Icon name="arrowRight" size={12} />
            </button>
          )}
          {rest.map(p => (
            <button type="button" className="pill" key={p.id} onClick={() => useStore.getState().spawnFromPreset(p.id, ws.id)}>
              <span className="pill-icon"><Icon name={presetIcon(p)} size={14} /></span>
              <span className="t">{p.label}</span>
              <Icon name="arrowRight" size={12} />
            </button>
          ))}
          <button type="button" className="pill" onClick={() => useStore.getState().openToolDialog(ws.id)}>
            <span className="pill-icon"><Icon name="more" size={14} /></span>
            <span className="t">选择其他工具</span>
            <Icon name="arrowRight" size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}

/* ═══ 终端表面（TerminalSurface 替身：行数据存 store，切走 retain）═══ */
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
    if (st.ui.dialog.kind === 'none' && !inputBusy) ref.current?.focus()
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
    </div>
  )
}

export function FileSurface({ path }: { path: string }) {
  const code = PREVIEWS[path] ?? `// ${path}\n// （原型预览占位）`
  return (
    <div className="file-surface">
      <div className="file-pathbar">
        <Icon name="file" size={12} />
        <span className="p">{path}</span>
      </div>
      <div className="code-view">
        {code.split('\n').map((l, i) => (
          <div className="cl" key={i}>
            <span className="ln-no">{i + 1}</span>
            <span>{l || ' '}</span>
          </div>
        ))}
      </div>
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

  useEffect(() => {
    const st = useStore.getState()
    const ae = document.activeElement
    const inputBusy = /INPUT|TEXTAREA|SELECT/.test(ae?.tagName ?? '')
    if (st.ui.dialog.kind === 'none' && !inputBusy) ref.current?.focus()
  }, [view.id])

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
    </div>
  )
}

/* ═══ 会话表面（ConversationView：chat/acp）═══ */
export function ConversationView({ t }: { t: Thread }) {
  const ph = t.kind === 'acp' ? 'Ask agent…' : 'Ask…'
  const listRef = useRef<HTMLDivElement>(null)
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
      <div className="conv-head">
        <span className="conv-avatar"><Icon name={t.kind === 'acp' ? 'acp' : 'agent'} size={14} /></span>
        <span className="conv-title">{t.title}</span>
        <span className="conv-status"><span className="dot done" />{t.pendingReply ? '正在回复' : '已连接'}</span>
      </div>
      <div className="conv-msgs" ref={listRef}>
        <div className="conv-msgs-in">
          {(t.messages ?? []).map(m => <MsgView key={m.id} m={m} />)}
          {t.pendingReply && <div className="thinking"><span className="thinking-dot" />正在思考…</div>}
        </div>
      </div>
      <div className="composer">
        <div className="composer-shell">
          <textarea
            placeholder={ph}
            rows={1}
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
            <Icon name="arrowRight" size={15} />
          </button>
        </div>
        <div className="composer-hint">Enter 发送 · Shift + Enter 换行</div>
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

function MsgView({ m }: { m: Msg }) {
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
        <div className={cn('role', m.error && 'err')}>{m.error ? 'ERROR' : 'ASSISTANT'}</div>
        <div className="body" style={m.error ? { color: 'var(--bell)' } : undefined}>
          <MdLite text={m.text} />
        </div>
      </div>
    </div>
  )
}
