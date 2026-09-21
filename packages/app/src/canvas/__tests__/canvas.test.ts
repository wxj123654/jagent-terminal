/**
 * canvas/__tests__/canvas.test.ts — GpuixCanvas + Canvas2dContext 单测。
 *
 * 注入 fake CanvasNative（调用录制 + 最小语义模拟），不依赖真 .node。
 * 真 native 像素断言在 e2e/canvas.e2e.test.tsx。
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Canvas2dContext } from '../context'
import { GpuixCanvas, createCanvas } from '../gpuixCanvas'
import { installCanvasNative, type CanvasNative } from '../native'

type Calls = Array<[string, ...unknown[]]>

const VALID_CSS = /^(#[0-9a-f]{3,8}|rgba?\(.*\)|[a-z]+)$/i

/** 录制所有调用；风格 setter 对非 CSS 颜色串抛 ERR_CANVAS（同 Rust）。 */
function makeFake() {
  const calls: Calls = []
  const surfaces = new Map<number, { w: number; h: number }>()
  let nextId = 1
  const rec =
    (name: string) =>
    (id: number, ...args: unknown[]) => {
      calls.push([name, id, ...args])
    }
  const style = (name: string) => (id: number, value: unknown) => {
    // 字符串按 CSS 颜色校验；对象（gradient spec）直接放行（同 Rust parse_paint_value）
    if (typeof value === 'string' && !VALID_CSS.test(value))
      throw new Error(`ERR_CANVAS: invalid color '${value}'`)
    calls.push([name, id, value])
  }
  const native: CanvasNative & {
    calls: Calls
    surfaces: Map<number, { w: number; h: number }>
  } = {
    calls,
    surfaces,
    canvasCreate: (w, h) => {
      const id = nextId++
      surfaces.set(id, { w, h })
      calls.push(['canvasCreate', w, h])
      return id
    },
    canvasDestroy: (id) => {
      surfaces.delete(id)
      calls.push(['canvasDestroy', id])
    },
    canvasResize: (id, w, h) => {
      const s = surfaces.get(id)
      if (s) {
        s.w = w
        s.h = h
      }
      calls.push(['canvasResize', id, w, h])
    },
    canvasRevision: (id) => (calls.push(['canvasRevision', id]), 0),
    canvasReset: rec('canvasReset'),
    canvasSave: rec('canvasSave'),
    canvasRestore: rec('canvasRestore'),
    canvasSetFillStyle: style('canvasSetFillStyle'),
    canvasSetStrokeStyle: style('canvasSetStrokeStyle'),
    canvasSetGlobalAlpha: rec('canvasSetGlobalAlpha'),
    canvasSetCompositeOp: rec('canvasSetCompositeOp'),
    canvasSetLineWidth: rec('canvasSetLineWidth'),
    canvasSetLineCap: rec('canvasSetLineCap'),
    canvasSetLineJoin: rec('canvasSetLineJoin'),
    canvasSetMiterLimit: rec('canvasSetMiterLimit'),
    canvasSetLineDash: rec('canvasSetLineDash'),
    canvasSetFont: rec('canvasSetFont'),
    canvasSetTextAlign: rec('canvasSetTextAlign'),
    canvasSetTextBaseline: rec('canvasSetTextBaseline'),
    canvasSetTransform: rec('canvasSetTransform'),
    canvasTransform: rec('canvasTransform'),
    canvasResetTransform: rec('canvasResetTransform'),
    canvasBeginPath: rec('canvasBeginPath'),
    canvasClosePath: rec('canvasClosePath'),
    canvasMoveTo: rec('canvasMoveTo'),
    canvasLineTo: rec('canvasLineTo'),
    canvasQuadraticTo: rec('canvasQuadraticTo'),
    canvasBezierTo: rec('canvasBezierTo'),
    canvasArc: rec('canvasArc'),
    canvasRect: rec('canvasRect'),
    canvasRoundRect: rec('canvasRoundRect'),
    canvasFill: rec('canvasFill'),
    canvasStroke: rec('canvasStroke'),
    canvasClip: rec('canvasClip'),
    canvasFillRect: rec('canvasFillRect'),
    canvasStrokeRect: rec('canvasStrokeRect'),
    canvasClearRect: rec('canvasClearRect'),
    canvasFillText: rec('canvasFillText'),
    canvasStrokeText: rec('canvasStrokeText'),
    canvasMeasureText: (id, text) => {
      calls.push(['canvasMeasureText', id, text])
      return { width: 42, fontBoundingBoxAscent: 9, fontBoundingBoxDescent: 3 }
    },
    canvasGetImageData: (id, x, y, w, h) => {
      calls.push(['canvasGetImageData', id, x, y, w, h])
      return Buffer.alloc(w * h * 4, 7)
    },
    canvasPutImageData: rec('canvasPutImageData'),
    canvasCheckColor: (css) => VALID_CSS.test(css),
    canvasSetFillPattern: rec('canvasSetFillPattern'),
    canvasSetStrokePattern: rec('canvasSetStrokePattern'),
    canvasSetImageSmoothing: rec('canvasSetImageSmoothing'),
    canvasDrawImage: (dst, src, sx, sy, sw, sh, dx, dy, dw, dh) => {
      calls.push(['canvasDrawImage', dst, src, sx, sy, sw, sh, dx, dy, dw, dh])
      return true
    },
    canvasEncodePng: (id) => {
      calls.push(['canvasEncodePng', id])
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    },
  }
  return native
}

