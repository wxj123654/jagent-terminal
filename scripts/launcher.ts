/**
 * scripts/launcher.ts — 应用 watchdog（docs/error-management.md 方案 D）。
 *
 * spawn 真正的 app 子进程并监控退出：
 * - 零退出 → 正常结束，launcher 跟着退
 * - 非零 / 被信号杀 → 读 ~/.j-agent/logs 最新错误日志尾部 → 桌面通知
 *   → 自动重启（带 crash-loop 保护：60s 内重启 ≥ 5 次则放弃，避免
 *   启动即崩的死循环把机器打满）
 *
 * 用法：
 *   bun scripts/launcher.ts            # dev：等价 bun run --cwd packages/app dev
 *   bun scripts/launcher.ts --compiled # 发布：拉 dist 下当前平台二进制
 *
 * 工作区状态已有 state.json 持久化兜底，重启后 UI 可恢复；PTY 会话会丢
 * （本来就是运行时态）。崩溃 dump 由方案 C sidecar 独立负责，本脚本
 * 不碰 dump。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { notifyDesktop } from '../packages/native/index.js'

const REPO = join(import.meta.dir, '..')
const LOG_DIR = join(homedir(), '.j-agent', 'logs')
const WINDOW_MS = 60_000
const MAX_RESTARTS = 5
const compiled = process.argv.includes('--compiled')

function appCommand(): { cmd: string; args: string[]; cwd: string } {
  if (compiled) {
    const exe =
      process.platform === 'darwin'
        ? join(REPO, 'dist', 'darwin-arm64', 'jagent')
        : process.platform === 'win32'
          ? join(REPO, 'dist', 'windows-x64', 'jagent.exe')
          : join(REPO, 'dist', 'linux-x64', 'jagent')
    return { cmd: exe, args: [], cwd: REPO }
  }
  return {
    cmd: process.execPath,
    args: ['run', 'src/main.tsx'],
    cwd: join(REPO, 'packages', 'app'),
  }
}

function tailLogs(n = 8): string {
  try {
    if (!existsSync(LOG_DIR)) return ''
    const files = readdirSync(LOG_DIR)
      .filter((f) => f.startsWith('errors-') && f.endsWith('.log'))
      .sort()
    const last = files.at(-1)
    if (!last) return ''
    const text = readFileSync(join(LOG_DIR, last), 'utf8')
    const lines = text.trimEnd().split('\n')
    return lines.slice(-n).join('\n')
  } catch {
    return ''
  }
}

function spawnApp(): ChildProcess {
  const { cmd, args, cwd } = appCommand()
  return spawn(cmd, args, {
    cwd,
    env: { ...process.env, JAGENT_DEV: compiled ? undefined : '1' },
    stdio: 'inherit',
  })
}

const starts: number[] = []
let current: ChildProcess | null = null

function tooManyRestarts(): boolean {
  const now = Date.now()
  while (starts.length && now - starts[0]! > WINDOW_MS) starts.shift()
  return starts.length >= MAX_RESTARTS
}

function launch(): void {
  starts.push(Date.now())
  const child = spawnApp()
  current = child
  child.on('exit', (code, signal) => {
    current = null
    const abnormal = code !== 0 || signal != null
    if (!abnormal) process.exit(0)
    const reason = signal ? `信号 ${signal}` : `退出码 ${code}`
    const tail = tailLogs()
    const body = tail ? `${reason}\n${tail.slice(0, 240)}` : reason
    try {
      notifyDesktop('j-agent 异常退出', body, true)
    } catch {
      console.error(`[launcher] 异常退出：${body}`)
    }
    if (tooManyRestarts()) {
      console.error(
        `[launcher] ${WINDOW_MS / 1000}s 内重启 ${MAX_RESTARTS} 次，放弃（防 crash-loop）`,
      )
      process.exit(code ?? 1)
    }
    console.error(`[launcher] ${reason}，3s 后重启…`)
    setTimeout(launch, 3000)
  })
  child.on('error', (e) => {
    console.error('[launcher] spawn 失败:', e)
    process.exit(1)
  })
}

process.on('SIGINT', () => {
  current?.kill('SIGINT')
  process.exit(130)
})
process.on('SIGTERM', () => {
  current?.kill('SIGTERM')
  process.exit(143)
})

launch()
