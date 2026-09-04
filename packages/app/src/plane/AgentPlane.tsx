/**
 * AgentPlane — 根组件（architecture.md §5 组件树；布局契约 §12 验收面）。
 *
 * flex：sidebar 248px + pane 剩余。store 经 props 注入（main.tsx 装配），
 * 组件树内部零全局单例——与 threads/store.ts 的依赖注入纪律一致。
 */

import type { ThreadStore } from '../threads/store'
import { COLORS, FONT } from '../ui/tokens'
import { Sidebar } from './Sidebar'
import { Pane } from './Pane'

export function App({ store }: { store: ThreadStore }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'row',
        backgroundColor: COLORS.app,
        fontFamily: FONT.ui,
        color: COLORS.text,
      }}
    >
      <Sidebar store={store} />
      <Pane store={store} />
    </div>
  )
}
