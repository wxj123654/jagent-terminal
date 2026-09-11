/**
 * scripts/sidecar-tree-smoke.ts — 发布形态 sidecar 防回归冒烟。
 *
 * 背景（2026-09-11 实机复现）：bun compile 只有一个 entry，崩溃监控
 * sidecar（`<exe> --crash-handler`）与主进程共用 main.tsx。native 的
 * run_crash_monitor 起后台线程后立即返回（JS 侧 runCrashSidecar 非阻塞），
 * 入口若不收敛，sidecar 会继续装配 UI（各自开窗）并且在
 * setupCrashReportingForApp 里再 spawn 子 sidecar —— 进程树与窗口数数秒内
 * 涨到 20+。dev 形态（scripts/crash-handler.ts 独立入口）测不到该回归，
 * 只有打包产物能暴露 → 本脚本只对 dist/<platform>/ 产物跑。
 *
 * 判定（任一不满足即失败）：
 *   ① 3s 内 sidecar 进程仍存活（stdin 未关；不是启动即崩）；
 *   ② 全程没有后代进程（不 spawn 子 sidecar）；
 *   ③ 输出里没有 `[gpuix]`（未进入 renderer.mount —— 即没有开窗装配）。
 *
 * 用法：bun scripts/sidecar-tree-smoke.ts [exePath]
 *   exePath 缺省按宿主平台推断 dist/<platform>/jagent[.exe]（跑前先 build）。
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const platformKey =
  process.platform === 'win32'
    ? `windows-${process.arch}`
    : process.platform === 'linux'
      ? `linux-${process.arch}-gnu`
      : `${process.platform}-${process.arch}`

const exeSuffix = process.platform === 'win32' ? '.exe' : ''
const exePath =
  process.argv[2] ?? join(import.meta.dir, '..', 'dist', platformKey, `jagent${exeSuffix}`)

if (!existsSync(exePath)) {
  console.error(`✗ 找不到产物 ${exePath}；先运行 bun run build。`)
  process.exit(1)
}

/** pid → ppid 快照（跨平台）。 */
async function processTable(): Promise<Map<number, number[]>> {
  const children = new Map<number, number[]>()
  let rows: [number, number][]
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ],
      { windowsHide: true },
    )
    rows = stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter((v) => v.length === 2 && v.every(Number.isFinite)) as [number, number][]
  } else {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid='])
    rows = stdout
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter((v) => v.length === 2 && v.every(Number.isFinite)) as [number, number][]
  }
  for (const [pid, ppid] of rows) {
    const list = children.get(ppid)
    if (list) list.push(pid)
    else children.set(ppid, [pid])
  }
  return children
}

/** rootPid 的全部后代（含多级）。 */
async function descendantsOf(rootPid: number): Promise<number[]> {
  const table = await processTable()
  const out: number[] = []
  const stack = [...(table.get(rootPid) ?? [])]
  while (stack.length > 0) {
    const pid = stack.pop()!
    out.push(pid)
    stack.push(...(table.get(pid) ?? []))
  }
  return out
}

/** 清场：先杀后代再杀本体（递归爆炸时主进程不会带走子进程）。 */
async function killTree(root: ChildProcess): Promise<void> {
  if (root.pid == null) return
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(root.pid), '/T', '/F'], {
      windowsHide: true,
    }).catch(() => {})
    return
  }
  const kids = await descendantsOf(root.pid).catch(() => [])
  for (const pid of kids.reverse()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已退出
    }
  }
  try {
    process.kill(root.pid, 'SIGKILL')
  } catch {
    // 已退出
  }
}

// ── 启动 sidecar（与 crashReport.ts 的 spawn 同形：stdin 是管道，EOF 即退）──

const scratch = mkdtempSync(join(tmpdir(), 'jagent-sidecar-smoke-'))
// 绝对路径（且落在本次 scratch 内）：相对路径的 UDS 会落在进程 CWD，
// 既污染仓库又依赖 CWD 可写 —— GUI 进程 CWD 只读时正是崩溃报告的坑。
const socketPath = join(scratch, 'smoke.sock')

console.log(`── sidecar smoke：${exePath}`)
const child = spawn(exePath, ['--crash-handler'], {
  env: {
    ...process.env,
    JAGENT_CRASH_SIDECAR: '1',
    JAGENT_CRASH_SOCKET: socketPath,
    JAGENT_CRASH_DIR: scratch,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

let output = ''
child.stdout?.on('data', (d: Buffer) => (output += d.toString()))
child.stderr?.on('data', (d: Buffer) => (output += d.toString()))

let maxDescendants = 0
const SAMPLES = 6
for (let i = 0; i < SAMPLES; i++) {
  await new Promise((r) => setTimeout(r, 500))
  if (child.exitCode !== null) break
  const kids = await descendantsOf(child.pid!).catch(() => [])
  maxDescendants = Math.max(maxDescendants, kids.length)
}

const alive = child.exitCode === null
await killTree(child)
rmSync(scratch, { recursive: true, force: true })

// ── 断言 ─────────────────────────────────────────────────────────────────

let ok = true
const fail = (msg: string) => {
  ok = false
  console.error(`  ✗ ${msg}`)
}

if (!alive) fail(`sidecar 提前退出（exit=${child.exitCode}），应存活至 stdin EOF`)
else console.log('  ✓ sidecar 存活（stdin 管道保持）')
if (maxDescendants > 0)
  fail(`sidecar 产生了后代进程（峰值 ${maxDescendants} 个）——入口未收敛，进程树爆炸`)
else console.log('  ✓ 无后代进程（未递归 spawn）')
if (output.includes('[gpuix]')) {
  fail('sidecar 输出了 [gpuix] 日志 —— 说明它执行了应用装配（会开窗）')
} else {
  console.log('  ✓ 未进入 UI 装配（无 [gpuix] 输出）')
}
if (!ok && output.trim()) console.error(`  sidecar 输出：\n${output.trim()}`)

console.log(ok ? '✓ sidecar 防回归冒烟通过' : '✗ sidecar 防回归冒烟失败')
process.exit(ok ? 0 : 1)
