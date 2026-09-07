/**
 * scripts/crash-handler.ts — 崩溃监视 sidecar 入口（方案 C）。
 *
 * 独立轻量进程：只加载 @jagent/native 的 runCrashMonitor，**不**走
 * main.tsx 装配（否则 sidecar 会再次 spawn 自己形成进程树爆炸）。
 *
 * 拉起方式（crashReport.ts）：
 *   bun scripts/crash-handler.ts            （dev）
 *   <exe> --crash-handler                   （发布：bun compile 后 argv 含此 flag）
 *
 * 环境：
 *   JAGENT_CRASH_SOCKET  IPC 名（macOS 为 mach-port 合法名，不含 /）
 *   JAGENT_CRASH_DIR     dump/crash.json 目录（缺省 ~/.j-agent/crashes）
 *
 * 退出：dump 完成 / 失败 / stdin EOF（主进程死）。永不开窗。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { runCrashMonitor, type CrashMonitorDone } from '../packages/native/index.js'

const socketPath = process.env.JAGENT_CRASH_SOCKET
if (!socketPath) {
  process.exit(0)
}

const dumpDir = process.env.JAGENT_CRASH_DIR ?? join(homedir(), '.j-agent', 'crashes')

let exited = false
const finish = () => {
  if (exited) return
  exited = true
  process.exit(0)
}

const ok = runCrashMonitor({ socketPath, dumpDir, maxDumps: 5 }, (_err, e: CrashMonitorDone) => {
  if (e?.reason === 'error') console.error('[jagent-crash-monitor]', e.detail ?? '')
  finish()
})
if (!ok) process.exit(0)

process.stdin.resume()
process.stdin.on('end', finish)
process.stdin.on('error', finish)
