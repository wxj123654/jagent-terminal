/**
 * threads/acp.ts — ACP v1（Agent Client Protocol）JSON-RPC 子进程客户端。
 *
 * 协议（agentclientprotocol.com/protocol/v1，2026-09 调研）：
 * - 传输 = stdio，UTF-8，行分隔 JSON（每行一个 JSON-RPC 2.0 消息，禁内嵌换行）
 * - 握手 = initialize（protocolVersion:1 + clientCapabilities）→ session/new
 *   （cwd 绝对路径 + mcpServers）→ sessionId
 * - 对话 = session/prompt（prompt: ContentBlock[]）→ 期间 session/update 通知
 *   流式汇报（agent_message_chunk / tool_call / tool_call_update / …）→
 *   响应 {stopReason: end_turn|max_tokens|max_turn_requests|refusal|cancelled}
 * - agent → client 请求：session/request_permission（options: allow_once/
 *   allow_always/reject_once/reject_always）；fs/*、terminal/* 仅在 client
 *   声明对应 capability 后才会来——我们全部不声明（{}），故不会收到。
 *
 * 实现边界（T3+.1 最小可用，自研零依赖——与 notify.rs/Rust toast 同款纪律）：
 * - 实现 ChatAgent seam：send(text) = 惰性握手 + prompt，resolve 拼装文本
 *  （messageId 变化分段落；tool_call 汇总为 bullet 行；非 end_turn 附停止注记）
 * - 权限请求自动应答：allow_once > allow_always > 首项（无 UI；后续接
 *  AcpSurface 权限面时替换）
 * - 流式：ChatAgent 当前形态整轮返回（chunks 在连接内拼装，不增量上报 UI）
 * - Windows：npm 全局 CLI 是 .cmd shim，node spawn 不带 shell 无法解析——
 *  win32 走 shell:true + 自拼引号；args 含 %/引号的极端转义是已知限制
 * - 进程退出：reject 全部在途请求（附 stderr 尾部，spawn 失败可见原因）；
 *  dispose() kill 子进程（close acp thread 时由 store 调）
 *
 * 测试面：__fixtures__/fake-acp-agent.ts（bun 脚本假 agent，FAKE_ACP_MODE
 * 选行为）——acp.test.ts 经 process.execPath 真 spawn 走完整 JSON-RPC 链。
 */

import { spawn, type ChildProcess } from 'node:child_process'

import type { ChatAgent } from './chat'

// ── 选项与类型 ───────────────────────────────────────────────────────

export type AcpConnectionOptions = {
  command: string
  args?: string[]
  /** 会话工作目录（session/new 的 cwd；默认 process.cwd()） */
  cwd?: string
  /** 追加环境变量（合并继承 process.env；测试注入 FAKE_ACP_MODE） */
  env?: Record<string, string>
  clientInfo?: { name: string; version: string }
}

export type AcpConnection = ChatAgent & {
  dispose(): void
  /** 子进程 pid（诊断/测试断言进程存活） */
  readonly pid: number | undefined
}

/** JSON-RPC 2.0 面（仅本文件需要的部分） */
type RpcResponse = {
  jsonrpc: '2.0'
  id?: number
  result?: unknown
  error?: { code: number; message: string }
}
type RpcIncoming = RpcResponse & { method?: string; params?: unknown }

type PendingEntry = { resolve: (v: any) => void; reject: (e: Error) => void }

/** 一次 prompt turn 的收集器（session/update → 拼装 → prompt 响应后定稿） */
type TurnCollector = {
  textParts: string[]
  currentMsgId: string | undefined
  /** toolCallId → 摘要行（按出现序） */
  tools: Map<string, { kind?: string; title?: string; status?: string }>
  toolOrder: string[]
}

/** 停止原因 → 注记（end_turn 无注记） */
const STOP_NOTE: Record<string, string> = {
  max_tokens: '达到 token 上限',
  max_turn_requests: '达到单轮请求上限',
  refusal: 'agent 拒绝继续',
  cancelled: '已取消',
}

// ── 实现 ─────────────────────────────────────────────────────────────

