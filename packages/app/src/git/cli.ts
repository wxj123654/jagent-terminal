/**
 * git/cli.ts — git CLI 子进程封装（docs/git-graph.md §2.1）。
 *
 * 唯一的进程边界：spawnGitLog（流式）/ findRepoRoot / showCommitBody / listChangedFiles。
 * 协议照抄 Zed `crates/git/src/repository.rs`：`--format` 用 \x00 分字段、
 * --date-order、按 chunk 回调（512 行）。stdout 走 ReadableStream + 流式
 * TextDecoder 行缓冲——禁止全量 text() 拼接（大 repo 会卡爆）。
 *
 * 本模块只依赖 node:child_process（spawn），不 import 项目内其他模块；解析行为由
 * cli.test.ts 锁定，真进程冒烟也在测试里跑（开发机必有 git）。
 *
 * ⚠ 为什么不用 Bun.spawn（性能相当，但 Windows 打包是 GUI 子系统）：
 * GUI 子系统进程没有可继承的 console，spawn console 子进程时 Windows 会给
 * 子进程新建一个**可见**控制台窗口（git 面板每次刷新都闪黑框）。压住它必须
 * 传 CREATE_NO_WINDOW，而 Bun.spawn 的 `windowsHide` 在 bun 1.3.13 实测
 * **无效**（子进程仍有 console 窗口）；node:child_process 的 spawn 走 libuv
 * 的 UV_PROCESS_WINDOWS_HIDE_CONSOLE，实测有效。故本模块统一用后者。
 */

import { spawn, type ChildProcess } from 'node:child_process'

/** Zed 三字段 + 行内 CDV 元数据（email/committer 单行字段；body 含换行，选中时另拉） */
const LOG_FORMAT = '--format=%H%x00%P%x00%D%x00%h%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%s'

/** 流式回调的 chunk 大小（Zed GRAPH_CHUNK_SIZE 同量级：首屏快 + 避免 setState 风暴） */
const CHUNK_SIZE = 512

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

/** 单行解析：字段数 < 10 或空 sha → null（坏行丢弃不炸） */
export function parseLogLine(line: string): GraphCommit | null {
  if (!line) return null
  const parts = line.split('\x00')
  if (parts.length < 10) return null
  const [
    sha,
    parentsStr,
    decor,
    shortSha,
    authorName,
    authorEmail,
    ts,
    committerName,
    committerEmail,
    subject,
  ] = parts
  if (!sha) return null
  return {
    sha,
    parents: parentsStr ? parentsStr.split(/\s+/).filter(Boolean) : [],
    refNames: decor ? decor.split(', ').filter(Boolean) : [],
    shortSha: shortSha ?? '',
    authorName: authorName ?? '',
    authorEmail: authorEmail ?? '',
    timestamp: ts ? parseInt(ts, 10) || 0 : 0,
    committerName: committerName ?? '',
    committerEmail: committerEmail ?? '',
    subject: subject ?? '',
  }
}

/** 流式字节 → 完整行（\n 切）。跨 chunk 的半行留在缓冲里。 */
export class LineBuffer {
  private buf = ''
  private decoder = new TextDecoder('utf-8')

  push(bytes: Uint8Array): string[] {
    this.buf += this.decoder.decode(bytes, { stream: true })
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    return lines
  }

  /** 流结束：冲掉残留（git log 末行无换行的兜底） */
  flush(): string[] {
    const rest = this.buf + this.decoder.decode()
    this.buf = ''
    return rest ? [rest] : []
  }
}

export interface GitLogHandle {
  /** kill 子进程并停止回调；幂等 */
  cancel(): void
  /** 进程结束（含取消/非零退出，都 resolve 不 reject） */
  done: Promise<{ ok: boolean; error?: string }>
}

/**
 * 统一的 git 子进程入口：Windows 上必须 windowsHide（见文件头注），
 * stdio 固定 ['ignore','pipe','pipe']（stdin 不给子进程，防 git 等输入）。
 */
function spawnGit(args: string[], cwd: string): ChildProcess {
  return spawn('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

/** 读完一个可读流（utf8 文本）；流为 null（子进程启动失败）时返回空串 */
function collectText(stream: ChildProcess['stdout']): Promise<string> {
  if (!stream) return Promise.resolve('')
  return new Promise((resolve, reject) => {
    let text = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      text += chunk
    })
    stream.on('end', () => resolve(text))
    stream.on('error', reject)
  })
}

/** 等子进程结束：返回 exit code；启动失败（ENOENT 等）reject */
function waitExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
}

