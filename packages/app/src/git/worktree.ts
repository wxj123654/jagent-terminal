/**
 * git/worktree.ts — WorktreeStore（D5 工作面板 + 工具栏分支徽章数据面）。
 *
 * 独立于 GitGraphStore（git log 流太重，工具栏徽章只需要 status+branch）；
 * 同底座（zustand/vanilla + DI deps，测试注假）。生命周期跟随当前上下文
 * cwd（活动会话 cwd / 工作区 path），mount(cwd) 幂等，切上下文重拉。
 *
 * 数据面全部是真实 git 数据：status --porcelain + diff --numstat HEAD +
 * rev-parse 分支名（cli.ts 聚合）。不造原型假数据。
 */

import { readFile, stat } from 'node:fs/promises'

import { createStore } from 'zustand/vanilla'

import { diffWorktreeFile, listWorktreeStatus, type WorktreeFile, type WorktreeStatus } from './cli'

export type WorktreeLoadStatus = 'idle' | 'loading' | 'ready' | 'error' | 'not-a-repo'

export interface WorktreeState {
  /** 挂载上下文（工作区 path / 未归属会话 cwd） */
  cwd: string | null
  status: WorktreeLoadStatus
  /** repo root（diff/preview 的 cwd 基准；非 repo 为 null） */
  root: string | null
  /** 当前分支（detached/空 repo → null） */
  branch: string | null
  /** 变更文件表（porcelain ∪ numstat 合并） */
  files: WorktreeFile[]
  /** 面板选中文件（diff 视图目标；null = 未选） */
  selected: string | null
  /** 选中文件的 unified patch；未跟踪/无 diff 为空串 */
  diff: string | null
  diffLoading: boolean
  /** 文件预览内容（files tab；已截断 cap） */
  preview: string | null
  previewLoading: boolean
  error: string | null
}

export interface WorktreeDeps {
  status: (cwd: string) => Promise<WorktreeStatus | null>
  diff: (root: string, path: string) => Promise<string>
  /** 文件预览（二进制/过大返回 null） */
  readFile: (path: string) => Promise<string | null>
}

/** 预览上限：512KB / 前 400 行（面板是预览不是编辑器） */
const PREVIEW_MAX_BYTES = 512 * 1024
const PREVIEW_MAX_LINES = 400

async function readTextFile(path: string): Promise<string | null> {
  try {
    const st = await stat(path)
    if (!st.isFile() || st.size > PREVIEW_MAX_BYTES) return null
    const text = await readFile(path, 'utf8')
    const lines = text.split('\n')
    return lines.length > PREVIEW_MAX_LINES ? lines.slice(0, PREVIEW_MAX_LINES).join('\n') : text
  } catch {
    return null
  }
}

const realDeps: WorktreeDeps = {
  status: listWorktreeStatus,
  diff: diffWorktreeFile,
  readFile: readTextFile,
}

const initialState: WorktreeState = {
  cwd: null,
  status: 'idle',
  root: null,
  branch: null,
  files: [],
  selected: null,
  diff: null,
  diffLoading: false,
  preview: null,
  previewLoading: false,
  error: null,
}

export type WorktreeStore = {
  getState: () => WorktreeState
  subscribe: (fn: () => void) => () => void
  /** 上下文挂载：同 cwd 且已加载 → no-op；否则重拉（切会话/工作区时调） */
  mount(cwd: string | null): void
  /** 强制重拉（面板刷新钮 / 打开面板时） */
  refresh(): void
  /** 选中文件：拉 diff（tracked）+ 预览（files tab 共用同一选中） */
  select(path: string | null): void
}

export function createWorktreeStore(deps: WorktreeDeps = realDeps): WorktreeStore {
  const store = createStore<WorktreeState>(() => ({ ...initialState }))
  /** 代际：旧请求回调看到代际不符即丢弃（同 GitGraphStore seq 纪律） */
  let seq = 0

  const load = async (cwd: string, generation: number) => {
    store.setState((s) => ({ ...s, status: 'loading', error: null }))
    try {
      const result = await deps.status(cwd)
      if (generation !== seq) return
      if (!result) {
        store.setState((s) => ({
          ...s,
          status: 'not-a-repo',
          root: null,
          branch: null,
          files: [],
          selected: null,
          diff: null,
          preview: null,
        }))
        return
      }
      store.setState((s) => {
        // 选中文件在新快照里还在则保留（刷新不该打断用户选择）
        const selected =
          s.selected && result.files.some((f) => f.path === s.selected) ? s.selected : null
        return {
          ...s,
          status: 'ready',
          root: result.root,
          branch: result.branch,
          files: result.files,
          selected,
          diff: selected === s.selected ? s.diff : null,
          preview: selected === s.selected ? s.preview : null,
        }
      })
    } catch (e) {
      if (generation !== seq) return
      store.setState((s) => ({
        ...s,
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      }))
    }
  }

  return {
    getState: () => store.getState(),
    subscribe: (fn) => store.subscribe(fn),

    mount(cwd) {
      if (cwd === store.getState().cwd && store.getState().status !== 'idle') return
      seq++
      store.setState((s) => ({
        ...s,
        cwd,
        status: cwd ? 'loading' : 'idle',
        root: null,
        branch: null,
        files: [],
        selected: null,
        diff: null,
        preview: null,
        error: null,
      }))
      if (cwd) void load(cwd, seq)
    },

    refresh() {
      const { cwd } = store.getState()
      if (!cwd) return
      seq++
      void load(cwd, seq)
    },

    select(path) {
      const generation = seq
      const { root } = store.getState()
      store.setState((s) => ({
        ...s,
        selected: path,
        diff: null,
        preview: null,
        diffLoading: !!path,
        previewLoading: !!path,
      }))
      if (!path || !root) {
        store.setState((s) => ({ ...s, diffLoading: false, previewLoading: false }))
        return
      }
      const abs = `${root}/${path}`
      void deps
        .diff(root, path)
        .then((patch) => {
          if (generation !== seq) return
          store.setState((s) =>
            s.selected === path ? { ...s, diff: patch, diffLoading: false } : s,
          )
        })
        .catch(() => {
          if (generation !== seq) return
          store.setState((s) => (s.selected === path ? { ...s, diff: '', diffLoading: false } : s))
        })
      void deps
        .readFile(abs)
        .then((text) => {
          if (generation !== seq) return
          store.setState((s) =>
            s.selected === path ? { ...s, preview: text, previewLoading: false } : s,
          )
        })
        .catch(() => {
          if (generation !== seq) return
          store.setState((s) =>
            s.selected === path ? { ...s, preview: null, previewLoading: false } : s,
          )
        })
    },
  }
}
