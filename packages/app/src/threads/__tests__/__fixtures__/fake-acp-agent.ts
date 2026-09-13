/**
 * fake-acp-agent.ts — 测试用 ACP v1 假 agent（bun 脚本子进程）。
 *
 * 行为由 FAKE_ACP_MODE 环境变量选择（默认 echo）：
 * - echo       ：两个 agent_message_chunk（换行分段）→ end_turn
 * - tools      ：tool_call + tool_call_update + 一个文本块 → end_turn
 * - permission ：发 session/request_permission（allow_once/reject_once 二选）
 *                → 按应答 optionId 出一条文本块 → end_turn
 * - refusal    ：无块，直接 stopReason=refusal
 * - crash      ：首个 prompt 时 process.exit(3)
 * - badline    ：响应前写一行非 JSON 到 stdout（客户端容错）
 * - version2   ：initialize 返回 protocolVersion 2（版本不兼容路径）
 *
 * 跑法：被 acp.test.ts / e2e 经 createAcpConnection({command: process.execPath,
 * args: [本文件]}) 真 spawn——走完整 stdio JSON-RPC 链。
 */

const mode = process.env.FAKE_ACP_MODE ?? 'echo'

const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`)
const respond = (id: number, result: unknown) => send({ jsonrpc: '2.0', id, result })
const notify = (method: string, params: unknown) => send({ jsonrpc: '2.0', method, params })

/** 待应答的 agent → client 请求（权限请求用） */
let pendingPermission: { id: number; onDone: (r: { result?: unknown }) => void } | null = null

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d: string) => {
  buf += d
  let nl: number
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line) handle(JSON.parse(line))
  }
})
// 客户端关 stdin（dispose kill 前的优雅路径）→ 退出
process.stdin.on('end', () => process.exit(0))

function handle(msg: any): void {
  if (typeof msg.method === 'string' && typeof msg.id === 'number') {
    // client → agent 请求
    switch (msg.method) {
      case 'initialize':
        respond(
          msg.id,
          mode === 'version2'
            ? { protocolVersion: 2, agentCapabilities: {}, authMethods: [] }
            : { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
        )
        return
      case 'session/new':
        respond(msg.id, { sessionId: 'fake-1' })
        return
      case 'session/prompt':
        onPrompt(msg)
        return
      default:
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: msg.method } })
    }
  } else if (typeof msg.method === 'string') {
    return // client 通知（session/cancel 等）——假 agent 忽略
  } else if (pendingPermission && msg.id === pendingPermission.id) {
    // client 对权限请求的响应
    const p = pendingPermission
    pendingPermission = null
    p.onDone(msg)
  }
}

function onPrompt(msg: any): void {
  const text: string = msg.params?.prompt?.[0]?.text ?? ''
  if (mode === 'crash') process.exit(3)
  if (mode === 'refusal') {
    respond(msg.id, { stopReason: 'refusal' })
    return
  }
  if (mode === 'badline') process.stdout.write('this line is not json\n')

  const finish = (stopReason = 'end_turn') => respond(msg.id, { stopReason })

  if (mode === 'tools') {
    notify('session/update', {
      sessionId: 'fake-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc1',
        title: 'Read file src/main.ts',
        kind: 'read',
        status: 'pending',
      },
    })
    notify('session/update', {
      sessionId: 'fake-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'in_progress',
      },
    })
    notify('session/update', {
      sessionId: 'fake-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: '看完了，' },
      },
    })
    notify('session/update', {
      sessionId: 'fake-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: '一切正常。' },
      },
    })
    notify('session/update', {
      sessionId: 'fake-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
      },
    })
    finish()
    return
  }

  if (mode === 'permission') {
    const reqId = 9001
    pendingPermission = {
      id: reqId,
      onDone: (r) => {
        const optionId = (r.result as { optionId?: string })?.optionId ?? 'none'
        notify('session/update', {
          sessionId: 'fake-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            content: { type: 'text', text: `permission:${optionId}` },
          },
        })
        finish()
      },
    }
    send({
      jsonrpc: '2.0',
      id: reqId,
      method: 'session/request_permission',
      params: {
        sessionId: 'fake-1',
        toolCall: { toolCallId: 'tc1', title: 'Run npm test', kind: 'execute', status: 'pending' },
        options: [
          { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
        ],
      },
    })
    return
  }

  // echo（默认）：两个 chunk，messageId 不同 → 客户端分段落
  notify('session/update', {
    sessionId: 'fake-1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm1',
      content: { type: 'text', text: `echo: ${text}` },
    },
  })
  notify('session/update', {
    sessionId: 'fake-1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'm2',
      content: { type: 'text', text: '(fake agent)' },
    },
  })
  finish()
}
