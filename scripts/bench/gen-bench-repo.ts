/**
 * scripts/bench/gen-bench-repo.ts — 生成确定性的 git graph bench 仓库。
 *
 * 拓扑：25 轮 ×（main 10 连续提交 + feature 分支 3 提交 + --no-ff merge），
 * 每 3 轮额外插一条 hotfix 分支（2 提交 + merge）→ lane 数在 2–5 间波动，
 * 与真实仓库的 graph 形状接近。作者/日期全部固定 → 输出逐字节确定。
 *
 * merge 后删除 feature/hotfix 分支（真实仓库不会积累 25 个残留分支，
 * badge 行为也更接近用户仓库），每 5 轮打一个 tag。
 *
 * 用法：bun scripts/bench/gen-bench-repo.ts [dir] [--fresh]
 *   dir 默认 %TEMP%/jagent-git-bench-repo；--fresh 删除重建。
 * 幂等：目录已存在且有 .git 时直接复用（打印提交数后退出）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const fresh = argv.includes('--fresh')
const dir = argv.find((a) => !a.startsWith('--')) ?? join(tmpdir(), 'jagent-git-bench-repo')

function git(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const { cwd = dir, env } = opts
  // 双保险：脚本生成的仓库绝不继承外层 GIT_DIR/GIT_WORK_TREE（防 cwd
  // 处理错误时把提交写进调用方仓库——2026-09-11 事故根因之一）
  const cleanEnv: Record<string, string | undefined> = {
    ...process.env,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    ...env,
  }
  try {
    return execFileSync('git', args, {
      cwd,
      env: cleanEnv as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    console.error(`[gen-bench-repo] git ${args.join(' ')} failed:`, (e as Error).message)
    throw e
  }
}

function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
    } as Record<string, string>,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString()
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  return norm(a) === norm(b)
}

if (fresh && existsSync(dir)) rmSync(dir, { recursive: true, force: true })

if (existsSync(join(dir, '.git'))) {
  const count = gitIn(dir, ['rev-list', '--count', 'HEAD']).trim()
  console.log(JSON.stringify({ dir, reused: true, commits: Number(count) }))
  process.exit(0)
}

if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })

// 硬护栏：目录已被某仓库占用（GIT_DIR 推导沿目录向上找到其他 .git）
// 时拒绝运行。2026-09-11 事故：曾因 cwd 处理 bug 把 39 个空提交写进
// 主仓库 HEAD（靠 reflog 恢复）——此护栏保证脚本永不落笔到别人的仓库。
{
  let probe = ''
  try {
    probe = gitIn(dir, ['rev-parse', '--show-toplevel']).trim()
  } catch {
    probe = ''
  }
  if (probe && !samePath(probe, dir)) {
    console.error(`[gen-bench-repo] REFUSING: ${dir} is inside work tree of ${probe}`)
    process.exit(3)
  }
}

// 固定身份 + 基准时间（每提交 +61s，避免同秒排序抖动）
const BASE = Date.UTC(2025, 0, 1, 0, 0, 0)
let seq = 0
function commitEnv(): Record<string, string> {
  const at = new Date(BASE + seq * 61_000).toISOString()
  seq += 1
  return {
    GIT_AUTHOR_NAME: 'Bench Author',
    GIT_AUTHOR_EMAIL: 'author@bench.local',
    GIT_COMMITTER_NAME: 'Bench Committer',
    GIT_COMMITTER_EMAIL: 'committer@bench.local',
    GIT_AUTHOR_DATE: at,
    GIT_COMMITTER_DATE: at,
  }
}

git(['init', '-q', '-b', 'main', dir], { cwd: process.cwd() })
// init 后自检：主仓库 HEAD 绝不能因此移动
{
  const probe = gitIn(dir, ['rev-parse', '--show-toplevel']).trim()
  if (!samePath(probe, dir)) {
    console.error(`[gen-bench-repo] REFUSING: init resolved to ${probe}, not ${dir}`)
    process.exit(3)
  }
}

const ROUNDS = 25
for (let r = 1; r <= ROUNDS; r++) {
  for (let i = 1; i <= 10; i++) {
    git(['commit', '--allow-empty', '-m', `round ${r}: main change ${i}`], { env: commitEnv() })
  }
  // feature 分支：3 提交后 --no-ff 合回（制造 merge commit + lane 曲线）
  git(['checkout', '-q', '-b', `feat/r${r}`])
  for (let i = 1; i <= 3; i++) {
    git(['commit', '--allow-empty', '-m', `round ${r}: feature ${i} of r${r}`], {
      env: commitEnv(),
    })
  }
  git(['checkout', '-q', 'main'])
  git(
    ['merge', '--no-ff', '--no-edit', '-m', `Merge branch 'feat/r${r}' into main`, `feat/r${r}`],
    { env: commitEnv() },
  )
  git(['branch', '-q', '-D', `feat/r${r}`])
  // 每 3 轮一条 hotfix 支线
  if (r % 3 === 0) {
    const parent = `HEAD~4`
    git(['checkout', '-q', '-b', `hotfix/r${r}`, parent])
    for (let i = 1; i <= 2; i++) {
      git(['commit', '--allow-empty', '-m', `round ${r}: hotfix ${i}`], { env: commitEnv() })
    }
    git(['checkout', '-q', 'main'])
    git(
      [
        'merge',
        '--no-ff',
        '--no-edit',
        '-m',
        `Merge branch 'hotfix/r${r}' into main`,
        `hotfix/r${r}`,
      ],
      { env: commitEnv() },
    )
    git(['branch', '-q', '-D', `hotfix/r${r}`])
  }
  if (r % 5 === 0) {
    git(['tag', `v0.${r}.0`], { env: commitEnv() })
  }
}
git(['checkout', '-q', 'main'])

const count = Number(
  execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir }).toString().trim(),
)
console.log(JSON.stringify({ dir, created: true, commits: count }))
