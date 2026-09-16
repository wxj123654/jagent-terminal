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
import { displayTitle } from './terminal'
import {
  clearLastSession,
  recordLastSession,
  workspaceDisplayName,
  type Workspace,
} from './workspaces'

export type { Workspace } from './workspaces'

// ── 类型（§3.1）──────────────────────────────────────────────────────

export type TerminalThread = {
  kind: 'terminal'
  /** `t${sessionId}` —— 事件里的 sessionId 可直接定位行（R4） */
  id: string
  sessionId: number
  /** 对应 TerminalPreset.id（内置或自定义） */
  preset?: string
  /** 归属工作区（Phase W；可选 = 旧调用点无上下文，W2 UI 迁移后全带） */
  workspaceId?: string
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
  /** 未读标记（codex-sidebar-v2：加粗 + 状态点 + 排序加权；activate 清除，
   *  菜单可手动标回——待办语义。不持久化，与 threads 同纪律） */
  unread?: boolean
  /** 置顶（组内排序首位；不持久化） */
  pin?: boolean
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
  /** 未读标记（同 TerminalThread.unread） */
  unread?: boolean
  /** 置顶（组内排序首位；不持久化） */
  pin?: boolean
  /** 归属工作区（Phase W） */
  workspaceId?: string
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
  /** 未读标记（同 TerminalThread.unread） */
  unread?: boolean
  /** 置顶（组内排序首位；不持久化） */
  pin?: boolean
  /** 归属工作区（Phase W） */
  workspaceId?: string
}

export type Thread = TerminalThread | ChatThread | AcpThread

/** 通知中心条目（D8）：真实会话事件流（bell/exit）落列；tone 对应原型
 *  ok/warn/err 图标色。不持久化（与 threads 同纪律——重启即死） */
export type SessionNotice = {
  /** `n${seq}` */
  id: string
  tone: 'ok' | 'warn' | 'err'
  /** 主文案（如「build 等待注意」/「Shell 已退出」） */
  text: string
  /** 副文案（工作区名 · 相对时间在 UI 层格式化） */
  sub: string
  at: number
  /** 来源会话（点击条目 → activate 跳转；会话已关闭则仅标已读） */
  threadId: string
  /** 已读标记（未读 = notices.filter(!read)；activate 该会话时自动标读） */
  read: boolean
}

export type ThreadState = {
  /** 混排，创建序 */
  threads: Thread[]
  /** 工作区列表（Phase W；持久化经 deps.persistWorkspaces，装配层写 state.json） */
  workspaces: Workspace[]
  /** 运行时态，不写 settings.json */
  lastUsedPreset: string | null
  /** 通知中心事件流（D8；未读 = notices.filter(n => !n.read)） */
  notices: SessionNotice[]
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
  /** 路由读侧：当前指向的 thread（缺省 null —— 保守视为非 active） */
  activeThreadId?: () => string | null
  /** 路由读侧：当前指向的工作区起始页（Phase W；removeWorkspace 兑底用，缺省 null） */
  activeWorkspaceId?: () => string | null
  /** 工作区持久化（Phase W）：workspaces 任何变化后 fire（fire-and-forget；
   *  装配层写 state.json，失败仅 warn）。不注入则跳过（纯内存，测试面）。 */
  persistWorkspaces?: (workspaces: Workspace[]) => void
  // ── ambient deps（缺省 = 真实环境；测试注入确定性值）──────────────
  /** 时钟（createdAt / 消息 at / 通知 at）。缺省 Date.now */
  now?: () => number
  /** id 生成（c/a/w 前缀的 uuid）。缺省 crypto.randomUUID */
  newId?: () => string
  /** cwd 继承链兜底（preset.cwd ?? workspace.path ?? 本项）。缺省 process.cwd */
  defaultCwd?: () => string
}

/** 构造选项（Phase W）：装配层读盘后的初值（含首启默认工作区决策） */
export type ThreadStoreOptions = {
  initialWorkspaces?: Workspace[]
}

