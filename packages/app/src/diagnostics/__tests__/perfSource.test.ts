/**
 * diagnostics/perfSource.test.ts — PerfSource 采样数学：差分 fps/paintAvg/
 * cpu、窗内直方图读数、读后清窗（reset 调用节奏）。
 */

import { describe, expect, test } from 'bun:test'

import { createPerfSource, type PaintPerfSnapshot } from '../perfSource'

function fakeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

function fakeRenderer() {
  let frames = 0
  let p90 = 0
  let max = 0
  const resets: number[] = []
  return {
    stats: { set: (f: number, p: number, m: number) => ((frames = f), (p90 = p), (max = m)) },
    resets,
    renderer: {
      getDebugFrameOverlayStats: () => ({ frames, samples: frames, p90Ms: p90, maxMs: max }),
      resetDebugFrameOverlayStats: () => {
        resets.push(frames)
        frames = 0
        p90 = 0
        max = 0
      },
    },
  }
}

function paintSeq(snaps: PaintPerfSnapshot[]) {
  let i = 0
  return () => snaps[Math.min(i++, snaps.length - 1)]
}

describe('createPerfSource', () => {
  test('构造即建基线（清启动期样本）；每次 sample 差分', () => {
    const clock = fakeClock()
    const { renderer, stats } = fakeRenderer()
    stats.set(100, 9, 50) // 启动期样本——构造时 reset 清掉
    const src = createPerfSource(renderer, {
      takePaintPerf: paintSeq([
        { count: 10, totalNs: 5e6, maxNs: 1e6 },
        { count: 10, totalNs: 5e6, maxNs: 1e6 },
        { count: 14, totalNs: 13e6, maxNs: 4e6 },
      ]),
      now: clock.now,
      cpuUsage: () => ({ user: 0, system: 0 }),
      memoryUsage: () => ({ rss: 512 * 1048576 }) as NodeJS.MemoryUsage,
    })
    const s0 = src.sample() // 首窗：无新帧 → 0
    expect(s0.fps).toBe(0)
    expect(s0.drawP90Ms).toBe(0)
    clock.advance(500)
    stats.set(4, 3, 8) // 本窗 4 帧
    const s1 = src.sample()
    expect(s1.fps).toBeCloseTo(8) // 4 帧 / 0.5s
    expect(s1.drawP90Ms).toBe(3)
    expect(s1.drawMaxMs).toBe(8)
    expect(s1.paintAvgMs).toBeCloseTo(2) // (13-5)ms / (14-10) 次
    expect(s1.paintMaxMs).toBe(4)
    expect(s1.memMB).toBe(512)
  })

  test('每窗读后即 reset（窗内直方图语义）', () => {
    const { renderer, stats, resets } = fakeRenderer()
    const src = createPerfSource(renderer, {
      takePaintPerf: paintSeq([{ count: 0, totalNs: 0, maxNs: 0 }]),
    })
    stats.set(5, 1, 2)
    src.sample()
    stats.set(7, 1, 2)
    src.sample()
    expect(resets).toEqual([0, 5, 7]) // 构造基线 1 次 + 每次 sample 1 次
  })

  test('窗内无新帧时 draw 读数为 0', () => {
    const clock = fakeClock()
    const { renderer } = fakeRenderer()
    const src = createPerfSource(renderer, {
      takePaintPerf: paintSeq([{ count: 0, totalNs: 0, maxNs: 0 }]),
      now: clock.now,
    })
    src.sample()
    clock.advance(500)
    const s = src.sample()
    expect(s.fps).toBe(0)
    expect(s.drawP90Ms).toBe(0)
    expect(s.drawMaxMs).toBe(0)
  })
})