export function createAcpConnection(opts: AcpConnectionOptions): AcpConnection {
  const cwd = opts.cwd ?? process.cwd()
  const isWin = process.platform === 'win32'

  // Windows：cmd.exe 需要 shell:true；node 的 shell join 不带引号，自行拼接
  const cmdline = isWin
    ? [opts.command, ...(opts.args ?? [])].map(quoteForCmd).join(' ')
    : opts.command
  const child: ChildProcess = spawn(cmdline, isWin ? [] : (opts.args ?? []), {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    ...(isWin ? { shell: true } : {}),
  })

  let nextId = 1
  const pending = new Map<number, PendingEntry>()
  let disposed = false
  let ready: Promise<void> | null = null
  let sessionId: string | null = null
  let activeTurn: TurnCollector | null = null
  /** stderr 尾部（环形截断；进程异常退出时附给错误消息） */
  let stderrTail = ''

  // ── 底层 IO ──

  const onExit = (code: number | null) => {
    const detail = stderrTail ? `\n${stderrTail}` : ''
    for (const [, p] of pending) p.reject(new Error(`ACP 进程退出（code ${code}）${detail}`))
    pending.clear()
  }

  child.on('exit', (code) => {
    if (!disposed) onExit(code)
  })
  child.on('error', (err) => {
    // spawn 失败（ENOENT 等）与运行中管道错误都走这里
    const e = new Error(`ACP 子进程失败：${err.message}${stderrTail ? `\n${stderrTail}` : ''}`)
    for (const [, p] of pending) p.reject(e)
    pending.clear()
  })
  // EPIPE 等 stdin 写错误：吞掉（死进程上的 write 由 pending reject 报告）
  child.stdin?.on?.('error', () => {})
  if (child.stderr) {
    let buf = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => {
      buf = (buf + d).slice(-4000)
      stderrTail = buf
    })
  }

  let outBuf = ''
  if (child.stdout) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      outBuf += d
      let nl: number
      while ((nl = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, nl).trim()
        outBuf = outBuf.slice(nl + 1)
        if (line) handleLine(line)
      }
    })
  }

  function post(msg: Record<string, unknown>) {
    child.stdin?.write(`${JSON.stringify(msg)}\n`)
  }

  function request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(new Error('ACP 连接已关闭'))
        return
      }
      const id = nextId++
      pending.set(id, { resolve, reject })
      try {
        post({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  function respond(id: number, result: unknown) {
    post({ jsonrpc: '2.0', id, result })
  }
  function respondError(id: number, code: number, message: string) {
    post({ jsonrpc: '2.0', id, error: { code, message } })
  }

  // ── 入站分发 ──

  function handleLine(line: string) {
    let msg: RpcIncoming
    try {
      msg = JSON.parse(line)
    } catch {
      return // 非 JSON 行容忍跳过（规范禁止，但容错无害）
    }
    if (typeof msg.method === 'string') {
      if (typeof msg.id === 'number') handleAgentRequest(msg.id, msg.method, msg.params)
      else handleNotification(msg.method, msg.params)
    } else if (typeof msg.id === 'number') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`ACP 错误 ${msg.error.code}：${msg.error.message}`))
      else p.resolve(msg.result)
    }
  }

  /** agent → client 请求（目前仅权限；未声明 fs/terminal 能力故不会来） */
  function handleAgentRequest(id: number, method: string, params: any) {
    if (method === 'session/request_permission') {
      const options: { optionId: string; kind?: string }[] = params?.options ?? []
      const pick =
        options.find((o) => o.kind === 'allow_once') ??
        options.find((o) => o.kind === 'allow_always') ??
        options[0]
      respond(
        id,
        pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' },
      )
      return
    }
    respondError(id, -32601, `j-agent 未实现该方法：${method}`)
  }

  function handleNotification(method: string, params: any) {
    if (method !== 'session/update' || !activeTurn) return
    const u = params?.update
    if (!u || typeof u.sessionUpdate !== 'string') return
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const c = u.content
        if (c?.type !== 'text' || typeof c.text !== 'string') return
        const mid = typeof u.messageId === 'string' ? u.messageId : undefined
        if (mid != null && activeTurn.currentMsgId != null && mid !== activeTurn.currentMsgId) {
          activeTurn.textParts.push('\n\n') // 新消息 → 新段落
        }
        if (mid != null) activeTurn.currentMsgId = mid
        activeTurn.textParts.push(c.text)
        return
      }
      case 'tool_call': {
        const id = String(u.toolCallId ?? '')
        if (!id || activeTurn.tools.has(id)) return
        activeTurn.tools.set(id, { kind: u.kind, title: u.title, status: u.status })
        activeTurn.toolOrder.push(id)
        return
      }
      case 'tool_call_update': {
        const row = activeTurn.tools.get(String(u.toolCallId ?? ''))
        if (!row) return
        if (u.kind != null) row.kind = u.kind
        if (u.title != null) row.title = u.title
        if (u.status != null) row.status = u.status
        return
      }
      default:
        return // user_message_chunk（本地已落列）/ thought / plan / usage 等忽略
    }
  }

  // ── 握手与 turn ──

  function ensureReady(): Promise<void> {
    if (!ready) {
      ready = (async () => {
        const init = await request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: opts.clientInfo ?? { name: 'j-agent', version: '0.1.0' },
        })
        if (init?.protocolVersion !== 1) {
          throw new Error(`ACP 协议版本不兼容（agent 返回 ${init?.protocolVersion}）`)
        }
        const s = await request('session/new', { cwd, mcpServers: [] })
        if (typeof s?.sessionId !== 'string') throw new Error('session/new 未返回 sessionId')
        sessionId = s.sessionId
      })().catch((err: unknown) => {
        ready = null // 失败允许重试（进程若已死会立刻再失败并带原因）
        throw err
      })
    }
    return ready
  }

  function assembleReply(turn: TurnCollector, stopReason: string): string {
    const parts: string[] = []
    const text = turn.textParts.join('').trim()
    if (text) parts.push(text)
    const toolLines = turn.toolOrder.map((id) => {
      const t = turn.tools.get(id)!
      const bits = ['tool', t.kind, t.title, t.status].filter((x) => x != null && x !== '')
      return `- ${bits.join(' · ')}`
    })
    if (toolLines.length > 0) parts.push(toolLines.join('\n'))
    const note = STOP_NOTE[stopReason]
    if (note) parts.push(`> 停止：${note}`)
    return parts.join('\n\n') || '（turn 结束，无输出）'
  }

  return {
    async send(text) {
      await ensureReady()
      const turn: TurnCollector = {
        textParts: [],
        currentMsgId: undefined,
        tools: new Map(),
        toolOrder: [],
      }
      activeTurn = turn
      try {
        const res = await request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text }],
        })
        return assembleReply(turn, String(res?.stopReason ?? 'end_turn'))
      } finally {
        activeTurn = null
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      const e = new Error('ACP 连接已关闭')
      for (const [, p] of pending) p.reject(e)
      pending.clear()
      try {
        child.kill()
      } catch {
        // 已退出：忽略
      }
    },

    get pid() {
      return child.pid
    },
  }
}

/** cmd.exe 引号：仅含空白/特殊字符时包双引号（首版转义边界，见文件头注记） */
function quoteForCmd(s: string): string {
  return /[\s&<>()@^|"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
