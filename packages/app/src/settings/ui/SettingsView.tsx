/**
 * settings/ui/SettingsView.tsx — 设置表面（settings-ui.md §3 信息架构 / §9 搜索 /
 * S1 Pane 特殊表面）。R8：外壳对齐原型 index.css 第二段（.settings/.st-nav/
 * .st-nav-brand/.st-search/.st-nav-item/.st-content-in/.st-page-head/.st-live/
 * .st-card/.st-search-section/.st-empty-card）。
 *
 * 左列 SettingsNav 218px（品牌头 + 搜索框 + 7 分区 + 命中计数徽章），右列
 * SettingsContent（st-card 包裹分区内容 / 搜索时 st-search-section 分组）。
 *
 * - 分区深链：?section=$s 由路由承载（useSettingsSection），nav 点击即导航
 * - 搜索（§9）：子串过滤 label/description/path + 预设名 + 键位动作名；
 *   命中分区显示计数徽章、无内容分区置灰（presets/acp 恒有内容——列表分区
 *   空命中时在卡内显示「无匹配」）；全无命中空态卡 + 清除按钮；Esc 清空
 * - 高亮：SettingRow highlightQuery（amber wash）
 * - 打开设置时焦点进搜索框（§4；autoFocus）
 * - 生命周期（Ctrl-, / Esc 关闭 / 切 thread 关闭）在全局键位层（T2.6）
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { Icon, inputFocus, COLORS, FONT } from '@jagent/ui'
import type { IconName } from '@jagent/ui'
import type { Keybindings } from '../../keybindings'
import { useSettingsSection, navigateSettingsSection } from '../../router'
import type { TerminalPreset } from '../../threads/presets'
import { presetMatches } from '../../threads/presets'
import { SECTIONS, SETTING_DEFS } from '../schema'
import type { AcpAgent, SettingSectionId, Settings } from '../schema'
import type { SettingsStore } from '../store'
import { useSettings } from '../useSettings'
import { acpAgentMatches } from './AcpAgentsSection'
import { settingsKeyboard } from './settingsKeyboard'
import {
  conventionMatches,
  keybindingHits,
  matchDef,
  renderSectionContent,
} from './SettingsSections'

/** 分区图标（原型 SECTION_ICONS） */
const SECTION_ICONS: Record<string, IconName> = {
  presets: 'agent',
  notifications: 'bell',
  terminal: 'terminal',
  appearance: 'edit',
  keybindings: 'tag',
  acp: 'acp',
  advanced: 'gear',
}