export interface ThreadStore {
  getState(): ThreadState
  subscribe(fn: () => void): () => void
  spawnFromPreset(presetId: string, workspaceId?: string): Promise<void>
  /** 新建空 chat thread + activate（入口：+ 菜单固定项，T3.2） */
  createChat(workspaceId?: string): void
  /** 新建 ACP thread + activate（入口：+ 菜单 agent 项，T3+.1；label 来自
   *  调用方的 settings 快照——store 不读 settings） */
  createAcpThread(agentId: string, label: string, workspaceId?: string): void
  /** chat 发送状态机：空串/pending 中忽略；user 落列 → agent.send → assistant/error 落列 */
  sendChatMessage(threadId: string, text: string): void
  /** acp 发送状态机（与 chat 同构；连接惰性建立，agent 进程错误 → error 行） */
  sendAcpMessage(threadId: string, text: string): void
  activate(target: ActiveTarget): void
  close(id: string): void
  rename(id: string, title: string): void
  cycle(dir: 1 | -1): void
  // ── 工作区（Phase W；architecture.md §3 同步） ─────────────────
  /** 新建工作区（name 空串回退 basename(path)）；返回 id。入口：添加工作区对话框（W2） */
  addWorkspace(name: string, path: string): string
  /** 重命名（空串忽略，同 rename 纪律） */
  renameWorkspace(id: string, name: string): void
  /** 移除工作区：连带 close 其全部会话（destroy/dispose/导航兑底同 close）+ 移除行 */
  removeWorkspace(id: string): void
  /** 切换工作区（点行）：恢复 lastSession（存在则 activate，否则回起始页 null）。
   *  不改 expanded（点箭头仅展开/收起，与激活分离——原型契约） */
  activateWorkspace(id: string): void
  /** 展开/收起分组（持久化，不导航） */
  toggleWorkspaceExpanded(id: string): void
  /** 显示全部 / 只显前 4 条优先项（codex-sidebar-v2 截断；持久化，不导航） */
  setWorkspaceShowAll(id: string, showAll: boolean): void
  /** 会话置顶（codex-sidebar-v2 行菜单 Pin；不持久化，不导航） */
  setThreadPinned(id: string, pin: boolean): void
  /** 会话未读标记（行菜单 Mark as unread；activate 清除——待办语义） */
  setThreadUnread(id: string, unread: boolean): void
  /** 工作区置顶（项目菜单 Pin；持久化，不导航） */
  setWorkspacePinned(id: string, pin: boolean): void
  /** 通知中心（D8）：全部已读——红点清除，条目保留 */
  markNoticesRead(): void
  /** 通知条目点击（D8）：标已读 + 来源会话仍在则 activate 跳转；
   *  会话已关闭仅标已读（不导航——路由不得指向不存在的行） */
  openNotice(noticeId: string): void
  /** 工作区内 tab（git-graph.md §4.1）：'home'/'git'；持久化，不导航 */
  setWorkspacePaneTab(id: string, tab: 'home' | 'git'): void
  /** 打开 Git 图：当前工作区（会话归属 / 已激活 / 第一个）切 paneTab=git 并激活。无工作区 no-op。 */
  openGitGraph(): void
  /** 装配层专用：native → store（经 events.ts 窄化后的判别联合） */
  onSessionEvent(e: TerminalSessionEvent): void
}

// ── 实现 ─────────────────────────────────────────────────────────────

/** chat 默认标题（首条消息改写的哨兵值；rename 手改后不再改写） */
export const CHAT_DEFAULT_TITLE = 'Chat'

