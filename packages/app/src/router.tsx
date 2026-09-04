/**
 * router.ts — 路由树（architecture.md §3.5）。
 *
 * 只描述 URL 形状：`/` · `/thread/$id` · `/settings?section=$s`。
 * 不 import threads / surfaces / settings——业务模块消费 useActiveTarget()
 * 派生视图，导航唯一事实源是这里的 router 实例（memory history）。
 *
 * R-V1 结论（Phase 1 实测）：RouterProvider（依赖 React context + Matches
 * acknowledgment 时序）在 GPUIX reconciler 下崩溃——`router._rendered`
 * 未在 children 渲染前建立。按 §3.5 预案降级：不渲染 RouterProvider，
 * 用 `router.subscribe` + `useSyncExternalStore` 手动桥。路由树定义、
 * `useActiveTarget()`、`router.navigate(...)` 接口不变。
 */

import { createElement } from 'react'
import { useSyncExternalStore } from 'react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'

/**
 * 手动桥的快照版本号：router.state 每次访问组装新对象，直接当
 * getSnapshot 会触发 React 的 "should be cached" 无限循环；订阅回调里
 * 递增版本号，getSnapshot 返回原始值（引用稳定），渲染时现读 pathname。
 *
 * 订阅源是 router.history（单参 listener，导航第一时间触发）而非
 * router.subscribe——后者是事件级 API（需 eventType 首参）。
 *
 * **Transitioner 契约**：router-core 在 `history.subscribers` 非空时
 * 不自行 `load()`（等框架层的 Transitioner 驱动，core router.js:419），
 * 所以本桥的订阅回调必须调 `router.load()`——否则第二次导航起挂起
 * （实测：settings → '/' 永不生效）。navigate 一律 fire-and-forget
 * （promise 的 resolve 依赖 Matches 的 acknowledgment，手动桥下不触发）。
 */
let snapshotVersion = 0
const subscribeRouter = (onStoreChange: () => void) =>
  router.history.subscribe(() => {
    void router.load()
    snapshotVersion++
    onStoreChange()
  })

export type ActiveTarget =
  | { type: 'thread'; id: string }
  | { type: 'settings' }
  | null

/** 路由占位组件——手动桥下路由树只是 URL 形状 + search 校验，不渲染。 */
function RouteSlot() {
  return createElement(Outlet)
}

const rootRoute = createRootRoute({ component: RouteSlot })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: RouteSlot,
})

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/thread/$id',
  component: RouteSlot,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  validateSearch: (search: Record<string, unknown>): { section?: string } => ({
    section: typeof search.section === 'string' ? search.section : undefined,
  }),
  component: RouteSlot,
})

const routeTree = rootRoute.addChildren([indexRoute, threadRoute, settingsRoute])

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ['/'] }),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

/** 从路由状态派生 ActiveTarget（手动桥：版本号快照 + 渲染期读 pathname）。 */
export function useActiveTarget(): ActiveTarget {
  useSyncExternalStore(subscribeRouter, () => snapshotVersion, () => snapshotVersion)
  return activeTargetFromLocation(router.history.location.pathname)
}

/** 纯函数：pathname → ActiveTarget（bun test 可直接测）。 */
export function activeTargetFromLocation(pathname: string): ActiveTarget {
  const m = /^\/thread\/(.+)$/.exec(pathname)
  if (m) return { type: 'thread', id: m[1] }
  if (pathname === '/settings') return { type: 'settings' }
  return null
}

/**
 * 装配层的 navigate 薄包装（ThreadDeps.navigate 的注入体）。
 * fire-and-forget：不 await（手动桥下 navigate 的 promise 不依赖）。
 */
export function navigateTarget(t: ActiveTarget): void {
  if (t === null) {
    void router.navigate({ to: '/' })
  } else if (t.type === 'settings') {
    void router.navigate({ to: '/settings' })
  } else {
    void router.navigate({ to: '/thread/$id', params: { id: t.id } })
  }
}

/** 装配层的路由读侧（ThreadDeps.activeThreadId 的注入体）。 */
export function currentActiveThreadId(): string | null {
  const t = activeTargetFromLocation(router.history.location.pathname)
  return t?.type === 'thread' ? t.id : null
}
