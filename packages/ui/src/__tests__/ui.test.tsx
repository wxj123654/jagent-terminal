/**
 * ui.test.tsx — @jagent/ui 原子控件行为测试（architecture.md §9 测试面：
 * TestGpuixRenderer 真渲染管线；坐标 hit-test + 键盘事件全走 GPUI 派发）。
 *
 * 跑法：bun test packages/ui/（Windows + TestGpuixRenderer）。
 * 每用例独立 render（root.render 替换整树）；回调记录进数组断言。
 * SettingRow 的测试留在 app（依赖业务 schema）：packages/app/src/ui/SettingRow.test.tsx。
 * 约定：ui 包测试统一放 src/__tests__/，不与源码混放（ui-extensions.md §7）。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { IconButton } from '../controls/IconButton'
import { NumberInput } from '../controls/NumberInput'
import { RangeInput } from '../controls/RangeInput'
import { SelectField } from '../controls/Select'
import { Textarea } from '../controls/Textarea'
import { TextInput } from '../controls/TextInput'
import { Toggle } from '../controls/Toggle'
import { Badge } from '../display/Badge'

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

function keyDown(testId: string, key: string): void {
  const el = t.renderer.findByTestId(testId)
  expect(el, `element not found: ${testId}`).toBeDefined()
  t.renderer.nativeSimulateKeyDown(el!.id, key)
}

function texts(): string {
  return t.renderer.getAllText().join('\n')
}

// ── Toggle ───────────────────────────────────────────────────────────

describe('Toggle', () => {
  test('点击切换 + space 键切换', () => {
    const calls: boolean[] = []
    t.render(
      createElement(Toggle, { checked: false, onChange: (v) => calls.push(v), testId: 'tg' }),
    )

    click('tg')
    expect(calls).toEqual([true])

    t.render(
      createElement(Toggle, { checked: false, onChange: (v) => calls.push(v), testId: 'tg' }),
    )
    keyDown('tg', 'space')
    expect(calls).toEqual([true, true])
  })

  test('disabled 不响应点击', () => {
    const calls: boolean[] = []
    t.render(
      createElement(Toggle, {
        checked: true,
        disabled: true,
        onChange: (v) => calls.push(v),
        testId: 'tg',
      }),
    )
    click('tg')
    expect(calls).toEqual([])
  })
})

// ── SelectField ──────────────────────────────────────────────────────

describe('SelectField', () => {
  const OPTIONS = [
    { value: 'auto', label: 'Auto（推荐）' },
    { value: 'dx12', label: 'DirectX 12' },
    { value: 'vulkan', label: 'Vulkan' },
  ]

  test('开菜单 → 点项回调', () => {
    const calls: string[] = []
    t.render(
      createElement(SelectField, {
        value: 'auto',
        options: OPTIONS,
        onChange: (v) => calls.push(v),
        testId: 'sel',
      }),
    )

    // 未开菜单：选项不在树上
    expect(t.renderer.findByTestId('sel-item-vulkan')).toBeUndefined()

    click('sel')
    expect(t.renderer.findByTestId('sel-item-vulkan')).toBeDefined()

    click('sel-item-vulkan')
    expect(calls).toEqual(['vulkan'])
  })

  test('disabled 不开菜单', () => {
    const calls: string[] = []
    t.render(
      createElement(SelectField, {
        value: 'auto',
        options: OPTIONS,
        disabled: true,
        onChange: (v) => calls.push(v),
        testId: 'sel',
      }),
    )
    click('sel')
    expect(t.renderer.findByTestId('sel-item-dx12')).toBeUndefined()
  })
})

// ── NumberInput ──────────────────────────────────────────────────────

describe('NumberInput', () => {
  test('stepper 点击 + up/down 键步进', () => {
    const calls: number[] = []
    const render = (value: number) =>
      t.render(
        createElement(NumberInput, {
          value,
          min: 0,
          max: 100,
          step: 5,
          onChange: (v) => calls.push(v),
          testId: 'num',
        }),
      )

    render(10)
    click('num-inc')
    expect(calls).toEqual([15])

    render(15)
    click('num-dec')
    expect(calls).toEqual([15, 10])

    render(10)
    keyDown('num-input', 'up')
    expect(calls).toEqual([15, 10, 15])

    render(15)
    keyDown('num-input', 'down')
    expect(calls).toEqual([15, 10, 15, 10])
  })

  test('越界 clamp：max 边界 stepper 不再增', () => {
    const calls: number[] = []
    t.render(
      createElement(NumberInput, {
        value: 100,
        min: 0,
        max: 100,
        step: 5,
        onChange: (v) => calls.push(v),
        testId: 'num',
      }),
    )
    click('num-inc')
    expect(calls).toEqual([])
  })

  test('键入合法值即时回调；越界值不回调', () => {
    const calls: number[] = []
    t.render(
      createElement(NumberInput, {
        value: 1,
        min: 0,
        max: 100,
        step: 1,
        onChange: (v) => calls.push(v),
        testId: 'num',
      }),
    )

    const input = t.renderer.findByTestId('num-input')!
    t.renderer.nativeSimulateKeystrokes(input.id, '5')
    expect(calls).toEqual([15])

    // 追加成 159 → 越界，仅进 draft 不回调
    t.renderer.nativeSimulateKeystrokes(input.id, '9')
    expect(calls).toEqual([15])
  })
})

// ── RangeInput ───────────────────────────────────────────────────────

describe('RangeInput', () => {
  test('键盘步进 + home/end', () => {
    const calls: number[] = []
    const render = (value: number) =>
      t.render(
        createElement(RangeInput, {
          value,
          min: 200,
          max: 400,
          step: 2,
          onChange: (v) => calls.push(v),
          testId: 'rng',
        }),
      )

    render(248)
    keyDown('rng', 'right')
    expect(calls).toEqual([250])

    render(250)
    keyDown('rng', 'left')
    expect(calls).toEqual([250, 248])

    render(248)
    keyDown('rng', 'end')
    expect(calls).toEqual([250, 248, 400])

    render(400)
    keyDown('rng', 'home')
    expect(calls).toEqual([250, 248, 400, 200])
  })

  test('mouseDown 比例定位 + 拖拽（getElementBounds 路径）', () => {
    const calls: number[] = []
    t.render(
      createElement(RangeInput, {
        value: 200,
        min: 200,
        max: 400,
        step: 2,
        onChange: (v) => calls.push(v),
        testId: 'rng',
      }),
    )

    const [x, y, w, h] = boundsOf('rng')
    // 轨道 50% → 300（down 首值即时 emit）
    t.renderer.nativeSimulateMouseDown(x + w / 2, y + h / 2)
    expect(calls).toEqual([300])

    // 拖到 25% 再 24%：拖动中合帧，同帧窗内两次 move 合并为尾值 248；
    // mouseup 尾缘 flush 落定
    t.renderer.nativeSimulateMouseMove(x + w * 0.25, y + h / 2, 0)
    t.renderer.nativeSimulateMouseMove(x + w * 0.24, y + h / 2, 0)
    expect(calls).toEqual([300])
    t.renderer.nativeSimulateMouseUp(x + w * 0.24, y + h / 2)
    expect(calls).toEqual([300, 248])
  })
})

// ── TextInput / Textarea ─────────────────────────────────────────────

describe('TextInput / Textarea', () => {
  test('键入即时回调', () => {
    const calls: string[] = []
    t.render(createElement(TextInput, { value: '', onChange: (v) => calls.push(v), testId: 'ti' }))
    const el = t.renderer.findByTestId('ti')!
    t.renderer.nativeSimulateKeystrokes(el.id, 'a b')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[calls.length - 1]).toBe('ab')
  })

  test('textarea 键入追加到初值', () => {
    const calls: string[] = []
    t.render(
      createElement(Textarea, { value: 'KEY=V', onChange: (v) => calls.push(v), testId: 'ta' }),
    )
    // textarea 文本在 native 编辑器内，不进 paint text——只验回调面
    const el = t.renderer.findByTestId('ta')!
    t.renderer.nativeSimulateKeystrokes(el.id, 'x')
    expect(calls[calls.length - 1]).toBe('KEY=Vx')
  })

  test('native input 行高取元素样式，不被默认 rem 行高撑大', () => {
    const render = (lineHeight: number) => {
      t.render(
        createElement('textarea', {
          testId: 'line-height-textarea',
          minRows: 3,
          style: { fontSize: 13, lineHeight },
        }),
      )
      t.renderer.flush()
      return t.renderer.getElementBounds(t.renderer.findByTestId('line-height-textarea')!.id)![3]
    }

    expect(render(17)).toBe(51)
    expect(render(23)).toBe(69)
  })
})

// ── Badge ────────────────────────────────────────────────────────────

describe('Badge', () => {
  test('变体文本渲染', () => {
    t.render(createElement(Badge, { variant: 'builtin', children: '内置' }))
    expect(t.renderer.getAllText().some((s) => s.includes('内置'))).toBe(true)
  })
})

// ── IconButton（含 Tooltip hover）─────────────────────────────────────

describe('IconButton', () => {
  test('点击回调 + hover 出 Tooltip 文案', () => {
    let clicked = 0
    t.render(
      createElement(IconButton, {
        name: 'reset',
        label: '恢复默认',
        onClick: () => clicked++,
        testId: 'btn',
      }),
    )

    click('btn')
    expect(clicked).toBe(1)

    // hover → Tooltip open（delay 0 立即）→ label 出现在 painted text。
    // 上游 click 改为 primary-button mouse-up 送达后，同元素内重复 move 不再
    // 合成 mouseenter（与 DOM 语义一致），需从外部移入才触发 hover。
    const [x, y, w, h] = boundsOf('btn')
    t.renderer.nativeSimulateMouseMove(x - 50, y - 50)
    t.renderer.nativeSimulateMouseMove(x + w / 2, y + h / 2)
    expect(texts().includes('恢复默认')).toBe(true)
  })

  test('tooltip=false 时 hover 不弹出气泡', () => {
    t.render(
      createElement(IconButton, {
        name: 'gitBranch',
        label: 'Git 图',
        tooltip: false,
        onClick: () => {},
        testId: 'btn-no-tip',
      }),
    )
    const [x, y, w, h] = boundsOf('btn-no-tip')
    t.renderer.nativeSimulateMouseMove(x + w / 2, y + h / 2)
    expect(texts().includes('Git 图')).toBe(false)
  })
})
