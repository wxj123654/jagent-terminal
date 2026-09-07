/**
 * errors/guards.test.ts + native.test.ts — 全局守卫与 native 收口
 * （方案 A 第 2/5 组件；纯逻辑，无需 TestRenderer）。
 */

import { afterEach, describe, expect, test } from 'bun:test'

import { listErrors, resetErrorBusForTest } from './bus'
import { installGlobalGuards, resetGuardsForTest } from './guards'
import { reportNativeError, trackNative, trackVoid } from './native'

afterEach(() => {
  resetErrorBusForTest()
  resetGuardsForTest()
})

describe('global guards', () => {
  // 不用真 void Promise.reject(...)：bun test runner 自己监听
  // unhandledRejection 并标记测试失败（与 app 进程语义不同）。改为直接
  //调我们注册的 handler——测的是「handler 正确 emit」，bun 的派发链
  // 由真窗口冒烟覆盖。
  function fireUnhandledRejection(reason: unknown) {
    const handlers = process.listeners('unhandledRejection') as ((
      reason: unknown,
      promise: Promise<unknown>,
    ) => void)[]
    expect(handlers.length).toBeGreaterThan(0)
    for (const h of handlers) h(reason, Promise.resolve())
  }

  test('unhandledRejection handler → 总线 emit', () => {
    installGlobalGuards()
    fireUnhandledRejection(new Error('ghost rejection'))
    const hit = listErrors().find((e) => e.context === 'unhandledRejection')
    expect(hit).toBeTruthy()
    expect(hit!.message).toContain('ghost rejection')
    expect(hit!.kind).toBe('unknown')
  })

  test('非 Error rejection 也可描述', () => {
    installGlobalGuards()
    fireUnhandledRejection('plain string')
    const hit = listErrors().find((e) => e.context === 'unhandledRejection')
    expect(hit).toBeTruthy()
    expect(hit!.message).toContain('plain string')
  })

  test('uncaughtException handler → 总线 emit', () => {
    installGlobalGuards()
    const handlers = process.listeners('uncaughtException') as ((e: Error) => void)[]
    expect(handlers.length).toBeGreaterThan(0)
    for (const h of handlers) h(new Error('synthetic uncaught'))
    const hit = listErrors().find((e) => e.context === 'uncaughtException')
    expect(hit).toBeTruthy()
    expect(hit!.message).toContain('synthetic uncaught')
  })

  test('installGlobalGuards 幂等（重复调用不重复 emit）', () => {
    installGlobalGuards()
    installGlobalGuards()
    fireUnhandledRejection(new Error('once'))
    expect(listErrors().filter((e) => e.context === 'unhandledRejection')).toHaveLength(1)
  })
})

describe('native 收口', () => {
  test('trackNative：reject → emit(kind native) 后原样 rethrow', async () => {
    const boom = new Error('spawn failed')
    await expect(
      trackNative('createTerminalSession', async () => {
        throw boom
      }),
    ).rejects.toBe(boom)
    const hit = listErrors().find((e) => e.context === 'createTerminalSession')
    expect(hit).toBeTruthy()
    expect(hit!.kind).toBe('native')
    expect(hit!.level).toBe('error')
  })

  test('trackNative：同步 throw（napi 同步命令）同样捕获', async () => {
    await expect(
      trackNative('destroyTerminalSession', async () => {
        throw new Error('no terminal session 9')
      }),
    ).rejects.toThrow('no terminal session 9')
    expect(listErrors().find((e) => e.context === 'destroyTerminalSession')).toBeTruthy()
  })

  test('trackNative：成功路径零 emit', async () => {
    const out = await trackNative('ok', async () => 42)
    expect(out).toBe(42)
    expect(listErrors()).toEqual([])
  })

  test('trackVoid：吞 reject 并 emit 指定 level', async () => {
    trackVoid(
      'bg-task',
      async () => {
        throw new Error('bg boom')
      },
      'warn',
    )
    await new Promise((r) => setTimeout(r, 5))
    const hit = listErrors().find((e) => e.context === 'bg-task')
    expect(hit!.level).toBe('warn')
  })

  test('reportNativeError：直接 emit', () => {
    reportNativeError('raw-call', new Error('raw'))
    expect(listErrors().find((e) => e.context === 'raw-call')).toBeTruthy()
  })
})
