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
 * - linux：Client decorations（CSD）——请求 WM 去掉系统标题栏；
 *   拖拽区在标题文本段（不盖住右侧三键；gpuix JS 无 stopPropagation，
 *   不能靠冒泡切断）；三键 JS onClick → minimize/maximize/close
 *   （对齐 Zed platform_linux WindowControl）。
 *
 * title 由 AgentPlane 注入（当前线程 displayTitle / 设置 / 'j-agent'），
 * 本组件零 store 依赖，测试直接传字符串。
 */

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { AppPlatform } from '@jagent/ui'
import { Icon, TRAFFIC_LIGHT_WIDTH, COLORS, FONT, focusRing } from '@jagent/ui'
import { SIZES } from '../tokens'

/** 窗口控制 seam（main.tsx 装配：闭包 renderer；测试注入 spy） */
export type WindowControls = {
  startMove(): void
  doubleClick(): void
  /** Linux CSD caption buttons（mac/win 可缺省） */
  minimize?(): void
  maximize?(): void
  close?(): void
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

/** Linux CSD 右上三键：JS onClick（Zed platform_linux） */
function LinuxCaptionButton({
  area,
  icon,
  close,
  onPress,
}: {
  area: 'min' | 'max' | 'close'
  icon: 'minimize' | 'maximize' | 'close'
  close?: boolean
  onPress?: () => void
}) {
  return (
    <div
      testId={`titlebar-${area}`}
      onClick={() => onPress?.()}
      style={{
        width: 36,
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'auto',
        cursor: 'pointer',
        color: COLORS.text,
        hover: close
          ? { backgroundColor: '#E81120', color: '#ffffff' }
          : { backgroundColor: COLORS.surface, color: COLORS.textBright },
        active: close
          ? { backgroundColor: '#c50f1d', color: 'rgba(255,255,255,0.85)' }
          : { backgroundColor: COLORS.surfaceHover },
      }}
    >
      <Icon name={icon} size={12} />
    </div>
  )
}

function LinuxWindowControls({ windowControls }: { windowControls?: WindowControls }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100%', flexShrink: 0 }}>
      <LinuxCaptionButton area="min" icon="minimize" onPress={() => windowControls?.minimize?.()} />
      <LinuxCaptionButton area="max" icon="maximize" onPress={() => windowControls?.maximize?.()} />
      <LinuxCaptionButton
        area="close"
        icon="close"
        close
        onPress={() => windowControls?.close?.()}
      />
    </div>
  )
}

/** 上下文块（原型 .tb-context：图标 + 名称 + cwd；纯展示不交互） */
function ContextBlock({
  icon,
  label,
  cwd,
  narrow,
}: {
  icon: 'folder' | 'gear'
  label: string
  cwd?: string | null
  narrow?: boolean
}) {
  return (
    <div
      testId="tb-context"
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        minWidth: 0,
        paddingLeft: 12,
        paddingRight: 12,
        // 不交互——pe:none 让整条区域仍是顶栏拖拽面（mac/linux 拖拽冒泡
        // 不依赖它；win HTCAPTION 下非 auto 子区并入 drag）
        pointerEvents: 'none',
      }}
    >
      <Icon name={icon} size={13} color={COLORS.muted} />
      <text
        style={{
          fontSize: 12,
          fontWeight: '500',
          fontFamily: FONT.ui,
          color: COLORS.text,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }}
      >
        {label}
      </text>
      {!narrow && cwd ? (
        <text
          testId="toolbar-cwd"
          style={{
            minWidth: 0,
            maxWidth: 420,
            fontSize: 11.5,
            fontFamily: FONT.ui,
            color: COLORS.faint,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {cwd}
        </text>
      ) : null}
    </div>
  )
}

/** 分支钮（原型 .tb-branch-btn：border 方角小钮 + mono 分支名 + caret；
 *  点击 → Git 菜单，回调带点击坐标） */
