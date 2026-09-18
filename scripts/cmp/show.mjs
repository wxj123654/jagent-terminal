/**
 * show.mjs — geom JSON 紧凑表格；给两个文件则按 sel+i 并置 proto vs impl。
 *
 * 用法：
 *   node scripts/cmp/show.mjs .shots/cmp/geom-proto-main.json
 *   node scripts/cmp/show.mjs .shots/cmp/geom-proto-main.json .shots/cmp/geom-impl-main.json
 *   node scripts/cmp/show.mjs <proto.json> <impl.json> ".t-row"   # 只看某选择器
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [pa, pb, filter] = process.argv.slice(2)
if (!pa) {
  console.error('用法: show.mjs <geom-a.json> [geom-b.json] [selFilter]')
  process.exit(1)
}
const A = JSON.parse(readFileSync(resolve(pa), 'utf8'))
const B = pb ? JSON.parse(readFileSync(resolve(pb), 'utf8')) : null

const key = (n) => `${n.sel ?? n.type}#${n.i ?? n.path}`
const row = (n) =>
  n
    ? `${String(n.x).padStart(6)},${String(n.y).padEnd(6)} ${String(n.w).padStart(6)}×${String(n.h).padEnd(6)} ${n.fs ?? ''} ${(n.text ?? n.testId ?? '').slice(0, 28)}`
    : '      —'

if (!B) {
  for (const n of A)
    if (!filter || key(n).includes(filter)) console.log(`${key(n).padEnd(28)} ${row(n)}`)
} else {
  const bMap = new Map(B.map((n) => [key(n), n]))
  const seen = new Set()
  for (const a of A) {
    const k = key(a)
    if (filter && !k.includes(filter)) continue
    const b = bMap.get(k)
    if (b) seen.add(k)
    const mark = b ? '' : '  (impl 缺)'
    console.log(`${k.padEnd(28)} P:${row(a)}\n${''.padEnd(28)} I:${row(b)}${mark}`)
  }
  for (const b of B) {
    const k = key(b)
    if (seen.has(k) || (filter && !k.includes(filter))) continue
    if (!bMap.has(k) || A.some((a) => key(a) === k)) continue
    console.log(`${k.padEnd(28)} P:      —\n${''.padEnd(28)} I:${row(b)}  (proto 缺)`)
  }
}
