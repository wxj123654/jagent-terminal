/**
 * keybindings.test.ts — 全局键位层单元测试（W4 补 searchThreads 面；
 * cycle/toggle/设置面生命周期键的端到端行为由 e2e 锁定，这里锁分层语义）。
 */

import { describe, expect, test } from 'bun:test'
import {
  createGlobalKeydown,
  keystrokeMatches,
  DEFAULT_KEYBINDINGS,
  type GlobalKeydown,
} from '../keybindings'

function makeHandler(over: {
  openSearch: () => void
  toggleSidebar?: () => void
  newSession?: () => void
  inSettings?: () => boolean
  settingsQuery?: () => string
  clearSettingsQuery?: () => void
  closeSettings?: () => void
  keyConsumed?: () => boolean
  dialogOpen?: () => boolean
  closeDialog?: () => void
  overlayEsc?: () => boolean
  drawerEsc?: () => boolean
}): {
  keydown: GlobalKeydown
  calls: { search: number; cycle: number }
} {
  const calls = { search: 0, cycle: 0 }
  const keydown = createGlobalKeydown({
    store: {
      cycle: (d: number) => {
        calls.cycle += d
      },
      // biome-ignore lint/suspicious/noExplicitAny: 测试桩
      activate: (_t: any) => {},
    },
    inSettings: over.inSettings ?? (() => false),
    focusSearch: () => {},
    openSearch: over.openSearch,
    toggleSidebar: over.toggleSidebar ?? (() => {}),
    newSession: over.newSession,
    drawerEsc: over.drawerEsc,
    inputFocused: () => false,
    settingsQuery: over.settingsQuery ?? (() => ''),
    clearSettingsQuery: over.clearSettingsQuery,
    closeSettings: over.closeSettings ?? (() => {}),
    keyConsumed: over.keyConsumed,
    dialogOpen: over.dialogOpen,
    closeDialog: over.closeDialog,
    overlayEsc: over.overlayEsc,
  })
  return { keydown, calls }
}

describe('keystrokeMatches：cmd 语法（W4）', () => {
  test('cmd-k 只在 cmd=true 命中；ctrl-k 不误中', () => {
    expect(keystrokeMatches('cmd-k', 'k', false, false, true)).toBe(true)
    expect(keystrokeMatches('cmd-k', 'k', true, false, false)).toBe(false)
    expect(keystrokeMatches('cmd-k', 'k', false, false, false)).toBe(false)
    expect(keystrokeMatches('ctrl-k', 'k', true, false, true)).toBe(false)
  })
  test('旧动作不受 cmd 参数影响', () => {
    expect(keystrokeMatches('ctrl-tab', 'tab', true, false)).toBe(true)
    expect(keystrokeMatches('/', '/', false, false)).toBe(true)
  })
})

describe('searchThreads 层（⌘K/Ctrl-K）', () => {
  test('工作区面：默认键位（mac cmd-k）→ 聚焦侧栏搜索；e2e 面（无注入键位表）ctrl-k 同', () => {
    let n = 0
    const { keydown } = makeHandler({ openSearch: () => (n += 1) })
    if (process.platform === 'darwin') keydown('k', false, false, true)
    else keydown('k', true, false, false)
    expect(n).toBe(1)
    // 不匹配的组合不触发
    keydown('k', false, false, false)
    keydown('j', false, false, true)
    expect(n).toBe(1)
  })

  test('设置面打开时不劫持（⌘K 留给设置面语义）', () => {
    let n = 0
    const { keydown } = makeHandler({
      openSearch: () => (n += 1),
      inSettings: () => true,
    })
    keydown('k', false, false, true)
    expect(n).toBe(0)
  })

  test('键位可配置：改绑 ctrl-shift-p 即时生效（keys 注入）', () => {
    let n = 0
    const keydown = createGlobalKeydown({
      store: {
        cycle: () => {},
        // biome-ignore lint/suspicious/noExplicitAny: 测试桩
        activate: (_t: any) => {},
      },
      inSettings: () => false,
      focusSearch: () => {},
      openSearch: () => (n += 1),
      toggleSidebar: () => {},
      inputFocused: () => false,
      settingsQuery: () => '',
      closeSettings: () => {},
      keys: () => ({ ...DEFAULT_KEYBINDINGS, searchThreads: 'ctrl-shift-p' }),
    })
    keydown('k', false, false, true)
    keydown('p', true, true, false)
    expect(n).toBe(1)
  })
})

