import { expect, test } from 'bun:test'
import { createTestRoot } from '@gpuix/react/testing'

/**
 * 嵌套滚动的浏览器式语义（详见 docs/nested-scroll-research.md）：
 *
 * 一串连续滚轮输入锁定同一个滚动容器（scroll latching）。序列内的后续
 * wheel 只作用于锁定容器；即使它已经到底，也不会把剩余位移交给祖先。
 * 只有开启新序列时才重新命中并沿链选目标——那一刻内层已到底，于是父层
 * 接管。结束序列的条件：空闲超过 500ms、指针相对序列首个位置移动 >= 10px、
 * modifier 变化、或 pointer 离开锁定容器边界。
 *
 * 覆盖 native hit test 与传播本身，而不是合成 JS 回调。
 */

type Root = ReturnType<typeof createTestRoot>

function yOf(t: Root, id: number) {
  return t.renderer.getScrollOffset(id)![1] + 0
}

function xOf(t: Root, id: number) {
  return t.renderer.getScrollOffset(id)![0] + 0
}

function wheel(t: Root, x: number, y: number, dx: number, dy: number, modifiers?: string) {
  t.renderer.nativeSimulateScrollWheel(x, y, dx, dy, modifiers)
}

function Rows({ count }: { count: number }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={i} style={{ height: 40, flexShrink: 0 }}>
      <text>{`row ${i}`}</text>
    </div>
  ))
}

test('a wheel burst stays latched to the inner container after it hits its edge', () => {
  const t = createTestRoot({ width: 500, height: 400 })
  let events = 0
  try {
    t.render(
      <div testId="outer" style={{ width: 260, height: 260, overflowY: 'scroll' }}>
        <div
          testId="inner"
          onScroll={() => events++}
          style={{ width: 240, height: 160, flexShrink: 0, overflowY: 'scroll' }}
        >
          <div style={{ height: 800, flexShrink: 0 }}>
            <text>inner content</text>
          </div>
        </div>
        <div style={{ height: 900, flexShrink: 0 }} />
      </div>,
    )
    const inner = t.renderer.findByType('div').find((d) => d.testId === 'inner')!
    const outer = t.renderer.findByType('div').find((d) => d.testId === 'outer')!

    // 第一个事件开启序列并锁定内层。
    wheel(t, 80, 60, 0, -50)
    expect(yOf(t, inner.id)).toBe(-50)
    expect(yOf(t, outer.id)).toBe(0)

    // 同一序列内继续滚：仍然只动内层。
    wheel(t, 80, 60, 0, -50)
    expect(yOf(t, inner.id)).toBe(-100)
    expect(yOf(t, outer.id)).toBe(0)

    // 内层到底后，同一序列剩余的事件不再带动父层（这是与"每事件接力"的差别）。
    t.renderer.scrollTo(inner.id, 0, -630)
    wheel(t, 80, 60, 0, -50)
    expect(yOf(t, inner.id)).toBe(-640)
    expect(yOf(t, outer.id)).toBe(0)
    wheel(t, 80, 60, 0, -50)
    expect(yOf(t, inner.id)).toBe(-640)
    expect(yOf(t, outer.id)).toBe(0)
    wheel(t, 80, 60, 0, -50)
    expect(yOf(t, inner.id)).toBe(-640)
    expect(yOf(t, outer.id)).toBe(0)

    // 空闲超过序列超时：下一个 wheel 开启新序列，内层已到底 → 父层接管。
    t.renderer.advanceTime(600)
    wheel(t, 80, 60, 0, -50)
    expect(yOf(t, inner.id)).toBe(-640)
    expect(yOf(t, outer.id)).toBe(-50)

    // 内层的 wheel 回调在整串输入里都照常触发（回调不等于位移）。
    expect(events).toBe(6)
  } finally {
    t.unmount()
  }
})

