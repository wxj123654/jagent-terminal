/**
 * Pane — 全项目唯一的表面调度（architecture.md §4）。
 *
 * 「整块替换」= 条件渲染：旧 surface 卸载、新 surface 挂载（无
 * display:none 藏匿）。retain 由两层保证：thread 记录在 ThreadStore、
 * 会话在 Rust TerminalPool（元素 destroy 只解绑视图）。
 *
 * 路由（§3.5）：/ → EmptyPresets · /thread/$id → 按 kind 查 registry ·
 * /settings → SettingsView（Phase 2；先占位）。
 */

import { useActiveTarget } from '../router'
import { useThreadStore } from '../threads/useThreadStore'
import type { ThreadStore } from '../threads/store'
import { getSurface } from '../surfaces/registry'
import { EmptyPresets } from '../surfaces/EmptyPresets'
import { COLORS, FONT } from './tokens'

function SettingsPlaceholder() {
  return (
    <div
      style={{
        flexGrow: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: COLORS.pane,
      }}
    >
      <text style={{ color: COLORS.muted, fontSize: 13, fontFamily: FONT.ui }}>
        settings — Phase 2（T2.4 SettingsView）
      </text>
    </div>
  )
}

export function Pane({ store }: { store: ThreadStore }) {
  const active = useActiveTarget()
  const thread = useThreadStore(store, (s) =>
    active?.type === 'thread' ? s.threads.find((t) => t.id === active.id) : undefined,
  )

  if (active?.type === 'settings') return <SettingsPlaceholder />
  if (!thread) return <EmptyPresets onPick={(id) => void store.spawnFromPreset(id)} />
  const S = getSurface(thread.kind)
  return <S thread={thread} store={store} />
}
