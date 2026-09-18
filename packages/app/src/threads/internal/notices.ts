/**
 * threads/internal/notices.ts — 通知中心簇（D8）。
 *
 * 规则单点：bell/exit 等真实会话事件落列（容量 50 丢最旧；不持久化——
 * read 随条目走，无计数器不变量要维护）；activate 来源会话时自动标读
 * （在 store.ts activate 一处）；openNotice 标已读 + 跳来源会话，
 * 带 viewId 时经 ctx.activateSessionView 直达视图。
 *
 * internal seam——只被 store.ts 装配调用，不对外导出。
 */

import type { SessionNotice, Thread } from '../store'
import type { StoreCtx } from './ctx'

/** 通知落列：sub = 归属工作区名 / 未归属 + 可选原因（原型「dotfiles · BEL」
 *  格式）；viewId = 来源会话内视图（openNotice 直达） */
export function pushNotice(
  ctx: StoreCtx,
  t: Thread,
  tone: SessionNotice['tone'],
  text: string,
  opts: { reason?: string; viewId?: string } = {},
): void {
  ctx.set((s) => {
    const ws = t.workspaceId ? s.workspaces.find((w) => w.id === t.workspaceId) : undefined
    s.notices.push({
      id: ctx.nextNoticeId(),
      tone,
      text,
      sub: `${ws?.name ?? '未归属'}${opts.reason ? ` · ${opts.reason}` : ''}`,
      at: ctx.now(),
      threadId: t.id,
      read: false,
      viewId: opts.viewId,
    })
    if (s.notices.length > 50) s.notices.splice(0, s.notices.length - 50)
  })
}

/** exit 事件 → notice 语气（0/无码 = 正常退出 ok；非零 err）——主会话与视图共用 */
export function exitTone(code?: number): SessionNotice['tone'] {
  return code === 0 || code == null ? 'ok' : 'err'
}

/** 全部已读——红点清除，条目保留 */
export function markNoticesRead(ctx: StoreCtx): void {
  ctx.set((s) => {
    for (const n of s.notices) n.read = true
  })
}

/** 条目点击：标已读 + 来源会话仍在则 activate 跳转（已关闭仅标已读——
 *  路由不得指向不存在的行）；带 viewId 时一并激活该视图直达现场
 * （幂等——activate 会再标一次已读） */
export function openNotice(ctx: StoreCtx, noticeId: string): void {
  const n = ctx.state().notices.find((x) => x.id === noticeId)
  if (!n) return
  ctx.set((s) => {
    const row = s.notices.find((x) => x.id === noticeId)
    if (row) row.read = true
  })
  if (ctx.state().threads.some((t) => t.id === n.threadId)) {
    ctx.activate({ type: 'thread', id: n.threadId })
    if (n.viewId) ctx.activateSessionView(n.threadId, n.viewId)
  }
}
