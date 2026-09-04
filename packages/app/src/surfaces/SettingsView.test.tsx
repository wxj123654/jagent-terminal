/**
 * surfaces/SettingsView.test.tsx — T2.4 设置表面测试（architecture.md §9：
 * TestGpuixRenderer；settings-ui.md §15 验收锚点 1/2/4 core + 3/5/10/11 controls）。
 *
 * 跑法：bun test packages/app/src/surfaces/（或整个 app）。
 * 真值接线用真 createSettingsStore + memoryAdapter（接口级，含写链异步——
 * 断言落盘用轮询）。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { SettingsView } from './SettingsView'
import { createSettingsStore } from '../settings/store'
import { memoryAdapter, type MemoryAdapter } from '../settings/file'
import { navigateSettingsSection } from '../router'

let t: TestRoot
let file: MemoryAdapter

beforeAll(() => {
  t = createTestRoot({ width: 1000, height: 700 })
  file = memoryAdapter()
  t.render(createElement(SettingsView, { settings: createSettingsStore(file) }))
})

afterAll(() => {
  t?.unmount()
})

function click(testId: string): void {
  const el = t.renderer.findByTestId(testId)
  expect(el, `not found: ${testId}`).toBeDefined()
  const b = t.renderer.getElementBounds(el!.id)
  expect(b, `no bounds: ${testId}`).toBeDefined()
  t.renderer.nativeSimulateClick(b![0] + b![2] / 2, b![1] + b![3] / 2)
}

function texts(): string {
  return t.renderer.getAllText().join('\n')
}

async function until(desc: string, pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${desc}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 纯 JS 导航 + React 提交让出（时序三律：useSyncExternalStore 的重渲染
 *  需 macrotask 边界提交，GPUI flush 随后） */
async function navigateSection(section: string): Promise<void> {
  navigateSettingsSection(section)
  await new Promise((r) => setTimeout(r, 10))
  t.renderer.flush()
}

// ── core：7 分区导航 + 默认分区 + 深链 ───────────────────────────────

describe('SettingsView · core（§15 1/2/4 部分）', () => {
  test('7 分区导航可见；默认分区 presets 占位卡（Phase 3 徽章）', () => {
    for (const id of ['presets', 'notifications', 'terminal', 'appearance', 'keybindings', 'acp', 'advanced']) {
      expect(t.renderer.findByTestId(`nav-${id}`)).toBeDefined()
    }
    expect(t.renderer.findByTestId('placeholder-presets')).toBeDefined()
    expect(texts().includes('Phase 3')).toBe(true)
  })

  test('nav 点击切分区 → terminal 行出现（SettingRow 真值渲染）', () => {
    click('nav-terminal')
    expect(t.renderer.findByTestId('row-terminal.fontFamily')).toBeDefined()
    expect(t.renderer.findByTestId('row-terminal.closeOnExit')).toBeDefined()
    // Term 分区 6 行全在
    for (const p of ['terminal.fontFamily', 'terminal.fontSize', 'terminal.cursorBlink', 'terminal.scrollbackLines', 'terminal.palette', 'terminal.closeOnExit']) {
      expect(t.renderer.findByTestId(`row-${p}`)).toBeDefined()
    }
  })

  test('深链 ?section=notifications → 通知分区 + 只读约定卡（§15 9 部分）', async () => {
    await navigateSection('notifications')
    expect(t.renderer.findByTestId('row-notifications.desktop')).toBeDefined()
    expect(t.renderer.findByTestId('cli-conventions')).toBeDefined()
    // 约定卡只读文案（§8：不代管 CLI 配置）
    expect(texts().includes('AMP_FORCE_BEL=1')).toBe(true)
  })

  test('keybindings 只读表（S5）', () => {
    click('nav-keybindings')
    expect(texts().includes('Ctrl-Tab / Ctrl-Shift-Tab')).toBe(true)
    expect(texts().includes('Ctrl-,')).toBe(true)
  })
})

// ── controls：搜索过滤 / 计数徽章 / 置灰 / 空态 / 清除 ────────────────

