/**
 * threads/store 测试（architecture.md §3.4：bun test，零 GPU 零 PTY）。
 *
 * fake deps 注入 + 真 router 实例（memory history；navigate 走 navigateTarget
 * 薄包装，active 判定走 currentActiveThreadId——与装配层同一体）。
 * Phase 1 覆盖最小子集；T2.1 补全用例（displayTitle 已在此覆盖）。
 */

import { beforeEach, describe, expect, test } from 'bun:test'

import {
  activeTargetFromLocation,
  currentActiveThreadId,
  navigateTarget,
  router,
} from '../router'
import { builtinPresetOf } from './presets'
import { createThreadStore, type ThreadDeps, type ThreadStore } from './store'
import { displayTitle } from './terminal'

function makeDeps(overrides: Partial<ThreadDeps> = {}) {
  let nextSession = 1
  const destroyed: number[] = []
  const notified: string[] = []
  let closeOnExit = false
  const deps: ThreadDeps = {
    spawnSession: async () => nextSession++,
    destroySession: async (id) => {
      destroyed.push(id)
    },
    navigate: navigateTarget,
    notify: (t) => notified.push(t.id),
    closeOnExit: () => closeOnExit,
    presetOf: (id) => builtinPresetOf(id),
    activeThreadId: currentActiveThreadId,
    ...overrides,
  }
  return {
    deps,
    destroyed,
    notified,
    setCloseOnExit: (v: boolean) => (closeOnExit = v),
  }
}

/** 等 router 的 async load 链走完（pathname 是同步的，保险起见 flush 微任务）。 */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('router 纯函数（顺带）', () => {
  test('activeTargetFromLocation 三分支', () => {
    expect(activeTargetFromLocation('/')).toBeNull()
    expect(activeTargetFromLocation('/thread/t3')).toEqual({ type: 'thread', id: 't3' })
    expect(activeTargetFromLocation('/settings')).toEqual({ type: 'settings' })
  })
})

describe('spawnFromPreset', () => {
  let store: ThreadStore
  beforeEach(() => {
    void router.navigate({ to: '/' })
    store = createThreadStore(makeDeps().deps)
  })

  test('push + lastUsedPreset + navigate 到新 thread', async () => {
    await store.spawnFromPreset('claude')
    const s = store.getState()
    expect(s.threads).toHaveLength(1)
    expect(s.threads[0]).toMatchObject({ kind: 'terminal', id: 't1', preset: 'claude' })
    expect(s.lastUsedPreset).toBe('claude')
    expect(currentActiveThreadId()).toBe('t1')
  })

  test('未知 preset 抛错且状态不变', async () => {
    await expect(store.spawnFromPreset('nope')).rejects.toThrow('unknown preset')
    expect(store.getState().threads).toHaveLength(0)
  })
})

describe('activate / bell 规则', () => {
  test('bell 非激活 → 红点 + notify；activate 清除且不再 notify', async () => {
    const ctx = makeDeps()
    const store = createThreadStore(ctx.deps)
    await store.spawnFromPreset('shell') // t1，激活
    await store.spawnFromPreset('shell') // t2，激活（t1 转后台）
    await store.activate({ type: 'thread', id: 't1' })

    store.onSessionEvent({ type: 'bell', sessionId: 2 })
    let row = store.getState().threads.find((t) => t.id === 't2')
    expect(row?.kind === 'terminal' && row.hasBell).toBe(true)
    expect(ctx.notified).toEqual(['t2'])

    // 激活 t2 → 清红点
    store.activate({ type: 'thread', id: 't2' })
    row = store.getState().threads.find((t) => t.id === 't2')
    expect(row?.kind === 'terminal' && row.hasBell).toBe(false)

    // active 时 bell 不落红点也不通知
    store.onSessionEvent({ type: 'bell', sessionId: 2 })
    row = store.getState().threads.find((t) => t.id === 't2')
    expect(row?.kind === 'terminal' && row.hasBell).toBe(false)
    expect(ctx.notified).toEqual(['t2'])
  })

  test('activate(settings) / null：threads 不动，路由切换', async () => {
    const store = createThreadStore(makeDeps().deps)
    await store.spawnFromPreset('shell')
    const before = store.getState().threads

    store.activate({ type: 'settings' })
    expect(router.history.location.pathname).toBe('/settings')
    expect(store.getState().threads).toBe(before)

    store.activate(null)
    expect(router.history.location.pathname).toBe('/')
    expect(store.getState().threads).toBe(before)
  })
})

