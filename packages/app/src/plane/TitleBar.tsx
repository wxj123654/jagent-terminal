/**
 * TitleBar — 自绘顶栏（Zed platform_title_bar 模式的 j-agent 版；
 * 2026-09 调研 .refs/gpuix/zed 源码定稿）。
 *
 * 三平台策略：
 * - mac：titlebarTransparent，红绿灯由系统画在左上；本条拖拽 =
 *   mousedown 置 armed + 首次按住移动 → windowControls.startMove()
 *   （Zed 的 should_move 模式：等一次 move 才启动，单击/双击语义
 *   不被拖拽吃掉）；双击 → windowControls.doubleClick()（尊重系统
 *   「双击标题栏缩放」偏好）。
 * - win：无系统条；整条标 windowControlArea:"drag"，Windows 由
 *   WM_NCHITTEST → HTCAPTION 接管拖拽；右侧三键（Segoe Fluent
 *   Icons 字形）同样只标 min/max/close 区域，点击由系统 NC 消息
 *   处理——零 JS 点击回调。按钮必须 pointerEvents:"auto"：
 *   BlockMouse 命中盒把外层 drag 区从命中链切断，否则 HTCAPTION
 *   抢在按钮前（gpui hit_test 倒序遇 BlockMouse 即停；Zed 的
 *   WindowsCaptionButton 同款 .occlude()）。
 * - linux：默认 Server decorations（系统标题栏在上），本行是纯内容
 *   导航条——无 drag 标记、无窗口按钮。
 *
 * title 由 AgentPlane 注入（当前线程 displayTitle / 设置 / 'j-agent'），
 * 本组件零 store 依赖，测试直接传字符串。
 */

import { useState } from 'react'

import { Icon } from '../ui/Icon'
import type { AppPlatform } from '../ui/platform'
import { COLORS, FONT, SIZES } from '../ui/tokens'

/** 窗口控制 seam（main.tsx 装配：闭包 renderer；测试注入 spy） */
export type WindowControls = {
  startMove(): void
  doubleClick(): void
}

type DragProps = {
  onMouseDown?: (e: { button?: number }) => void
  onMouseUp?: () => void
  onMouseLeave?: () => void
  onMouseMove?: (e: { pressedButton?: number }) => void
  onClick?: (e: { clickCount?: number }) => void
}

/**
 * mac/linux 拖拽事件集（win 不用：命中测试驱动）。
 * armed + pressedButton===0 双保险；mouseleave 解除（Zed 用
 * on_mouse_down_out 同义）。
 */
export function useTitleBarDrag(wc: WindowControls | undefined): DragProps {
  const [armed, setArmed] = useState(false)
  if (!wc) return {}
  return {
    onMouseDown: (e) => {
      if (e.button === 0) setArmed(true)
    },
    onMouseUp: () => setArmed(false),
    onMouseLeave: () => setArmed(false),
    onMouseMove: (e) => {
      if (armed && e.pressedButton === 0) {
        setArmed(false)
        wc.startMove()
      }
    },
    onClick: (e) => {
      if (e.clickCount === 2) wc.doubleClick()
    },
  }
}

/** Windows 右上三键（Zed WindowsWindowControls：36px 宽全高，系统处理点击）
 *  gpui 的 font_family 是单名：direct_write.rs 的 GetMatchingFonts 按
 *  精确 family 名查找，无 CSS 引号/逗号列表解析——列表会整体查不到并
 *  fallback 到内嵌字体，私有区 glyph（U+E921…）无字形成豆腐块。
 *  Segoe MDL2 Assets 自 Win10 起自带且 Win11 保留，含所需 glyph；
 *  Segoe Fluent Icons 仅 Win11 有，不作首选。 */
const WIN_CAPTION_FONT = 'Segoe MDL2 Assets'

function WindowsCaptionButton({
  area,
  glyph,
  close,
}: {
  area: 'min' | 'max' | 'close'
  glyph: string
  close?: boolean
}) {
  return (
    <div
      testId={`titlebar-${area}`}
      style={{
        width: 36,
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // BlockMouse：切断外层 drag 区命中链（否则 HTCAPTION 抢先），
        // 同时也是按钮自身命中盒（系统 NC 处理点击）
        pointerEvents: 'auto',
        windowControlArea: area,
        color: COLORS.text,
        hover: close
          ? { backgroundColor: '#E81120', color: '#ffffff' }
          : { backgroundColor: COLORS.surface, color: COLORS.textBright },
        active: close
          ? { backgroundColor: '#c50f1d', color: 'rgba(255,255,255,0.85)' }
          : { backgroundColor: COLORS.surfaceHover },
      }}
    >
      <text
        style={{
          pointerEvents: 'none',
          fontFamily: WIN_CAPTION_FONT,
          fontSize: 10,
          // color 不写：继承 div 的 color / hover 伪类变色（gpuix 文本样式栈）
        }}
      >
        {glyph}
      </text>
    </div>
  )
}

function WindowsWindowControls() {
  // max 图标固定 e922（restore e923 需要 isMaximized 查询，gpuix 未暴露；
  // 系统点击行为不受影响，仅图标不随最大化态切换）
  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100%' }}>
      <WindowsCaptionButton area="min" glyph={'\uE921'} />
      <WindowsCaptionButton area="max" glyph={'\uE922'} />
      <WindowsCaptionButton area="close" glyph={'\uE8BB'} close />
    </div>
  )
}

export function TitleBar({
  title,
  platform,
  windowControls,
  narrow,
  drawerOpen,
  onToggleDrawer,
}: {
  title: string
  platform: AppPlatform
  windowControls?: WindowControls
  /** 窄窗口抽屉态（W4）：true 渲染汉堡钮（点击 toggle 抽屉） */
  narrow?: boolean
  drawerOpen?: boolean
  onToggleDrawer?: () => void
}) {
  const drag = useTitleBarDrag(windowControls)
  return (
    <div
      testId="titlebar"
      style={{
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        height: SIZES.titleBarHeight,
        backgroundColor: COLORS.titlebar,
        // 不把 padding 放在横向 flex item 上：gpuix 的 padding 会从
        // painted bounds 起点偏移并破坏本段与 sidebar 的对齐。mac 的
        // 红绿灯让位已由 SidebarHeader 承担，本段始终只留 12px 内容距。
        userSelect: 'none',
        ...(platform === 'win'
          ? { windowControlArea: 'drag' as const, justifyContent: 'space-between' }
          : {}),
      }}
      {...(platform === 'mac' ? drag : {})}
    >
      {narrow ? (
        <div
          testId="drawer-toggle"
          tabIndex={0}
          onClick={() => onToggleDrawer?.()}
          onKeyDown={(e) => {
            if (e.key === 'enter' || e.key === 'space') onToggleDrawer?.()
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: SIZES.titleBarHeight,
            flexShrink: 0,
            cursor: 'pointer',
            hover: { backgroundColor: COLORS.surfaceHover },
          }}
        >
          <Icon name="menu" size={13} color={drawerOpen ? COLORS.accent : COLORS.text} />
        </div>
      ) : null}
      <text
        testId="titlebar-title"
        style={{
          pointerEvents: 'none',
          marginLeft: 12,
          marginRight: platform === 'win' ? 0 : 12,
          marginTop: 1,
          minWidth: 0,
          flexGrow: 1,
          fontSize: 12,
          fontFamily: FONT.ui,
          fontWeight: '500',
          color: COLORS.text,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
        }}
      >
        {title}
      </text>
      {/* win：三键靠右（space-between：title 左、按钮右） */}
      {platform === 'win' && <WindowsWindowControls />}
    </div>
  )
}
