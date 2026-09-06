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
} from './keybindings'

function makeHandler(over: { focusThreadSearch: () => void; inSettings?: () => boolean }): {
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
    focusThreadSearch: over.focusThreadSearch,
    inputFocused: () => false,
    settingsQuery: () => '',
    escConsumed: () => false,
    clearEscConsumed: () => {},
    closeSettings: () => {},
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
    const { keydown } = makeHandler({ focusThreadSearch: () => (n += 1) })
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
      focusThreadSearch: () => (n += 1),
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
      focusThreadSearch: () => (n += 1),
      inputFocused: () => false,
      settingsQuery: () => '',
      escConsumed: () => false,
      clearEscConsumed: () => {},
      closeSettings: () => {},
      keys: () => ({ ...DEFAULT_KEYBINDINGS, searchThreads: 'ctrl-shift-p' }),
    })
    keydown('k', false, false, true)
    keydown('p', true, true, false)
    expect(n).toBe(1)
  })
})