describe('title / exit / closeOnExit', () => {
  test('oscTitle 更新；customTitle 冻结不被覆盖', async () => {
    const store = createThreadStore(makeDeps().deps)
    await store.spawnFromPreset('shell')
    store.onSessionEvent({ type: 'title', sessionId: 1, title: 'vim' })
    let row = store.getState().threads[0]
    expect(row.kind === 'terminal' && row.oscTitle).toBe('vim')

    store.rename('t1', '我的会话')
    store.onSessionEvent({ type: 'title', sessionId: 1, title: 'osc-after-rename' })
    row = store.getState().threads[0]
    expect(row.kind === 'terminal' && row.customTitle).toBe('我的会话')
    expect(row.kind === 'terminal' && row.oscTitle).toBe('vim') // 未被覆盖
  })

  test('rename 空串忽略', async () => {
    const store = createThreadStore(makeDeps().deps)
    await store.spawnFromPreset('shell')
    store.rename('t1', '   ')
    const row = store.getState().threads[0]
    expect(row.kind === 'terminal' && row.customTitle).toBeUndefined()
  })

  test('exit + closeOnExit=false → 灰行保留（不变量 3）', async () => {
    const store = createThreadStore(makeDeps().deps)
    await store.spawnFromPreset('shell')
    store.onSessionEvent({ type: 'exit', sessionId: 1 })
    const row = store.getState().threads[0]
    expect(row.kind === 'terminal' && row.status).toBe('exited')
    expect(store.getState().threads).toHaveLength(1)
  })

  test('exit + closeOnExit=true → 移除（走 close）', async () => {
    const ctx = makeDeps()
    ctx.setCloseOnExit(true)
    const store = createThreadStore(ctx.deps)
    await store.spawnFromPreset('shell')
    store.onSessionEvent({ type: 'exit', sessionId: 1 })
    expect(store.getState().threads).toHaveLength(0)
    expect(ctx.destroyed).toEqual([1])
    expect(router.history.location.pathname).toBe('/') // 先导航离开
  })
})

describe('close', () => {
  test('close 当前的 thread：先导航离开再移除 + destroySession', async () => {
    const ctx = makeDeps()
    const store = createThreadStore(ctx.deps)
    await store.spawnFromPreset('shell') // t1 active
    store.close('t1')
    expect(store.getState().threads).toHaveLength(0)
    expect(ctx.destroyed).toEqual([1])
    expect(router.history.location.pathname).toBe('/')
  })

  test('close 后台的 thread：不导航，仅移除', async () => {
    const ctx = makeDeps()
    const store = createThreadStore(ctx.deps)
    await store.spawnFromPreset('shell') // t1
    await store.spawnFromPreset('shell') // t2 active
    store.close('t1')
    expect(store.getState().threads.map((t) => t.id)).toEqual(['t2'])
    expect(ctx.destroyed).toEqual([1])
    expect(router.history.location.pathname).toBe('/thread/t2')
  })
})

describe('cycle 环形', () => {
  test('dir=1 到尾回卷；dir=-1 到头回卷', async () => {
    const store = createThreadStore(makeDeps().deps)
    await store.spawnFromPreset('shell') // t1
    await store.spawnFromPreset('shell') // t2
    await store.spawnFromPreset('shell') // t3 active

    store.cycle(1) // t3 → t1（回卷）
    await flush()
    expect(currentActiveThreadId()).toBe('t1')
    store.cycle(-1) // t1 → t3（回卷）
    await flush()
    expect(currentActiveThreadId()).toBe('t3')
    store.cycle(1) // t3 → t1
    await flush()
    expect(currentActiveThreadId()).toBe('t1')
  })
})

describe('displayTitle 四级兜底（契约 §4）', () => {
  test('customTitle ?? oscTitle ?? initCommand ?? "Terminal"', () => {
    expect(displayTitle({ customTitle: 'c', oscTitle: 'o', initCommand: 'i' })).toBe('c')
    expect(displayTitle({ oscTitle: 'o', initCommand: 'i' })).toBe('o')
    expect(displayTitle({ initCommand: 'i' })).toBe('i')
    expect(displayTitle({})).toBe('Terminal')
  })
})