describe('Git 图键位层（git-graph.md §4.3）', () => {
  function makeGitHandler(over: {
    inSettings?: () => boolean
    inputFocused?: () => boolean
    gitGraphKey?: (key: string) => boolean
    openGitGraph?: () => void
  }) {
    const calls = { cycle: 0 }
    const keydown = createGlobalKeydown({
      store: {
        cycle: (d: number) => {
          calls.cycle += d
        },
        // biome-ignore lint/suspicious/noExplicitAny: 测试桩
        activate: (_t: any) => {},
      },
      inSettings: over.inSettings ?? (() => false),
      focusSearch: () => {},
      openSearch: () => {},
      toggleSidebar: () => {},
      inputFocused: over.inputFocused ?? (() => false),
      settingsQuery: () => '',
      closeSettings: () => {},
      gitGraphKey: over.gitGraphKey,
      openGitGraph: over.openGitGraph,
    })
    return { keydown, calls }
  }

  test('gitGraphKey 返回 true → 消费（不透传不 cycle）', () => {
    let eaten = 0
    const { keydown, calls } = makeGitHandler({
      gitGraphKey: (key) => {
        if (key === 'down') {
          eaten++
          return true
        }
        return false
      },
    })
    keydown('down', false, false)
    expect(eaten).toBe(1)
    // 未命中键透传（无修饰键不触发 cycle）
    keydown('x', false, false)
    expect(eaten).toBe(1)
    expect(calls.cycle).toBe(0)
  })

  test('设置面打开时不吃（gitGraphKey 让位设置面生命周期键）', () => {
    let n = 0
    const { keydown } = makeGitHandler({
      inSettings: () => true,
      gitGraphKey: () => {
        n++
        return true
      },
    })
    keydown('down', false, false)
    expect(n).toBe(0)
  })

  test('输入框聚焦时不吃 gitGraphKey（查找框打字）', () => {
    let n = 0
    const { keydown } = makeGitHandler({
      inputFocused: () => true,
      gitGraphKey: () => {
        n++
        return true
      },
    })
    keydown('r', false, false)
    keydown('down', false, false)
    expect(n).toBe(0)
  })

  test('ctrl-shift-g → openGitGraph（硬编码一期）', () => {
    let n = 0
    const { keydown } = makeGitHandler({ openGitGraph: () => (n += 1) })
    keydown('g', true, true)
    expect(n).toBe(1)
    // 无 shift / 无 ctrl / 其他键不触发
    keydown('g', true, false)
    keydown('g', false, true)
    keydown('h', true, true)
    expect(n).toBe(1)
  })

  test('未注入 gitGraphKey/openGitGraph 时零影响（e2e 旧布线兼容）', () => {
    const { keydown, calls } = makeGitHandler({})
    keydown('down', false, false)
    keydown('g', true, true)
    expect(calls.cycle).toBe(0)
  })
})

// ── D2：⌘B/Ctrl-B 收起侧栏 ──────────────────────────────────────────

describe('toggleSidebar（D2）', () => {
  test('⌘B/Ctrl-B 触发（平台默认键位）', () => {
    let n = 0
    const { keydown } = makeHandler({
      openSearch: () => {},
      toggleSidebar: () => (n += 1),
    })
    if (process.platform === 'darwin') keydown('b', false, false, true)
    else keydown('b', true, false, false)
    expect(n).toBe(1)
  })
  test('裸 b 不触发（终端透传）', () => {
    let n = 0
    const { keydown } = makeHandler({
      openSearch: () => {},
      toggleSidebar: () => (n += 1),
    })
    keydown('b', false, false, false)
    expect(n).toBe(0)
  })
})

