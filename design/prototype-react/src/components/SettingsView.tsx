import type { ReactNode } from 'react'
import { useStore } from '@/store'
import {
  SECTIONS, SETTING_DEFS, DEFAULTS, KEY_ACTIONS, FIXED_KEYS, CONVENTIONS,
  type SettingDef,
} from '@/seed'
import {
  getPath, setPath, isModified, matchDef, sectionHits, fontItems, presetCmdSummary,
} from '@/model'
import { Icon } from '@/icons'
import { Sel } from '@/components/ui/select'
import { Toggle, RangeSlider } from '@/components/ui/controls'
import { Pop } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Preset, AcpAgent } from '@/types'

const SECTION_ICONS: Record<string, string> = {
  presets: 'agent',
  notifications: 'bell',
  terminal: 'terminal',
  appearance: 'edit',
  keybindings: 'tag',
  acp: 'acp',
  advanced: 'gear',
}

function hl(text: string, q: string | null): ReactNode {
  if (!q) return text
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}

export function SettingsView() {
  const sec = useStore(s => s.ui.settingsSection)
  const query = useStore(s => s.ui.settingsQuery)
  const settings = useStore(s => s.settings)
  const q = query.trim()
  const hits = sectionHits(settings, q)
  const searching = q !== ''

  return (
    <div className="settings">
      <div className="st-nav">
        <div className="st-nav-brand">
          <span className="st-nav-mark"><Icon name="gear" size={15} /></span>
          <span><strong>设置</strong><small>偏好与工具</small></span>
        </div>
        <label className="st-search">
          <Icon name="search" size={13} />
          <input
            role="searchbox"
            aria-label="搜索设置"
            placeholder="搜索设置…"
            value={query}
            onChange={e => useStore.setState(d => void (d.ui.settingsQuery = e.target.value))}
            data-settings-search
          />
          <kbd>/</kbd>
        </label>
        <div className="st-nav-list" role="tablist" aria-orientation="vertical">
          {SECTIONS.map(item => (
            <button
              type="button"
              role="tab"
              aria-selected={!searching && sec === item.id}
              key={item.id}
              className={cn('st-nav-item', !searching && sec === item.id && 'active')}
              onClick={() => useStore.setState(d => void (d.ui.settingsSection = item.id))}
            >
              <Icon name={SECTION_ICONS[item.id]} size={14} />
              <span>{item.label}</span>
              {hits[item.id] ? <span className="hit">{hits[item.id]}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div className="st-content">
        <div className="st-content-in">
          {searching ? <SearchAll q={q} /> : <Section sec={sec} />}
        </div>
      </div>
    </div>
  )
}

function sectionHasContent(sec: string, q: string, settings: ReturnType<typeof useStore.getState>['settings']) {
  const kl = q.toLowerCase()
  if (sec === 'presets' || sec === 'acp') return true
  if (sec === 'keybindings') {
    const rows = KEY_ACTIONS.filter(
      a => a.label.toLowerCase().includes(kl) || settings.keybindings[a.action]?.includes(kl),
    )
    const fixed = FIXED_KEYS.filter(
      ([l, k]) => l.toLowerCase().includes(kl) || k.toLowerCase().includes(kl),
    )
    return rows.length + fixed.length > 0
  }
  const defs = SETTING_DEFS.filter(d => d.section === sec && matchDef(d, q))
  if (defs.length) return true
  if (
    sec === 'notifications' &&
    ('cli bel osc 约定'.includes(kl) ||
      CONVENTIONS.some(c => (c[0] + c[1]).toLowerCase().includes(kl)))
  )
    return true
  return false
}

function SearchAll({ q }: { q: string }) {
  const settings = useStore(s => s.settings)
  const visible = SECTIONS.filter(s => sectionHasContent(s.id, q, settings))
  if (!visible.length)
    return (
      <div className="st-empty-card">
        <Icon name="search" size={18} />
        <div className="st-empty">没有匹配「{q}」的设置。</div>
        <button type="button" className="st-clear" onClick={() => useStore.setState(d => void (d.ui.settingsQuery = ''))}>
          清除搜索
        </button>
      </div>
    )
  return (
    <>
      <div className="st-page-head">
        <div>
          <div className="st-h">搜索结果</div>
          <div className="st-page-sub">找到 {visible.length} 个相关分区</div>
        </div>
      </div>
      {visible.map(s => (
        <div className="st-search-section" key={s.id}>
          <div className="st-h">{s.label}</div>
          <div className="st-card"><SectionBody sec={s.id} q={q} /></div>
        </div>
      ))}
    </>
  )
}

function Section({ sec }: { sec: string }) {
  const s = SECTIONS.find(x => x.id === sec)
  return (
    <>
      <div className="st-page-head">
        <div>
          <div className="st-h">{s?.label ?? ''}</div>
          <div className="st-page-sub">更改会立即应用，并自动保存到本地设置。</div>
        </div>
        <span className="st-live"><span className="dot done" />即时生效</span>
      </div>
      <div className="st-card"><SectionBody sec={sec} q={null} /></div>
    </>
  )
}

function SectionBody({ sec, q }: { sec: string; q: string | null }) {
  if (sec === 'presets') return <PresetsSection q={q} />
  if (sec === 'keybindings') return <KbSection q={q} />
  if (sec === 'acp') return <AcpSection q={q} />
  const defs = SETTING_DEFS.filter(d => d.section === sec && (!q || matchDef(d, q)))
  if (!defs.length && sec !== 'notifications') return null
  return (
    <>
      {defs.map(d => (
        <SettingRow key={d.path} d={d} q={q} />
      ))}
      {sec === 'notifications' &&
        (!q ||
          'cli bel osc 约定'.includes(q.toLowerCase()) ||
          CONVENTIONS.some(c => (c[0] + c[1]).toLowerCase().includes(q.toLowerCase()))) && (
          <div className="conv-card">
            <div className="h">
              CLI 侧 BEL / OSC 约定（j-agent 只信任这两个信号；到各自 CLI 侧配置，此处不代管）
            </div>
            {CONVENTIONS.map(([n, d]) => (
              <div className="r" key={n}>
                <span className="n">{n}</span>
                <span className="d">{d}</span>
              </div>
            ))}
          </div>
        )}
    </>
  )
}

function SettingRow({ d, q }: { d: SettingDef; q: string | null }) {
  const settings = useStore(s => s.settings)
  const v = getPath(settings, d.path)
  const mod = isModified(settings, d.path)
  return (
    <div className="srow">
      <div className="lcol">
        <div className="lrow">
          {mod && <span className="moddot" />}
          <span className="lbl">{hl(d.label, q)}</span>
          <span
            className={cn('reset', mod && 'vis')}
            title={`恢复默认：${d.label}`}
            onClick={() =>
              useStore.setState(x => void setPath(x.settings, d.path, DEFAULTS[d.path]))
            }
          >
            <Icon name="reset" size={12} />
          </span>
        </div>
        <div className="desc">{hl(d.desc, q)}</div>
      </div>
      <div className="ctl">
        <Control d={d} v={v} />
      </div>
    </div>
  )
}

function Control({ d, v }: { d: SettingDef; v: unknown }) {
  if (d.type === 'toggle')
    return (
      <Toggle
        checked={!!v}
        onChange={nv => useStore.setState(x => void setPath(x.settings, d.path, nv))}
      />
    )
  if (d.type === 'select')
    return (
      <span className="sel-wrap">
        <Sel
          value={String(v)}
          options={d.options ?? []}
          onChange={nv => useStore.setState(x => void setPath(x.settings, d.path, nv))}
        />
      </span>
    )
  if (d.type === 'number')
    return (
      <input
        className="num-in"
        type="number"
        min={d.min}
        max={d.max}
        step={d.step}
        value={Number(v)}
        onChange={e => useStore.setState(x => void setPath(x.settings, d.path, Number(e.target.value)))}
      />
    )
  if (d.type === 'range')
    return (
      <span className="range-wrap">
        <RangeSlider
          value={Number(v)}
          min={d.min!}
          max={d.max!}
          step={d.step!}
          onChange={nv => useStore.setState(x => void setPath(x.settings, d.path, nv))}
        />
        <span className="range-val">{Number(v)}px</span>
      </span>
    )
  if (d.type === 'font') return <FontControl path={d.path} v={String(v)} />
  return (
    <input
      className={cn('txt-in', d.mono && 'mono')}
      type="text"
      value={String(v)}
      onChange={e => useStore.setState(x => void setPath(x.settings, d.path, e.target.value))}
    />
  )
}

/* ── 字体选择器（FontSelect 原型：搜索 + 字身预览 + 自由输入）── */
function FontControl({ path, v }: { path: string; v: string }) {
  const picker = useStore(s => s.ui.fontPicker)
  const open = picker?.path === path
  const items = open ? fontItems(useStore.getState().settings, path, picker.q) : []
  const cur = v

  const commit = (name?: string) => {
    if (!name) return
    useStore.setState(d => {
      setPath(d.settings, path, name)
      d.ui.fontPicker = null
    })
  }

  return (
    <Pop
      open={open}
      onOpenChange={o =>
        useStore.setState(d => void (d.ui.fontPicker = o ? { path, q: '', hi: 0 } : null))
      }
      className="font-pop"
      sideOffset={4}
      onOpenAutoFocus={e => e.preventDefault()}
      anchor={
        <span
          className="font-trig"
          onClick={() =>
            useStore.setState(d => {
              d.ui.fontPicker = open ? null : { path, q: '', hi: 0 }
            })
          }
        >
          <span className="fv">{v}</span>
          <span className="chev">
            <Icon name="chevronDown" size={12} />
          </span>
        </span>
      }
    >
      <div className="font-search">
        <Icon name="search" size={12} />
        <input
          autoFocus
          placeholder="搜索字体…"
          value={picker?.q ?? ''}
          onChange={e =>
            useStore.setState(d => {
              if (d.ui.fontPicker) {
                d.ui.fontPicker.q = e.target.value
                d.ui.fontPicker.hi = 0
              }
            })
          }
          onKeyDown={e => {
            const p = useStore.getState().ui.fontPicker
            if (!p) return
            const len = items.length
            if (e.key === 'ArrowDown' && len) {
              useStore.setState(d => void (d.ui.fontPicker!.hi = (p.hi + 1) % len))
              e.preventDefault()
            } else if (e.key === 'ArrowUp' && len) {
              useStore.setState(d => void (d.ui.fontPicker!.hi = (p.hi - 1 + len) % len))
              e.preventDefault()
            } else if (e.key === 'Enter' && len) {
              commit(items[p.hi]?.name)
              e.preventDefault()
            } else if (e.key === 'Escape') {
              e.stopPropagation()
              useStore.setState(d => void (d.ui.fontPicker = null))
            }
          }}
        />
      </div>
      <div className="font-list">
        {items.map((it, i) => (
          <div
            key={it.name + i}
            className={cn('font-row', i === picker?.hi && 'hi', it.name === cur && 'sel', it.free && 'free')}
            onClick={() => commit(it.name)}
          >
            <span className="ck">{it.name === cur && <Icon name="check" size={12} />}</span>
            <span
              className="nm"
              style={it.free ? undefined : { fontFamily: `'${it.name.replace(/'/g, '')}'` }}
            >
              {it.free ? `使用 "${it.name}"` : it.name}
            </span>
          </div>
        ))}
      </div>
    </Pop>
  )
}

/* ── 键位分区 ── */
function KbSection({ q }: { q: string | null }) {
  const settings = useStore(s => s.settings)
  const capturing = useStore(s => s.ui.kbCapturing)
  const kl = q?.toLowerCase() ?? null
  const rows = KEY_ACTIONS.filter(
    a => !kl || a.label.toLowerCase().includes(kl) || settings.keybindings[a.action]?.includes(kl),
  )
  const fixed = FIXED_KEYS.filter(
    ([l, k]) => !kl || l.toLowerCase().includes(kl) || k.toLowerCase().includes(kl),
  )
  if (!rows.length && !fixed.length) return null
  return (
    <>
      {rows.map(a => {
        const cur = settings.keybindings[a.action]
        const conflict = KEY_ACTIONS.find(
          o => o.action !== a.action && settings.keybindings[o.action] === cur,
        )
        const mod = isModified(settings, 'keybindings.' + a.action)
        const cap = capturing === a.action
        return (
          <div key={a.action}>
            <div className="kb-row">
              <span className="lbl">
                {hl(a.label, q)}
                {mod && (
                  <span className="moddot" style={{ display: 'inline-block', verticalAlign: 'middle' }} />
                )}
              </span>
              {mod && (
                <span
                  className="mini-btn"
                  onClick={() =>
                    useStore.setState(x =>
                      void setPath(x.settings, 'keybindings.' + a.action, DEFAULTS['keybindings.' + a.action]),
                    )
                  }
                >
                  <Icon name="reset" size={12} /> 恢复
                </span>
              )}
              <span
                className={cn('kb-cap', cap && 'capturing')}
                onClick={() => useStore.setState(d => void (d.ui.kbCapturing = a.action))}
              >
                {cap ? '按下新组合…' : cur}
              </span>
            </div>
            {conflict && (
              <div className="kb-conflict">
                ⚠ 与「{conflict.label}」冲突（同绑 {cur}）
              </div>
            )}
          </div>
        )
      })}
      {fixed.map(([l, k]) => (
        <div className="kb-row" key={l}>
          <span className="lbl">{l}</span>
          <span className="kb-fixed">{k}</span>
        </div>
      ))}
    </>
  )
}

/* ── 预设分区 ── */
function PresetsSection({ q }: { q: string | null }) {
  const settings = useStore(s => s.settings)
  const items = settings.presets.items
  const kl = q?.toLowerCase() ?? null
  const visible = kl
    ? items.filter(p =>
        `${p.label} ${p.id} ${p.program ?? ''} ${p.initCommand ?? ''}`.toLowerCase().includes(kl),
      )
    : items
  return (
    <>
      <div className="srow" style={{ borderBottom: 'none', paddingBottom: 4 }}>
        <div className="lcol">
          <div className="lrow">
            <span className="lbl">「+」按钮默认预设</span>
          </div>
          <div className="desc">点侧栏「新建会话」时直接启动该预设；选「跟随上次使用」则记住上次选择</div>
        </div>
        <div className="ctl">
          <span className="sel-wrap">
            <Sel
              value={settings.presets.plusDefault ?? ''}
              options={[
                { value: '', label: '跟随上次使用' },
                ...items.map(p => ({ value: p.id, label: p.label })),
              ]}
              onChange={v =>
                useStore.setState(d => void (d.settings.presets.plusDefault = v || null))
              }
            />
          </span>
        </div>
      </div>
      <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)', margin: '14px 0 6px', padding: '0 2px' }}>
        预设列表
      </div>
      {!visible.length && kl ? (
        <div className="le-empty">无匹配预设</div>
      ) : (
        visible.map(p => <PresetCard key={p.id} p={p} />)
      )}
      <div
        className="le-add"
        onClick={() =>
          useStore.setState(d => {
            const np: Preset = {
              id: `preset${Date.now()}`,
              label: '自定义预设',
              category: 'tool',
              builtin: false,
              args: [],
              env: {},
            }
            d.settings.presets.items.push(np)
            d.ui.expandedPreset = np.id
          })
        }
      >
        <Icon name="plus" size={12} /> 新增预设
      </div>
    </>
  )
}

const fieldRow = (l: string, ctl: ReactNode) => (
  <div className="field-row">
    <span className="fl">{l}</span>
    <span className="fc">{ctl}</span>
  </div>
)

function PresetCard({ p }: { p: Preset }) {
  const expanded = useStore(s => s.ui.expandedPreset)
  const open = expanded === p.id
  const mod = p.builtin && p._mod && Object.keys(p._mod).length > 0
  const setField = (f: string, val: string) =>
    useStore.setState(d => {
      const pp = d.settings.presets.items.find(x => x.id === p.id)
      if (!pp) return
      if (f === 'args') pp.args = val.split('\n').filter(Boolean)
      else if (f === 'env')
        pp.env = Object.fromEntries(
          val
            .split('\n')
            .filter(l => l.includes('='))
            .map(l => l.split('=')),
        )
      else (pp as unknown as Record<string, unknown>)[f] = val
      pp._mod = { ...pp._mod, [f]: 1 }
    })
  return (
    <div className="le-card">
      <div
        className={cn('le-head', open && 'open')}
        onClick={() =>
          useStore.setState(d => void (d.ui.expandedPreset = open ? null : p.id))
        }
      >
        <span className="chev">
          <Icon name="chevronRight" size={12} />
        </span>
        <span className="nm">{p.label}</span>
        <span className="cmd">{presetCmdSummary(p)}</span>
        <span className="bdg">{p.builtin ? '内置' : '自定义'}</span>
        {mod ? <span className="moddot" /> : null}
        <span className="acts">
          <span
            className="mini-btn"
            title="复制为自定义"
            onClick={e => {
              e.stopPropagation()
              useStore.setState(d => {
                const np = { ...p, id: `preset${Date.now()}`, label: p.label + ' 副本', builtin: false }
                delete np._mod
                d.settings.presets.items.push(np)
                d.ui.expandedPreset = np.id
              })
            }}
          >
            <Icon name="copy" size={12} />
          </span>
          {p.builtin && mod ? (
            <span
              className="mini-btn"
              title="重置"
              onClick={e => {
                e.stopPropagation()
                useStore.setState(d => {
                  const pp = d.settings.presets.items.find(x => x.id === p.id)
                  if (pp) delete pp._mod
                })
                useStore.getState().toast('已恢复内置预设默认')
              }}
            >
              <Icon name="reset" size={12} />
            </span>
          ) : null}
          {!p.builtin && (
            <span
              className="mini-btn danger"
              title="删除"
              onClick={e => {
                e.stopPropagation()
                useStore.setState(d => {
                  d.settings.presets.items = d.settings.presets.items.filter(x => x.id !== p.id)
                  if (d.settings.presets.plusDefault === p.id) d.settings.presets.plusDefault = null
                })
              }}
            >
              <Icon name="trash" size={12} />
            </span>
          )}
        </span>
      </div>
      {open && (
        <div className="le-body">
          {fieldRow('Label', <input type="text" value={p.label} onChange={e => setField('label', e.target.value)} />)}
          {fieldRow(
            'Program',
            <input
              type="text"
              style={{ fontFamily: 'var(--font-mono)' }}
              value={p.program ?? ''}
              placeholder="可执行文件名或绝对路径；留空 = 系统默认 shell"
              onChange={e => setField('program', e.target.value)}
            />,
          )}
          {fieldRow(
            'Args',
            <textarea
              placeholder="每行一个参数"
              value={(p.args ?? []).join('\n')}
              onChange={e => setField('args', e.target.value)}
            />,
          )}
          {fieldRow(
            'Env',
            <textarea
              placeholder="每行 KEY=VALUE，如 AMP_FORCE_BEL=1"
              value={Object.entries(p.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')}
              onChange={e => setField('env', e.target.value)}
            />,
          )}
          {fieldRow(
            'Init command',
            <input
              type="text"
              style={{ fontFamily: 'var(--font-mono)' }}
              value={p.initCommand ?? ''}
              placeholder="作为普通键入打进 shell，不是 exec 替换进程"
              onChange={e => setField('initCommand', e.target.value)}
            />,
          )}
          {fieldRow(
            'Cwd',
            <input
              type="text"
              style={{ fontFamily: 'var(--font-mono)' }}
              value={p.cwd ?? ''}
              placeholder="可选；默认项目根目录"
              onChange={e => setField('cwd', e.target.value)}
            />,
          )}
        </div>
      )}
    </div>
  )
}

/* ── ACP agents 分区 ── */
function AcpSection({ q }: { q: string | null }) {
  const agents = useStore(s => s.settings.acpAgents)
  const expanded = useStore(s => s.ui.expandedAgent)
  const kl = q?.toLowerCase() ?? null
  const visible = kl
    ? agents.filter(a => `${a.label} ${a.command} ${a.args.join(' ')}`.toLowerCase().includes(kl))
    : agents
  const setField = (a: AcpAgent, f: string, val: string) =>
    useStore.setState(d => {
      const aa = d.settings.acpAgents.find(x => x.id === a.id)
      if (!aa) return
      if (f === 'args') aa.args = val.split('\n').filter(Boolean)
      else (aa as unknown as Record<string, unknown>)[f] = val
    })
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
        外部 agent 进程，经 ACP 协议接入（JSON-RPC over stdio）。
      </div>
      {!visible.length && kl ? (
        <div className="le-empty">无匹配 agent</div>
      ) : (
        visible.map(a => {
          const open = expanded === a.id
          return (
            <div className="le-card" key={a.id}>
              <div
                className={cn('le-head', open && 'open')}
                onClick={() =>
                  useStore.setState(d => void (d.ui.expandedAgent = open ? null : a.id))
                }
              >
                <span className="chev">
                  <Icon name="chevronRight" size={12} />
                </span>
                <span className="nm">{a.label}</span>
                <span className="cmd">
                  {a.command} {a.args.join(' ')}
                </span>
                <span className="bdg">ACP</span>
                <span className="acts">
                  <span
                    className="mini-btn danger"
                    onClick={e => {
                      e.stopPropagation()
                      useStore.setState(
                        d => void (d.settings.acpAgents = d.settings.acpAgents.filter(x => x.id !== a.id)),
                      )
                    }}
                  >
                    <Icon name="trash" size={12} />
                  </span>
                </span>
              </div>
              {open && (
                <div className="le-body">
                  {fieldRow('Label', <input type="text" value={a.label} onChange={e => setField(a, 'label', e.target.value)} />)}
                  {fieldRow(
                    'Command',
                    <input
                      type="text"
                      style={{ fontFamily: 'var(--font-mono)' }}
                      value={a.command}
                      placeholder="可执行文件名或绝对路径，如 codex / claude-code-acp"
                      onChange={e => setField(a, 'command', e.target.value)}
                    />,
                  )}
                  {fieldRow(
                    'Args',
                    <textarea
                      placeholder="每行一个参数，如 --acp"
                      value={a.args.join('\n')}
                      onChange={e => setField(a, 'args', e.target.value)}
                    />,
                  )}
                </div>
              )}
            </div>
          )
        })
      )}
      <div
        className="le-add"
        onClick={() =>
          useStore.setState(d => {
            const a: AcpAgent = { id: `acp${Date.now()}`, label: 'New Agent', command: '', args: [] }
            d.settings.acpAgents.push(a)
            d.ui.expandedAgent = a.id
          })
        }
      >
        <Icon name="plus" size={12} /> 新增 ACP agent
      </div>
    </>
  )
}
