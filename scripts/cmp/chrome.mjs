/**
 * chrome.mjs — cmp 工具链共享层（shot-proto / geom-proto / probe-dom /
 * pngdiff / region / crop 共用）。
 *
 * - playwright-core 从 design/prototype-react 的 node_modules 解析（仓库根
 *   未装该依赖——它是原型工程的 devDependency，唯一已装副本）。
 * - 系统 Chrome（channel:'chrome'），与 design/prototype-react/smoke.mjs 同款。
 * - vite dev server 不在跑时自动拉起（bun run dev --strictPort），脚本结束
 *   时回收；已在跑则复用不动。
 * - 规范化三件事（docs/prototype-visual-diff.md）：隐 #demo、去 focus ring、
 *   窗口<视口时剥 #app 的 border/radius/shadow。
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

export const PROTO_DIR = resolve(import.meta.dirname, '..', '..', 'design', 'prototype-react')
export const SHOTS_DIR = resolve(import.meta.dirname, '..', '..', '.shots')
export const CMP_DIR = resolve(SHOTS_DIR, 'cmp')
export const DEFAULT_PORT = 5199

const require = createRequire(resolve(PROTO_DIR, 'package.json'))
const { chromium } = require('playwright-core')

/** 等 vite dev server 就绪（已在跑则秒回）。返回需要回收的子进程或 null。 */
export async function ensureDevServer(port = DEFAULT_PORT) {
  const base = `http://localhost:${port}`
  try {
    await fetch(base, { signal: AbortSignal.timeout(1500) })
    return { base, child: null } // 已在跑——复用
  } catch {
    /* 没在跑 → 拉起 */
  }
  const child = spawn('bun', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: PROTO_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Windows: detached + 结束时 taskkill 树杀（bun 包装的 vite 需整树）
  })
  const deadline = Date.now() + 30_000
  let lastErr = ''
  child.stderr?.on('data', (d) => (lastErr += d))
  while (Date.now() < deadline) {
    try {
      await fetch(base, { signal: AbortSignal.timeout(1000) })
      return { base, child }
    } catch {
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  child.kill()
  throw new Error(`vite dev server 30s 未就绪（port ${port}）：${lastErr.slice(-500)}`)
}

/** 起浏览器 + 页面（1280×800 视口）。 */
export async function openPage() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  return { browser, page, errors }
}

/** 规范化注入：#demo 隐藏、focus ring 清零、#app 窗壳装饰剥掉。 */
export async function normalize(page) {
  await page.addStyleTag({
    content: `
      #demo{display:none!important}
      *:focus{outline:none!important}
      *:focus-visible{outline:none!important;box-shadow:none!important}
      #app{border:none!important;border-radius:0!important;box-shadow:none!important}
    `,
  })
}

/** #app 矩形（窗口坐标系=页面视口；截图 clip 与 geom 原点都靠它）。 */
export async function appRect(page) {
  return page.locator('#app').boundingBox()
}

/** 截图裁到 #app 盒（窗口<视口的 narrow 态也拿到窗口尺寸的 PNG）。 */
export async function shotApp(page, outPath) {
  const box = await appRect(page)
  if (!box) throw new Error('#app not found')
  await page.screenshot({ path: outPath, clip: box })
}

export async function killChild(child) {
  if (!child) return
  try {
    child.kill('SIGTERM')
  } catch {}
  // Windows SIGTERM 对 bun spawn 的 vite 子孙不一定整树死——补 taskkill
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    } catch {}
  }
}
