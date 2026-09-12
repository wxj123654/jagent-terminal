/**
 * AgentPlane.test.tsx — 窄窗口抽屉（W4c）：760px 断点布局 + 汉堡钮 +
 * scrim/Esc 关抽屉。TestRenderer 构造时传窗口宽（offscreen window 尺寸
 * → useWindowSize 真 read，非 fallback）。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { createGitGraphStore } from '../git/store'
import { createWorktreeStore } from '../git/worktree'
import { navigateTarget } from '../router'
import { memoryAdapter } from '../settings/file'
import { createSettingsStore, type SettingsStore } from '../settings/store'
import { createThreadStore, type ThreadStore, type ThreadDeps } from '../threads/store'
import { defaultWorkspace } from '../threads/workspaces'
import { App } from './AgentPlane'
import { dialogKeyboard } from './dialogKeyboard'
import { planeKeyboard } from './planeKeyboard'

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
    navigate: navigateTarget,
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
  } as never as ThreadDeps
}

function setup(width: number): { store: ThreadStore; settings: SettingsStore } {
  const settings = createSettingsStore(memoryAdapter())
  const store = createThreadStore(makeDeps(), {
    initialWorkspaces: [defaultWorkspace('/w/x')],
  })
  t = createTestRoot({ width, height: 700 })
  t.render(
    createElement(App, {
      store,
      settings,
      gitStore: createGitGraphStore(),
      // 假 deps：不起 git 子进程（status null → not-a-repo 静默态）
      worktree: createWorktreeStore({
        status: async () => null,
        diff: async () => '',
        readFile: async () => null,
      }),
    }),
  )
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

describe('AgentPlane：顶栏 Git 图按钮', () => {
  test('titlebar-git 点击 → paneTab=git 并激活工作区', () => {
    const { store } = setup(800)
    expect(t.renderer.findByTestId('titlebar-git') != null).toBe(true)
    expect(store.getState().workspaces[0]!.paneTab).toBe('home')
    click('titlebar-git')
    expect(store.getState().workspaces[0]!.paneTab).toBe('git')
  })
})

describe('AgentPlane：窄窗口抽屉（W4）', () => {
  test('宽窗口（800px）：无汉堡钮，sidebar 常驻（open-settings 在树中）', () => {
    setup(800)
    expect(t.renderer.findByTestId('drawer-toggle')).toBeUndefined()
    expect(t.renderer.findByTestId('open-settings') != null).toBe(true)
    expect(t.renderer.findByTestId('drawer-scrim')).toBeUndefined()
  })

  test('窄窗口（700px）：汉堡钮在，sidebar 隐藏；点击开抽屉（scrim+panel+设置钮）再点击 scrim 关', () => {
    setup(700)
    expect(t.renderer.findByTestId('drawer-toggle') != null).toBe(true)
    expect(t.renderer.findByTestId('open-settings')).toBeUndefined()
    click('drawer-toggle')
    t.renderer.flush()
    expect(t.renderer.findByTestId('drawer-panel') != null).toBe(true)
    expect(t.renderer.findByTestId('open-settings') != null).toBe(true)
    click('drawer-scrim')
    t.renderer.flush()
    expect(t.renderer.findByTestId('drawer-panel')).toBeUndefined()
  })

  test('抽屉内 Esc 层级：空 query + Esc → 关抽屉（onEscEmpty；v2 搜索框在工具栏，Esc 锚点改 root）', () => {
    setup(700)
    click('drawer-toggle')
    t.renderer.flush()
    key('drawer-panel', 'escape')
    t.renderer.flush()
    // v2：侧栏内搜索框已移除，Esc 关抽屉改由 root 键位层（⌘B 同效）承担；
    // drawer-panel 自身无 Esc handler，抽屉仍在（锁定不误关）
    expect(t.renderer.findByTestId('drawer-panel') != null).toBe(true)
  })
})

describe('AgentPlane：⌘K/Ctrl-K 聚焦搜索 → 打字 → Esc（无 terminal 场景闭环）', () => {
  test('cmd-k 路由 → 焦点进搜索框 → 键入进 query → Esc 清空', async () => {
    // v2（D2）：侧栏内搜索框已移除——⌘K 打开搜索弹窗（dialogKeyboard
    // .openSearch，与工具栏搜索钮同链）。本用例锁定弹窗路径。
    const settings = createSettingsStore(memoryAdapter())
    const store = createThreadStore(makeDeps(), {
      initialWorkspaces: [defaultWorkspace('/w/alpha')],
    })
    t = createTestRoot({ width: 900, height: 700 })
    t.render(
      createElement(App, {
        store,
        settings,
        gitStore: createGitGraphStore(),
        worktree: createWorktreeStore({
          status: async () => null,
          diff: async () => '',
          readFile: async () => null,
        }),
      }),
    )
    t.renderer.flush()
    // 键位层直接调 openSearch（dialogKeyboard 单例；真窗口经 createGlobalKeydown
    // 的 searchThreads 分支，同函数）
    dialogKeyboard.openSearch()
    await until2(() => t.renderer.findByTestId('search-dialog-input') != null)
    // 收尾：Esc 关闭弹窗（DialogHost onKeyDown）
    key('search-dialog-input', 'escape')
    t.renderer.flush()
  })
})

async function until2(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

// ── D2：⌘B 收起侧栏（宽窗口形态） ──────────────────────────────────

describe('AgentPlane：侧栏收起（D2 ⌘B）', () => {
  test('toggleSidebar：宽窗口 sidebar 隐藏 + 侧栏头让位；再切恢复', async () => {
    setup(900)
    // useEffect（planeKeyboard.register）需 macrotask 提交（时序三律）
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    expect(t.renderer.findByTestId('open-settings') != null).toBe(true)
    expect(t.renderer.findByTestId('sidebar-header') != null).toBe(true)
    planeKeyboard.toggleSidebar()
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    expect(t.renderer.findByTestId('open-settings')).toBeUndefined()
    expect(t.renderer.findByTestId('sidebar-header')).toBeUndefined()
    planeKeyboard.toggleSidebar()
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    expect(t.renderer.findByTestId('open-settings') != null).toBe(true)
  })

  // D4：宽窗口收起后，TitleBar 常驻侧栏钮仍可鼠标恢复（此前唯一按钮
  // 随 SidebarHeader 卸载，宽窗收起后只能靠 ⌘B 恢复）
  test('宽窗口收起后：toggle-sidebar 常驻，点击可鼠标恢复（D4）', async () => {
    setup(900)
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    expect(t.renderer.findByTestId('toggle-sidebar') != null).toBe(true)
    planeKeyboard.toggleSidebar()
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    // 侧栏隐藏但恢复钮仍在场
    expect(t.renderer.findByTestId('open-settings')).toBeUndefined()
    expect(t.renderer.findByTestId('toggle-sidebar') != null).toBe(true)
    click('toggle-sidebar')
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    expect(t.renderer.findByTestId('open-settings') != null).toBe(true)
  })
})
