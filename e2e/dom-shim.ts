/**
 * e2e/dom-shim.ts — canvas 库（uPlot 1.6）静态渲染路径需要的最小 DOM 环境。
 *
 * 这不是浏览器 DOM，只为 e2e 验收服务：布局信息恒零（getBoundingClientRect
 * 返回 0,0 起点的矩形）、事件只存不发（没有真实交互）、style 是属性袋。
 * 'canvas' 标签返回包裹 GpuixCanvas 的节点——width/height 直通 backing
 * store，getContext('2d') 返回真 ctx。installDomShim() 必须在 import 库
 * 之前调用（uPlot 在模块加载期探测 window/document/devicePixelRatio）。
 */

import { GpuixCanvas } from '../packages/app/src/canvas/gpuixCanvas'

type Listener = (...args: unknown[]) => void

class ShimTextNode {
  constructor(public nodeValue: string) {}
}

export class ShimElement {
  readonly tagName: string
  parentNode: ShimElement | null = null
  readonly children: ShimElement[] = []
  /** uPlot 只写不读（el.style[name] = '…px'），普通对象袋即可。 */
  readonly style: Record<string, string> = {}
  private readonly classes = new Set<string>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private textNode: ShimTextNode | null = null

  readonly classList = {
    contains: (c: string) => this.classes.has(c),
    add: (c: string) => {
      this.classes.add(c)
    },
    remove: (c: string) => {
      this.classes.delete(c)
    },
  }

  constructor(tag: string) {
    this.tagName = tag.toUpperCase()
  }

  appendChild<T extends ShimElement>(el: T): T {
    el.remove()
    el.parentNode = this
    this.children.push(el)
    return el
  }

  insertBefore<T extends ShimElement>(el: T, ref: ShimElement | ShimTextNode | null): T {
    const i = ref instanceof ShimElement ? this.children.indexOf(ref) : -1
    if (i < 0) return this.appendChild(el)
    el.remove()
    el.parentNode = this
    this.children.splice(i, 0, el)
    return el
  }

  remove(): void {
    const p = this.parentNode
    if (p) {
      const i = p.children.indexOf(this)
      if (i >= 0) p.children.splice(i, 1)
      this.parentNode = null
    }
  }

  /** td.firstChild.nodeValue = '…' 写入路径（uPlot legend）。 */
  get firstChild(): ShimElement | ShimTextNode | null {
    return this.textNode ?? this.children[0] ?? null
  }

  get textContent(): string {
    return this.textNode?.nodeValue ?? ''
  }
  set textContent(v: string) {
    this.children.length = 0
    this.textNode = new ShimTextNode(String(v))
  }

  addEventListener(ev: string, cb: Listener): void {
    let set = this.listeners.get(ev)
    if (!set) this.listeners.set(ev, (set = new Set()))
    set.add(cb)
  }

  removeEventListener(ev: string, cb: Listener): void {
    this.listeners.get(ev)?.delete(cb)
  }

  dispatchEvent(ev: { type: string }): boolean {
    for (const cb of this.listeners.get(ev.type) ?? []) cb(ev)
    return true
  }

  /** 布局恒零：静态验收路径只消费 left/top/width/height。 */
  getBoundingClientRect(): {
    left: number
    top: number
    right: number
    bottom: number
    width: number
    height: number
    x: number
    y: number
  } {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }
  }
}

export class ShimCanvasElement extends ShimElement {
  /** 库画的那块真 surface；断言像素从这里读。 */
  readonly gpuix: GpuixCanvas

  constructor() {
    super('canvas')
    this.gpuix = new GpuixCanvas(300, 150)
  }

  getContext(mode: '2d' | string, options?: unknown) {
    return this.gpuix.getContext(mode, options)
  }

  get width(): number {
    return this.gpuix.width
  }
  set width(v: number) {
    this.gpuix.width = v
  }

  get height(): number {
    return this.gpuix.height
  }
  set height(v: number) {
    this.gpuix.height = v
  }

  toDataURL(type?: string): string {
    return this.gpuix.toDataURL(type)
  }
}

export interface DomShim {
  window: Record<string, unknown>
  document: { createElement(tag: string): ShimElement }
  uninstall(): void
}

const GLOBALS = [
  'window',
  'document',
  'navigator',
  'devicePixelRatio',
  'matchMedia',
  'CustomEvent',
  'HTMLElement',
] as const

/**
 * 安装全局 DOM 垫片并返回句柄（uninstall 恢复/删除原值）。
 * 只覆盖缺失的全局；已存在的（如 bun 的 navigator/CustomEvent）原样保留，
 * 不足字段就地补齐（navigator.language）。
 */
export function installDomShim(): DomShim {
  const g = globalThis as Record<string, unknown>
  const saved = new Map<string, unknown>()

  const winListeners = new Map<string, Set<Listener>>()
  const shimWindow = {
    devicePixelRatio: 1,
    addEventListener: (ev: string, cb: Listener) => {
      let set = winListeners.get(ev)
      if (!set) winListeners.set(ev, (set = new Set()))
      set.add(cb)
    },
    removeEventListener: (ev: string, cb: Listener) => {
      winListeners.get(ev)?.delete(cb)
    },
    dispatchEvent: (ev: { type: string }) => {
      for (const cb of winListeners.get(ev.type) ?? []) cb(ev)
      return true
    },
    matchMedia: (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  }

  const shimDocument = {
    createElement: (tag: string): ShimElement =>
      tag === 'canvas' ? new ShimCanvasElement() : new ShimElement(tag),
  }

  class ShimCustomEvent {
    readonly type: string
    readonly detail: unknown
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type
      this.detail = init?.detail
    }
  }

  const installs: Record<string, unknown> = {
    window: shimWindow,
    document: shimDocument,
    devicePixelRatio: 1,
    matchMedia: shimWindow.matchMedia,
    CustomEvent: ShimCustomEvent,
    HTMLElement: ShimElement,
  }

  for (const key of GLOBALS) {
    if (key === 'navigator') continue
    saved.set(key, g[key])
    if (installs[key] !== undefined || !(key in g)) g[key] = installs[key]
  }
  if (!('navigator' in g) || g.navigator == null) {
    saved.set('navigator', undefined)
    g.navigator = { language: 'en-US' }
  } else if (typeof (g.navigator as { language?: string }).language !== 'string') {
    // bun 的 navigator 只有 userAgent：补 language（Intl.NumberFormat 用）
    const nav = g.navigator as { language?: string }
    saved.set('navigator.language', nav.language)
    nav.language = 'en-US'
  }

  return {
    window: shimWindow,
    document: shimDocument,
    uninstall: () => {
      for (const [key, prev] of saved) {
        if (key === 'navigator.language') {
          ;(g.navigator as { language?: string }).language = prev as string | undefined
        } else if (prev === undefined) {
          delete g[key]
        } else {
          g[key] = prev
        }
      }
    },
  }
}
