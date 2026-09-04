/**
 * surfaces/SettingsSections.tsx — SettingsView 右列分区内容
 * （settings-ui.md §6 分表 / §8 通知约定卡 / §9 键位表 / §10 Advanced）。
 *
 * Defs 分区（notifications/terminal/appearance）：SETTING_DEFS 过滤
 * section → SettingRow 声明式渲染（D7），值/回调全走注入的 SettingsStore
 * 接口（SettingsView 传入 props，本文件不 import store 实现——纯展示层）。
 * writeError（§5.3 行内红条）：出错 path 对应行下渲染红字 + 回滚已由
 * store 层完成（内存回滚 persisted，显示值随之回退）。
 *
 * Presets（T3.1）/ ACP（T3+.1）：独立文件列表 CRUD。Keybindings：T3+.2
 * 解锁可编辑（捕获式改键 + 冲突警示；Esc / + 菜单为平台语义只读）。
 * Advanced（T3+.2）：gpuBackend defs + 诊断卡 + settings.json 实时视图。
 */

import { useState, type ReactElement } from 'react'

import { DEFAULT_KEYBINDINGS, type KeybindingAction, type Keybindings } from '../keybindings'
import { openInSystemApp } from '../settings/file'
import type { SettingDef, SettingSectionId, SettingsPath } from '../settings/schema'
import { SETTING_DEFS } from '../settings/schema'
import type { SettingsStore } from '../settings/store'
import { getByPath, serializeSettings } from '../settings/store'
import { SettingRow } from '../ui/SettingRow'
import { COLORS, FONT } from '../ui/tokens'
import { AcpAgentsSection } from './AcpAgentsSection'
import { ModDot } from './listEditorParts'
import { PresetsSection } from './PresetsSection'
import { settingsKeyboard } from './settingsKeyboard'

export type SectionProps = {
  settings: SettingsStore
  /** 搜索子串（行级过滤 + label/desc 高亮；null = 不过滤不高亮） */
  query: string | null
  defs: SettingDef[]
}

/** defs → SettingRow 列表（查询命中 + 真值接线 + writeError 红条） */
export function DefsSection({ settings, query, defs }: SectionProps): ReactElement {
  const s = settings.get()
  const err = settings.writeError()
  const rows = defs.filter((d) => matchDef(d, query))

  if (rows.length === 0) return <EmptyHits />

  return (
    <div>
      {rows.map((def) => (
        <div key={def.path}>
          <SettingRow
            def={def}
            value={getByPath(s, def.path) as boolean | string | number}
            modified={settings.isModified(def.path)}
            onChange={(v) => settings.patch(def.path, v)}
            onReset={() => settings.reset(def.path)}
          />
          {err?.path === def.path ? <WriteErrorBar message={err.message} /> : null}
        </div>
      ))}
    </div>
  )
}

/** §5.3 行内红条 */
function WriteErrorBar({ message }: { message: string }): ReactElement {
  return (
    <text
      testId={`writeerror`}
      style={{ fontSize: 11, fontFamily: FONT.mono, color: COLORS.bell, marginBottom: 6 }}
    >
      {`写入失败：${message}`}
    </text>
  )
}

// ── 通知分区约定卡（§8，只读，产品文档非配置入口）──────────────────

const CONVENTIONS: [string, string][] = [
  ['Pi', '.pi/extensions/zed-bell.ts 在 agent_end 写 \\x07'],
  ['Amp', 'env AMP_FORCE_BEL=1'],
  ['Claude', 'settings.json → preferredNotifChannel: "terminal_bell"'],
  ['Codex', 'tui.terminal_title → OSC 标题'],
]

export function CliConventionsCard(): ReactElement {
  return (
    <div
      testId="cli-conventions"
      style={{
        marginTop: 18,
        padding: 12,
        backgroundColor: COLORS.sidebar,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 6,
      }}
    >
      <text
        style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.textBright, marginBottom: 8 }}
      >
        CLI 侧 BEL / OSC 约定（j-agent 只信任这两个信号；到各自 CLI 侧配置，此处不代管）
      </text>
      {CONVENTIONS.map(([name, desc]) => (
        <div key={name} style={{ display: 'flex', flexDirection: 'row', gap: 10, marginBottom: 4 }}>
          <text
            style={{
              width: 64,
              fontSize: 11,
              fontFamily: FONT.ui,
              color: COLORS.text,
              flexShrink: 0,
            }}
          >
            {name}
          </text>
          <text
            style={{
              flexGrow: 1,
              fontSize: 11,
              fontFamily: FONT.mono,
              color: COLORS.muted,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              pointerEvents: 'none',
            }}
          >
            {desc}
          </text>
        </div>
      ))}
    </div>
  )
}

