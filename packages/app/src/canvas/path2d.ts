/**
 * canvas/path2d.ts — Path2D：可复用路径对象。
 *
 * 不持有 Rust 侧副本：每个 path 方法把操作追加为扁平 number op 流，
 * fill/stroke/clip(path) 时整流经一次 napi（Float64Array）交给
 * Rust path_from_ops 解码为 BezPath。op tag 与
 * packages/native/src/canvas/state.rs 的 OP_* 常量一一对应。
 *
 * 当前点/子路径起点的跟踪只为 arcTo（需要 p0）服务；SVG path 字符串
 * 构造与 addPath 的 DOMMatrix transform 不在子集内（显式抛错而非静默）。
 */

const OP_MOVE_TO = 0
const OP_LINE_TO = 1
const OP_QUAD_TO = 2
const OP_CURVE_TO = 3
const OP_CLOSE = 4
const OP_ARC = 5
const OP_ELLIPSE = 6
const OP_RECT = 7
const OP_ROUND_RECT = 8

function finiteAll(...vs: number[]): boolean {
  return vs.every((v) => Number.isFinite(v))
}

/**
 * 与 Rust append_arc 一致的 sweep 归一化（仅为跟踪弧终点用——几何由
 * Rust 权威计算，两边公式必须一致）。
 */
function normalizedEnd(start: number, end: number, anticlockwise: boolean): number {
  const tau = Math.PI * 2
  let sweep = end - start
  if (anticlockwise) {
    if (sweep <= -tau) sweep = -tau
    else if (sweep > 0) sweep = (((sweep % tau) + tau) % tau) - tau
  } else {
    if (sweep >= tau) sweep = tau
    else if (sweep < 0) sweep = ((sweep % tau) + tau) % tau
  }
  return start + sweep
}

export class Path2D {
  private ops: number[] = []
  private buf: Float64Array | null = null
  /** 当前点（_hasPoint=false 表示无子路径）与子路径起点。 */
  private px = 0
  private py = 0
  private hasPoint = false
  private sx = 0
  private sy = 0

  constructor(source?: Path2D | string) {
    if (source instanceof Path2D) {
      this.addPath(source)
    } else if (typeof source === 'string' && source !== '') {
      // 子集不含 SVG path 解析；抛错让库 feature-detect，而不是静默画空。
      throw new TypeError('Path2D: SVG path string is not supported')
    }
  }

  /** context.ts 读取的传输形态；路径被修改时失效重算。 */
  _opsArray(): Float64Array {
    return (this.buf ??= new Float64Array(this.ops))
  }

  private push(...items: number[]): void {
    this.ops.push(...items)
    this.buf = null
  }

  private setPoint(x: number, y: number): void {
    this.px = x
    this.py = y
    this.hasPoint = true
  }

  private startSubpath(x: number, y: number): void {
    this.sx = x
    this.sy = y
    this.setPoint(x, y)
  }

  moveTo(x: number, y: number): void {
    if (!finiteAll(x, y)) return
    this.push(OP_MOVE_TO, x, y)
    this.startSubpath(x, y)
  }

