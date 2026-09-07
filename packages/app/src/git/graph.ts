/**
 * git/graph.ts — lane 分配状态机（docs/git-graph.md §2.2）。
 *
 * Zed `git_ui/src/git_graph.rs` 的 `GraphData::add_commits` +
 * `LaneState::to_commit_lines` 的 TS 同构移植（pin 8b94def）。语义保持一致：
 *  - 输入顺序 = git log 顺序（新 → 旧，HEAD 在前）；
 *  - commit_lane = 等待本 sha 的活跃 lane 最小值，否则复用/新开空 lane；
 *  - parent0 继承本 lane（直线段），parent1.. 各开一条 merge 曲线支线；
 *  - 支线收尾时按 would_overlap 修正曲线落点，避免穿越本 lane 上的提交；
 *  - lane 颜色按 lane 下标缓存、色板轮转。
 *
 * 零 IO（输入是已解析的 GraphCommit），全部行为由 graph.test.ts 锁定。
 */

import type { GraphCommit } from './cli'

/** Zed usize::MAX 的「未定」哨兵 */
export const UNSET = Number.MAX_SAFE_INTEGER

/** 直线段：垂直线覆盖 [产生行, toRow]；曲线段：在 onRow 行从上一位置弯到 toColumn */
export type LaneSegment =
  | { kind: 'straight'; toRow: number }
  | { kind: 'curve'; toColumn: number; onRow: number; merge: boolean }

/** 一条完整的连接线（child 列出发 → parent 列到达），行区间为闭区间 */
export interface CommitLine {
  childColumn: number
  rowSpan: [startRow: number, endRow: number]
  colorIdx: number
  segments: LaneSegment[]
}

export interface GraphRow {
  commit: GraphCommit
  lane: number
  colorIdx: number
}

interface ActiveLane {
  parent: string
  child: string
  /** null = merge 支线（收尾时继承 parent 提交所在 lane 的色） */
  color: number | null
  startingRow: number
  startingCol: number
  destinationColumn: number | null
  segments: LaneSegment[]
}

/** 默认 = GRAPH_LANE_COLORS.length（tokens.ts）；可注入小色板测轮转 */
export class GitGraphData {
  readonly rows: GraphRow[] = []
  readonly lines: CommitLine[] = []
  /** 行号 → 覆盖该行的线（渲染时按行取用，避免全量扫 lines） */
  readonly linesByRow = new Map<number, CommitLine[]>()
  maxLanes = 0

  private laneStates: (ActiveLane | null)[] = []
  private laneColors = new Map<number, number>()
  private parentToLanes = new Map<string, number[]>()
  private nextColor = 0

  constructor(private readonly paletteSize = 8) {}

  clear(): void {
    this.rows.length = 0
    this.lines.length = 0
    this.linesByRow.clear()
    this.laneStates.length = 0
    this.laneColors.clear()
    this.parentToLanes.clear()
    this.nextColor = 0
    this.maxLanes = 0
  }

  /** 流式增量追加（可多次调用；分块喂入与一次喂入结果一致——测试不变量 ⑤） */
  addCommits(chunk: readonly GraphCommit[]): void {
    for (const commit of chunk) {
      const commitRow = this.rows.length
      const waiting = this.parentToLanes.get(commit.sha)
      const commitLane = waiting ? Math.min(...waiting) : this.firstEmptyLaneIdx()
      const commitColor = this.getLaneColor(commitLane)

      // ① 收尾：所有等着本 sha 的 lane 生成 CommitLine（含 merge 曲线重叠修正）
      if (waiting) {
        this.parentToLanes.delete(commit.sha)
        for (const laneColumn of waiting) {
          const state = this.laneStates[laneColumn]
          const first = state?.segments[0]
          if (state && first?.kind === 'curve' && first.merge && laneColumn !== commitLane) {
            const curveRow = state.startingRow + 1
            const wouldOverlap =
              curveRow < commitRow &&
              this.rows.some((r, i) => i >= curveRow && i < commitRow && r.lane === commitLane)
            if (wouldOverlap) first.toColumn = laneColumn
          }
          const line = this.laneToCommitLine(laneColumn, commitRow, commitLane, commitColor)
          if (line) {
            this.lines.push(line)
            // 索引到覆盖的每一行（闭区间）
            for (let r = line.rowSpan[0]; r <= line.rowSpan[1]; r++) {
              const arr = this.linesByRow.get(r)
              if (arr) arr.push(line)
              else this.linesByRow.set(r, [line])
            }
          }
        }
      }

      // ② 开支：parent0 继承本 lane（直线）；parent1.. 各开 merge 曲线支线
      if (commit.parents.length > 0) {
        const p0 = commit.parents[0]
        this.laneStates[commitLane] = {
          parent: p0,
          child: commit.sha,
          color: commitColor,
          startingRow: commitRow,
          startingCol: commitLane,
          destinationColumn: null,
          segments: [{ kind: 'straight', toRow: UNSET }],
        }
        this.pushParentLane(p0, commitLane)
        for (const p of commit.parents.slice(1)) {
          const nl = this.firstEmptyLaneIdx()
          this.laneStates[nl] = {
            parent: p,
            child: commit.sha,
            color: null,
            startingRow: commitRow,
            startingCol: commitLane,
            destinationColumn: null,
            segments: [{ kind: 'curve', toColumn: UNSET, onRow: UNSET, merge: true }],
          }
          this.pushParentLane(p, nl)
        }
      }

      this.maxLanes = Math.max(this.maxLanes, this.laneStates.length)
      this.rows.push({ commit, lane: commitLane, colorIdx: commitColor })
    }
  }

