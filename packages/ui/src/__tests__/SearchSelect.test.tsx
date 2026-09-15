/**
 * SearchSelect.test.tsx — 通用搜索下拉选择器行为测试（TestGpuixRenderer
 * 真渲染管线）。FontSelect 的基座组件。
 *
 * 覆盖：静态 options / label≠value 显示与提交 / searchable=false 的隐形
 * input 键盘导航 / virtualized 列表（全挂载 + 只画可视窗口 + 高亮跟随滚动）
 * / freeform 关闭时无自由输入行。
 *
 * 跑法：bun test packages/ui/（Windows + TestGpuixRenderer）。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { SearchSelect } from '../controls/SearchSelect'

let t: TestRoot

beforeAll(() => {
  t = createTestRoot({ width: 900, height: 700 })
})

afterAll(() => {
  t?.unmount()
})

// ── helpers ──────────────────────────────────────────────────────────

function boundsOf(testId: string): number[] {
  const el = t.renderer.findByTestId(testId)
  expect(el, `element not found: ${testId}`).toBeDefined()
  const b = t.renderer.getElementBounds(el!.id)
  expect(b, `no bounds: ${testId}`).toBeDefined()
  return [b!.x, b!.y, b!.width, b!.height]
}

function click(testId: string): void {
  const [x, y, w, h] = boundsOf(testId)
  t.renderer.nativeSimulateClick(x + w / 2, y + h / 2)
}

function texts(): string {
  return t.renderer.getAllText().join('\n')
}

async function open(): Promise<void> {
  click('ss')
  await new Promise((r) => setTimeout(r, 0))
  t.renderer.flush()
}

// ── SearchSelect ─────────────────────────────────────────────────────

describe('SearchSelect', () => {
  test('静态 options：label≠value 时显示 label、提交 value', async () => {
    const changes: string[] = []
    t.render(
      createElement(SearchSelect, {
        value: 'one-dark',
        options: [
          { value: 'one-dark', label: 'Mono Dark（默认）' },
          { value: 'light', label: 'Light' },
        ],
        onChange: (v) => changes.push(v),
        testId: 'ss',
      }),
    )
    await open()
    expect(texts()).toContain('Mono Dark（默认）')
    expect(texts()).toContain('Light')
    click('ss-item-light')
    expect(changes).toEqual(['light'])
  })

  test('searchable=false：无搜索框，隐形 input 保住键盘导航', async () => {
    const changes: string[] = []
    t.render(
      createElement(SearchSelect, {
        value: 'a',
        options: ['a', 'b', 'c'],
        searchable: false,
        onChange: (v) => changes.push(v),
        testId: 'ss',
      }),
    )
    await open()
    expect(t.renderer.findByTestId('ss-search')).toBeUndefined()
    // ↓↓ 移到 c，enter 提交（键盘事件落在隐形 input 上；逐个发避免批量丢键）
    const hidden = t.renderer.findByType('input')[0]
    // activeIndex 从 null 起步：第一次 ↓ 落第 0 项，三次 ↓ 到 'c'。
    // nativeSimulateKeyDown 末尾不 flush——React state 未提交就连发会读旧值
    for (let i = 0; i < 3; i++) {
      t.renderer.nativeSimulateKeyDown(hidden.id, 'down')
      t.renderer.flush()
    }
    t.renderer.nativeSimulateKeyDown(hidden.id, 'enter')
    expect(changes).toEqual(['c'])
  })

  test('freeform=false：无匹配时不出自由输入行', async () => {
    t.render(
      createElement(SearchSelect, {
        value: 'a',
        options: ['a', 'b'],
        onChange: () => {},
        testId: 'ss',
      }),
    )
    await open()
    const input = t.renderer.findByTestId('ss-search')!
    t.renderer.nativeSimulateKeystrokes(input.id, 'x y z')
    expect(texts()).not.toContain('使用')
    expect(texts()).toContain('无匹配结果')
  })

  test('virtualized：children 全挂载、只画可视窗口、高亮跟随滚动', async () => {
    const fonts = Array.from({ length: 100 }, (_, i) => `Font ${i}`)
    t.render(
      createElement(SearchSelect, {
        value: 'Font 0',
        options: fonts,
        virtualized: true,
        onChange: () => {},
        testId: 'ss',
      }),
    )
    await open()
    const list = t.renderer.findByTestId('ss-list')!
    expect(list.type).toBe('virtual-list')
    expect(list.children).toHaveLength(100)
    // 只画可视窗口（264px / 26px ≈ 10 行 + overdraw）
    expect(t.renderer.getPaintedText().length).toBeLessThan(30)
    // 行宽撑满弹层（virtual-list 子项不默认 stretch，width:'100%' 兜底）
    const row = t.renderer.findByTestId('ss-item-Font 3')!
    expect(t.renderer.getElementBounds(row.id)!.width).toBeGreaterThan(250)
    // 高亮跟随：连按 20 次 ↓，视口应滚动到高亮项附近
    const input = t.renderer.findByTestId('ss-search')!
    for (let i = 0; i < 20; i++) t.renderer.nativeSimulateKeyDown(input.id, 'down')
    const anchor = t.renderer.getListScrollTop?.(list.id)
    expect(anchor).toBeDefined()
    expect(anchor![0]).toBeGreaterThan(5)
  })

  test('virtualized + 打开时当前选中项滚入视口', async () => {
    const fonts = Array.from({ length: 100 }, (_, i) => `Font ${i}`)
    t.render(
      createElement(SearchSelect, {
        value: 'Font 50',
        options: fonts,
        virtualized: true,
        onChange: () => {},
        testId: 'ss',
      }),
    )
    await open()
    const list = t.renderer.findByTestId('ss-list')!
    const anchor = t.renderer.getListScrollTop?.(list.id)
    expect(anchor).toBeDefined()
    // Font 50 应滚到视口顶部附近
    expect(anchor![0]).toBeGreaterThan(30)
  })
})
