/**
 * AgentPlane — 根组件（architecture.md §5 组件树；布局契约 §12 验收面）。
 *
 * 两行布局：顶栏行（SidebarHeader + TitleBar，Zed 融合模式——红绿灯让位
 * 由 SidebarHeader 承担）+ 内容行（sidebar 248px + pane 剩余）。store 经
 * props 注入（main.tsx 装配），组件树内部零全局单例——与 threads/store.ts
 * 的依赖注入纪律一致。windowControls 同为注入 seam（main.tsx 闭包
 * renderer；测试传 spy）。
 */

import { useWindowSize } from '@gpuix/react'
import { useState } from 'react'
import { useActiveTarget } from '../router'
import type { SettingsStore } from '../settings/store'
import { useSettingsValue } from '../settings/useSettings'
import type { ThreadStore } from '../threads/store'
import { displayTitle } from '../threads/terminal'
import { useThreadStore } from '../threads/useThreadStore'
import type { PerfSource } from '../ui/PerfHud'
import { PerfHud } from '../ui/PerfHud'
import { PLATFORM } from '../ui/platform'
import { COLORS, FONT } from '../ui/tokens'
import { Pane } from './Pane'
import { Sidebar, SidebarHeader } from './Sidebar'
import { TitleBar, type WindowControls } from './TitleBar'
import type { DirectoryPicker } from './WorkspaceList'

/** 窄窗口抽屉断点（原型 W0 契约）：低于此宽 sidebar 变 overlay 抽屉 */
const NARROW_BREAKPOINT = 760

/** 顶栏标题：当前线程 displayTitle · 设置 → '设置' · 空态 → 'j-agent' */
function useTitle(store: ThreadStore): string {
  const active = useActiveTarget()
  const thread = useThreadStore(store, (s) =>
    active?.type === 'thread' ? s.threads.find((t) => t.id === active.id) : undefined,
  )
  if (active?.type === 'settings') return '设置'
  if (!thread) return 'j-agent'
  return thread.kind === 'terminal' ? displayTitle(thread) : thread.title
}

export function App({
  store,
  settings,
  windowControls,
  pickDirectory,
  perfSource,
}: {
  store: ThreadStore
  settings: SettingsStore
  windowControls?: WindowControls
  /** 原生目录选择（W3；main.tsx 包装 native pickDirectory；缺省隐藏「浏览…」） */
  pickDirectory?: DirectoryPicker
  /** 性能 HUD 数据源（main.tsx 装配：takePaintPerf + process CPU/MEM 采样器；不传则 HUD 不挂载） */
  perfSource?: PerfSource
}) {
  const title = useTitle(store)
  // 窄窗口抽屉（W4）：useWindowSize poll 100ms（TestRenderer 无窗口面时
  // fallback 800×600 → 宽窗口态，测试零影响）
  const { width } = useWindowSize()
  const narrow = width < NARROW_BREAKPOINT
  // 侧栏宽（appearance.sidebarWidth，200–400）：顶栏左段 / 抽屉面板与内容行
  // 侧栏共用一个订阅点，值经 props 下流（依赖注入纪律，组件内不重复订阅）
  const sidebarWidth = useSettingsValue(settings, (s) => s.appearance.sidebarWidth)
  // 性能 HUD（advanced.perfHud）：单值订阅——开关切换才重渲染顶栏行
  const perfHud = useSettingsValue(settings, (s) => s.advanced.perfHud)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const sidebar = (
    <Sidebar
      store={store}
      settings={settings}
      pickDirectory={pickDirectory}
      onEscEmpty={narrow ? () => setDrawerOpen(false) : undefined}
    />
  )
  const pane = <Pane store={store} settings={settings} />
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: COLORS.app,
        fontFamily: FONT.ui,
        color: COLORS.text,
      }}
    >
      {/* 顶栏行（自绘 titlebar；mac 红绿灯悬浮在 SidebarHeader 段上方）。
          整行同色，避免左段 sidebar 色与右段 titlebar 色接缝。 */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          flexShrink: 0,
          backgroundColor: COLORS.titlebar,
          borderBottomWidth: 1,
          borderColor: COLORS.border,
        }}
      >
        <SidebarHeader platform={PLATFORM} windowControls={windowControls} width={sidebarWidth} />
        <TitleBar
          title={title}
          platform={PLATFORM}
          windowControls={windowControls}
          narrow={narrow}
          drawerOpen={drawerOpen}
          onToggleDrawer={narrow ? () => setDrawerOpen((v) => !v) : undefined}
          trailing={perfHud && perfSource ? <PerfHud source={perfSource} /> : null}
        />
      </div>
      {/* 内容行。窄窗口时 Pane 先、抽屉（Sidebar+scrim）后——GPUI 按树序
          绘制（CONSTRAINTS #2），后画的覆盖层才不会被 Pane 整块盖住。 */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          flexGrow: 1,
          minHeight: 0,
          position: 'relative',
        }}
      >
        {narrow ? (
          <>
            {pane}
            {drawerOpen ? (
              <>
                <div
                  testId="drawer-scrim"
                  onClick={() => setDrawerOpen(false)}
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: '#00000099',
                  }}
                />
                <div
                  testId="drawer-panel"
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: sidebarWidth,
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  {sidebar}
                </div>
              </>
            ) : null}
          </>
        ) : (
          <>
            {sidebar}
            {pane}
          </>
        )}
      </div>
    </div>
  )
}
