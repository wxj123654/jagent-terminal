/**
 * Sidebar — 左栏（布局契约 §2/§3；宽度 = appearance.sidebarWidth，
 * 200–400，设置 → 外观 → 侧栏宽度拖拽实时写回）。
 *
 * Phase W2 起结构：搜索框（跨工作区搜会话；Esc 清空）→ WorkspaceList
 * （工作区分组树 + 添加工作区；新建入口 = 工作区行 ＋ 的 ToolMenu）→
 * Footer(齿轮 → settings 表面)。原 NewThreadButton/ThreadList 平铺形态
 * 由 WorkspaceList 取代（TopBar 常驻新建钮移除：入口唯一化到工作区行，
 * 无「当前工作区」歧义）。
 */

import { useState } from 'react'

import type { AppPlatform } from '@jagent/ui'
import { Icon, TRAFFIC_LIGHT_WIDTH, COLORS, FONT } from '@jagent/ui'
import type { SettingsStore } from '../settings/store'
import { useSettingsValue } from '../settings/useSettings'
import type { ThreadStore } from '../threads/store'
import { SIZES } from '../tokens'
import type { DialogOpener } from './DialogHost'
import { useTitleBarDrag, type WindowControls } from './TitleBar'
import { WorkspaceList } from './WorkspaceList'
/**
 * 顶栏左段：v2 侧栏头（52px；Phase D0）。mac 上给红绿灯让位 78px，
 * 无 AGENT 标识（v2 去品牌字）；侧栏收起钮已移至 TitleBar 常驻（D4：
 * 侧栏隐藏后仍需鼠标恢复入口，不能随侧栏一起卸载）。
 * mac/linux 可拖窗口（armed+move）；win 标 drag 区。
 * 宽 = 侧栏宽（AgentPlane 从 settings 订阅后传入，与内容行对齐）。
 */
export function SidebarHeader({
  platform,
  windowControls,
  width,
}: {
  platform: AppPlatform
  windowControls?: WindowControls
  /** 与内容行侧栏同宽（appearance.sidebarWidth） */
  width: number
}) {
  const drag = useTitleBarDrag(windowControls)
  return (
    <div
      testId="sidebar-header"
      style={{
        width,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: SIZES.sidebarHeadHeight,
        // 不把 padding 放在横向 flex item 上：gpuix 的 padding 不计入
        // flex 占位（会让本段从 x=78 开始并把工具栏推出窗口）；用子项 margin 保留视觉内缩。
        // v2：侧栏头底 = 侧栏底 #000（不再与工具栏同色——两段分属侧栏/主栏）。
        backgroundColor: COLORS.sidebar,
        userSelect: 'none',
        ...(platform === 'win' ? { windowControlArea: 'drag' as const } : {}),
      }}
      {...(platform === 'mac' || platform === 'linux' ? drag : {})}
    >
      {/* 左占位：mac 红绿灯让位；win/linux 留对称内缩（收起钮已移
          TitleBar，此段只剩拖拽让位与对称内缩） */}
      <div style={{ width: (platform === 'mac' ? TRAFFIC_LIGHT_WIDTH : 0) + 10, flexShrink: 0 }} />
    </div>
  )
}

export function Sidebar({
  store,
  settings,
  onEscEmpty: _onEscEmpty,
  dialog,
}: {
  store: ThreadStore
  settings: SettingsStore
  /** Esc 层级最低层（W4）：query 空 + Esc → 窄窗口抽屉关闭（宽窗口 no-op）。
   *  v2：侧栏内搜索框已移除（⌘K 打开弹窗）；保留 prop 以兼容窄屏抽屉调用点 */
  onEscEmpty?: () => void
  /** 弹窗入口（W7）：⌘K 搜索/添加工作区 */
  dialog: DialogOpener
}) {
  const [query] = useState('')
  // 宽度单值订阅：设置页拖滑块时只重渲染侧栏（不碰会话树）；
  // 其他 patch（如主题）因 selector 值稳定而不触发重渲染
  const width = useSettingsValue(settings, (s) => s.appearance.sidebarWidth)

  return (
    <div
      style={{
        width,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        // v2：侧栏底 = #000 + 顶部白 4.5%→25% 渐变（原型 sidebar 双层背景）。
        // gpuix 无渐变原语，用单层 #000 + 头部与 tile 叠层近似；分层由
        // WorkspaceList 的 tile 容器承担。
        backgroundColor: COLORS.sidebar,
        borderWidth: 0,
        borderRightWidth: 1,
        borderColor: COLORS.border,
      }}
    >
      {/* v2：搜索框上移到侧栏头（D0 与收起钮同段）后，列表区直接从双区开始 */}
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
