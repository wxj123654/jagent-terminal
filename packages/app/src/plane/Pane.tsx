/**
 * Pane — 全项目唯一的表面调度（architecture.md §4）。
 *
 * 「整块替换」= 条件渲染：旧 surface 卸载、新 surface 挂载（无
 * display:none 藏匿）。retain 由两层保证：thread 记录在 ThreadStore、
 * 会话在 Rust TerminalPool（元素 destroy 只解绑视图）。
 *
 * 路由（§3.5）：/ → EmptyPresets · /thread/$id → 按 kind 查 registry ·
 * /settings → SettingsView（settings-ui.md §3：Pane 特殊表面，非 thread
 * kind——不进混排列表、不进 History）。
 */

import { useActiveTarget } from '../router'
import { useThreadStore } from '../threads/useThreadStore'
import type { ThreadStore } from '../threads/store'
import type { SettingsStore } from '../settings/store'
import { getSurface } from '../surfaces/registry'
import { EmptyPresets } from '../surfaces/EmptyPresets'
import { SettingsView } from '../surfaces/SettingsView'

export function Pane({ store, settings }: { store: ThreadStore; settings: SettingsStore }) {
  const active = useActiveTarget()
  const thread = useThreadStore(store, (s) =>
    active?.type === 'thread' ? s.threads.find((t) => t.id === active.id) : undefined,
  )

  if (active?.type === 'settings') return <SettingsView settings={settings} />
  if (!thread) return <EmptyPresets onPick={(id) => void store.spawnFromPreset(id)} settings={settings} />
  const S = getSurface(thread.kind)
  return <S thread={thread} store={store} settings={settings} />
}
