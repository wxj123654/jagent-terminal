/**
 * packages/app/bench/git-graph-ablation.bench.tsx — git graph 行渲染消融基准。
 *
 * 目的：把「滚动期整帧 draw ≈7ms」分解到行内容的构成项：
 *   full    完整复刻 GraphRowView（svg pieces ×N + 4 text + badges + hover）
 *   nosvg   去掉 svg pieces（Graph 列空白，其余不动）
 *   notext  去掉 4 个 text（保留 svg + badges）
 *   bare    空行容器（仅行 div + 内部布局 div，无内容元素）
 *   sametext full 结构但所有 text 内容为同一字符串——区分 shaping 缓存
 *           miss（逐字符串重新 shape）与元素/paint 固有成本
 *   half    full 但窗口高 380（行数减半；滚轮 y 跟随窗口）
 *
 * 数据源与真实 bench 完全一致：真实 store mount bench 仓库后的
 * rows/linesByRow 快照 + buildRowGraphics 同款几何。
 *
 * 用法：
 *   ABL=full bun packages/app/bench/git-graph-ablation.bench.tsx <repoDir>
 */

import { createRenderer, render, startFrameLoop } from '@gpuix/react'

import { COLORS, FONT } from '@jagent/ui'
import { parseRefNames, relativeTime } from '../src/git/format'
import type { GraphRow } from '../src/git/graph'
import { buildRowGraphics, graphColumnWidth, ROW_HEIGHT } from '../src/git/graphSvg'
import { GRAPH_LANE_COLORS } from '../src/tokens'
import { createGitGraphStore } from '../src/git/store'

const SAMPLE_MS = 500
const SCROLL_STEP_PX = 60
const SCROLL_TICK_MS = 16
const MODE = process.env.ABL ?? 'full'
const WIN_H = MODE === 'half' ? 380 : 760
/** 滚轮命中点：half 窗口矮，y 跟随窗口高度 */
const WHEEL_Y = MODE === 'half' ? 200 : 400

type WindowStat = {
  phase: string
  samples: number
  p90Ms: number
  maxMs: number
  framesTotal: number
}

// ── 行复刻（结构与 GraphRowView 等价；内容开关由 MODE 控制） ──────────

function AblationRow({
  row,
  index,
  lines,
  maxLanes,
  rowWidth,
}: {
  row: GraphRow
  index: number
  lines: readonly import('../src/git/graph').CommitLine[]
  maxLanes: number
  rowWidth: number
}) {
  const withSvg = MODE !== 'nosvg' && MODE !== 'bare'
  const withText = MODE !== 'notext' && MODE !== 'bare'
  /** sametext：所有内容字符串同一个 → text layout/shaping 缓存应全命中 */
  const same = MODE === 'sametext'
  const T = (s: string) => (same ? 'bench text' : s)
  const width = graphColumnWidth(maxLanes)
  const pieces = withSvg
    ? buildRowGraphics({
        row: index,
        lines,
        commitLane: row.lane,
        commitColorIdx: row.colorIdx,
        maxLanes,
        hollow: index === 0,
      })
    : []
  const decors = parseRefNames(row.commit.refNames.join(', '))
  return (
    <div
      testId={`abl-row-${index}`}
      style={{
        width: rowWidth,
        height: ROW_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        hover: { backgroundColor: 'rgba(128,128,128,0.12)' },
        cursor: 'pointer',
      }}
    >
      <div
        style={{
          width,
          height: ROW_HEIGHT,
          position: 'relative',
          flexShrink: 0,
          marginLeft: 8,
          marginRight: 6,
        }}
      >
        {pieces.map((p, i) => (
          <svg
            key={i}
            source={p.source}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width,
              height: ROW_HEIGHT,
              color: GRAPH_LANE_COLORS[p.colorIdx % GRAPH_LANE_COLORS.length],
            }}
          />
        ))}
      </div>
      <div
        style={{
          height: ROW_HEIGHT,
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          paddingRight: 12,
          minWidth: 0,
        }}
      >
        {withText ? (
          <>
            <div style={{ display: 'flex', flexDirection: 'row', gap: 4, flexShrink: 0, marginRight: 6 }}>
              {decors.map((d, i) => (
                <div
                  key={`${d.kind}-${d.label}-${i}`}
                  style={{
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    height: 18,
                    borderWidth: 1,
                    borderColor: COLORS.borderSubtle,
                    borderRadius: 5,
                    overflow: 'hidden',
                    flexShrink: 0,
                    backgroundColor: 'rgba(128,128,128,0.12)',
                  }}
                >
                  <div
                    style={{
                      width: 15,
                      height: 15,
                      backgroundColor: COLORS.muted,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  />
                  <text
                    style={{
                      fontSize: 11,
                      fontFamily: FONT.mono,
                      color: COLORS.textBright,
                      paddingLeft: 4,
                      paddingRight: 5,
                    }}
                  >
                    {T(d.label)}
                  </text>
                </div>
              ))}
            </div>
            <text
              style={{
                fontSize: 13,
                fontFamily: FONT.ui,
                color: COLORS.text,
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 0,
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
                overflow: 'hidden',
              }}
            >
              {T(row.commit.subject)}
            </text>
            <text
              style={{
                fontSize: 11,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                width: 110,
                flexShrink: 0,
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
                overflow: 'hidden',
                marginLeft: 8,
              }}
            >
              {T(row.commit.authorName)}
            </text>
            <text
              style={{
                fontSize: 11,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                width: 80,
                flexShrink: 0,
                textAlign: 'right',
                marginLeft: 8,
              }}
            >
              {T(relativeTime(row.commit.timestamp))}
            </text>
            <text
              style={{
                fontSize: 11,
                fontFamily: FONT.mono,
                color: COLORS.muted,
                width: 72,
                flexShrink: 0,
                marginLeft: 8,
              }}
            >
              {T(row.commit.shortSha)}
            </text>
          </>
        ) : null}
      </div>
    </div>
  )
}