export function spawnGitLog(cwd: string, onChunk: (commits: GraphCommit[]) => void): GitLogHandle {
  const lb = new LineBuffer()
  let cancelled = false
  let pending: GraphCommit[] = []
  /** stderr 尾部（环形截断；进程异常退出时附给错误消息） */
  let stderrTail = ''

  const emit = () => {
    if (pending.length > 0 && !cancelled) {
      onChunk(pending)
      pending = []
    }
  }

  let child: ChildProcess
  try {
    child = spawnGit(['log', LOG_FORMAT, '--date-order'], cwd)
  } catch (e) {
    // 同步 throw（极罕见；ENOENT 走异步 'error'）
    const error = e instanceof Error ? e.message : String(e)
    return { cancel: () => {}, done: Promise.resolve({ ok: false, error }) }
  }

  // stderr 必须同时消费：只读 stdout 会让子进程在 stderr 缓冲区满时卡死
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4096)
  })

  const finished = new Promise<{ code: number | null; spawnError?: string }>((resolve) => {
    let settled = false
    child.once('error', (e) => {
      if (settled) return
      settled = true
      resolve({ code: null, spawnError: e.message })
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      resolve({ code })
    })
  })

  const done = (async () => {
    /** 读 stdout 失败的原因（子进程启动失败/中途断开）；有 spawnError 时优先用后者 */
    let readError: string | undefined
    try {
      if (child.stdout) {
        for await (const chunk of child.stdout) {
          if (cancelled) break
          for (const line of lb.push(chunk as Uint8Array)) {
            const c = parseLogLine(line)
            if (c) {
              pending.push(c)
              if (pending.length >= CHUNK_SIZE) emit()
            }
          }
        }
      }
      if (!cancelled) {
        for (const line of lb.flush()) {
          const c = parseLogLine(line)
          if (c) pending.push(c)
        }
        emit()
      }
    } catch (e) {
      // 子进程早退时 node 的 stdout 流会以 "Premature close" 之类的错误结束；
      // 真因在 spawnError/stderr 里，这里只记下备选消息
      readError = e instanceof Error ? e.message : String(e)
    }
    const { code, spawnError } = await finished
    if (spawnError) return { ok: false, error: spawnError }
    if (cancelled) return { ok: false, error: 'cancelled' }
    if (readError) return { ok: false, error: stderrTail.trim() || readError }
    if (code !== 0) {
      return {
        ok: false,
        error: stderrTail.trim() || `git log exited with ${code}`,
      }
    }
    return { ok: true }
  })()

  return {
    cancel() {
      if (cancelled) return
      cancelled = true
      pending = []
      try {
        child.kill()
      } catch {
        // 已退出
      }
    },
    done,
  }
}

/** repo root 检测（git rev-parse --show-toplevel）；非 repo / 无 git → null */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  try {
    const child = spawnGit(['rev-parse', '--show-toplevel'], cwd)
    const [out, code] = await Promise.all([collectText(child.stdout), waitExit(child)])
    if (code !== 0) return null
    return out.trim() || null
  } catch {
    return null
  }
}

/** 一次性 git 子进程（非流式）。stdout 全文返回；非 0 抛 stderr。 */
export async function runGit(cwd: string, args: string[]): Promise<string> {
  const child = spawnGit(args, cwd)
  const [out, err, code] = await Promise.all([
    collectText(child.stdout),
    collectText(child.stderr),
    waitExit(child),
  ])
  if (code !== 0) throw new Error(err.trim() || `git ${args[0] ?? ''} exited with ${code}`)
  return out
}

export interface ChangedFile {
  path: string
  /** 二进制为 null */
  added: number | null
  deleted: number | null
}

/** `git diff-tree --numstat` / `git show --numstat --format=` 输出解析 */
export function parseChangedFiles(raw: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    const tab1 = line.indexOf('\t')
    const tab2 = tab1 >= 0 ? line.indexOf('\t', tab1 + 1) : -1
    if (tab1 < 0 || tab2 < 0) continue
    const a = line.slice(0, tab1)
    const d = line.slice(tab1 + 1, tab2)
    const path = line.slice(tab2 + 1)
    if (!path) continue
    files.push({
      path,
      added: a === '-' ? null : parseInt(a, 10) || 0,
      deleted: d === '-' ? null : parseInt(d, 10) || 0,
    })
  }
  return files
}

export interface GitBranch {
  name: string
  current: boolean
}