test('pointer travel, modifiers, and idle gaps start a new wheel sequence', () => {
  const t = createTestRoot({ width: 500, height: 400 })
  try {
    t.render(
      <div testId="outer" style={{ width: 260, height: 260, overflowY: 'scroll' }}>
        <div testId="inner" style={{ width: 240, height: 160, flexShrink: 0, overflowY: 'scroll' }}>
          <div style={{ height: 800, flexShrink: 0 }}>
            <text>inner content</text>
          </div>
        </div>
        <div style={{ height: 900, flexShrink: 0 }} />
      </div>,
    )
    const inner = t.renderer.findByType('div').find((d) => d.testId === 'inner')!
    const outer = t.renderer.findByType('div').find((d) => d.testId === 'outer')!

    // 锁死内层到底。
    wheel(t, 80, 60, 0, -50)
    t.renderer.scrollTo(inner.id, 0, -640)

    // 指针移动不足 10px：仍属同一序列，父层不动。
    wheel(t, 83, 63, 0, -50)
    expect(yOf(t, outer.id)).toBe(0)

    // 指针相对序列首个位置移动 >= 10px：新序列 → 内层到底，父层接管。
    wheel(t, 80, 80, 0, -50)
    expect(yOf(t, inner.id)).toBe(-640)
    expect(yOf(t, outer.id)).toBe(-50)

    // modifier 变化同样开启新序列。
    wheel(t, 80, 80, 0, -50, 'alt')
    expect(yOf(t, outer.id)).toBe(-100)

    // 指针移出锁定容器：序列结束，父层继续接管。
    t.renderer.nativeSimulateMouseMove(80, 240)
    wheel(t, 80, 240, 0, -50)
    expect(yOf(t, outer.id)).toBe(-150)
  } finally {
    t.unmount()
  }
})

test('nested virtual-list latches a burst and chains on the next sequence', () => {
  const t = createTestRoot({ width: 500, height: 400 })
  try {
    t.render(
      <div testId="outer" style={{ width: 260, height: 260, overflowY: 'scroll' }}>
        <virtual-list estimatedItemHeight={40} style={{ width: 240, height: 160, flexShrink: 0 }}>
          <Rows count={20} />
        </virtual-list>
        <div style={{ height: 900, flexShrink: 0 }} />
      </div>,
    )
    const list = t.renderer.findByType('virtual-list')[0]!
    const outer = t.renderer.findByType('div').find((d) => d.testId === 'outer')!

    wheel(t, 80, 60, 0, -50)
    expect(yOf(t, list.id)).toBe(-50)
    expect(yOf(t, outer.id)).toBe(0)

    t.renderer.scrollTo(list.id, 0, -630)
    wheel(t, 80, 60, 0, -50)
    expect(yOf(t, list.id)).toBe(-640)
    expect(yOf(t, outer.id)).toBe(0)

    // 同一序列到底不再接力。
    wheel(t, 80, 60, 0, -50)
    expect(yOf(t, list.id)).toBe(-640)
    expect(yOf(t, outer.id)).toBe(0)

    // 新序列（指针位移）才让父层接管。
    wheel(t, 80, 120, 0, -50)
    expect(yOf(t, list.id)).toBe(-640)
    expect(yOf(t, outer.id)).toBe(-50)
  } finally {
    t.unmount()
  }
})

