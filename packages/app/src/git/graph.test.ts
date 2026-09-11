/**
 * git/graph.test.ts — lane 状态机单测（docs/git-graph.md §5）。
 *
 * 全部手工推演断言（对照 Zed 语义）。输入顺序 = git log 顺序（新 → 旧）。
 * 覆盖：①线性 ②fork+merge（曲线段/颜色继承/checkout 接驳）③lane 复用
 * ④would_overlap 修正 ⑤增量一致性 ⑥颜色轮转 ⑦空 chunk / maxLanes 单调。
 */

import { describe, expect, test } from 'bun:test'

import type { GraphCommit } from './cli'
import { GitGraphData, firstParentChain } from './graph'

/** 快捷构造：sha 用短代号，parents 引用其它代号 */
function c(sha: string, parents: string[], refNames: string[] = []): GraphCommit {
  return {
    sha,
    parents,
    refNames,
    shortSha: sha.slice(0, 7),
    authorName: 'a',
    authorEmail: 'a@x',
    timestamp: 0,
    committerName: 'a',
    committerEmail: 'a@x',
    subject: `subject ${sha}`,
  }
}

describe('GitGraphData 线性历史', () => {
  test('全部 lane 0，直线段逐行接续', () => {
    const g = new GitGraphData()
    g.addCommits([c('c3', ['c2']), c('c2', ['c1']), c('c1', [])])
    expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(g.lines.map((l) => [l.childColumn, l.rowSpan])).toEqual([
      [0, [0, 1]],
      [0, [1, 2]],
    ])
    expect(g.lines[0].segments).toEqual([{ kind: 'straight', toRow: 1 }])
    expect(g.maxLanes).toBe(1)
  })
})

describe('GitGraphData fork + merge', () => {
  //   f(merge e,d)  row0
  //   e ← c          row1 lane0
  //   d ← b          row2 lane1
  //   c ← b          row3 lane0
  //   b ← a          row4 lane0（d、c 双线汇入）
  //   a              row5
  const batch = () => [
    c('f', ['e', 'd']),
    c('e', ['c']),
    c('d', ['b']),
    c('c', ['b']),
    c('b', ['a']),
    c('a', []),
  ]

  test('lane 分配 + merge 曲线 + checkout 接驳', () => {
    const g = new GitGraphData()
    g.addCommits(batch())
    expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 1, 0, 0, 0])
    expect(g.maxLanes).toBe(2)
    expect(g.lines).toHaveLength(6)

    // f→d 支线：从 f 的 col0 出发，row1 弯到 col1（merge），直线到 row2
    const dLine = g.lines[1]
    expect(dLine.childColumn).toBe(0)
    expect(dLine.rowSpan).toEqual([0, 2])
    expect(dLine.segments[0]).toEqual({
      kind: 'curve',
      toColumn: 1,
      onRow: 1,
      merge: true,
    })
    expect(dLine.segments[1]).toEqual({ kind: 'straight', toRow: 2 })
    // merge 支线色 = parent（d）所在 lane 的色 = lane1 缓存色
    expect(dLine.colorIdx).toBe(g.rows[2].colorIdx)

    // b 到达时 waiting 顺序 = push 顺序 [lane1(from d), lane0(from c)]：
    // d 侧直线在 row3 截断 + row4 checkout 曲线接到 lane0（lines[3]，先于 lane0 的 lines[4]）
    const bJoin = g.lines[3]
    expect(bJoin.childColumn).toBe(1)
    expect(bJoin.rowSpan).toEqual([2, 4])
    expect(bJoin.segments).toEqual([
      { kind: 'straight', toRow: 3 },
      { kind: 'curve', toColumn: 0, onRow: 4, merge: false },
    ])
  })

  test('增量分块 = 一次喂入（不变量 ⑤）', () => {
    const whole = new GitGraphData()
    whole.addCommits(batch())
    const split = new GitGraphData()
    split.addCommits(batch().slice(0, 3))
    split.addCommits([batch()[3]])
    split.addCommits(batch().slice(4))
    expect(split.rows).toEqual(whole.rows)
    expect(split.lines).toEqual(whole.lines)
    expect(split.maxLanes).toBe(whole.maxLanes)
  })

  test('merge 之后空 lane 被复用（lane1 不涨到 2）', () => {
    const g = new GitGraphData()
    g.addCommits(batch())
    g.addCommits([c('h', ['a', 'x']), c('x', [])])
    // h：lane0（a 已空）+ x 支线 = firstEmptyLaneIdx → 1（复用）
    const hRow = g.rows[6]
    expect(hRow.lane).toBe(0)
    const xLine = g.lines.find((l) => l.rowSpan[0] === 6 && l.childColumn === 0)
    expect(xLine?.segments[0]).toEqual({
      kind: 'curve',
      toColumn: 1,
      onRow: 7,
      merge: true,
    })
    expect(g.maxLanes).toBe(2)
  })
})

