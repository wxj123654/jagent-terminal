/**
 * threads/internal/sessionViews.ts — 会话内视图簇（Phase R；原型
 * SessionTabs：main/git/file/shell tab）。
 *
 * 规则单点：
 * - CRUD：activate/close/openFile/addShell（'main' 虚拟 id 不落 views
 *   数组；file:<path> 去重；shell:N 递增绑真 PTY + 孤儿回收）
 * - 「已看到」单点 clearViewBell：当前展示的 shell 视图清 hasBell
 *   （activate / activateSessionView 共用；后台程序化调用不清）
 * - 视图 PTY 事件归属：主会话 `t$sid` 定位落空 → 按 view.sessionId
 *   路由到所属 shell 视图（sessionId 与主会话 disjoint，无歧义）
 * - removeSessionView：closeSessionView / 视图 exit+closeOnExit 共用
 *   （shell 连带销毁 PTY；关当前视图 → 回退左邻或主面）
 *
 * 跨簇调用：pushNotice/exitTone 单向 import 自 notices（无环——notices
 * 不反向依赖本模块）；deps.spawnSession/destroySession（PTY 生命周期）。
 * internal seam——只被 store.ts 装配调用，不对外导出。
 */

import type { TerminalSessionEvent } from '../events'
import { MAIN_VIEW_ID, sessionViewTitle, threadTitle } from '../store'
import type { ShellView, Thread, ThreadState } from '../store'
import type { StoreCtx } from './ctx'
import { exitTone, pushNotice } from './notices'

/** 「已看到」单点：当前展示的 shell 视图清 hasBell（activate / activateSessionView 共用） */
export function clearViewBell(t: Thread | undefined): void {
  const v = t?.views?.find((x) => x.id === t.activeViewId)
  if (v?.kind === 'shell' && v.hasBell) v.hasBell = false
}

/** 视图 PTY 归属查找：按 view.sessionId 定位 → 属主对 {所属会话, shell 视图} */
export function findShellViewOwner(
  s: ThreadState,
  sessionId: number,
): { thread: Thread; view: ShellView } | undefined {
  for (const t of s.threads)
    for (const v of t.views ?? [])
      if (v.kind === 'shell' && v.sessionId === sessionId) return { thread: t, view: v }
}

/** 视图移除单点（closeSessionView / 视图 PTY exit+closeOnExit 共用）：
 *  shell 视图连带销毁 PTY（防空 rejection 同 close 纪律）；关的是当前
 *  视图 → 回退左邻或主面（原型契约） */
export function removeSessionView(ctx: StoreCtx, threadId: string, viewId: string): void {
  const t = ctx.state().threads.find((x) => x.id === threadId)
  const i = t?.views?.findIndex((v) => v.id === viewId) ?? -1
  if (!t || i < 0) return
  const view = t.views![i]!
  if (view.kind === 'shell') ctx.deps.destroySession(view.sessionId).catch(() => {})
  ctx.set((s) => {
    const tt = s.threads.find((x) => x.id === threadId)
    const j = tt?.views?.findIndex((v) => v.id === viewId) ?? -1
    if (!tt || j < 0) return
    tt.views!.splice(j, 1)
    if (tt.activeViewId === viewId) tt.activeViewId = tt.views![j - 1]?.id ?? MAIN_VIEW_ID
  })
}

/** 激活会话内视图（'main' = 回主面；不存在 id 忽略）。
 *  「已看到」只对真正展示的视图成立——后台会话的程序化调用不清标记 */
export function activateSessionView(ctx: StoreCtx, threadId: string, viewId: string): void {
  const active = ctx.activeThreadId() === threadId
  ctx.set((s) => {
    const t = s.threads.find((x) => x.id === threadId)
    if (!t) return
    if (viewId !== MAIN_VIEW_ID && !t.views?.some((v) => v.id === viewId)) return
    t.activeViewId = viewId
    if (active) clearViewBell(t)
  })
}

/** 关闭会话内视图（'main' 不可关——原型契约） */
export function closeSessionView(ctx: StoreCtx, threadId: string, viewId: string): void {
  if (viewId === MAIN_VIEW_ID) return
  removeSessionView(ctx, threadId, viewId)
}

/** 打开文件视图（file:<path> 去重复用；原型「打开文件」列表项） */
export function openSessionFile(ctx: StoreCtx, threadId: string, path: string): void {
  ctx.set((s) => {
    const t = s.threads.find((x) => x.id === threadId)
    if (!t) return
    t.views ??= []
    const id = `file:${path}`
    if (!t.views.some((v) => v.id === id))
      t.views.push({
        id,
        kind: 'file',
        label: path.split(/[\\/]/).pop() || path,
        path,
      })
    t.activeViewId = id
  })
}

/** 新建会话内 shell 视图（真 PTY：spawnSession；cwd = 会话 cwd /
 *  归属工作区 path / 进程 CWD 继承链；spawn 期间会话被关 → 孤儿
 *  PTY 立即回收不落视图） */
