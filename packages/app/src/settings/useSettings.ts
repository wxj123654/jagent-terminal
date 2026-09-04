/**
 * settings/useSettings.ts — SettingsStore 的 React 订阅桥（useThreadStore 同款：
 * useSyncExternalStore 直桥）。getSnapshot 返回 store.getState().settings——
 * zustand set 每次产新对象（immer produce），引用稳定约定成立。
 */

import { useSyncExternalStore } from 'react'

import type { SettingsStore } from './store'
import type { Settings } from './schema'

/** 订阅整个 Settings 快照（设置面行数少，整树重渲染粒度足够） */
export function useSettings(store: SettingsStore): Settings {
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(onStoreChange),
    () => store.get(),
    () => store.get(),
  )
}