function callsOf(fake: ReturnType<typeof makeFake>, name: string) {
  return fake.calls.filter((c) => c[0] === name)
}

let fake: ReturnType<typeof makeFake>

beforeEach(() => {
  fake = makeFake()
  installCanvasNative(fake)
})

describe('GpuixCanvas', () => {
  test('getContext("2d") 返回同一 ctx；其他模式返回 null', () => {
    const c = new GpuixCanvas(64, 32, fake)
    const ctx = c.getContext('2d')
    expect(ctx).not.toBeNull()
    expect(c.getContext('2d')).toBe(ctx)
    expect(ctx!.canvas).toBe(c)
    expect(c.getContext('webgl')).toBeNull()
    expect(c.getContext('bitmaprenderer')).toBeNull()
  })

  test('默认尺寸 300×150；createCanvas 走绑定 native', () => {
    const c = createCanvas()
    expect(c.width).toBe(300)
    expect(c.height).toBe(150)
    expect(callsOf(fake, 'canvasCreate')).toEqual([['canvasCreate', 300, 150]])
  })

  test('非法尺寸抛 RangeError', () => {
    expect(() => new GpuixCanvas(0, 10, fake)).toThrow(RangeError)
    expect(() => new GpuixCanvas(10, -5, fake)).toThrow(RangeError)
    expect(() => new GpuixCanvas(70000, 10, fake)).toThrow(RangeError)
  })

  test('width/height setter → canvasResize + ctx shadow 重置 + rev bump', () => {
    const c = new GpuixCanvas(64, 32, fake)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ff0000'
    let bumps = 0
    c.subscribe(() => bumps++)
    c.width = 100
    expect(callsOf(fake, 'canvasResize')).toEqual([['canvasResize', c.surfaceId, 100, 32]])
    expect(c.width).toBe(100)
    expect(bumps).toBe(1)
    // resize 重置状态：fillStyle 回默认
    expect(ctx.fillStyle).toBe('#000000')
    c.height = 80
    expect(c.height).toBe(80)
    expect(bumps).toBe(2)
  })

  test('destroy 释放 surface；再次 getContext 按记录尺寸 revive', () => {
    const c = new GpuixCanvas(64, 32, fake)
    const oldId = c.surfaceId
    c.destroy()
    expect(c.destroyed).toBe(true)
    expect(callsOf(fake, 'canvasDestroy')).toEqual([['canvasDestroy', oldId]])
    const ctx = c.getContext('2d')!
    expect(c.destroyed).toBe(false)
    expect(c.surfaceId).not.toBe(oldId)
    expect(fake.surfaces.get(c.surfaceId)).toEqual({ w: 64, h: 32 })
    // 旧 ctx 对象跟随新 surface（动态取 id）
    ctx.fillStyle = '#00ff00'
    const styleCalls = callsOf(fake, 'canvasSetFillStyle')
    expect(styleCalls.at(-1)![1]).toBe(c.surfaceId)
  })

  test('resizeDevice：resize 到设备像素 + base transform scale(dpr)', () => {
    const c = new GpuixCanvas(100, 50, fake)
    c.resizeDevice(200, 100, 2)
    expect(c.width).toBe(200)
    expect(c.appliedPixelRatio).toBe(2)
    expect(callsOf(fake, 'canvasSetTransform')).toEqual([
      ['canvasSetTransform', c.surfaceId, 2, 0, 0, 2, 0, 0],
    ])
    // destroy 后 revive 重放 dpr transform
    c.destroy()
    c.getContext('2d')
    expect(callsOf(fake, 'canvasSetTransform').at(-1)).toEqual([
      'canvasSetTransform',
      c.surfaceId,
      2,
      0,
      0,
      2,
      0,
      0,
    ])
  })
})

