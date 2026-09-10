/**
 * ui/Popover.test.tsx — 坐标浮层：外点关闭 / 内点保持 / Esc。
 *
 * 跑法：bun test packages/app/src/ui/Popover.test.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement, useState } from 'react'

import { Popover } from '../overlays/Popover'

let t: TestRoot

beforeAll(() => {
  t = createTestRoot({ width: 800, height: 600 })
})

afterAll(() => {
  t?.unmount()
})

function Demo({
  initialOpen = true,
  x = 200,
  y = 160,
}: {
  initialOpen?: boolean
  x?: number
  y?: number
}) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        testId="bg"
        onClick={() => setOpen(true)}
        style={{ width: 100, height: 32, marginLeft: 12, marginTop: 12 }}
      >
        <text>open</text>
      </div>
      {open ? (
        <Popover position={{ x, y }} onClose={() => setOpen(false)} testId="pop">
          <div testId="pop-inner" style={{ width: 160, height: 72, padding: 8 }}>
            <text>popover body</text>
          </div>
        </Popover>
      ) : null}
    </div>
  )
}

describe('Popover', () => {
  test('点外部 → onMouseDownOutside 关闭', () => {
    t.render(createElement(Demo, { key: 'outside' }))
    t.renderer.flush()
    expect(t.renderer.findByTestId('pop')).toBeDefined()
    expect(t.renderer.getAllText()).toContain('popover body')

    // 远离浮层，且避开左上角 trigger（margin 12 + 100×32）——点 trigger
    // 会 onClick 再打开，掩盖外点关闭。
    t.renderer.nativeSimulateClick(780, 580)
    t.renderer.flush()
    expect(t.renderer.findByTestId('pop')).toBeUndefined()
    expect(t.renderer.getAllText()).not.toContain('popover body')
  })

  test('点浮层内部 → 保持打开', () => {
    t.render(createElement(Demo, { key: 'inside' }))
    t.renderer.flush()
    expect(t.renderer.findByTestId('pop')).toBeDefined()

    // 浮层大致中心（bounds ≈ 205,165,218×80）
    t.renderer.nativeSimulateClick(280, 200)
    t.renderer.flush()
    expect(t.renderer.findByTestId('pop')).toBeDefined()
    expect(t.renderer.getAllText()).toContain('popover body')
  })

  test('Esc → 关闭', () => {
    t.render(createElement(Demo, { key: 'esc' }))
    t.renderer.flush()
    const pop = t.renderer.findByTestId('pop')
    expect(pop).toBeDefined()
    t.renderer.nativeSimulateKeyDown(pop!.id, 'escape')
    t.renderer.flush()
    expect(t.renderer.findByTestId('pop')).toBeUndefined()
  })
})
