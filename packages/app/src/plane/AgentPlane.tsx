/**
 * AgentPlane — 根组件（architecture.md §5 组件树；布局契约 §12 验收面）。
 *
 * 两行布局：顶栏行（SidebarHeader + TitleBar，Zed 融合模式——红绿灯让位
 * 由 SidebarHeader 承担）+ 内容行（sidebar 248px + pane 剩余）。store 经
 * props 注入（main.tsx 装配），组件树内部零全局单例——与 threads/store.ts
 * 的依赖注入纪律一致。windowControls 同为注入 seam（main.tsx 闭包
 * renderer；测试传 spy）。
 */

import { useActiveTarget } from '../router'
import type { SettingsStore } from '../settings/store'
import type { ThreadStore } from '../threads/store'
import { displayTitle } from '../threads/terminal'
import { useThreadStore } from '../threads/useThreadStore'
import { PLATFORM } from '../ui/platform'
import { COLORS, FONT } from '../ui/tokens'
import { Pane } from './Pane'
import { Sidebar, SidebarHeader } from './Sidebar'
import { TitleBar, type WindowControls } from './TitleBar'

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
}: {
  store: ThreadStore
  settings: SettingsStore
  windowControls?: WindowControls
}) {
  const title = useTitle(store)
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
      {/* 顶栏行（自绘 titlebar；mac 红绿灯悬浮在 SidebarHeader 段上方） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          flexShrink: 0,
          borderBottomWidth: 1,
          borderColor: COLORS.border,
        }}
      >
        <SidebarHeader platform={PLATFORM} windowControls={windowControls} />
        <TitleBar title={title} platform={PLATFORM} windowControls={windowControls} />
      </div>
      {/* 内容行 */}
      <div style={{ display: 'flex', flexDirection: 'row', flexGrow: 1, minHeight: 0 }}>
        <Sidebar store={store} settings={settings} />
        <Pane store={store} settings={settings} />
      </div>
    </div>
  )
}
