/**
 * scripts/setup-refs.ts — 一条命令重建 .refs/gpuix（含本地补丁与 @gpuix/react dist）。
 *
 * 幂等：.refs/gpuix 已存在且 pin/补丁就位时快速通过；--force 删除重建。
 *
 * 流程（README「构建准备」的脚本化）：
 *   1. git clone --depth 1 https://github.com/remorses/gpuix .refs/gpuix
 *   2. git fetch --depth 1 origin <GPUIX_PIN> && git checkout --detach <pin>
 *      （上游 main 会前移，必须显式 pin——GitHub 支持按任意 SHA 浅取）
 *   3. git apply patches/gpuix/*.patch（文件名序；0001 改 .gitmodules 的
 *      shallow=true 必须先于 submodule update 生效）
 *   4. git submodule update --init --depth 1 zed
 *      （zed pin 由 gpuix 仓库记录的 submodule SHA 决定 = 8b94def…）
 *   5. git -C zed apply patches/gpuix-zed/*.patch
 *   6. bun install && bun run build:react（产出 packages/react/dist）
 *
 * 用法：bun run setup-refs [--force]
 */

import { existsSync, rmSync } from 'node:fs'
import {
  GPUIX_DIR,
  GPUIX_PATCHES_DIR,
  GPUIX_PIN,
  GPUIX_REPO,
  ZED_PATCHES_DIR,
  git,
  patchFiles,
  run,
} from './refs-config'

const FORCE = process.argv.includes('--force')

async function isPatchedApplied(): Promise<boolean> {
  // apply 后工作树必然有修改；再抽查 patch 文件数 vs git diff 文件数
  const { out: status } = await git(['status', '--short'], { cwd: GPUIX_DIR })
  return status.trim().length > 0
}

async function main() {
  if (existsSync(GPUIX_DIR)) {
    if (FORCE) {
      console.log('[setup-refs] --force：删除 .refs/gpuix 重建…')
      rmSync(GPUIX_DIR, { recursive: true, force: true })
    } else {
      const { out: headOut } = await git(['rev-parse', 'HEAD'], { cwd: GPUIX_DIR })
      const head = headOut.trim()
      if (head === GPUIX_PIN && (await isPatchedApplied())) {
        console.log(
          `[setup-refs] .refs/gpuix 已就位（pin ${head.slice(0, 7)}，补丁已应用），跳过。`,
        )
        console.log('[setup-refs] 如需重建：bun run setup-refs -- --force')
        return
      }
      console.log(
        `[setup-refs] .refs/gpuix 存在但状态不符（HEAD ${head.slice(0, 7)}），请先手动处理或用 --force 重建。`,
      )
      process.exit(1)
    }
  }

  console.log(`[setup-refs] ① clone ${GPUIX_REPO}（浅）…`)
  await git(['clone', '--depth', '1', GPUIX_REPO, GPUIX_DIR])

  console.log(`[setup-refs] ② pin 到 ${GPUIX_PIN.slice(0, 7)}…`)
  await git(['fetch', '--depth', '1', 'origin', GPUIX_PIN], { cwd: GPUIX_DIR })
  await git(['checkout', '--detach', GPUIX_PIN], { cwd: GPUIX_DIR })

  console.log('[setup-refs] ③ 应用 gpuix 主仓补丁…')
  for (const p of patchFiles('gpuix')) {
    console.log(`        ${p}`)
    await git(['apply', '--ignore-whitespace', `${GPUIX_PATCHES_DIR}/${p}`], { cwd: GPUIX_DIR })
  }

  console.log('[setup-refs] ④ 初始化 zed 子模块（浅，pin 由 gpuix 记录）…')
  await git(['submodule', 'update', '--init', '--depth', '1', 'zed'], { cwd: GPUIX_DIR })

  console.log('[setup-refs] ⑤ 应用 zed 子仓补丁…')
  for (const p of patchFiles('gpuix-zed')) {
    console.log(`        ${p}`)
    await git(['apply', '--ignore-whitespace', `${ZED_PATCHES_DIR}/${p}`], {
      cwd: `${GPUIX_DIR}/zed`,
    })
  }

  console.log('[setup-refs] ⑥ 构建 @gpuix/react dist（bun install + build:react）…')
  await run('bun', ['install'], { cwd: GPUIX_DIR })
  await run('bun', ['run', 'build:react'], { cwd: GPUIX_DIR })

  console.log('[setup-refs] 完成。下一步：')
  console.log('  cd packages/native && bun run build:debug   # 编译 jagent-native.node')
}

main().catch((err) => {
  console.error(`[setup-refs] 失败：${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
