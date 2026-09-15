/**
 * scripts/fix-element-bounds.ts — getElementBounds 返回类型迁移 codemod。
 *
 * 上游 eac7181 把 getElementBounds 从 number[] ([x,y,w,h]) 改成
 * ElementBounds {x,y,width,height}。本脚本：
 *   1. 收集每个文件中 `= ...getElementBounds(...)` 赋值出的变量名；
 *   2. 把这些变量的 [0]/[1]/[2]/[3] 下标访问改成 .x/.y/.width/.height；
 *   3. RangeInput.tsx 的鸭子类型签名 + Array.isArray 检查单独处理。
 *
 * 用法：bun run scripts/fix-element-bounds.ts [--write]
 *   默认 dry-run 打印改动；--write 落盘。
 *
 * 注意：源码里避免连续两个反斜杠字面量（write/heredoc 管道会折叠），
 * 用 BS 常量代替。
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const WRITE = process.argv.includes('--write')
const ROOT = join(import.meta.dir, '..')
const PROP = ['x', 'y', 'width', 'height'] as const
const BS = String.fromCharCode(92) // 反斜杠，避开字面量折叠问题

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') yield* walk(p)
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      yield p
    }
  }
}

let touched = 0
for (const dir of ['packages/app/src', 'packages/ui/src', 'e2e']) {
  for (const file of walk(join(ROOT, dir))) {
    let src = readFileSync(file, 'utf8')
    if (!src.includes('getElementBounds')) continue

    // 1. 变量名收集：const b = ...getElementBounds(...) / let / 赋值
    const vars = new Set<string>()
    for (const m of src.matchAll(
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^=\n]*getElementBounds/g,
    )) {
      vars.add(m[1]!)
    }
    if (vars.size === 0) continue

    // 2. 下标 → 属性（仅收集到的变量；[0]..[3]）
    let changed = src
    for (const v of vars) {
      const esc = v.replace(/[$]/g, BS + '$&')
      const re = new RegExp(BS + 'b' + esc + '(!?)' + BS + '[([0-3])' + BS + ']', 'g')
      changed = changed.replace(re, (_all, bang: string, idx: string) => {
        return `${v}${bang}.${PROP[Number(idx)]}`
      })
    }

    if (changed !== src) {
      touched++
      console.log(
        `${WRITE ? 'WRITE' : 'DIFF '} ${file.replace(ROOT + '\\', '')}  vars: ${[...vars].join(', ')}`,
      )
      if (WRITE) writeFileSync(file, changed)
      src = changed
    }
  }
}
console.log(touched ? `${touched} file(s) ${WRITE ? 'updated' : 'would change'}` : 'no changes')
