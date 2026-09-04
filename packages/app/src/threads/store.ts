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

/** Phase 2 骨架（无行为） */
export type ChatThread = { kind: 'chat'; id: string; title: string; createdAt: number }
/** Phase 3 骨架（无行为） */
export type AcpThread = { kind: 'acp'; id: string; title: string; createdAt: number }

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
  /** 路由读侧（active 判定：bell 红点只打非 active、cycle 基准、close 先导航离开）。
   *  装配层注入（直接读 history）。未注入时：bell 视为非 active，close 保守先导航。 */
  activeThreadId?: () => string | null
}

export interface ThreadStore {
  getState(): ThreadState
  subscribe(fn: () => void): () => void
  spawnFromPreset(presetId: string): Promise<void>
  activate(target: ActiveTarget): void
  close(id: string): void
  rename(id: string, title: string): void
  cycle(dir: 1 | -1): void
  /** 装配层专用：native → store（经 events.ts 窄化后的判别联合） */
  onSessionEvent(e: TerminalSessionEvent): void
}

// ── 实现 ─────────────────────────────────────────────────────────────

export function createThreadStore(deps: ThreadDeps): ThreadStore {
  const store = createStore<ThreadState>(() => ({ threads: [], lastUsedPreset: null }))
  const set = (recipe: (s: ThreadState) => void) => store.setState(produce(recipe))
  const state = () => store.getState()

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

    activate,

    close(id) {
      const thread = state().threads.find((t) => t.id === id)
      if (!thread) return
      // 不变量 1：close 前先导航离开（路由不得指向将移除的行）
      if (routerPointsAt(id)) activate(null)
      if (thread.kind === 'terminal') void deps.destroySession(thread.sessionId)
      set((s) => {
        s.threads = s.threads.filter((t) => t.id !== id)
      })
    },

    rename(id, title) {
      // 空串忽略；写 customTitle → 冻结（不变量 2）
      if (!title.trim()) return
      set((s) => {
        const t = s.threads.find((x) => x.id === id)
        if (t && t.kind === 'terminal') t.customTitle = title
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
}
