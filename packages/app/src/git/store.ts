/**
 * git/store.ts — GitGraphStore（docs/git-graph.md §2.3）。
 *
 * 独立于 ThreadStore（D5：git 数据非会话，生命周期 = workspace tab 级）。
 * zustand/vanilla + useSyncExternalStore 直桥（threads/store 同款底座）。
 *
 * CLI 面全部依赖注入（GitGraphDeps）：默认真实现（cli.ts），测试注假流。
 * mount 幂等：同 cwd 复用进行中/已完成的流；不同 cwd 取消旧流重跑（seq
 * 防旧流回调写入新挂载）。选中提交即异步加载说明正文 + 变更文件（行内 CDV）。
 */

import { createStore } from 'zustand/vanilla'

import {
  findRepoRoot,
  listBranches,
  listChangedFiles,
  runGit,
  showCommitBody,
  spawnGitLog,
  type ChangedFile,
  type GitBranch,
  type GitLogHandle,
} from './cli'
import {
  firstParentChain,
  GitGraphData,
  type CommitLine,
  type GraphRow,
} from './graph'

export type GitGraphStatus =
  'idle' | 'loading' | 'ready' | 'error' | 'not-a-repo'

export interface GitGraphState {
  status: GitGraphStatus
  rows: readonly GraphRow[]
  /** 行号 → 覆盖该行的连接线（GitGraphData 增量维护的同一 Map 引用） */
  linesByRow: ReadonlyMap<number, readonly CommitLine[]>
  maxLanes: number
  /** 流式进度（工具条 n commits） */
  loadedCount: number
  selectedSha: string | null
  /** 选中提交的说明正文（%b）；无正文为空串 */
  body: string | null
  detailLoading: boolean
  detailError: string | null
  /** 选中提交的变更文件（行内详情文件树） */
  files: readonly ChangedFile[]
  /** HEAD 第一父链之外的 sha（mute 非线性提交） */
  muteShas: ReadonlySet<string>
  branches: readonly GitBranch[]
  showRemote: boolean
  findQuery: string
  findMatches: readonly string[]
  findIndex: number
  actionError: string | null
  /** log 流级错误（非 repo 单列 status） */
  error: string | null
}

export interface GitGraphDeps {
  findRepoRoot: (cwd: string) => Promise<string | null>
  spawnGitLog: (
    cwd: string,
    onChunk: (commits: import('./cli').GraphCommit[]) => void,
  ) => GitLogHandle
  showCommitBody: (cwd: string, sha: string) => Promise<string>
  listChangedFiles: (cwd: string, sha: string) => Promise<ChangedFile[]>
  listBranches: (cwd: string) => Promise<GitBranch[]>
  runGit: (cwd: string, args: string[]) => Promise<string>
}

const realDeps: GitGraphDeps = {
  findRepoRoot,
  spawnGitLog,
  showCommitBody,
  listChangedFiles,
  listBranches,
  runGit,
}

const initialState: GitGraphState = {
  status: 'idle',
  rows: [],
  linesByRow: new Map(),
  maxLanes: 0,
  loadedCount: 0,
  selectedSha: null,
  body: null,
  detailLoading: false,
  detailError: null,
  files: [],
  muteShas: new Set(),
  branches: [],
  showRemote: true,
  findQuery: '',
  findMatches: [],
  findIndex: -1,
  actionError: null,
  error: null,
}

export type GitGraphStore = {
  getState: () => GitGraphState
  subscribe: (fn: () => void) => () => void
  /** 幂等挂载：同 cwd 且流已建 → 复用；否则取消旧流重跑 */
  mount(cwd: string): void
  /** 选中提交（null = 清除）；选中即加载说明正文 + 文件树 */
  select(sha: string | null): void
  /** ↑/↓ 移动选中（越界钳制；无选中时从端点开始） */
  moveSelection(dir: 1 | -1): void
  /** 取消当前流 + 清态重跑 */
  refresh(): void
  /** 取消流 + 复位（装配层/测试用；切 workspace 由 mount(newCwd) 覆盖） */
  unmount(): void
  setShowRemote(on: boolean): void
  find(query: string): void
  findNext(dir?: 1 | -1): void
  runAction(args: string[]): Promise<void>
}

