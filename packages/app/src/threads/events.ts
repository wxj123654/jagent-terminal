/**
 * threads/events.ts — SessionEvent 的判别联合窄化（architecture.md §2.2）。
 *
 * napi 生成的 SessionEvent.type 是 string（非判别联合）；在跨语言 seam
 * 的 JS 侧边界做一次窄化映射，store 消费端拿到可穷尽检查的联合类型。
 * index.d.ts 是生成物不可手改——窄化类型必须住在消费端（threads/）。
 */

/** Rust `pool::SessionEvent` 的 JS 镜像（判别联合）。 */
export type TerminalSessionEvent =
  | { type: 'title'; sessionId: number; title?: string }
  | { type: 'bell'; sessionId: number }
  | { type: 'exit'; sessionId: number; code?: number }

/**
 * seam 边界窄化：接受 napi 的宽形态（type: string），返回判别联合。
 * 未知 type 返回 null——拒绝而不是猜（新增事件类型时 Rust 侧先行，
 * JS 侧在此显式补分支）。
 */
export function narrowSessionEvent(e: {
  type: string
  sessionId: number
  title?: string
  code?: number
}): TerminalSessionEvent | null {
  switch (e.type) {
    case 'title':
      return { type: 'title', sessionId: e.sessionId, title: e.title }
    case 'bell':
      return { type: 'bell', sessionId: e.sessionId }
    case 'exit':
      return { type: 'exit', sessionId: e.sessionId, code: e.code }
    default:
      return null
  }
}
