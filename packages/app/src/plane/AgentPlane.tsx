/**
 * AgentPlane — 根组件（architecture.md §5 组件树的最小 Phase 1 形态）。
 *
 * flex：sidebar 248px + pane 剩余（布局契约 §12）。本文件 T1.5 扩成
 * Sidebar/ThreadList/ThreadRow/Pane；现在只搭最小 pane 调度，作为
 * R-V1 手动桥的验证载体（无 RouterProvider，见 router.tsx 结论注）。
 */

import { router, useActiveTarget } from '../router'

function PaneSlot() {
  const active = useActiveTarget()
  const label =
    active === null
      ? 'no thread (EmptyPresets → T1.5)'
      : active.type === 'settings'
        ? 'settings (SettingsView → Phase 2)'
        : `thread ${active.id}`
  return (
    <div style={{ flexGrow: 1, display: 'flex', padding: 16 }}>
      <text style={{ color: '#c5c8cc', fontSize: 14 }}>{label}</text>
    </div>
  )
}

export function App() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'row',
        backgroundColor: '#17181a',
      }}
    >
      <PaneSlot />
    </div>
  )
}
