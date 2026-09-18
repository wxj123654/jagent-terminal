/**
 * threads/internal/conversations.ts — chat/acp 会话簇（T3.2 / T3+.1）。
 *
 * 规则单点：
 * - 创建：createChat / createAcpThread（push + activate；acp title=传入
 *   label + autoTitle 哨兵；store 不读 settings——label 由调用方给）
 * - 发送状态机（chat/acp 同构，sendConversationMessage 单点）：空串/
 *   pending 忽略；user 落列 + pendingReply → agent.send → assistant/
 *   error 落列 + 复位；thread 已 close 则丢弃回复（不复活已删行）
 * - 首条 user 消息截断改写 title（chat：title===CHAT_DEFAULT_TITLE
 *   哨兵；acp：autoTitle 哨兵；rename 手改后冻结）
 * - acp 连接情建：ctx.acpAgents map 首查，未建则 deps.createAcpAgent
 *   （同步 throw → error 行，如配置被删）；dispose 归 store.close
 *
 * internal seam——只被 store.ts 装配调用，不对外导出。
 */

import type { ChatAgent, ChatMessage } from '../chat'
import { CHAT_DEFAULT_TITLE } from '../store'
import type { AcpThread, ChatThread } from '../store'
import type { StoreCtx } from './ctx'
import { assertWorkspace } from './workspaceOps'

/** 新建空 chat thread + activate（入口：+ 菜单固定项，T3.2） */
export function createChat(ctx: StoreCtx, workspaceId?: string): void {
  assertWorkspace(ctx, workspaceId)
  const thread: ChatThread = {
    kind: 'chat',
    id: `c${ctx.newId()}`,
    title: CHAT_DEFAULT_TITLE,
    createdAt: ctx.now(),
    messages: [],
    pendingReply: false,
    workspaceId,
  }
  ctx.set((s) => {
    s.threads.push(thread)
  })
  ctx.activate({ type: 'thread', id: thread.id })
}

/** 新建 ACP thread + activate（入口：+ 菜单 agent 项，T3+.1；label 来自
 *  调用方的 settings 快照——store 不读 settings） */
export function createAcpThread(
  ctx: StoreCtx,
  agentId: string,
  label: string,
  workspaceId?: string,
): void {
  assertWorkspace(ctx, workspaceId)
  const thread: AcpThread = {
    kind: 'acp',
    id: `a${ctx.newId()}`,
    title: label,
    createdAt: ctx.now(),
    agentId,
    messages: [],
    pendingReply: false,
    autoTitle: true,
    workspaceId,
  }
  ctx.set((s) => {
    s.threads.push(thread)
  })
  ctx.activate({ type: 'thread', id: thread.id })
}

/** 回复落列（thread 已 close 则丢弃；pendingReply 复位） */
function pushReply(ctx: StoreCtx, threadId: string, kind: 'chat' | 'acp', msg: ChatMessage): void {
  ctx.set((s) => {
    const t = s.threads.find((x) => x.id === threadId)
    if (!t || t.kind !== kind) return
    t.messages.push(msg)
    t.pendingReply = false
  })
}

/** 会话消息状态机（chat/acp 同构，单点）：见文件头规则表。
 *  acp 连接情建：首查 acpAgents map，未建则 deps.createAcpAgent（同步
 *  throw → error 行，如配置被删）。 */
export async function sendConversationMessage(
  ctx: StoreCtx,
  threadId: string,
  raw: string,
  kind: 'chat' | 'acp',
): Promise<void> {
  const text = raw.trim()
  if (!text) return // 空串忽略（同 rename）
  const thread = ctx.state().threads.find((t) => t.id === threadId)
  if (!thread || thread.kind !== kind || thread.pendingReply) return

  let agent: ChatAgent
  if (kind === 'chat') agent = ctx.deps.chatAgent
  else {
    const existing = ctx.acpAgents.get(threadId)
    if (existing) agent = existing
    else {
      try {
        agent = ctx.deps.createAcpAgent((thread as AcpThread).agentId)
      } catch (err) {
        pushReply(ctx, threadId, kind, {
          id: ctx.nextMsgId(),
          role: 'assistant',
          text: `无法建立 ACP 连接：${err instanceof Error ? err.message : String(err)}`,
          at: ctx.now(),
          error: true,
        })
        return
      }
      ctx.acpAgents.set(threadId, agent)
    }
  }

  const userMsg: ChatMessage = { id: ctx.nextMsgId(), role: 'user', text, at: ctx.now() }
  ctx.set((s) => {
    const t = s.threads.find((x) => x.id === threadId)
    if (!t || t.kind !== kind || t.pendingReply) return
    t.messages.push(userMsg)
    t.pendingReply = true
    // 首条 user 消息定标题（仅哨兵期间；手改后冻结）
    const isFirstUser = t.messages.every((m) => m.role !== 'user' || m.id === userMsg.id)
    const auto = t.kind === 'chat' ? t.title === CHAT_DEFAULT_TITLE : t.autoTitle
    if (isFirstUser && auto) {
      t.title = text.length > 32 ? `${text.slice(0, 32)}…` : text
      if (t.kind === 'acp') t.autoTitle = false
    }
  })

  try {
    const reply = await agent.send(text)
    pushReply(ctx, threadId, kind, {
      id: ctx.nextMsgId(),
      role: 'assistant',
      text: reply,
      at: ctx.now(),
    })
  } catch (err) {
    pushReply(ctx, threadId, kind, {
      id: ctx.nextMsgId(),
      role: 'assistant',
      text: `发送失败：${err instanceof Error ? err.message : String(err)}`,
      at: ctx.now(),
      error: true,
    })
  }
}