function BranchButton({
  branch,
  onClick,
}: {
  branch: string
  onClick?: (pos: { x: number; y: number }) => void
}) {
  /** 行上最后一次指针位置（键盘打开菜单的定位兜底——GPUIX 无元素 bounds 读面） */
  const lastPointer = useRef({ x: 0, y: 0 })
  return (
    <div
      tabIndex={0}
      testId="chip-branch"
      onClick={(e) => onClick?.({ x: e.x ?? 0, y: e.y ?? 0 })}
      onMouseMove={(e) => {
        lastPointer.current = { x: e.x ?? 0, y: e.y ?? 0 }
      }}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onClick?.(lastPointer.current)
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        height: 28,
        minWidth: 28,
        maxWidth: 220,
        paddingLeft: 7,
        paddingRight: 7,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 6,
        backgroundColor: 'rgba(255,255,255,0.025)',
        boxShadow: {
          offsetX: 0,
          offsetY: 1,
          blurRadius: 2,
          spreadRadius: 0,
          color: 'rgba(0,0,0,0.18)',
        },
        color: COLORS.muted,
        cursor: 'pointer',
        flexShrink: 0,
        pointerEvents: 'auto',
        hover: { backgroundColor: COLORS.surface, borderColor: COLORS.exited },
      }}
    >
      <Icon name="gitBranch" size={14} color={COLORS.muted} />
      <text
        style={{
          minWidth: 0,
          fontSize: 12,
          fontFamily: FONT.mono,
          color: COLORS.text,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
          pointerEvents: 'none',
        }}
      >
        {branch}
      </text>
      <Icon name="chevronDown" size={12} color={COLORS.faint} />
    </div>
  )
}

/** 工具栏方钮（原型 .tb-cell：28px 高 / radius 6；on 态 = bg-active + 亮字） */
function ToolButton({
  icon,
  testId,
  on,
  onClick,
}: {
  icon: 'menu' | 'panelLeft' | 'panelRight' | 'search'
  testId: string
  on?: boolean
  onClick?: () => void
}) {
  const [focused, setFocused] = useState(false)
  return (
    <div
      tabIndex={0}
      testId={testId}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onClick?.()
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 28,
        height: 28,
        paddingLeft: 7,
        paddingRight: 7,
        borderRadius: 6,
        flexShrink: 0,
        cursor: 'pointer',
        // 同 tb-cell：win HTCAPTION 下必须 occlude 才可点
        pointerEvents: 'auto',
        backgroundColor: on ? COLORS.surfaceActive : 'transparent',
        boxShadow: focused ? focusRing() : undefined,
        hover: { backgroundColor: on ? COLORS.surfaceActive : COLORS.surfaceHover },
      }}
    >
      <Icon name={icon} size={15} color={on ? COLORS.textBright : COLORS.muted} />
    </div>
  )
}

/**
 * 自绘顶栏（最新原型 40d30e8 的 #titlebar：两行结构）：
 * - titlebar-main（40px）：[侧栏钮/抽屉钮] [上下文块（图标+名+cwd）]
 *   … [分支钮 → Git 菜单] [搜索（侧栏藏/窄屏）] [trailing] [面板钮] [三键]
 * - tb-tabs（36px）：SessionTabs（thread 路由）/ ContextTab（其它路由）
 *   ——由调用方以 `tabs` 插槽注入（路由态归 AgentPlane 装配）。
 *
 * 拖拽：mac 整条可拖（两行都挂）；linux 拖中段空白 + tab 行空白；
 * win 整条 windowControlArea drag。
 */
