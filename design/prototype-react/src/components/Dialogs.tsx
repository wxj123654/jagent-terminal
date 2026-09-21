import { useState, type ReactNode } from 'react'
import { useStore, searchThreads } from '@/store'
import { wsById, relTime, rowTitle, KIND_ICON } from '@/model'
import { Icon } from '@/icons'
import { Modal } from '@/components/ui/dialog'
import { Sel } from '@/components/ui/select'
import { cn } from '@/lib/utils'

export function DialogHost() {
  const dialog = useStore(s => s.ui.dialog)
  switch (dialog.kind) {
    case 'tool':
      return <ToolDialog />
    case 'search':
      return <SearchDialog />
    case 'addWorkspace':
      return <WorkspaceDialog />
    case 'rename':
      return <RenameDialog target={dialog.target} />
    case 'errors':
      return <ErrorDialog />
    case 'crash':
      return <CrashDialog />
    default:
      return null
  }
}

const close = () => useStore.getState().closeDialog()

function ModalHead({ t, extra }: { t: string; extra?: ReactNode }) {
  return (
    <div className="modal-head">
      <span className="t">{t}</span>
      {extra}
      <div className="modal-x" onClick={close}>
        <Icon name="close" size={16} />
      </div>
    </div>
  )
}

/* ═══ 新建会话（工具选择）═══ */
function ToolDialog() {
  const workspaces = useStore(s => s.workspaces)
  const toolWs = useStore(s => s.ui.toolWs)
  const toolFilter = useStore(s => s.ui.toolFilter)
  const includeTemp = useStore(s => s.ui.toolWsIncludeTemp)
  const presets = useStore(s => s.settings.presets.items)
  const agents = useStore(s => s.settings.acpAgents)

  const f = toolFilter.trim().toLowerCase()
  const hit = (...xs: (string | undefined)[]) =>
    f === '' || xs.some(x => x?.toLowerCase().includes(f))
  const presetsV = presets.filter(p => hit(p.label, p.program, p.initCommand, ...(p.args ?? [])))
  const agentsV = agents.filter(a => hit(a.label, a.command, ...a.args))
  const agentP = presetsV.filter(p => p.id !== 'shell')
  const termP = presetsV.filter(p => p.id === 'shell')
  const ws = toolWs ? wsById(workspaces, toolWs) : null

  const row = (
    ic: string,
    icCls: string,
    name: string,
    desc: string | undefined,
    cmd: string,
    rec: boolean,
    onPick: () => void,
    key?: string,
  ) => (
    <div className="tool-row" key={key} onClick={onPick}>
      <span className={`ic ${icCls}`}>
        <Icon name={ic} size={14} />
      </span>
      <span className="mid">
        <span className="nm">
          {name}
          {rec && <span className="rec">默认</span>}
        </span>
        {desc && <span className="ds">{desc}</span>}
      </span>
      {cmd && <span className="cmd">{cmd}</span>}
    </div>
  )

  const st = () => useStore.getState()

  return (
    <Modal open onClose={close} title="新建会话" width={440}>
      <ModalHead t="新建会话" />
      <div className="modal-body">
        <div className="tool-ctx">
          <span className="k">工作区</span>
          <span className="sel-wrap">
            <Sel
              value={toolWs ?? ''}
              options={[
                ...(includeTemp ? [{ value: '', label: '（未归属 · 临时会话）' }] : []),
                ...workspaces.map(w => ({ value: w.id, label: w.name })),
              ]}
              onChange={v => useStore.setState(d => void (d.ui.toolWs = v || null))}
            />
          </span>
          <span className="cwd">{ws?.path ?? '（无项目目录）'}</span>
        </div>
        <div className="tool-filter">
          <Icon name="search" size={14} />
          <input
            autoFocus
            placeholder="搜索工具…"
            value={toolFilter}
            onChange={e => useStore.setState(d => void (d.ui.toolFilter = e.target.value))}
          />
        </div>
        <div className="tool-list">
          {agentP.length > 0 && <div className="glabel">AI 编程</div>}
          {agentP.map(p =>
            row(
              'agent',
              'agent',
              p.label,
              p.description,
              [p.program, ...(p.args ?? [])].filter(Boolean).join(' ') || p.initCommand || '',
              p.id === 'pi',
              () => {
                close()
                st().spawnFromPreset(p.id, toolWs || undefined)
              },
              p.id,
            ),
          )}
          {termP.length > 0 && <div className="glabel">终端工具</div>}
          {termP.map(p =>
            row(
              'terminal',
              '',
              p.label,
              p.description,
              [p.program, ...(p.args ?? [])].filter(Boolean).join(' ') || p.initCommand || '',
              false,
              () => {
                close()
                st().spawnFromPreset(p.id, toolWs || undefined)
              },
              p.id,
            ),
          )}
          {(ws || agentsV.length > 0) && <div className="glabel">对话</div>}
          {ws &&
            row('chat', 'chat', 'New Chat', '应用内对话面（非终端）', '', false, () => {
              close()
              st().createChat(toolWs)
            }, 'new-chat')}
          {agentsV.map(a =>
            row(
              'acp',
              'acp',
              a.label,
              'ACP agent',
              `${a.command} ${a.args.join(' ')}`.trim(),
              false,
              () => {
                close()
                st().createAcp(a.id, a.label, toolWs)
              },
              a.id,
            ),
          )}
          {!presetsV.length && !agentsV.length && (
            <div className="mhint">没有匹配工具。自定义命令可在设置的 ACP 分区添加。</div>
          )}
        </div>
        <div className="mhint">选一项即创建会话，Esc 取消</div>
      </div>
    </Modal>
  )
}

