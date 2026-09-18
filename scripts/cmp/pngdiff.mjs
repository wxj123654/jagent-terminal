/**
 * pngdiff.mjs — 逐像素 diff（阈值 24/通道）+ 差异率 + 行/列直方图 + diff 图。
 *
 * 用法（仓库根目录）：
 *   node scripts/cmp/pngdiff.mjs a.png b.png [diff.png] [--rows] [--cols]
 *
 * PNG 解码/编码走 headless Chrome canvas（无 npm 依赖）；两图尺寸不同时
 * 按 min(w,h) 比并报告尺寸差。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { openPage } from './chrome.mjs'

const TH = 24 // 通道差阈值（抗锯齿灰边不计）

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const wantRows = process.argv.includes('--rows')
const wantCols = process.argv.includes('--cols')
const [aPath, bPath, diffPath] = args
if (!aPath || !bPath) {
  console.error('用法: pngdiff.mjs <a.png> <b.png> [diff.png] [--rows] [--cols]')
  process.exit(1)
}

const a64 = 'data:image/png;base64,' + readFileSync(resolve(aPath)).toString('base64')
const b64 = 'data:image/png;base64,' + readFileSync(resolve(bPath)).toString('base64')

const { browser, page } = await openPage()
try {
  await page.goto('about:blank')
  const res = await page.evaluate(
    async ({ a64, b64, TH, wantDiff }) => {
      const load = (src) =>
        new Promise((ok, no) => {
          const im = new Image()
          im.onload = () => ok(im)
          im.onerror = no
          im.src = src
        })
      const [ia, ib] = await Promise.all([load(a64), load(b64)])
      const w = Math.min(ia.width, ib.width)
      const h = Math.min(ia.height, ib.height)
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
      let diff = 0
      const rowDiff = Array.from({ length: h }, () => 0)
      const colDiff = Array.from({ length: w }, () => 0)
      const out = wantDiff ? new ImageData(w, h) : null
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4
          const d =
            Math.abs(da.data[i] - db.data[i]) > TH ||
            Math.abs(da.data[i + 1] - db.data[i + 1]) > TH ||
            Math.abs(da.data[i + 2] - db.data[i + 2]) > TH
          if (d) {
            diff++
            rowDiff[y]++
            colDiff[x]++
          }
          if (out) {
            // diff 图：不同=品红，同=取 A 图灰度压暗（底纹可见差异位置）
            if (d) {
              out.data[i] = 255
              out.data[i + 1] = 0
              out.data[i + 2] = 255
            } else {
              const g = da.data[i] * 0.3 + da.data[i + 1] * 0.59 + da.data[i + 2] * 0.11
              out.data[i] = g * 0.35
              out.data[i + 1] = g * 0.35
              out.data[i + 2] = g * 0.35
            }
            out.data[i + 3] = 255
          }
        }
      }
      let diffUrl = null
      if (out) {
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        c.getContext('2d').putImageData(out, 0, 0)
        diffUrl = c.toDataURL('image/png')
      }
      return {
        w,
        h,
        aw: ia.width,
        ah: ia.height,
        bw: ib.width,
        bh: ib.height,
        diff,
        pct: (diff / (w * h)) * 100,
        rowDiff,
        colDiff,
        diffUrl,
      }
    },
    { a64, b64, TH, wantDiff: !!diffPath },
  )

  console.log(
    `A=${res.aw}×${res.ah}  B=${res.bw}×${res.bh}  比较区=${res.w}×${res.h}` +
      (res.aw !== res.bw || res.ah !== res.bh ? '  ⚠ 尺寸不同，只比重叠区' : ''),
  )
  console.log(`差异像素 ${res.diff} / ${res.w * res.h}  =  ${res.pct.toFixed(2)}%`)
  if (wantRows) {
    const top = res.rowDiff
      .map((n, y) => [n, y])
      .filter(([n]) => n > 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 20)
    console.log('行直方图 top20 (y:diffpx):', top.map(([n, y]) => `${y}:${n}`).join(' '))
  }
  if (wantCols) {
    const top = res.colDiff
      .map((n, x) => [n, x])
      .filter(([n]) => n > 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 20)
    console.log('列直方图 top20 (x:diffpx):', top.map(([n, x]) => `${x}:${n}`).join(' '))
  }
  if (diffPath && res.diffUrl) {
    writeFileSync(resolve(diffPath), Buffer.from(res.diffUrl.split(',')[1], 'base64'))
    console.log('diff 图 →', diffPath)
  }
} finally {
  await browser.close()
}
