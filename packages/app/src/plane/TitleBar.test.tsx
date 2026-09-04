/**
 * plane/TitleBar.test.tsx — 自绘顶栏三平台分支（Zed 模式移植的回归面）。
 *
 * 跑法：bun test packages/app/src/plane/（TestGpuixRenderer 真渲染管线）。
 * 平台行为参数化注入（TitleBar/SidebarHeader 接 platform prop），
 * 三分支在同一台机器上可测。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { TitleBar, type WindowControls } from './TitleBar'
import { SidebarHeader } from './Sidebar'

let t: TestRoot

beforeAll(() => {
  t = createTestRoot({ width: 900, height: 700 })
})

afterAll(() => {
  t?.unmount()
})

function controlsSpy() {
  const calls: string[] = []
  const wc: WindowControls = {
    startMove: () => calls.push('move'),
    doubleClick: () => calls.push('zoom'),
  }
  return { wc, calls }
}

/** testId → [x, y, w, h]（必须已渲染） */
function boundsOf(testId: string): number[] {
  const el = t.renderer.findByTestId(testId)
  expect(el, `element not found: ${testId}`).toBeDefined()
  const b = t.renderer.getElementBounds(el!.id)
  expect(b, `bounds not found: ${testId}`).toBeDefined()
  return b!
}

// ── mac：红绿灯让位在 SidebarHeader 段；TitleBar 段正常 padding ──────

describe('TitleBar · mac', () => {
  test('SidebarHeader 让位红绿灯（paddingLeft=83=71+12），TitleBar 段 12', () => {
    const { wc } = controlsSpy()
    t.render(
      createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'row', width: '100%', height: 34 } },
        createElement(SidebarHeader, { platform: 'mac', windowControls: wc }),
        createElement(TitleBar, { title: 'j-agent', platform: 'mac', windowControls: wc }),
      ),
    )
    t.renderer.flush()

    const header = boundsOf('sidebar-header')
    expect(header[0]).toBe(0)
    expect(header[2]).toBe(248)

    const bar = boundsOf('titlebar')
    expect(bar[0]).toBe(248)
    // AGENT 文字实际起点 ≈ 83（让位后）；标题起点 ≈ 260（248+12）
    const texts = t.renderer.getAllText()
    expect(texts.join('\n')).toContain('AGENT')
    expect(texts.join('\n')).toContain('j-agent')
  })

  test('drag：mousedown + 按住 move → startMove 一次；双击 → zoom', () => {
    const { wc, calls } = controlsSpy()
    t.render(
      createElement(TitleBar, { title: 't', platform: 'mac', windowControls: wc }),
    )
    t.renderer.flush()
    const b = boundsOf('titlebar')
    const cx = b[0] + b[2] / 2
    const cy = b[1] + b[3] / 2

    t.renderer.simulateMouseDown(cx, cy, 0)
    t.renderer.simulateMouseMove(cx + 5, cy + 3, 0)
    t.renderer.simulateMouseUp(cx + 5, cy + 3, 0)
    expect(calls).toEqual(['move'])

    // 双击（clickCount=2 的 click）→ zoom
    t.renderer.simulateClick(cx, cy, 0)
    t.renderer.simulateClick(cx, cy, 0)
    expect(calls).toContain('zoom')
  })
})

// ── win：三键 + drag 标记；按钮无 JS 点击（系统 NC 处理）────────────

describe('TitleBar · win', () => {
  test('三键存在且各自标记 windowControlArea；无 JS 点击也渲染', () => {
    const { wc, calls } = controlsSpy()
    t.render(
      createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'row', width: '100%', height: 34 } },
        createElement(SidebarHeader, { platform: 'win', windowControls: wc }),
        createElement(TitleBar, { title: 'j-agent', platform: 'win', windowControls: wc }),
      ),
    )
    t.renderer.flush()

    for (const area of ['min', 'max', 'close'] as const) {
      const b = boundsOf(`titlebar-${area}`)
      expect(b[2]).toBe(36)
      expect(b[3]).toBe(34)
    }
    // 右缘对齐：close 按钮右缘 = titlebar 右缘
    const bar = boundsOf('titlebar')
    const close = boundsOf('titlebar-close')
    expect(close[0] + close[2]).toBe(bar[0] + bar[2])

    // 点击 close：无 JS onClick → windowControls 不被调用（系统路径）
    t.renderer.simulateClick(close[0] + 18, close[1] + 17, 0)
    expect(calls).toEqual([])
  })
})

// ── linux：纯内容导航条（系统标题栏在上）────────────────────────────

describe('TitleBar · linux', () => {
  test('无三键、无 drag 事件（windowControls 不触发）', () => {
    const { wc, calls } = controlsSpy()
    t.render(
      createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'row', width: '100%', height: 34 } },
        createElement(SidebarHeader, { platform: 'linux', windowControls: wc }),
        createElement(TitleBar, { title: 'j-agent', platform: 'linux', windowControls: wc }),
      ),
    )
    t.renderer.flush()

    expect(t.renderer.findByTestId('titlebar-close')).toBeUndefined()
    expect(t.renderer.findByTestId('titlebar-min')).toBeUndefined()

    const bar = boundsOf('titlebar')
    t.renderer.simulateMouseDown(bar[0] + 10, bar[1] + 17, 0)
    t.renderer.simulateMouseMove(bar[0] + 20, bar[1] + 20, 0)
    expect(calls).toEqual([])
  })
})
