/**
 * report.mjs — proto vs impl 全状态批量差异报告（pngdiff+region 的批量版）。
 *
 * 用法（仓库根目录）：
 *   node scripts/cmp/report.mjs            # 全部成对状态
 *   node scripts/cmp/report.mjs main git   # 指定 proto 状态名
 *   node scripts/cmp/report.mjs --diff     # 另存 diff 图 .shots/cmp/diff-<state>.png
 *
 * 产物：stdout 表格 + .shots/cmp/report.json（机器可读，喂
 * docs/prototype-react-diff.md 的数据源）。
 *
 * proto/impl 状态名映射见 PAIRS（workspace↔ws 等）。narrow 态 proto 700×800
 * vs impl-narrow-700 700×800，尺寸一致可比。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CMP_DIR, openPage } from './chrome.mjs'

const TH = 24

// [proto 状态, impl 状态（impl-<x>.png / geom-impl-<x>.json 的后缀）]
const PAIRS = [
  ['main', 'main'],
  ['home', 'home'],
  ['chat', 'chat'],
  ['acp', 'acp'],
  ['workspace', 'ws'],
  ['git', 'git'],
  ['settings', 'settings'],
  ['panel', 'panel'],
  ['search', 'search'],
  ['tool', 'tool'],
  ['addws', 'addws'],
  ['errors', 'errors'],
  ['crash', 'crash'],
  ['notif', 'notif'],
  ['font', 'font'],
  ['sess-main', 'sess-main'],
  ['sess-git', 'sess-git'],
  ['sess-file', 'sess-file'],
  ['sess-shell', 'sess-shell'],
  ['sess-add', 'sess-add'],
  ['ctxmenu', 'ctxmenu'],
  ['hidden', 'hidden'],
]

// 与 region.mjs 同分区（1280×800 壳：侧栏 264 / 顶壳 77）
const REGIONS = [
  ['sidebar', 0, 0, 264, 800],
  ['titlebar', 264, 0, 1016, 77],
  ['workpanel', 1000, 77, 280, 723],
  ['main', 264, 77, 736, 723],
]

const argv = process.argv.slice(2)
const only = argv.filter((a) => !a.startsWith('--'))
const wantDiff = argv.includes('--diff')

const implPng = (impl) => join(CMP_DIR, '..', `impl-${impl}${impl === 'narrow' ? '-700' : ''}.png`)
const protoPng = (proto) => join(CMP_DIR, `proto-${proto}.png`)

const jobs = []
for (const [proto, impl] of PAIRS) {
  if (only.length && !only.includes(proto) && !only.includes(impl)) continue
  let a64, b64
  try {
    a64 = 'data:image/png;base64,' + readFileSync(resolve(protoPng(proto))).toString('base64')
    b64 = 'data:image/png;base64,' + readFileSync(resolve(implPng(impl))).toString('base64')
  } catch (e) {
    console.log(`${proto.padEnd(10)} ✗ 缺图：${e.message.split('\n')[0]}`)
    continue
  }
  jobs.push({ proto, impl, a64, b64 })
}

const { browser, page } = await openPage()
try {
  await page.goto('about:blank')
  const results = []
  for (const { proto, impl, a64, b64 } of jobs) {
    const res = await page.evaluate(
      async ({ a64, b64, TH, REGIONS, wantDiff }) => {
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
        const count = (x0, y0, rw, rh, out) => {
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
              const d =
                Math.abs(da.data[i] - db.data[j]) > TH ||
                Math.abs(da.data[i + 1] - db.data[j + 1]) > TH ||
                Math.abs(da.data[i + 2] - db.data[j + 2]) > TH
              if (d) {
                diff++
                if (out) {
                  const k = (y * w + x) * 4
                  out.data[k] = 255
                  out.data[k + 1] = 0
                  out.data[k + 2] = 255
                  out.data[k + 3] = 255
                }
              } else if (out) {
                const k = (y * w + x) * 4
                const g = da.data[i] * 0.3 + da.data[i + 1] * 0.59 + da.data[i + 2] * 0.11
                out.data[k] = g * 0.35
                out.data[k + 1] = g * 0.35
                out.data[k + 2] = g * 0.35
                out.data[k + 3] = 255
              }
            }
          return { diff, total: (x1 - xs) * (y1 - ys) }
        }
        const out = wantDiff ? new ImageData(w, h) : null
        const whole = count(0, 0, w, h, out)
        const regions = {}
        for (const [name, x, y, rw, rh] of REGIONS) {
          const r = count(x, y, rw, rh, null)
          regions[name] = r ? +((r.diff / r.total) * 100).toFixed(2) : null
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
          protoSize: [ia.width, ia.height],
          implSize: [ib.width, ib.height],
          cmpSize: [w, h],
          whole: +((whole.diff / whole.total) * 100).toFixed(2),
          regions,
          diffUrl,
        }
      },
      { a64, b64, TH, REGIONS, wantDiff },
    )
    if (wantDiff && res.diffUrl) {
      writeFileSync(
        join(CMP_DIR, `diff-${proto}.png`),
        Buffer.from(res.diffUrl.split(',')[1], 'base64'),
      )
    }
    delete res.diffUrl
    results.push({ proto, impl, ...res })
    const reg = Object.entries(res.regions)
      .map(([k, v]) => `${k}:${v == null ? '-' : v + '%'}`)
      .join(' ')
    console.log(
      `${proto.padEnd(10)} ${String(res.whole).padStart(6)}%  ${reg}` +
        (res.protoSize[0] !== res.implSize[0] || res.protoSize[1] !== res.implSize[1]
          ? `  ⚠ 尺寸 ${res.protoSize} vs ${res.implSize}`
          : ''),
    )
  }
  writeFileSync(join(CMP_DIR, 'report.json'), JSON.stringify(results, null, 2))
  console.log('\nreport → .shots/cmp/report.json')
} finally {
  await browser.close()
}
