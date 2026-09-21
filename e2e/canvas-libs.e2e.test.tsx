/**
 * e2e/canvas-libs.e2e.test.tsx — C8 验收阶梯：uPlot 1.6.32 + Chart.js 4.5.1
 * 真 .node 像素断言（含 Path2D 通道）。
 *
 * 跑法：bun test e2e/（macOS + TestGpuixRenderer 真 GPU 渲染）。
 *
 * 验证面：
 * 1. Path2D：fill/stroke/clip(path) 真像素 + arcTo 解算 + 当前路径不受影响
 * 2. uPlot：e2e/dom-shim 最小 DOM → new uPlot → commit 微任务后读回像素，
 *    断言数据线（stroke 色）与轴线落在 plot 区域；挂载路径走
 *    <canvas surface> 元素 + captureScreenshot 真窗口帧断言
 * 3. Chart.js：platform=BasicPlatform（绕 DOM 探测，自动关动画）+
 *    animation:false/responsive:false/events:[] 直接吃 GpuixCanvas；
 *    line 图自动走 usePath2D 分支（typeof Path2D === 'function'）
 *
 * 缺口（见 docs/canvas-conformance.json）：DOM 事件/真实布局（shim 全零）、
 * uPlot 交互（cursor/select/dblclick 不发事件）、Path2D(SVG 字符串)、
 * addPath(transform)。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestRoot } from '@gpuix/react/testing'
import { installCanvasElement } from '@jagent/native'
import * as native from '@jagent/native'
import { createElement } from 'react'

import { createCanvas, type GpuixCanvas } from '../packages/app/src/canvas/gpuixCanvas'
import { installCanvasNative } from '../packages/app/src/canvas/native'
import { Path2D } from '../packages/app/src/canvas/path2d'
import { installDomShim } from './dom-shim'
import { decodePng } from './png'

const SHOTS = join(import.meta.dir, '..', '.shots')

function px(data: Uint8ClampedArray): [number, number, number, number] {
  return [data[0]!, data[1]!, data[2]!, data[3]!]
}

/** 以 (cx,cy) 为中心的 size×size 区域里是否存在满足 pred 的像素。 */
function hasPixelNear(
  ctx: { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } },
  cx: number,
  cy: number,
  size: number,
  pred: (p: [number, number, number, number]) => boolean,
): boolean {
  const half = Math.floor(size / 2)
  const img = ctx.getImageData(cx - half, cy - half, size, size)
  for (let i = 0; i < img.data.length; i += 4) {
    if (pred([img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!])) return true
  }
  return false
}

function countPixels(
  ctx: { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } },
  w: number,
  h: number,
  pred: (p: [number, number, number, number]) => boolean,
): number {
  const img = ctx.getImageData(0, 0, w, h)
  let n = 0
  for (let i = 0; i < img.data.length; i += 4) {
    if (pred([img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!])) n++
  }
  return n
}

const isRed = (p: [number, number, number, number]) =>
  p[3] > 200 && p[0] > 180 && p[1] < 100 && p[2] < 100
const isBlue = (p: [number, number, number, number]) =>
  p[3] > 200 && p[2] > 180 && p[0] < 100 && p[1] < 100
const isGreen = (p: [number, number, number, number]) =>
  p[3] > 200 && p[1] > 150 && p[0] < 100 && p[2] < 100

let shim: ReturnType<typeof installDomShim>

// TestGpuixRenderer 的 TEST_STATE 是 thread_local 单例：同进程里只有第一个
// 窗口的 paint_image 上屏（第二个窗口普通元素正常、image 空白）。两个挂载
// 断言因此共用一个 root——同窗口 t.render 重渲染换 surface 是正常的。
let mountedRoot: ReturnType<typeof createTestRoot> | null = null
function sharedRoot(): ReturnType<typeof createTestRoot> {
  mountedRoot ??= createTestRoot({ width: 420, height: 320 })
  return mountedRoot
}

beforeAll(() => {
  installCanvasElement()
  installCanvasNative(native)
  // uPlot 在模块加载期探测 window/document——shim 必须先装；
  // Chart.js 显式走 BasicPlatform，不受 shim 影响。
  shim = installDomShim()
})

afterAll(() => {
  mountedRoot?.unmount()
  mountedRoot = null
})