describe('Canvas2dContext 属性 setter', () => {
  let ctx: Canvas2dContext
  let id: number

  beforeEach(() => {
    const c = new GpuixCanvas(64, 64, fake)
    id = c.surfaceId
    ctx = c.getContext('2d')!
  })

  test('fillStyle/strokeStyle：合法转发；非法静默忽略保留旧值', () => {
    ctx.fillStyle = '#ff0000'
    ctx.strokeStyle = 'rgb(0,0,255)'
    expect(ctx.fillStyle).toBe('#ff0000')
    expect(ctx.strokeStyle).toBe('rgb(0,0,255)')
    expect(callsOf(fake, 'canvasSetFillStyle')).toEqual([['canvasSetFillStyle', id, '#ff0000']])

    ctx.fillStyle = 'not a color'
    ctx.strokeStyle = '!!!'
    expect(ctx.fillStyle).toBe('#ff0000')
    expect(ctx.strokeStyle).toBe('rgb(0,0,255)')
    // 非法值没有成功落 native（fake 在 push 前 throw）
    expect(callsOf(fake, 'canvasSetFillStyle')).toHaveLength(1)
    expect(callsOf(fake, 'canvasSetStrokeStyle')).toHaveLength(1)
  })

  test('globalAlpha/lineWidth/miterLimit：越界与非有限值忽略', () => {
    ctx.globalAlpha = 0.5
    expect(ctx.globalAlpha).toBe(0.5)
    ctx.globalAlpha = 2
    ctx.globalAlpha = -1
    ctx.globalAlpha = NaN
    expect(ctx.globalAlpha).toBe(0.5)

    ctx.lineWidth = 0
    ctx.lineWidth = -3
    expect(ctx.lineWidth).toBe(1)
    ctx.lineWidth = 4.5
    expect(ctx.lineWidth).toBe(4.5)

    ctx.miterLimit = 0
    expect(ctx.miterLimit).toBe(10)
  })

  test('枚举型属性：合法值转发，非法忽略', () => {
    ctx.lineCap = 'round'
    ctx.lineJoin = 'bevel'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.globalCompositeOperation = 'screen'
    expect(ctx.lineCap).toBe('round')
    expect(ctx.lineJoin).toBe('bevel')
    expect(ctx.textAlign).toBe('center')
    expect(ctx.textBaseline).toBe('middle')
    expect(ctx.globalCompositeOperation).toBe('screen')

    // 非法枚举：绕过类型检查模拟 JS 调用方
    ;(ctx as unknown as Record<string, unknown>).lineCap = 'triangle'
    ;(ctx as unknown as Record<string, unknown>).globalCompositeOperation = 'magic'
    expect(ctx.lineCap).toBe('round')
    expect(ctx.globalCompositeOperation).toBe('screen')
  })

  test('font：shorthand 解析为结构化字段；非法忽略', () => {
    ctx.font = 'italic bold 12px/1.5 "Helvetica Neue", serif'
    expect(ctx.font).toBe('italic bold 12px/1.5 "Helvetica Neue", serif')
    expect(callsOf(fake, 'canvasSetFont')).toEqual([
      ['canvasSetFont', id, 'Helvetica Neue', 12, 700, true],
    ])
    ctx.font = 'not a font'
    expect(ctx.font).toBe('italic bold 12px/1.5 "Helvetica Neue", serif')
    expect(callsOf(fake, 'canvasSetFont')).toHaveLength(1)
  })

  test('setLineDash：奇数段复制；负数/非有限丢弃', () => {
    ctx.setLineDash([4, 2, 1])
    expect(ctx.getLineDash()).toEqual([4, 2, 1, 4, 2, 1])
    expect(callsOf(fake, 'canvasSetLineDash').at(-1)).toEqual([
      'canvasSetLineDash',
      id,
      [4, 2, 1, 4, 2, 1],
      0,
    ])
    ctx.setLineDash([-1, 2])
    ctx.setLineDash([NaN])
    expect(ctx.getLineDash()).toEqual([4, 2, 1, 4, 2, 1])
    // getLineDash 返回副本
    const d = ctx.getLineDash()
    d.push(99)
    expect(ctx.getLineDash()).toEqual([4, 2, 1, 4, 2, 1])
  })
})

