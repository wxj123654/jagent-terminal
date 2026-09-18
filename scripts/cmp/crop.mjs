/**
 * crop.mjs — 同区域左右拼接放大图（左=a 右=b，中缝 1px 品红，人工核对用）。
 *
 * 用法（仓库根目录）：
 *   node scripts/cmp/crop.mjs a.png b.png out.png <x> <y> <w> <h> [scale]
 * 例：node scripts/cmp/crop.mjs .shots/cmp/proto-main.png .shots/impl-main.png \
 *       .shots/cmp/z-list.png 0 145 264 180 3
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { openPage } from './chrome.mjs'

const [aPath, bPath, outPath, sx, sy, sw, sh, sc] = process.argv.slice(2)
if (!aPath || !bPath || !outPath || sx == null) {
  console.error('用法: crop.mjs <a.png> <b.png> <out.png> <x> <y> <w> <h> [scale=3]')
  process.exit(1)
}
const [x, y, w, h, scale] = [+sx, +sy, +sw, +sh, +(sc ?? 3)]

const a64 = 'data:image/png;base64,' + readFileSync(resolve(aPath)).toString('base64')
const b64 = 'data:image/png;base64,' + readFileSync(resolve(bPath)).toString('base64')

const { browser, page } = await openPage()
try {
  await page.goto('about:blank')
  const url = await page.evaluate(
    async ({ a64, b64, x, y, w, h, scale }) => {
      const load = (src) =>
        new Promise((ok, no) => {
          const im = new Image()
          im.onload = () => ok(im)
          im.onerror = no
          im.src = src
        })
      const [ia, ib] = await Promise.all([load(a64), load(b64)])
      const c = document.createElement('canvas')
      c.width = w * 2 * scale + scale
      c.height = h * scale
      const g = c.getContext('2d')
      g.imageSmoothingEnabled = false // 放大保持像素硬边
      g.drawImage(ia, x, y, w, h, 0, 0, w * scale, h * scale)
      g.fillStyle = '#f0f'
      g.fillRect(w * scale, 0, scale, h * scale)
      g.drawImage(ib, x, y, w, h, w * scale + scale, 0, w * scale, h * scale)
      return c.toDataURL('image/png')
    },
    { a64, b64, x, y, w, h, scale },
  )
  writeFileSync(resolve(outPath), Buffer.from(url.split(',')[1], 'base64'))
  console.log('拼接图 →', outPath, `(左=${aPath} 右=${bPath} ${scale}x)`)
} finally {
  await browser.close()
}
