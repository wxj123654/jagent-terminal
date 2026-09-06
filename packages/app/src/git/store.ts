/**
 * git/store.ts — GitGraphStore（docs/git-graph.md §2.3）。
 *
 * 独立于 ThreadStore（D5：git 数据非会话，生命周期 = workspace tab 级）。
 * zustand/vanilla + useSyncExternalStore 直桥（threads/store 同款底座）。
 *
 * CLI 面全部依赖注入（GitGraphDeps）：默认真实现（cli.ts），测试注假流。
 * mount 幂等：同 cwd 复用进行中/已完成的流；不同 cwd 取消旧流重跑（seq
 * 防旧流回调写入新挂载）。选中提交即异步加载 patch（详情列数据）。
 */

import { createStore } from 'zustand/vanilla'

import { findRepoRoot, showPatch, spawnGitLog, type GitLogHandle } from './cli'
import { GitGraphData, type CommitLine, type GraphRow } from './graph'

export type GitGraphStatus = 'idle' | 'loading' | 'ready' | 'error' | 'not-a-repo'

export interface GitGraphState {
  status: GitGraphStatus
  rows: readonly GraphRow[]
  /** 行号 → 覆盖该行的连接线（GitGraphData 增量维护的同一 Map 引用） */
  linesByRow: ReadonlyMap<number, readonly CommitLine[]>
  maxLanes: number
  /** 流式进度（工具条 n commits） */
  loadedCount: number
  selectedSha: string | null
  patch: string | null
  patchLoading: boolean
  patchError: string | null
  /** log 流级错误（非 repo 单列 status） */
  error: string | null
}

export interface GitGraphDeps {
  findRepoRoot: (cwd: string) => Promise<string | null>
  spawnGitLog: (
    cwd: string,
    onChunk: (commits: import('./cli').GraphCommit[]) => void,
  ) => GitLogHandle
  showPatch: (cwd: string, sha: string) => Promise<string>
}

const realDeps: GitGraphDeps = { findRepoRoot, spawnGitLog, showPatch }

const initialState: GitGraphState = {
  status: 'idle',
  rows: [],
  linesByRow: new Map(),
  maxLanes: 0,
  loadedCount: 0,
  selectedSha: null,
  patch: null,
  patchLoading: false,
  patchError: null,
  error: null,
}

export type GitGraphStore = {
  getState: () => GitGraphState
  subscribe: (fn: () => void) => () => void
  /** 幂等挂载：同 cwd 且流已建 → 复用；否则取消旧流重跑 */
  mount(cwd: string): void
  /** 选中提交（null = 清除）；选中即加载 patch */
  select(sha: string | null): void
  /** ↑/↓ 移动选中（越界钳制；无选中时从端点开始） */
  moveSelection(dir: 1 | -1): void
  /** 取消当前流 + 清态重跑 */
  refresh(): void
  /** 取消流 + 复位（装配层/测试用；切 workspace 由 mount(newCwd) 覆盖） */
  unmount(): void
}

export function createGitGraphStore(deps: GitGraphDeps = realDeps): GitGraphStore {
  const store = createStore<GitGraphState>(() => ({ ...initialState }))
  /** 挂载代际：旧流的回调/done 看到代际不符即静默丢弃 */
  let seq = 0
  let patchSeq = 0
  let data = new GitGraphData()
  let handle: GitLogHandle | null = null
  let mountedCwd: string | null = null
  let repoRoot: string | null = null

  const set = (patch: Partial<GitGraphState>) => store.setState({ ...patch })

  const cancelLog = () => {
    handle?.cancel()
    handle = null
  }

  async function mount(cwd: string): Promise<void> {
    if (mountedCwd === cwd && handle) return
    cancelLog()
    const mySeq = ++seq
    mountedCwd = cwd
    repoRoot = null
    data = new GitGraphData()
    set({
      status: 'loading',
      rows: [],
      linesByRow: data.linesByRow,
      maxLanes: 0,
      loadedCount: 0,
      selectedSha: null,
      patch: null,
      patchLoading: false,
      patchError: null,
      error: null,
    })

    const root = await deps.findRepoRoot(cwd)
    if (mySeq !== seq) return
    if (!root) {
      set({ status: 'not-a-repo' })
      return
    }
    repoRoot = root
    handle = deps.spawnGitLog(root, (chunk) => {
      if (mySeq !== seq) return
      data.addCommits(chunk)
      set({
        rows: data.rows.slice(),
        maxLanes: data.maxLanes,
        loadedCount: data.rows.length,
      })
    })
    const res = await handle.done
    if (mySeq !== seq) return
    if (res.error === 'cancelled') return
    if (!res.ok) {
      set({ status: 'error', error: res.error ?? 'git log failed' })
      return
    }
    set({
      status: data.rows.length > 0 ? 'ready' : 'error',
      error: data.rows.length > 0 ? null : '没有任何提交',
    })
  }

  async function select(sha: string | null): Promise<void> {
    set({ selectedSha: sha, patch: null, patchError: null, patchLoading: sha != null })
    if (!sha || !repoRoot) return
    const mySeq = ++patchSeq
    try {
      const patch = await deps.showPatch(repoRoot, sha)
      // 期间选中已变 / 已卸载 → 丢弃
      if (patchSeq !== mySeq || store.getState().selectedSha !== sha) return
      set({ patch, patchLoading: false })
    } catch (e) {
      if (patchSeq !== mySeq) return
      set({ patchLoading: false, patchError: e instanceof Error ? e.message : String(e) })
    }
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    mount: (cwd) => void mount(cwd),
    select: (sha) => void select(sha),
    moveSelection(dir) {
      const s = store.getState()
      if (s.rows.length === 0) return
      const idx = s.rows.findIndex((r) => r.commit.sha === s.selectedSha)
      const next =
        idx < 0
          ? dir === 1
            ? 0
            : s.rows.length - 1
          : Math.min(s.rows.length - 1, Math.max(0, idx + dir))
      const target = s.rows[next]
      if (target && target.commit.sha !== s.selectedSha) select(target.commit.sha)
    },
    refresh() {
      if (!mountedCwd) return
      const cwd = mountedCwd
      mountedCwd = null
      void mount(cwd)
    },
    unmount() {
      seq++
      patchSeq++
      cancelLog()
      mountedCwd = null
      repoRoot = null
      data = new GitGraphData()
      store.setState({ ...initialState })
    },
  }
}
