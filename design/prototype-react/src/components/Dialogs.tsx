import { useState, type ReactNode } from 'react'
import { useStore, searchThreads } from '@/store'
import { wsById, relTime, rowTitle, KIND_ICON } from '@/model'
import { seedSettings } from '@/seed'
import { Icon } from '@/icons'
import { Modal } from '@/components/ui/dialog'
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

/* ═══ 新建会话（工具选择 · Spotlight 命令面板风格）═══ */
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
          {rec && <span className="rec">推荐</span>}
        </span>
        {desc && <span className="ds">{desc}</span>}
      </span>
      {cmd && <span className="cmd">{cmd}</span>}
    </div>
  )

  const st = () => useStore.getState()

  return (
    <Modal open onClose={close} title="新建会话" width={520}>
      <ModalHead
        t="新建会话"
        extra={
          <button
            type="button"
            className="tb-cell tb-branch-btn"
            style={{ height: 24, padding: '0 9px', fontSize: 11, marginRight: 6 }}
            onClick={() => {
              close()
              useStore.setState(d => {
                d.ui.settingsSection = 'presets'
                d.ui.settingsWindowOpen = true
              })
            }}
          >
            <Icon name="gear" size={11.5} /> 管理预设
          </button>
        }
      />
      <div className="modal-body" style={{ paddingBottom: 0 }}>
        {/* 工作区胶囊切换条 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '6px 8px',
            background: 'var(--inputBg)',
            border: '1px solid var(--borderSubtle)',
            borderRadius: 8,
            marginBottom: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--muted)', marginRight: 4 }}>目标工作区:</span>
            {workspaces.map(w => {
              const active = toolWs === w.id
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => useStore.setState(d => void (d.ui.toolWs = w.id))}
                  style={{
                    height: 22,
                    padding: '0 8px',
                    borderRadius: 5,
                    fontSize: 11.5,
                    fontWeight: active ? 600 : 400,
                    background: active ? 'var(--accentSoft)' : 'transparent',
                    color: active ? 'var(--textBright)' : 'var(--muted)',
                    border: `1px solid ${active ? 'rgba(99,102,241,.45)' : 'transparent'}`,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    cursor: 'pointer',
                  }}
                >
                  <Icon name="folder" size={11} />
                  <span>{w.name}</span>
                </button>
              )
            })}
            {includeTemp && (
              <button
                type="button"
                onClick={() => useStore.setState(d => void (d.ui.toolWs = null))}
                style={{
                  height: 22,
                  padding: '0 8px',
                  borderRadius: 5,
                  fontSize: 11,
                  background: !toolWs ? 'var(--accentSoft)' : 'transparent',
                  color: !toolWs ? 'var(--textBright)' : 'var(--muted)',
                  cursor: 'pointer',
                }}
              >
                未归属
              </button>
            )}
          </div>
          <span
            style={{
              fontSize: 10.5,
              fontFamily: 'var(--font-mono)',
              color: 'var(--faint)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {ws?.path ?? '临时目录'}
          </span>
        </div>

        <div className="tool-filter">
          <Icon name="search" size={14} />
          <input
            autoFocus
            placeholder="过滤预设工具、ACP 代理或 Shell 命令…"
            value={toolFilter}
            onChange={e => useStore.setState(d => void (d.ui.toolFilter = e.target.value))}
          />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--faint)' }}>⌘N</span>
        </div>
        <div className="tool-list">
          {agentP.length > 0 && (
            <>
              <div className="glabel">AI 编程预设 ({agentP.length})</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6, padding: '2px 2px 4px' }}>
                {agentP.map(p => (
                  <div
                    className="tool-row"
                    key={p.id}
                    style={{
                      border: '1px solid var(--borderSubtle)',
                      background: 'rgba(24,28,39,.55)',
                      padding: '7px 9px',
                    }}
                    onClick={() => {
                      close()
                      st().spawnFromPreset(p.id, toolWs || undefined)
                    }}
                  >
                    <span className="ic agent">
                      <Icon name="agent" size={14} />
                    </span>
                    <span className="mid">
                      <span className="nm">
                        {p.label}
                        {p.id === 'pi' && <span className="rec">默认</span>}
                      </span>
                      {p.description && <span className="ds">{p.description}</span>}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          {termP.length > 0 ? (
            <>
              <div className="glabel">交互式终端与内置会话</div>
              {termP.map(p =>
                row(
                  'terminal',
                  '',
                  p.label,
                  p.description,
                  '/bin/zsh',
                  false,
                  () => {
                    close()
                    st().spawnFromPreset(p.id, toolWs || undefined)
                  },
                  p.id,
                ),
              )}
            </>
          ) : (
            f === '' && (
              <>
                <div className="glabel">基础终端（保底）</div>
                {row(
                  'terminal',
                  '',
                  'Shell（系统默认终端）',
                  '打开工作区目录下的交互式 Shell',
                  '/bin/zsh',
                  false,
                  () => {
                    close()
                    st().spawnFromPreset('shell', toolWs || undefined)
                  },
                  'fallback-shell',
                )}
              </>
            )
          )}
          {(ws || agentsV.length > 0) && <div className="glabel">对话与 ACP 协议代理</div>}
          {ws &&
            row('chat', 'chat', 'AI 对话面板 (In-App Chat)', '内置多轮对话与工具调用流视图', 'chat', false, () => {
              close()
              st().createChat(toolWs)
            }, 'new-chat')}
          {agentsV.map(a =>
            row(
              'acp',
              'acp',
              a.label,
              '经 JSON-RPC 2.0 over stdio 接入外部代理',
              `${a.command} ${a.args.join(' ')}`.trim(),
              false,
              () => {
                close()
                st().createAcp(a.id, a.label, toolWs)
              },
              a.id,
            ),
          )}
          {presets.length === 0 && (
            <div
              style={{
                margin: '10px 4px 4px',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px dashed var(--borderSubtle)',
                background: 'rgba(24,28,39,.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                预设工具已被清空
              </span>
              <button
                type="button"
                className="tb-cell tb-branch-btn"
                style={{ height: 24, padding: '0 9px', fontSize: 11 }}
                onClick={() => {
                  useStore.setState(d => {
                    d.settings.presets.items = seedSettings().presets.items
                  })
                  st().toast('已恢复 5 个默认预设')
                }}
              >
                <Icon name="reset" size={11} /> 恢复默认预设
              </button>
            </div>
          )}
          {!presetsV.length && !agentsV.length && f !== '' && (
            <div className="mhint">没有匹配工具。自定义命令可在设置的预设/ACP 分区添加。</div>
          )}
        </div>
        <div
          style={{
            marginTop: 8,
            padding: '8px 2px 10px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 11,
            color: 'var(--muted)',
          }}
        >
          <span>点击任一工具立即在「{ws?.name ?? '临时'}」下启动会话</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--faint)' }}>
            ↵ 启动 · Esc 关闭
          </span>
        </div>
      </div>
    </Modal>
  )
}

/* ═══ 搜索会话（Spotlight 命令面板风格，支持默认展示最近会话与关键词高亮）═══ */
function SearchDialog() {
  const s = useStore()
  const q = s.ui.searchQuery.trim()
  const results = q
    ? searchThreads(s, q)
    : s.threads.slice(0, 8).map(t => ({
        thread: t,
        workspace: t.workspaceId ? wsById(s.workspaces, t.workspaceId) ?? null : null,
      }))
  const cur = Math.min(s.ui.searchCursor, Math.max(results.length - 1, 0))

  const pick = (id: string) => {
    close()
    useStore.getState().activate({ type: 'thread', id })
  }

  return (
    <Modal open onClose={close} title="搜索" width={560} r20>
      <div className="search-in">
        <span style={{ color: 'var(--accentHover)', display: 'flex' }}>
          <Icon name="search" size={16} />
        </span>
        <input
          autoFocus
          placeholder="搜索会话标题、工作区目录、工具类型…"
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
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--muted)',
            background: 'var(--surface)',
            border: '1px solid var(--borderSubtle)',
            padding: '1px 6px',
            borderRadius: 4,
          }}
        >
          {q ? `${results.length} 匹配` : '最近活跃'}
        </span>
      </div>
      <div className="sr-list">
        <div style={{ padding: '4px 10px 6px', fontSize: 10.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {q ? `搜索结果 (${results.length})` : `最近与置顶会话 (${results.length})`}
        </div>
        {q !== '' && !results.length && (
          <div className="sr-none">没有匹配的会话。试试项目名或工具名。</div>
        )}
        {results.map(({ thread: t, workspace: ws }, i) => {
          const isExited = t.kind === 'terminal' && t.status === 'exited'
          return (
            <div
              key={t.id}
              className={cn('sr-row', i === cur && 'sel')}
              onClick={() => pick(t.id)}
            >
              <span
                className="ic"
                style={{
                  color: isExited
                    ? 'var(--faint)'
                    : t.kind === 'terminal'
                      ? 'var(--terminalKind)'
                      : t.kind === 'acp'
                        ? 'var(--acpKind)'
                        : 'var(--accentHover)',
                }}
              >
                <Icon name={KIND_ICON[t.kind]} size={15} />
              </span>
              <span className="t" style={{ color: isExited ? 'var(--muted)' : 'var(--textBright)', fontWeight: i === cur ? 600 : 450 }}>
                {rowTitle(t)}
              </span>
              {t.pin && (
                <span style={{ color: 'var(--faint)', display: 'flex' }}>
                  <Icon name="pin" size={11} />
                </span>
              )}
              {t.pendingReply && (
                <span style={{ fontSize: 10, padding: '0 6px', borderRadius: 4, background: 'rgba(251,191,36,.15)', color: 'var(--statusRunning)' }}>
                  思考中
                </span>
              )}
              {t.hasBell && (
                <span style={{ fontSize: 10, padding: '0 6px', borderRadius: 4, background: 'rgba(192,132,252,.15)', color: 'var(--acpKind)' }}>
                  🔔 BEL
                </span>
              )}
              {isExited && (
                <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--faint)' }}>
                  [已退出]
                </span>
              )}
              <span
                className="w"
                style={{
                  background: 'var(--inputBg)',
                  border: '1px solid var(--border)',
                  padding: '1px 7px',
                  borderRadius: 4,
                }}
              >
                {ws?.name ?? '未归属'}
              </span>
              <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--faint)' }}>
                {relTime(t.createdAt)}
              </span>
            </div>
          )
        })}
      </div>
      <div
        style={{
          padding: '8px 14px',
          borderTop: '1px solid var(--border)',
          background: 'rgba(13,15,21,.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 11,
          color: 'var(--muted)',
        }}
      >
        <span>支持按会话名称、工作区、预设工具或目录检索</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--faint)' }}>
          ↑↓ 选择 · ↵ 激活跳转 · Esc 关闭
        </span>
      </div>
    </Modal>
  )
}