export function SettingsView({ settings }: { settings: SettingsStore }): ReactElement {
  const section = useSettingsSection()
  const [query, setQuery] = useState('')
  // .st-search:focus-within 等价物（GPUIX 无后代伪类，input 焦点态翻壳边色）
  const [searchFocused, setSearchFocused] = useState(false)
  // 搜索框元素 id 用 ref 回调获取（挂载即有，不依赖 focus 事件——
  // autoFocus 程序化聚焦不派发 JS onFocus，实测）
  const searchRef = useRef<{ id: number } | null>(null)
  // 模块态同步（root 键位层读）：query 提交后更新。与卸载清理分开两个
  // effect——query 变化时不能重置 searchInputId（那是 onFocus 记的）
  useEffect(() => {
    settingsKeyboard.setQuery(query)
  }, [query])
  // 卸载：设置面不在时 settingsKeyboard 的值无意义
  useEffect(() => {
    return () => {
      settingsKeyboard.setQuery('')
      settingsKeyboard.setSearchInput(null)
    }
  }, [])
  // 订阅设置快照：patch/reset/writeError 后整树重渲染（行数少，粒度足够）
  const snap = useSettings(settings)

  const q: string | null = query.trim() || null
  const hits = hitsBySection(q, snap.presets.items, snap.acpAgents, snap.keybindings)
  const searching = q !== null
  const visibleSections = searching
    ? SECTIONS.filter((s) => sectionHasContent(s.id, q!, snap))
    : SECTIONS

  return (
    <div
      testId="settings-view"
      style={{
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'row',
        backgroundColor: COLORS.pane,
      }}
    >
      {/* ── 左列：SettingsNav（.st-nav：218px / rgba(32,36,43,.55) / subtle 右边） ── */}
      <div
        style={{
          width: 218,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: COLORS.settingsNav,
          borderRightWidth: 1,
          borderColor: COLORS.borderSubtle,
        }}
      >
        {/* 品牌头（.st-nav-brand：58px + 底边；mark 28×28 r8 surface + gear） */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 9,
            height: 58,
            paddingLeft: 14,
            paddingRight: 14,
            borderBottomWidth: 1,
            borderColor: COLORS.borderSubtle,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderWidth: 1,
              borderColor: COLORS.borderSubtle,
              borderRadius: 8,
              backgroundColor: COLORS.surface,
              flexShrink: 0,
            }}
          >
            <Icon name="gear" size={15} color={COLORS.accent} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <text
              style={{
                fontSize: 12,
                fontFamily: FONT.ui,
                color: COLORS.textBright,
                pointerEvents: 'none',
              }}
            >
              设置
            </text>
            <text
              style={{
                fontSize: 10,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                pointerEvents: 'none',
              }}
            >
              偏好与工具
            </text>
          </div>
        </div>

        {/* 搜索框（.st-search：34px / margin 12 10 10 / r8 / inputBg + kbd「/」） */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            marginTop: 12,
            marginLeft: 10,
            marginRight: 10,
            marginBottom: 10,
            height: 34,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 8,
            backgroundColor: COLORS.inputBg,
            borderWidth: 1,
            borderColor: searchFocused ? COLORS.focusBorder : COLORS.borderSubtle,
            flexShrink: 0,
          }}
        >
          <Icon name="search" size={13} color={COLORS.muted} />
          <input
            ref={(r) => {
              searchRef.current = r
              settingsKeyboard.setSearchInput(r?.id ?? null)
            }}
            testId="settings-search"
            autoFocus
            value={query}
            placeholder="搜索设置…"
            onChange={(e) => setQuery(e.value ?? '')}
            onFocus={() => {
              // 点击/Tab 聚焦时上报输入态（autoFocus 不触发此回调；计数
              // 语义见 ui/keyboard.ts 注释——负值不影响 any 判定）
              inputFocus.acquire()
              setSearchFocused(true)
            }}
            onBlur={() => {
              inputFocus.release()
              setSearchFocused(false)
            }}
            onKeyDown={(e) => {
              // Esc 消费同步写模块态：React 状态在事件回调内同步提交，
              // root 层（同一按键的后一跳）必须看到「已消费」标记而非
              // 清空后的 query（时序实测：useEffect 先于 root handler 跑完）
              if (e.key === 'escape' && query) {
                setQuery('')
                settingsKeyboard.setQuery('')
                settingsKeyboard.markEscConsumed()
              }
            }}
            style={{
              flexGrow: 1,
              minWidth: 0,
              fontSize: 12,
              lineHeight: 16,
              fontFamily: FONT.ui,
              color: COLORS.textBright,
            }}
          />
          {/* kbd「/」提示（proto .st-search kbd：18px 高 / r4 / mono 10 / faint） */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 18,
              minWidth: 18,
              paddingLeft: 5,
              paddingRight: 5,
              borderWidth: 1,
              borderColor: COLORS.borderSubtle,
              borderRadius: 4,
              flexShrink: 0,
              pointerEvents: 'none',
            }}
          >
            <text
              style={{
                fontSize: 10,
                lineHeight: 16,
                fontFamily: FONT.mono,
                color: COLORS.faint,
                pointerEvents: 'none',
              }}
            >
              /
            </text>
          </div>
        </div>

        {/* 7 分区（.st-nav-list：gap 3 / pad 0 8 10；item 34px 高 + 图标 +
            命中徽章；搜索时无内容分区置灰） */}
        <div
          style={{
            flexGrow: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            paddingLeft: 8,
            paddingRight: 8,
            paddingBottom: 10,
            overflowY: 'scroll',
          }}
        >
          {SECTIONS.map((s) => {
            const n = hits[s.id] ?? 0
            const hasContent = !searching || sectionHasContent(s.id, q!, snap)
            const dimmed = searching && !hasContent
            const active = !searching && s.id === section
            return (
              <div
                key={s.id}
                testId={`nav-${s.id}`}
                tabIndex={dimmed ? -1 : 0}
                onClick={() => {
                  if (dimmed) return
                  setQuery('')
                  navigateSettingsSection(s.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'enter' && !dimmed) {
                    setQuery('')
                    navigateSettingsSection(s.id)
                  }
                }}
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 9,
                  width: '100%',
                  height: 34,
                  paddingLeft: 9,
                  paddingRight: 9,
                  borderWidth: 1,
                  borderRadius: 8,
                  borderColor: active ? COLORS.borderSubtle : 'transparent',
                  cursor: dimmed ? 'default' : 'pointer',
                  backgroundColor: active ? COLORS.surfaceActive : 'transparent',
                  boxShadow: active
                    ? {
                        offsetX: 0,
                        offsetY: 1,
                        blurRadius: 2,
                        spreadRadius: 0,
                        color: 'rgba(0,0,0,0.18)',
                      }
                    : undefined,
                  opacity: dimmed ? 0.4 : 1,
                  flexShrink: 0,
                  hover: dimmed || active ? undefined : { backgroundColor: COLORS.surface },
                }}
              >
                {/* 装饰：pe none 不挡命中（GPUIX 不冒泡） */}
                <Icon
                  name={SECTION_ICONS[s.id] ?? 'gear'}
                  size={14}
                  color={active ? COLORS.accent : COLORS.muted}
                />
                <text
                  style={{
                    fontSize: 12,
                    fontFamily: FONT.ui,
                    color: active ? COLORS.textBright : COLORS.text,
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                    minWidth: 0,
                    flexGrow: 1,
                    pointerEvents: 'none',
                  }}
                >
                  {s.label}
                </text>
                {searching && n > 0 ? (
                  <text
                    style={{
                      fontSize: 10,
                      fontFamily: FONT.ui,
                      color: COLORS.accent,
                      backgroundColor: COLORS.accentSoft,
                      borderRadius: 8,
                      paddingTop: 1,
                      paddingBottom: 1,
                      paddingLeft: 6,
                      paddingRight: 6,
                      flexShrink: 0,
                      pointerEvents: 'none',
                    }}
                  >
                    {String(n)}
                  </text>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── 右列：SettingsContent（.st-content / .st-content-in）──
          padding 在内层包裹 div：gpuix/gpui 的 overflow scroll 容器
          若同时带 padding，内容不满时 padding 上下和会被计入 scroll_max
          （空滚 40px + 内容滚出顶部）——已用 TestRenderer 复现锁定 */}
      <div
        testId="settings-content-scroll"
        style={{
          flexGrow: 1,
          // minWidth: 0 —— 行向 flex item 的 auto 最小尺寸 = 内容固有宽度；
          // overflowY scroll 在 gpuix/taffy 里不清零横轴 auto min，长描述
          // （CJK 不可断行）会把整列撑出视口、右侧控件被裁。显式归零让
          // 列宽回到可用空间，文本正常换行。
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'scroll',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            maxWidth: 920,
            paddingTop: 30,
            paddingLeft: 34,
            paddingRight: 34,
            paddingBottom: 52,
          }}
        >
          {searching ? (
            visibleSections.length === 0 ? (
              <EmptySearchCard query={query.trim()} onClear={() => setQuery('')} />
            ) : (
              <>
                {/* .st-page-head（搜索态无 live pill） */}
                <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 18 }}>
                  <text
                    style={{
                      fontSize: 18,
                      fontWeight: 600,
                      fontFamily: FONT.ui,
                      color: COLORS.textBright,
                    }}
                  >
                    搜索结果
                  </text>
                  <text
                    style={{
                      marginTop: 5,
                      fontSize: 12,
                      fontFamily: FONT.ui,
                      color: COLORS.muted,
                    }}
                  >
                    {`找到 ${visibleSections.length} 个相关分区`}
                  </text>
                </div>
                {/* 跨分区命中：每分区 .st-search-section（小写头）+ .st-card */}
                {visibleSections.map((s) => (
                  <div key={s.id} style={{ marginTop: 22 }}>
                    <text
                      style={{
                        fontSize: 11,
                        fontFamily: FONT.ui,
                        color: COLORS.muted,
                        marginBottom: 8,
                      }}
                    >
                      {/* 原型 text-transform:uppercase（GPUIX 无该属性，JS 侧转） */}
                      {s.label.toUpperCase()}
                    </text>
                    <StCard>{renderSectionContent(s.id, settings, q)}</StCard>
                  </div>
                ))}
              </>
            )
          ) : (
            <>
              {/* .st-page-head：18px 标题 + sub + 右侧 live pill */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 20,
                  marginBottom: 18,
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <text
                    style={{
                      fontSize: 18,
                      fontWeight: 600,
                      fontFamily: FONT.ui,
                      color: COLORS.textBright,
                    }}
                  >
                    {SECTIONS.find((s) => s.id === section)?.label ?? ''}
                  </text>
                  <text
                    style={{
                      marginTop: 5,
                      fontSize: 12,
                      fontFamily: FONT.ui,
                      color: COLORS.muted,
                    }}
                  >
                    更改会立即应用，并自动保存到本地设置。
                  </text>
                </div>
                {/* .st-live：26px 胶囊 + done 绿点 */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    height: 26,
                    paddingLeft: 9,
                    paddingRight: 9,
                    borderWidth: 1,
                    borderColor: COLORS.borderSubtle,
                    borderRadius: 999,
                    backgroundColor: COLORS.card,
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      backgroundColor: COLORS.statusDone,
                      flexShrink: 0,
                    }}
                  />
                  <text
                    style={{
                      fontSize: 10,
                      fontFamily: FONT.ui,
                      color: COLORS.muted,
                      pointerEvents: 'none',
                    }}
                  >
                    即时生效
                  </text>
                </div>
              </div>
              <StCard>{renderSectionContent(section as SettingSectionId, settings, null)}</StCard>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** .st-card：分区内容玻璃卡（overflow hidden + subtle 边 + r12 + card 底 + 浅阴影） */
function StCard({ children }: { children: ReactElement | null }): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 12,
        backgroundColor: COLORS.card,
        boxShadow: {
          offsetX: 0,
          offsetY: 1,
          blurRadius: 2,
          spreadRadius: 0,
          color: 'rgba(0,0,0,0.16)',
        },
      }}
    >
      {children}
    </div>
  )
}

