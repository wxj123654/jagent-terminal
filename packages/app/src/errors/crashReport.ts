/**
 * errors/crashReport.ts — 进程外崩溃报告的 JS 装配（方案 C）。
 *
 * 同一入口、两种角色（Zed `--crash-handler` 变道的 j-agent 形态）：
 * - sidecar：独立轻量入口 `scripts/crash-handler.ts`（dev）或
 *   `<exe> --crash-handler`（发布）。**不**走 main.tsx——否则 sidecar
 *   会再次 spawn 自己形成进程树爆炸。
 * - 主进程：启动时先读 crash.json（上次崩溃残留）→ 错误总线；spawn
 *   sidecar → 等 IPC 就绪 → setupCrashReporting（false = 降级：panic
 *   hook 照装，无 dump）。
 *
 * IPC 名（跨平台）：
 * - macOS：mach port 名，**不能含 `/`**（minidumper 把 path 当 CString
 *   直接当 port 名）。用 `jagent.crash.<pid>`。
 * - Linux/Windows：真路径（UDS / named pipe）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  runCrashMonitor,
  setupCrashReporting,
  type CrashMonitorDone,
  type CrashReportingOptionsJs,
} from '@jagent/native'

import { emitError } from './bus'

export const CRASH_SIDECAR_ENV = 'JAGENT_CRASH_SIDECAR'
export const CRASH_HANDLER_FLAG = '--crash-handler'
export const CRASH_DIR = join(homedir(), '.j-agent', 'crashes')
const CRASH_JSON = join(CRASH_DIR, 'crash.json')

/** 上次会话崩溃残留（启动时读一次；有则 UI 提示）。 */
export type LastCrash = {
  kind: 'panic' | 'signal'
  message: string
  location?: string
  thread?: string
  dumpPath?: string
  appVersion?: string
  at?: number
}

/**
 * IPC 名：macOS 必须是合法 mach port 名（无 `/`）；其余平台用路径。
 * 公开供测试断言。
 */
export function crashSocketName(pid: number = process.pid): string {
  if (process.platform === 'darwin') return `jagent.crash.${pid}`
  return join(CRASH_DIR, `crash-${pid}.sock`)
}

/** sidecar 是否就绪：macOS 无 UDS 文件可等，用短暂延迟代替。 */
function waitForSidecar(socketPath: string, timeoutMs: number): Promise<boolean> {
  if (process.platform === 'darwin') {
    // mach port 由 Server::with_name 注册，无文件可 poll。给 sidecar
    // 加载 .node + bind 的时间（实测冷启动 ~200ms）。
    return new Promise((resolve) => setTimeout(() => resolve(true), Math.min(timeoutMs, 400)))
  }
  const start = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      if (existsSync(socketPath)) return resolve(true)
      if (Date.now() - start > timeoutMs) return resolve(false)
      setTimeout(tick, 25)
    }
    tick()
  })
}

/** 当前进程是否被标记为 sidecar（环境变量或 --crash-handler 参数）。 */
export function isCrashSidecar(): boolean {
  return process.env[CRASH_SIDECAR_ENV] === '1' || process.argv.includes(CRASH_HANDLER_FLAG)
}

/**
 * sidecar 入口（仅 `scripts/crash-handler.ts` 调用；main.tsx 不再走这条
 * 路径——独立入口才能避免 spawn 自己）。阻塞至 dump 完成或 stdin EOF。
 */
export function runCrashSidecar(): void {
  const socketPath = process.env.JAGENT_CRASH_SOCKET
  if (!socketPath) process.exit(0)
  const dumpDir = process.env.JAGENT_CRASH_DIR ?? CRASH_DIR
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
}

/**
 * sidecar 启动参数：dev 跑独立脚本；发布（bun compile 单文件）走
 * `--crash-handler` 变道。公开供测试断言。
 */
export function sidecarSpawnArgs(): { cmd: string; args: string[] } {
  const compiled = !process.execPath.endsWith('bun') && !process.execPath.endsWith('bun.exe')
  if (compiled) {
    return { cmd: process.execPath, args: [CRASH_HANDLER_FLAG] }
  }
  // dev：从本文件定位仓库根（packages/app/src/errors/crashReport.ts
  // → 上溯 5 层到仓库根）。bun compile 不会走这条分支。
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(here, '..', '..', '..', '..')
  return {
    cmd: process.execPath,
    args: [join(repoRoot, 'scripts', 'crash-handler.ts')],
  }
}

/**
 * 主进程装配：拉起 sidecar + 安装 crash 报告 + 读取上次崩溃残留。
 * 在 renderer 开窗之前调用（崩溃保护越早生效越好）。任何失败都静默
 * 降级（返回 null）——崩溃报告自身绝不能把应用搞崩。
 */
export async function setupCrashReportingForApp(appVersion: string): Promise<LastCrash | null> {
  const last = readLastCrash()

  mkdirSync(CRASH_DIR, { recursive: true })
  const socketPath = crashSocketName()
  const { cmd, args } = sidecarSpawnArgs()
  const child = spawn(cmd, args, {
    env: {
      ...process.env,
      [CRASH_SIDECAR_ENV]: '1',
      JAGENT_CRASH_SOCKET: socketPath,
      JAGENT_CRASH_DIR: CRASH_DIR,
    },
    stdio: ['pipe', 'inherit', 'inherit'],
    detached: false,
    // 发布形态是 GUI 子系统（无 console 可继承）；不做隐藏时 Windows 会给
    // sidecar 新建一个可见控制台窗口（dev 下是 bun.exe，同理）。
    windowsHide: true,
  })
  child.on('error', () => {})

  const ready = await waitForSidecar(socketPath, 5000)
  const opts: CrashReportingOptionsJs = {
    socketPath,
    dumpDir: CRASH_DIR,
    sessionId: `${Date.now()}-${process.pid}`,
    appVersion,
  }
  const installed = ready && setupCrashReporting(opts)
  if (!installed) {
    child.stdin?.end()
  }

  if (last) {
    emitError({
      level: 'error',
      kind: 'crash',
      message:
        last.kind === 'panic'
          ? `上次会话异常退出（原生层异常）：${last.message}`
          : '上次会话异常退出（原生崩溃）',
      detail: [
        last.location ? `位置 ${last.location}` : null,
        last.thread ? `线程 ${last.thread}` : null,
        last.appVersion ? `版本 ${last.appVersion}` : null,
        last.dumpPath ? `转储 ${last.dumpPath}` : null,
        last.at ? `时间 ${new Date(last.at).toLocaleString()}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      context: 'crash.json',
    })
  }
  return last
}

/** 读取（并解析）崩溃残留；无/损坏返回 null。path 可注入（测试）。 */
export function readLastCrash(path: string = CRASH_JSON): LastCrash | null {
  try {
    if (!existsSync(path)) return null
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Partial<LastCrash> & {
      schema?: string
    }
    if (doc.schema !== 'jagent.crash.v1') return null
    return {
      kind: doc.kind === 'panic' ? 'panic' : 'signal',
      message: doc.message ?? '',
      location: doc.location ?? undefined,
      thread: doc.thread ?? undefined,
      dumpPath: doc.dumpPath ?? undefined,
      appVersion: doc.appVersion ?? undefined,
      at: doc.at,
    }
  } catch {
    return null
  }
}

/** UI dismiss 后调用：删除 crash.json（dump 文件保留）。path 可注入（测试）。 */
export function dismissLastCrash(path: string = CRASH_JSON): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // 忽略：下次启动会再读到（无害）
  }
}