export function TitleBar({
  platform,
  windowControls,
  narrow,
  drawerOpen,
  onToggleDrawer,
  sidebarHidden,
  onToggleSidebar,
  contextIcon,
  contextLabel,
  cwd,
  branch,
  onBranchClick,
  onSearch,
  panelOpen,
  onTogglePanel,
  trailing,
  tabs,
}: {
  platform: AppPlatform
  windowControls?: WindowControls
  /** 窄窗口抽屉态（W4）：true 渲染汉堡钮（点击 toggle 抽屉） */
  narrow?: boolean
  drawerOpen?: boolean
  onToggleDrawer?: () => void
  /** 宽窗口侧栏收起态（D4）：true 时切换钮用 panelLeft 图标表示"恢复" */
  sidebarHidden?: boolean
  /** 侧栏开关（宽窗口收起/展开；与 ⌘B 同效）——常驻按钮，侧栏隐藏后仍可鼠标恢复 */
  onToggleSidebar?: () => void
  /** 上下文块（原型 .tb-context）：settings → gear，其余 → folder */
  contextIcon?: 'folder' | 'gear'
  contextLabel?: string
  /** 当前 cwd（窄屏隐藏；原型 .cwd 11.5px text-4） */
  cwd?: string | null
  /** 当前分支（null → 不渲染；窄屏隐藏。点击 → Git 菜单，回调带点击坐标） */
  branch?: string | null
  onBranchClick?: (pos: { x: number; y: number }) => void
  /** 搜索钮（原型 #btn-search：侧栏隐藏或窄屏时显） */
  onSearch?: () => void
  /** 工作面板开关（panelRight；on 态抬亮） */
  panelOpen?: boolean
  onTogglePanel?: () => void
  /** 右侧尾部插槽（ErrorIndicator / 性能 HUD 等；元素零依赖，数据源由调用方装配）。win 下落在窗口控制三键左侧 */
  trailing?: ReactNode
  /** 标签行内容（原型 #tb-tabs；调用方按路由装配 SessionTabs/ContextTab） */
  tabs?: ReactNode
}) {
  const drag = useTitleBarDrag(windowControls)
  const dragOnBar = platform === 'mac'
  const dragOnMid = platform === 'linux'
  const showSearch = !!onSearch && (narrow || sidebarHidden)
  // mac 侧栏收起时本条左端接替红绿灯让位（原型 .sidebar-hidden .toolbar
  // padding-left: 78px）；窄屏回到 12px。
  const padLeft = platform === 'mac' && sidebarHidden && !narrow ? TRAFFIC_LIGHT_WIDTH : 12
  return (
    <div
      testId="titlebar"
      style={{
        flexShrink: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: COLORS.titlebar,
        borderBottomWidth: 1,
        borderColor: COLORS.border,
        userSelect: 'none',
        ...(platform === 'win' ? { windowControlArea: 'drag' as const } : {}),
      }}
      {...(dragOnBar ? drag : {})}
    >
      {/* 主行（原型 #titlebar-main，--toolbarH 40px） */}
      <div
        testId="titlebar-main"
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 2,
          height: SIZES.toolbarHeight,
          minWidth: 0,
          paddingLeft: padLeft,
          // win/linux 三键贴窗口右缘（真实标题栏语义），mac 留 12px 内距
          paddingRight: platform === 'mac' ? 12 : 0,
          borderBottomWidth: 1,
          borderColor: COLORS.border,
        }}
      >
        {/* 侧栏开关（原型：侧栏可见时无 panelLeft 钮——收起入口在
            侧栏头；仅窄窗口汉堡钮 / 宽窗口收起态的恢复钮） */}
        {narrow ? (
          <ToolButton icon="menu" testId="drawer-toggle" on={drawerOpen} onClick={onToggleDrawer} />
        ) : sidebarHidden ? (
          <ToolButton icon="panelLeft" testId="toggle-sidebar" onClick={onToggleSidebar} />
        ) : null}

        {/* 上下文块（原型 .tb-context：folder/gear + 名 + cwd） */}
        <ContextBlock
          icon={contextIcon ?? 'folder'}
          label={contextLabel ?? 'j-agent'}
          cwd={cwd}
          narrow={narrow}
        />

        {/* 中段弹性空白（linux 拖拽挂这里——不盖住右侧按钮） */}
        <div
          testId="titlebar-drag"
          style={{ flexGrow: 1, minWidth: 0, height: '100%' }}
          {...(dragOnMid ? drag : {})}
        />

        {/* 分支钮（原型 .tb-branch-btn：border 方角 + mono + caret；
            点击 → Git 菜单（打开图 / 查看变更）；窄屏隐藏） */}
        {!narrow && branch ? <BranchButton branch={branch} onClick={onBranchClick} /> : null}

        {/* 搜索入口（原型 #btn-search：仅侧栏隐藏/窄屏显——其余在侧栏头） */}
        {showSearch ? (
          <ToolButton icon="search" testId="toolbar-search" onClick={onSearch} />
        ) : null}

        {/* 尾部插槽（ErrorIndicator / HUD）：win 下在三键左侧。整条标 drag
            时必须 pointerEvents auto，否则 HTCAPTION 抢在按钮前。 */}
        {trailing ? (
          <div
            testId="titlebar-trailing"
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 2,
              flexShrink: 0,
              pointerEvents: 'auto',
            }}
          >
            {trailing}
          </div>
        ) : null}

        {/* 工作面板开关（原型 #btn-panel） */}
        <ToolButton
          icon="panelRight"
          testId="panel-toggle"
          on={panelOpen}
          onClick={onTogglePanel}
        />

        {/* 窗口控制（原型 .win-ctl：左边框分隔 + 内距；win 三键由系统
            NC 处理，linux CSD 走 JS seam） */}
        {platform === 'win' || platform === 'linux' ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              alignSelf: 'stretch',
              flexShrink: 0,
              borderLeftWidth: 1,
              borderColor: COLORS.border,
              paddingLeft: 6,
              marginLeft: 4,
            }}
          >
            {platform === 'win' ? (
              <WindowsWindowControls />
            ) : (
              <LinuxWindowControls windowControls={windowControls} />
            )}
          </div>
        ) : null}
      </div>

      {/* 标签行（原型 #tb-tabs，--tabbarH 36px；app 底色 + 4/6 内距） */}
      <div
        testId="tb-tabs"
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'stretch',
          gap: 3,
          height: SIZES.tabBarHeight,
          minWidth: 0,
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 6,
          paddingRight: 6,
          backgroundColor: COLORS.app,
          overflow: 'hidden',
        }}
        {...(dragOnMid ? drag : {})}
      >
        {tabs}
      </div>
    </div>
  )
}