/** .st-empty-card：搜索全空态（虚线卡 + 大搜索图标 + 清除钮；
 *  GPUIX 无 dashed 边框，实线近似） */
function EmptySearchCard({ query, onClear }: { query: string; onClear: () => void }): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        minHeight: 220,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 12,
      }}
    >
      <Icon name="search" size={18} color={COLORS.muted} />
      <text
        testId="settings-empty"
        style={{ fontSize: 13, fontFamily: FONT.ui, color: COLORS.muted }}
      >
        {`没有匹配「${query}」的设置。`}
      </text>
      <div
        testId="settings-clear-search"
        tabIndex={0}
        onClick={onClear}
        onKeyDown={(e) => {
          if (e.key === 'enter') onClear()
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 26,
          paddingLeft: 10,
          paddingRight: 10,
          marginTop: 3,
          borderWidth: 1,
          borderColor: COLORS.borderSubtle,
          borderRadius: 6,
          backgroundColor: COLORS.surface,
          cursor: 'pointer',
          hover: { backgroundColor: COLORS.surfaceHover },
        }}
      >
        <text
          style={{
            fontSize: 12,
            fontFamily: FONT.ui,
            color: COLORS.textBright,
            pointerEvents: 'none',
          }}
        >
          清除搜索
        </text>
      </div>
    </div>
  )
}

