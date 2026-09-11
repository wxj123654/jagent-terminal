/**
 * git/graphSvg.test.ts — 行内几何（docs/git-graph.md §5：path 快照面）。
 *
 * 用 fork+merge 已知形状断言 path d 与圆点位置；行数/颜色分组数量。
 */

import { describe, expect, test } from 'bun:test'

import { parseLogLine } from './cli'
import { GitGraphData } from './graph'
import {
  buildGapGraphics,
  buildRowGraphics,
  graphColumnWidth,
  laneX,
  ROW_HEIGHT,
  CIRCLE_RADIUS,
} from './graphSvg'

describe('graphColumnWidth / laneX', () => {
  test('最小 6 lane；maxLanes 增长跟随', () => {
    expect(graphColumnWidth(2)).toBe(6 * 13 + 6)
    expect(graphColumnWidth(8)).toBe(8 * 13 + 6)
  })

  test('laneX：lane0 中心 = 3 + 6.5', () => {
    expect(laneX(0)).toBe(9.5)
    expect(laneX(1)).toBe(22.5)
  })
})

describe('buildRowGraphics', () => {
  // f(merge e,d) / e←c / d←b / c←b / b←a / a —— graph.test.ts 同形状
  const build = () => {
    const g = new GitGraphData()
    g.addCommits([
      parseLogLine(
        [
          'f'.repeat(40),
          ['e'.repeat(40), 'd'.repeat(40)].join(' '),
          '',
          'fffffff',
          'a',
          'a@x',
          '0',
          'a',
          'a@x',
          'f',
        ].join('\x00'),
      )!,
      parseLogLine(
        ['e'.repeat(40), 'c'.repeat(40), '', 'eeeeeee', 'a', 'a@x', '0', 'a', 'a@x', 'e'].join(
          '\x00',
        ),
      )!,
      parseLogLine(
        ['d'.repeat(40), 'b'.repeat(40), '', 'ddddddd', 'a', 'a@x', '0', 'a', 'a@x', 'd'].join(
          '\x00',
        ),
      )!,
      parseLogLine(
        ['c'.repeat(40), 'b'.repeat(40), '', 'ccccccc', 'a', 'a@x', '0', 'a', 'a@x', 'c'].join(
          '\x00',
        ),
      )!,
      parseLogLine(
        ['b'.repeat(40), 'a'.repeat(40), '', 'bbbbbbb', 'a', 'a@x', '0', 'a', 'a@x', 'b'].join(
          '\x00',
        ),
      )!,
      parseLogLine(
        ['a'.repeat(40), '', '', 'aaaaaaa', 'a', 'a@x', '0', 'a', 'a@x', 'a'].join('\x00'),
      )!,
    ])
    return g
  }

  test('row0（f）：圆点在 lane0 + 一条 merge 曲线起点的下半竖线', () => {
    const g = build()
    const pieces = buildRowGraphics({
      row: 0,
      lines: g.linesByRow.get(0) ?? [],
      commitLane: g.rows[0].lane,
      commitColorIdx: g.rows[0].colorIdx,
      maxLanes: g.maxLanes,
    })
    // lane0 直线（f→e）+ lane1 支线下半竖线 + 圆点 = 3 组
    expect(pieces).toHaveLength(3)
    // f→e 直线在 row0 是起点行：M lane0 13 V 26
    const line0 = pieces.find((p) =>
      p.source.includes(`M ${laneX(0)} ${ROW_HEIGHT / 2} V ${ROW_HEIGHT}`),
    )
    expect(line0).toBeDefined()
    expect(line0!.colorIdx).toBe(0)
    // f→d 支线起点行：下半竖线在 col0（下一行才弯到 col1）
    const branch = pieces.find((p) => p.colorIdx === 1)
    expect(branch?.source).toContain(`M ${laneX(0)} ${ROW_HEIGHT / 2} V ${ROW_HEIGHT}`)
    // 圆点：cx = lane0 中心，cy = 中线
    const dot = pieces[pieces.length - 1]
    expect(dot.source).toContain(`<circle cx="${laneX(0)}" cy="${ROW_HEIGHT / 2}"`)
  })

  test('row1（e）：f→e 直线收尾（上半竖线）+ 支线 merge 弧到 col1', () => {
    const g = build()
    const pieces = buildRowGraphics({
      row: 1,
      lines: g.linesByRow.get(1) ?? [],
      commitLane: g.rows[1].lane,
      commitColorIdx: g.rows[1].colorIdx,
      maxLanes: g.maxLanes,
    })
    // 支线（色1）在 row1 弯：M x0 0 C x0 6.5, x1 6.5, x1 13，再从中线续下半竖线
    const arc = pieces.find((p) => p.colorIdx === 1)
    expect(arc).toBeDefined()
    expect(arc!.source).toContain(
      `M ${laneX(0)} 0 C ${laneX(0)} 6.5, ${laneX(1)} 6.5, ${laneX(1)} 13`,
    )
    expect(arc!.source).toContain(`M ${laneX(1)} ${ROW_HEIGHT / 2} V ${ROW_HEIGHT}`)
    // 回归：弧已占上半，禁止再从 y=0 画 to 列竖线（否则合并点旁冒 orphan stub）
    expect(arc!.source).not.toContain(`M ${laneX(1)} 0 V`)
  })

  test('选中行 extraBelow：下半竖线穿过 CDV 高度；圆点仍在 26 中线', () => {
    const g = build()
    const extra = 224
    const pieces = buildRowGraphics({
      row: 0,
      lines: g.linesByRow.get(0) ?? [],
      commitLane: g.rows[0].lane,
      commitColorIdx: g.rows[0].colorIdx,
      maxLanes: g.maxLanes,
      extraBelow: extra,
      hollow: true,
    })
    const h = ROW_HEIGHT + extra
    expect(pieces.some((p) => p.source.includes(`height="${h}"`))).toBe(true)
    expect(pieces.some((p) => p.source.includes(`V ${h}`))).toBe(true)
    const dot = pieces[pieces.length - 1]
    expect(dot.source).toContain(
      `<circle cx="${laneX(0)}" cy="${ROW_HEIGHT / 2}" r="${CIRCLE_RADIUS}" fill="none"`,
    )
  })

  test('buildGapGraphics：详情行只画穿过的竖线，无圆点', () => {
    const g = build()
    const pieces = buildGapGraphics({
      afterRow: 0,
      lines: g.linesByRow.get(0) ?? [],
      maxLanes: g.maxLanes,
      height: 200,
    })
    expect(pieces.length).toBeGreaterThan(0)
    expect(pieces.every((p) => !p.source.includes('<circle'))).toBe(true)
    expect(pieces.some((p) => p.source.includes(`V 200`))).toBe(true)
    expect(pieces[0]!.source).toContain(`height="200"`)
  })

  test('每个 piece 都是合法单色 svg（stroke=currentColor）', () => {
    const g = build()
    for (let r = 0; r < g.rows.length; r++) {
      const pieces = buildRowGraphics({
        row: r,
        lines: g.linesByRow.get(r) ?? [],
        commitLane: g.rows[r].lane,
        commitColorIdx: g.rows[r].colorIdx,
        maxLanes: g.maxLanes,
      })
      for (const p of pieces) {
        expect(p.source).toContain('stroke="currentColor"')
        expect(p.source).toContain(`viewBox="0 0 ${graphColumnWidth(g.maxLanes)} ${ROW_HEIGHT}"`)
      }
    }
  })
})