describe('Canvas2dContext 状态栈与 transform', () => {
  test('save/restore：shadow + native 同步恢复', () => {
    const c = new GpuixCanvas(64, 64, fake)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ff0000'
    ctx.lineWidth = 5
    ctx.save()
    ctx.fillStyle = '#00ff00'
    ctx.lineWidth = 1
    ctx.restore()
    expect(ctx.fillStyle).toBe('#ff0000')
    expect(ctx.lineWidth).toBe(5)
    expect(callsOf(fake, 'canvasSave')).toHaveLength(1)
    expect(callsOf(fake, 'canvasRestore')).toHaveLength(1)
    // 空栈 restore 是 no-op（规范）
    ctx.restore()
    expect(callsOf(fake, 'canvasRestore')).toHaveLength(1)
  })

  test('reset：canvasReset + shadow 归位 + rev bump', () => {
    const c = new GpuixCanvas(64, 64, fake)
    const ctx = c.getContext('2d')!
    let bumps = 0
    c.subscribe(() => bumps++)
    ctx.fillStyle = '#ff0000'
    ctx.save()
    ctx.reset()
    expect(ctx.fillStyle).toBe('#000000')
    expect(bumps).toBe(1)
    ctx.restore() // 栈已清：no-op
    expect(ctx.fillStyle).toBe('#000000')
  })

  test('transform/translate/scale/rotate → canvasTransform；非有限忽略', () => {
    const c = new GpuixCanvas(64, 64, fake)
    const ctx = c.getContext('2d')!
    ctx.translate(10, 20)
    ctx.scale(2, 3)
    ctx.rotate(Math.PI / 2)
    const t = callsOf(fake, 'canvasTransform')
    expect(t[0]).toEqual(['canvasTransform', c.surfaceId, 1, 0, 0, 1, 10, 20])
    expect(t[1]).toEqual(['canvasTransform', c.surfaceId, 2, 0, 0, 3, 0, 0])
    expect(t[2]![2]).toBeCloseTo(0, 6) // cos(π/2)
    expect(t[2]![3]).toBeCloseTo(1, 6) // sin(π/2)
    ctx.transform(NaN, 0, 0, 1, 0, 0)
    expect(callsOf(fake, 'canvasTransform')).toHaveLength(3)

    ctx.setTransform(1, 0, 0, 1, 5, 5)
    expect(callsOf(fake, 'canvasSetTransform')).toEqual([
      ['canvasSetTransform', c.surfaceId, 1, 0, 0, 1, 5, 5],
    ])
    ctx.setTransform({ a: 2 })
    expect(callsOf(fake, 'canvasSetTransform').at(-1)).toEqual([
      'canvasSetTransform',
      c.surfaceId,
      2,
      0,
      0,
      1,
      0,
      0,
    ])
    ctx.resetTransform()
    expect(callsOf(fake, 'canvasResetTransform')).toHaveLength(1)
  })
})

