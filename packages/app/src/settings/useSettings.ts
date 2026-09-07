/**
 * settings/useSettings.ts — SettingsStore 的 React 订阅桥（useThreadStore 同款：
 * useSyncExternalStore 直桥）。getSnapshot 返回 store.getState().settings——
 * zustand set 每次产新对象（immer produce），引用稳定约定成立。
 */

import { useSyncExternalStore } from 'react'

import type { Settings } from './schema'
import type { SettingsStore } from './store'

/** 订阅整个 Settings 快照（设置面行数少，整树重渲染粒度足够） */
export function useSettings(store: SettingsStore): Settings {
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(onStoreChange),
    () => store.get(),
    () => store.get(),
  )
}

/**
 * 订阅 Settings 的单一切片（selector 返回原始值/稳定引用才不会每 patch
 * 重渲染——任意 patch 都触发 notify，React 重取 snapshot 比较后才决定
 * 是否重渲染）。侧栏宽度这类被布局面（AgentPlane/Sidebar/ToolMenu）消费的
 * 单值用这个，避免在设置页拖任意滑块时重渲染整棵 App（含大会话树）。
 */
export function useSettingsValue<T>(store: SettingsStore, select: (s: Settings) => T): T {
  return useSyncExternalStore(
    (onStoreChange) => store.subscribe(onStoreChange),
    () => select(store.get()),
    () => select(store.get()),
  )
}