export function createThreadStore(deps: ThreadDeps, opts: ThreadStoreOptions = {}): ThreadStore {
  const store = createStore<ThreadState>(() => ({
    threads: [],
    workspaces: opts.initialWorkspaces ?? [],
    lastUsedPreset: null,
    notices: [],
  }))
  const set = (recipe: (s: ThreadState) => void) => store.setState(produce(recipe))
  const state = () => store.getState()
  /** acp thread → 连接实例（情建；close 时 dispose。不进 state——纯运行时资源） */
  const acpAgents = new Map<string, ChatAgent>()
  // ambient deps：缺省真实环境适配（nativeDeps 显式接线同款值）
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const defaultCwd = deps.defaultCwd ?? (() => process.cwd())
  /** chat 消息 id 自增（实例级——跨 store 实例不共享，测试互不污染） */
  let msgSeq = 0
  /** 通知条目 id 自增（同 msgSeq 纪律） */
  let noticeSeq = 0
  /** workspaces 变化后统一持久化出口（fire-and-forget） */
  const persist = () => deps.persistWorkspaces?.(state().workspaces)
  const activate = (target: ActiveTarget) => {
    // 契约 §7：聚焦即清 bell 红点；codex-sidebar-v2：打开即已读（unread 同处清）
    if (target?.type === 'thread') {
      let touchedWorkspace = false
      set((s) => {
        const t = s.threads.find((x) => x.id === target.id)
        if (t && t.kind === 'terminal' && t.hasBell) t.hasBell = false
        if (t && t.unread) t.unread = false
        // 进入会话即已读其通知（D8：activate 是「已看到」的唯一判定）
        for (const n of s.notices) if (n.threadId === target.id) n.read = true
        // Phase W：会话聚焦 → 归属工作区 lastSession 记录（activateWorkspace 恢复源）
        if (t?.workspaceId) {
          touchedWorkspace = recordLastSession(s.workspaces, t.workspaceId, t.id)
        }
      })
      // produce 同步执行，set 返回时标记已定；仅 lastSession 实际变化才写盘
      if (touchedWorkspace) persist()
    }
    // 表面整块替换；settings/null 不动 threads（后台 PTY 照跑）
    deps.navigate(target)
  }

  return {
    getState: state,
    subscribe: (fn) => store.subscribe(fn),

    async spawnFromPreset(presetId, workspaceId) {
      const preset = deps.presetOf(presetId)
      if (!preset) throw new Error(`unknown preset: ${presetId}`)
      const ws = workspaceId ? state().workspaces.find((w) => w.id === workspaceId) : undefined
      if (workspaceId && !ws) throw new Error(`unknown workspace: ${workspaceId}`)
      // cwd 继承链（Phase W 契约）：preset 显式 cwd（用户配置意图）→ 工作区目录 → 进程 CWD
      const cwd = preset.cwd ?? ws?.path ?? defaultCwd()
      const sessionId = await deps.spawnSession({
        cwd, // 与 thread.cwd 同源（Rust None 回退也是进程 CWD，显式传保两端一致）
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
        cwd,
        initCommand: preset.initCommand,
        status: 'running',
        hasBell: false,
        createdAt: now(),
        workspaceId: ws?.id,
      }
      set((s) => {
        s.threads.push(thread)
        s.lastUsedPreset = preset.id
      })
      activate({ type: 'thread', id: thread.id })
    },

    createChat(workspaceId) {
      assertWorkspace(state(), workspaceId)
      const thread: ChatThread = {
        kind: 'chat',
        id: `c${newId()}`,
        title: CHAT_DEFAULT_TITLE,
        createdAt: now(),
        messages: [],
        pendingReply: false,
        workspaceId,
      }
      set((s) => {
        s.threads.push(thread)
      })
      activate({ type: 'thread', id: thread.id })
    },

    createAcpThread(agentId, label, workspaceId) {
      assertWorkspace(state(), workspaceId)
      const thread: AcpThread = {
        kind: 'acp',
        id: `a${newId()}`,
        title: label,
        createdAt: now(),
        agentId,
        messages: [],
        pendingReply: false,
        autoTitle: true,
        workspaceId,
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
      // 不变量 1：close 前先导航离开（路由不得指向将移除的行）。
      // Phase W：有归属 → 回该工作区起始页（原型「会话移除后回工作区
      // 起始页」）；无归属（旧数据/局部复用）→ '/'
      if (routerPointsAt(id)) {
        activate(thread.workspaceId ? { type: 'workspace', id: thread.workspaceId } : null)
      }
      // destroySession 的 reject 已在 nativeDeps 的 trackNative 里进错误总线
      // （emit 后 rethrow）；这里只防空 rejection（错误不再二次处理）。
      if (thread.kind === 'terminal') deps.destroySession(thread.sessionId).catch(() => {})
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
        // Phase W：会话移除 → 若是所属工作区 lastSession 则清空（下一个
        // activateWorkspace 回起始页；「最后一个会话被移除后回工作区起始页」
        // 的数据面兑底，空态 UI 是 W2）
        if (thread.workspaceId) clearLastSession(s.workspaces, thread.workspaceId, id)
      })
      persist()
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

    // ── 工作区（Phase W）──────────────────────────────────────

    addWorkspace(name, path) {
      const ws: Workspace = {
        id: `w${newId()}`,
        name: name.trim() || workspaceDisplayName(path),
        path,
        expanded: true,
        lastSession: null,
        paneTab: 'home',
        showAll: false,
        createdAt: now(),
      }
      set((s) => {
        s.workspaces.push(ws)
      })
      persist()
      return ws.id
    },

    renameWorkspace(id, name) {
      if (!name.trim()) return // 空串忽略（同 rename 纪律）
      set((s) => {
        const ws = s.workspaces.find((w) => w.id === id)
        if (ws) ws.name = name.trim()
      })
      persist()
    },

    removeWorkspace(id) {
      if (!state().workspaces.some((w) => w.id === id)) return
      // 连带 close 全部会话：destroySession/dispose/导航兑底都复用 close 单点
      //（首个被 close 的 active thread 会先导航到本工作区起始页；后续 close
      // 的 routerPointsAt 已 false，不再额外导航）
      for (const victim of state().threads.filter((t) => t.workspaceId === id)) {
        this.close(victim.id)
      }
      set((s) => {
        s.workspaces = s.workspaces.filter((w) => w.id !== id)
      })
      // 工作区已删：路由若指向它的起始页（close 兑底或用户停在空态）→
      // 回全局起始页（EmptyPresets 兑底）；非 active 不导航
      if (deps.activeWorkspaceId?.() === id) activate(null)
      persist()
    },

    activateWorkspace(id) {
      const ws = state().workspaces.find((w) => w.id === id)
      if (!ws) return
      // 恢复上次会话；已不存在（重启后 PTY 即死）或从未打开 → 工作区
      // 起始页（router 目标 /workspace/$id，Pane 渲染 WorkspaceEmpty）。
      // activate 内部会再写 lastSession（幂等，同 id 无害）
      const target = ws.lastSession
        ? state().threads.find((t) => t.id === ws.lastSession)
        : undefined
      activate(target ? { type: 'thread', id: target.id } : { type: 'workspace', id })
    },

    toggleWorkspaceExpanded(id) {
      set((s) => {
        const ws = s.workspaces.find((w) => w.id === id)
        if (ws) ws.expanded = !ws.expanded
      })
      persist()
    },

    setWorkspaceShowAll(id, showAll) {
      set((s) => {
        const ws = s.workspaces.find((w) => w.id === id)
        if (ws) ws.showAll = showAll
      })
      persist()
    },

    setThreadPinned(id, pin) {
      set((s) => {
        const t = s.threads.find((x) => x.id === id)
        if (t) t.pin = pin
      })
    },

    setThreadUnread(id, unread) {
      set((s) => {
        const t = s.threads.find((x) => x.id === id)
        if (t) t.unread = unread
      })
    },

    setWorkspacePinned(id, pin) {
      set((s) => {
        const ws = s.workspaces.find((w) => w.id === id)
        if (ws) ws.pin = pin
      })
      persist()
    },

    markNoticesRead() {
      set((s) => {
        for (const n of s.notices) n.read = true
      })
    },

    openNotice(noticeId) {
      const n = state().notices.find((x) => x.id === noticeId)
      if (!n) return
      set((s) => {
        const row = s.notices.find((x) => x.id === noticeId)
        if (row) row.read = true
      })
      // 来源会话仍在才导航（已关闭的会话只标已读——activate 会再标一次，幂等）
      if (state().threads.some((t) => t.id === n.threadId)) {
        activate({ type: 'thread', id: n.threadId })
      }
    },

    setWorkspacePaneTab(id, tab) {
      set((s) => {
        const ws = s.workspaces.find((w) => w.id === id)
        if (ws && ws.paneTab !== tab) ws.paneTab = tab
      })
      persist()
    },

    openGitGraph() {
      const s = state()
      const threadId = deps.activeThreadId?.() ?? null
      const fromThread = threadId
        ? s.threads.find((t) => t.id === threadId)?.workspaceId
        : undefined
      const id = fromThread ?? deps.activeWorkspaceId?.() ?? s.workspaces[0]?.id
      if (!id) return
      set((st) => {
        const ws = st.workspaces.find((w) => w.id === id)
        if (ws && ws.paneTab !== 'git') ws.paneTab = 'git'
      })
      persist()
      activate({ type: 'workspace', id })
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
              pushNotice(t, 'warn', `「${displayTitle(t)}」等待注意`, 'BEL')
              deps.notify(t)
            }
          }
          break
        }
        case 'exit': {
          const t = state().threads.find((x) => x.id === id)
          if (!t || t.kind !== 'terminal') return
          // 通知中心（D8）：退出是真实会话事件——非零码 err、正常退出 ok
          pushNotice(
            t,
            e.code === 0 || e.code == null ? 'ok' : 'err',
            `「${displayTitle(t)}」已退出`,
          )
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

  /** 通知落列（D8）：sub = 归属工作区名 / 未归属 + 可选原因（原型
   *  「dotfiles · BEL」格式）；容量 50（溢出丢最旧——read 随条目走，
   *  无计数器不变量要维护） */
  function pushNotice(
    t: TerminalThread,
    tone: SessionNotice['tone'],
    text: string,
    reason?: string,
  ) {
    set((s) => {
      const ws = t.workspaceId ? s.workspaces.find((w) => w.id === t.workspaceId) : undefined
      s.notices.push({
        id: `n${++noticeSeq}`,
        tone,
        text,
        sub: `${ws?.name ?? '未归属'}${reason ? ` · ${reason}` : ''}`,
        at: now(),
        threadId: t.id,
        read: false,
      })
      if (s.notices.length > 50) s.notices.splice(0, s.notices.length - 50)
    })
  }

  /** 显式传入的 workspaceId 必须存在（调用方 bug 早暴露；spawn 侧已内联同判） */
  function assertWorkspace(s: ThreadState, id: string | undefined): void {
    if (id != null && !s.workspaces.some((w) => w.id === id)) {
      throw new Error(`unknown workspace: ${id}`)
    }
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
            at: now(),
            error: true,
          })
          return
        }
        acpAgents.set(threadId, agent)
      }
    }

    const userMsg: ChatMessage = { id: `m${++msgSeq}`, role: 'user', text, at: now() }
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
        at: now(),
      })
    } catch (err) {
      pushReply(threadId, kind, {
        id: `m${++msgSeq}`,
        role: 'assistant',
        text: `发送失败：${err instanceof Error ? err.message : String(err)}`,
        at: now(),
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
