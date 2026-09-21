/**
 * probe-dom.mjs — 任意选择器几何探测（终端打印，不落盘）。
 *
 * 用法（仓库根目录）：
 *   node scripts/cmp/probe-dom.mjs ".t-row" ".ws-head"
 *   node scripts/cmp/probe-dom.mjs --view=tool ".tool-row"
 *   node scripts/cmp/probe-dom.mjs --view=sess-file ".file-pathbar"
 */

import { DEFAULT_PORT, ensureDevServer, killChild, openPage } from './chrome.mjs'

const args = process.argv.slice(2)
const viewIdx = args.indexOf('--view')
const view = viewIdx >= 0 ? args[viewIdx + 1] : null
const sels = args.filter((a, i) => !a.startsWith('--') && i !== viewIdx + 1)
if (!sels.length) {
  console.error('用法: probe-dom.mjs [--view=<v>] <selector...>')
  process.exit(1)
}
const port = Number(process.env.PORT ?? DEFAULT_PORT)

const { base, child } = await ensureDevServer(port)
const { browser, page } = await openPage()
try {
  await page.goto(`${base}/${view ? `?view=${view}` : ''}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(350)
  const rows = await page.evaluate((sels) => {
    const app = document.querySelector('#app')
    const o = app ? app.getBoundingClientRect() : { left: 0, top: 0 }
    const out = []
    for (const sel of sels) {
      let els
      try {
        els = document.querySelectorAll(sel)
      } catch (e) {
        out.push({ sel, err: String(e) })
        continue
      }
      if (!els.length) out.push({ sel, err: '0 matches' })
      els.forEach((el, i) => {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        out.push({
          sel,
          i,
          x: +(r.left - o.left).toFixed(1),
          y: +(r.top - o.top).toFixed(1),
          w: +r.width.toFixed(1),
          h: +r.height.toFixed(1),
          bg: cs.backgroundColor,
          color: cs.color,
          fs: cs.fontSize,
          text: (el.childElementCount === 0 ? (el.textContent ?? '') : '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 40),
        })
      })
    }
    return out
  }, sels)
  for (const r of rows) {
    if (r.err) console.log(`${r.sel}  ✗ ${r.err}`)
    else
      console.log(
        `${r.sel}[${r.i}]  x=${r.x} y=${r.y} w=${r.w} h=${r.h}  bg=${r.bg} fs=${r.fs} ${r.text ? `"${r.text}"` : ''}`,
      )
  }
} finally {
  await browser.close()
  await killChild(child)
}
