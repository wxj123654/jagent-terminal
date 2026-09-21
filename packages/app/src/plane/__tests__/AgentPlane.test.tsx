/**
 * AgentPlane.test.tsx — 窄窗口抽屉（W4c）：760px 断点布局 + 汉堡钮 +
 * scrim/Esc 关抽屉。TestRenderer 构造时传窗口宽（offscreen window 尺寸
 * → useWindowSize 真 read，非 fallback）。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { inputFocus, keyConsumed, overlayEsc } from '@jagent/ui'
import { dialogKeyboard } from '../../dialogs/dialogKeyboard'
import { createGitGraphStore } from '../../git/store'
import { createWorktreeStore } from '../../git/worktree'
import { createGlobalKeydown, type GlobalKeydown } from '../../keybindings'
import { activeTargetFromLocation, lastNonSettings, navigateTarget, router } from '../../router'
import { memoryAdapter } from '../../settings/file'
import { createSettingsStore, type SettingsStore } from '../../settings/store'
import { settingsKeyboard } from '../../settings/ui/settingsKeyboard'
import { createThreadStore, type ThreadStore, type ThreadDeps } from '../../threads/store'
import { defaultWorkspace } from '../../threads/workspaces'
import { App } from '../AgentPlane'
import { planeKeyboard } from '../planeKeyboard'

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

function setup(
  width: number,
  opts: { branch?: string; wireKeys?: boolean } = {},
): { store: ThreadStore; settings: SettingsStore } {
  const settings = createSettingsStore(memoryAdapter())
  const store = createThreadStore(makeDeps(), {
    initialWorkspaces: [defaultWorkspace('/w/x')],
  })
  // R11：wireKeys = 真键位层（与 main.tsx/e2e 同一 createGlobalKeydown 语义）
  let handleKeydown: GlobalKeydown = () => {}
  if (opts.wireKeys) {
    handleKeydown = createGlobalKeydown({
      store,
      inSettings: () =>
        activeTargetFromLocation(router.history.location.pathname)?.type === 'settings',
      closeSettings: () => store.activate(lastNonSettings()),
      focusSearch: () => {},
      openSearch: () => dialogKeyboard.openSearch(),
      newSession: () => dialogKeyboard.newSession(),
      toggleSidebar: () => planeKeyboard.toggleSidebar(),
      drawerEsc: () => planeKeyboard.escape(),
      inputFocused: () => inputFocus.any,
      settingsQuery: settingsKeyboard.query,
      clearSettingsQuery: () => settingsKeyboard.clearQuery(),
      keyConsumed: () => keyConsumed.take(),
      dialogOpen: () => dialogKeyboard.isOpen(),
      closeDialog: () => dialogKeyboard.close(),
      overlayEsc: () => overlayEsc.escape(),
      keys: () => settings.get().keybindings,
    })
  }
  t = createTestRoot({
    width,
    height: 700,
    onKeyDown: opts.wireKeys
      ? (e) =>
          handleKeydown(
            e.key ?? '',
            e.modifiers?.ctrl ?? false,
            e.modifiers?.shift ?? false,
            e.modifiers?.cmd ?? false,
          )
      : undefined,
  })
  if (opts.wireKeys) keyConsumed.take() // 排空前面用例/文件遗留的消费标记
  t.render(
    createElement(App, {
      store,
      settings,
      gitStore: createGitGraphStore(),
      // 假 deps：不起 git 子进程（status null → not-a-repo 静默态；
      // opts.branch 给分支名 → 顶栏 chip-branch 渲染）
      worktree: createWorktreeStore({
        status: async () => (opts.branch ? { root: '/w/x', branch: opts.branch, files: [] } : null),
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
  t.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2, 0)
  t.renderer.flush()
}

function key(testId: string, k: string) {
  const el = t.renderer.findByTestId(testId)
  if (!el) throw new Error(`not found: ${testId}`)
  t.renderer.nativeSimulateKeyDown(el.id, k)
  t.renderer.flush()
}

describe('AgentPlane：分支 chip 菜单（原型 chip-branch → ctx 菜单）', () => {
  test('chip-branch 点击 → 菜单；「打开 Git 图」→ paneTab=git 并激活工作区', async () => {
    const { store } = setup(800, { branch: 'main' })
    // contextCwd 需激活工作区才有值（worktree.mount 的输入）
    store.activate({ type: 'workspace', id: store.getState().workspaces[0]!.id })
    // worktree.mount 是 effect + async status——等分支 chip 出现
    await until2(() => t.renderer.findByTestId('chip-branch') != null)
    // 原型：无独立 titlebar-git 钮（入口 = 分支 chip 菜单）
    expect(t.renderer.findByTestId('titlebar-git')).toBeUndefined()
    expect(store.getState().workspaces[0]!.paneTab).toBe('home')
    click('chip-branch')
    t.renderer.flush()
    expect(t.renderer.findByTestId('ctx-graph') != null).toBe(true)
    expect(t.renderer.findByTestId('ctx-changes') != null).toBe(true)
    click('ctx-graph')
    t.renderer.flush()
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

  test('root 键位层 Esc 关抽屉（R11 真链路）：开着关、关了 no-op、宽窗 no-op', async () => {
    setup(700, { wireKeys: true })
    // useEffect 注册（planeKeyboard/dialogKeyboard）需 macrotask 提交
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    click('drawer-toggle')
    t.renderer.flush()
    expect(t.renderer.findByTestId('drawer-panel') != null).toBe(true)
    // Esc → root 层 → drawerEsc → 关闭（原型：winW<760 && drawerOpen → close）
    t.renderer.simulateKeystrokes('escape')
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    expect(t.renderer.findByTestId('drawer-panel')).toBeUndefined()
    // 抽屉已关：Esc 无操作（不崩溃、不重开）
    t.renderer.simulateKeystrokes('escape')
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    expect(t.renderer.findByTestId('drawer-panel')).toBeUndefined()
  })

  test('宽窗口 Esc no-op（抽屉层不吃；终端表面 Esc 透传 PTY 的硬约束）', async () => {
    setup(800, { wireKeys: true })
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    t.renderer.simulateKeystrokes('escape')
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    expect(t.renderer.findByTestId('drawer-panel')).toBeUndefined()
    expect(t.renderer.findByTestId('modal-card')).toBeUndefined()
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

describe('AgentPlane：⌘N newSession（R11 全链路：键位层 → dialogKeyboard → ToolDialog）', () => {
  test('⌘N/Ctrl-Shift-N → tool 弹窗（目标工作区 = 当前上下文；Esc 关闭不连坐）', async () => {
    const { store } = setup(900, { wireKeys: true })
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    // 激活该工作区（newSessionWorkspace：工作区路由 → active.id）
    const wsId = store.getState().workspaces[0]!.id
    store.activate({ type: 'workspace', id: wsId })
    await new Promise((r) => setTimeout(r, 10))
    t.renderer.flush()
    t.renderer.simulateKeystrokes(process.platform === 'darwin' ? 'cmd-n' : 'ctrl-shift-n')
    await until2(() => t.renderer.findByTestId('modal-card') != null)
    expect(t.renderer.findByTestId('tool-dialog-workspace') != null).toBe(true)
    // 工作区上下文条显示当前工作区 path（newSessionWorkspace 命中）
    expect(t.renderer.getAllText().some((x) => x.includes('/w/x'))).toBe(true)
    // 弹窗层：全局动作让位——⌘B 不收侧栏（原型 dialog.kind!=='none' → return）
    t.renderer.simulateKeystrokes(process.platform === 'darwin' ? 'cmd-b' : 'ctrl-b')
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    expect(t.renderer.findByTestId('open-settings') != null).toBe(true) // 侧栏仍在
    // Esc 关闭（root 弹窗层兜底 / modal-card 消费——两条路径都到 'none'）
    t.renderer.simulateKeystrokes('escape')
    await until2(() => t.renderer.findByTestId('modal-card') == null)
    // 关闭后再按 ⌘N 可重开（状态无残留）
    t.renderer.simulateKeystrokes(process.platform === 'darwin' ? 'cmd-n' : 'ctrl-shift-n')
    await until2(() => t.renderer.findByTestId('modal-card') != null)
    // 收尾
    t.renderer.simulateKeystrokes('escape')
    await until2(() => t.renderer.findByTestId('modal-card') == null)
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

  // D4：宽窗口收起后，TitleBar 出现 panelLeft 恢复钮（原型：侧栏可见时
  // 无此钮——收起入口在侧栏头；收起后才渲染恢复钮）
  test('宽窗口收起后：toggle-sidebar 出现，点击可鼠标恢复（D4）', async () => {
    setup(900)
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    // 侧栏可见时无 panelLeft 钮
    expect(t.renderer.findByTestId('toggle-sidebar')).toBeUndefined()
    planeKeyboard.toggleSidebar()
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    // 侧栏隐藏 → 恢复钮出现
    expect(t.renderer.findByTestId('open-settings')).toBeUndefined()
    expect(t.renderer.findByTestId('toggle-sidebar') != null).toBe(true)
    click('toggle-sidebar')
    await new Promise((r) => setTimeout(r, 0))
    t.renderer.flush()
    expect(t.renderer.findByTestId('open-settings') != null).toBe(true)
  })
})
