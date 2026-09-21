/**
 * threads/internal/workspaceOps.ts — 工作区簇（Phase W；交互契约
 * design/workspace-plane.md）。
 *
 * 规则单点：
 * - CRUD：add/rename/remove（空串忽略；空名回退 basename(path)）；
 *   remove 连带 close 归属会话——复用 ctx.close 单点（destroy/dispose/
 *   导航兑底同一实现），再移除行 + 路由兑底
 * - 状态位：expanded / showAll / pinned / paneTab（持久化不导航；
 *   paneTab 'home'/'git' 是工作区内 tab，git-graph.md §4.1）
 * - activateWorkspace：恢复 lastSession（死 id/无 → 工作区起始页），
 *   不改 expanded（点箭头仅展开/收起，与激活分离——原型契约）
 * - 会话行标记：setThreadPinned / setThreadUnread（不持久化）
 * - 每次 workspaces 变化后统一 ctx.persist()
 *
 * internal seam——只被 store.ts 装配调用，不对外导出。
 */

import { workspaceDisplayName, type Workspace } from '../workspaces'
import type { StoreCtx } from './ctx'

/** 新建工作区（name 空串回退 basename(path)）；返回 id */
export function addWorkspace(ctx: StoreCtx, name: string, path: string): string {
  const ws: Workspace = {
    id: `w${ctx.newId()}`,
    name: name.trim() || workspaceDisplayName(path),
    path,
    expanded: true,
    lastSession: null,
    paneTab: 'home',
    showAll: false,
    createdAt: ctx.now(),
  }
  ctx.set((s) => {
    s.workspaces.push(ws)
  })
  ctx.persist()
  return ws.id
}

/** 重命名（空串忽略，同 rename 纪律） */
export function renameWorkspace(ctx: StoreCtx, id: string, name: string): void {
  if (!name.trim()) return
  ctx.set((s) => {
    const ws = s.workspaces.find((w) => w.id === id)
    if (ws) ws.name = name.trim()
  })
  ctx.persist()
}

/** 移除工作区：连带 close 其全部会话（destroy/dispose/导航兑底同
 *  close）+ 移除行。首个被 close 的 active thread 会先导航到本工作区
 *  起始页；后续 close 的 routerPointsAt 已 false，不再额外导航 */
export function removeWorkspace(ctx: StoreCtx, id: string): void {
  if (!ctx.state().workspaces.some((w) => w.id === id)) return
  for (const victim of ctx.state().threads.filter((t) => t.workspaceId === id)) {
    ctx.close(victim.id)
  }
  ctx.set((s) => {
    s.workspaces = s.workspaces.filter((w) => w.id !== id)
  })
  // 工作区已删：路由若指向它的起始页（close 兑底或用户停在空态）→
  // 回全局起始页（EmptyPresets 兑底）；非 active 不导航
  if (ctx.deps.activeWorkspaceId?.() === id) ctx.activate(null)
  ctx.persist()
}

/** 切换工作区（点行）：恢复 lastSession（存在则 activate，否则回起始页）。
 *  不改 expanded（点箭头仅展开/收起，与激活分离——原型契约）。
 *  activate 内部会再写 lastSession（幂等，同 id 无害） */
export function activateWorkspace(ctx: StoreCtx, id: string): void {
  const ws = ctx.state().workspaces.find((w) => w.id === id)
  if (!ws) return
  const target = ws.lastSession
    ? ctx.state().threads.find((t) => t.id === ws.lastSession)
    : undefined
  ctx.activate(target ? { type: 'thread', id: target.id } : { type: 'workspace', id })
}

/** 展开/收起分组（持久化，不导航） */
export function toggleWorkspaceExpanded(ctx: StoreCtx, id: string): void {
  ctx.set((s) => {
    const ws = s.workspaces.find((w) => w.id === id)
    if (ws) ws.expanded = !ws.expanded
  })
  ctx.persist()
}

/** 显示全部 / 只显前 4 条优先项（codex-sidebar-v2 截断；持久化，不导航） */
export function setWorkspaceShowAll(ctx: StoreCtx, id: string, showAll: boolean): void {
  ctx.set((s) => {
    const ws = s.workspaces.find((w) => w.id === id)
    if (ws) ws.showAll = showAll
  })
  ctx.persist()
}

/** 工作区置顶（项目菜单 Pin；持久化，不导航） */
export function setWorkspacePinned(ctx: StoreCtx, id: string, pin: boolean): void {
  ctx.set((s) => {
    const ws = s.workspaces.find((w) => w.id === id)
    if (ws) ws.pin = pin
  })
  ctx.persist()
}

/** 工作区内 tab（git-graph.md §4.1）：'home'/'git'；持久化，不导航 */
export function setWorkspacePaneTab(ctx: StoreCtx, id: string, tab: 'home' | 'git'): void {
  ctx.set((s) => {
    const ws = s.workspaces.find((w) => w.id === id)
    if (ws && ws.paneTab !== tab) ws.paneTab = tab
  })
  ctx.persist()
}

/** 会话置顶（codex-sidebar-v2 行菜单 Pin；不持久化，不导航） */
export function setThreadPinned(ctx: StoreCtx, id: string, pin: boolean): void {
  ctx.set((s) => {
    const t = s.threads.find((x) => x.id === id)
    if (t) t.pin = pin
  })
}

/** 会话未读标记（行菜单 Mark as unread；activate 清除——待办语义） */
export function setThreadUnread(ctx: StoreCtx, id: string, unread: boolean): void {
  ctx.set((s) => {
    const t = s.threads.find((x) => x.id === id)
    if (t) t.unread = unread
  })
}

/** 显式传入的 workspaceId 必须存在（调用方 bug 早暴露；spawn 侧已内联同判） */
export function assertWorkspace(ctx: StoreCtx, id: string | undefined): void {
  if (id != null && !ctx.state().workspaces.some((w) => w.id === id)) {
    throw new Error(`unknown workspace: ${id}`)
  }
}