export async function addSessionShell(ctx: StoreCtx, threadId: string): Promise<void> {
  const t = ctx.state().threads.find((x) => x.id === threadId)
  if (!t) return
  const cwd =
    (t.kind === 'terminal' ? t.cwd : undefined) ??
    ctx.state().workspaces.find((w) => w.id === t.workspaceId)?.path ??
    ctx.defaultCwd()
  const sessionId = await ctx.deps.spawnSession({ cwd })
  if (!ctx.state().threads.some((x) => x.id === threadId)) {
    ctx.deps.destroySession(sessionId).catch(() => {})
    return
  }
  ctx.set((s) => {
    const tt = s.threads.find((x) => x.id === threadId)
    if (!tt) return
    tt.views ??= []
    let n = 1
    while (tt.views.some((v) => v.id === `shell:${n}`)) n++
    tt.views.push({
      id: `shell:${n}`,
      kind: 'shell',
      label: `Shell ${n}`,
      sessionId,
      cwd,
      status: 'running',
    })
    tt.activeViewId = `shell:${n}`
  })
}

/** 打开 Git 图（git-graph.md §4.1 + 原型 40d30e8）：活跃会话已归属工作区
 *  → 会话内 'git' 视图（不切路由）；否则当前/首个工作区切 paneTab=git
 *  并激活 */
export function openGitGraph(ctx: StoreCtx): void {
  const s = ctx.state()
  const threadId = ctx.deps.activeThreadId?.() ?? null
  const t = threadId ? s.threads.find((x) => x.id === threadId) : undefined
  if (t?.workspaceId) {
    ctx.set((st) => {
      const tt = st.threads.find((x) => x.id === t.id)
      if (!tt) return
      tt.views ??= []
      if (!tt.views.some((v) => v.id === 'git'))
        tt.views.push({ id: 'git', kind: 'git', label: 'Git 图' })
      tt.activeViewId = 'git'
    })
    return
  }
  // 非会话上下文（工作区页/未归属会话/起始页）→ 工作区 paneTab 路径
  const id = ctx.deps.activeWorkspaceId?.() ?? s.workspaces[0]?.id
  if (!id) return
  ctx.set((st) => {
    const ws = st.workspaces.find((w) => w.id === id)
    if (ws && ws.paneTab !== 'git') ws.paneTab = 'git'
  })
  ctx.persist()
  ctx.activate({ type: 'workspace', id })
}

/** 视图 PTY 事件（R1）：title/bell/exit 归属到所属 shell 视图——
 *  title → view.oscTitle（空串忽略，同主会话）；
 *  bell → 视图正显示则丢弃；否则 view.hasBell，且会话本身在后台时
 *         走会话级提醒面（terminal=hasBell / chat·acp=unread）+ notice + notify；
 *  exit → notice + status='exited'（closeOnExit → 移除视图） */
export function handleShellViewEvent(
  ctx: StoreCtx,
  thread: Thread,
  view: ShellView,
  e: TerminalSessionEvent,
): void {
  switch (e.type) {
    case 'title': {
      if (!e.title) return // 空串忽略（同主会话规则）
      ctx.set((s) => {
        const v = s.threads.find((x) => x.id === thread.id)?.views?.find((x) => x.id === view.id)
        if (v?.kind === 'shell') v.oscTitle = e.title
      })
      break
    }
    case 'bell': {
      const threadActive = ctx.activeThreadId() === thread.id
      // 视图正在显示（会话 active 且它是活动视图）→ 同主面规则：不落标记
      if (threadActive && (thread.activeViewId ?? MAIN_VIEW_ID) === view.id) return
      ctx.set((s) => {
        const tt = s.threads.find((x) => x.id === thread.id)
        const v = tt?.views?.find((x) => x.id === view.id)
        if (v?.kind === 'shell') v.hasBell = true
        // 会话本身在后台 → 会话级提醒（activate 清除面与主会话对称）
        if (tt && !threadActive) {
          if (tt.kind === 'terminal') tt.hasBell = true
          else tt.unread = true
        }
      })
      if (!threadActive) {
        pushNotice(
          ctx,
          thread,
          'warn',
          `「${threadTitle(thread)} · ${sessionViewTitle(view)}」等待注意`,
          { reason: 'BEL', viewId: view.id },
        )
        ctx.deps.notify(thread)
      }
      break
    }
    case 'exit': {
      pushNotice(
        ctx,
        thread,
        exitTone(e.code),
        `「${threadTitle(thread)} · ${sessionViewTitle(view)}」已退出`,
        { viewId: view.id },
      )
      if (ctx.deps.closeOnExit()) {
        // PTY 已死；destroySession 走同一移除单点（幂等 catch）
        removeSessionView(ctx, thread.id, view.id)
      } else {
        ctx.set((s) => {
          const v = s.threads.find((x) => x.id === thread.id)?.views?.find((x) => x.id === view.id)
          if (v?.kind === 'shell') {
            v.status = 'exited'
            v.exitCode = e.code ?? null
          }
        })
      }
      break
    }
  }
}