describe('Canvas2dContext 绘制与像素', () => {
  test('像素 op bump rev；path/样式/transform 不 bump', () => {
    const c = new GpuixCanvas(64, 64, fake)
    let bumps = 0
    c.subscribe(() => bumps++)
    const ctx = c.getContext('2d')!

    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(10, 10)
    ctx.fillStyle = '#ff0000'
    ctx.translate(1, 1)
    ctx.clip()
    expect(bumps).toBe(0)

    ctx.fill()
    expect(bumps).toBe(1)
    ctx.stroke()
    expect(bumps).toBe(2)
    ctx.fillRect(0, 0, 8, 8)
    ctx.strokeRect(0, 0, 8, 8)
    ctx.clearRect(0, 0, 8, 8)
    expect(bumps).toBe(5)
    ctx.fillText('hi', 0, 0)
    ctx.strokeText('hi', 0, 0)
    expect(bumps).toBe(7)
    ctx.fillText('', 0, 0) // 空文本 no-op
    expect(bumps).toBe(7)
    ctx.fillRect(0, 0, 0, 10) // 零尺寸 no-op
    expect(bumps).toBe(7)
  })

  test('path 方法转发 + 非有限参数静默返回', () => {
    const c = new GpuixCanvas(64, 64, fake)
    const ctx = c.getContext('2d')!
    ctx.moveTo(NaN, 0)
    ctx.lineTo(Infinity, 0)
    expect(callsOf(fake, 'canvasMoveTo')).toHaveLength(0)
    expect(callsOf(fake, 'canvasLineTo')).toHaveLength(0)
    ctx.moveTo(1, 2)
    ctx.quadraticCurveTo(1, 2, 3, 4)
    ctx.bezierCurveTo(1, 2, 3, 4, 5, 6)
    ctx.rect(0, 0, 5, 5)
    ctx.roundRect(0, 0, 5, 5, 2)
    expect(callsOf(fake, 'canvasMoveTo')[0]).toEqual(['canvasMoveTo', c.surfaceId, 1, 2])
    expect(callsOf(fake, 'canvasQuadraticTo')[0]).toEqual([
      'canvasQuadraticTo',
      c.surfaceId,
      1,
      2,
      3,
      4,
    ])
    expect(callsOf(fake, 'canvasBezierTo')[0]).toEqual([
      'canvasBezierTo',
      c.surfaceId,
      1,
      2,
      3,
      4,
      5,
      6,
    ])
  })

  test('arc：负半径抛 IndexSizeError；非有限返回', () => {
    const c = new GpuixCanvas(64, 64, fake)
    const ctx = c.getContext('2d')!
    ctx.arc(5, 5, NaN, 0, 1)
    expect(callsOf(fake, 'canvasArc')).toHaveLength(0)
    expect(() => ctx.arc(5, 5, -1, 0, 1)).toThrow(DOMException)
    ctx.arc(5, 5, 3, 0, Math.PI, true)
    expect(callsOf(fake, 'canvasArc')).toEqual([
      ['canvasArc', c.surfaceId, 5, 5, 3, 0, Math.PI, true],
    ])
  })

  test('fill/clip 规则转发；非法规则抛 TypeError', () => {
    const c = new GpuixCanvas(64, 64, fake)
    const ctx = c.getContext('2d')!
    ctx.fill('evenodd')
    ctx.clip('nonzero')
    expect(callsOf(fake, 'canvasFill')[0]).toEqual(['canvasFill', c.surfaceId, 'evenodd'])
    expect(callsOf(fake, 'canvasClip')[0]).toEqual(['canvasClip', c.surfaceId, 'nonzero'])
    expect(() => ctx.fill('bogus' as never)).toThrow(TypeError)
  })

  test('getImageData → {data: Uint8ClampedArray, width, height}；零尺寸抛错', () => {
    const c = new GpuixCanvas(64, 64, fake)
    const ctx = c.getContext('2d')!
    const img = ctx.getImageData(1.7, 2.2, 4, 3)
    expect(img.data).toBeInstanceOf(Uint8ClampedArray)
    expect(img.data.length).toBe(4 * 3 * 4)
    expect(img.width).toBe(4)
    expect(img.height).toBe(3)
    expect(img.data[0]).toBe(7) // fake 填充
    expect(callsOf(fake, 'canvasGetImageData')[0]).toEqual([
      'canvasGetImageData',
      c.surfaceId,
      1,
      2,
      4,
      3,
    ])
    expect(() => ctx.getImageData(0, 0, 0, 5)).toThrow(DOMException)
    expect(() => ctx.getImageData(0, 0, 5, NaN)).toThrow(TypeError)
  })

  test('putImageData：全图零拷贝；dirty 矩形裁剪', () => {
    const c = new GpuixCanvas(64, 64, fake)
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(4, 4)
    img.data[0] = 255
    ctx.putImageData(img, 10, 20)
    const put = callsOf(fake, 'canvasPutImageData')
    expect(put[0]![1]).toBe(c.surfaceId)
    expect(put[0]!.slice(2, 6)).toEqual([10, 20, 4, 4])
    expect((put[0]![6] as Buffer)[0]).toBe(255)

    // dirty 子区：源 (1,1) 起 2×2 → 目标 (10+1, 20+1)
    ctx.putImageData(img, 10, 20, 1, 1, 2, 2)
    const p2 = callsOf(fake, 'canvasPutImageData').at(-1)!
    expect(p2.slice(2, 6)).toEqual([11, 21, 2, 2])
    expect((p2[6] as Buffer).length).toBe(2 * 2 * 4)

    // dirty 越界裁剪到源尺寸
    ctx.putImageData(img, 0, 0, 2, 2, 10, 10)
    const p3 = callsOf(fake, 'canvasPutImageData').at(-1)!
    expect(p3.slice(2, 6)).toEqual([2, 2, 2, 2])
  })

  test('measureText 返回近似 metrics 形态', () => {
    const c = new GpuixCanvas(64, 64, fake)
    const ctx = c.getContext('2d')!
    const m = ctx.measureText('hello')
    expect(m.width).toBe(42)
    expect(m.fontBoundingBoxAscent).toBe(9)
    expect(m.fontBoundingBoxDescent).toBe(3)
    expect(m.actualBoundingBoxRight).toBe(42)
  })
})

