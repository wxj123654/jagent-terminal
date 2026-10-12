/**
 * ui/PopoverSideEvents.test.tsx — 触发钮内嵌浮层的事件隔离。
 *
 * 菜单（deferred+occlude）挂在触发钮（行）内部时，点菜单项：
 * - 菜单项自身 onClick 触发；
 * - 不冒泡到行 onClick（否则「置顶」会同时激活行）；
 * - 点后菜单按调用方状态卸载。
 *
 * 状态文本放在菜单外，避免菜单卸载时把断言文本一起带走。
 *
 * 跑法：bun test src/__tests__/PopoverSideEvents.test.tsx
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

function Row() {
  const [rowClicks, setRowClicks] = useState(0)
  const [picked, setPicked] = useState(0)
  const [menuOpen, setMenuOpen] = useState(true)
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <text>{`row-clicks:${rowClicks} picked:${picked}`}</text>
      <div
        testId="row"
        onClick={() => setRowClicks((c) => c + 1)}
        style={{ marginLeft: 100, marginTop: 50, width: 200, height: 32 }}
      >
        {menuOpen ? (
          <Popover side="bottom" onClose={() => setMenuOpen(false)} testId="menu-row">
            <div
              testId="menu-item"
              onClick={() => {
                setPicked((p) => p + 1)
                setMenuOpen(false)
              }}
              style={{ width: 120, height: 30 }}
            >
              <text>item</text>
            </div>
          </Popover>
        ) : null}
      </div>
    </div>
  )
}

describe('Popover side 事件隔离', () => {
  test('点菜单项 → 只触发菜单项，不冒泡到行 onClick', () => {
    t.render(createElement(Row, { key: 'events' }))
    t.renderer.flush()
    const item = t.renderer.findByTestId('menu-item')!
    const b = t.renderer.getElementBounds(item.id)!
    t.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2, 0)
    t.renderer.flush()
    expect(t.renderer.getAllText()).toContain('row-clicks:0 picked:1')
  })
})

function KeyRow({ menuInitiallyOpen = true }: { menuInitiallyOpen?: boolean }) {
  const [rowKeys, setRowKeys] = useState(0)
  const [menuOpen, setMenuOpen] = useState(menuInitiallyOpen)
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <text>{`row-keys:${rowKeys} menu:${menuOpen ? 1 : 0}`}</text>
      <div
        testId="krow"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'enter') setRowKeys((c) => c + 1)
        }}
        style={{ marginLeft: 100, marginTop: 50, width: 200, height: 32 }}
      >
        {menuOpen ? (
          <Popover side="bottom" onClose={() => setMenuOpen(false)} testId="kmenu" autoFocus>
            <div testId="kmenu-item" tabIndex={0} style={{ width: 120, height: 30 }}>
              <text>item</text>
            </div>
          </Popover>
        ) : null}
      </div>
    </div>
  )
}

describe('Popover side 键盘隔离', () => {
  test('对照：焦点在行本身时 Enter 确实触发行 onKeyDown', () => {
    t.render(createElement(KeyRow, { key: 'keys-ctrl', menuInitiallyOpen: false }))
    t.renderer.flush()
    const row = t.renderer.findByTestId('krow')!
    t.renderer.focusElement(row.id)
    t.renderer.flush()
    t.renderer.nativeSimulateKeyDown(row.id, 'enter')
    t.renderer.flush()
    expect(t.renderer.getAllText()).toContain('row-keys:1 menu:0')
  })

  test('菜单内 Enter 会冒泡到行 onKeyDown（框架事实，须由调用方守卫）', () => {
    t.render(createElement(KeyRow, { key: 'keys' }))
    t.renderer.flush()
    const menu = t.renderer.findByTestId('kmenu')!
    t.renderer.focusElement(menu.id)
    t.renderer.flush()
    t.renderer.nativeSimulateKeyDown(menu.id, 'enter')
    t.renderer.flush()
    // gpuix 不阻断冒泡：菜单内 Enter 会让行 onKeyDown 收到一次
    expect(t.renderer.getAllText()).toContain('row-keys:1 menu:1')
  })
})

function MenuBtn() {
  const [opens, setOpens] = useState(0)
  const [picked, setPicked] = useState(0)
  const [open, setOpen] = useState(false)
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <text>{`opens:${opens} picked:${picked} open:${open ? 1 : 0}`}</text>
      <div style={{ position: 'relative', marginLeft: 100, marginTop: 50, width: 200, height: 32 }}>
        <div
          testId="mbtn"
          tabIndex={0}
          onClick={() => {
            setOpens((c) => c + 1)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            // 守卫：菜单开着时，菜单内按键冒泡上来不得再开菜单
            if (open) return
            if (e.key === 'enter' || e.key === 'space') {
              setOpens((c) => c + 1)
              setOpen(true)
            }
          }}
          style={{ marginLeft: 150, marginTop: 4, width: 22, height: 22 }}
        >
          {open ? (
            <Popover
              side="bottom"
              align="end"
              onClose={() => setOpen(false)}
              testId="mmenu"
              autoFocus
            >
              <div
                testId="mmenu-item"
                tabIndex={0}
                onClick={() => {
                  setPicked((c) => c + 1)
                  setOpen(false)
                }}
                style={{ width: 120, height: 30 }}
              >
                <text>item</text>
              </div>
            </Popover>
          ) : null}
        </div>
      </div>
    </div>
  )
}

describe('Popover 按钮内嵌事件', () => {
  test('菜单项点击：不冒泡到「…」钮 onClick（不应再次开菜单）', () => {
    t.render(createElement(MenuBtn, { key: 'mbtn-click' }))
    t.renderer.flush()
    const btn = t.renderer.getElementBounds(t.renderer.findByTestId('mbtn')!.id)!
    t.renderer.nativeSimulateClick(btn.x + btn.width / 2, btn.y + btn.height / 2, 0)
    t.renderer.flush()
    expect(t.renderer.getAllText()).toContain('opens:1 picked:0 open:1')
    const item = t.renderer.getElementBounds(t.renderer.findByTestId('mmenu-item')!.id)!
    t.renderer.nativeSimulateClick(item.x + item.width / 2, item.y + item.height / 2, 0)
    t.renderer.flush()
    expect(t.renderer.getAllText()).toContain('opens:1 picked:1 open:0')
  })

  test('菜单内 Enter：不冒泡到「…」钮 onKeyDown（不应再次开菜单）', () => {
    t.render(createElement(MenuBtn, { key: 'mbtn-key' }))
    t.renderer.flush()
    const btn = t.renderer.findByTestId('mbtn')!
    t.renderer.focusElement(btn.id)
    t.renderer.flush()
    t.renderer.nativeSimulateKeyDown(btn.id, 'enter')
    t.renderer.flush()
    expect(t.renderer.getAllText()).toContain('opens:1 picked:0 open:1')
    const menu = t.renderer.findByTestId('mmenu-item')!
    t.renderer.focusElement(menu.id)
    t.renderer.flush()
    t.renderer.nativeSimulateKeyDown(menu.id, 'enter')
    t.renderer.flush()
    // 守卫生效：冒泡上来的 Enter 不再把 opens 加到 2
    expect(t.renderer.getAllText()).toContain('opens:1 picked:0 open:1')
  })
})
