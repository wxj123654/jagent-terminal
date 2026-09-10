/**
 * surfaces/SettingsView.tsx — 设置表面（settings-ui.md §3 信息架构 / §9 搜索 /
 * S1 Pane 特殊表面）。
 *
 * 左列 SettingsNav 218px（搜索框 + 7 分区 + 命中计数徽章），右列
 * SettingsContent（分区内容 / 搜索时跨分区命中列表）。
 *
 * - 分区深链：?section=$s 由路由承载（useSettingsSection），nav 点击即导航
 * - 搜索（§9）：子串过滤 label/description/path + 预设名 + 键位动作名；
 *   命中分区显示计数徽章、0 命中置灰；无命中空态 + 清除按钮；Esc 清空
 * - 高亮：SettingRow highlightQuery（amber wash）
 * - 打开设置时焦点进搜索框（§4；autoFocus）
 * - 生命周期（Ctrl-, / Esc 关闭 / 切 thread 关闭）在全局键位层（T2.6）
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { Icon, inputFocus, COLORS, FONT } from '@jagent/ui'
import type { Keybindings } from '../keybindings'
import { useSettingsSection, navigateSettingsSection } from '../router'
import { SECTIONS, SETTING_DEFS } from '../settings/schema'
import type { AcpAgent, SettingSectionId } from '../settings/schema'
import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import type { TerminalPreset } from '../threads/presets'
import { presetMatches } from '../threads/presets'
import { acpAgentMatches } from './AcpAgentsSection'
import { settingsKeyboard } from './settingsKeyboard'
import { matchDef, renderSectionContent, SectionHeading, keybindingHits } from './SettingsSections'

export function SettingsView({ settings }: { settings: SettingsStore }): ReactElement {
  const section = useSettingsSection()
  const [query, setQuery] = useState('')
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
  const totalHits = Object.values(hits).reduce((a, b) => a + b, 0)

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
      {/* ── 左列：SettingsNav ── */}
      <div
        style={{
          width: 218,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: COLORS.sidebar,
          borderRightWidth: 1,
          borderColor: COLORS.border,
          paddingTop: 10,
        }}
      >
        {/* 搜索框 */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            marginLeft: 10,
            marginRight: 10,
            marginBottom: 8,
            height: 28,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 4,
            backgroundColor: COLORS.inputBg,
            borderWidth: 1,
            borderColor: COLORS.borderSubtle,
          }}
        >
          <Icon name="search" size={12} color={COLORS.muted} />
          <input
            ref={(r) => {
              searchRef.current = r
              settingsKeyboard.setSearchInput(r?.id ?? null)
            }}
            testId="settings-search"
            autoFocus
            value={query}
            placeholder="搜索设置（/ 聚焦）"
            onChange={(e) => setQuery(e.value ?? '')}
            onFocus={() => {
              // 点击/Tab 聚焦时上报输入态（autoFocus 不触发此回调；计数
              // 语义见 ui/keyboard.ts 注释——负值不影响 any 判定）
              inputFocus.acquire()
            }}
            onBlur={() => {
              inputFocus.release()
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
        </div>

        {/* 7 分区（搜索时带计数徽章 / 0 命中置灰） */}
        {SECTIONS.map((s) => {
          const n = hits[s.id] ?? 0
          const dimmed = searching && n === 0
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
                position: 'relative',
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                height: 30,
                marginLeft: 8,
                marginRight: 8,
                paddingLeft: 10,
                paddingRight: 8,
                borderRadius: 4,
                cursor: dimmed ? 'default' : 'pointer',
                backgroundColor: active ? COLORS.surface : 'transparent',
                opacity: dimmed ? 0.4 : 1,
                hover: dimmed ? undefined : { backgroundColor: COLORS.surface },
              }}
            >
              {/* 装饰：pe none 不挡命中（GPUIX 不冒泡） */}
              <text
                style={{
                  fontSize: 12.5,
                  fontFamily: FONT.ui,
                  color: active ? COLORS.textBright : COLORS.text,
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  pointerEvents: 'none',
                }}
              >
                {s.label}
              </text>
              {searching && n > 0 ? (
                <text
                  style={{
                    fontSize: 10,
                    fontFamily: FONT.mono,
                    color: COLORS.accent,
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

      {/* ── 右列：SettingsContent ──
          padding 在内层包裹 div：gpuix/gpui 的 overflow scroll 容器
          若同时带 padding，内容不满时 padding 上下和会被计入 scroll_max
          （空滚 40px + 内容滚出顶部）——已用 TestRenderer 复现锁定 */}
      <div
        testId="settings-content-scroll"
        style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', overflowY: 'scroll' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', padding: 20 }}>
          {searching ? (
            totalHits === 0 ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  alignItems: 'flex-start',
                }}
              >
                <text
                  testId="settings-empty"
                  style={{ fontSize: 13, fontFamily: FONT.ui, color: COLORS.muted }}
                >
                  {`无匹配“${query.trim()}”的设置项`}
                </text>
                <div
                  testId="settings-clear-search"
                  tabIndex={0}
                  onClick={() => setQuery('')}
                  onKeyDown={(e) => {
                    if (e.key === 'enter') setQuery('')
                  }}
                  style={{
                    height: 26,
                    paddingLeft: 10,
                    paddingRight: 10,
                    display: 'flex',
                    alignItems: 'center',
                    borderRadius: 4,
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
            ) : (
              // 跨分区命中列表（对齐 Zed：搜索时右列显示全部命中）
              SECTIONS.filter((s) => (hits[s.id] ?? 0) > 0).map((s) => (
                <div key={s.id} style={{ marginBottom: 18 }}>
                  <SectionHeading label={s.label} />
                  {renderSectionContent(s.id, settings, q)}
                </div>
              ))
            )
          ) : (
            <>
              <SectionHeading label={SECTIONS.find((s) => s.id === section)?.label ?? ''} />
              {renderSectionContent(section as SettingSectionId, settings, null)}
            </>
          )}
        </div>
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
