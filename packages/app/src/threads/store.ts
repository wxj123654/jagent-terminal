/**
 * threads/store.ts — ThreadStore（architecture.md §3；唯一会话事实源）。
 *
 * 实现底座：zustand/vanilla createStore（不绑 React）+ immer produce。
 * store 本体零 native / 零 router 导入——跨语言 seam 与路由都经
 * ThreadDeps 注入（§1.2：native 只在 main.tsx 与本文件注入参数类型可见）。
 *
 * 规则表（§3.3）全部在 store 一处——locality 的兑现。实现按簇拆进
 * internal/*（sessionViews / notices / workspaceOps / conversations，
 * 共享 internal/ctx.ts 上下文），接口不变——internal seam 是模块私有的，
 * interface 即测试面不变。
 */

import { produce } from 'immer'
import { createStore } from 'zustand/vanilla'

import type { SpawnOptionsJs } from '@jagent/native'

import type { ActiveTarget } from '../router'
import type { ChatAgent, ChatMessage } from './chat'
import type { TerminalSessionEvent } from './events'
import type { TerminalPreset } from './presets'
import { displayTitle } from './terminal'
import { clearLastSession, recordLastSession, type Workspace } from './workspaces'

import * as conversations from './internal/conversations'
import type { StoreCtx } from './internal/ctx'
import * as notices from './internal/notices'
import * as sessionViews from './internal/sessionViews'
import * as workspaceOps from './internal/workspaceOps'

export type { Workspace } from './workspaces'

// ── 类型（§3.1）──────────────────────────────────────────────────────

/**
 * 会话内视图（最新原型 40d30e8 的 SessionView：标题栏第二行 tab strip
 * 的非「主面」页）。'main' 是虚拟 id（主面本身不落 views 数组）。
 * 运行时态不持久化：shell 视图绑真 PTY（重启即死），file 视图按 path 重读。
 */
export type SessionView =
  | { id: string; kind: 'git'; label: string }
  | { id: string; kind: 'file'; label: string; path: string }
  | {
      /** `shell:${n}`（会话内递增） */
      id: string
      kind: 'shell'
      /** `Shell n` 兜底标题（tab 展示 oscTitle ?? label） */
      label: string
      /** 独立 PTY（≠ thread.sessionId）；closeSessionView/close 连带销毁 */
      sessionId: number
      cwd: string
      /** SessionEvent.title —— 视图 PTY 事件按 sessionId 归属到本视图 */
      oscTitle?: string
      /** 视图非前台时 BEL 落此；该视图被展示时清除（activate/activateSessionView） */
      hasBell?: boolean
      status: 'running' | 'exited'
      exitCode?: number | null
    }

/** shell 视图别名（事件归属/视图消费方共用窄化，R2/R3 tab 也用） */
export type ShellView = Extract<SessionView, { kind: 'shell' }>