/* ═══ 搜索会话 ═══ */
function SearchDialog() {
  const s = useStore()
  const q = s.ui.searchQuery.trim()
  const results = q ? searchThreads(s, q) : []
  const cur = Math.min(s.ui.searchCursor, Math.max(results.length - 1, 0))

  const pick = (id: string) => {
    close()
    useStore.getState().activate({ type: 'thread', id })
  }

  return (
    <Modal open onClose={close} title="搜索" width={560} r20>
      <div className="search-in">
        <Icon name="search" size={16} />
        <input
          autoFocus
          placeholder="搜索会话、工作区、命令…"
          value={s.ui.searchQuery}
          onChange={e =>
            useStore.setState(d => {
              d.ui.searchQuery = e.target.value
              d.ui.searchCursor = 0
            })
          }
          onKeyDown={e => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              useStore.setState(d => void d.ui.searchCursor++)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              useStore.setState(d => void (d.ui.searchCursor = Math.max(0, d.ui.searchCursor - 1)))
            } else if (e.key === 'Enter') {
              const hit = results[Math.min(cur, results.length - 1)]
              if (hit) pick(hit.thread.id)
            } else if (e.key === 'Escape' && (e.target as HTMLInputElement).value) {
              e.stopPropagation()
              useStore.setState(d => void (d.ui.searchQuery = ''))
            }
          }}
        />
      </div>
      <div className="sr-list">
        {q !== '' && !results.length && (
          <div className="sr-none">没有匹配的会话。试试项目名或工具名。</div>
        )}
        {results.map(({ thread: t, workspace: ws }, i) => (
          <div
            key={t.id}
            className={cn('sr-row', i === cur && 'sel')}
            onClick={() => pick(t.id)}
          >
            <span className="ic">
              <Icon name={KIND_ICON[t.kind]} size={16} />
            </span>
            <span className="t">{rowTitle(t)}</span>
            <span className="w">{ws?.name ?? ''}</span>
          </div>
        ))}
      </div>
    </Modal>
  )
}

/* ═══ 添加工作区 ═══ */
function WorkspaceDialog() {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const ok = () => {
    const p = path.trim()
    const n = name.trim() || (p ? p.split('/').pop() : '')
    if (!p) {
      useStore.getState().toast('请填写目录')
      return
    }
    const id = `ws${Date.now()}`
    useStore.setState(d => {
      d.workspaces.push({
        id, name: n || 'workspace', path: p, expanded: true, createdAt: Date.now(), paneTab: 'home',
      })
      d.ui.dialog = { kind: 'none' }
    })
    useStore.getState().activate({ type: 'workspace', id })
  }
  return (
    <Modal open onClose={close} title="添加工作区" width={440}>
      <ModalHead t="添加工作区" />
      <div className="modal-body">
        <div className="mlabel">工作区名称（空 = 目录名）</div>
        <input
          className="txt-in"
          style={{ width: '100%' }}
          autoFocus
          placeholder="my-project"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <div className="mlabel" style={{ marginTop: 12 }}>
          目录
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="txt-in mono"
            style={{ flex: 1 }}
            placeholder="/Users/you/project"
            value={path}
            onChange={e => setPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && ok()}
          />
          <span
            className="mbtn"
            onClick={() => {
              setPath('D:/projects/' + (name || 'new-project'))
              useStore.getState().toast('目录选择器（原型：已填入示例路径）')
            }}
          >
            <Icon name="folder" size={12} /> 浏览…
          </span>
        </div>
        <div className="modal-actions">
          <button className="mbtn" onClick={close}>
            取消
          </button>
          <button className="mbtn primary" onClick={ok}>
            添加工作区
          </button>
        </div>
      </div>
    </Modal>
  )
}

