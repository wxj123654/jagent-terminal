/**
 * git/useWorktree.ts — WorktreeStore 的 React 订阅 hook
 * （threads/useThreadStore、git/useGitGraphStore 同款 useSyncExternalStore
 * 直桥）。原借住在 plane/WorkPanel.tsx 被 SessionTabs 反向消费；归域后
 * 与 store 同目录。
 */

import { useSyncExternalStore } from 'react'

import type { WorktreeStore } from './worktree'

export function useWorktree<T>(
  store: WorktreeStore,
  select: (s: ReturnType<WorktreeStore['getState']>) => T,
): T {
  return useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => select(store.getState()),
    () => select(store.getState()),
  )
}
