/**
 * threads/chat.ts — chat 消息模型 + ChatAgent seam（T3.2）。
 *
 * 布局契约 §5.2：「composer 只把输入送进 chat agent，与 PTY stdin 无关」。
 * chat agent 的具体后端（2026-09-05 用户拍板）：默认 EchoAgent 本地模拟，
 * Phase 3+ ACP / LLM 接入时换 adapter——UI 与状态机（store.sendChatMessage）
 * 不动。与 ThreadDeps 同款纪律：store 经依赖注入拿 ChatAgent，本文件零
 * native / 零 UI 依赖。
 */

/** chat 消息（判别联合；id 仅需 thread 内唯一，store 侧自增分配） */
export type ChatMessage =
  | { id: string; role: 'user'; text: string; at: number }
  /** error:true = agent 回复失败行（bell 红着色，UI 标「失败」） */
  | { id: string; role: 'assistant'; text: string; at: number; error?: boolean }

/** ChatAgent seam：composer 输入的唯一去处。send resolve 回复全文；reject =
 *  回复失败（store 落一条 error assistant 行）。流式回复（ACP chunk）Phase 3+
 *  再扩接口，当前形态对 Promise 足够。 */
export type ChatAgent = {
  send(text: string): Promise<string>
}

/** EchoAgent — 本地模拟回复。delayMs 模拟「思考」延迟（测试/e2e 注入 0） */
export function createEchoAgent(delayMs = 600): ChatAgent {
  return {
    async send(text) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      return [
        `（echo stub）收到：${text.slice(0, 200)}`,
        '',
        'chat 后端尚未接线 —— Phase 3+ 换 ACP / LLM adapter，此处只是回声。',
      ].join('\n')
    },
  }
}
