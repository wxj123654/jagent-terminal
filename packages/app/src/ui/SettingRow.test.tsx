/**
 * ui/SettingRow.test.tsx — 设置行行为测试（声明式行：控件回调 / 蓝点 /
 * reset 槽 / phase disabled）。SettingRow 依赖应用 SettingDef（settings
 * schema），按 ui-extensions.md §5 留在 app；helpers 与控件测试同源
 * （packages/ui/src/ui.test.tsx）。
 *
 * 跑法：bun test packages/app/src/ui/（TestGpuixRenderer 真渲染管线）。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { SETTING_DEFS } from '../settings/schema'
import { SettingRow } from './SettingRow'

let t: TestRoot

beforeAll(() => {
  t = createTestRoot({ width: 900, height: 700 })
})

afterAll(() => {
  t?.unmount()
})

// ── helpers ──────────────────────────────────────────────────────────

/** testId → [x, y, w, h]（必须已渲染） */
function boundsOf(testId: string): number[] {
  const el = t.renderer.findByTestId(testId)
  expect(el, `element not found: ${testId}`).toBeDefined()
  const b = t.renderer.getElementBounds(el!.id)
  expect(b, `no bounds: ${testId}`).toBeDefined()
  return b!
}

/** 坐标点击（中心点，走 GPUI hit-test 全管线） */
function click(testId: string): void {
  const [x, y, w, h] = boundsOf(testId)
  t.renderer.nativeSimulateClick(x + w / 2, y + h / 2)
}

function texts(): string {
  return t.renderer.getAllText().join('\n')
}

// ── SettingRow（声明式行）────────────────────────────────────────────

describe('SettingRow', () => {
  const defOf = (path: string) => {
    const def = SETTING_DEFS.find((d) => d.path === path)
    expect(def, `def not found: ${path}`).toBeDefined()
    return def!
  }

  test('toggle 行：控件回调 + 蓝点 + reset', () => {
    const changes: (boolean | string | number)[] = []
    let resets = 0
    const def = defOf('notifications.desktop')
    t.render(
      createElement(SettingRow, {
        def,
        value: true,
        modified: true,
        onChange: (v) => changes.push(v),
        onReset: () => resets++,
      }),
    )

    expect(t.renderer.findByTestId('row-notifications.desktop')).toBeDefined()
    expect(t.renderer.findByTestId('moddot-notifications.desktop')).toBeDefined()
    expect(t.renderer.findByTestId('reset-notifications.desktop')).toBeDefined()
    expect(boundsOf('reset-slot-notifications.desktop')[2]).toBe(18)
    expect(boundsOf('reset-notifications.desktop')[2]).toBe(18)

    click('setting-notifications.desktop')
    expect(changes).toEqual([false])

    click('reset-notifications.desktop')
    expect(resets).toBe(1)
  })

  test('未修改行保留 reset 槽；显隐切换不改变控件与槽位布局', () => {
    const def = defOf('terminal.scrollbackLines')
    const renderRow = (modified: boolean) =>
      t.render(
        createElement(SettingRow, {
          def,
          value: 10000,
          modified,
          onChange: () => {},
          onReset: () => {},
        }),
      )

    renderRow(false)
    expect(t.renderer.findByTestId('reset-terminal.scrollbackLines')).toBeUndefined()
    expect(t.renderer.findByTestId('reset-inactive-terminal.scrollbackLines')).toBeDefined()
    const slotBefore = boundsOf('reset-slot-terminal.scrollbackLines')
    const controlBefore = boundsOf('setting-terminal.scrollbackLines')
    expect(slotBefore[2]).toBe(18)

    renderRow(true)
    expect(t.renderer.findByTestId('reset-terminal.scrollbackLines')).toBeDefined()
    expect(boundsOf('reset-slot-terminal.scrollbackLines')).toEqual(slotBefore)
    expect(boundsOf('setting-terminal.scrollbackLines')).toEqual(controlBefore)
    expect(t.renderer.getAllText().some((s) => s.includes('回滚行数'))).toBe(true)
    expect(t.renderer.getAllText().some((s) => s.includes('scrollback 缓冲区大小'))).toBe(true)
  })

  test('phase 行：控件 disabled + PhaseBadge', () => {
    const def = { ...defOf('notifications.desktop'), phase: 2 as const }
    const changes: (boolean | string | number)[] = []
    t.render(
      createElement(SettingRow, {
        def,
        value: true,
        modified: false,
        onChange: (v) => changes.push(v),
        onReset: () => {},
      }),
    )

    expect(t.renderer.findByTestId('phase-notifications.desktop')).toBeDefined()
    expect(texts().includes('Phase 2')).toBe(true)

    click('setting-notifications.desktop')
    expect(changes).toEqual([])
  })
})
