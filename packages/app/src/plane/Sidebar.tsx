/**
 * Sidebar — 左栏整列（codex-sidebar-v2 方案 C：头 + 列表 + 脚，52/…/34px）。
 *
 * 结构（方案 C 原型 .sb）：
 * - 头（52px，.head）：mac 红绿灯让位 78px + 单个收起钮（⌘B 同效）。
 *   新建/搜索下移为 WorkspaceList 顶部 nav 行组。窗口拖拽同顶栏。
 * - WorkspaceList（滚动区）：nav 行组 + 工作区分组（含「未归属」虚拟组）。
 * - 脚（34px，.foot）：设置齿轮 + 通知铃（未读红点 + 锚定上方浮层）
 *   + 右侧版本号。
 *
 * 宽度 = appearance.sidebarWidth（200–400，设置拖拽实时写回）。
 */

import { useState } from 'react'

import { useWindowSize } from '@gpuix/react'
import type { AppPlatform } from '@jagent/ui'
import { Icon, IconButton, Popover, TRAFFIC_LIGHT_WIDTH, COLORS, FONT } from '@jagent/ui'
import type { SettingsStore } from '../settings/store'
import { useSettingsValue } from '../settings/useSettings'
import type { ThreadStore } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { relTime } from '../threads/workspaces'
import { SIZES } from '../tokens'
import type { DialogOpener } from './DialogHost'
import { useTitleBarDrag, type WindowControls } from './TitleBar'
import { WorkspaceList } from './WorkspaceList'

/**
 * 侧栏头（52px；方案 C 原型 .head）。mac 红绿灯让位 78px；单个收起钮
 * （panelLeft 图标，⌘B 同效——新建/搜索已下移为 nav 行组）。
 * mac/linux 可拖窗口；win 标 drag 区。
 */
export function SidebarHeader({
  platform,
  windowControls,
  width,
  onCollapse,
}: {
  platform: AppPlatform
  windowControls?: WindowControls
  /** 与侧栏列同宽（appearance.sidebarWidth）；独立渲染时传 */
  width?: number
  /** 收起整列（⌘B 同效；窄窗口 = 关抽屉） */
  onCollapse?: () => void
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
        height: SIZES.sidebarHeadHeight,
        // 不把 padding 放在横向 flex item 上：gpuix 的 padding 不计入
        // flex 占位——用子项 margin 保留视觉内缩。
        backgroundColor: COLORS.sidebar,
        userSelect: 'none',
        ...(platform === 'win' ? { windowControlArea: 'drag' as const } : {}),
      }}
      {...(platform === 'mac' || platform === 'linux' ? drag : {})}
    >
      {/* 左占位：mac 红绿灯让位；win/linux 留对称内缩 */}
      <div style={{ width: (platform === 'mac' ? TRAFFIC_LIGHT_WIDTH : 0) + 10, flexShrink: 0 }} />
      <IconButton
        name="panelLeft"
        label="收起侧栏"
        testId="sidebar-collapse"
        size={15}
        hitSize={28}
        radius={9999}
        tooltip={false}
        onClick={() => onCollapse?.()}
      />
    </div>
  )
}

/** 通知中心浮层（D8；原型 .notif-pop 锚定铃铛上方 8px） */
function NotifPopover({
  store,
  position,
  onClose,
}: {
  store: ThreadStore
  position: { x: number; y: number }
  onClose: () => void
}) {
  const notices = useThreadStore(store, (s) => s.notices)
  const TONE = { ok: COLORS.statusDone, warn: COLORS.statusRunning, err: COLORS.statusError }
  return (
    <Popover
      testId="notif-popover"
      position={position}
      anchor="bottomLeft"
      onClose={onClose}
      minWidth={300}
      style={{ maxWidth: 320, padding: 0 }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 12,
          paddingRight: 8,
          paddingTop: 10,
          paddingBottom: 8,
          borderBottomWidth: 1,
          borderColor: COLORS.border,
        }}
      >
        <text
          style={{
            fontSize: 13,
            fontFamily: FONT.ui,
            fontWeight: '500',
            color: COLORS.textBright,
            flexGrow: 1,
            pointerEvents: 'none',
          }}
        >
          通知
        </text>
        <div
          tabIndex={0}
          testId="notif-clear-all"
          onClick={() => store.markNoticesRead()}
          onKeyDown={(e) => {
            if (e.key === 'enter' || e.key === 'space') store.markNoticesRead()
          }}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            height: 20,
            paddingLeft: 7,
            paddingRight: 7,
            borderRadius: 4,
            cursor: 'pointer',
            hover: { backgroundColor: COLORS.surface },
          }}
        >
          <Icon name="check" size={10} color={COLORS.muted} />
          <text
            style={{
              fontSize: 10.5,
              fontFamily: FONT.ui,
              color: COLORS.muted,
              pointerEvents: 'none',
            }}
          >
            全部已读
          </text>
        </div>
      </div>
      <div style={{ maxHeight: 300, overflowY: 'scroll', paddingTop: 4, paddingBottom: 4 }}>
        {notices.length === 0 ? (
          <text
            style={{
              fontSize: 11.5,
              fontFamily: FONT.ui,
              color: COLORS.faint,
              padding: 14,
              textAlign: 'center',
              pointerEvents: 'none',
            }}
          >
            暂无通知
          </text>
        ) : (
          [...notices].reverse().map((n) => (
            <div
              key={n.id}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 8,
                paddingLeft: 12,
                paddingRight: 10,
                paddingTop: 7,
                paddingBottom: 7,
              }}
            >
              <div
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 9999,
                  backgroundColor: TONE[n.tone],
                  marginTop: 5,
                  flexShrink: 0,
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <text
                  style={{
                    fontSize: 11.5,
                    fontFamily: FONT.ui,
                    color: COLORS.text,
                    whiteSpace: 'normal',
                    pointerEvents: 'none',
                  }}
                >
                  {n.text}
                </text>
                <text
                  style={{
                    fontSize: 10,
                    fontFamily: FONT.mono,
                    color: COLORS.faint,
                    pointerEvents: 'none',
                  }}
                >
                  {`${n.sub} · ${relTime(n.at)}`}
                </text>
              </div>
            </div>
          ))
        )}
      </div>
    </Popover>
  )
}

