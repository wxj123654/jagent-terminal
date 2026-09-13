/**
 * git/types.ts — Git 域类型（git-graph.md §2；从 cli.ts 提取）。
 *
 * 域模型单点：store/graph/view/fileTree 消费的是这些形状，不依赖 cli.ts 的
 * 进程边界（spawn/流式解析归 cli.ts，本文件零 IO 零依赖）。
 */

/** git log 行解析后的提交（Zed 十字段格式；%b 正文选中时另拉） */
export interface GraphCommit {
  /** %H 全 sha（oid 键） */
  sha: string
  /** %P 按空白切 */
  parents: string[]
  /** %D 逗号+空格切；detached HEAD / 普通提交为 [] */
  refNames: string[]
  shortSha: string
  authorName: string
  authorEmail: string
  /** %at 秒 */
  timestamp: number
  committerName: string
  committerEmail: string
  subject: string
}

/** 流式 git log 句柄（spawnGitLog 的返回面） */
export interface GitLogHandle {
  /** kill 子进程并停止回调；幂等 */
  cancel(): void
  /** 进程结束（含取消/非零退出，都 resolve 不 reject） */
  done: Promise<{ ok: boolean; error?: string }>
}

/** 单提交/工作区的变更文件（numstat 行） */
export interface ChangedFile {
  path: string
  /** 二进制为 null */
  added: number | null
  deleted: number | null
}

/** 本地分支（for-each-ref 行） */
export interface GitBranch {
  name: string
  current: boolean
}

// ── 工作区状态（D5 工作面板：status 文件表 / diff / 当前分支）──────────

export type WorktreeFileKind = 'm' | 'a' | 'd'

export interface WorktreeFile extends ChangedFile {
  /** porcelain 状态归并：m 修改 / a 新增（含 ?? 未跟踪与暂存新文件）/ d 删除 */
  status: WorktreeFileKind
}

export interface WorktreeStatus {
  /** repo root（diff/preview 的 cwd 基准） */
  root: string
  /** 当前分支名；detached HEAD / 空 repo → null */
  branch: string | null
  files: WorktreeFile[]
}