describe('Canvas2dContext gradient/pattern/drawImage/toDataURL（C7）', () => {
  test('createLinearGradient → fillStyle 转发 spec 对象；getter 返回原对象', () => {
    const c = new GpuixCanvas(64, 64, fake)
    const ctx = c.getContext('2d')!
    const g = ctx.createLinearGradient(0, 0, 64, 0)
    g.addColorStop(0, '#ff0000')
    g.addColorStop(1, 'rgb(0,0,255)')
    ctx.fillStyle = g
    expect(ctx.fillStyle).toBe(g)
    expect(callsOf(fake, 'canvasSetFillStyle')).toEqual([
      [
        'canvasSetFillStyle',
        c.surfaceId,
        {
          kind: 'linear',
          x0: 0,
          y0: 0,
          x1: 64,
          y1: 0,
          stops: [
            { offset: 0, color: '#ff0000' },
            { offset: 1, color: 'rgb(0,0,255)' },
          ],
        },
      ],
    ])
  })

  test('createRadialGradient/createConicGradient 参数校验', () => {
    const c = new GpuixCanvas(64, 64, fake)
    const ctx = c.getContext('2d')!
    expect(() => ctx.createLinearGradient(0, NaN, 1, 1)).toThrow(TypeError)
    expect(() => ctx.createRadialGradient(0, 0, -1, 0, 0, 4)).toThrow(DOMException)
    expect(() => ctx.createConicGradient(NaN, 0, 0)).toThrow(TypeError)
    const g = ctx.createConicGradient(Math.PI, 8, 8)
    g.addColorStop(0.5, '#00ff00')
    ctx.strokeStyle = g
    const call = callsOf(fake, 'canvasSetStrokeStyle').at(-1)!
    expect(call[2]).toMatchObject({
      kind: 'conic',
      angle: Math.PI,
      x: 8,
      y: 8,
    })
  })

  test('addColorStop：越界 → IndexSizeError；非法色 → SyntaxError；NaN → TypeError', () => {
    const c = new GpuixCanvas(64, 64, fake)
    const g = c.getContext('2d')!.createLinearGradient(0, 0, 1, 1)
    expect(() => g.addColorStop(1.5, 'red')).toThrow(DOMException)
    expect(() => g.addColorStop(-0.1, 'red')).toThrow(DOMException)
    expect(() => g.addColorStop(NaN, 'red')).toThrow(TypeError)
    expect(() => g.addColorStop(0.5, 'not a color')).toThrow(DOMException)
  })

  test('createPattern 快照源像素；fillStyle=pattern → canvasSetFillPattern', () => {
    const src = new GpuixCanvas(4, 2, fake)
    const dst = new GpuixCanvas(64, 64, fake)
    const ctx = dst.getContext('2d')!
    const p = ctx.createPattern(src, 'repeat')!
    expect(p.width).toBe(4)
    expect(p.pixels.length).toBe(4 * 2 * 4)
    expect(callsOf(fake, 'canvasGetImageData')).toEqual([
      ['canvasGetImageData', src.surfaceId, 0, 0, 4, 2],
    ])
    ctx.fillStyle = p
    const call = callsOf(fake, 'canvasSetFillPattern').at(-1)!
    expect(call[0]).toBe('canvasSetFillPattern')
    expect(call[1]).toBe(dst.surfaceId)
    expect(call.slice(3)).toEqual([4, 2, 'repeat'])
    // repetition 归一化：null/''/未知 → 'repeat'；合法四值保留
    expect(ctx.createPattern(src, 'repeat-x')!.repetition).toBe('repeat-x')
    expect(ctx.createPattern(src, null)!.repetition).toBe('repeat')
    expect(ctx.createPattern(src, 'bogus')!.repetition).toBe('repeat')
    src.destroy()
    expect(ctx.createPattern(src, 'repeat')).toBeNull()
  })

  test('drawImage：3/5/9 参归一化到 canvasDrawImage；返回值驱动 dirty', () => {
    const src = new GpuixCanvas(10, 20, fake)
    const dst = new GpuixCanvas(64, 64, fake)
    const ctx = dst.getContext('2d')!
    let bumps = 0
    dst.subscribe(() => bumps++)

    ctx.drawImage(src, 1, 2) // 3 参：全源 → (1,2) 原尺寸
    expect(callsOf(fake, 'canvasDrawImage').at(-1)).toEqual([
      'canvasDrawImage',
      dst.surfaceId,
      src.surfaceId,
      0,
      0,
      10,
      20,
      1,
      2,
      10,
      20,
    ])
    expect(bumps).toBe(1)

    ctx.drawImage(src, 1, 2, 30, 40) // 5 参：缩放
    expect(callsOf(fake, 'canvasDrawImage').at(-1)).toEqual([
      'canvasDrawImage',
      dst.surfaceId,
      src.surfaceId,
      0,
      0,
      10,
      20,
      1,
      2,
      30,
      40,
    ])
    expect(bumps).toBe(2)

    ctx.drawImage(src, 1, 2, 3, 4, 5, 6, 7, 8) // 9 参透传
    expect(callsOf(fake, 'canvasDrawImage').at(-1)).toEqual([
      'canvasDrawImage',
      dst.surfaceId,
      src.surfaceId,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
    ])
    expect(bumps).toBe(3)

    // 非有限参数：静默返回，不进 native
    ctx.drawImage(src, NaN, 0)
    expect(bumps).toBe(3)
    // native 报 no-op（false）→ 不 bump
    fake.canvasDrawImage = () => false
    ctx.drawImage(src, 0, 0)
    expect(bumps).toBe(3)
    // 已销毁源 → no-op
    src.destroy()
    ctx.drawImage(src, 0, 0)
    expect(bumps).toBe(3)
  })

  test('imageSmoothingEnabled：默认 true；save/restore 覆盖', () => {
    const c = new GpuixCanvas(64, 64, fake)
    const ctx = c.getContext('2d')!
    expect(ctx.imageSmoothingEnabled).toBe(true)
    ctx.imageSmoothingEnabled = false
    expect(callsOf(fake, 'canvasSetImageSmoothing')).toEqual([
      ['canvasSetImageSmoothing', c.surfaceId, false],
    ])
    ctx.save()
    ctx.imageSmoothingEnabled = true
    ctx.restore()
    expect(ctx.imageSmoothingEnabled).toBe(false)
  })

  test('toDataURL → data:image/png;base64（PNG 字节来自 canvasEncodePng）', () => {
    const c = new GpuixCanvas(8, 8, fake)
    const url = c.toDataURL()
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    const b64 = url.slice('data:image/png;base64,'.length)
    expect(Buffer.from(b64, 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(callsOf(fake, 'canvasEncodePng')).toEqual([['canvasEncodePng', c.surfaceId]])
  })
})

describe('canvas-conformance.json 机器校验', () => {
  // pass/partial → 成员必须存在；no → 必须不存在（防无意宣称兼容）
  test('成员存在性与清单一致', async () => {
    const manifest = (await Bun.file(
      join(import.meta.dir, '../../../../../docs/canvas-conformance.json'),
    ).json()) as Record<string, Record<string, string>>

    const canvas = new GpuixCanvas(8, 8, fake)
    const ctx = canvas.getContext('2d')!
    const check = (obj: object, entries: Record<string, string>) => {
      for (const [name, status] of Object.entries(entries)) {
        const exists = name in obj
        if (status.startsWith('no')) {
          expect(exists, `${name} marked 'no' but exists`).toBe(false)
        } else {
          expect(exists, `${name} marked '${status}' but missing`).toBe(true)
        }
      }
    }
    check(canvas, manifest.element ?? {})
    check(ctx, manifest.properties ?? {})
    check(ctx, manifest.methods ?? {})
  })
})