export function createGitGraphStore(
  deps: GitGraphDeps = realDeps,
): GitGraphStore {
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
      body: null,
      detailLoading: false,
      detailError: null,
      files: [],
      muteShas: new Set(),
      findQuery: '',
      findMatches: [],
      findIndex: -1,
      actionError: null,
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
      const chain = firstParentChain(data.rows.map((r) => r.commit))
      const mute = new Set(
        data.rows
          .filter((r) => !chain.has(r.commit.sha))
          .map((r) => r.commit.sha),
      )
      set({
        rows: data.rows.slice(),
        maxLanes: data.maxLanes,
        loadedCount: data.rows.length,
        muteShas: mute,
      })
    })
    void deps.listBranches?.(root).then((branches) => {
      if (mySeq !== seq) return
      set({ branches })
    })
    const res = await handle.done
    if (mySeq !== seq) return
    if (res.error === 'cancelled') return
    if (!res.ok) {
      set({ status: 'error', error: res.error ?? 'git log failed' })
      return
    }
    const chain = firstParentChain(data.rows.map((r) => r.commit))
    const mute = new Set(
      data.rows
        .filter((r) => !chain.has(r.commit.sha))
        .map((r) => r.commit.sha),
    )
    set({
      status: data.rows.length > 0 ? 'ready' : 'error',
      error: data.rows.length > 0 ? null : '没有任何提交',
      muteShas: mute,
    })
  }

  async function select(sha: string | null): Promise<void> {
    set({
      selectedSha: sha,
      body: null,
      detailError: null,
      detailLoading: sha != null,
      files: [],
    })
    if (!sha || !repoRoot) return
    const mySeq = ++patchSeq
    const root = repoRoot
    try {
      const [body, files] = await Promise.all([
        deps.showCommitBody(root, sha),
        deps.listChangedFiles?.(root, sha) ?? Promise.resolve([]),
      ])
      if (patchSeq !== mySeq || store.getState().selectedSha !== sha) return
      set({ body, files, detailLoading: false })
    } catch (e) {
      if (patchSeq !== mySeq) return
      set({
        detailLoading: false,
        detailError: e instanceof Error ? e.message : String(e),
      })
    }
  }

  function applyFind(query: string, dir: 0 | 1 | -1) {
    const q = query.trim().toLowerCase()
    if (!q) {
      set({ findQuery: '', findMatches: [], findIndex: -1 })
      return
    }
    const matches = store
      .getState()
      .rows.filter(
        (r) =>
          r.commit.subject.toLowerCase().includes(q) ||
          r.commit.sha.toLowerCase().startsWith(q),
      )
      .map((r) => r.commit.sha)
    if (matches.length === 0) {
      set({ findQuery: query, findMatches: [], findIndex: -1 })
      return
    }
    const prev = store.getState().findIndex
    const idx =
      dir === 0
        ? 0
        : ((prev < 0 ? 0 : prev) + dir + matches.length) % matches.length
    set({ findQuery: query, findMatches: matches, findIndex: idx })
    const sha = matches[idx]
    if (sha) void select(sha)
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
      if (target && target.commit.sha !== s.selectedSha)
        select(target.commit.sha)
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
    setShowRemote(on) {
      set({ showRemote: on })
    },
    find(query) {
      applyFind(query, 0)
    },
    findNext(dir = 1) {
      applyFind(store.getState().findQuery, dir)
    },
    async runAction(args) {
      if (!repoRoot) return
      set({ actionError: null })
      try {
        await deps.runGit(repoRoot, args)
        if (mountedCwd) {
          const cwd = mountedCwd
          mountedCwd = null
          void mount(cwd)
        }
      } catch (e) {
        set({ actionError: e instanceof Error ? e.message : String(e) })
      }
    },
  }
}