describe('Path2D（真 native 像素）', () => {
  test('fill(path) 填三角形；当前路径不受影响', () => {
    const c = createCanvas(64, 64)
    const ctx = c.getContext('2d')!
    const p = new Path2D()
    p.moveTo(32, 8)
    p.lineTo(56, 56)
    p.lineTo(8, 56)
    p.closePath()
    ctx.fillStyle = '#00aa00'
    ctx.fill(p)
    expect(px(ctx.getImageData(32, 40, 1, 1).data)).toEqual([0, 0xaa, 0, 0xff])
    expect(px(ctx.getImageData(10, 10, 1, 1).data)[3]).toBe(0)
    // 当前默认路径仍是空：fill() 不画任何东西
    ctx.fillStyle = '#ff0000'
    ctx.fill()
    expect(px(ctx.getImageData(10, 10, 1, 1).data)[3]).toBe(0)
    c.destroy()
  })

  test('stroke(path) + clip(path) + 路径复用', () => {
    const c = createCanvas(64, 64)
    const ctx = c.getContext('2d')!
    const line = new Path2D()
    line.moveTo(4, 16)
    line.lineTo(60, 16)
    ctx.strokeStyle = '#ff0000'
    ctx.lineWidth = 4
    ctx.stroke(line)
    ctx.stroke(line) // 同一路径可重复描（Chart.js _path 缓存路径）
    expect(isRed(px(ctx.getImageData(32, 16, 1, 1).data))).toBe(true)
    expect(px(ctx.getImageData(32, 24, 1, 1).data)[3]).toBe(0)

    const clipBox = new Path2D()
    clipBox.rect(0, 32, 64, 32)
    ctx.clip(clipBox)
    ctx.fillStyle = '#0000ff'
    ctx.fillRect(0, 0, 64, 64) // 只应命中下半
    expect(px(ctx.getImageData(32, 48, 1, 1).data)[2]).toBe(0xff)
    expect(px(ctx.getImageData(32, 8, 1, 1).data)[2]).toBe(0) // 上半只有 stroke 的线
    c.destroy()
  })

  test('arcTo 圆角矩形（uPlot 柱图路径同款）+ ellipse', () => {
    const c = createCanvas(64, 64)
    const ctx = c.getContext('2d')!
    const p = new Path2D()
    // uPlot bars 的 roundRect 手法：moveTo + 4×arcTo + closePath
    p.moveTo(20, 8)
    p.arcTo(56, 8, 56, 56, 8)
    p.arcTo(56, 56, 8, 56, 8)
    p.arcTo(8, 56, 8, 8, 8)
    p.arcTo(8, 8, 56, 8, 8)
    p.closePath()
    ctx.fillStyle = '#ff0000'
    ctx.fill(p)
    expect(isRed(px(ctx.getImageData(32, 32, 1, 1).data))).toBe(true) // 中心实
    expect(px(ctx.getImageData(9, 9, 1, 1).data)[3]).toBe(0) // 圆角外透明
    expect(isRed(px(ctx.getImageData(32, 9, 1, 1).data))).toBe(true) // 上边中点在面内

    const e = new Path2D()
    e.ellipse(32, 32, 24, 8, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#0000ff'
    ctx.fill(e)
    expect(isBlue(px(ctx.getImageData(50, 32, 1, 1).data))).toBe(true)
    expect(px(ctx.getImageData(32, 4, 1, 1).data)[3]).toBe(0) // 椭圆 ry=8 顶 24，rect 顶 8 之外
    c.destroy()
  })

  test('new Path2D(other) 拷贝 + evenodd 规则', () => {
    const c = createCanvas(64, 64)
    const ctx = c.getContext('2d')!
    const outer = new Path2D()
    outer.rect(4, 4, 56, 56)
    const hole = new Path2D(outer)
    hole.rect(24, 24, 16, 16)
    ctx.fillStyle = '#00aa00'
    ctx.fill(hole, 'evenodd')
    expect(isGreen(px(ctx.getImageData(10, 10, 1, 1).data))).toBe(true)
    expect(px(ctx.getImageData(32, 32, 1, 1).data)[3]).toBe(0) // 内矩形镂空
    c.destroy()
  })
})

describe('uPlot 1.6.32（dom-shim + 真 native）', () => {
  /** 构造并完成首帧 commit（uPlot 走 queueMicrotask 延迟 commit）。 */
  async function buildUPlot() {
    const uPlot = (await import('uplot')).default
    const root = shim.document.createElement('div')
    const u = new uPlot(
      {
        width: 400,
        height: 300,
        scales: { x: { time: false } },
        series: [{}, { stroke: '#ff0000', width: 2 }],
        axes: [{ stroke: '#0000ff' }, { stroke: '#0000ff' }],
        legend: { show: false },
        cursor: { show: false },
      },
      [
        [0, 1, 2, 3, 4],
        [0, 10, 5, 15, 8],
      ],
      root,
    )
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    return { u, root, surface: (u as unknown as { ctx: { canvas: GpuixCanvas } }).ctx.canvas }
  }

  test('离屏渲染：数据线红像素落在数据点、轴线蓝像素存在', async () => {
    const { u, surface } = await buildUPlot()
    expect(surface.width).toBe(400)
    expect(surface.height).toBe(300)
    const ctx = surface.getContext('2d')!

    const nonzero = countPixels(ctx, 400, 300, (p) => p[3] > 0)
    expect(nonzero).toBeGreaterThan(1000)

    // u.bbox = plot 区域（CSS px = device px，pxRatio=1）
    const bb = (
      u as unknown as { bbox: { left: number; top: number; width: number; height: number } }
    ).bbox
    // 数据点 (x=2, y=5) → 数据坐标换算像素：x 轴 [0,4]，y 轴 [0,15]
    const dx = Math.round(bb.left + (2 / 4) * bb.width)
    const dy = Math.round(bb.top + (1 - 5 / 15) * bb.height)
    expect(
      hasPixelNear(ctx, dx, dy, 9, isRed),
      `series point (${dx},${dy}) should be on the red line`,
    ).toBe(true)
    // 全图红线像素与轴线蓝像素计数
    expect(countPixels(ctx, 400, 300, isRed)).toBeGreaterThan(50)
    expect(countPixels(ctx, 400, 300, isBlue)).toBeGreaterThan(20)
    // 画布四角外仍透明
    expect(px(ctx.getImageData(2, 297, 1, 1).data)[3]).toBe(0)
    surface.destroy()
  })

  test('setData 重绘：换数据后新数据线位置正确', async () => {
    const { u, surface } = await buildUPlot()
    const ctx = surface.getContext('2d')!
    u.setData([
      [0, 1, 2, 3, 4],
      [15, 5, 10, 0, 8],
    ])
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    // 用 uPlot 自己的量程换算：setData 后 y 量程可能重算，手写 bbox 数学不可靠
    const pos = u as unknown as { valToPos(v: number, k: string, toPx: boolean): number }
    const dx = Math.round(pos.valToPos(2, 'x', true))
    const dy = Math.round(pos.valToPos(10, 'y', true))
    expect(hasPixelNear(ctx, dx, dy, 9, isRed)).toBe(true)
    surface.destroy()
  })

  test('uPlot surface 挂进真窗口：截图帧上有数据线', async () => {
    const { u, surface } = await buildUPlot()
    const t = sharedRoot()
    try {
      t.render(
        createElement('canvas', {
          surface: surface.surfaceId,
          rev: surface.revision,
          style: { width: 400, height: 300 },
        }),
      )
      t.renderer.flush()
      mkdirSync(SHOTS, { recursive: true })
      const shotPath = join(SHOTS, 'canvas-uplot.png')
      t.renderer.captureScreenshot(shotPath)
      const png = decodePng(readFileSync(shotPath))
      const scale = png.width / 420
      // 数据点 (2,5) 的换算坐标 → 缩放为 PNG 物理像素，邻域采样红线
      const bb = (
        u as unknown as { bbox: { left: number; top: number; width: number; height: number } }
      ).bbox
      const cx = Math.round((bb.left + (2 / 4) * bb.width) * scale)
      const cy = Math.round((bb.top + (1 - 5 / 15) * bb.height) * scale)
      let found = false
      for (let y = cy - 8; y <= cy + 8 && !found; y++) {
        for (let x = cx - 8; x <= cx + 8; x++) {
          const [r, g, b, a] = png.pixel(x, y)
          if (a > 200 && r > 180 && g < 100 && b < 100) {
            found = true
            break
          }
        }
      }
      expect(found, `uPlot data line should be at screen (${cx},${cy})`).toBe(true)
    } finally {
      surface.destroy()
    }
  })
})

describe('Chart.js 4.5.1（BasicPlatform + 静态渲染）', () => {
  async function buildChart(canvas: GpuixCanvas) {
    const { Chart, registerables, BasicPlatform } = await import('chart.js')
    Chart.register(...registerables)
    const chart = new Chart(
      canvas as never,
      {
        type: 'line',
        // BasicPlatform：acquireContext 走 item.getContext('2d')，自动关动画；
        // 绕 _detectPlatform → 不需要真 DOM（详见 TODOLIST C8 结论）。
        platform: BasicPlatform,
        data: {
          labels: [0, 1, 2, 3, 4],
          datasets: [
            {
              data: [0, 10, 5, 15, 8],
              borderColor: '#ff0000',
              borderWidth: 2,
              pointRadius: 0,
            },
          ],
        },
        options: {
          animation: false,
          responsive: false,
          events: [],
          scales: {
            x: { grid: { color: '#0000ff' } },
            y: { grid: { color: '#0000ff' } },
          },
          plugins: { legend: { display: false } },
        },
      } as never,
    )
    return chart
  }

  test('line 图渲染到 GpuixCanvas：数据点坐标断言 + usePath2D 生效', async () => {
    const canvas = createCanvas(400, 300)
    const chart = await buildChart(canvas)
    expect(chart.width).toBe(400)
    const ctx = canvas.getContext('2d')!

    expect(countPixels(ctx, 400, 300, (p) => p[3] > 0)).toBeGreaterThan(500)
    expect(countPixels(ctx, 400, 300, isBlue)).toBeGreaterThan(50) // 网格线
    expect(countPixels(ctx, 400, 300, isRed)).toBeGreaterThan(30) // 数据线

    // 数据点 (x=2, y=5) 的设备坐标从元素布局读，附近必须是红线像素
    const meta = chart.getDatasetMeta(0)
    const pt = meta.data[2] as unknown as { x: number; y: number }
    expect(hasPixelNear(ctx, Math.round(pt.x), Math.round(pt.y), 9, isRed)).toBe(true)

    // line 元素走 Path2D 缓存路径（typeof Path2D === 'function'）
    const lineEl = meta.dataset as unknown as { _path?: unknown }
    expect(lineEl._path).toBeInstanceOf(Path2D)
    chart.destroy()
    canvas.destroy()
  })

  test('bar 图 + update() 重绘', async () => {
    const canvas = createCanvas(400, 300)
    const { Chart, BasicPlatform } = await import('chart.js')
    const chart = new Chart(
      canvas as never,
      {
        type: 'bar',
        platform: BasicPlatform,
        data: {
          labels: ['a', 'b', 'c'],
          datasets: [{ data: [3, 7, 5], backgroundColor: '#00aa00' }],
        },
        options: {
          animation: false,
          responsive: false,
          events: [],
          plugins: { legend: { display: false } },
        },
      } as never,
    )
    const ctx = canvas.getContext('2d')!
    expect(countPixels(ctx, 400, 300, isGreen)).toBeGreaterThan(200)

    // update 改数据重绘：绿柱变红柱
    chart.data.datasets[0]!.data = [8, 2, 6]
    chart.data.datasets[0]!.backgroundColor = '#ff0000'
    chart.update()
    expect(countPixels(ctx, 400, 300, isRed)).toBeGreaterThan(200)
    chart.destroy()
    canvas.destroy()
  })

  test('Chart.js surface 挂进真窗口：截图帧上有图形', async () => {
    const canvas = createCanvas(400, 300)
    const chart = await buildChart(canvas)
    const t = sharedRoot()
    try {
      t.render(
        createElement('canvas', {
          surface: canvas.surfaceId,
          rev: canvas.revision,
          style: { width: 400, height: 300 },
        }),
      )
      t.renderer.flush()
      mkdirSync(SHOTS, { recursive: true })
      const shotPath = join(SHOTS, 'canvas-chartjs.png')
      t.renderer.captureScreenshot(shotPath)
      const png = decodePng(readFileSync(shotPath))
      const scale = png.width / 420
      // 数据点 (x=2, y=5) 的设备坐标（dpr=1 → CSS=设备）→ PNG 物理像素
      const meta = chart.getDatasetMeta(0)
      const pt = meta.data[2] as unknown as { x: number; y: number }
      const cx = Math.round(pt.x * scale)
      const cy = Math.round(pt.y * scale)

      let redFound = false
      for (let y = cy - 8; y <= cy + 8 && !redFound; y++) {
        for (let x = cx - 8; x <= cx + 8; x++) {
          const [r, g, b, a] = png.pixel(x, y)
          if (a > 200 && r > 180 && g < 100 && b < 100) {
            redFound = true
            break
          }
        }
      }
      expect(redFound, `Chart.js data line should be at screen (${cx},${cy})`).toBe(true)
    } finally {
      chart.destroy()
      canvas.destroy()
    }
  })
})
