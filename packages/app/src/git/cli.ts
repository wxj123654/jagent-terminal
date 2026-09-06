/**
 * git/cli.ts — git CLI 子进程封装（docs/git-graph.md §2.1）。
 *
 * 唯一的进程边界：spawnGitLog（流式）/ findRepoRoot / showPatch。
 * 协议照抄 Zed `crates/git/src/repository.rs`：`--format` 用 \x00 分字段、
 * --date-order、按 chunk 回调（512 行）。stdout 走 ReadableStream + 流式
 * TextDecoder 行缓冲——禁止全量 text() 拼接（大 repo 会卡爆）。
 *
 * 本模块只依赖 Bun 全局（spawn），不 import 项目内其他模块；解析行为由
 * cli.test.ts 锁定，真进程冒烟也在测试里跑（开发机必有 git）。
 */

/** Zed 三字段 + 一期展示字段（D3：全字段直带，~150B/行） */
const LOG_FORMAT = '--format=%H%x00%P%x00%D%x00%h%x00%an%x00%at%x00%s'

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
  /** %at 秒 */
  timestamp: number
  subject: string
}

/** 单行解析：字段数 < 7 或空 sha → null（坏行丢弃不炸） */
export function parseLogLine(line: string): GraphCommit | null {
  if (!line) return null
  const parts = line.split('\x00')
  if (parts.length < 7) return null
  const [sha, parentsStr, decor, shortSha, authorName, ts, subject] = parts
  if (!sha) return null
  return {
    sha,
    parents: parentsStr ? parentsStr.split(/\s+/).filter(Boolean) : [],
    refNames: decor ? decor.split(', ').filter(Boolean) : [],
    shortSha: shortSha ?? '',
    authorName: authorName ?? '',
    timestamp: ts ? parseInt(ts, 10) || 0 : 0,
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

export function spawnGitLog(cwd: string, onChunk: (commits: GraphCommit[]) => void): GitLogHandle {
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
        return { ok: false, error: err.trim() || `git log exited with ${code}` }
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
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) return null
    return out.trim() || null
  } catch {
    return null
  }
}

/** 单提交 patch（选中看 diff 用）。空串 = 无变更（空提交/根提交的极端） */
export async function showPatch(cwd: string, sha: string): Promise<string> {
  const proc = Bun.spawn(['git', 'show', '--format=', '--patch', '--no-color', sha], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(err.trim() || `git show exited with ${code}`)
  }
  return out
}
