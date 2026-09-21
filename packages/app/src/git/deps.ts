/**
 * git/deps.ts — Git store 依赖的真实适配器装配（DI 工厂单点）。
 *
 * store.ts / worktree.ts 声明各自的 deps interface（消费方持有接口），
 * 本模块把 cli.ts 的进程边界函数与 fs/readTextFile 预览适配器装成实现——
 * 「哪个 store 用哪些真函数」一目了然；测试仍注假流，不经过这里。
 */

import { readTextFile } from '../fs/readTextFile'
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
