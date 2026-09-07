/**
 * errors/bus.test.ts — 错误总线（方案 A #1/#2 组件）。
 *
 * 覆盖：emit 分配 id/at · ring 上限丢弃最旧 · 订阅新错误与清空信号 ·
 * errorCount 只数 error/fatal · describeUnknown 三形态 · emit 钩子异常
 * 不反噬。
 */

import { afterEach, describe, expect, test } from 'bun:test'

import {
  clearErrors,
  describeUnknown,
  emitError,
  errorCount,
  listErrors,
  onErrorEmitted,
  resetErrorBusForTest,
  subscribeErrors,
  type AppError,
} from './bus'

afterEach(() => resetErrorBusForTest())

describe('error bus', () => {
  test('emit 分配自增 id 与 at，listErrors 新→旧', () => {
    const a = emitError({ level: 'error', kind: 'io', message: 'a' })
    const b = emitError({ level: 'warn', kind: 'unknown', message: 'b' })
    expect(a.id).toBe(1)
    expect(b.id).toBe(2)
    expect(b.at).toBeGreaterThanOrEqual(a.at)
    expect(listErrors().map((e) => e.message)).toEqual(['b', 'a'])
  })

  test('ring 超限丢最旧', () => {
    for (let i = 0; i < 1005; i++) emitError({ level: 'warn', kind: 'unknown', message: `e${i}` })
    const list = listErrors()
    expect(list).toHaveLength(1000)
    // 最新在前，最旧（e5）被丢
    expect(list[0]!.message).toBe('e1004')
    expect(list.at(-1)!.message).toBe('e5')
  })

  test('订阅收到新错误；退订后不再收', () => {
    const got: AppError[] = []
    const off = subscribeErrors((e) => {
      if (e) got.push(e)
    })
    emitError({ level: 'error', kind: 'native', message: 'x' })
    off()
    emitError({ level: 'error', kind: 'native', message: 'y' })
    expect(got.map((e) => e.message)).toEqual(['x'])
  })

  test('clearErrors 发 null 信号并清缓冲', () => {
    let cleared = false
    subscribeErrors((e) => {
      if (e === null) cleared = true
    })
    emitError({ level: 'error', kind: 'io', message: 'z' })
    clearErrors()
    expect(cleared).toBe(true)
    expect(listErrors()).toEqual([])
    expect(errorCount()).toBe(0)
  })

  test('errorCount 只数 error/fatal（warn 不计）', () => {
    emitError({ level: 'warn', kind: 'io', message: 'w' })
    emitError({ level: 'error', kind: 'io', message: 'e' })
    emitError({ level: 'fatal', kind: 'panic', message: 'f' })
    expect(errorCount()).toBe(2)
  })

  test('emit 钩子抛错不反噬错误链', () => {
    onErrorEmitted(() => {
      throw new Error('hook boom')
    })
    const e = emitError({ level: 'error', kind: 'io', message: 'still lands' })
    expect(e.message).toBe('still lands')
    expect(listErrors()).toHaveLength(1)
  })

  test('describeUnknown：Error / string / 对象', () => {
    const err = new Error('boom')
    const d1 = describeUnknown(err)
    expect(d1.message).toBe('boom')
    expect(d1.detail).toContain('boom')
    expect(describeUnknown('plain').message).toBe('plain')
    expect(describeUnknown({ code: 42 }).message).toContain('42')
  })
})
