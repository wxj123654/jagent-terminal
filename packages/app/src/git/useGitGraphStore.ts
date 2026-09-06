/**
 * git/useGitGraphStore.ts — React 订阅 hook（threads/useThreadStore 同款直桥）。
 */

import { useSyncExternalStore } from 'react'

import type { GitGraphState, GitGraphStore } from './store'

export function useGitGraphStore<T>(store: GitGraphStore, selector: (s: GitGraphState) => T): T {
  const subscribe = store.subscribe
  const getSnapshot = () => selector(store.getState())
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
