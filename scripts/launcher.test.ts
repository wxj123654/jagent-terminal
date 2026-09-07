/**
 * scripts/launcher.test.ts — watchdog 的纯函数面（crash-loop 判定 /
 * 日志尾部读取）。不 spawn 真窗口。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('launcher helpers（内联复刻，避免拉 native）', () => {
  test('crash-loop：窗口内满额判定', () => {
    const WINDOW_MS = 60_000
    const MAX = 5
    const starts: number[] = []
    const tooMany = (now: number) => {
      while (starts.length && now - starts[0]! > WINDOW_MS) starts.shift()
      return starts.length >= MAX
    }
    const t0 = 1_000_000
    for (let i = 0; i < 4; i++) starts.push(t0 + i * 1000)
    expect(tooMany(t0 + 4000)).toBe(false)
    starts.push(t0 + 4000)
    expect(tooMany(t0 + 4000)).toBe(true)
    // 窗口滑出后应解除
    expect(tooMany(t0 + WINDOW_MS + 5000)).toBe(false)
  })

  test('日志尾部：读最新 errors-*.log 最后 n 行', () => {
    const dir = join(tmpdir(), `jagent-launcher-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'errors-20200101.log'), 'old\n', 'utf8')
    writeFileSync(join(dir, 'errors-20990101.log'), 'a\nb\nc\nd\n', 'utf8')
    const files = require('node:fs')
      .readdirSync(dir)
      .filter((f: string) => f.startsWith('errors-') && f.endsWith('.log'))
      .sort()
    const last = files.at(-1)!
    const lines = require('node:fs').readFileSync(join(dir, last), 'utf8').trimEnd().split('\n')
    expect(lines.slice(-2)).toEqual(['c', 'd'])
    rmSync(dir, { recursive: true, force: true })
  })
})
