/**
 * git/graphKeys.ts — Git 图表面的裸键语义（git-graph.md §4.3；从 main.tsx
 * 提取——git 域键位归 git/，装配层只注入路由读侧与工作区读侧）。
 *
 * 激活判定：当前路由是 /workspace/$id 且该工作区 paneTab==='git'，
 * 或活跃会话正显示会话内 git 视图（最新原型 SessionTabs 'git' tab）。
 * 非激活必返回 false 透传（硬约束 2：不吃 vim/claude 按键）；
 * 输入框聚焦时上游键位层（keybindings.ts）已挡，本层不重复判。
 */

import type { Workspace } from '../threads/workspaces'
import type { GitGraphStore } from './store'

export function createGitGraphKey(opts: {
  /** 当前路由指向的工作区 id（装配层 = router 的 currentActiveWorkspaceId） */
  activeWorkspaceId: () => string | null
  /** 工作区列表读侧（装配层 = threadStore.getState().workspaces） */
  workspaces: () => readonly Workspace[]
  /** 会话内 git 视图激活判定（装配层读 active thread 的 activeViewId） */
  activeSessionGitView?: () => boolean
  store: Pick<GitGraphStore, 'moveSelection' | 'select' | 'refresh'>
}): (key: string) => boolean {
  return (key) => {
    const wsId = opts.activeWorkspaceId()
    const ws = wsId ? opts.workspaces().find((w) => w.id === wsId) : undefined
    const gitPageActive = (ws && ws.paneTab === 'git') || opts.activeSessionGitView?.()
    if (!gitPageActive) return false
    switch (key) {
      case 'down':
      case 'arrowdown':
        opts.store.moveSelection(1)
        return true
      case 'up':
      case 'arrowup':
        opts.store.moveSelection(-1)
        return true
      case 'enter':
        // 选中态即详情打开态（↑↓/点击已带），吃掉防透传
        return true
      case 'escape':
        opts.store.select(null)
        return true
      case 'r':
        opts.store.refresh()
        return true
      default:
        return false
    }
  }
}