describe('GitGraphData would_overlap 修正', () => {
  test('merge 曲线落点被中间提交挡住时落回自己列', () => {
    //   h(merge g,e)  row0  lane0(g) + lane1(e 支线，curve from col0)
    //   g ← e          row1  lane0（挡在 e 的直线路径上）
    //   e ← d          row2  commit_lane = min([0,1]) = 0
    //   d              row3
    const g = new GitGraphData()
    g.addCommits([c('h', ['g', 'e']), c('g', ['e']), c('e', ['d']), c('d', [])])
    // h→e 支线：修正前 toColumn 是 UNSET，因 row1 的 g 占着 commit_lane(0)，
    // 曲线不能横穿 → 落回 lane1，再在 row2 checkout 到 lane0
    const eLine = g.lines.find((l) => l.rowSpan[0] === 0 && l.rowSpan[1] === 2)
    expect(eLine).toBeDefined()
    expect(eLine!.segments[0]).toEqual({
      kind: 'curve',
      toColumn: 1,
      onRow: 1,
      merge: true,
    })
    // Zed 语义：on_row < ending_row 时先补直线到 ending_row-1，再 checkout 接驳
    expect(eLine!.segments[1]).toEqual({ kind: 'straight', toRow: 1 })
    expect(eLine!.segments[2]).toEqual({
      kind: 'curve',
      toColumn: 0,
      onRow: 2,
      merge: false,
    })
  })

  test('无遮挡时不修正：曲线直接落到 commit lane', () => {
    //   h3(merge g3,e3) row0 lane0(g3) + lane1(e3 支线)
    //   e3 ← d3         row1 commit_lane = 1（等 e3 的只有支线自己）
    const g = new GitGraphData()
    g.addCommits([c('h3', ['g3', 'e3']), c('e3', ['d3']), c('g3', ['d3']), c('d3', [])])
    const e3Line = g.lines.find((l) => l.rowSpan[0] === 0 && l.rowSpan[1] === 1)
    expect(e3Line?.segments).toEqual([{ kind: 'curve', toColumn: 1, onRow: 1, merge: true }])
  })
})

describe('GitGraphData 颜色', () => {
  test('lane 色缓存 + 色板轮转取模', () => {
    const g = new GitGraphData(2)
    // 3 路分支：lane0/1/2 → 色 0/1/0（轮转）。支线在 parent 到达时才收尾，
    // 断言收尾后 3 条线的颜色（null 继承 parent 提交所在 lane 的色）
    g.addCommits([
      c('j', ['i1', 'i2', 'i3']),
      c('i1', ['r']),
      c('i2', ['r']),
      c('i3', ['r']),
      c('r', []),
    ])
    expect(g.maxLanes).toBe(3)
    expect(g.rows[0].colorIdx).toBe(0)
    const fromJ = g.lines.filter((l) => l.rowSpan[0] === 0)
    expect(fromJ).toHaveLength(3)
    // i1(lane0) 色漄0；i2(lane1) 色漄1；i3(lane2) 色漄 2%2=0
    expect(fromJ.map((l) => l.colorIdx).sort()).toEqual([0, 0, 1])
  })

  test('merge 支线收尾继承 parent 色（null → parentColor）', () => {
    const g = new GitGraphData()
    g.addCommits([c('f', ['e', 'd']), c('e', ['r']), c('d', ['r']), c('r', [])])
    const dLine = g.lines.find((l) => l.rowSpan[1] === 2)
    // d 在 lane1，支线色 null → 继承 d 的 commit 色（lane1 缓存色）
    expect(dLine?.colorIdx).toBe(g.rows[2].colorIdx)
  })
})

describe('GitGraphData 边界', () => {
  test('空 chunk 无副作用', () => {
    const g = new GitGraphData()
    g.addCommits([c('a', [])])
    g.addCommits([])
    expect(g.rows).toHaveLength(1)
    expect(g.maxLanes).toBe(1)
  })

  test('maxLanes 单调不减；clear 复位', () => {
    const g = new GitGraphData()
    g.addCommits([c('f', ['e', 'd']), c('e', []), c('d', [])])
    expect(g.maxLanes).toBe(2)
    g.addCommits([])
    expect(g.maxLanes).toBe(2)
    g.clear()
    expect(g.rows).toHaveLength(0)
    expect(g.lines).toHaveLength(0)
    expect(g.maxLanes).toBe(0)
  })

  test('firstParentChain：HEAD 第一父链含根；侧枝排除', () => {
    const commits = [
      c('f', ['e', 'd']),
      c('e', ['c']),
      c('d', ['b']),
      c('c', ['b']),
      c('b', ['a']),
      c('a', []),
    ]
    expect([...firstParentChain(commits)]).toEqual(['f', 'e', 'c', 'b', 'a'])
    expect(firstParentChain([])).toEqual(new Set())
  })

  test('根提交不延伸 lane（parents 空 → lane 空闲）', () => {
    const g = new GitGraphData()
    g.addCommits([c('b', ['a']), c('a', [])])
    expect(g.rows.map((r) => r.lane)).toEqual([0, 0])
    // a 是根：b→a 直线在 a 行收尾，之后 lane0 空闲
    expect(g.lines).toHaveLength(1)
    expect(g.lines[0].rowSpan).toEqual([0, 1])
  })
})