// ── Keybindings 分区（S5；T3+.2 解锁可编辑）──────────────────────

/** 可编辑动作（settings.keybindings 四叶）。requireCtrl 语义约束：
 *  cycleNext/cyclePrev/toggleSettings 生活在全局修饰键层（硬约束 2：不吃裸键——终端里
 *  vim/claude 按键必须透传）；focusSearch 生活在设置面裸键层。 */
const KEY_ACTIONS: { action: KeybindingAction; label: string; requireCtrl: boolean }[] = [
  { action: 'cycleNext', label: '下一个 thread（循环切换）', requireCtrl: true },
  { action: 'cyclePrev', label: '上一个 thread（循环切换）', requireCtrl: true },
  { action: 'toggleSettings', label: '打开 / 关闭设置', requireCtrl: true },
  { action: 'focusSearch', label: '聚焦设置搜索', requireCtrl: false },
]

/** 平台语义只读行（不参与配置） */
const FIXED_KEYS: [string, string][] = [
  ['返回 / 清空搜索', 'Esc（平台语义）'],
  ['新建 / 预设菜单', '+ 单击 / Shift +'],
]

/** 捕获白名单：单字符（非空白非 '-'）或具名键 */
const NAMED_KEYS = new Set([
  'tab',
  'enter',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'backspace',
  'delete',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
])

function validKey(k: string): boolean {
  return (k.length === 1 && k !== '-' && k.trim() !== '') || NAMED_KEYS.has(k)
}

/** 键位表命中数（与行级过滤同逻辑：动作名/当前键位串子串） */
export function keybindingHits(q: string, keybindings?: Keybindings): number {
  const lower = q.toLowerCase()
  const keyOf = (a: KeybindingAction): string => keybindings?.[a] ?? DEFAULT_KEYBINDINGS[a]
  const rows = [
    ...KEY_ACTIONS.map(({ action, label }) => [label, keyOf(action)] as const),
    ...FIXED_KEYS.map(([label, key]) => [label, key] as const),
  ]
  return rows.filter(
    ([label, key]) => label.toLowerCase().includes(lower) || key.toLowerCase().includes(lower),
  ).length
}

/** 单个捕获格：点击/enter 进入编辑态 → 按组合即时写入；Esc 取消（同步消费
 *  标记防 root 层连坐关设置——T2.6 时序）；无效组合拒绝并提示。 */
function KeyCap({
  settings,
  action,
  requireCtrl,
  keystroke,
}: {
  settings: SettingsStore
  action: KeybindingAction
  requireCtrl: boolean
  keystroke: string
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const path = `keybindings.${action}` as SettingsPath
  const onKeyDown = (e: { key?: string; modifiers?: { ctrl: boolean; shift: boolean } }) => {
    if (!editing) {
      if (e.key === 'enter') {
        setEditing(true)
        setHint(null)
      }
      return
    }
    if (e.key === 'escape') {
      // 取消编辑：同步置消费标记（root 层后到不连坐关设置）
      settingsKeyboard.markEscConsumed()
      setEditing(false)
      setHint(null)
      return
    }
    // 修饰键单独按下：等待非修饰键
    if (e.key === 'ctrl' || e.key === 'shift' || e.key === 'alt') return
    const ctrl = e.modifiers?.ctrl ?? false
    const shift = e.modifiers?.shift ?? false
    const ks = `${ctrl ? 'ctrl-' : ''}${shift ? 'shift-' : ''}${e.key ?? ''}`
    if (e.key === '-') {
      setHint('「-」不可用（语法限制）')
      return
    }
    if (!validKey(e.key ?? '')) {
      setHint('不支持的键')
      return
    }
    if (requireCtrl && !ctrl) {
      setHint('需含 Ctrl（全局层不吃裸键）')
      return
    }
    if (!requireCtrl && (ctrl || shift)) {
      setHint('需无修饰键（设置面裸键层）')
      return
    }
    settings.patch(path, ks)
    setEditing(false)
    setHint(null)
  }
  const modified = settings.isModified(path)
  return (
    <div
      testId={`kb-cap-${action}`}
      tabIndex={0}
      onClick={() => {
        setEditing(true)
        setHint(null)
      }}
      onKeyDown={onKeyDown}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 3,
        paddingBottom: 3,
        paddingLeft: 8,
        paddingRight: 8,
        borderWidth: 1,
        borderColor: editing ? COLORS.accent : hint ? COLORS.bell : COLORS.borderSubtle,
        borderRadius: 5,
        backgroundColor: COLORS.sidebar,
      }}
    >
      <text
        style={{
          fontSize: 11,
          fontFamily: FONT.mono,
          color: editing ? COLORS.accent : COLORS.text,
        }}
      >
        {editing ? (hint ?? '按下新组合…') : keystroke}
      </text>
      {modified ? <ModDot /> : null}
    </div>
  )
}

