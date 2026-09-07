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

import { navigateSettingsSection } from '../router'
import { memoryAdapter, type MemoryAdapter } from '../settings/file'
import { createSettingsStore } from '../settings/store'
import { SettingsView } from './SettingsView'

let t: TestRoot
let file: MemoryAdapter
let settingsStore: ReturnType<typeof createSettingsStore>

beforeAll(() => {
  t = createTestRoot({ width: 1000, height: 700 })
  file = memoryAdapter()
  settingsStore = createSettingsStore(file)
  t.render(createElement(SettingsView, { settings: settingsStore }))
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
  test('7 分区导航可见；默认分区 presets 真分区（预设列表 + plusDefault）', () => {
    for (const id of [
      'presets',
      'notifications',
      'terminal',
      'appearance',
      'keybindings',
      'acp',
      'advanced',
    ]) {
      expect(t.renderer.findByTestId(`nav-${id}`)).toBeDefined()
    }
    // T3.1：Presets 不再占位——真 CRUD 分区（内置 5 行 + 新增按钮）
    expect(t.renderer.findByTestId('placeholder-presets')).toBeUndefined()
    expect(t.renderer.findByTestId('plus-default')).toBeDefined()
    expect(t.renderer.findByTestId('preset-card-claude')).toBeDefined()
    expect(t.renderer.findByTestId('add-preset')).toBeDefined()
    // T3+.1：ACP 分区实装（默认 2 示例 + 新增按钮；占位卡下岗）
    click('nav-acp')
    t.renderer.flush()
    expect(t.renderer.findByTestId('placeholder-acp')).toBeUndefined()
    expect(t.renderer.findByTestId('agent-card-acp-codex')).toBeDefined()
    expect(t.renderer.findByTestId('agent-card-acp-claude')).toBeDefined()
    expect(t.renderer.findByTestId('add-acp-agent')).toBeDefined()
  })

  test('nav 点击切分区 → terminal 行出现（SettingRow 真值渲染）', () => {
    click('nav-terminal')
    expect(t.renderer.findByTestId('row-terminal.fontFamily')).toBeDefined()
    expect(t.renderer.findByTestId('row-terminal.closeOnExit')).toBeDefined()
    // Term 分区 6 行全在
    for (const p of [
      'terminal.fontFamily',
      'terminal.fontSize',
      'terminal.cursorBlink',
      'terminal.scrollbackLines',
      'terminal.palette',
      'terminal.closeOnExit',
    ]) {
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

  test('keybindings 分区：默认键位 + 平台语义只读行（S5 解锁后仍保留）', () => {
    click('nav-keybindings')
    // 键帽显示 = settings.json 原串（JSON 是事实源）
    expect(texts().includes('ctrl-tab')).toBe(true)
    expect(texts().includes('ctrl-shift-tab')).toBe(true)
    expect(texts().includes('ctrl-,')).toBe(true)
    expect(texts().includes('Esc（平台语义）')).toBe(true)
    // 四个可编辑捕获格
    expect(t.renderer.findByTestId('kb-cap-cycleNext')).toBeDefined()
    expect(t.renderer.findByTestId('kb-cap-focusSearch')).toBeDefined()
  })

  /** 点击捕获格中心进入编辑态（坐标 hit-test 路径） */
  function clickCap(testId: string): void {
    const el = t.renderer.findByTestId(testId)!
    const b = t.renderer.getElementBounds(el.id)!
    t.renderer.nativeSimulateClick(b[0] + b[2] / 2, b[1] + b[3] / 2)
  }

  test('改键：点击捕获格 → 按组合 → 即时写入 + 蓝点 + reset 恢复', async () => {
    click('nav-keybindings')
    clickCap('kb-cap-toggleSettings')
    t.renderer.flush()
    // 编辑态提示
    expect(texts().includes('按下新组合…')).toBe(true)
    // 无 ctrl 裸键 → 拒绝（全局层不吃裸键）
    t.renderer.nativeSimulateKeyDown(t.renderer.findByTestId('kb-cap-toggleSettings')!.id, 'k')
    t.renderer.flush()
    expect(texts().includes('需含 Ctrl')).toBe(true)
    // 有效组合 → 写入
    t.renderer.nativeSimulateKeyDown(t.renderer.findByTestId('kb-cap-toggleSettings')!.id, 'ctrl-k')
    t.renderer.flush()
    expect(texts().includes('ctrl-k')).toBe(true)
    expect(texts().includes('按下新组合…')).toBe(false)
    // modified → reset 钮出现；点击回默认
    expect(t.renderer.findByTestId('kb-reset-toggleSettings')).toBeDefined()
    click('kb-reset-toggleSettings')
    t.renderer.flush()
    // 平台无关断言：toggleSettings 行恢复默认 ctrl-,，同绑警示行消失。
    // （searchThreads 常驻行在 win 默认就是 ctrl-k，全文搜索 'ctrl-k'
    // 在 Windows 上恒 true，不可用作 reset 后的断言。）
    expect(texts().includes('ctrl-,')).toBe(true)
    expect(texts().includes('同绑 ctrl-k')).toBe(false)
    expect(t.renderer.findByTestId('kb-reset-toggleSettings')).toBeUndefined()
    // 设置真值面
    expect(settingsStore.get().keybindings.toggleSettings).toBe('ctrl-,')
  })

  test('改键冲突：同绑另一动作 → 警示行', async () => {
    click('nav-keybindings')
    clickCap('kb-cap-toggleSettings')
    t.renderer.flush()
    // 与 cycleNext 同绑 ctrl-tab → 双方警示
    t.renderer.nativeSimulateKeyDown(
      t.renderer.findByTestId('kb-cap-toggleSettings')!.id,
      'ctrl-tab',
    )
    t.renderer.flush()
    expect(t.renderer.findByTestId('kb-conflict-toggleSettings')).toBeDefined()
    expect(t.renderer.findByTestId('kb-conflict-cycleNext')).toBeDefined()
    settingsStore.reset('keybindings.toggleSettings')
    // store 直调（非事件路径）→ React 订阅提交需 macrotask 让出
    await new Promise((r) => setTimeout(r, 10))
    t.renderer.flush()
    expect(t.renderer.findByTestId('kb-conflict-cycleNext')).toBeUndefined()
  })

  test('Esc 取消编辑：不连坐关设置（消费标记）', async () => {
    click('nav-keybindings')
    clickCap('kb-cap-cycleNext')
    t.renderer.flush()
    expect(texts().includes('按下新组合…')).toBe(true)
    t.renderer.nativeSimulateKeyDown(t.renderer.findByTestId('kb-cap-cycleNext')!.id, 'escape')
    t.renderer.flush()
    expect(texts().includes('按下新组合…')).toBe(false) // 退出编辑态
    expect(t.renderer.findByTestId('settings-search')).toBeDefined() // 设置面还在
  })
})

// ── controls：搜索过滤 / 计数徽章 / 置灰 / 空态 / 清除 ────────────────

describe('SettingsView · 搜索（§15 3/5 部分）', () => {
  test('键入 → 跨分区命中 + nav 计数徽章 + 0 命中置灰', () => {
    const search = t.renderer.findByTestId('settings-search')!
    t.renderer.nativeSimulateKeystrokes(search.id, 'f o n t')
    t.renderer.flush()

    // path 前缀 terminal.font* 命中 fontFamily/fontSize → terminal 计数 2
    t.renderer.findByTestId('nav-terminal')!
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
    expect(texts().includes('ctrl-tab')).toBe(true)
  })

  test('Esc 清空搜索 → 回分区视图', async () => {
    const search = t.renderer.findByTestId('settings-search')!
    t.renderer.nativeSimulateKeystrokes(search.id, 'f o n t')
    t.renderer.flush()
    expect(t.renderer.findByTestId('row-terminal.fontFamily')).toBeDefined()

    t.renderer.nativeSimulateKeyDown(search.id, 'escape')
    t.renderer.flush()
    // 搜索退出 → 回 keybindings 分区（只读表）
    expect(texts().includes('ctrl-tab')).toBe(true)
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
    await until(
      'reset button appears',
      () => t.renderer.findByTestId('reset-notifications.desktop') !== undefined,
    )

    await until('settings.json written', () => file.snapshot() !== null)
    const written = JSON.parse(file.snapshot()!) as { notifications: { desktop: boolean } }
    expect(written.notifications.desktop).toBe(false)

    // reset → 回默认（默认值 + 蓝点消失）
    click('reset-notifications.desktop')
    await until(
      'reset removes button',
      () => t.renderer.findByTestId('reset-notifications.desktop') === undefined,
    )
  })

  test('写失败 → 行内红条 + 内存回滚（§5.3）', async () => {
    file.setFailWrite(new Error('EACCES: disk full'))
    click('setting-notifications.desktop')
    await until('write error bar', () => t.renderer.findByTestId('writeerror') !== undefined)
    expect(texts().includes('EACCES')).toBe(true)

    file.setFailWrite(null)
    click('setting-notifications.sound')
    await until(
      'error cleared on success',
      () => t.renderer.findByTestId('writeerror') === undefined,
    )
  })
})

// ── scroll containment：视口约束 + padding 不产生空滚 ─────────────────

describe('SettingsView · scroll containment', () => {
  test('短内容不产生空滚；内容超出时视口仍受父高约束', () => {
    const constrained = createTestRoot({ width: 900, height: 700 })
    const localSettings = createSettingsStore(memoryAdapter())
    const frame = (height: number) =>
      createElement(
        'div',
        {
          style: {
            width: 900,
            height,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          },
        },
        createElement(SettingsView, { settings: localSettings }),
      )

    try {
      navigateSettingsSection('presets')
      constrained.render(frame(500))
      constrained.renderer.flush()

      let scroll = constrained.renderer.findByTestId('settings-content-scroll')!
      let bounds = constrained.renderer.getElementBounds(scroll.id)!
      expect(bounds[3]).toBe(500)
      constrained.renderer.nativeSimulateScrollWheel(
        bounds[0] + bounds[2] / 2,
        bounds[1] + 100,
        0,
        -1000,
      )
      expect(Math.abs(constrained.renderer.getScrollOffset(scroll.id)![1])).toBe(0)

      constrained.render(frame(300))
      constrained.renderer.flush()
      scroll = constrained.renderer.findByTestId('settings-content-scroll')!
      bounds = constrained.renderer.getElementBounds(scroll.id)!
      expect(bounds[3]).toBe(300)
      constrained.renderer.nativeSimulateScrollWheel(
        bounds[0] + bounds[2] / 2,
        bounds[1] + 100,
        0,
        -1000,
      )
      expect(constrained.renderer.getScrollOffset(scroll.id)![1]).toBeLessThan(0)
    } finally {
      constrained.unmount()
    }
  })
})
