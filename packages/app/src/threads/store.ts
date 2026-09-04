/**
 * threads/store.ts — ThreadStore（architecture.md §3；唯一会话事实源）。
 *
 * 实现底座：zustand/vanilla createStore（不绑 React）+ immer produce。
 * store 本体零 native / 零 router 导入——跨语言 seam 与路由都经
 * ThreadDeps 注入（§1.2：native 只在 main.tsx 与本文件注入参数类型可见）。
 *
 * 规则表（§3.3）全部在 store 一处——locality 的兑现。Phase 1 实现全量
 * 规则（T2.1 补测试面）。
 */

import { produce } from 'immer'
import { createStore } from 'zustand/vanilla'

import type { SpawnOptionsJs } from '@jagent/native'

import type { ActiveTarget } from '../router'
import type { ChatAgent, ChatMessage } from './chat'
import type { TerminalSessionEvent } from './events'
import type { TerminalPreset } from './presets'

// ── 类型（§3.1）──────────────────────────────────────────────────────

export type TerminalThread = {
  kind: 'terminal'
  /** `t${sessionId}` —— 事件里的 sessionId 可直接定位行（R4） */
  id: string
  sessionId: number
  /** 对应 TerminalPreset.id（内置或自定义） */
  preset?: string
  cwd: string
  /** 兜底标题用 */
  initCommand?: string
  /** 来自 SessionEvent.title */
  oscTitle?: string
  /** 手改后冻结（不再被 OSC 覆盖） */
  customTitle?: string
  status: 'running' | 'exited'
  exitCode?: number | null
  /** activate 该 thread 时清除 */
  hasBell: boolean
  createdAt: number
}

/** chat thread（T3.2 实装：消息 + pendingReply 状态机在 store 一处） */
export type ChatThread = {
  kind: 'chat'
  /** `c${uuid}`（R4） */
  id: string
  /** 默认 'Chat'；首条 user 消息截断改写（rename 手改后冻结——title !== 默认值即不再改） */
  title: string
  createdAt: number
  messages: ChatMessage[]
  /** agent 回复进行中：composer 发送钮禁用 + 消息尾 thinking 占位 */
  pendingReply: boolean
}
/** Phase 3+ 实装：外部 agent JSON-RPC 会话；消息面与 chat 同构（ConversationView 复用） */
export type AcpThread = {
  kind: 'acp'
  /** `a${uuid}`（R4） */
  id: string
  /** 初始 = agent label（调用方传入，store 不读 settings）；首条 user 消息截断改写 */
  title: string
  createdAt: number
  /** settings.acpAgents 的配置 id（连接按 thread 惰性建立，配置变更不追旧 thread） */
  agentId: string
  messages: ChatMessage[]
  pendingReply: boolean
  /** title 未被手改/首条消息改写（首条 user 消息自动改写的哨兵；rename 置 false） */
  autoTitle: boolean
}

export type Thread = TerminalThread | ChatThread | AcpThread

export type ThreadState = {
  /** 混排，创建序 */
  threads: Thread[]
  /** 运行时态，不写 settings.json */
  lastUsedPreset: string | null
  // 注意：active 不在此——导航唯一事实源是 router（§3.5）
}

/** 依赖注入——store 本体纯 TS 可测（§3.2） */
export type ThreadDeps = {
  spawnSession: (o: SpawnOptionsJs) => Promise<number>
  destroySession: (id: number) => Promise<void>
  /** 路由跳转薄包装（装配层 = router.navigate） */
  navigate: (t: ActiveTarget) => void
  /** 桌面通知（Phase 2 定实现；读 settings.desktop 在装配层） */
  notify: (t: TerminalThread) => void
  /** 读 settings 终端区（装配层桥接） */
  closeOnExit: () => boolean
  presetOf: (id: string) => TerminalPreset | undefined
  /** chat 后端 seam（T3.2；装配层默认 EchoAgent，ACP/LLM 未来换 adapter） */
  chatAgent: ChatAgent
  /** ACP 后端工厂（T3+.1）：每 acp thread 首次发送时调一次，返回的连接实例
   *  自持子进程（close thread 时 dispose）；未知 agentId 应 throw（store 落错误行） */
  createAcpAgent: (agentId: string) => ChatAgent
  /** 路由读侧（active 判定：bell 红点只打非 active、cycle 基准、close 先导航离开）。
   *  装配层注入（直接读 history）。未注入时：bell 视为非 active，close 保守先导航。 */
  activeThreadId?: () => string | null
}