/** `git for-each-ref --format=%(refname:short)%x00%(HEAD)` refs/heads */
export function parseBranches(raw: string): GitBranch[] {
  const out: GitBranch[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    const [name, head] = line.split('\x00')
    if (!name) continue
    out.push({ name, current: head === '*' })
  }
  return out
}

/** 单提交 patch（选中看 diff 用）。空串 = 无变更（空提交/根提交的极端） */
export async function showPatch(cwd: string, sha: string): Promise<string> {
  return runGit(cwd, ['show', '--format=', '--patch', '--no-color', sha])
}

/** 提交说明正文（%b，不含 subject）。多段以换行保留；无正文返回空串。 */
export async function showCommitBody(cwd: string, sha: string): Promise<string> {
  const raw = await runGit(cwd, ['log', '-1', '--format=%b', sha])
  return raw.replace(/\n+$/, '')
}

/** 单提交变更文件（行内详情文件树） */
export async function listChangedFiles(cwd: string, sha: string): Promise<ChangedFile[]> {
  const raw = await runGit(cwd, ['show', '--format=', '--numstat', '--no-color', sha])
  return parseChangedFiles(raw)
}

/** 本地分支列表（控件条下拉） */
export async function listBranches(cwd: string): Promise<GitBranch[]> {
  const raw = await runGit(cwd, [
    'for-each-ref',
    '--format=%(refname:short)%x00%(HEAD)',
    'refs/heads',
  ])
  return parseBranches(raw)
}

// ── 工作区状态（D5 工作面板：status 文件表 / diff / 当前分支）──────────

export type WorktreeFileKind = 'm' | 'a' | 'd'

export interface WorktreeFile extends ChangedFile {
  /** porcelain 状态归并：m 修改 / a 新增（含 ?? 未跟踪与暂存新文件）/ d 删除 */
  status: WorktreeFileKind
}

/**
 * `git status --porcelain=v1 -z` 解析。条目 `XY<sp>path\0`；重命名/复制
 * 在 -z 下是 `XY<sp>new\0old\0`（字段序反转、无箭头）——跳过后一条目。
 * 状态字母取 X（index 侧）优先、Y（worktree 侧）兜底；?? → 'a'。
 */
export function parseStatusEntries(raw: string): { path: string; status: WorktreeFileKind }[] {
  const entries = raw.split('\0')
  const out: { path: string; status: WorktreeFileKind }[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.length < 4) continue
    const x = e[0]
    const y = e[1]
    const path = e.slice(3)
    if (!path) continue
    if (x === 'R' || x === 'C') i++ // 消费 old-path 条目
    const letter = x !== ' ' && x !== '?' ? x : y
    const status: WorktreeFileKind =
      letter === 'A' || letter === '?' ? 'a' : letter === 'D' ? 'd' : 'm'
    out.push({ path, status })
  }
  return out
}

export interface WorktreeStatus {
  /** repo root（diff/preview 的 cwd 基准） */
  root: string
  /** 当前分支名；detached HEAD / 空 repo → null */
  branch: string | null
  files: WorktreeFile[]
}

/**
 * 工作区快照：porcelain 状态表 + `git diff HEAD --numstat` 行数合并 +
 * 当前分支。非 repo → null。单条子命令失败（如无 HEAD 的空 repo）降级
 * 为空数据而不是整体失败。
 */
export async function listWorktreeStatus(cwd: string): Promise<WorktreeStatus | null> {
  const root = await findRepoRoot(cwd)
  if (!root) return null
  const safe = (p: Promise<string>) => p.catch(() => '')
  const [statusRaw, numstatRaw, branchRaw] = await Promise.all([
    safe(runGit(root, ['status', '--porcelain=v1', '-z'])),
    safe(runGit(root, ['diff', '--numstat', '--no-color', 'HEAD', '--'])),
    safe(runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])),
  ])
  const counts = new Map(parseChangedFiles(numstatRaw).map((f) => [f.path, f]))
  const files = parseStatusEntries(statusRaw).map(({ path, status }) => ({
    path,
    status,
    added: counts.get(path)?.added ?? null,
    deleted: counts.get(path)?.deleted ?? null,
  }))
  const branch = branchRaw.trim()
  return { root, branch: branch && branch !== 'HEAD' ? branch : null, files }
}

/** 单文件 vs HEAD 的 unified patch（工作面板内联 diff）。未跟踪文件 → 空串。 */
export async function diffWorktreeFile(root: string, path: string): Promise<string> {
  return runGit(root, ['diff', '--no-color', 'HEAD', '--', path])
}