export function KeybindingsSection({
  settings,
  query,
}: {
  settings: SettingsStore
  query: string | null
}): ReactElement {
  const s = settings.get().keybindings
  const q = query?.toLowerCase() ?? null
  const matchRow = (label: string, key: string): boolean =>
    !q || label.toLowerCase().includes(q) || key.toLowerCase().includes(q)
  const editable = KEY_ACTIONS.filter(({ action, label }) => matchRow(label, s[action]))
  const fixed = FIXED_KEYS.filter(([label, key]) => matchRow(label, key))
  if (editable.length === 0 && fixed.length === 0) return <EmptyHits />
  return (
    <div>
      {editable.map(({ action, label, requireCtrl }) => {
        // 冲突：其它动作已绑同一串（运行时按声明序取首中；此处仅警示）
        const conflict = KEY_ACTIONS.find((o) => o.action !== action && s[o.action] === s[action])
        const modified = settings.isModified(`keybindings.${action}` as SettingsPath)
        return (
          <div key={action} style={{ borderBottomWidth: 1, borderColor: COLORS.border }}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingTop: 9,
                paddingBottom: 9,
              }}
            >
              <text style={{ fontSize: 12.5, fontFamily: FONT.ui, color: COLORS.text }}>
                {label}
              </text>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {modified ? (
                  <text
                    testId={`kb-reset-${action}`}
                    style={{ fontSize: 12, fontFamily: FONT.mono, color: COLORS.muted }}
                    onClick={() => settings.reset(`keybindings.${action}` as SettingsPath)}
                  >
                    ↺
                  </text>
                ) : null}
                <KeyCap
                  settings={settings}
                  action={action}
                  requireCtrl={requireCtrl}
                  keystroke={s[action]}
                />
              </div>
            </div>
            {conflict ? (
              <text
                testId={`kb-conflict-${action}`}
                style={{
                  fontSize: 11,
                  fontFamily: FONT.mono,
                  color: COLORS.bell,
                  marginBottom: 6,
                }}
              >
                {`⚠ 与「${conflict.label}」冲突（同绑 ${s[action]}）`}
              </text>
            ) : null}
          </div>
        )
      })}
      {fixed.map(([label, key]) => (
        <div
          key={label}
          style={{
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'space-between',
            paddingTop: 9,
            paddingBottom: 9,
            borderBottomWidth: 1,
            borderColor: COLORS.border,
          }}
        >
          <text style={{ fontSize: 12.5, fontFamily: FONT.ui, color: COLORS.text }}>{label}</text>
          <text style={{ fontSize: 11.5, fontFamily: FONT.mono, color: COLORS.muted }}>{key}</text>
        </div>
      ))}
    </div>
  )
}

// ── Advanced 分区（§10；T3+.2：gpuBackend + 诊断卡 + JSON 实时视图）────

/** 与 packages/app/package.json version 同步（resolveJsonModule 未开，不引双源） */
const APP_VERSION = '0.1.0'
/** scripts/refs-config.ts 的 gpuix pin 前缀 */
const GPUIX_PIN = 'e948b20'

function DiagnosticsCard(): ReactElement {
  const rows: [string, string][] = [
    ['版本', `j-agent ${APP_VERSION}（T1–T3+）`],
    ['GPUIX fork', `pin ${GPUIX_PIN}…（patches/ 版本化）`],
    ['平台', process.platform === 'win32' ? 'Windows · ConPTY' : process.platform],
  ]
  return (
    <div
      testId="diagnostics-card"
      style={{
        marginTop: 18,
        padding: 12,
        backgroundColor: COLORS.sidebar,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 6,
      }}
    >
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', flexDirection: 'row', gap: 10, marginBottom: 4 }}>
          <text
            style={{
              width: 88,
              fontSize: 11,
              fontFamily: FONT.ui,
              color: COLORS.text,
              flexShrink: 0,
            }}
          >
            {k}
          </text>
          <text style={{ flexGrow: 1, fontSize: 11, fontFamily: FONT.mono, color: COLORS.muted }}>
            {v}
          </text>
        </div>
      ))}
    </div>
  )
}