/** 三类 thread 共用的会话视图字段（原型 Thread.views/activeViewId） */
type SessionViews = {
  /** 副页签列表（git/file/shell；创建序） */
  views?: SessionView[]
  /** 当前视图 id；缺省/'main' = 主面 */
  activeViewId?: string
}

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
} & SessionViews

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
} & SessionViews
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
} & SessionViews

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
  /** 来源会话内视图（shell PTY 事件）：openNotice 一并激活该视图 */
  viewId?: string
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
  /** 桌面通知（Phase 2 定实现；读 settings.desktop 在装配层）。入参放宽
   *  到 Thread：shell 视图 PTY 的 bell 也可能属于 chat/acp 会话 */
  notify: (t: Thread) => void
  /** 读 settings 终端区（装配层桥接） */
  closeOnExit: () => boolean
  presetOf: (id: string) => TerminalPreset | undefined
  /** chat 后端 seam（T3.2；装配层默认 EchoAgent，ACP/LLM 未来换 adapter） */
  chatAgent: ChatAgent
  /** ACP 后端工厂（T3+.1）：每 acp thread 首次发送时调一次，返回的连接实例
   *  自持子进程（close thread 时 dispose）；未知 agentId 应 throw（store 落错误行） */
  createAcpAgent: (agentId: string) => ChatAgent
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
  /** 打开 Git 图：活跃会话已归属工作区 → 会话内 'git' 视图（不切路由，
   *  原型 SessionTabs 语义）；否则当前/首个工作区切 paneTab=git 并激活 */
  openGitGraph(): void
  // ── 会话内视图（最新原型 SessionTabs：main/git/file/shell tab）─────
  /** 激活会话内视图（'main' = 回主面；不存在 id 忽略） */
  activateSessionView(threadId: string, viewId: string): void
  /** 关闭会话内视图（'main' 不可关；shell 视图连带销毁 PTY；
   *  关的是当前视图 → 回退左邻或主面） */
  closeSessionView(threadId: string, viewId: string): void
  /** 打开文件视图（file:<path> 去重复用；原型「打开文件」列表项） */
  openSessionFile(threadId: string, path: string): void
  /** 新建会话内 shell 视图（真 PTY：spawnSession；cwd = 会话 cwd / 归属工作区 path） */
  addSessionShell(threadId: string): Promise<void>
  /** 装配层专用：native → store（经 events.ts 窄化后的判别联合） */
  onSessionEvent(e: TerminalSessionEvent): void
}

// ── 实现 ─────────────────────────────────────────────────────────────

/** chat 默认标题（首条消息改写的哨兵值；rename 手改后不再改写） */
export const CHAT_DEFAULT_TITLE = 'Chat'

/** 主面虚拟视图 id（不落 views 数组；原型契约） */
export const MAIN_VIEW_ID = 'main'

/** 会话标题（通知文案；装配层 notify 共用）：terminal → displayTitle 兜底链，chat/acp → title */
export function threadTitle(t: Thread): string {
  return t.kind === 'terminal' ? displayTitle(t) : t.title
}

/** 视图展示名（tab/通知同一规则）：shell → oscTitle ?? label；其余 → label */
export function sessionViewTitle(v: SessionView): string {
  return v.kind === 'shell' ? (v.oscTitle ?? v.label) : v.label
}