test('short nested content and overflow-x inner do not steal a vertical wheel', () => {
  const t = createTestRoot({ width: 500, height: 400 })
  try {
    t.render(
      <div style={{ display: 'flex', flexDirection: 'row', width: 500, height: 300 }}>
        <div testId="short-outer" style={{ width: 240, height: 160, overflowY: 'scroll' }}>
          <div
            testId="short-inner"
            style={{ width: 220, height: 80, flexShrink: 0, overflowY: 'scroll' }}
          >
            <div style={{ height: 40, flexShrink: 0 }} />
          </div>
          <div style={{ height: 900, flexShrink: 0 }} />
        </div>
        <div testId="axis-outer" style={{ width: 240, height: 160, overflowY: 'scroll' }}>
          <div
            testId="axis-inner"
            style={{ width: 220, height: 80, flexShrink: 0, overflowX: 'scroll' }}
          >
            <div style={{ width: 800, height: 80, flexShrink: 0 }} />
          </div>
          <div style={{ height: 900, flexShrink: 0 }} />
        </div>
      </div>,
    )
    const shortInner = t.renderer.findByType('div').find((d) => d.testId === 'short-inner')!
    const shortOuter = t.renderer.findByType('div').find((d) => d.testId === 'short-outer')!

    // 内容不足以滚动的内层从不认领序列，父层直接接管。
    wheel(t, 80, 60, 0, -50)
    expect(yOf(t, shortInner.id)).toBe(0)
    expect(yOf(t, shortOuter.id)).toBe(-50)

    const axisInner = t.renderer.findByType('div').find((d) => d.testId === 'axis-inner')!
    const axisOuter = t.renderer.findByType('div').find((d) => d.testId === 'axis-outer')!

    // 横向滚轮锁到只能横向滚动的内层。
    wheel(t, 320, 60, -80, 0)
    expect(xOf(t, axisInner.id)).toBe(-80)
    expect(yOf(t, axisOuter.id)).toBe(0)

    // 同一序列的纵向滚轮被锁定容器吞掉：不横滚也不带动父层。
    wheel(t, 320, 60, 0, -50)
    expect(xOf(t, axisInner.id)).toBe(-80)
    expect(yOf(t, axisOuter.id)).toBe(0)

    // 指针移开后是新序列：命中路径只剩父层，纵向滚轮生效。
    wheel(t, 320, 100, 0, -50)
    expect(xOf(t, axisInner.id)).toBe(-80)
    expect(yOf(t, axisOuter.id)).toBe(-50)
  } finally {
    t.unmount()
  }
})

test('padded scroll containers expose no phantom scroll range', () => {
  const t = createTestRoot({ width: 500, height: 400 })
  try {
    t.render(
      <div testId="outer" style={{ width: 260, height: 300, overflowY: 'scroll' }}>
        {/* 内容 40 高 < 内容盒 140：padding 不该造出可滚动范围 */}
        <div
          testId="padded-fitting"
          style={{
            width: 240,
            height: 160,
            overflowY: 'scroll',
            padding: 10,
            flexShrink: 0,
          }}
        >
          <div testId="fitting-child" style={{ width: 100, height: 40, flexShrink: 0 }} />
        </div>
        {/* 内容 500 高 > 内容盒 180：真实范围 = 500 + 2*10 - 200 = 320 */}
        <div
          testId="padded-overflowing"
          style={{
            width: 240,
            height: 200,
            overflowY: 'scroll',
            padding: 10,
            flexShrink: 0,
          }}
        >
          <div style={{ width: 100, height: 500, flexShrink: 0 }} />
        </div>
        <div style={{ height: 900, flexShrink: 0 }} />
      </div>,
    )
    const outer = t.renderer.findByType('div').find((d) => d.testId === 'outer')!
    const fitting = t.renderer.findByType('div').find((d) => d.testId === 'padded-fitting')!
    const overflowing = t.renderer.findByType('div').find((d) => d.testId === 'padded-overflowing')!
    const child = t.renderer.findByType('div').find((d) => d.testId === 'fitting-child')!

    // 记录盒是元素自己的盒子：padding 只内缩子元素，不再整体偏移元素原点。
    expect(
      t.renderer
        .getElementBounds(fitting.id)!
        .slice(0, 2)
        .map((v) => v + 0),
    ).toEqual([0, 0])
    expect(
      t.renderer
        .getElementBounds(child.id)!
        .slice(0, 2)
        .map((v) => v + 0),
    ).toEqual([10, 10])

    // 曾经的幽灵滚动量恰等于 padding 总和（10*2 = 20），现在没有范围。
    t.renderer.scrollTo(fitting.id, -100000, -100000)
    expect(xOf(t, fitting.id)).toBe(0)
    expect(yOf(t, fitting.id)).toBe(0)

    // 溢出容器的范围没被这次修复改小。
    t.renderer.scrollTo(overflowing.id, 0, -100000)
    expect(yOf(t, overflowing.id)).toBe(-320)

    // 幽灵范围消失后，滚轮不再被内层吞掉：父层直接接管整段位移。
    wheel(t, 80, 60, 0, -50)
    expect(yOf(t, fitting.id)).toBe(0)
    expect(yOf(t, outer.id)).toBe(-50)
  } finally {
    t.unmount()
  }
})
