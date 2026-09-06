/**
 * AgentPlane.test.tsx — 窄窗口抽屉（W4c）：760px 断点布局 + 汉堡钮 +
 * scrim/Esc 关抽屉。TestRenderer 构造时传窗口宽（offscreen window 尺寸
 * → useWindowSize 真 read，非 fallback）。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { createGlobalKeydown } from '../keybindings'
import { memoryAdapter } from '../settings/file'
import { createSettingsStore, type SettingsStore } from '../settings/store'
import { createThreadStore, type ThreadStore, type ThreadDeps } from '../threads/store'
import { defaultWorkspace } from '../threads/workspaces'
import { App } from './AgentPlane'
import { sidebarKeyboard } from './sidebarKeyboard'

let t: TestRoot

afterEach(() => {
  t?.unmount()
})

function makeDeps(): ThreadDeps {
  // 最小桩：抽屉测试不 spawn（真 PTY 面 e2e 已锁）
  const stub = () => {
    throw new Error('抽屉测试不 spawn')
  }
  return {
    spawn: stub,
    resize: () => {},
    write: () => {},
    kill: () => {},
    presetOf: () => undefined,
    bellClear: () => {},
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
  } as never as ThreadDeps
}

function setup(width: number): { store: ThreadStore; settings: SettingsStore } {
  const settings = createSettingsStore(memoryAdapter())
  const store = createThreadStore(makeDeps(), {
    initialWorkspaces: [defaultWorkspace('/w/x')],
  })
  t = createTestRoot({ width, height: 700 })
  t.render(createElement(App, { store, settings }))
  t.renderer.flush()
  return { store, settings }
}

function click(testId: string) {
  const el = t.renderer.findByTestId(testId)
  if (!el) throw new Error(`not found: ${testId}`)
  const b = t.renderer.getElementBounds(el.id)!
  t.renderer.nativeSimulateClick(b[0] + b[2] / 2, b[1] + b[3] / 2, 0)
  t.renderer.flush()
}

function key(testId: string, k: string) {
  const el = t.renderer.findByTestId(testId)
  if (!el) throw new Error(`not found: ${testId}`)
  t.renderer.nativeSimulateKeyDown(el.id, k)
  t.renderer.flush()
}

describe('AgentPlane：窄窗口抽屉（W4）', () => {
  test('宽窗口（800px）：无汉堡钮，sidebar 常驻（session-search 在树中）', () => {
    setup(800)
    expect(t.renderer.findByTestId('drawer-toggle')).toBeUndefined()
    expect(t.renderer.findByTestId('session-search') != null).toBe(true)
    expect(t.renderer.findByTestId('drawer-scrim')).toBeUndefined()
  })

  test('窄窗口（700px）：汉堡钮在，sidebar 隐藏；点击开抽屉（scrim+panel+搜索框）再点击 scrim 关', () => {
    setup(700)
    expect(t.renderer.findByTestId('drawer-toggle') != null).toBe(true)
    expect(t.renderer.findByTestId('session-search')).toBeUndefined()
    click('drawer-toggle')
    t.renderer.flush()
    expect(t.renderer.findByTestId('drawer-panel') != null).toBe(true)
    expect(t.renderer.findByTestId('session-search') != null).toBe(true)
    click('drawer-scrim')
    t.renderer.flush()
    expect(t.renderer.findByTestId('drawer-panel')).toBeUndefined()
  })

  test('抽屉内搜索框 Esc 层级：query 空 + Esc → 关抽屉（onEscEmpty）', () => {
    setup(700)
    click('drawer-toggle')
    t.renderer.flush()
    key('session-search', 'escape')
    t.renderer.flush()
    expect(t.renderer.findByTestId('drawer-panel')).toBeUndefined()
  })
})

describe('AgentPlane：⌘K/Ctrl-K 聚焦搜索 → 打字 → Esc（无 terminal 场景闭环）', () => {
  test('cmd-k 路由 → 焦点进搜索框 → 键入进 query → Esc 清空', async () => {
    // 独立 root：onKeyDown 接 createGlobalKeydown（与 main.tsx/e2e 同构）
    const settings = createSettingsStore(memoryAdapter())
    const store = createThreadStore(makeDeps(), {
      initialWorkspaces: [defaultWorkspace('/w/alpha')],
    })
    t = createTestRoot({
      width: 900,
      height: 700,
      onKeyDown: (e) => {
        handleKeydown(
          e.key ?? '',
          e.modifiers?.ctrl ?? false,
          e.modifiers?.shift ?? false,
          e.modifiers?.cmd ?? false,
        )
      },
    })
    handleKeydown = createGlobalKeydown({
      store,
      inSettings: () => false,
      closeSettings: () => {},
      focusSearch: () => {},
      focusThreadSearch: () => {
        const id = sidebarKeyboard.searchInputId()
        if (id != null) t.renderer.focusElement(id)
      },
      inputFocused: () => false,
      settingsQuery: () => '',
      escConsumed: () => false,
      clearEscConsumed: () => {},
      keys: () => settings.get().keybindings,
    })
    t.render(createElement(App, { store, settings }))
    t.renderer.flush()
    await until2(() => sidebarKeyboard.searchInputId() != null)

    // 平台默认键位（darwin cmd-k / 其他 ctrl-k）
    t.renderer.simulateKeystrokes(process.platform === 'darwin' ? 'cmd-k' : 'ctrl-k')
    t.renderer.flush()
    // 焦点在搜索框：后续键击进 query
    t.renderer.simulateKeystrokes('al')
    await until2(() => sidebarKeyboard.query() === 'al')
    // Esc 清空（宽窗口 onEscEmpty 未注入 → no-op）
    t.renderer.simulateKeystrokes('escape')
    await until2(() => sidebarKeyboard.query() === '')
  })
})

let handleKeydown: ReturnType<typeof createGlobalKeydown> = () => {}
async function until2(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}
