/**
 * threads/useThreadStore.ts — React 侧订阅 hook（architecture.md §3.2/§5）。
 *
 * zustand React 包的 useStore 要求完整 StoreApi 类型；本项目的
 * ThreadStore 接口只暴露 getState/subscribe（注入纪律），所以这里用
 * useSyncExternalStore 直桥。selector 约定：返回原始值或稳定引用
 * （immer 结构共享保证 find(...) 引用不变即跳过渲染）。
 */

import { useSyncExternalStore } from 'react'

import type { ThreadState, ThreadStore } from './store'

export function useThreadStore<T>(store: ThreadStore, selector: (s: ThreadState) => T): T {
  const subscribe = store.subscribe
  const getSnapshot = () => selector(store.getState())
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
