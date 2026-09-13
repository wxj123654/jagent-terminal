/**
 * git/deps.ts — Git store 依赖的真实适配器装配（DI 工厂单点）。
 *
 * store.ts / worktree.ts 声明各自的 deps interface（消费方持有接口），
 * 本模块把 cli.ts 的进程边界函数与 node:fs 预览适配器装成实现——
 * 「哪个 store 用哪些真函数」一目了然；测试仍注假流，不经过这里。
 */

import { readFile, stat } from 'node:fs/promises'

import {
  diffWorktreeFile,
  findRepoRoot,
  listBranches,
  listChangedFiles,
  listWorktreeStatus,
  runGit,
  showCommitBody,
  spawnGitLog,
} from './cli'
import type { GitGraphDeps } from './store'
import type { WorktreeDeps } from './worktree'

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

export const realGitGraphDeps: GitGraphDeps = {
  findRepoRoot,
  spawnGitLog,
  showCommitBody,
  listChangedFiles,
  listBranches,
  runGit,
}

export const realWorktreeDeps: WorktreeDeps = {
  status: listWorktreeStatus,
  diff: diffWorktreeFile,
  readFile: readTextFile,
}