// ── bench 主体（与 git-graph.bench.tsx 相同的场景协议） ───────────────

const renderer = createRenderer()
renderer.init({
  title: `j-agent bench: abl-${MODE}`,
  appName: 'j-agent-bench',
  width: 1180,
  height: WIN_H,
  minWidth: 720,
  minHeight: 240,
  titlebarTransparent: true,
})

const repoDir = process.argv[2] ?? ''
if (!repoDir) {
  console.error('usage: ABL=<mode> bun packages/app/bench/git-graph-ablation.bench.tsx <repoDir>')
  process.exit(2)
}

const store = createGitGraphStore()

// 数据快照：mount → ready 后取 rows/linesByRow（此后 store 不再变化，
// 变体渲染纯静态内容，排除流式加载的干扰帧）
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
const t0 = performance.now()
while (store.getState().status !== 'ready' && performance.now() - t0 < 10_000) {
  store.mount(repoDir)
  await sleep(50)
}
const snap = store.getState()
const rows = snap.rows
const linesByRow = snap.linesByRow
const maxLanes = snap.maxLanes

render(
  <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, backgroundColor: COLORS.pane }}>
    <virtual-list estimatedItemHeight={ROW_HEIGHT} style={{ height: WIN_H - 10 }}>
      {rows.map((row, i) => (
        <AblationRow
          key={row.commit.sha}
          row={row}
          index={i}
          lines={linesByRow.get(i) ?? []}
          maxLanes={maxLanes}
          rowWidth={1180}
        />
      ))}
    </virtual-list>
  </div>,
  { renderer },
)
startFrameLoop(renderer)
await sleep(300)
if (process.env.JAGENT_BENCH_SHOT) {
  renderer.captureScreenshot(process.env.JAGENT_BENCH_SHOT)
}
renderer.resetDebugFrameOverlayStats()
await sleep(SAMPLE_MS) // warmup

async function scrollPhase(name: string, ms: number, deltaY: number): Promise<WindowStat[]> {
  const out: WindowStat[] = []
  const start = performance.now()
  let lastTick = start
  while (performance.now() - start < ms) {
    const now = performance.now()
    if (now - lastTick >= SCROLL_TICK_MS) {
      lastTick = now
      renderer.simulateScrollWheel(600, WHEEL_Y, 0, deltaY)
    }
    await sleep(16)
    if (performance.now() - start - out.length * SAMPLE_MS >= SAMPLE_MS) {
      const s = renderer.getDebugFrameOverlayStats()
      out.push({
        phase: name,
        samples: s.samples,
        p90Ms: s.p90Ms ?? 0,
        maxMs: s.maxMs ?? 0,
        framesTotal: s.frames,
      })
      renderer.resetDebugFrameOverlayStats()
    }
  }
  const s = renderer.getDebugFrameOverlayStats()
  out.push({
    phase: `${name}-tail`,
    samples: s.samples,
    p90Ms: s.p90Ms ?? 0,
    maxMs: s.maxMs ?? 0,
    framesTotal: s.frames,
  })
  renderer.resetDebugFrameOverlayStats()
  return out
}

const down = await scrollPhase('down', 3000, -SCROLL_STEP_PX)
const up = await scrollPhase('up', 3000, SCROLL_STEP_PX)

const real = [...down, ...up].filter((w) => w.samples > 0)
const p90s = real.map((w) => w.p90Ms).sort((a, b) => a - b)
const med = p90s.length ? p90s[Math.floor(p90s.length / 2)] : 0
console.log(
  JSON.stringify({
    mode: MODE,
    winH: WIN_H,
    commits: rows.length,
    maxLanes,
    p90Med: Math.round(med * 100) / 100,
    maxMs: Math.round(Math.max(0, ...real.map((w) => w.maxMs)) * 100) / 100,
    windows: [...down, ...up],
  }),
)
process.exit(0)
