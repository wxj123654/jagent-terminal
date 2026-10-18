import type { ReactNode } from 'react'
import { useStore } from '@/store'
import {
  SECTIONS, SETTING_DEFS, DEFAULTS, KEY_ACTIONS, FIXED_KEYS, CONVENTIONS, seedSettings,
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
  appearance: 'panelLeft',
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

/**
 * 独立多窗口设置中心（Multi-Window SettingsWindow）
 * - 居于主窗口正中央弹出（940×620 黄金比例，支持双击或点击右上角最大化铺满）；
 * - 右侧内容区域横向 100% 铺满（左右 24px 对称内边距，消除右侧留白）；
 * - 内部卡片采用精致、克制的标准高度（48px–52px 行高，杜绝人为拉高的巨型方块）。
 */
export function SettingsWindow() {
  const open = useStore(s => s.ui.settingsWindowOpen || s.route?.type === 'settings')
  const maximized = useStore(s => !!s.ui.settingsWinMaximized)
  const sec = useStore(s => s.ui.settingsSection)
  const query = useStore(s => s.ui.settingsQuery)
  const settings = useStore(s => s.settings)

  if (!open) return null

  const q = query.trim()
  const hits = sectionHits(settings, q)
  const searching = q !== ''

  const closeWin = () => {
    useStore.setState(d => {
      d.ui.settingsWindowOpen = false
      d.ui.fontPicker = null
      d.ui.kbCapturing = null
      if (d.route?.type === 'settings') {
        d.route = d.lastNonSettings ?? { type: 'workspace', id: 'ws-jt' }
      }
    })
  }

  const toggleMax = () => {
    useStore.setState(d => void (d.ui.settingsWinMaximized = !d.ui.settingsWinMaximized))
  }

  return (
    <div
      className="settings-win-scrim"
      onMouseDown={e => {
        if (e.target === e.currentTarget) closeWin()
      }}
    >
      <div
        className={cn('settings-win', maximized && 'maximized')}
        role="dialog"
        aria-label="设置独立窗口"
      >
        {/* ── 独立窗口顶部 40px 融合标题栏 ── */}
        <div className="settings-win-titlebar" onDoubleClick={toggleMax}>
          <div className="settings-win-title">
            <span style={{ color: 'var(--accentHover)', display: 'flex' }}>
              <Icon name="gear" size={14} />
            </span>
            <span>设置中心</span>
          </div>

          <label className="settings-win-search">
            <Icon name="search" size={12.5} />
            <input
              role="searchbox"
              aria-label="搜索设置"
              placeholder="搜索设置项、预设、快捷键…"
              value={query}
              onChange={e => useStore.setState(d => void (d.ui.settingsQuery = e.target.value))}
              data-settings-search
            />
            {query ? (
              <button
                type="button"
                onClick={() => useStore.setState(d => void (d.ui.settingsQuery = ''))}
                style={{ color: 'var(--muted)', cursor: 'pointer' }}
                title="清空搜索"
              >
                <Icon name="close" size={12} />
              </button>
            ) : (
              <kbd>/</kbd>
            )}
          </label>

          <button
            type="button"
            className="tb-cell tb-branch-btn"
            style={{ height: 26, padding: '0 9px', fontSize: 11 }}
            onClick={() => useStore.getState().toast('已在编辑器中打开 ~/.j-agent/settings.json')}
          >
            <Icon name="file" size={12} />
            <span>settings.json</span>
          </button>

          <button
            type="button"
            className="ibtn"
            style={{ width: 26, height: 26 }}
            title={maximized ? '还原窗口' : '铺满窗口'}
            onClick={toggleMax}
          >
            <Icon name="maximize" size={12.5} />
          </button>
          <button
            type="button"
            className="ibtn"
            style={{ width: 26, height: 26 }}
            title="关闭设置窗口 (Esc)"
            onClick={closeWin}
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {/* ── 独立窗口主体：左侧 188px 分类轨 + 右侧横向 100% 铺满内容区 ── */}
        <div className="settings-win-body">
          <div className="st-nav">
            <div className="st-nav-list isolated-scroll" role="tablist" aria-orientation="vertical" style={{ padding: 0 }}>
              {SECTIONS.map(item => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={!searching && sec === item.id}
                  key={item.id}
                  className={cn('st-nav-item', !searching && sec === item.id && 'active')}
                  onClick={() =>
                    useStore.setState(d => {
                      d.ui.settingsSection = item.id
                      d.ui.settingsQuery = ''
                    })
                  }
                >
                  <Icon name={SECTION_ICONS[item.id]} size={13.5} />
                  <span>{item.label}</span>
                  {hits[item.id] ? <span className="hit">{hits[item.id]}</span> : null}
                </button>
              ))}
            </div>

            <div
              style={{
                padding: '8px 6px 2px',
                borderTop: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                fontSize: 11,
                color: 'var(--faint)',
              }}
            >
              <button
                type="button"
                className="tb-cell tb-branch-btn"
                style={{ width: '100%', justifyContent: 'center', height: 26, fontSize: 11 }}
                onClick={() => {
                  useStore.getState().resetAll()
                  useStore.setState(d => void (d.ui.settingsWindowOpen = true))
                  useStore.getState().toast('已恢复全部默认设置')
                }}
              >
                <Icon name="reset" size={11.5} />
                <span>重置全部默认</span>
              </button>
            </div>
          </div>

          <div className="st-content isolated-scroll">
            <div className="st-content-in">
              {searching ? <SearchAll q={q} /> : <Section sec={sec} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export const SettingsView = SettingsWindow

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
      <div className="st-page-head" style={{ marginBottom: 4 }}>
        <div>
          <div className="st-h" style={{ fontSize: 16 }}>搜索结果</div>
          <div className="st-page-sub">在 {visible.length} 个设置分区中找到匹配项</div>
        </div>
      </div>
      {visible.map(s => (
        <div className="st-search-section" key={s.id} style={{ marginTop: 8 }}>
          <div className="st-h">{s.label}</div>
          <SectionBody sec={s.id} q={q} />
        </div>
      ))}
    </>
  )
}

function Section({ sec }: { sec: string }) {
  const s = SECTIONS.find(x => x.id === sec)
  return (
    <>
      <div className="st-page-head" style={{ marginBottom: 2 }}>
        <div>
          <div className="st-h" style={{ fontSize: 16 }}>{s?.label ?? ''}</div>
          <div className="st-page-sub">更改会立即应用到主窗口所有活跃会话，并自动保存到本地配置。</div>
        </div>
        <span className="st-live">
          <span className="dot done" />
          即时生效
        </span>
      </div>
      <SectionBody sec={sec} q={null} />
    </>
  )
}

function SectionBody({ sec, q }: { sec: string; q: string | null }) {
  const settings = useStore(s => s.settings)
  if (sec === 'presets') return <PresetsSection q={q} />
  if (sec === 'keybindings') return <KbSection q={q} />
  if (sec === 'acp') return <AcpSection q={q} />

  const defs = SETTING_DEFS.filter(d => d.section === sec && (!q || matchDef(d, q)))

  if (!defs.length && sec !== 'notifications') return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
      <div className="st-card" style={{ width: '100%' }}>
        {defs.map(d => (
          <SettingRow key={d.path} d={d} q={q} />
        ))}
      </div>

      {/* ── Terminal 分区：紧凑精致的实时字体与色板预览条（高 ~96px，不撑爆视口）── */}
      {sec === 'terminal' && !q && (
        <div className="st-card" style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--textBright)' }}>
              终端字体与调色板实时预览
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {['#f87171', '#34d399', '#fbbf24', '#6366f1', '#c084fc', '#38bdf8'].map(c => (
                <span
                  key={c}
                  style={{ width: 14, height: 10, borderRadius: 3, background: c }}
                />
              ))}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)', marginLeft: 4 }}>
                {settings.terminal.fontFamily} · {settings.terminal.fontSize}px
              </span>
            </div>
          </div>
          <div
            style={{
              background: 'var(--inputBg)',
              border: '1px solid var(--borderSubtle)',
              borderRadius: 7,
              padding: '8px 12px',
              fontFamily: `'${settings.terminal.fontFamily}', var(--font-mono)`,
              fontSize: settings.terminal.fontSize,
              lineHeight: 1.55,
              color: 'var(--textBright)',
            }}
          >
            <div>
              <span style={{ color: 'var(--accentHover)' }}>~/Documents/jagent-terminal</span>{' '}
              <span style={{ color: 'var(--acpKind)' }}>git:(main)</span>{' '}
              <span style={{ color: 'var(--terminalKind)' }}>❯</span> cargo test --workspace{' '}
              <span style={{ color: 'var(--muted)' }}>— 75 passed (0.84s)</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Appearance 分区：横向紧凑 3 列主题色卡（高 ~100px，告别 461px 巨型色块）── */}
      {sec === 'appearance' && !q && (
        <div className="st-card" style={{ padding: '12px 16px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--textBright)', marginBottom: 10 }}>
            主题色板快速切换
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
            {[
              { id: 'one-dark', name: 'Obsidian Indigo', sub: '高对比深色（默认）', bg: '#0b0d12', pane: '#12151e', acc: '#6366f1' },
              { id: 'one-dark-pro', name: 'One Dark Pro', sub: '经典柔和蓝灰', bg: '#181a1f', pane: '#21252b', acc: '#61afef' },
              { id: 'light', name: 'Daylight Clean', sub: '浅色日间高可读', bg: '#f3f4f6', pane: '#ffffff', acc: '#4f46e5' },
            ].map(t => {
              const active = settings.appearance.theme === t.id
              return (
                <div
                  key={t.id}
                  onClick={() => useStore.setState(d => void (d.settings.appearance.theme = t.id))}
                  style={{
                    borderRadius: 8,
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--borderSubtle)'}`,
                    background: active ? 'var(--surfaceActive)' : 'var(--inputBg)',
                    padding: '10px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 28,
                      borderRadius: 5,
                      background: t.bg,
                      border: '1px solid var(--borderSubtle)',
                      display: 'flex',
                      overflow: 'hidden',
                      flexShrink: 0,
                    }}
                  >
                    <span style={{ width: 10, background: t.bg, borderRight: '1px solid rgba(128,128,128,.25)' }} />
                    <span style={{ flex: 1, background: t.pane, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ width: 10, height: 4, borderRadius: 2, background: t.acc }} />
                    </span>
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--textBright)' }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t.sub}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Notifications 分区：紧凑双列 CLI 信号约定 + 测试通知操作 ── */}
      {sec === 'notifications' &&
        (!q ||
          'cli bel osc 约定'.includes(q.toLowerCase()) ||
          CONVENTIONS.some(c => (c[0] + c[1]).toLowerCase().includes(q.toLowerCase()))) && (
          <div className="st-card" style={{ padding: '12px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--textBright)' }}>
                CLI 侧 BEL / OSC 信号约定
              </span>
              <button
                type="button"
                className="tb-cell tb-branch-btn"
                style={{ height: 24, padding: '0 9px', fontSize: 11 }}
                onClick={() => {
                  useStore.getState().pushNotice('ok', '测试通知：Agent 任务已完成', 'jagent-terminal · 信号连通正常')
                  useStore.getState().toast('🔔 已向左下角通知中心发送一条测试通知')
                }}
              >
                <Icon name="bell" size={11.5} /> 发送测试通知
              </button>
            </div>
            <div className="st-grid-2col" style={{ gap: 8 }}>
              {CONVENTIONS.map(([n, d]) => (
                <div
                  key={n}
                  style={{
                    padding: '8px 11px',
                    borderRadius: 7,
                    background: 'var(--inputBg)',
                    border: '1px solid var(--borderSubtle)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accentHover)', flexShrink: 0 }}>{n}</span>
                  <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d}</span>
                </div>
              ))}
            </div>
          </div>
        )}

      {/* ── Advanced 分区：紧凑 3 列运行时状态条 + 本地数据与崩溃转储管理 ── */}
      {sec === 'advanced' && !q && (
        <>
          <div className="st-card" style={{ padding: '12px 16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              <div style={{ background: 'var(--inputBg)', border: '1px solid var(--borderSubtle)', borderRadius: 7, padding: '8px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>GPU 帧耗时 (P90 / Max)</div>
                <div style={{ fontSize: 13.5, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--terminalKind)', marginTop: 2 }}>
                  1.8 ms / 4.2 ms · 120fps
                </div>
              </div>
              <div style={{ background: 'var(--inputBg)', border: '1px solid var(--borderSubtle)', borderRadius: 7, padding: '8px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>PTY 会话池与内存水位</div>
                <div style={{ fontSize: 13.5, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--accentHover)', marginTop: 2 }}>
                  186 MB · 8 Active PTYs
                </div>
              </div>
              <div style={{ background: 'var(--inputBg)', border: '1px solid var(--borderSubtle)', borderRadius: 7, padding: '8px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Crash Sidecar 守护</div>
                <div style={{ fontSize: 13.5, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--textBright)', marginTop: 2 }}>
                  ● IPC Ready (0 dumps)
                </div>
              </div>
            </div>
          </div>
          <div className="st-card" style={{ padding: '12px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--textBright)' }}>
                  本地配置与崩溃转储目录
                </span>
                <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>
                  ~/.j-agent/settings.json · ~/.j-agent/crashes/crash-&lt;pid&gt;.sock
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button
                  type="button"
                  className="tb-cell tb-branch-btn"
                  style={{ height: 26, padding: '0 10px', fontSize: 11 }}
                  onClick={() => useStore.getState().toast('已在文件管理器打开 ~/.j-agent/crashes')}
                >
                  <Icon name="folder" size={12} /> 打开转储目录
                </button>
                <button
                  type="button"
                  className="tb-cell tb-branch-btn"
                  style={{ height: 26, padding: '0 10px', fontSize: 11 }}
                  onClick={() => useStore.getState().toast('已导出运行诊断报告 jagent-diag.zip')}
                >
                  <Icon name="download" size={12} /> 导出诊断包
                </button>
              </div>
            </div>
          </div>
          <div className="st-card" style={{ padding: '12px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--textBright)' }}>
                settings.json · 实时视图（JSON 是事实源，UI 是表单视图）
              </span>
              <span
                style={{ fontSize: 11.5, color: 'var(--accent)', cursor: 'pointer' }}
                onClick={() => useStore.getState().toast('已在编辑器中打开 ~/.j-agent/settings.json')}
              >
                在编辑器中打开 ↗
              </span>
            </div>
            <pre
              className="nested-scroll"
              style={{
                maxHeight: 180,
                padding: '8px 10px',
                borderRadius: 6,
                background: 'var(--inputBg)',
                border: '1px solid var(--borderSubtle)',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                lineHeight: 1.5,
                color: 'var(--muted)',
              }}
            >
              {JSON.stringify(settings, null, 2)}
            </pre>
          </div>
        </>
      )}
    </div>
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

/* ── 字体选择器 ── */
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

/* ── 键位分区（紧凑双列卡片网格，不硬撑高度）── */
function KbSection({ q }: { q: string | null }) {
  const settings = useStore(s => s.settings)
  const capturing = useStore(s => s.ui.kbCapturing)
  const kl = q?.toLowerCase() ?? null
  const rows = KEY_ACTIONS.filter(
    a => !kl || a.label.toLowerCase().includes(kl) || settings.keybindings[a.action]?.includes(kl),
  )
  const extraFixed: [string, string][] = [
    ...FIXED_KEYS,
    ['打开 Git 提交图谱', 'Ctrl-Shift-G'],
    ['关闭当前会话副页签', '鼠标中键 / ×'],
    ['AI 对话发送 / 换行', 'Enter / Shift-Enter'],
    ['设置窗口最大化 / 还原', '双击标题栏'],
  ]
  const fixed = extraFixed.filter(
    ([l, k]) => !kl || l.toLowerCase().includes(kl) || k.toLowerCase().includes(kl),
  )
  if (!rows.length && !fixed.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--textBright)' }}>
          全局与会话导航快捷键 ({rows.length}) · 点击右侧键位胶囊可直接录制新组合
        </span>
        <button
          type="button"
          className="tb-cell tb-branch-btn"
          style={{ height: 24, padding: '0 9px', fontSize: 11 }}
          onClick={() => {
            useStore.setState(d => {
              KEY_ACTIONS.forEach(a => {
                d.settings.keybindings[a.action] = String(DEFAULTS['keybindings.' + a.action])
              })
            })
            useStore.getState().toast('已恢复全部默认快捷键绑定')
          }}
        >
          <Icon name="reset" size={11} /> 恢复默认键位
        </button>
      </div>
      <div className="st-grid-2col" style={{ gap: 8 }}>
        {rows.map(a => {
          const cur = settings.keybindings[a.action]
          const conflict = KEY_ACTIONS.find(
            o => o.action !== a.action && settings.keybindings[o.action] === cur,
          )
          const mod = isModified(settings, 'keybindings.' + a.action)
          const cap = capturing === a.action
          return (
            <div className="st-card" key={a.action} style={{ padding: '2px 0' }}>
              <div className="kb-row" style={{ borderBottom: 'none', padding: '7px 14px' }}>
                <span className="lbl" style={{ fontSize: 12 }}>
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
                <div className="kb-conflict" style={{ padding: '0 14px 6px' }}>
                  ⚠ 与「{conflict.label}」冲突（同绑 {cur}）
                </div>
              )}
            </div>
          )
        })}
      </div>

      {fixed.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--textBright)', padding: '2px 2px 0' }}>
            平台与终端内置约定 ({fixed.length})
          </div>
          <div className="st-grid-2col" style={{ gap: 8 }}>
            {fixed.map(([l, k]) => (
              <div className="st-card" key={l} style={{ padding: '2px 0' }}>
                <div className="kb-row" style={{ borderBottom: 'none', padding: '7px 14px' }}>
                  <span className="lbl" style={{ fontSize: 12 }}>{l}</span>
                  <span className="kb-fixed">{k}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

const fieldRow = (l: string, ctl: ReactNode) => (
  <div className="field-row">
    <span className="fl">{l}</span>
    <span className="fc">{ctl}</span>
  </div>
)

      {/* ── 预设分区（全部预设均可删除 + 支持一键恢复默认 + 空预设引导态）── */}
function PresetsSection({ q }: { q: string | null }) {
  const settings = useStore(s => s.settings)
  const items = settings.presets.items
  const kl = q?.toLowerCase() ?? null
  const visible = kl
    ? items.filter(p =>
        `${p.label} ${p.id} ${p.program ?? ''} ${p.initCommand ?? ''}`.toLowerCase().includes(kl),
      )
    : items

  const restoreDefaults = () => {
    useStore.setState(d => {
      d.settings.presets.items = seedSettings().presets.items
      d.ui.expandedPreset = null
    })
    useStore.getState().toast('已恢复 5 个默认内置预设')
  }

  const addCustomPreset = () => {
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
      <div className="st-card">
        <div className="srow" style={{ borderBottom: 'none' }}>
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
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--textBright)' }}>
          预设工具列表 ({visible.length}) · 点击卡片展开编辑，右侧垃圾桶可直接删除
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {items.length > 0 && (
            <button
              type="button"
              className="tb-cell tb-error-btn"
              style={{ height: 26, padding: '0 9px', fontSize: 11 }}
              onClick={() => {
                useStore.setState(d => {
                  d.settings.presets.items = []
                  d.settings.presets.plusDefault = null
                  d.ui.expandedPreset = null
                })
                useStore.getState().toast('已清空全部预设（可切回启动台查看空预设效果）')
              }}
            >
              <Icon name="trash" size={11.5} /> 清空全部
            </button>
          )}
          <button
            type="button"
            className="tb-cell tb-branch-btn"
            style={{ height: 26, padding: '0 9px', fontSize: 11 }}
            onClick={restoreDefaults}
          >
            <Icon name="reset" size={11.5} /> 恢复默认预设
          </button>
          <button
            type="button"
            className="sb-btn-primary"
            style={{ flex: 'none', height: 26, padding: '0 10px', fontSize: 11.5 }}
            onClick={addCustomPreset}
          >
            <Icon name="plus" size={11.5} /> 新增预设
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <div
          className="st-card"
          style={{
            padding: '28px 20px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 10,
            textAlign: 'center',
          }}
        >
          <span style={{ color: 'var(--muted)' }}>
            <Icon name="agent" size={22} />
          </span>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--textBright)' }}>
            所有预设工具均已删除
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 420 }}>
            此时工作区启动台将自动隐藏预设矩阵，仅保留「启动 AI Coding Agent」与「新建交互式终端」两个核心入口。
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              className="tb-cell tb-branch-btn"
              style={{ height: 28, padding: '0 12px', fontSize: 12 }}
              onClick={restoreDefaults}
            >
              <Icon name="reset" size={12} /> 恢复 5 个默认预设
            </button>
            <button
              type="button"
              className="sb-btn-primary"
              style={{ flex: 'none', height: 28, padding: '0 12px', fontSize: 12 }}
              onClick={addCustomPreset}
            >
              <Icon name="plus" size={12} /> 新增自定义预设
            </button>
          </div>
        </div>
      ) : !visible.length && kl ? (
        <div className="le-empty">无匹配预设</div>
      ) : (
        <div className="st-grid-2col" style={{ gap: 8 }}>
          {visible.map(p => (
            <PresetCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  )
}

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
    <div
      className="le-card"
      style={{
        margin: 0,
        gridColumn: open ? '1 / -1' : undefined,
        borderColor: open ? 'var(--accent)' : undefined,
      }}
    >
      <div
        className={cn('le-head', open && 'open')}
        style={{ height: 42 }}
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
            title="复制为自定义预设"
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
              title="重置修改"
              onClick={e => {
                e.stopPropagation()
                useStore.setState(d => {
                  const pp = d.settings.presets.items.find(x => x.id === p.id)
                  if (pp) delete pp._mod
                })
                useStore.getState().toast('已恢复内置预设默认参数')
              }}
            >
              <Icon name="reset" size={12} />
            </span>
          ) : null}
          <span
            className="mini-btn danger"
            title={`删除预设「${p.label}」`}
            aria-label={`删除预设 ${p.label}`}
            onClick={e => {
              e.stopPropagation()
              useStore.setState(d => {
                d.settings.presets.items = d.settings.presets.items.filter(x => x.id !== p.id)
                if (d.settings.presets.plusDefault === p.id) d.settings.presets.plusDefault = null
                if (d.ui.expandedPreset === p.id) d.ui.expandedPreset = null
              })
              useStore.getState().toast(`已删除预设「${p.label}」`)
            }}
          >
            <Icon name="trash" size={12} />
          </span>
        </span>
      </div>
      {open && (
        <div className="le-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, paddingTop: 8 }}>
          {fieldRow('Label', <input type="text" value={p.label} onChange={e => setField('label', e.target.value)} />)}
          {fieldRow(
            'Program',
            <input
              type="text"
              style={{ fontFamily: 'var(--font-mono)' }}
              value={p.program ?? ''}
              placeholder="留空 = 系统默认 shell"
              onChange={e => setField('program', e.target.value)}
            />,
          )}
          {fieldRow(
            'Init cmd',
            <input
              type="text"
              style={{ fontFamily: 'var(--font-mono)' }}
              value={p.initCommand ?? ''}
              placeholder="作为普通键入打进 shell"
              onChange={e => setField('initCommand', e.target.value)}
            />,
          )}
          {fieldRow(
            'Cwd',
            <input
              type="text"
              style={{ fontFamily: 'var(--font-mono)' }}
              value={p.cwd ?? ''}
              placeholder="默认项目根目录"
              onChange={e => setField('cwd', e.target.value)}
            />,
          )}
          {fieldRow(
            'Args',
            <textarea
              rows={2}
              placeholder="每行一个参数"
              value={(p.args ?? []).join('\n')}
              onChange={e => setField('args', e.target.value)}
            />,
          )}
          {fieldRow(
            'Env',
            <textarea
              rows={2}
              placeholder="每行 KEY=VALUE"
              value={Object.entries(p.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')}
              onChange={e => setField('env', e.target.value)}
            />,
          )}
        </div>
      )}
    </div>
  )
}

/* ── ACP agents 分区（全宽双列紧凑网格卡片 + 内联展开编辑）── */
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          外部 Coding Agent 进程，经 ACP 协议接入（JSON-RPC 2.0 over stdio）。
        </span>
        <button
          type="button"
          className="sb-btn-primary"
          style={{ flex: 'none', height: 26, padding: '0 10px', fontSize: 11.5 }}
          onClick={() =>
            useStore.setState(d => {
              const a: AcpAgent = { id: `acp${Date.now()}`, label: 'New Agent', command: 'claude-code-acp', args: [] }
              d.settings.acpAgents.push(a)
              d.ui.expandedAgent = a.id
            })
          }
        >
          <Icon name="plus" size={11.5} /> 新增 ACP Agent
        </button>
      </div>

      {!visible.length && kl ? (
        <div className="le-empty">无匹配 agent</div>
      ) : (
        <div className="st-grid-2col" style={{ gap: 8 }}>
          {visible.map(a => {
            const open = expanded === a.id
            return (
              <div
                className="le-card"
                key={a.id}
                style={{
                  margin: 0,
                  gridColumn: open ? '1 / -1' : undefined,
                  borderColor: open ? 'var(--accent)' : undefined,
                }}
              >
                <div
                  className={cn('le-head', open && 'open')}
                  style={{ height: 42 }}
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
                  <div className="le-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, paddingTop: 8 }}>
                    {fieldRow('Label', <input type="text" value={a.label} onChange={e => setField(a, 'label', e.target.value)} />)}
                    {fieldRow(
                      'Command',
                      <input
                        type="text"
                        style={{ fontFamily: 'var(--font-mono)' }}
                        value={a.command}
                        placeholder="如 codex / claude-code-acp"
                        onChange={e => setField(a, 'command', e.target.value)}
                      />,
                    )}
                    <div style={{ gridColumn: '1 / -1' }}>
                      {fieldRow(
                        'Args',
                        <textarea
                          rows={2}
                          placeholder="每行一个参数，如 --acp"
                          value={a.args.join('\n')}
                          onChange={e => setField(a, 'args', e.target.value)}
                        />,
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ACP 模板快速接入与协议桥接状态卡 */}
      {!kl && (
        <>
          <div className="st-card" style={{ padding: '12px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--textBright)' }}>
                官方 ACP 代理模板一键接入
              </span>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>点击即可添加到上方列表</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
              {[
                { label: 'Gemini CLI (ACP)', command: 'gemini', args: ['--acp'] },
                { label: 'Goose Agent', command: 'goose', args: ['acp'] },
                { label: 'Pi ACP Bridge', command: 'pi', args: ['--acp-stdio'] },
              ].map(tpl => (
                <button
                  key={tpl.label}
                  type="button"
                  onClick={() => {
                    useStore.setState(d => {
                      const id = `acp-${Date.now()}`
                      d.settings.acpAgents.push({ id, label: tpl.label, command: tpl.command, args: tpl.args })
                      d.ui.expandedAgent = id
                    })
                    useStore.getState().toast(`已添加模板「${tpl.label}」`)
                  }}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 7,
                    background: 'var(--inputBg)',
                    border: '1px solid var(--borderSubtle)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--textBright)' }}>{tpl.label}</div>
                    <div style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>
                      {tpl.command} {tpl.args.join(' ')}
                    </div>
                  </div>
                  <span style={{ color: 'var(--accentHover)', display: 'flex' }}>
                    <Icon name="plus" size={12} />
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="st-card" style={{ padding: '12px 16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              <div style={{ background: 'var(--inputBg)', border: '1px solid var(--borderSubtle)', borderRadius: 7, padding: '8px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>传输协议与握手超时</div>
                <div style={{ fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--textBright)', marginTop: 2 }}>
                  JSON-RPC 2.0 stdio · 15s
                </div>
              </div>
              <div style={{ background: 'var(--inputBg)', border: '1px solid var(--borderSubtle)', borderRadius: 7, padding: '8px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>工作区读写与 Diff 桥接</div>
                <div style={{ fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--statusDone)', marginTop: 2 }}>
                  ● 自动同步至右侧变更面板
                </div>
              </div>
              <div style={{ background: 'var(--inputBg)', border: '1px solid var(--borderSubtle)', borderRadius: 7, padding: '8px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>宿主环境变量透传</div>
                <div style={{ fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--font-mono)', color: 'var(--accentHover)', marginTop: 2 }}>
                  PATH / API_KEY / SSH_AUTH
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
