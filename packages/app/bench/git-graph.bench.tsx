/**
 * scripts/bench/git-graph-bench.tsx — git graph 页整帧 draw 耗时基准。
 *
 * 回答的问题：GitGraphView 打开时滚动，Window::draw（build+layout+paint
 * 全程）每帧多少 ms？相对 terminal（用户观测 3–4ms）差在哪。
 *
 * 手段：真实 GpuixRenderer（release .node，与 dev 同路径）+ 真实
 * GitGraphView + 真实 store（mount 到 gen-bench-repo 生成的确定性仓库）
 * + simulateScrollWheel 程序化滚动 + getDebugFrameOverlayStats 500ms 窗
 * 采样（读后即 reset，语义与 PerfHud 相同）。
 *
 * 场景：
 *   warmup   500ms   首帧/字形/预热，不计
 *   idle     1000ms  静止——gpui 按需重绘，期望 ~0 帧（非 0 即有自乱源）
 *   down     3000ms  每 16ms 滚轮 -60px（向下）
 *   up       3000ms  每 16ms 滚轮 +60px（向上）
 *
 * 用法：
 *   bun scripts/bench/gen-bench-repo.ts          # 先生成仓库（幂等）
 *   bun packages/app/bench/git-graph.bench.tsx <repoDir>   # 跑基准，stdout 输出 JSON
 *
 * 判定（回路红/绿）：down/up 阶段 p90 复现用户观测的 ~10ms → 红；
 * 优化后显著下降（terminal 水平 3–4ms）→ 绿。
 */

import { createRenderer, render, startFrameLoop } from '@gpuix/react'
import { installGitGraphRowElement } from '@jagent/native'

import { createGitGraphStore } from '../src/git/store'
import { GitGraphView } from '../src/git/components/GitGraphView'

const SAMPLE_MS = 500
const SCROLL_STEP_PX = 60
const SCROLL_TICK_MS = 16
// 顺序敏感：先注册 <git-graph-row> 工厂，再建 renderer
installGitGraphRowElement()

type Window = {
  phase: string
  frames: number
  samples: number
  p90Ms: number
  p99Ms: number
  maxMs: number
}

const renderer = createRenderer()
renderer.init({
  title: 'j-agent bench: git-graph',
  appName: 'j-agent-bench',
  width: 1180,
  height: 760,
  minWidth: 720,
  minHeight: 480,
  titlebarTransparent: true,
})

const repoDir = process.argv[2] ?? process.env.JAGENT_BENCH_REPO ?? ''
if (!repoDir) {
  console.error('usage: bun scripts/bench/git-graph-bench.tsx <repoDir>')
  process.exit(2)
}

const store = createGitGraphStore()

render(
  <GitGraphView cwd={repoDir} store={store} repoLabel="bench-repo" />,
  { renderer },
)
startFrameLoop(renderer)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function until(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = performance.now()
  while (performance.now() - t0 < timeoutMs) {
    if (cond()) return true
    await sleep(50)
  }
  return cond()
}

/** 一个采样窗：读 stats → reset → 返回（读后即清，与 PerfHud 同语义） */
function sampleWindow(phase: string): Window {
  const s = renderer.getDebugFrameOverlayStats()
  const w: Window = {
    phase,
    frames: s.frames,
    samples: s.samples,
    p90Ms: s.p90Ms ?? 0,
    p99Ms: s.p99Ms ?? 0,
    maxMs: s.maxMs ?? 0,
  }
  renderer.resetDebugFrameOverlayStats()
  return w
}

/** 采样一个阶段；scroll 时按 tick 驱动滚轮 */
async function phase(
  name: string,
  ms: number,
  scroll: { deltaY: number } | null,
): Promise<Window[]> {
  renderer.resetDebugFrameOverlayStats()
  const windows: Window[] = []
  const t0 = performance.now()
  let lastTick = t0
  while (performance.now() - t0 < ms) {
    if (scroll) {
      const now = performance.now()
      if (now - lastTick >= SCROLL_TICK_MS) {
        lastTick = now
        renderer.simulateScrollWheel(600, 400, 0, scroll.deltaY)
      }
    }
    await sleep(16)
    if (performance.now() - t0 - (windows.length * SAMPLE_MS) >= SAMPLE_MS) {
      windows.push(sampleWindow(name))
    }
  }
  // 阶段尾窗（不满 SAMPLE_MS 也收，标注帧数）
  windows.push(sampleWindow(`${name}-tail`))
  return windows
}

function summarize(ws: Window[]): { frames: number; p90Med: number; maxMs: number } {
  const real = ws.filter((w) => w.samples > 0)
  const p90s = real.map((w) => w.p90Ms).sort((a, b) => a - b)
  const med = p90s.length ? p90s[Math.floor(p90s.length / 2)] : 0
  return {
    frames: ws.reduce((a, w) => a + w.frames, 0),
    p90Med: Math.round(med * 100) / 100,
    maxMs: Math.round(Math.max(0, ...ws.map((w) => w.maxMs)) * 100) / 100,
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────
const ok = await until(
  () => store.getState().status === 'ready' && store.getState().loadedCount > 0,
  10_000,
)
if (!ok) {
  console.error(
    JSON.stringify({ error: 'repo did not load', state: store.getState().status }),
  )
  process.exit(1)
}
// 等首帧绘制落定（rows 到位后的第一个 draw）
await sleep(300)

// 视觉冒烟：JAGENT_BENCH_SHOT=path.png 时截首屏（新行元素的像素级人工核对）
if (process.env.JAGENT_BENCH_SHOT) {
  renderer.captureScreenshot(process.env.JAGENT_BENCH_SHOT)
}

await phase('warmup', SAMPLE_MS, null)

const idle = await phase('idle', 1000, null)
const down = await phase('down', 3000, { deltaY: -SCROLL_STEP_PX })
const up = await phase('up', 3000, { deltaY: SCROLL_STEP_PX })

const out = {
  repo: repoDir,
  commits: store.getState().loadedCount,
  maxLanes: store.getState().maxLanes,
  summary: {
    idle: summarize(idle),
    down: summarize(down),
    up: summarize(up),
  },
  windows: [...idle, ...down, ...up],
}
console.log(JSON.stringify(out, null, 2))
process.exit(0)
