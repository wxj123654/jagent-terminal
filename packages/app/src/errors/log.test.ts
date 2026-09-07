/**
 * errors/log.test.ts — 落盘（方案 A 第 4 组件）。
 *
 * 覆盖：按天文件追加（两行两块）· detail 缩进 · install(null) 卸载后不写 ·
 * prune 清 7 天前旧档。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { emitError, onErrorEmitted, resetErrorBusForTest } from './bus'
import { installErrorLog, pruneOldLogs } from './log'

afterEach(() => {
  installErrorLog(null)
  resetErrorBusForTest()
})

async function flushWrites() {
  // appendErrorLog 是 fire-and-forget promise；bun 测试里让一个宏任务轮次过去
  await new Promise((r) => setTimeout(r, 5))
}

describe('error log', () => {
  test('emit 经钩子按天追加；detail 缩进', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jagent-errors-'))
    installErrorLog(dir)
    emitError({ level: 'error', kind: 'native', message: 'first', context: 'spawn' })
    emitError({ level: 'warn', kind: 'io', message: 'second', detail: 'line1\nline2' })
    await flushWrites()
    const names = await readdir(dir)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^errors-\d{8}\.log$/)
    const body = await readFile(join(dir, names[0]!), 'utf8')
    expect(body).toContain('[error/native] spawn: first')
    expect(body).toContain('[warn/io] second')
    expect(body).toContain('    line1')
    expect(body).toContain('    line2')
  })

  test('install(null) 卸载后 emit 不写盘', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jagent-errors-'))
    installErrorLog(dir)
    installErrorLog(null)
    emitError({ level: 'error', kind: 'io', message: 'nope' })
    await flushWrites()
    expect(await readdir(dir)).toEqual([])
  })

  test('pruneOldLogs 清 7 天前旧档，保留近期', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jagent-errors-'))
    const old = new Date(Date.now() - 9 * 86400_000)
    const stamp = (d: Date) =>
      `${d.getFullYear()}${`${d.getMonth() + 1}`.padStart(2, '0')}${`${d.getDate()}`.padStart(2, '0')}`
    await writeFile(join(dir, `errors-${stamp(old)}.log`), 'old', 'utf8')
    await writeFile(join(dir, `errors-${stamp(new Date())}.log`), 'new', 'utf8')
    await writeFile(join(dir, 'errors-notadate.log'), 'junk', 'utf8')
    await pruneOldLogs(dir)
    const names = await readdir(dir)
    expect(names).toContain(`errors-${stamp(new Date())}.log`)
    expect(names).not.toContain(`errors-${stamp(old)}.log`)
    expect(names).toContain('errors-notadate.log') // 非日期名不碰
  })

  test('onErrorEmitted 直连（不经 install）也可订阅', async () => {
    const seen: string[] = []
    const off = onErrorEmitted((e) => seen.push(e.message))
    emitError({ level: 'warn', kind: 'io', message: 'direct' })
    off()
    expect(seen).toEqual(['direct'])
  })
})