export function Sidebar({
  store,
  settings,
  dialog,
  platform,
  windowControls,
  version,
  onNewSession,
  onCollapse,
}: {
  store: ThreadStore
  settings: SettingsStore
  /** 弹窗入口（W7）：⌘K 搜索/添加工作区 */
  dialog: DialogOpener
  platform: AppPlatform
  windowControls?: WindowControls
  /** 脚右侧版本号（装配层注入） */
  version?: string
  /** nav「新建会话」的目标（当前工作区；AgentPlane 算） */
  onNewSession?: () => void
  /** 头收起钮（⌘B 同效；窄窗口 = 关抽屉） */
  onCollapse?: () => void
}) {
  const [notifOpen, setNotifOpen] = useState(false)
  const { height: winH } = useWindowSize()
  // 宽度单值订阅：设置页拖滑块时只重渲染侧栏（不碰会话树）
  const width = useSettingsValue(settings, (s) => s.appearance.sidebarWidth)
  const unread = useThreadStore(store, (s) => s.notices.length - s.noticesRead)
  // 浮层锚定铃铛上方（原型 .notif-pop bottom:100%+8）：bottomLeft 角贴
  // 脚条上缘左端（GPUIX 无元素 bounds 读面，侧栏贴左底 → 窗口坐标可算）
  const notifPos = { x: 8, y: winH - 40 }

  return (
    <div
      testId="sidebar"
      style={{
        width,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: COLORS.sidebar,
        borderWidth: 0,
        borderRightWidth: 1,
        borderColor: COLORS.border,
        height: '100%',
      }}
    >
      <SidebarHeader platform={platform} windowControls={windowControls} onCollapse={onCollapse} />
      <WorkspaceList store={store} dialog={dialog} onNewSession={onNewSession} />

      {/* 脚（原型 .foot：padding 8 10 12 + 1px 顶部分隔线）：设置 + 通知铃（未读红点）+ 版本号 */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 2,
          paddingLeft: 10,
          paddingRight: 10,
          paddingTop: 8,
          paddingBottom: 12,
          borderTopWidth: 1,
          borderColor: COLORS.border,
          flexShrink: 0,
        }}
      >
        <IconButton
          name="gear"
          label="设置"
          testId="open-settings"
          size={15}
          hitSize={28}
          radius={9999}
          tooltip={false}
          onClick={() => store.activate({ type: 'settings' })}
        />
        <div style={{ position: 'relative' }}>
          <IconButton
            name="bell"
            label="通知"
            testId="open-notifications"
            size={15}
            hitSize={28}
            radius={9999}
            tooltip={false}
            onClick={() => setNotifOpen((v) => !v)}
          />
          {unread > 0 ? (
            <div
              testId="notif-unread-dot"
              style={{
                position: 'absolute',
                right: 4,
                top: 4,
                width: 7,
                height: 7,
                borderRadius: 9999,
                backgroundColor: COLORS.bell,
                borderWidth: 1.5,
                borderColor: COLORS.sidebar,
                pointerEvents: 'none',
              }}
            />
          ) : null}
        </div>
        <div style={{ flexGrow: 1 }} />
        {version ? (
          <text
            style={{
              // 「v{version}」是两个 text 子节点——flex row 防竖排折行
              display: 'flex',
              flexDirection: 'row',
              fontSize: 11,
              fontFamily: FONT.ui,
              color: COLORS.faint,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              pointerEvents: 'none',
            }}
          >
            {`v${version}`}
          </text>
        ) : null}
      </div>

      {notifOpen ? (
        <NotifPopover store={store} position={notifPos} onClose={() => setNotifOpen(false)} />
      ) : null}
    </div>
  )
}