export interface ThreadStore {
  getState(): ThreadState
  subscribe(fn: () => void): () => void
  spawnFromPreset(presetId: string): Promise<void>
  /** 新建空 chat thread + activate（入口：+ 菜单固定项，T3.2） */
  createChat(): void
  /** 新建 ACP thread + activate（入口：+ 菜单 agent 项，T3+.1；label 来自
   *  调用方的 settings 快照——store 不读 settings） */
  createAcpThread(agentId: string, label: string): void
  /** chat 发送状态机：空串/pending 中忽略；user 落列 → agent.send → assistant/error 落列 */
  sendChatMessage(threadId: string, text: string): void
  /** acp 发送状态机（与 chat 同构；连接惰性建立，agent 进程错误 → error 行） */
  sendAcpMessage(threadId: string, text: string): void
  activate(target: ActiveTarget): void
  close(id: string): void
  rename(id: string, title: string): void
  cycle(dir: 1 | -1): void
  /** 装配层专用：native → store（经 events.ts 窄化后的判别联合） */
  onSessionEvent(e: TerminalSessionEvent): void
}

// ── 实现 ─────────────────────────────────────────────────────────────

/** chat 消息 id 自增（仅需 thread 内唯一 + 测试可预测） */
let msgSeq = 0

/** chat 默认标题（首条消息改写的哨兵值；rename 手改后不再改写） */
export const CHAT_DEFAULT_TITLE = 'Chat'

