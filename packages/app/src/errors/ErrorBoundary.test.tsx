/**
 * errors/ErrorBoundary.test.tsx — 区域隔离（方案 A 第 3 组件）。
 *
 * 覆盖：子树 render 抛错 → pane fallback + 总线收到 kind=render ·
 * 重试按钮换 key 重挂载恢复 · root fallback 形态 · 健康子树直通。
 * TestRenderer（@gpuix/react/testing）——GPUIX 宿主下 class boundary
 * 的行为与真窗口一致（react-reconciler 核心机制）。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { useState } from 'react'

import { listErrors, resetErrorBusForTest } from './bus'
import { ErrorBoundary } from './ErrorBoundary'

afterEach(() => resetErrorBusForTest())

let t: TestRoot

function clickCenter(testId: string) {
  const el = t.renderer.findByTestId(testId)
  if (!el) throw new Error(`element not found: ${testId}`)
  const b = t.renderer.getElementBounds(el.id)!
  t.renderer.nativeSimulateClick(b[0]! + b[2]! / 2, b[1]! + b[3]! / 2, 0)
  t.renderer.flush()
}

function Boom({ message }: { message: string }): null {
  // render 期抛错（boundary 的触发面）；返回值不可达
  throw new Error(message)
}

function Counter() {
  const [n] = useState(7)
  return <text testId="healthy">{`n=${n}`}</text>
}

describe('ErrorBoundary', () => {
  test('pane 面抛错 → 区域 fallback + 总线 kind=render', () => {
    t = createTestRoot()
    t.render(
      <ErrorBoundary area="pane">
        <Boom message="surface exploded" />
      </ErrorBoundary>,
    )
    expect(t.renderer.findByTestId('error-boundary-pane')).toBeTruthy()
    const errs = listErrors()
    expect(errs).toHaveLength(1)
    expect(errs[0]!.kind).toBe('render')
    expect(errs[0]!.context).toBe('boundary:pane')
    expect(errs[0]!.message).toContain('surface exploded')
  })

  test('重试 → key 换新重挂载，恢复后的子树存活', () => {
    t = createTestRoot()
    let fail = true
    function Flaky() {
      if (fail) throw new Error('flaky')
      return <text testId="recovered">ok</text>
    }
    t.render(
      <ErrorBoundary area="pane">
        <Flaky />
      </ErrorBoundary>,
    )
    expect(t.renderer.findByTestId('error-boundary-pane')).toBeTruthy()
    fail = false
    clickCenter('error-boundary-pane-retry')
    expect(t.renderer.findByTestId('recovered')).toBeTruthy()
  })

  test('root fallback 全屏形态', () => {
    t = createTestRoot()
    t.render(
      <ErrorBoundary area="root">
        <Boom message="root dead" />
      </ErrorBoundary>,
    )
    expect(t.renderer.findByTestId('error-boundary-root')).toBeTruthy()
    expect(t.renderer.findByTestId('error-boundary-retry')).toBeTruthy()
  })

  test('settings 面独立 area 标注', () => {
    t = createTestRoot()
    t.render(
      <ErrorBoundary area="settings">
        <Boom message="settings dead" />
      </ErrorBoundary>,
    )
    expect(t.renderer.findByTestId('error-boundary-settings')).toBeTruthy()
    expect(listErrors()[0]!.context).toBe('boundary:settings')
  })

  test('健康子树直通渲染', () => {
    t = createTestRoot()
    t.render(
      <ErrorBoundary area="pane">
        <Counter />
      </ErrorBoundary>,
    )
    // TestElement.text 对 JSX children 形态的 <text> 不填充（getAllText
    // 走 native 树）；断言内容存在 + 无错误入总线。
    expect(t.renderer.getAllText()).toContain('n=7')
    expect(listErrors()).toEqual([])
  })
})