  lineTo(x: number, y: number): void {
    if (!finiteAll(x, y)) return
    this.push(OP_LINE_TO, x, y)
    if (!this.hasPoint) this.startSubpath(x, y)
    else this.setPoint(x, y)
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (!finiteAll(cx, cy, x, y)) return
    this.push(OP_QUAD_TO, cx, cy, x, y)
    if (!this.hasPoint) this.startSubpath(cx, cy)
    this.setPoint(x, y)
  }

  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (!finiteAll(c1x, c1y, c2x, c2y, x, y)) return
    this.push(OP_CURVE_TO, c1x, c1y, c2x, c2y, x, y)
    if (!this.hasPoint) this.startSubpath(c1x, c1y)
    this.setPoint(x, y)
  }

  closePath(): void {
    if (!this.hasPoint) return
    this.push(OP_CLOSE)
    this.setPoint(this.sx, this.sy)
  }

  arc(x: number, y: number, radius: number, start: number, end: number, ccw = false): void {
    const n = [x, y, radius, start, end].map(Number)
    if (!finiteAll(...n)) return
    if (n[2]! < 0) throw new DOMException('arc radius must be non-negative', 'IndexSizeError')
    this.push(OP_ARC, ...n, ccw ? 1 : 0)
    this.trackEllipseEnd(n[0]!, n[1]!, n[2]!, n[2]!, 0, n[3]!, n[4]!, ccw)
  }

  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    ccw = false,
  ): void {
    const n = [x, y, rx, ry, rotation, start, end].map(Number)
    if (!finiteAll(...n)) return
    if (n[2]! < 0 || n[3]! < 0) {
      throw new DOMException('ellipse radii must be non-negative', 'IndexSizeError')
    }
    this.push(OP_ELLIPSE, ...n, ccw ? 1 : 0)
    this.trackEllipseEnd(n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, n[5]!, n[6]!, ccw)
  }

  /** 椭圆参数方程终点 + 弧起点连接语义（弧起点成为子路径起点当且仅当无当前点）。 */
  private trackEllipseEnd(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    rot: number,
    start: number,
    end: number,
    ccw: boolean,
  ): void {
    const ea = normalizedEnd(start, end, ccw)
    const cosR = Math.cos(rot)
    const sinR = Math.sin(rot)
    const ex = cx + rx * Math.cos(ea) * cosR - ry * Math.sin(ea) * sinR
    const ey = cy + rx * Math.cos(ea) * sinR + ry * Math.sin(ea) * cosR
    if (!this.hasPoint) {
      const sx = cx + rx * Math.cos(start) * cosR - ry * Math.sin(start) * sinR
      const sy = cy + rx * Math.cos(start) * sinR + ry * Math.sin(start) * cosR
      this.startSubpath(sx, sy)
    }
    this.setPoint(ex, ey)
  }

  /**
   * 规范 arcTo：p0=当前点，求与 p0p1、p1p2 两线段相切的半径 r 圆弧。
   * 退化为直线（半径 0 / 共线 / 点重合）时等价 lineTo(x1,y1)。
   */
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void {
    const n = [x1, y1, x2, y2, radius].map(Number)
    if (!finiteAll(...n)) return
    if (n[4]! < 0) throw new DOMException('arcTo radius must be non-negative', 'IndexSizeError')
    const [ax, ay, bx, by, r] = n as [number, number, number, number, number]
    if (!this.hasPoint) {
      this.moveTo(ax, ay)
      return
    }
    // 方向单位向量 d1 = p1→p0，d2 = p1→p2
    let d1x = this.px - ax
    let d1y = this.py - ay
    let d2x = bx - ax
    let d2y = by - ay
    const l1 = Math.hypot(d1x, d1y)
    const l2 = Math.hypot(d2x, d2y)
    const cross = d1x * d2y - d1y * d2x
    if (r === 0 || l1 === 0 || l2 === 0 || Math.abs(cross) < 1e-12) {
      this.lineTo(ax, ay)
      return
    }
    d1x /= l1
    d1y /= l1
    d2x /= l2
    d2y /= l2
    const dot = d1x * d2x + d1y * d2y
    const halfSin = Math.sqrt(Math.max(0, (1 - dot) / 2))
    const halfCos = Math.sqrt(Math.max(0, (1 + dot) / 2))
    if (halfSin < 1e-12) {
      this.lineTo(ax, ay)
      return
    }
    // 切点 T1/T2 与圆心 C（角平分线上，|p1C| = r/sin(θ/2)）
    const t = (r * halfCos) / halfSin
    const dist = r / halfSin
    let ux = d1x + d2x
    let uy = d1y + d2y
    const ul = Math.hypot(ux, uy)
    if (ul < 1e-12) {
      this.lineTo(ax, ay)
      return
    }
    ux /= ul
    uy /= ul
    const cx = ax + dist * ux
    const cy = ay + dist * uy
    const t1x = ax + t * d1x
    const t1y = ay + t * d1y
    const t2x = ax + t * d2x
    const t2y = ay + t * d2y
    this.lineTo(t1x, t1y)
    const start = Math.atan2(t1y - cy, t1x - cx)
    const end = Math.atan2(t2y - cy, t2x - cx)
    this.arc(cx, cy, r, start, end, cross > 0)
  }

  rect(x: number, y: number, w: number, h: number): void {
    if (!finiteAll(x, y, w, h)) return
    this.push(OP_RECT, x, y, w, h)
    // 等价于 moveTo(x,y)+三条边+close：结束后当前点回到 (x,y)
    this.startSubpath(x, y)
  }

  /** 与 ctx.roundRect 一致的单半径形态。 */
  roundRect(x: number, y: number, w: number, h: number, radius = 0): void {
    const n = [x, y, w, h, radius].map(Number)
    if (!finiteAll(...n)) return
    this.push(OP_ROUND_RECT, ...n)
    this.startSubpath(x, y)
  }

  /** 规范 addPath 的 transform 参数（DOMMatrix）不在子集内。 */
  addPath(path: Path2D, transform?: unknown): void {
    if (!(path instanceof Path2D)) throw new TypeError('addPath expects a Path2D')
    if (transform !== undefined) {
      throw new TypeError('addPath transform (DOMMatrix) is not supported')
    }
    this.push(...path.ops)
    if (path.hasPoint) {
      this.px = path.px
      this.py = path.py
      this.sx = path.sx
      this.sy = path.sy
      this.hasPoint = true
    }
  }
}
