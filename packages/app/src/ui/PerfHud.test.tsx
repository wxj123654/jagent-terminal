/**
 * ui/PerfHud.test.tsx — 性能 HUD 测试面。
 *
 * 1. 数据面：fake PerfSource（快照序列）→ 初始渲染取首样；
 *    advanceTime 驱动 500ms 轮询 → 文本随差分快照更新。
 * 2. 布局面（win 组合）：trailing HUD 落在窗口控制三键左侧、
 *    不吃 close 的命中区（pointerEvents none）。
 *
 * 跑法：bun test packages/app/src/ui/PerfHud.test.tsx
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { TitleBar } from '../plane/TitleBar'
import { PerfHud, type PerfSample, type PerfSource } from './PerfHud'

let t: TestRoot

beforeAll(() => {
  t = createTestRoot({ width: 900, height: 700 })
})

afterAll(() => {
  t?.unmount()
})

const SAMPLE_A: PerfSample = {
  fps: 0,
  drawP90Ms: 0,
  drawMaxMs: 0,
  paintAvgMs: 0,
  paintMaxMs: 0,
  cpuPct: 1.2,
  memMB: 88,
}
const SAMPLE_B: PerfSample = {
  fps: 60,
  drawP90Ms: 4.2,
  drawMaxMs: 11.8,
  paintAvgMs: 2.5,
  paintMaxMs: 9.8,
  cpuPct: 12.4,
  memMB: 92,
}

function fakeSource(seq: PerfSample[]): { source: PerfSource; calls: () => number } {
  let i = 0
  return {
    source: {
      sample: () => {
        const v = seq[Math.min(i, seq.length - 1)]!
        i += 1
        return v
      },
    },
    calls: () => i,
  }
}

/** 轮询断言：advanceTime 驱动 fake clock（interval），真实 setTimeout 让出（React 提交） */
async function untilText(substr: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  for (;;) {
    t.renderer.advanceTime(80)
    if (t.renderer.getAllText().some((s) => s.includes(substr))) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timeout waiting HUD text: ${substr}; got ${JSON.stringify(t.renderer.getAllText())}`,
      )
    }
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('PerfHud · 数据面', () => {
  test('初始渲染取首样（空闲态 0fps）；500ms 轮询后更新为差分快照', async () => {
    const { source, calls } = fakeSource([SAMPLE_A, SAMPLE_B])
    t.render(createElement(PerfHud, { source }))
    t.renderer.flush()
    expect(calls()).toBe(1)

    // 初始：空闲态（0fps / draw 0 / cpu 1% / mem 88MB）
    await untilText('0fps')
    expect(t.renderer.getAllText().some((s) => s.includes('draw 0.0/0.0ms'))).toBe(true)
    expect(t.renderer.getAllText().some((s) => s.includes('88MB'))).toBe(true)

    // 轮询到 B：整帧 fps / draw p90/max / term 均值与峰值都刷新
    await untilText('60fps')
    expect(t.renderer.getAllText().some((s) => s.includes('draw 4.2/11.8ms'))).toBe(true)
    expect(t.renderer.getAllText().some((s) => s.includes('term 2.5/9.8ms'))).toBe(true)
    expect(calls()).toBeGreaterThanOrEqual(2)
  })

  test('卸载即停采样（无泄漏轮询）', async () => {
    const { source, calls } = fakeSource([SAMPLE_A])
    t.render(createElement(PerfHud, { source }))
    t.renderer.flush()
    const n = calls()
    t.render(createElement('div', null)) // 卸载 HUD
    t.renderer.advanceTime(2000)
    await new Promise((r) => setTimeout(r, 30))
    expect(calls()).toBe(n) // effect cleanup 清掉了 interval
  })
})

describe('PerfHud · win 布局组合', () => {
  test('HUD 在三键左侧且不侵占 close 命中区', () => {
    t.render(
      createElement(TitleBar, {
        chipLabel: 'j-agent',
        platform: 'win',
        trailing: createElement(PerfHud, { source: fakeSource([SAMPLE_B]).source }),
      }),
    )
    t.renderer.flush()

    const hud = t.renderer.findByTestId('perf-hud')
    expect(hud).toBeDefined()
    const hudB = t.renderer.getElementBounds(hud!.id)!
    const close = t.renderer.findByTestId('titlebar-close')!
    const closeB = t.renderer.getElementBounds(close.id)!

    // HUD 完整落在 close 左侧（右缘 < close 左缘），且在同一顶栏高度带
    expect(hudB[0] + hudB[2]).toBeLessThanOrEqual(closeB[0])
    expect(hudB[1]).toBeGreaterThanOrEqual(0)
  })
})
