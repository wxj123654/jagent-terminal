/**
 * plane/TitleBar.test.tsx — 自绘工具栏三平台分支（Zed 模式移植的回归面）。
 *
 * 跑法：bun test packages/app/src/plane/（TestGpuixRenderer 真渲染管线）。
 * 平台行为参数化注入（TitleBar/SidebarHeader 接 platform prop），
 * 三分支在同一台机器上可测。
 *
 * V2 布局：侧栏整列（含 52px 头）+ 主列（46px 工具栏）。测试还原
 * 真实两列结构——SidebarHeader 代表左列，外层列容器代表 main。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { SidebarHeader } from './Sidebar'
import { TitleBar, type WindowControls } from './TitleBar'

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
    minimize: () => calls.push('min'),
    maximize: () => calls.push('max'),
    close: () => calls.push('close'),
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

/** V2 两列骨架：左列头（侧栏代理）+ 主列（工具栏撑满剩余宽） */
function plane(wc: WindowControls, platform: 'mac' | 'win' | 'linux', titleBarProps = {}) {
  return createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'row', width: '100%', height: '100%' } },
    createElement(SidebarHeader, { platform, windowControls: wc, width: 248 }),
    createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 } },
      createElement(TitleBar, { platform, windowControls: wc, ...titleBarProps }),
    ),
  )
}

// ── mac：红绿灯让位在 SidebarHeader 段；工具栏 46px / 左 padding 12 ──

describe('TitleBar · mac', () => {
  test(`SidebarHeader 让位红绿灯（52px 头），工具栏 46px 12px 内距`, () => {
    const { wc } = controlsSpy()
    t.render(
      plane(wc, 'mac', { chipIcon: 'agent' as const, chipLabel: 'j-agent', panelOpen: false }),
    )
    t.renderer.flush()

    // padding 不放在横向 flex item 上，因此整个左段与内容列严格
    // 对齐；v2：侧栏头 52px、无 AGENT 标签（红绿灯让位由左占位承担）。
    const header = boundsOf('sidebar-header')
    expect(header[0]).toBe(0)
    expect(header[2]).toBe(248)
    expect(header[3]).toBe(52)

    const bar = boundsOf('titlebar')
    expect(bar[0]).toBe(248)
    expect(bar[2]).toBe(900 - 248) // 主列撑满剩余宽
    expect(bar[3]).toBe(46)
    // 左 padding 12 → 常驻侧栏钮 x = 248+12；会话 chip 跟在其后（gap 8）
    expect(boundsOf('toggle-sidebar')[0]).toBe(248 + 12)
    expect(boundsOf('chip-session')[0]).toBe(248 + 12 + 28 + 8)
    const texts = t.renderer.getAllText()
    expect(texts.join('\n')).toContain('j-agent')
    // 面板开关常驻右端前（三键在 mac 不渲染）
    expect(boundsOf('panel-toggle')[0] + 28).toBeLessThanOrEqual(900)
  })

  test('drag：mousedown + 按住 move → startMove 一次；单击不误触 zoom', () => {
    const { wc, calls } = controlsSpy()
    t.render(createElement(TitleBar, { platform: 'mac', windowControls: wc }))
    t.renderer.flush()
    const b = boundsOf('titlebar')
    const cx = b[0] + b[2] / 2
    const cy = b[1] + b[3] / 2

    t.renderer.nativeSimulateMouseDown(cx, cy, 0)
    t.renderer.nativeSimulateMouseMove(cx + 5, cy + 3, 0)
    t.renderer.nativeSimulateMouseUp(cx + 5, cy + 3, 0)
    expect(calls).toEqual(['move'])

    // 单击（clickCount=1）不触发 zoom。双击 → zoom 的路径无法在测试基建
    // 断言（gpui test_context 的 click_count 恒为 1），真机手验。
    t.renderer.nativeSimulateClick(cx, cy, 0)
    expect(calls).toEqual(['move'])
  })
})

// ── win：三键 + drag 标记；按钮无 JS 点击（系统 NC 处理）────────────

describe('TitleBar · win', () => {
  test('三键存在且各自标记 windowControlArea；无 JS 点击也渲染', () => {
    const { wc, calls } = controlsSpy()
    t.render(plane(wc, 'win'))
    t.renderer.flush()

    for (const area of ['min', 'max', 'close'] as const) {
      const b = boundsOf(`titlebar-${area}`)
      expect(b[2]).toBe(36)
      expect(b[3]).toBe(46)
    }
    // 右缘对齐：close 右缘贴窗口右缘（900；父条 bounds 的 x/w
    // 在 gpuix automation 中分别表示 content 起点与盒宽）
    const close = boundsOf('titlebar-close')
    expect(close[0] + close[2]).toBe(900)
    // Windows 不需要 mac 红绿灯让位；左段盒子从窗口左边开始。
    expect(boundsOf('sidebar-header')[0]).toBe(0)

    // 点击 close：无 JS onClick → windowControls 不被调用（系统路径）
    t.renderer.nativeSimulateClick(close[0] + 18, close[1] + 17, 0)
    expect(calls).toEqual([])
  })
})

// ── linux：CSD（Client decorations）——拖拽 + 右侧三键 JS 回调 ────────

describe('TitleBar · linux', () => {
  test('三键存在；拖拽区 mousedown+move → startMove；按钮 onClick 触发 seam', () => {
    const { wc, calls } = controlsSpy()
    t.render(plane(wc, 'linux'))
    t.renderer.flush()

    for (const area of ['min', 'max', 'close'] as const) {
      const b = boundsOf(`titlebar-${area}`)
      expect(b[2]).toBe(36)
      expect(b[3]).toBe(46)
    }
    const close = boundsOf('titlebar-close')
    expect(close[0] + close[2]).toBe(900)

    // 拖拽挂在 titlebar-drag（不含三键）：mousedown + move → startMove
    const drag = boundsOf('titlebar-drag')
    const cx = drag[0] + Math.min(40, drag[2] / 2)
    const cy = drag[1] + drag[3] / 2
    t.renderer.nativeSimulateMouseDown(cx, cy, 0)
    t.renderer.nativeSimulateMouseMove(cx + 5, cy + 3, 0)
    t.renderer.nativeSimulateMouseUp(cx + 5, cy + 3, 0)
    expect(calls).toEqual(['move'])

    // 点击 close → JS seam（非 Windows NC 路径）
    t.renderer.nativeSimulateClick(close[0] + 18, close[1] + 17, 0)
    expect(calls).toEqual(['move', 'close'])

    const min = boundsOf('titlebar-min')
    t.renderer.nativeSimulateClick(min[0] + 18, min[1] + 17, 0)
    expect(calls).toEqual(['move', 'close', 'min'])

    const max = boundsOf('titlebar-max')
    t.renderer.nativeSimulateClick(max[0] + 18, max[1] + 17, 0)
    expect(calls).toEqual(['move', 'close', 'min', 'max'])
  })
})
