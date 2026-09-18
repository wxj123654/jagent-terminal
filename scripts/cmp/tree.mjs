/**
 * tree.mjs — geom-impl JSON（proto-shot.mjs --geom 产物）缩进树打印。
 *
 * 用法：node scripts/cmp/tree.mjs .shots/cmp/geom-impl-main.json [filterSubstr]
 * filterSubstr 命中（path/type/testId/text）则打印该节点及其祖先链。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [file, filter] = process.argv.slice(2)
if (!file) {
  console.error('用法: tree.mjs <geom.json> [filterSubstr]')
  process.exit(1)
}
const nodes = JSON.parse(readFileSync(resolve(file), 'utf8'))

const fmt = (n) =>
  `${n.type}${n.testId ? `#${n.testId}` : ''} ${n.x},${n.y} ${n.w}×${n.h}` +
  `${n.text ? ` "${String(n.text).slice(0, 30)}"` : ''}`

if (!filter) {
  for (const n of nodes) console.log('  '.repeat(n.depth) + fmt(n))
} else {
  const hit = new Set()
  nodes.forEach((n, i) => {
    if (`${n.path} ${n.type} ${n.testId} ${n.text}`.includes(filter)) {
      // 命中节点 + 祖先链（path 前缀）+ 直接子级
      const parts = n.path.split('/').filter(Boolean)
      for (let d = 0; d <= parts.length; d++) {
        const prefix = parts.slice(0, d).join('/')
        const idx = nodes.findIndex(
          (m) => m.path === (prefix ? `/${prefix}` : '') || m.path === prefix,
        )
        if (idx >= 0) hit.add(idx)
      }
      hit.add(i)
      nodes.forEach((m, j) => {
        if (m.path.startsWith(n.path === '' ? '/' : n.path + '/')) hit.add(j)
      })
    }
  })
  for (const [i, n] of nodes.entries()) if (hit.has(i)) console.log('  '.repeat(n.depth) + fmt(n))
}
