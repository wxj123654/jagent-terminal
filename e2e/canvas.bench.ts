/**
 * e2e/canvas.bench.ts — C8 可复跑基准。
 *
 * 跑法：bun run e2e/canvas.bench.ts（需 release .node，与 dev 同路径）。
 *
 * 两个测量面（都走真 native，不含 GPUI paint / GPU）：
 *
 * A. 5k 混合命令 × 连续帧 —— 预算 16.6ms/帧（60fps）
 *    每帧 625 迭代 × 8 个 napi 调用 = 5000 命令
 *    （beginPath/moveTo/2×lineTo/quadraticCurveTo/closePath/fill/fillRect），
 *    帧末 getImageData(1,1) 强制 commit 触发 vello_cpu 光栅化。
 *    覆盖：JS ctx 调用 → napi → Ctx2d 状态机 → CPU 光栅化。
 *    不覆盖：surface→GPU 纹理上传、window.paint_image。
 *
 * B. 脏帧整帧像素提取 —— 预算 ~220MB/s（全纹理上传等价量级）
 *    每迭代先 fillRect 弄脏整帧，再 canvasGetImageData(0,0,w,h) 全帧读回：
 *    commit（若有 pending）+ 全帧 unpremultiply + Buffer 打包。
 *    这是 current_frame 脏帧路径（premul_bytes → RGBA→BGRA swizzle →
 *    RenderImage）的同量级保守代理——unpremultiply 逐像素除法比 swizzle
 *    纯搬运更贵，测得过即覆盖真实路径。不覆盖 GPU atlas 上传本身
 *    （paint_image 需真窗口，且 Metal 异步提交不属于 CPU 带宽预算）。
 */

import { installCanvasElement } from '@jagent/native'
import * as native from '@jagent/native'

import { createCanvas } from '../packages/app/src/canvas/gpuixCanvas'
import { installCanvasNative } from '../packages/app/src/canvas/native'

installCanvasElement()
installCanvasNative(native)

const W = 800
const H = 600
const FRAMES = 120
const WARMUP = 10
const BUDGET_FRAME_MS = 16.6
const BUDGET_UPLOAD_MBS = 220

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))]!
  return {
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    p50: q(0.5),
    p95: q(0.95),
    max: s[s.length - 1]!,
  }
}

// ── A. 5k mixed commands × frame ─────────────────────────────────────
{
  const c = createCanvas(W, H)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#3366cc'
  ctx.strokeStyle = '#ff8800'
  ctx.lineWidth = 2

  const frame = (f: number) => {
    // 625 × 8 napi 调用 = 5000/帧；坐标确定性变化避免任何缓存命中
    for (let i = 0; i < 625; i++) {
      const x = ((i * 37 + f * 13) % (W - 40)) + 4
      const y = ((i * 53 + f * 7) % (H - 40)) + 4
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + 30, y + 6)
      ctx.lineTo(x + 12, y + 28)
      ctx.quadraticCurveTo(x + 20, y + 34, x, y + 10)
      ctx.closePath()
      ctx.fill()
      ctx.fillRect(x, y, 24, 3)
    }
    // 帧末提交：1px 读回强制 rasterize 本帧全部 pending op
    ctx.getImageData(0, 0, 1, 1)
  }

  for (let f = 0; f < WARMUP; f++) frame(f)
  const times: number[] = []
  for (let f = 0; f < FRAMES; f++) {
    const t0 = performance.now()
    frame(f)
    times.push(performance.now() - t0)
  }
  const s = stats(times)
  const ok = s.p95 < BUDGET_FRAME_MS
  console.log(
    `[A] 5k cmd/frame × ${FRAMES}f (${W}x${H}): mean=${s.mean.toFixed(2)}ms ` +
      `p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms max=${s.max.toFixed(2)}ms ` +
      `| budget ${BUDGET_FRAME_MS}ms → ${ok ? 'PASS' : 'FAIL'}`,
  )
  c.destroy()
}

// ── B. dirty-frame full-texture readback bandwidth ───────────────────
{
  const c = createCanvas(W, H)
  const ctx = c.getContext('2d')!
  const bytes = W * H * 4

  const iter = (i: number) => {
    // 弄脏整帧再读回 = 脏帧提交 + 全帧像素提取
    ctx.fillStyle = i % 2 ? '#102030' : '#302010'
    ctx.fillRect(0, 0, W, H)
    const t0 = performance.now()
    native.canvasGetImageData(c.surfaceId, 0, 0, W, H)
    return performance.now() - t0
  }

  for (let i = 0; i < WARMUP; i++) iter(i)
  const times: number[] = []
  let total = 0
  for (let i = 0; i < FRAMES; i++) {
    const dt = iter(i)
    times.push(dt)
    total += dt
  }
  const s = stats(times)
  const mbs = (((bytes * FRAMES) / total) * 1000) / 1e6
  const ok = mbs > BUDGET_UPLOAD_MBS
  console.log(
    `[B] dirty-frame ${(bytes / 1e6).toFixed(2)}MB × ${FRAMES}: mean=${s.mean.toFixed(3)}ms ` +
      `p95=${s.p95.toFixed(3)}ms → ${mbs.toFixed(0)}MB/s ` +
      `| budget ~${BUDGET_UPLOAD_MBS}MB/s → ${ok ? 'PASS' : 'FAIL'}`,
  )
  c.destroy()
}