export function createThreadStore(deps: ThreadDeps): ThreadStore {
  const store = createStore<ThreadState>(() => ({ threads: [], lastUsedPreset: null }))
  const set = (recipe: (s: ThreadState) => void) => store.setState(produce(recipe))
  const state = () => store.getState()
  /** acp thread → 连接实例（情建；close 时 dispose。不进 state——纯运行时资源） */
  const acpAgents = new Map<string, ChatAgent>()
  const activate = (target: ActiveTarget) => {
    // 契约 §7：聚焦即清 bell 红点
    if (target?.type === 'thread') {
      set((s) => {
        const t = s.threads.find((x) => x.id === target.id)
        if (t && t.kind === 'terminal' && t.hasBell) t.hasBell = false
      })
    }
    // 表面整块替换；settings/null 不动 threads（后台 PTY 照跑）
    deps.navigate(target)
  }

  return {
    getState: state,
    subscribe: (fn) => store.subscribe(fn),

    async spawnFromPreset(presetId) {
      const preset = deps.presetOf(presetId)
      if (!preset) throw new Error(`unknown preset: ${presetId}`)
      const sessionId = await deps.spawnSession({
        cwd: preset.cwd ?? process.cwd(), // 与 thread.cwd 同源（Rust None 回退也是进程 CWD，显式传保两端一致）
        program: preset.program,
        args: preset.args,
        env: preset.env,
        initCommand: preset.initCommand,
      })
      const thread: TerminalThread = {
        kind: 'terminal',
        id: `t${sessionId}`,
        sessionId,
        preset: preset.id,
        cwd: preset.cwd ?? process.cwd(),
        initCommand: preset.initCommand,
        status: 'running',
        hasBell: false,
        createdAt: Date.now(),
      }
      set((s) => {
        s.threads.push(thread)
        s.lastUsedPreset = preset.id
      })
      activate({ type: 'thread', id: thread.id })
    },

    createChat() {
      const thread: ChatThread = {
        kind: 'chat',
        id: `c${crypto.randomUUID()}`,
        title: CHAT_DEFAULT_TITLE,
        createdAt: Date.now(),
        messages: [],
        pendingReply: false,
      }
      set((s) => {
        s.threads.push(thread)
      })
      activate({ type: 'thread', id: thread.id })
    },

    createAcpThread(agentId, label) {
      const thread: AcpThread = {
        kind: 'acp',
        id: `a${crypto.randomUUID()}`,
        title: label,
        createdAt: Date.now(),
        agentId,
        messages: [],
        pendingReply: false,
        autoTitle: true,
      }
      set((s) => {
        s.threads.push(thread)
      })
      activate({ type: 'thread', id: thread.id })
    },

    sendChatMessage(threadId, text) {
      void sendConversationMessage(threadId, text, 'chat')
    },

    sendAcpMessage(threadId, text) {
      void sendConversationMessage(threadId, text, 'acp')
    },

    activate,

    close(id) {
      const thread = state().threads.find((t) => t.id === id)
      if (!thread) return
      // 不变量 1：close 前先导航离开（路由不得指向将移除的行）
      if (routerPointsAt(id)) activate(null)
      if (thread.kind === 'terminal') void deps.destroySession(thread.sessionId)
      if (thread.kind === 'acp') {
        // 连接随行销毁（子进程 kill；释放失败不阻塞移除）
        const agent = acpAgents.get(id)
        acpAgents.delete(id)
        try {
          agent?.dispose?.()
        } catch {
          // 忽略：行移除是主路径
        }
      }
      set((s) => {
        s.threads = s.threads.filter((t) => t.id !== id)
      })
    },

    rename(id, title) {
      // 空串忽略；terminal 写 customTitle → 冻结（不变量 2）；chat/acp 直接改
      // title（首条消息改写只在上哨兵期间发生——手改后冻结）
      if (!title.trim()) return
      set((s) => {
        const t = s.threads.find((x) => x.id === id)
        if (!t) return
        if (t.kind === 'terminal') t.customTitle = title
        else {
          t.title = title
          if (t.kind === 'acp') t.autoTitle = false
        }
      })
    },

    cycle(dir) {
      const { threads } = state()
      if (threads.length === 0) return
      // 环形移动（契约 §4）：基准 = 当前 active（deps.activeThreadId 读侧）。
      // 无 active（'/' 或 settings 表面）时：dir=1 → 第一个，dir=-1 → 最后一个。
      // （不能直接 (idx+dir+n)%n——idx=-1 且 dir=-1 会落到 n-2 的怪分支）
      const idx = threads.findIndex((t) => t.id === activeThreadId())
      const nextIdx =
        idx === -1
          ? dir === 1
            ? 0
            : threads.length - 1
          : (idx + dir + threads.length) % threads.length
      activate({ type: 'thread', id: threads[nextIdx].id })
    },

    onSessionEvent(e) {
      const id = `t${e.sessionId}`
      switch (e.type) {
        case 'title': {
          set((s) => {
            const t = s.threads.find((x) => x.id === id)
            // customTitle 存在则忽略（冻结）
            if (t && t.kind === 'terminal' && t.customTitle == null && e.title) {
              t.oscTitle = e.title
            }
          })
          break
        }
        case 'bell': {
          const t = state().threads.find((x) => x.id === id)
          if (t && t.kind === 'terminal') {
            // 非 active 时红点 + 通知（active 判定经 router——见 activeThreadId）
            const isTargetActive = activeThreadId() === id
            if (!isTargetActive) {
              set((s) => {
                const row = s.threads.find((x) => x.id === id)
                if (row && row.kind === 'terminal') row.hasBell = true
              })
              deps.notify(t)
            }
          }
          break
        }
        case 'exit': {
          const t = state().threads.find((x) => x.id === id)
          if (!t || t.kind !== 'terminal') return
          if (deps.closeOnExit()) {
            this.close(id)
          } else {
            // exited 会话留在池中（不变量 3）——重激活显示残留
            set((s) => {
              const row = s.threads.find((x) => x.id === id)
              if (row && row.kind === 'terminal') {
                row.status = 'exited'
                row.exitCode = e.code ?? null
              }
            })
          }
          break
        }
      }
    },
  }

  /** active thread id（router 读侧；未注入时回退 null = 视为非 active） */
  function activeThreadId(): string | null {
    return deps.activeThreadId?.() ?? null
  }

  /** 路由是否指向该 thread（close 的先导航离开判定；未注入时保守视为指向） */
  function routerPointsAt(id: string): boolean {
    return deps.activeThreadId ? deps.activeThreadId() === id : true
  }

  /**
   * 会话消息状态机（chat/acp 同构，单点）：空串/pending 忽略；user 落列 +
   * pendingReply → agent.send → assistant/error 落列 + 复位；thread 已 close
   * 则丢弃回复（不变量：不复活已删行）。首条 user 消息截断改写 title
   * （chat：title===CHAT_DEFAULT_TITLE 哨兵；acp：autoTitle 哨兵）。
   * acp 连接情建：首查 acpAgents map，未建则 deps.createAcpAgent（同步 throw
   * → error 行，如配置被删）。
   */
  async function sendConversationMessage(threadId: string, raw: string, kind: 'chat' | 'acp') {
    const text = raw.trim()
    if (!text) return // 空串忽略（同 rename）
    const thread = state().threads.find((t) => t.id === threadId)
    if (!thread || thread.kind !== kind || thread.pendingReply) return

    let agent: ChatAgent
    if (kind === 'chat') agent = deps.chatAgent
    else {
      const existing = acpAgents.get(threadId)
      if (existing) agent = existing
      else {
        try {
          agent = deps.createAcpAgent((thread as AcpThread).agentId)
        } catch (err) {
          pushReply(threadId, kind, {
            id: `m${++msgSeq}`,
            role: 'assistant',
            text: `无法建立 ACP 连接：${err instanceof Error ? err.message : String(err)}`,
            at: Date.now(),
            error: true,
          })
          return
        }
        acpAgents.set(threadId, agent)
      }
    }

    const userMsg: ChatMessage = { id: `m${++msgSeq}`, role: 'user', text, at: Date.now() }
    set((s) => {
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
      pushReply(threadId, kind, {
        id: `m${++msgSeq}`,
        role: 'assistant',
        text: reply,
        at: Date.now(),
      })
    } catch (err) {
      pushReply(threadId, kind, {
        id: `m${++msgSeq}`,
        role: 'assistant',
        text: `发送失败：${err instanceof Error ? err.message : String(err)}`,
        at: Date.now(),
        error: true,
      })
    }
  }

  /** 回复落列（thread 已 close 则丢弃；pendingReply 复位） */
  function pushReply(threadId: string, kind: 'chat' | 'acp', msg: ChatMessage) {
    set((s) => {
      const t = s.threads.find((x) => x.id === threadId)
      if (!t || t.kind !== kind) return
      t.messages.push(msg)
      t.pendingReply = false
    })
  }
}