// ── R11：原型 useGlobalKeys 优先级链分层 ─────────────────────────────

describe('R11 分层链（原型 useGlobalKeys 对齐）', () => {
  test('L0 元素级消费标记：keyConsumed → 整链跳过（捕获格/Modal Esc）', () => {
    let n = 0
    const { keydown, calls } = makeHandler({
      openSearch: () => (n += 1),
      keyConsumed: () => true,
    })
    keydown('k', false, false, true) // ⌘K 也不应触发
    keydown('tab', true, false) // cycle 也不应触发
    expect(n).toBe(0)
    expect(calls.cycle).toBe(0)
  })

  test('L1 弹窗层：开着吞全部全局动作；Esc 兜底关闭', () => {
    let closed = 0
    const { keydown, calls } = makeHandler({
      openSearch: () => (calls.search += 1),
      dialogOpen: () => true,
      closeDialog: () => (closed += 1),
    })
    keydown('k', false, false, true) // ⌘K 让位
    keydown('tab', true, false) // cycle 让位
    expect(calls.search).toBe(0)
    expect(calls.cycle).toBe(0)
    keydown('escape', false, false)
    expect(closed).toBe(1)
    // 弹窗关后全局动作恢复
    const keydown2 = makeHandler({ openSearch: () => (calls.search += 1) }).keydown
    keydown2('k', false, false, true)
    expect(calls.search).toBe(process.platform === 'darwin' ? 1 : 0)
  })

  test('L2 浮层 Esc 栈：返回 true 吃掉（先于设置面/抽屉层）', () => {
    let overlay = 0
    let drawer = 0
    let closed = 0
    const { keydown } = makeHandler({
      openSearch: () => {},
      overlayEsc: () => {
        overlay += 1
        return true
      },
      drawerEsc: () => {
        drawer += 1
        return true
      },
      closeSettings: () => (closed += 1),
      inSettings: () => true,
    })
    keydown('escape', false, false)
    expect(overlay).toBe(1) // 浮层先吃
    expect(closed).toBe(0) // 设置面不连坐关
    expect(drawer).toBe(0)
  })

  test('L3 设置面 Esc：query 非空 → 清空不退出；空 → 关闭', () => {
    let cleared = 0
    let closed = 0
    const { keydown } = makeHandler({
      openSearch: () => {},
      inSettings: () => true,
      settingsQuery: () => 'abc',
      clearSettingsQuery: () => (cleared += 1),
      closeSettings: () => (closed += 1),
    })
    keydown('escape', false, false)
    expect(cleared).toBe(1)
    expect(closed).toBe(0)

    const empty = makeHandler({
      openSearch: () => {},
      inSettings: () => true,
      settingsQuery: () => '',
      clearSettingsQuery: () => (cleared += 1),
      closeSettings: () => (closed += 1),
    })
    empty.keydown('escape', false, false)
    expect(cleared).toBe(1)
    expect(closed).toBe(1)
  })

  test('newSession（D7）：平台默认键位命中；裸 n 不吃；设置面不劫持', () => {
    let n = 0
    const { keydown } = makeHandler({
      openSearch: () => {},
      newSession: () => (n += 1),
    })
    // mac ⌘N / win·linux ctrl-shift-n（schema 平台默认值）
    if (process.platform === 'darwin') keydown('n', false, false, true)
    else keydown('n', true, true, false)
    expect(n).toBe(1)
    // 裸 n / 错修饰不吃（硬约束 2：全局动作必含修饰键）
    keydown('n', false, false, false)
    keydown('n', true, false, false) // 裸 ctrl-n（readline next-history）不吃
    expect(n).toBe(1)

    // 设置面内不劫持（同 searchThreads 语义）
    const inSettings = makeHandler({
      openSearch: () => {},
      newSession: () => (n += 1),
      inSettings: () => true,
    })
    inSettings.keydown('n', false, false, true)
    expect(n).toBe(1)
  })
})
