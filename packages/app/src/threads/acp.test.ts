/**
 * threads/acp.test.ts — ACP 连接单测（真子进程：process.execPath 跑
 * __fixtures__/fake-acp-agent.ts，完整 stdio JSON-RPC 链）。零 GPU 零 PTY。
 *
 * 覆盖：echo 拼装（messageId 分段）/ 工具摘要 / 权限自动应答 / refusal 注记 /
 * crash 拒绝 / 版本不兼容 / 非 JSON 行容错 / dispose 后拒发 + 子进程终止。
 */

import { describe, expect, test } from 'bun:test'

import { join } from 'node:path'

import { createAcpConnection } from './acp'

const FIXTURE = join(import.meta.dir, '__fixtures__', 'fake-acp-agent.ts')

/** 以指定行为模式启动假 agent 连接 */
function fake(mode: string) {
  return createAcpConnection({
    command: process.execPath,
    args: [FIXTURE],
    env: { FAKE_ACP_MODE: mode },
  })
}

/** 进程存活探测（Windows/POSIX 通用：kill(pid,0) 不抛 = 存在） */
async function untilDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() - start > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 30))
  }
}

describe('createAcpConnection（真子进程 JSON-RPC）', () => {
  test('echo：文本块拼接（messageId 变化 → 分段落）', async () => {
    const c = fake('echo')
    const reply = await c.send('hi')
    expect(reply).toBe('echo: hi\n\n(fake agent)')
    c.dispose()
  })

  test('tools：tool_call 摘要行 + 状态更新', async () => {
    const c = fake('tools')
    const reply = await c.send('check')
    expect(reply).toContain('一切正常。')
    expect(reply).toContain('- tool · read · Read file src/main.ts · completed')
    c.dispose()
  })

  test('permission：自动应答 allow_once 优先', async () => {
    const c = fake('permission')
    const reply = await c.send('go')
    expect(reply).toBe('permission:allow_once')
    c.dispose()
  })

  test('refusal：停止注记 + 无输出哨兵由文本空触发', async () => {
    const c = fake('refusal')
    const reply = await c.send('x')
    expect(reply).toBe('> 停止：agent 拒绝继续')
    c.dispose()
  })

  test('crash：prompt 中进程退出 → reject 且带退出码', async () => {
    const c = fake('crash')
    // 首个 send 触发 initialize + session/new + prompt —— crash 在 prompt 时退出
    await expect(c.send('boom')).rejects.toThrow(/退出|失败/)
    c.dispose()
  })

  test('version2：initialize 版本不兼容 → reject', async () => {
    const c = fake('version2')
    await expect(c.send('x')).rejects.toThrow('协议版本不兼容')
    c.dispose()
  })

  test('badline：stdout 非 JSON 行容忍跳过', async () => {
    const c = fake('badline')
    const reply = await c.send('ok')
    expect(reply).toContain('echo: ok')
    c.dispose()
  })

  test('多轮：同连接连续 send（session 复用）', async () => {
    const c = fake('echo')
    expect(await c.send('one')).toContain('echo: one')
    expect(await c.send('two')).toContain('echo: two')
    c.dispose()
  })

  test('dispose 后 send 拒绝；子进程终止', async () => {
    const c = fake('echo')
    const pid = c.pid!
    expect(pid).toBeGreaterThan(0)
    c.dispose()
    await expect(c.send('late')).rejects.toThrow('已关闭')
    expect(await untilDead(pid)).toBe(true)
  })

  test('坏命令：spawn 失败 → send reject 带原因', async () => {
    const c = createAcpConnection({ command: 'definitely-not-a-real-cmd-xyz-123' })
    await expect(c.send('x')).rejects.toThrow(/失败|退出/)
    c.dispose()
  })
})
