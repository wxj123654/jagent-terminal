/**
 * Sidebar — 左栏（布局契约 §2/§3：248px 固定宽）。
 *
 * Phase W2 起结构：搜索框（跨工作区搜会话；Esc 清空）→ WorkspaceList
 * （工作区分组树 + 添加工作区；新建入口 = 工作区行 ＋ 的 ToolMenu）→
 * Footer(齿轮 → settings 表面)。原 NewThreadButton/ThreadList 平铺形态
 * 由 WorkspaceList 取代（TopBar 常驻新建钮移除：入口唯一化到工作区行，
 * 无「当前工作区」歧义）。
 */

import { useState } from 'react'

import type { SettingsStore } from '../settings/store'
import type { ThreadStore } from '../threads/store'
import { Icon } from '../ui/Icon'
import { inputFocus } from '../ui/keyboard'
import type { AppPlatform } from '../ui/platform'
import { TRAFFIC_LIGHT_WIDTH } from '../ui/platform'
import { COLORS, FONT, SIZES } from '../ui/tokens'
import type { DialogOpener } from './DialogHost'
import { sidebarKeyboard } from './sidebarKeyboard'
import { useTitleBarDrag, type WindowControls } from './TitleBar'
import { WorkspaceList } from './WorkspaceList'

/**
 * 顶栏左段：AGENT 标识 + 线程切换 hint。mac 上给红绿灯让位（Zed：
 * sidebar 打开时 TRAFFIC_LIGHT_PADDING 在这一段，TitleBar 段不加）；
 * mac 同样可拖窗口（TitleBar 同款 armed+move 模式）；win 标 drag 区。
 */
export function SidebarHeader({
  platform,
  windowControls,
}: {
  platform: AppPlatform
  windowControls?: WindowControls
}) {
  const drag = useTitleBarDrag(windowControls)
  return (
    <div
      testId="sidebar-header"
      style={{
        width: SIZES.sidebarWidth,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: SIZES.titleBarHeight,
        // 不把 padding 放在横向 flex item 上：gpuix 的 padding 不计入
        // flex 占位，会让本段从 x=TRAFFIC_LIGHT_WIDTH 开始并把 TitleBar
        // 推出窗口。用子项 margin 保留视觉内缩，本段严格占满 248px。
        // 与 TitleBar 同色：顶栏行是一条连续表面，不是侧栏顶盖。
        backgroundColor: COLORS.titlebar,
        userSelect: 'none',
        ...(platform === 'win' ? { windowControlArea: 'drag' as const } : {}),
      }}
      {...(platform === 'mac' ? drag : {})}
    >
      <text
        testId="sidebar-header-label"
        style={{
          marginLeft: (platform === 'mac' ? TRAFFIC_LIGHT_WIDTH : 0) + 12,
          // GPUI 文本基线略高于几何中心；+1px 与系统红绿灯光学对齐。
          marginTop: 1,
          fontSize: 11,
          fontFamily: FONT.ui,
          fontWeight: '600',
          color: COLORS.muted,
        }}
      >
        AGENT
      </text>
      <text
        style={{
          marginRight: 10,
          marginTop: 1,
          fontSize: 10,
          fontFamily: FONT.mono,
          color: COLORS.muted,
        }}
      >
        ⌃⇥
      </text>
    </div>
  )
}

export function Sidebar({
  store,
  settings,
  onEscEmpty,
  dialog,
}: {
  store: ThreadStore
  settings: SettingsStore
  /** Esc 层级最低层（W4）：query 空 + Esc → 窄窗口抽屉关闭（宽窗口 no-op） */
  onEscEmpty?: () => void
  /** 弹窗入口（W7）：⌘K 搜索/添加工作区 */
  dialog: DialogOpener
}) {
  const [query, setQuery] = useState('')

  return (
    <div
      style={{
        width: SIZES.sidebarWidth,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: COLORS.sidebar,
        borderWidth: 0,
        borderRightWidth: 1,
        borderColor: COLORS.border,
      }}
    >
      {/* 搜索会话（跨工作区：标题/工具/目录；非空时列表切搜索结果） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          marginTop: 6,
          marginLeft: 10,
          marginRight: 10,
          marginBottom: 6,
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
            sidebarKeyboard.setSearchInput(r?.id ?? null)
          }}
          testId="session-search"
          value={query}
          placeholder="搜索会话"
          onChange={(e) => {
            setQuery(e.value ?? '')
            sidebarKeyboard.setQuery(e.value ?? '')
          }}
          onFocus={() => inputFocus.acquire()}
          onBlur={() => inputFocus.release()}
          onKeyDown={(e) => {
            // Esc 层级（W4）：非空清空 → 空+抽屉态关抽屉（onEscEmpty）
            if (e.key === 'escape') {
              if (query) {
                setQuery('')
                sidebarKeyboard.setQuery('')
              } else {
                onEscEmpty?.()
              }
            }
          }}
          style={{
            flexGrow: 1,
            fontSize: 12,
            fontFamily: FONT.ui,
            color: COLORS.text,
          }}
        />
      </div>

      <WorkspaceList store={store} settings={settings} query={query} dialog={dialog} />

      {/* Footer：设置入口（Ctrl-, 同效，见 main.tsx 键位层） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          height: 34,
          paddingLeft: 12,
          borderTopWidth: 1,
          borderColor: COLORS.border,
        }}
      >
        <div
          tabIndex={0}
          testId="open-settings"
          onClick={() => store.activate({ type: 'settings' })}
          onKeyDown={(e) => {
            if (e.key === 'enter') store.activate({ type: 'settings' })
          }}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            height: 24,
            paddingLeft: 6,
            paddingRight: 6,
            borderRadius: 4,
            cursor: 'pointer',
            hover: { backgroundColor: COLORS.surface },
          }}
        >
          <Icon name="gear" size={13} color={COLORS.muted} />
          <text
            style={{
              fontSize: 12,
              fontFamily: FONT.ui,
              color: COLORS.muted,
              pointerEvents: 'none',
            }}
          >
            设置
          </text>
          <text
            style={{
              fontSize: 10,
              fontFamily: FONT.mono,
              color: COLORS.muted,
              pointerEvents: 'none',
            }}
          >
            Ctrl-,
          </text>
        </div>
      </div>
    </div>
  )
}