/** settings.json 实时视图（只读代码块；订阅快照 → 修改即时反映）+
 *  「在编辑器中打开」（真盘 adapter 才有 path；memory 测试面不渲染） */
function JsonViewCard({ settings }: { settings: SettingsStore }): ReactElement {
  const path = settings.filePath()
  return (
    <div
      testId="settings-json-card"
      style={{
        marginTop: 18,
        padding: 12,
        backgroundColor: COLORS.sidebar,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.textBright }}>
          settings.json · 实时视图（JSON 是事实源，UI 是表单视图）
        </text>
        {path ? (
          <text
            testId="open-settings-json"
            style={{ fontSize: 11.5, fontFamily: FONT.ui, color: COLORS.accent }}
            onClick={() => void openInSystemApp(path)}
          >
            在编辑器中打开 ↗
          </text>
        ) : null}
      </div>
      <div style={{ maxHeight: 280, overflowY: 'scroll' }}>
        {/* markdown 是 native 元素：内容不进 getAllText——断言走
            findByType('markdown') 的 customProps.source */}
        <markdown
          testId="settings-json-view"
          source={`\`\`\`json\n${serializeSettings(settings.get()).trimEnd()}\n\`\`\`}`}
        />
      </div>
    </div>
  )
}

export function AdvancedSection({
  settings,
  query,
}: {
  settings: SettingsStore
  query: string | null
}): ReactElement {
  return (
    <div>
      <DefsSection settings={settings} query={query} defs={DEFS_BY_SECTION.advanced ?? []} />
      <DiagnosticsCard />
      <JsonViewCard settings={settings} />
    </div>
  )
}

// ── 共享小件 ─────────────────────────────────────────────────────────

/** 搜索无命中空态（§9：空态 + 清除按钮由 SettingsView 提供 query 清空） */
export function EmptyHits(): ReactElement {
  return (
    <text
      testId="settings-empty-hits"
      style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted, padding: 8 }}
    >
      无匹配设置项
    </text>
  )
}

/** def × query 子串匹配（label / description / key 路径；不区分大小写） */
export function matchDef(d: SettingDef, query: string | null): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    d.label.toLowerCase().includes(q) ||
    (d.description?.toLowerCase().includes(q) ?? false) ||
    d.path.toLowerCase().includes(q)
  )
}

/** 分区标题（右列顶部；搜索模式下列出跨分区命中时用） */
export function SectionHeading({ label }: { label: string }): ReactElement {
  return (
    <text style={{ fontSize: 15, fontFamily: FONT.ui, color: COLORS.textBright, marginBottom: 6 }}>
      {label}
    </text>
  )
}

/** defs by section（模块级预计算） */
export const DEFS_BY_SECTION: Record<string, SettingDef[]> = groupBySection(SETTING_DEFS)

function groupBySection(defs: SettingDef[]): Record<string, SettingDef[]> {
  const map: Record<string, SettingDef[]> = {}
  for (const d of defs) {
    ;(map[d.section] ??= []).push(d)
  }
  return map
}

/** 分区渲染调度：非 defs 分区（keybindings/presets/acp）特判 */
export function renderSectionContent(
  section: SettingSectionId,
  settings: SettingsStore,
  query: string | null,
): ReactElement {
  switch (section) {
    case 'notifications':
      return (
        <div>
          <DefsSection
            settings={settings}
            query={query}
            defs={DEFS_BY_SECTION.notifications ?? []}
          />
          <CliConventionsCard />
        </div>
      )
    case 'terminal':
    case 'appearance':
      return <DefsSection settings={settings} query={query} defs={DEFS_BY_SECTION[section] ?? []} />
    case 'advanced':
      return <AdvancedSection settings={settings} query={query} />
    case 'keybindings':
      return <KeybindingsSection settings={settings} query={query} />
    case 'presets':
      return <PresetsSection settings={settings} query={query} />
    case 'acp':
      return <AcpAgentsSection settings={settings} query={query} />
  }
}