export function createThreadStore(deps: ThreadDeps, opts: ThreadStoreOptions = {}): ThreadStore {
  const store = createStore<ThreadState>(() => ({
    threads: [],
    workspaces: opts.initialWorkspaces ?? [],
    lastUsedPreset: null,
    notices: [],
  }))
  const set = (recipe: (s: ThreadState) => void) => store.setState(produce(recipe))
  const state = () => store.getState()
  /** chat 消息 id 自增（实例级——跨 store 实例不共享，测试互不污染） */
  let msgSeq = 0
  /** 通知条目 id 自增（同 msgSeq 纪律） */
  let noticeSeq = 0

  /** internal 模块共享上下文（见 internal/ctx.ts）：跨簇调用经接线点，
   *  不互 import（workspaceOps→close、notices→activateSessionView 会成环） */
  const ctx: StoreCtx = {
    state,
    set,
    deps,
    activate,
    persist: () => deps.persistWorkspaces?.(state().workspaces),
    now: deps.now ?? Date.now,
    newId: deps.newId ?? (() => crypto.randomUUID()),
    defaultCwd: deps.defaultCwd ?? (() => process.cwd()),
    activeThreadId: () => deps.activeThreadId?.() ?? null,
    acpAgents: new Map<string, ChatAgent>(),
    nextMsgId: () => `m${++msgSeq}`,
    nextNoticeId: () => `n${++noticeSeq}`,
    close,
    activateSessionView: (threadId, viewId) =>
      sessionViews.activateSessionView(ctx, threadId, viewId),
  }

  return {
    getState: state,
    subscribe: (fn) => store.subscribe(fn),

    spawnFromPreset,
    createChat: (workspaceId) => conversations.createChat(ctx, workspaceId),
    createAcpThread: (agentId, label, workspaceId) =>
      conversations.createAcpThread(ctx, agentId, label, workspaceId),
    sendChatMessage: (threadId, text) =>
      void conversations.sendConversationMessage(ctx, threadId, text, 'chat'),
    sendAcpMessage: (threadId, text) =>
      void conversations.sendConversationMessage(ctx, threadId, text, 'acp'),
    activate,
    close,
    rename,
    cycle,

    addWorkspace: (name, path) => workspaceOps.addWorkspace(ctx, name, path),
    renameWorkspace: (id, name) => workspaceOps.renameWorkspace(ctx, id, name),
    removeWorkspace: (id) => workspaceOps.removeWorkspace(ctx, id),
    activateWorkspace: (id) => workspaceOps.activateWorkspace(ctx, id),
    toggleWorkspaceExpanded: (id) => workspaceOps.toggleWorkspaceExpanded(ctx, id),
    setWorkspaceShowAll: (id, showAll) => workspaceOps.setWorkspaceShowAll(ctx, id, showAll),
    setThreadPinned: (id, pin) => workspaceOps.setThreadPinned(ctx, id, pin),
    setThreadUnread: (id, unread) => workspaceOps.setThreadUnread(ctx, id, unread),
    setWorkspacePinned: (id, pin) => workspaceOps.setWorkspacePinned(ctx, id, pin),
    setWorkspacePaneTab: (id, tab) => workspaceOps.setWorkspacePaneTab(ctx, id, tab),

    markNoticesRead: () => notices.markNoticesRead(ctx),
    openNotice: (id) => notices.openNotice(ctx, id),

    openGitGraph: () => sessionViews.openGitGraph(ctx),
    activateSessionView: (threadId, viewId) =>
      sessionViews.activateSessionView(ctx, threadId, viewId),
    closeSessionView: (threadId, viewId) => sessionViews.closeSessionView(ctx, threadId, viewId),
    openSessionFile: (threadId, path) => sessionViews.openSessionFile(ctx, threadId, path),
    addSessionShell: (threadId) => sessionViews.addSessionShell(ctx, threadId),
    onSessionEvent,
  }

  /** spawn 会话（terminal）：preset 查表 → cwd 继承链（preset 显式 cwd =
   *  用户配置意图 → 工作区目录 → 进程 CWD）→ spawnSession → push +
   *  lastUsedPreset + activate */
  async function spawnFromPreset(presetId: string, workspaceId?: string) {
    const preset = deps.presetOf(presetId)
    if (!preset) throw new Error(`unknown preset: ${presetId}`)
    const ws = workspaceId ? state().workspaces.find((w) => w.id === workspaceId) : undefined
    if (workspaceId && !ws) throw new Error(`unknown workspace: ${workspaceId}`)
    const cwd = preset.cwd ?? ws?.path ?? ctx.defaultCwd()
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
      createdAt: ctx.now(),
      workspaceId: ws?.id,
    }
    set((s) => {
      s.threads.push(thread)
      s.lastUsedPreset = preset.id
    })
    activate({ type: 'thread', id: thread.id })
  }

  /** 表面切换单点：聚焦即清 bell 红点（契约 §7）+ unread（打开即已读）+
   *  正在展示的视图 hasBell + 该会话通知标读 + lastSession 记录 →
   *  deps.navigate（settings/null 不动 threads，后台 PTY 照跑） */
  function activate(target: ActiveTarget) {
    if (target?.type === 'thread') {
      let touchedWorkspace = false
      set((s) => {
        const t = s.threads.find((x) => x.id === target.id)
        if (t && t.kind === 'terminal' && t.hasBell) t.hasBell = false
        if (t && t.unread) t.unread = false
        sessionViews.clearViewBell(t)
        for (const n of s.notices) if (n.threadId === target.id) n.read = true
        if (t?.workspaceId) {
          touchedWorkspace = recordLastSession(s.workspaces, t.workspaceId, t.id)
        }
      })
      if (touchedWorkspace) ctx.persist()
    }
    deps.navigate(target)
  }

  /** 会话移除单点：先导航离开（不变量 1）→ destroy/dispose/视图 PTY
   *  连带销毁 → 移除行 + lastSession 兑底 + persist */
  function close(id: string) {
    const thread = state().threads.find((t) => t.id === id)
    if (!thread) return
    if (routerPointsAt(id)) {
      activate(thread.workspaceId ? { type: 'workspace', id: thread.workspaceId } : null)
    }
    // destroySession 的 reject 已在 nativeDeps 的 trackNative 里进错误总线
    // （emit 后 rethrow）；这里只防空 rejection（错误不再二次处理）。
    if (thread.kind === 'terminal') deps.destroySession(thread.sessionId).catch(() => {})
    // 会话内 shell 视图绑的是独立 PTY（非 thread.sessionId）——随会话行一起销毁
    for (const v of thread.views ?? []) {
      if (v.kind === 'shell') deps.destroySession(v.sessionId).catch(() => {})
    }
    if (thread.kind === 'acp') {
      const agent = ctx.acpAgents.get(id)
      ctx.acpAgents.delete(id)
      try {
        agent?.dispose?.()
      } catch {
        // 忽略：行移除是主路径
      }
    }
    set((s) => {
      s.threads = s.threads.filter((t) => t.id !== id)
      if (thread.workspaceId) clearLastSession(s.workspaces, thread.workspaceId, id)
    })
    ctx.persist()
  }

  /** 空串忽略；terminal 写 customTitle → 冻结（不变量 2）；chat/acp 直接改
   *  title（首条消息改写只在哨兵期间发生——手改后冻结） */
  function rename(id: string, title: string) {
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
  }

  /** 环形移动（契约 §4）：基准 = 当前 active（activeThreadId 读侧）。
   *  无 active（'/' 或 settings 表面）时：dir=1 → 第一个，dir=-1 → 最后一个。 */
  function cycle(dir: 1 | -1) {
    const { threads } = state()
    if (threads.length === 0) return
    const idx = threads.findIndex((t) => t.id === ctx.activeThreadId())
    const nextIdx =
      idx === -1
        ? dir === 1
          ? 0
          : threads.length - 1
        : (idx + dir + threads.length) % threads.length
    activate({ type: 'thread', id: threads[nextIdx].id })
  }

  /** native → store 会话事件路由：主会话 `t$sid` 定位落空 → 视图 PTY
   *  归属（按 view.sessionId 路由到所属 shell 视图，disjoint 无歧义）；
   *  命中主会话走 title/bell/exit 三分支（冻结/红点+notify/灰行或
   *  closeOnExit 移除，通知落列经 pushNotice） */
  function onSessionEvent(e: TerminalSessionEvent) {
    const id = `t${e.sessionId}`
    if (!state().threads.some((t) => t.id === id)) {
      const owner = sessionViews.findShellViewOwner(state(), e.sessionId)
      if (owner) sessionViews.handleShellViewEvent(ctx, owner.thread, owner.view, e)
      return
    }
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
          const isTargetActive = ctx.activeThreadId() === id
          if (!isTargetActive) {
            set((s) => {
              const row = s.threads.find((x) => x.id === id)
              if (row && row.kind === 'terminal') row.hasBell = true
            })
            notices.pushNotice(ctx, t, 'warn', `「${displayTitle(t)}」等待注意`, {
              reason: 'BEL',
            })
            deps.notify(t)
          }
        }
        break
      }
      case 'exit': {
        const t = state().threads.find((x) => x.id === id)
        if (!t || t.kind !== 'terminal') return
        // 通知中心（D8）：退出是真实会话事件——非零码 err、正常退出 ok
        notices.pushNotice(ctx, t, notices.exitTone(e.code), `「${displayTitle(t)}」已退出`)
        if (deps.closeOnExit()) {
          close(id)
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
  }

  /** 路由是否指向该 thread（close 的先导航离开判定；未注入时保守视为指向） */
  function routerPointsAt(id: string): boolean {
    return deps.activeThreadId ? deps.activeThreadId() === id : true
  }
}
