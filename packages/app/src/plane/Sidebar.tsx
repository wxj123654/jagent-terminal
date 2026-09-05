/**
 * Sidebar — 左栏（布局契约 §2/§3：248px 固定宽）。
 *
 * 顶部 Header 行已抽为 SidebarHeader：与 TitleBar 同处「顶栏行」
 * （Zed 融合模式：红绿灯让位由 SidebarHeader 承担，见 plane/TitleBar.tsx）。
 * 本体：NewThreadButton · ThreadList · Footer(齿轮 → settings 表面)。
 */

import type { SettingsStore } from '../settings/store'
import type { ThreadStore } from '../threads/store'
import { Icon } from '../ui/Icon'
import type { AppPlatform } from '../ui/platform'
import { TRAFFIC_LIGHT_WIDTH } from '../ui/platform'
import { COLORS, FONT, SIZES } from '../ui/tokens'
import { NewThreadButton } from './NewThreadButton'
import { ThreadList } from './ThreadList'
import { useTitleBarDrag, type WindowControls } from './TitleBar'

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

export function Sidebar({ store, settings }: { store: ThreadStore; settings: SettingsStore }) {
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
      <NewThreadButton store={store} settings={settings} />

      <ThreadList store={store} />

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
