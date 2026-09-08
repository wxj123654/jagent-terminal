import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { git, type PatchEntry } from './refs-config'

export interface PatchSuite {
  gitDir: string
  patchDir: string
  manifest: PatchEntry
}

/** Windows CI checkout (core.autocrlf=true) may rewrite patch files to CRLF
 * while `git diff` stays LF; compare on normalized newlines only. */
export function normalizePatchText(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** Read-only inspection shared by setup and export. Never repairs a checkout:
 * old patches and user edits must be distinguished by the person exporting. */
export async function inspectPatchSuite(suite: PatchSuite, comparePatches: boolean = true) {
  const { gitDir, patchDir, manifest } = suite
  const problems: string[] = []
  const diffs: Record<string, string> = {}
  const { out: staged } = await git(['diff', '--cached', '--name-only', '-z'], { cwd: gitDir })
  if (staged) problems.push(`staged changes: ${staged.split('\0').filter(Boolean).join(', ')}`)

  const { out: status } = await git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'],
    { cwd: gitDir },
  )
  const managed = new Set(Object.values(manifest).flat())
  const entries = status.split('\0').filter(Boolean)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    const path = entry.slice(3)
    if (!managed.has(path)) problems.push(`unmanaged change: ${path}`)
    // Porcelain -z emits a second pathname for renames/copies.
    if (/[RC]/.test(entry.slice(0, 2))) i++
  }

  for (const name of readdirSync(patchDir)) {
    if (name.endsWith('.patch') && !(name in manifest)) problems.push(`unmanaged patch: ${name}`)
  }
  for (const name of Object.keys(manifest).sort()) {
    const { out } = await git(
      ['diff', '--no-ext-diff', '--no-textconv', '--', ...manifest[name]!],
      {
        cwd: gitDir,
      },
    )
    diffs[name] = out
    if (comparePatches) {
      const file = Bun.file(join(patchDir, name))
      if (!(await file.exists())) problems.push(`missing patch: ${name}`)
      else if (normalizePatchText(await file.text()) !== normalizePatchText(out)) {
        problems.push(`patch drift: ${name}`)
      }
    }
  }
  return { problems, diffs }
}

/** The zed pin is the gitlink in the pinned gpuix commit, not a second constant. */
export async function inspectRefs(options: {
  pin: string
  gpuix: PatchSuite
  zed: PatchSuite
  requiredFiles: readonly string[]
}): Promise<string[]> {
  const problems: string[] = []
  const { pin, gpuix, zed, requiredFiles } = options
  try {
    const { out: head } = await git(['rev-parse', 'HEAD'], { cwd: gpuix.gitDir })
    if (head.trim() !== pin) problems.push(`gpuix pin mismatch: ${head.trim()}`)
    const { out: tree } = await git(['ls-tree', pin, '--', 'zed'], { cwd: gpuix.gitDir })
    const expectedZed = /^160000 commit ([0-9a-f]+)\tzed\s*$/.exec(tree)?.[1]
    if (!expectedZed) problems.push('missing zed gitlink in gpuix pin')
    const { out: zedHead } = await git(['rev-parse', 'HEAD'], { cwd: zed.gitDir })
    if (zedHead.trim() !== expectedZed) problems.push(`zed pin mismatch: ${zedHead.trim()}`)
    for (const [name, suite] of [
      ['gpuix', gpuix],
      ['gpuix-zed', zed],
    ] as const) {
      const state = await inspectPatchSuite(suite)
      problems.push(...state.problems.map((problem) => `${name}: ${problem}`))
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  for (const path of requiredFiles) {
    if (!existsSync(join(gpuix.gitDir, path))) problems.push(`missing build output: ${path}`)
  }
  return problems
}
