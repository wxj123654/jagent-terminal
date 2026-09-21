/**
 * e2e/canvas.e2e.test.tsx — C6/C7 端到端验收：真 .node + rough.js。
 *
 * 跑法：bun test e2e/（macOS + TestGpuixRenderer 真 GPU 渲染）。
 *
 * 验证面：
 * 1. 离屏 createCanvas → 真 native 像素断言（fillRect/getImageData 着色）
 * 2. <Canvas> 挂载 → rough.js 手绘矩形/圆 → ctx.getImageData 读回 +
 *    captureScreenshot 解 PNG 断言屏幕上真有色块（元素 paint 链路验证）
 * 3. DPR：pixelRatio=2 → backing 翻倍 + scale(dpr) base transform 生效
 * 4. C7：gradient/pattern fill、drawImage(canvas) 各参形、
 *    imageSmoothingEnabled、toDataURL PNG 回读
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { installCanvasElement } from '@jagent/native'
import * as native from '@jagent/native'
import { createElement, type Ref } from 'react'
import rough from 'roughjs'

import { Canvas } from '../packages/app/src/canvas/Canvas'
import { createCanvas, type GpuixCanvas } from '../packages/app/src/canvas/gpuixCanvas'
import { installCanvasNative } from '../packages/app/src/canvas/native'
import { decodePng } from './png'

const SHOTS = join(import.meta.dir, '..', '.shots')

function px(data: Uint8ClampedArray): [number, number, number, number] {
  return [data[0]!, data[1]!, data[2]!, data[3]!]
}

beforeAll(() => {
  // seam 装配：custom element 注册必须在 renderer 创建之前（工厂是全局排他的）
  installCanvasElement()
  installCanvasNative(native)
})

describe('GpuixCanvas（离屏，真 native）', () => {
  test('fillRect/getImageData 真实像素读写', () => {
    const c = createCanvas(64, 64)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#3366cc'
    ctx.fillRect(0, 0, 32, 64)
    expect(px(ctx.getImageData(16, 32, 1, 1).data)).toEqual([0x33, 0x66, 0xcc, 0xff])
    // 右半未画 → transparent black
    expect(px(ctx.getImageData(48, 32, 1, 1).data)).toEqual([0, 0, 0, 0])
    c.destroy()
  })

  test('rough.js 在离屏 canvas 上作画（不挂载 React）', () => {
    const c = createCanvas(200, 120)
    const rc = rough.canvas(c as unknown as Parameters<typeof rough.canvas>[0])
    rc.rectangle(10, 10, 180, 100, {
      stroke: '#cc0000',
      strokeWidth: 2,
      fill: '#00aa00',
      fillStyle: 'solid',
      roughness: 0, // 确定性：roughness=0 去掉随机抖动
      seed: 1,
    })
    const ctx = c.getContext('2d')!
    // 实心填充：矩形内部必为绿
    const [r, g, , a] = px(ctx.getImageData(100, 60, 1, 1).data)
    expect(g).toBeGreaterThan(150)
    expect(r).toBeLessThan(80)
    expect(a).toBe(255)
    // 矩形外（5,5）仍透明
    expect(px(ctx.getImageData(5, 5, 1, 1).data)[3]).toBe(0)
    c.destroy()
  })
})

describe('<Canvas> 挂载 + rough.js', () => {
  test('rough.js 手绘形状出现在真窗口帧上', async () => {
    const t: TestRoot = createTestRoot({ width: 400, height: 300 })
    try {
      let canvas: GpuixCanvas | null = null
      const ref: Ref<GpuixCanvas> = (c) => {
        canvas = c
      }
      t.render(
        createElement(
          'div',
          { style: { display: 'flex', width: 400, height: 300 } },
          createElement(Canvas, {
            width: 200,
            height: 120,
            pixelRatio: 1,
            ref,
          }),
        ),
      )
      expect(canvas).not.toBeNull()
      expect(canvas!.width).toBe(200)
      expect(canvas!.height).toBe(120)

      // 先铺不透明底色（让截图断言有稳定锚点），再让 rough.js 画
      const ctx = canvas!.getContext('2d')!
      ctx.fillStyle = '#123456'
      ctx.fillRect(0, 0, 200, 120)
      const rc = rough.canvas(canvas as unknown as Parameters<typeof rough.canvas>[0])
      rc.rectangle(10, 10, 180, 100, {
        stroke: '#ff8800',
        strokeWidth: 3,
        fill: '#22cc44',
        fillStyle: 'solid',
        roughness: 0,
        seed: 1,
      })
      rc.circle(60, 60, 40, {
        stroke: '#0044ff',
        strokeWidth: 2,
        roughness: 0,
        seed: 2,
      })

      // rev bump → React 重渲染（uSES 订阅 → 调度提交需要让出主线程）
      await new Promise((r) => setTimeout(r, 0))
      t.renderer.flush()

      // ── surface 层断言：绿填充矩形内部 ──
      const [r, g, , a] = px(ctx.getImageData(160, 90, 1, 1).data)
      expect(g).toBeGreaterThan(150)
      expect(r).toBeLessThan(80)
      expect(a).toBe(255)

      // ── 元素树断言（surface/rev 作为 custom props 到达 native）──
      const els = t.renderer.findByType('canvas')
      expect(els).toHaveLength(1)
      expect(els[0]!.customProps?.surface).toBe(canvas!.surfaceId)
      expect(typeof els[0]!.customProps?.rev).toBe('number')

      // ── 屏幕帧断言：解 PNG，canvas 区域内的采样点必须是画上去的绿 ──
      // （custom element 不走 automation::track_own_bounds——getElementBounds
      // 对它恒 null，故直接按布局位置采样：canvas 在 400×300 窗口左上角
      // 200×120，采样 (160,90) 落在 rough 矩形实心填充内）
      mkdirSync(SHOTS, { recursive: true })
      const shotPath = join(SHOTS, 'canvas-rough.png')
      t.renderer.captureScreenshot(shotPath)
      const png = decodePng(readFileSync(shotPath))
      // bounds 是 point 坐标；PNG 是物理像素（scaleFactor = png.width/400）
      const scale = png.width / 400
      const cx = Math.round(160 * scale)
      const cy = Math.round(90 * scale)
      const [sr, sg, sb, sa] = png.pixel(cx, cy)
      expect(
        sg > 120 && sr < 120 && sa > 200,
        `screenshot center pixel ${[sr, sg, sb, sa]} should be rough green`,
      ).toBe(true)
    } finally {
      t.unmount()
    }
  })

  test('pixelRatio=2：backing 翻倍 + CSS 坐标经 scale(dpr) 生效', async () => {
    const t = createTestRoot({ width: 400, height: 300 })
    try {
      let canvas: GpuixCanvas | null = null
      t.render(
        createElement(
          'div',
          { style: { display: 'flex', width: 400, height: 300 } },
          createElement(Canvas, {
            width: 100,
            height: 60,
            pixelRatio: 2,
            ref: (c: GpuixCanvas | null) => {
              canvas = c
            },
          }),
        ),
      )
      // backing = CSS × 2
      expect(canvas!.width).toBe(200)
      expect(canvas!.height).toBe(120)
      // CSS 坐标铺满 → 物理右下角也着色（证明 scale(2) base transform 在）
      const ctx = canvas!.getContext('2d')!
      ctx.fillStyle = '#ff0000'
      ctx.fillRect(0, 0, 100, 60)
      expect(px(ctx.getImageData(199, 119, 1, 1).data)).toEqual([0xff, 0, 0, 0xff])
    } finally {
      t.unmount()
    }
  })
})

describe('C7：gradient/pattern/drawImage/toDataURL（真 native 像素）', () => {
  /** 4×4 源：左上红 右上绿 左下蓝 右下白（putImageData 灌入）。 */
  function checker(): GpuixCanvas {
    const c = createCanvas(4, 4)
    const img = c.getContext('2d')!.createImageData(4, 4)
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const [r, g, b] =
          x < 2 ? (y < 2 ? [255, 0, 0] : [0, 0, 255]) : y < 2 ? [0, 255, 0] : [255, 255, 255]
        const i = (y * 4 + x) * 4
        img.data[i] = r!
        img.data[i + 1] = g!
        img.data[i + 2] = b!
        img.data[i + 3] = 255
      }
    }
    c.getContext('2d')!.putImageData(img, 0, 0)
    return c
  }

  test('linear gradient：端点色 + 中间插值；fillStyle 可换回纯色', () => {
    const c = createCanvas(64, 16)
    const ctx = c.getContext('2d')!
    const g = ctx.createLinearGradient(0, 0, 64, 0)
    g.addColorStop(0, '#ff0000')
    g.addColorStop(1, '#0000ff')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 16)
    // 像素中心采样：x=2.5 → t≈0.04 近红；x=61.5 → t≈0.96 近蓝（非精确端点）
    const near0 = px(ctx.getImageData(2, 8, 1, 1).data)
    expect(near0[0]).toBeGreaterThan(240)
    expect(near0[2]).toBeLessThan(20)
    const mid = px(ctx.getImageData(32, 8, 1, 1).data)
    expect(mid[0]).toBeGreaterThan(100)
    expect(mid[2]).toBeGreaterThan(100)
    const near1 = px(ctx.getImageData(61, 8, 1, 1).data)
    expect(near1[2]).toBeGreaterThan(240)
    expect(near1[0]).toBeLessThan(20)
    // gradient 对象再换回字符串
    ctx.fillStyle = '#00ff00'
    ctx.fillRect(0, 0, 4, 4)
    expect(px(ctx.getImageData(2, 2, 1, 1).data)).toEqual([0, 0xff, 0, 0xff])
    c.destroy()
  })

  test('radial/conic gradient 真像素', () => {
    const c = createCanvas(64, 64)
    const ctx = c.getContext('2d')!
    const rg = ctx.createRadialGradient(32, 32, 0, 32, 32, 24)
    rg.addColorStop(0, '#ff0000')
    rg.addColorStop(1, '#0000ff')
    ctx.fillStyle = rg
    ctx.fillRect(0, 0, 64, 64)
    const center = px(ctx.getImageData(32, 32, 1, 1).data)
    expect(center[0]).toBeGreaterThan(200)
    expect(center[2]).toBeLessThan(60)
    expect(px(ctx.getImageData(60, 60, 1, 1).data)[2]).toBe(0xff) // Pad 边界色

    const cg = ctx.createConicGradient(0, 32, 32)
    cg.addColorStop(0, '#ff0000')
    cg.addColorStop(0.5, '#00ff00')
    cg.addColorStop(1, '#ff0000')
    ctx.fillStyle = cg
    ctx.fillRect(0, 0, 64, 64)
    const east = px(ctx.getImageData(56, 32, 1, 1).data)
    const west = px(ctx.getImageData(8, 32, 1, 1).data)
    expect(east[0]).toBeGreaterThan(180)
    expect(west[1]).toBeGreaterThan(180)
    c.destroy()
  })

  test('strokeStyle 也吃 gradient', () => {
    const c = createCanvas(64, 16)
    const ctx = c.getContext('2d')!
    const g = ctx.createLinearGradient(0, 0, 64, 0)
    g.addColorStop(0, '#ff0000')
    g.addColorStop(1, '#0000ff')
    ctx.strokeStyle = g
    ctx.lineWidth = 4
    ctx.strokeRect(4, 4, 56, 8)
    const [r, , b, a] = px(ctx.getImageData(8, 4, 1, 1).data)
    expect(a).toBe(255)
    expect(r).toBeGreaterThan(180)
    expect(b).toBeLessThan(80)
    c.destroy()
  })

  test('pattern repeat 平铺 / no-repeat 只画条带', () => {
    const src = createCanvas(2, 2)
    const img = src.getContext('2d')!.createImageData(2, 2)
    img.data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])
    src.getContext('2d')!.putImageData(img, 0, 0)

    const c = createCanvas(8, 8)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = ctx.createPattern(src, 'repeat')!
    ctx.fillRect(0, 0, 8, 8)
    expect(px(ctx.getImageData(0, 0, 1, 1).data)).toEqual([255, 0, 0, 255])
    expect(px(ctx.getImageData(3, 0, 1, 1).data)).toEqual([0, 255, 0, 255])
    expect(px(ctx.getImageData(4, 5, 1, 1).data)).toEqual([0, 0, 255, 255])
    expect(px(ctx.getImageData(7, 7, 1, 1).data)).toEqual([255, 255, 255, 255])

    // no-repeat：条带外必须是透明而不是边缘拖影
    const c2 = createCanvas(8, 8)
    const ctx2 = c2.getContext('2d')!
    ctx2.fillStyle = ctx2.createPattern(src, 'no-repeat')!
    ctx2.fillRect(0, 0, 8, 8)
    expect(px(ctx2.getImageData(0, 0, 1, 1).data)).toEqual([255, 0, 0, 255])
    expect(px(ctx2.getImageData(3, 1, 1, 1).data)).toEqual([0, 0, 0, 0])
    expect(px(ctx2.getImageData(1, 3, 1, 1).data)).toEqual([0, 0, 0, 0])
    src.destroy()
    c.destroy()
    c2.destroy()
  })

  test('drawImage(canvas)：偏移/缩放/源矩形/镜像/自绘', () => {
    const src = checker()
    const c = createCanvas(32, 32)
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingEnabled = false

    // 3 参：原尺寸偏移 blit
    ctx.drawImage(src, 8, 8)
    expect(px(ctx.getImageData(9, 9, 1, 1).data)).toEqual([255, 0, 0, 255])
    expect(px(ctx.getImageData(11, 9, 1, 1).data)).toEqual([0, 255, 0, 255])
    expect(px(ctx.getImageData(4, 4, 1, 1).data)).toEqual([0, 0, 0, 0])

    // 5 参：4×4 → 16×16
    ctx.drawImage(src, 0, 0, 16, 16)
    expect(px(ctx.getImageData(10, 2, 1, 1).data)).toEqual([0, 255, 0, 255])
    expect(px(ctx.getImageData(2, 10, 1, 1).data)).toEqual([0, 0, 255, 255])

    // 9 参：源 (2,0,2,2) 绿块 → (20,20,8,8)
    ctx.drawImage(src, 2, 0, 2, 2, 20, 20, 8, 8)
    expect(px(ctx.getImageData(24, 24, 1, 1).data)).toEqual([0, 255, 0, 255])
    expect(px(ctx.getImageData(19, 24, 1, 1).data)).toEqual([0, 0, 0, 0]) // dst 外不被波及

    // 负 dw 镜像：源左半红画到右半
    ctx.drawImage(src, 0, 0, 4, 4, 16, 16, -16, 16)
    expect(px(ctx.getImageData(14, 17, 1, 1).data)).toEqual([255, 0, 0, 255]) // 源 (0,0) 在右端
    expect(px(ctx.getImageData(2, 17, 1, 1).data)).toEqual([0, 255, 0, 255]) // 源 (3,0) 在左端

    // 自绘：dst == src surface
    const self_ = createCanvas(8, 8)
    const sctx = self_.getContext('2d')!
    sctx.fillStyle = '#ff0000'
    sctx.fillRect(0, 0, 4, 8)
    sctx.drawImage(self_, 0, 0, 4, 8, 4, 0, 4, 8) // 左半红复制到右半
    expect(px(sctx.getImageData(6, 4, 1, 1).data)).toEqual([255, 0, 0, 255])
    expect(px(sctx.getImageData(2, 4, 1, 1).data)).toEqual([255, 0, 0, 255])

    src.destroy()
    c.destroy()
    self_.destroy()
  })

  test('imageSmoothingEnabled=false → 最近邻硬边；true → 双线性过渡', () => {
    const src = createCanvas(2, 1)
    const img = src.getContext('2d')!.createImageData(2, 1)
    img.data.set([255, 0, 0, 255, 0, 0, 255, 255])
    src.getContext('2d')!.putImageData(img, 0, 0)

    const hard = createCanvas(8, 1)
    const hctx = hard.getContext('2d')!
    hctx.imageSmoothingEnabled = false
    hctx.drawImage(src, 0, 0, 2, 1, 0, 0, 8, 1)
    expect(px(hctx.getImageData(3, 0, 1, 1).data)).toEqual([255, 0, 0, 255])
    expect(px(hctx.getImageData(4, 0, 1, 1).data)).toEqual([0, 0, 255, 255])

    const soft = createCanvas(8, 1)
    const sctx = soft.getContext('2d')!
    sctx.drawImage(src, 0, 0, 2, 1, 0, 0, 8, 1)
    const mid = px(sctx.getImageData(3, 0, 1, 1).data) // 边界邻域：双线性应混色
    expect(mid[0] > 0 && mid[2] > 0).toBe(true)

    src.destroy()
    hard.destroy()
    soft.destroy()
  })

  test('toDataURL → PNG 解码回读像素一致', () => {
    const c = createCanvas(16, 8)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#3366cc'
    ctx.fillRect(0, 0, 8, 8) // 左半蓝
    ctx.fillStyle = '#cc6600'
    ctx.fillRect(8, 0, 8, 8) // 右半橙
    const url = c.toDataURL()
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    const png = decodePng(Buffer.from(url.slice(22), 'base64'))
    expect(png.width).toBe(16)
    expect(png.height).toBe(8)
    expect(png.pixel(4, 4)).toEqual([0x33, 0x66, 0xcc, 0xff])
    expect(png.pixel(12, 4)).toEqual([0xcc, 0x66, 0, 0xff])
    // alpha 语义：透明像素 roundtrip
    const t = createCanvas(4, 4)
    t.getContext('2d')!.fillStyle = 'rgba(255,0,0,0.5)'
    t.getContext('2d')!.fillRect(0, 0, 4, 4)
    const tp = decodePng(Buffer.from(t.toDataURL().slice(22), 'base64')).pixel(2, 2)
    expect(tp[0]).toBe(255)
    expect(Math.abs(tp[3] - 128)).toBeLessThanOrEqual(2)
    c.destroy()
    t.destroy()
  })
})
