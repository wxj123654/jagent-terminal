/**
 * git/cli.ts — git CLI 子进程封装（docs/git-graph.md §2.1）。
 *
 * 唯一的进程边界：spawnGitLog（流式）/ findRepoRoot / showCommitBody / listChangedFiles。
 * 协议照抄 Zed `crates/git/src/repository.rs`：`--format` 用 \x00 分字段、
 * --date-order、按 chunk 回调（512 行）。stdout 走 ReadableStream + 流式
 * TextDecoder 行缓冲——禁止全量 text() 拼接（大 repo 会卡爆）。
 *
 * 本模块只依赖 Bun 全局（spawn），不 import 项目内其他模块；解析行为由
 * cli.test.ts 锁定，真进程冒烟也在测试里跑（开发机必有 git）。
 */

/** Zed 三字段 + 行内 CDV 元数据（email/committer 单行字段；body 含换行，选中时另拉） */
const LOG_FORMAT =
  '--format=%H%x00%P%x00%D%x00%h%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%s'

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

export function spawnGitLog(
  cwd: string,
  onChunk: (commits: GraphCommit[]) => void,
): GitLogHandle {
  let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn(['git', 'log', LOG_FORMAT, '--date-order'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (e) {
    // cwd 不存在 / git 不在 PATH：spawn 同步 throw（ENOENT）
    const error = e instanceof Error ? e.message : String(e)
    return { cancel: () => {}, done: Promise.resolve({ ok: false, error }) }
  }
  const lb = new LineBuffer()
  let cancelled = false
  let pending: GraphCommit[] = []

  const emit = () => {
    if (pending.length > 0 && !cancelled) {
      onChunk(pending)
      pending = []
    }
  }

  const done = (async () => {
    try {
      const reader = proc.stdout.getReader()
      for (;;) {
        const { done: closed, value } = await reader.read()
        if (closed || cancelled) break
        for (const line of lb.push(value)) {
          const c = parseLogLine(line)
          if (c) {
            pending.push(c)
            if (pending.length >= CHUNK_SIZE) emit()
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
      const code = await proc.exited
      if (cancelled) return { ok: false, error: 'cancelled' }
      if (code !== 0) {
        const err = await new Response(proc.stderr).text()
        return {
          ok: false,
          error: err.trim() || `git log exited with ${code}`,
        }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })()

  return {
    cancel() {
      if (cancelled) return
      cancelled = true
      pending = []
      try {
        proc.kill()
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
    const proc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    if (code !== 0) return null
    return out.trim() || null
  } catch {
    return null
  }
}

/** 一次性 git 子进程（非流式）。stdout 全文返回；非 0 抛 stderr。 */
export async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0)
    throw new Error(err.trim() || `git ${args[0] ?? ''} exited with ${code}`)
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
export async function showCommitBody(
  cwd: string,
  sha: string,
): Promise<string> {
  const raw = await runGit(cwd, ['log', '-1', '--format=%b', sha])
  return raw.replace(/\n+$/, '')
}

/** 单提交变更文件（行内详情文件树） */
export async function listChangedFiles(
  cwd: string,
  sha: string,
): Promise<ChangedFile[]> {
  const raw = await runGit(cwd, [
    'show',
    '--format=',
    '--numstat',
    '--no-color',
    sha,
  ])
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
