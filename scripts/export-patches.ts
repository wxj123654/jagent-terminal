/**
 * scripts/export-patches.ts — .refs 工作树改动 → patches/ 目录（防漂移）。
 *
 * 日常流程：改 .refs/gpuix（或 .refs/gpuix/zed）源码 → 测试通过 →
 *   bun run export-patches
 * manifest 映射内的文件改动会重写进对应 .patch 文件；映射外的新改动文件
 * 会报错并列出（先在 refs-config.ts 的 MANIFEST 里登记新 patch 分组再导出）。
 *
 * --check：只校验不写文件（工作树 diff 应与 patch 文件一致；CI 可用）。
 */

import { MANIFEST, SUITES, Suite, PatchEntry, git, patchFiles } from './refs-config'

const CHECK_ONLY = process.argv.includes('--check')

async function changedFiles(cwd: string): Promise<Set<string>> {
  // porcelain：工作树对 HEAD 的全部修改（本系统无 staged 中间态约定）
  const { out } = await git(['status', '--porcelain', '--ignore-submodules=all'], { cwd })
  const files = new Set<string>()
  for (const line of out.split('\n')) {
    if (!line) continue
    const path = line.slice(3).trim()
    if (path) files.add(path)
  }
  return files
}

async function main() {
  let dirty = false

  for (const suite of Object.keys(SUITES) as Suite[]) {
    const { gitDir, patchDir } = SUITES[suite]
    // 统一结构类型取用（见 refs-config PatchEntry 注释：直接 keyof 联合会得 never）
    const manifest: PatchEntry = MANIFEST[suite]
    const managed = new Set(Object.values(manifest).flat())
    const actual = await changedFiles(gitDir)

    // 映射外的修改文件 → 报错（漂移检测）
    const unmanaged = [...actual].filter((f) => !managed.has(f))
    if (unmanaged.length > 0) {
      console.error(
        `[export-patches] ✗ ${suite}：以下文件有改动但不在 MANIFEST 映射内（先在 scripts/refs-config.ts 登记新 patch 分组）：\n  ${unmanaged.join('\n  ')}`,
      )
      dirty = true
      continue
    }
    // 映射内但工作树无改动的文件 → patch 会导出为空（合法：补丁被上游吸收时）
    const empty = [...managed].filter((f) => !actual.has(f))
    if (empty.length > 0) {
      console.warn(
        `[export-patches] ⚠ ${suite}：映射内文件无工作树改动（补丁为空文件或部分为空）：\n  ${empty.join('\n  ')}`,
      )
    }

    for (const p of patchFiles(suite)) {
      const files: readonly string[] = manifest[p]!
      const { out: diff } = await git(['diff', '--', ...files], { cwd: gitDir })
      if (CHECK_ONLY) {
        const existing = await Bun.file(`${patchDir}/${p}`).text()
        if (existing.trim() !== diff.trim()) {
          console.error(`[export-patches] ✗ ${suite}/${p} 与工作树不一致（需重新导出）`)
          dirty = true
        }
      } else {
        await Bun.write(`${patchDir}/${p}`, diff)
        console.log(`[export-patches] ${suite}/${p} ← ${files.length} 文件（${diff.length} 字节）`)
      }
    }
  }

  if (CHECK_ONLY) {
    if (dirty) {
      console.error('[export-patches] --check 失败：patch 目录与 .refs 工作树漂移')
      process.exit(1)
    }
    console.log('[export-patches] --check 通过：patch 目录与工作树一致')
  }
}

main().catch((err) => {
  console.error(`[export-patches] 失败：${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
