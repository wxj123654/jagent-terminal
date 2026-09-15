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
        // 右缘让出 6px 给侧栏拖拽把手：本头有不透明底色 → hitbox
        // （BlockMouseExceptScroll）会盖住先绘制的把手，头部区域 hover/
        // 拖拽都到不了把手。底色与侧栏同色，让位无视觉差异；win 下
        // drag 区右端少 6px，正好变成 resize 条。
        marginRight: 6,
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
      {/* win 下本头是 HTCAPTION drag 区：必须 occlude 才能赢过系统命中
          测试（TitleBar trailing 同款；否则点击被当拖拽吃掉） */}
      <div style={{ display: 'flex', pointerEvents: 'auto' }}>
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
            // 原型 .notif-head .t：12px/600
            fontSize: 12,
            fontFamily: FONT.ui,
            fontWeight: '600',
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
          <Icon name="check" size={12} color={COLORS.muted} />
          <text
            style={{
              fontSize: 11,
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
                    // 原型 .nt：12px text / line-height 1.4
                    fontSize: 12,
                    fontFamily: FONT.ui,
                    color: COLORS.text,
                    lineHeight: 17,
                    whiteSpace: 'normal',
                    pointerEvents: 'none',
                  }}
                >
                  {n.text}
                </text>
                <text
                  style={{
                    // 原型 .ns：10.5px faint
                    fontSize: 10.5,
                    fontFamily: FONT.ui,
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
  const [resizing, setResizing] = useState(false)
  const [resizeHover, setResizeHover] = useState(false)
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
      {/* 右缘拖拽把手（原型 .sb-resize：col-resize，拖拽实时写回
          appearance.sidebarWidth 200–400）。命中区 6px 透明；视觉指示
          是 2px accent 细线，仅 hover/拖拽时显示（6px 泛蓝太显眼）。
          mouseDown+mouseMove 组合 → renderer 自动 capture_pointer，
          拖出把手不中断（WorkPanel 左缘把手同款）。 */}
      <div
        testId="sidebar-resize"
        onMouseEnter={() => setResizeHover(true)}
        onMouseLeave={() => {
          setResizeHover(false)
          setResizing(false)
        }}
        onMouseDown={(e) => {
          if (e.button === 0) setResizing(true)
        }}
        onMouseUp={() => setResizing(false)}
        onMouseMove={(e) => {
          if (!resizing || e.pressedButton !== 0) return
          settings.patch(
            'appearance.sidebarWidth',
            Math.round(Math.min(400, Math.max(200, e.x ?? 0))),
          )
        }}
        style={{
          position: 'absolute',
          // 全收在侧栏内（不外探 -3）：Pane 后绘制，外探部分会被其
          // BlockMouse hitbox 截断 hit_test 而失效
          right: 0,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: 'col-resize',
          // 把手先绘制（hitbox 在栈底）：兄弟元素的 hitbox 压在上面会
          // 先封口 hover 集合（BlockMouseExceptScroll 处截止）——所以
          // SidebarHeader 用 marginRight:6 在头部区域让出这条命中带；
          // 列表/脚部无不透明底色不产生 hitbox，天然不挡
          pointerEvents: 'auto',
        }}
      />
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
                // 原型 .badge-dot：7px 点 + 1.5px 描边（CSS border 在盒外）。
                // gpuix 把 border 算进盒内 → 盒 10px 才等效 7px 点 + 描边；
                // 位置回退 1.5px 保持点中心不变
                position: 'absolute',
                right: 2.5,
                top: 2.5,
                width: 10,
                height: 10,
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

      {/* 指示线独立成最后绘制的兄弟节点：把手必须先画（hitbox 栈底，
          见上），accent 线若作其子节点会随把手一起被 header 底色与脚部
          分隔线盖住（顶部缺一段 + 底部 1px 缺口）。pointerEvents:none
          只画不挡命中 */}
      <div
        style={{
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: 2,
          backgroundColor: resizing || resizeHover ? COLORS.accent : 'transparent',
          pointerEvents: 'none',
        }}
      />

      {notifOpen ? (
        <NotifPopover store={store} position={notifPos} onClose={() => setNotifOpen(false)} />
      ) : null}
    </div>
  )
}
