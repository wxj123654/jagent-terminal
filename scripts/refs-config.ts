/**
 * scripts/refs-config.ts — .refs 补丁系统的共享配置。
 *
 * patches/ 目录按 OpenWRT/nixpkgs 的 quilt 风格版本化 gpuix/zed 的本地补丁：
 * 上游 pin commit + 主仓库内的 patch 系列 = 可复现的本地依赖
 * （.refs/ 本身保持 gitignore，可随时删除重建）。
 */

import { join } from 'node:path'

export const REPO_ROOT = join(import.meta.dir, '..')
export const REFS_DIR = join(REPO_ROOT, '.refs')

/** gpuix 上游仓库与 pin（浅克隆后 fetch 此 commit 并 detach）。 */
export const GPUIX_REPO = 'https://github.com/remorses/gpuix'
export const GPUIX_PIN = '6b4be86952aa89cfe61bb573740aea33fef5c5c4'

export const GPUIX_DIR = join(REFS_DIR, 'gpuix')
export const ZED_DIR = join(GPUIX_DIR, 'zed')

/** patch 目录（文件名序即 apply 序）。 */
export const PATCHES_DIR = join(REPO_ROOT, 'patches')
export const GPUIX_PATCHES_DIR = join(PATCHES_DIR, 'gpuix')
export const ZED_PATCHES_DIR = join(PATCHES_DIR, 'gpuix-zed')

/** 两个 patch suite：gpuix 主仓与它的 zed 子模块仓。 */
export type Suite = 'gpuix' | 'gpuix-zed'

/**
 * patch 文件 ↔ 源文件映射（export-patches 用；apply 按 manifest 的
 * 键名文件序进行）。一个源文件恰属一个 patch（分组时保证，避免 hunk 拆分）。
 * Suite 显式字面量 + satisfies 统一结构：若用 `keyof typeof MANIFEST` 推导
 * Suite 会与 satisfies 形成循环引用；且不能靠
 * `keyof typeof MANIFEST[suite]` 取键——两个 suite 的键集无交集，
 * keyof (A|B) = never，会把 files 推导成 never。
 */
export type PatchEntry = Readonly<Record<string, readonly string[]>>
export type PatchManifest = Readonly<Record<Suite, PatchEntry>>

export const MANIFEST = {
  gpuix: {
    '0002-jagent-native-seam.patch': [
      'packages/native/src/custom_elements/mod.rs',
      'packages/native/src/custom_elements/input.rs',
      'packages/native/src/lib.rs',
      'packages/native/src/renderer.rs',
      'packages/native/src/style.rs',
      'packages/native/src/test_renderer.rs',
    ],
  },
  'gpuix-zed': {
    '0001-gpui-workspace-root.patch': ['crates/gpui/Cargo.toml'],
    '0002-hide-offscreen-test-window.patch': [
      'crates/gpui/src/app/visual_test_context.rs',
      'crates/gpui_windows/src/window.rs',
    ],
  },
} as const satisfies PatchManifest

export const SUITES: Record<Suite, { gitDir: string; patchDir: string }> = {
  gpuix: { gitDir: GPUIX_DIR, patchDir: GPUIX_PATCHES_DIR },
  'gpuix-zed': { gitDir: ZED_DIR, patchDir: ZED_PATCHES_DIR },
}

/** 按文件名序列出一个 suite 的 patch 文件。 */
export function patchFiles(suite: Suite): string[] {
  return Object.keys(MANIFEST[suite]).sort()
}
/** 跨平台跑命令：非零退出码抛错（带 stdout/stderr）。 */
export async function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${code}\n${out}\n${err}`)
  }
  return { out, err }
}

export async function git(args: string[], opts: { cwd?: string } = {}) {
  return run('git', args, opts)
}