/** 各分区命中数（搜索过滤面：defs + 键位动作（动态键位值）+ 预设名（动态 items）+ ACP agent 名（动态列表）） */
export function hitsBySection(
  q: string | null,
  presetItems: TerminalPreset[],
  acpAgents: AcpAgent[],
  keybindings?: Keybindings,
): Record<string, number> {
  if (!q) return {}
  const hits: Record<string, number> = {}
  for (const d of SETTING_DEFS) {
    if (matchDef(d, q)) hits[d.section] = (hits[d.section] ?? 0) + 1
  }
  hits.keybindings = (hits.keybindings ?? 0) + keybindingHits(q, keybindings)
  const presetHits = presetItems.filter((p) => presetMatches(p, q)).length
  if (presetHits > 0) hits.presets = (hits.presets ?? 0) + presetHits
  const acpHits = acpAgents.filter((a) => acpAgentMatches(a, q)).length
  if (acpHits > 0) hits.acp = (hits.acp ?? 0) + acpHits
  return hits
}

/** 原型 sectionHasContent：presets/acp 恒有内容（列表分区在搜索列始终出现，
 *  空命中走卡内「无匹配」）；keybindings 看行级命中；notifications 附加约定卡
 *  命中；其余看 defs。搜索态 nav 置灰与右列分节共用此谓词。 */
export function sectionHasContent(
  id: string,
  q: string,
  snap: Pick<Settings, 'keybindings'>,
): boolean {
  if (id === 'presets' || id === 'acp') return true
  if (id === 'keybindings') return keybindingHits(q, snap.keybindings) > 0
  const defHit = SETTING_DEFS.some((d) => d.section === id && matchDef(d, q))
  if (defHit) return true
  if (id === 'notifications' && conventionMatches(q)) return true
  return false
}
