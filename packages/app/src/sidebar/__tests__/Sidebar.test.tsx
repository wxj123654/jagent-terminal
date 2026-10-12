/**
 * sidebar/Sidebar.test.tsx — 通知中心（D8）交互测试。
 *
 * 真 createThreadStore（fake deps）+ TestGpuixRenderer。覆盖：
 * 铃铛未读红点（read 字段计数）· 条目点击 → openNotice（标已读 +
 * 跳来源会话）· 「全部已读」清红点留条目。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import type { DialogOpener } from '../../dialogs/DialogHost'
import {
  currentActiveThreadId,
  currentActiveWorkspaceId,
  navigateTarget,
  router,
} from '../../router'
import { memoryAdapter } from '../../settings/file'
import { createSettingsStore, type SettingsStore } from '../../settings/store'
import { builtinPresetOf } from '../../threads/presets'
import { createThreadStore, type ThreadStore } from '../../threads/store'
import { Sidebar } from '../Sidebar'

let t: TestRoot
let store: ThreadStore
let settings: SettingsStore
// 每用例换 store 实例 → key 强制重挂载（useSyncExternalStore 的 subscribe
// 是稳定箭头函数，同类型重渲染不重订阅，会读到旧 store 的监听）
let mountKey = 0

const dialog: DialogOpener = {
  openToolMenu: () => {},
  openAddWorkspace: () => {},
  openSearch: () => {},
  openRename: () => {},
  openErrors: () => {},
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function clickCenter(testId: string) {
  const el = t.renderer.findByTestId(testId)
  if (!el) throw new Error(`element not found: ${testId}`)
  const b = t.renderer.getElementBounds(el.id)!
  t.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2, 0)
  t.renderer.flush()
}

beforeAll(() => {
  t = createTestRoot({ width: 900, height: 700 })
})

afterAll(() => {
  t?.unmount()
})

beforeEach(() => {
  void router.navigate({ to: '/' })
  settings = createSettingsStore(memoryAdapter())
  let nextSession = 1
  store = createThreadStore({
    spawnSession: async () => nextSession++,
    destroySession: async () => {},
    navigate: navigateTarget,
    notify: () => {},
    closeOnExit: () => false,
    presetOf: (id) => builtinPresetOf(id),
    activeThreadId: currentActiveThreadId,
    activeWorkspaceId: currentActiveWorkspaceId,
    chatAgent: { send: async () => '' },
    createAcpAgent: () => {
      throw new Error('nope')
    },
  })
  t.render(
    createElement(Sidebar, {
      key: `sb${++mountKey}`,
      store,
      settings,
      dialog,
      platform: 'win',
    }),
  )
  t.renderer.flush()
})

describe('通知中心（D8）', () => {
  test('bell → 红点出现；点条目 → 已读 + 跳来源会话', async () => {
    await store.spawnFromPreset('shell') // t1
    await store.spawnFromPreset('shell') // t2 active
    store.onSessionEvent({ type: 'bell', sessionId: 1 })
    // useSyncExternalStore 的 store→React 更新在测试渲染器里异步调度，
    // 需要一次真微任务 tick（WorkspaceList 的 until() 同款）
    await flush()
    t.renderer.flush()

    expect(t.renderer.findByTestId('notif-unread-dot')).toBeDefined()

    clickCenter('open-notifications')
    const notice = store.getState().notices[0]!
    const item = t.renderer.findByTestId(`notif-item-${notice.id}`)
    expect(item).toBeDefined()

    clickCenter(`notif-item-${notice.id}`)
    expect(store.getState().notices[0]!.read).toBe(true)
    expect(currentActiveThreadId()).toBe('t1')
    // 全部已读 → 红点消失
    await flush()
    t.renderer.flush()
    expect(t.renderer.findByTestId('notif-unread-dot')).toBeUndefined()
  })

  test('通知浮层贴铃铛上缘（原型 side=top align=start）：浮层底在铃铛顶之上、左缘对齐', async () => {
    await store.spawnFromPreset('shell')
    await store.spawnFromPreset('shell')
    store.onSessionEvent({ type: 'bell', sessionId: 1 })
    await flush()
    t.renderer.flush()

    clickCenter('open-notifications')
    const bellEl = t.renderer.findByTestId('open-notifications')!
    const bell = t.renderer.getElementBounds(bellEl.id)!
    const pop = t.renderer.getElementBounds(t.renderer.findByTestId('notif-popover')!.id)!
    // 浮层在铃铛上方：浮层底边 ≤ 铃铛顶边（允许 gap 10 之内的误差由 ≤ 即可）
    // 非退化：两个盒子都有真实尺寸与位置（防 0/0 恰好满足不等式）
    expect(bell.width).toBeGreaterThan(0)
    expect(pop.height).toBeGreaterThan(0)
    expect(bell.y).toBeGreaterThan(pop.y)
    expect(pop.y + pop.height).toBeLessThanOrEqual(bell.y)
    // 左缘贴铃铛左缘（铃铛钮 hitSize 28，视觉左缘 = 钮左缘）
    expect(Math.abs(pop.x - bell.x)).toBeLessThanOrEqual(6)
  })

  test('「全部已读」清红点、条目保留', async () => {
    await store.spawnFromPreset('shell')
    await store.spawnFromPreset('shell')
    store.onSessionEvent({ type: 'bell', sessionId: 1 })
    store.onSessionEvent({ type: 'exit', sessionId: 1, code: 0 })
    await flush()
    t.renderer.flush()

    clickCenter('open-notifications')
    clickCenter('notif-clear-all')
    expect(store.getState().notices.every((n) => n.read)).toBe(true)
    expect(store.getState().notices).toHaveLength(2)
    await flush()
    t.renderer.flush()
    expect(t.renderer.findByTestId('notif-unread-dot')).toBeUndefined()
  })
})
