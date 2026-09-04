/**
 * surfaces/SettingsSections.tsx — SettingsView 右列分区内容
 * （settings-ui.md §6 分表 / §8 通知约定卡 / §9 键位只读表 / §7·§3+ 占位）。
 *
 * Defs 分区（notifications/terminal/appearance/advanced）：SETTING_DEFS 过滤
 * section → SettingRow 声明式渲染（D7），值/回调全走注入的 SettingsStore
 * 接口（SettingsView 传入 props，本文件不 import store 实现——纯展示层）。
 * writeError（§5.3 行内红条）：出错 path 对应行下渲染红字 + 回滚已由
 * store 层完成（内存回滚 persisted，显示值随之回退）。
 *
 * Presets：T3.1 实装（PresetsSection.tsx，列表 CRUD）。ACP：Phase 3+ 占位卡
 * （§5.3 可见但 disabled + Phase 徽章）。Keybindings：第一期只读表（S5）。
 */

import type { ReactElement } from 'react'

import type { SettingDef, SettingSectionId } from '../settings/schema'
import { SETTING_DEFS } from '../settings/schema'
import type { SettingsStore } from '../settings/store'
import { getByPath } from '../settings/store'
import { SettingRow } from '../ui/SettingRow'
import { COLORS, FONT } from '../ui/tokens'
import { AcpAgentsSection } from './AcpAgentsSection'
import { PresetsSection } from './PresetsSection'

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

// ── Keybindings 只读表（S5：第一期只读）─────────────────────────────

const KEYBINDINGS: [string, string][] = [
  ['循环切换 thread（混排）', 'Ctrl-Tab / Ctrl-Shift-Tab'],
  ['打开 / 关闭设置', 'Ctrl-,'],
  ['聚焦设置搜索', '/'],
  ['返回 / 清空搜索', 'Esc'],
  ['新建（默认预设）/ 预设菜单', '+ 单击 / Shift +'],
]

/** 键位表命中数（与行级过滤同逻辑：动作名/键名子串） */
export function keybindingHits(q: string): number {
  const lower = q.toLowerCase()
  return KEYBINDINGS.filter(
    ([action, key]) => action.toLowerCase().includes(lower) || key.toLowerCase().includes(lower),
  ).length
}

export function KeybindingsSection({ query }: { query: string | null }): ReactElement {
  const q = query?.toLowerCase() ?? null
  const rows = KEYBINDINGS.filter(
    ([action, key]) => !q || action.toLowerCase().includes(q) || key.toLowerCase().includes(q),
  )
  if (rows.length === 0) return <EmptyHits />
  return (
    <div>
      {rows.map(([action, key]) => (
        <div
          key={action}
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
          <text style={{ fontSize: 12.5, fontFamily: FONT.ui, color: COLORS.text }}>{action}</text>
          <text style={{ fontSize: 11.5, fontFamily: FONT.mono, color: COLORS.muted }}>{key}</text>
        </div>
      ))}
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
    case 'advanced':
      return <DefsSection settings={settings} query={query} defs={DEFS_BY_SECTION[section] ?? []} />
    case 'keybindings':
      return <KeybindingsSection query={query} />
    case 'presets':
      return <PresetsSection settings={settings} query={query} />
    case 'acp':
      return <AcpAgentsSection settings={settings} query={query} />
  }
}