/* ═══ 添加工作区（路径输入 + 浏览联体按钮 + 名称自动推导预览）═══ */
function WorkspaceDialog() {
  const [path, setPath] = useState('~/Projects/jagent-cloud')
  const [name, setName] = useState('')
  const derivedName = name.trim() || (path.trim() ? path.trim().replace(/\/+$/, '').split('/').pop() || 'workspace' : 'my-project')

  const ok = () => {
    const p = path.trim()
    if (!p) {
      useStore.getState().toast('请填写项目目录路径')
      return
    }
    const id = `ws${Date.now()}`
    useStore.setState(d => {
      d.workspaces.push({
        id, name: derivedName, path: p, expanded: true, createdAt: Date.now(), paneTab: 'home',
      })
      d.ui.dialog = { kind: 'none' }
    })
    useStore.getState().activate({ type: 'workspace', id })
  }
  return (
    <Modal open onClose={close} title="添加工作区" width={460}>
      <ModalHead t="添加工作区" />
      <div className="modal-body">
        <div className="mlabel">项目目录路径</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="txt-in mono"
            style={{ flex: 1 }}
            autoFocus
            placeholder="~/Projects/my-app"
            value={path}
            onChange={e => setPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && ok()}
          />
          <button
            type="button"
            className="mbtn"
            onClick={() => {
              setPath('~/Projects/' + (name.trim() || 'next-agent'))
              useStore.getState().toast('目录选择器（原型：已填入示例路径）')
            }}
          >
            <Icon name="folder" size={12} /> 浏览…
          </button>
        </div>

        {/* 常用路径快速填入胶囊 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10.5, color: 'var(--faint)' }}>快速选择:</span>
          {['~/Projects/jagent-cloud', '~/Documents/gpui-kit', '~/Work/ rust-workspace'].map(sample => (
            <button
              key={sample}
              type="button"
              onClick={() => setPath(sample.replace(/\s+/g, ''))}
              style={{
                fontSize: 10.5,
                fontFamily: 'var(--font-mono)',
                padding: '2px 7px',
                borderRadius: 4,
                background: 'var(--inputBg)',
                border: '1px solid var(--borderSubtle)',
                color: 'var(--muted)',
                cursor: 'pointer',
              }}
            >
              {sample.replace(/\s+/g, '')}
            </button>
          ))}
        </div>

        <div className="mlabel" style={{ marginTop: 14 }}>
          自定义显示名称（留空则自动使用目录名）
        </div>
        <input
          className="txt-in"
          style={{ width: '100%' }}
          placeholder={derivedName}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && ok()}
        />

        {/* 名称自动推导与 Git 状态实时预览卡 */}
        <div
          style={{
            marginTop: 12,
            padding: '10px 12px',
            borderRadius: 8,
            background: 'var(--inputBg)',
            border: '1px solid var(--borderSubtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ color: 'var(--accentHover)', display: 'flex' }}>
              <Icon name="folder" size={14} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--textBright)' }}>
                {derivedName}
              </div>
              <div style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {path.trim() || '未指定路径'}
              </div>
            </div>
          </div>
          <span
            style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              padding: '2px 7px',
              borderRadius: 999,
              background: 'rgba(52,211,153,.14)',
              color: 'var(--statusDone)',
              border: '1px solid rgba(52,211,153,.3)',
              flexShrink: 0,
            }}
          >
            ● Git 仓库就绪
          </span>
        </div>

        <div className="modal-actions" style={{ marginTop: 6 }}>
          <button type="button" className="mbtn" onClick={close}>
            取消
          </button>
          <button type="button" className="mbtn primary" onClick={ok}>
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
