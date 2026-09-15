/**
 * FontSelect.test.tsx — 可搜索字体选择器行为测试（TestGpuixRenderer 真渲染
 * 管线；原型 design/j-agent-prototype.html `.font-pop`）。
 *
 * 覆盖：触发器显示当前值 / 打开懒加载字体清单 / 搜索过滤（startsWith 优先）
 * / 点选提交 / 自由输入兜底（「使用 "…"」行）/ Esc 关闭 / 当前值不在清单
 * 时并入列表。
 *
 * 跑法：bun test packages/ui/（Windows + TestGpuixRenderer）。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { FontSelect } from '../controls/FontSelect'

let t: TestRoot

beforeAll(() => {
  t = createTestRoot({ width: 900, height: 700 })
})

afterAll(() => {
  t?.unmount()
})

// ── helpers ──────────────────────────────────────────────────────────

const FONTS = ['Cascadia Code', 'Consolas', 'Fira Code', 'JetBrains Mono', 'Monaco']

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

function renderPicker(
  opts: { value?: string; fonts?: string[] | null; onChange?: (v: string) => void } = {},
) {
  const changes: string[] = []
  t.render(
    createElement(FontSelect, {
      value: opts.value ?? 'JetBrains Mono',
      loadFonts: opts.fonts === null ? undefined : async () => opts.fonts ?? FONTS,
      onChange: opts.onChange ?? ((v: string) => changes.push(v)),
      testId: 'fs',
    }),
  )
  return changes
}

/** 打开弹层并等 loadFonts 微任务落地（setTimeout 0 让 React 提交 + flush） */
async function openPicker(): Promise<void> {
  click('fs')
  await new Promise((r) => setTimeout(r, 0))
  t.renderer.flush()
}

// ── FontSelect ───────────────────────────────────────────────────────

describe('FontSelect', () => {
  test('触发器显示当前值；点击打开搜索弹层并懒加载字体', async () => {
    let loaded = 0
    t.render(
      createElement(FontSelect, {
        value: 'JetBrains Mono',
        loadFonts: async () => {
          loaded++
          return FONTS
        },
        onChange: () => {},
        testId: 'fs',
      }),
    )
    expect(t.renderer.findByTestId('fs-menu')).toBeUndefined()
    expect(loaded).toBe(0) // 未打开不加载

    await openPicker()
    expect(t.renderer.findByTestId('fs-menu')).toBeDefined()
    expect(t.renderer.findByTestId('fs-search')).toBeDefined()
    expect(loaded).toBe(1)
    expect(texts()).toContain('JetBrains Mono')
    expect(texts()).toContain('Cascadia Code')
  })

  test('搜索过滤：startsWith 优先于 includes', async () => {
    renderPicker()
    await openPicker()
    const input = t.renderer.findByTestId('fs-search')!
    t.renderer.nativeSimulateKeystrokes(input.id, 'm o n')
    const all = texts()
    expect(all).toContain('JetBrains Mono')
    expect(all).toContain('Monaco')
    expect(all).not.toContain('Cascadia Code')
    // startsWith（Monaco）排在 includes（JetBrains Mono）之前——比 item 行 y 坐标
    const yMonaco = boundsOf('fs-item-Monaco')[1]
    const yJet = boundsOf('fs-item-JetBrains Mono')[1]
    expect(yMonaco).toBeLessThan(yJet)
  })

  test('点选提交并关闭', async () => {
    const changes = renderPicker()
    await openPicker()
    click('fs-item-Consolas')
    expect(changes).toEqual(['Consolas'])
    expect(t.renderer.findByTestId('fs-menu')).toBeUndefined()
  })

  test('自由输入兜底：无精确匹配时出现「使用 "…"」行', async () => {
    const changes = renderPicker()
    await openPicker()
    const input = t.renderer.findByTestId('fs-search')!
    t.renderer.nativeSimulateKeystrokes(input.id, 'm y f o n t')
    expect(texts()).toContain('使用 "myfont"')
    click('fs-item-myfont')
    expect(changes).toEqual(['myfont'])
  })

  test('当前值不在系统清单时并入列表（可显示 ✓ 选中态）', async () => {
    renderPicker({ value: 'My Custom Font' })
    await openPicker()
    expect(texts()).toContain('My Custom Font')
    expect(t.renderer.findByTestId('fs-item-My Custom Font')).toBeDefined()
  })

  test('Esc 关闭弹层', async () => {
    renderPicker()
    await openPicker()
    const input = t.renderer.findByTestId('fs-search')!
    t.renderer.nativeSimulateKeyDown(input.id, 'escape')
    expect(t.renderer.findByTestId('fs-menu')).toBeUndefined()
  })

  test('无 loadFonts（加载失败面）：空清单 + 自由输入仍可用', async () => {
    const changes = renderPicker({ fonts: null })
    await openPicker()
    const input = t.renderer.findByTestId('fs-search')!
    t.renderer.nativeSimulateKeystrokes(input.id, 'x y z')
    expect(texts()).toContain('使用 "xyz"')
    click('fs-item-xyz')
    expect(changes).toEqual(['xyz'])
  })
})
