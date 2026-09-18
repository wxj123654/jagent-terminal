/**
 * region.mjs — 分区差异率（把整图 diff% 拆到区域，定位差异位置）。
 *
 * 用法（仓库根目录）：
 *   node scripts/cmp/region.mjs a.png b.png
 *
 * 区域表按 1280×800 壳布局（侧栏 264 / 顶栏 40+36+1 / 工作区剩余）。
 * 图小则区域自动裁到图内。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { openPage } from './chrome.mjs'

const TH = 24

// [名, x, y, w, h]——264 侧栏 + 77 顶壳（toolbar 40 + tabbar 36 + 分隔 1）
const REGIONS = [
  ['侧栏-头', 0, 0, 264, 52],
  ['侧栏-nav', 0, 52, 264, 64],
  ['侧栏-列表', 0, 116, 264, 640],
  ['侧栏-脚', 0, 756, 264, 44],
  ['顶栏-主行', 264, 0, 1016, 40],
  ['顶栏-tab行', 264, 40, 1016, 37],
  ['工作面板区', 1000, 77, 280, 723],
  ['主区', 264, 77, 736, 723],
]

const [aPath, bPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (!aPath || !bPath) {
  console.error('用法: region.mjs <a.png> <b.png>')
  process.exit(1)
}
const a64 = 'data:image/png;base64,' + readFileSync(resolve(aPath)).toString('base64')
const b64 = 'data:image/png;base64,' + readFileSync(resolve(bPath)).toString('base64')

const { browser, page } = await openPage()
try {
  await page.goto('about:blank')
  const res = await page.evaluate(
    async ({ a64, b64, TH, REGIONS }) => {
      const load = (src) =>
        new Promise((ok, no) => {
          const im = new Image()
          im.onload = () => ok(im)
          im.onerror = no
          im.src = src
        })
      const [ia, ib] = await Promise.all([load(a64), load(b64)])
      const draw = (im) => {
        const c = document.createElement('canvas')
        c.width = im.width
        c.height = im.height
        const g = c.getContext('2d', { willReadFrequently: true })
        g.drawImage(im, 0, 0)
        return g.getImageData(0, 0, im.width, im.height)
      }
      const da = draw(ia),
        db = draw(ib)
      const w = Math.min(ia.width, ib.width)
      const h = Math.min(ia.height, ib.height)
      const pct = (x0, y0, rw, rh) => {
        const x1 = Math.min(x0 + rw, w),
          y1 = Math.min(y0 + rh, h)
        const xs = Math.max(x0, 0),
          ys = Math.max(y0, 0)
        if (x1 <= xs || y1 <= ys) return null
        let diff = 0
        for (let y = ys; y < y1; y++)
          for (let x = xs; x < x1; x++) {
            const i = (y * ia.width + x) * 4
            const j = (y * ib.width + x) * 4
            if (
              Math.abs(da.data[i] - db.data[j]) > TH ||
              Math.abs(da.data[i + 1] - db.data[j + 1]) > TH ||
              Math.abs(da.data[i + 2] - db.data[j + 2]) > TH
            )
              diff++
          }
        return { diff, total: (x1 - xs) * (y1 - ys), pct: (diff / ((x1 - xs) * (y1 - ys))) * 100 }
      }
      return {
        size: [ia.width, ia.height, ib.width, ib.height],
        regions: REGIONS.map(([name, x, y, rw, rh]) => ({ name, ...pct(x, y, rw, rh) })),
        whole: pct(0, 0, w, h),
      }
    },
    { a64, b64, TH, REGIONS },
  )
  console.log(`尺寸 A=${res.size[0]}×${res.size[1]} B=${res.size[2]}×${res.size[3]}`)
  console.log(`整图  ${res.whole.pct.toFixed(2)}%`)
  for (const r of res.regions)
    if (r.pct != null)
      console.log(`${r.name.padEnd(8)} ${r.pct.toFixed(2).padStart(6)}%  (${r.diff}px)`)
} finally {
  await browser.close()
}
