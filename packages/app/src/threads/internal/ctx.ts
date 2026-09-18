/**
 * threads/internal/ctx.ts — 内部模块共享上下文（internal seam）。
 *
 * ThreadStore 的实现按簇拆进 internal/*（sessionViews / notices /
 * workspaceOps / conversations），接口不变——本文件是它们共同依赖的
 * 上下文：state/set/deps/ambient 环境 + 跨簇调用接线点。
 *
 * 跨簇调用尽量单向 import（sessionViews → notices）；只有会成环的边
 * （workspaceOps → close、notices → activateSessionView）经 ctx 字段
 * 接线——装配顺序在 createThreadStore 一处可见。
 *
 * internal/* 不对外导出：外部一律走 threads/store.ts 的 ThreadStore
 * interface（interface 即测试面）。
 */

import type { ActiveTarget } from '../../router'
import type { ChatAgent } from '../chat'
import type { ThreadDeps, ThreadState } from '../store'

export type StoreCtx = {
  /** 快照（zustand getState；immer 结构共享保证稳定引用） */
  state: () => ThreadState
  /** 可变写法更新（immer produce 负责不可变化） */
  set: (recipe: (s: ThreadState) => void) => void
  deps: ThreadDeps
  /** 表面切换单点（清 bell/unread/notice + lastSession 记录 + deps.navigate） */
  activate: (target: ActiveTarget) => void
  /** workspaces 变化后统一持久化出口（fire-and-forget） */
  persist: () => void
  /** 时钟（createdAt / 消息 at / 通知 at） */
  now: () => number
  /** id 生成（c/a/w 前缀的 uuid） */
  newId: () => string
  /** cwd 继承链兜底（preset.cwd ?? workspace.path ?? 本项） */
  defaultCwd: () => string
  /** 路由读侧：当前指向的 thread（缺省 null = 保守视为非 active） */
  activeThreadId: () => string | null
  /** acp thread → 连接实例（情建；close 时 dispose。不进 state——纯运行时资源） */
  acpAgents: Map<string, ChatAgent>
  /** chat 消息 id 自增（实例级——跨 store 实例不共享，测试互不污染） */
  nextMsgId: () => string
  /** 通知条目 id 自增（同 msgSeq 纪律） */
  nextNoticeId: () => string
  // ── 跨簇接线点（createThreadStore 装配；只接会成环的边）─────────────
  /** 会话移除单点（removeWorkspace 连带 close 归属会话用——close 在 store.ts） */
  close: (id: string) => void
  /** 视图激活（openNotice 直达来源视图用——notices→sessionViews 直接
   *  import 会成环：sessionViews 已单向 import notices） */
  activateSessionView: (threadId: string, viewId: string) => void
}