/* ═══ 重命名 ═══ */
function RenameDialog({ target }: { target: { type: 'thread' | 'workspace'; id: string } }) {
  const s = useStore.getState()
  const t0 =
    target.type === 'thread'
      ? s.threads.find(t => t.id === target.id)
      : undefined
  const w0 = target.type === 'workspace' ? wsById(s.workspaces, target.id) : undefined
  const cur = t0 ? rowTitle(t0) : (w0?.name ?? '')
  const [v, setV] = useState(cur)
  const ok = () => {
    useStore.setState(d => {
      if (target.type === 'thread') {
        const t = d.threads.find(x => x.id === target.id)
        if (t) {
          if (t.kind === 'terminal') t.customTitle = v
          else t.title = v
        }
      } else {
        const w = wsById(d.workspaces, target.id)
        if (w) w.name = v
      }
      d.ui.dialog = { kind: 'none' }
    })
  }
  return (
    <Modal open onClose={close} title="重命名" width={320}>
      <ModalHead t="重命名" />
      <div className="modal-body">
        <div className="mlabel">名称</div>
        <input
          className="txt-in"
          style={{ width: '100%' }}
          autoFocus
          value={v}
          onChange={e => setV(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && ok()}
        />
        <div className="modal-actions">
          <button className="mbtn" onClick={close}>
            取消
          </button>
          <button className="mbtn primary" onClick={ok}>
            重命名
          </button>
        </div>
      </div>
    </Modal>
  )
}

/* ═══ 错误历史 ═══ */
function ErrorDialog() {
  const errors = useStore(s => s.errors)
  const LV = { error: 'var(--statusError)', warn: 'var(--statusRunning)', info: 'var(--accent)' }
  return (
    <Modal
      open
      onClose={close}
      title="错误历史"
      width={520}
    >
      <ModalHead
        t="错误历史"
        extra={
          errors.length ? (
            <span
              className="mini-btn"
              onClick={() => useStore.setState(d => void (d.errors = []))}
            >
              <Icon name="trash" size={12} /> 清空
            </span>
          ) : undefined
        }
      />
      <div className="modal-body" style={{ height: 340 }}>
        {!errors.length ? (
          <div className="st-empty" style={{ padding: 28, textAlign: 'center' }}>
            没有记录的错误。
          </div>
        ) : (
          [...errors].reverse().map((e, i) => (
            <div className="err-item" key={i}>
              <span className="lv" style={{ color: LV[e.level] }}>
                {e.level.toUpperCase()}
              </span>
              <span className="msg">
                {e.message}
                <div style={{ fontSize: 10, color: 'var(--faint)', marginTop: 2 }}>{e.area}</div>
              </span>
              <span className="tm">{relTime(e.at)}</span>
            </div>
          ))
        )}
      </div>
    </Modal>
  )
}

/* ═══ 崩溃残留提示 ═══ */
function CrashDialog() {
  return (
    <Modal open onClose={close} title="上次会话异常退出" width={480}>
      <ModalHead t="上次会话异常退出" />
      <div className="modal-body" style={{ height: 200 }}>
        <div style={{ fontSize: 12, color: 'var(--textBright)', marginBottom: 8 }}>
          j-agent 上次运行时发生了异常退出（panic）。
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          崩溃报告已写入本地目录，可提交 issue 时附上：
        </div>
        <div className="crash-path">
          %APPDATA%\j-agent\crash\crash-2026-09-13.json
          <br />
          %APPDATA%\j-agent\crash\minidump.dmp
        </div>
        <div className="modal-actions">
          <button
            className="mbtn"
            onClick={() => useStore.getState().toast('已在系统文件管理器打开（原型占位）')}
          >
            打开目录
          </button>
          <button className="mbtn primary" onClick={close}>
            知道了
          </button>
        </div>
      </div>
    </Modal>
  )
}