  // ── 内部 ─────────────────────────────────────────────────────────

  private firstEmptyLaneIdx(): number {
    const i = this.laneStates.findIndex((s) => s === null)
    if (i >= 0) return i
    this.laneStates.push(null)
    return this.laneStates.length - 1
  }

  private getLaneColor(laneIdx: number): number {
    let c = this.laneColors.get(laneIdx)
    if (c === undefined) {
      c = this.nextColor
      this.nextColor = (this.nextColor + 1) % this.paletteSize
      this.laneColors.set(laneIdx, c)
    }
    return c
  }

  private pushParentLane(parent: string, lane: number): void {
    const arr = this.parentToLanes.get(parent)
    if (arr) arr.push(lane)
    else this.parentToLanes.set(parent, [lane])
  }

  /**
   * lane 收尾（parent 提交到达，行号 = endingRow）。对齐 Zed to_commit_lines：
   * 只 finalize 最后一段——直线的「∞」截断到 ending_row；曲线的 on_row/to_column
   * 落定，必要时补一段直线 + checkout 曲线接驳到 parent 所在列。
   */
  private laneToCommitLine(
    laneColumn: number,
    endingRow: number,
    parentColumn: number,
    parentColor: number,
  ): CommitLine | null {
    const state = this.laneStates[laneColumn]
    if (!state) return null
    this.laneStates[laneColumn] = null

    const finalDestination = state.destinationColumn ?? parentColumn
    const finalColor = state.color ?? parentColor
    const segments = state.segments
    const last = segments[segments.length - 1]

    if (last && last.kind === 'straight' && last.toRow === UNSET) {
      if (finalDestination !== laneColumn) {
        last.toRow = endingRow - 1
        const checkout: LaneSegment = {
          kind: 'curve',
          toColumn: finalDestination,
          onRow: endingRow,
          merge: false,
        }
        if (last.toRow === state.startingRow) segments[segments.length - 1] = checkout
        else segments.push(checkout)
      } else {
        last.toRow = endingRow
      }
    } else if (last && last.kind === 'curve') {
      if (last.onRow === UNSET) {
        if (last.toColumn === UNSET) last.toColumn = finalDestination
        if (last.merge) {
          last.onRow = state.startingRow + 1
          if (last.onRow < endingRow) {
            if (last.toColumn !== finalDestination) {
              segments.push({ kind: 'straight', toRow: endingRow - 1 })
              segments.push({
                kind: 'curve',
                toColumn: finalDestination,
                onRow: endingRow,
                merge: false,
              })
            } else {
              segments.push({ kind: 'straight', toRow: endingRow })
            }
          } else if (last.toColumn !== finalDestination) {
            segments.push({
              kind: 'curve',
              toColumn: finalDestination,
              onRow: endingRow,
              merge: false,
            })
          }
        } else {
          last.onRow = endingRow
          if (last.toColumn !== finalDestination) {
            segments.push({ kind: 'straight', toRow: endingRow })
            segments.push({
              kind: 'curve',
              toColumn: finalDestination,
              onRow: endingRow,
              merge: false,
            })
          }
        }
      } else if (last.onRow < endingRow) {
        if (last.toColumn !== finalDestination) {
          segments.push({ kind: 'straight', toRow: endingRow - 1 })
          segments.push({
            kind: 'curve',
            toColumn: finalDestination,
            onRow: endingRow,
            merge: false,
          })
        } else {
          segments.push({ kind: 'straight', toRow: endingRow })
        }
      } else if (last.toColumn !== finalDestination) {
        segments.push({
          kind: 'curve',
          toColumn: finalDestination,
          onRow: endingRow,
          merge: false,
        })
      }
    }

    return {
      childColumn: state.startingCol,
      rowSpan: [state.startingRow, endingRow],
      colorIdx: finalColor,
      segments,
    }
  }
}

/** HEAD（log 首行）沿第一父链走到根。侧枝（merge 第二父及祖先）不在集合内 → mute。 */
export function firstParentChain(commits: readonly GraphCommit[]): Set<string> {
  const chain = new Set<string>()
  if (commits.length === 0) return chain
  const bySha = new Map(commits.map((c) => [c.sha, c]))
  let sha: string | undefined = commits[0]!.sha
  while (sha && !chain.has(sha)) {
    chain.add(sha)
    sha = bySha.get(sha)?.parents[0]
  }
  return chain
}
