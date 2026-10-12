/**
 * ui/PopoverSide.test.tsx — side/align 相对触发器定位（无 position）。
 *
 * Popover 渲染在触发钮内部（父子关系）；断言浮层 bounds 贴触发钮下缘、左对齐。
 *
 * 跑法：bun test src/__tests__/PopoverSide.test.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { Popover } from '../overlays/Popover'

let t: TestRoot

beforeAll(() => {
  t = createTestRoot({ width: 800, height: 600 })
})

afterAll(() => {
  t?.unmount()
})

function Demo({
  align,
  triggerX = 100,
}: {
  align?: 'start' | 'center' | 'end'
  triggerX?: number
}) {
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <div testId="trigger" style={{ marginLeft: triggerX, marginTop: 50, width: 40, height: 22 }}>
        <Popover side="bottom" align={align} onClose={() => {}} testId="pop-side">
          <div testId="pop-side-inner" style={{ width: 120, height: 60 }}>
            <text>side body</text>
          </div>
        </Popover>
      </div>
    </div>
  )
}

function ClippedDemo() {
  // 触发钮在一个 40px 高、overflow 裁剪的滚动容器里，菜单 68px 高必然超出它
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <div
        testId="clip"
        style={{ marginLeft: 100, marginTop: 20, width: 200, height: 40, overflow: 'hidden' }}
      >
        <div testId="trigger" style={{ marginTop: 9, width: 40, height: 22 }}>
          <Popover side="bottom" onClose={() => {}} testId="pop-side">
            <div testId="pop-side-inner" style={{ width: 120, height: 60 }}>
              <text>side body</text>
            </div>
          </Popover>
        </div>
      </div>
    </div>
  )
}

describe('Popover side/align', () => {
  test('side 模式下放不下下方 → 翻到上方（flip，Web 端语义），不压进钮内', () => {
    // 钮靠窗口底部（窗口高 400）：钮底 362，下方只剩 38px，放不下 gap4+菜单68 → 翻到上方
    // （注：钮 y=300 时下方 78px 足够，不会越界，不能用来测 flip）
    function Bottom() {
      return (
        <div style={{ width: '100%', height: '100%' }}>
          <div testId="flip-btn" style={{ marginLeft: 100, marginTop: 340, width: 40, height: 22 }}>
            <Popover side="bottom" align="start" onClose={() => {}} testId="pop-flip">
              <div testId="pop-flip-inner" style={{ width: 120, height: 60 }}>
                <text>flip</text>
              </div>
            </Popover>
          </div>
        </div>
      )
    }
    t.render(createElement(Bottom, { key: 'flip' }))
    t.renderer.flush()
    const btn = t.renderer.getElementBounds(t.renderer.findByTestId('flip-btn')!.id)!
    const pop = t.renderer.getElementBounds(t.renderer.findByTestId('pop-flip')!.id)!
    expect(pop.height).toBeGreaterThan(0)
    // 翻到上方：菜单底边不超过钮顶边（不与钮重叠）
    expect(pop.y + pop.height).toBeLessThanOrEqual(btn.y + 1)
  })

  test('祖先 overflow:hidden 裁剪时菜单仍完整绘制（deferred 不继承 content mask）', () => {
    t.render(createElement(ClippedDemo, { key: 'clip' }))
    t.renderer.flush()
    const clip = t.renderer.getElementBounds(t.renderer.findByTestId('clip')!.id)!
    const pop = t.renderer.getElementBounds(t.renderer.findByTestId('pop-side')!.id)!
    // 菜单底边超出裁剪容器底边，证明它没有被容器截断
    expect(pop.y + pop.height).toBeGreaterThan(clip.y + clip.height)
    expect(t.renderer.getAllText()).toContain('side body')
  })

  test('side=bottom align=start → 浮层贴触发钮下缘、左缘对齐', () => {
    t.render(createElement(Demo, { key: 'start', align: 'start' }))
    t.renderer.flush()
    const trig = t.renderer.getElementBounds(t.renderer.findByTestId('trigger')!.id)!
    // 断言 Popover 内容盒（testId=pop-side，含 padding/border），不是子元素
    const pop = t.renderer.getElementBounds(t.renderer.findByTestId('pop-side')!.id)!
    expect(pop.y).toBeGreaterThanOrEqual(trig.y + trig.height - 1)
    expect(Math.abs(pop.x - trig.x)).toBeLessThanOrEqual(6)
  })

  test('align=end → 浮层右缘与触发钮右缘对齐', () => {
    // 触发钮放右侧（x=400），右对齐的 218px 浮层不越出窗口左边界
    t.render(createElement(Demo, { key: 'end', align: 'end', triggerX: 400 }))
    t.renderer.flush()
    const trig = t.renderer.getElementBounds(t.renderer.findByTestId('trigger')!.id)!
    const pop = t.renderer.getElementBounds(t.renderer.findByTestId('pop-side')!.id)!
    expect(Math.abs(pop.x + pop.width - (trig.x + trig.width))).toBeLessThanOrEqual(6)
  })
})