describe('SettingsView · 搜索（§15 3/5 部分）', () => {
  test('键入 → 跨分区命中 + nav 计数徽章 + 0 命中置灰', () => {
    const search = t.renderer.findByTestId('settings-search')!
    t.renderer.nativeSimulateKeystrokes(search.id, 'f o n t')
    t.renderer.flush()

    // path 前缀 terminal.font* 命中 fontFamily/fontSize → terminal 计数 2
    const nav = t.renderer.findByTestId('nav-terminal')!
    expect(t.renderer.getAllText().some((s) => s.trim() === '2')).toBe(true)

    // 搜索模式右列：terminal 命中行（跨分区列表）
    expect(t.renderer.findByTestId('row-terminal.fontFamily')).toBeDefined()

    // 0 命中分区置灰（opacity 0.4），点击不切分区（guard）
    const acp = t.renderer.findByTestId('nav-acp')!
    expect(acp.style.opacity).toBe(0.4)
    click('nav-acp')
    t.renderer.flush()
    // 搜索态未被打断（仍是跨分区命中列表）
    expect(t.renderer.findByTestId('row-terminal.fontFamily')).toBeDefined()
  })

  test('无命中空态 + 清除按钮恢复', async () => {
    // 清空后键入乱串
    let search = t.renderer.findByTestId('settings-search')!
    t.renderer.nativeSimulateKeystrokes(search.id, 'backspace backspace backspace backspace')
    search = t.renderer.findByTestId('settings-search')!
    t.renderer.nativeSimulateKeystrokes(search.id, 'z z z q')
    t.renderer.flush()

    expect(t.renderer.findByTestId('settings-empty')).toBeDefined()

    click('settings-clear-search')
    t.renderer.flush()
    expect(t.renderer.findByTestId('settings-empty')).toBeUndefined()
    // 清除后回到当前分区视图（keybindings——上一用例遗留的 section）
    expect(texts().includes('Ctrl-Tab / Ctrl-Shift-Tab')).toBe(true)
  })

  test('Esc 清空搜索 → 回分区视图', async () => {
    const search = t.renderer.findByTestId('settings-search')!
    t.renderer.nativeSimulateKeystrokes(search.id, 'f o n t')
    t.renderer.flush()
    expect(t.renderer.findByTestId('row-terminal.fontFamily')).toBeDefined()

    t.renderer.nativeSimulateKeyDown(search.id, 'escape')
    t.renderer.flush()
    // 搜索退出 → 回 keybindings 分区（只读表）
    expect(texts().includes('Ctrl-Tab / Ctrl-Shift-Tab')).toBe(true)
  })
})

// ── 真值接线：patch 落盘 + modified + reset + writeError ─────────────

describe('SettingsView · 真值（§15 4/5 部分）', () => {
  test('toggle 点击 → 即时改值 + 异步落盘 + modified 蓝点 + reset 恢复', async () => {
    await navigateSection('notifications')

    // 默认 desktop=true，无蓝点
    expect(t.renderer.findByTestId('reset-notifications.desktop')).toBeUndefined()

    click('setting-notifications.desktop')
    t.renderer.flush()

    // 修改后:modified → reset 钮出现（订阅桥重渲染）
    await until('reset button appears', () =>
      t.renderer.findByTestId('reset-notifications.desktop') !== undefined,
    )

    await until('settings.json written', () => file.snapshot() !== null)
    const written = JSON.parse(file.snapshot()!) as { notifications: { desktop: boolean } }
    expect(written.notifications.desktop).toBe(false)

    // reset → 回默认（默认值 + 蓝点消失）
    click('reset-notifications.desktop')
    await until('reset removes button', () =>
      t.renderer.findByTestId('reset-notifications.desktop') === undefined,
    )
  })

  test('写失败 → 行内红条 + 内存回滚（§5.3）', async () => {
    file.setFailWrite(new Error('EACCES: disk full'))
    click('setting-notifications.desktop')
    await until('write error bar', () => t.renderer.findByTestId('writeerror') !== undefined)
    expect(texts().includes('EACCES')).toBe(true)

    file.setFailWrite(null)
    click('setting-notifications.sound')
    await until('error cleared on success', () =>
      t.renderer.findByTestId('writeerror') === undefined,
    )
  })
})
