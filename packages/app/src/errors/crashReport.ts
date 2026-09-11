/**
 * errors/crashReport.ts — 进程外崩溃报告的 JS 装配（方案 C）。
 *
 * 两种角色、两条入口路径（Zed `--crash-handler` 变道的 j-agent 形态）：
 * - sidecar：dev 走独立轻量入口 `scripts/crash-handler.ts`；发布形态
 *   （bun compile 单文件）只能与主进程共用 main.tsx —— 由
 *   `enterCrashSidecarIfRequested()` 收敛：识别后立即进入挂起态，装配一行
 *   都不执行（否则 sidecar 各自开窗，并在 setupCrashReportingForApp 里再
 *   spawn 子 sidecar，形成进程树爆炸）。
 * - 主进程：启动时先读 crash.json（上次崩溃残留）→ 错误总线；spawn
 *   sidecar → 等 IPC 就绪 → setupCrashReporting（false = 降级：panic
 *   hook 照装，无 dump）。
 *
 * IPC 名（跨平台）：CRASH_DIR 下的**绝对路径** `crash-<pid>.sock`。
 * - macOS：minidumper 把这个字符串同时用作 UDS 路径与 mach port 名；
 *   相对路径会让 UDS 落在进程 CWD —— GUI app 的 CWD 只读，bind 直接
 *   EROFS 失败（见 crashSocketName）。
 * - Linux/Windows：UDS / named pipe 路径。
 */

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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
/**
 * 当前进程使用的崩溃目录。`JAGENT_CRASH_DIR` 可覆盖 —— 冒烟/测试靠它把
 * socket、就绪标记、dump、crash.json 全部隔离到临时目录，不碰用户数据。
 * 主进程 spawn sidecar 时会注入该变量，两侧路径始终一致。
 */
export function crashDir(): string {
  return process.env.JAGENT_CRASH_DIR ?? CRASH_DIR
}

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
  // 必须是**绝对路径**（三平台统一）。minidumper 在 macOS 上把同一个字符串
  // 既当 UDS 路径又当 mach port 名：相对路径的 UDS 会落在进程 CWD，而 GUI
  // （LaunchServices）启动的 app CWD 是只读的「/」→ bind 报 EROFS(errno 30)，
  // sidecar 秒退（2026-09-11 定位：`cd / && python3 -c "socket.bind('x.sock')"`
  // 复现同一错误码）。mach port 名允许含「/」，不必为此牺牲 UDS 路径。
  return join(crashDir(), `crash-${pid}.sock`)
}

/** sidecar 就绪标记路径：bind 成功后由 sidecar 落盘（见 runCrashSidecar）。 */
export function sidecarReadyPath(pid: number = process.pid): string {
  return join(crashDir(), `sidecar-${pid}.ready`)
}

/**
 * 等 sidecar bind 完成。mach port（macOS）与 UDS（其他平台）都没有
 * 「连接前可观测」的外部信号，统一 poll sidecar 自己落的就绪标记 ——
 * 旧的 macOS 固定 sleep 在 .app 冷启动（Gatekeeper 校验 + 80MB 单文件
 * 加载 >400ms）时会误判降级，把刚起来的 sidecar 用 stdin EOF 掐掉。
 * 公开供测试断言。
 */
export function waitForSidecar(readyFile: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      if (existsSync(readyFile)) return resolve(true)
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
 * sidecar 入口（dev 由 `scripts/crash-handler.ts` 调用；发布形态由 main.tsx
 * 的 `enterCrashSidecarIfRequested` 调用）。
 *
 * ⚠ **非阻塞**：native 的 `run_crash_monitor` 起后台线程后立即返回，本函数
 * 注册完 stdin 监听就返回 —— 进程存活靠 stdin 句柄，不靠停在函数里。
 * 发布形态的调用方必须自己停止后续装配（见 enterCrashSidecarIfRequested）。
 */
export function runCrashSidecar(): void {
  const socketPath = process.env.JAGENT_CRASH_SOCKET
  if (!socketPath) process.exit(0)
  const dumpDir = crashDir()
  let exited = false
  const finish = () => {
    if (exited) return
    exited = true
    try {
      rmSync(sidecarReadyPath(), { force: true })
    } catch {
      // 忽略：残留标记由主进程按 pid 清理
    }
    process.exit(0)
  }
  const ok = runCrashMonitor({ socketPath, dumpDir, maxDumps: 5 }, (_err, e: CrashMonitorDone) => {
    if (e?.reason === 'error') console.error('[jagent-crash-monitor]', e.detail ?? '')
    finish()
  })
  if (!ok) process.exit(0)
  // bind 成功 → 落就绪标记（主进程 poll 它，见 waitForSidecar）
  try {
    writeFileSync(sidecarReadyPath(), '')
  } catch {
    // 写不了不致命：主进程等超时后降级（panic hook 照装）
  }
  process.stdin.resume()
  process.stdin.on('end', finish)
  process.stdin.on('error', finish)
}

/**
 * main.tsx 入口调度（发布形态的唯一收敛点）。返回 true 表示当前进程是
 * sidecar：调用方**必须**停止一切应用装配（UI 装配、开窗、再 spawn）。
 *
 * 为什么必须挂起：bun compile 只有一个 entry，sidecar 与主进程共用
 * main.tsx；而 runCrashSidecar 非阻塞（见其文档）。少了这一步，每个
 * sidecar 会继续装配 UI（自己开一个窗口）并在 setupCrashReportingForApp
 * 里再 spawn 子孙 sidecar —— 进程树/窗口数持续暴涨（2026-09-11 实机复现：
 * 数秒内 21+ 个窗口）。
 */
export function enterCrashSidecarIfRequested(run: () => void = runCrashSidecar): boolean {
  if (!isCrashSidecar()) return false
  run()
  return true
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
 * 清理陈旧 IPC 残留：socket 文件（sidecar 被 SIGKILL 时 Drop 清理来不及跑）
 * 与就绪标记。只删 24h 前的，避免误伤并行实例的活动会话。
 */
export function pruneStaleCrashIpc(dir: string = crashDir(), now: number = Date.now()): number {
  let removed = 0
  try {
    for (const e of readdirSync(dir)) {
      if (!/^crash-\d+\.sock$/.test(e) && !/^sidecar-\d+\.ready$/.test(e)) continue
      const path = join(dir, e)
      try {
        if (now - statSync(path).mtimeMs > 24 * 60 * 60 * 1000) {
          rmSync(path, { force: true })
          removed += 1
        }
      } catch {
        // 单个文件失败不影响其余
      }
    }
  } catch {
    // 目录不存在等：无残留可清
  }
  return removed
}

/** 测试注入点：单测不得真的 spawn sidecar 进程。 */
export type CrashReportingDeps = { spawn: typeof spawn }

/**
 * 主进程装配：拉起 sidecar + 安装 crash 报告 + 读取上次崩溃残留。
 * 在 renderer 开窗之前调用（崩溃保护越早生效越好）。任何失败都静默
 * 降级（返回 null）——崩溃报告自身绝不能把应用搞崩。
 *
 * sidecar 进程调用本函数直接返回 null（递归防护，见 enterCrashSidecarIfRequested）。
 */
export async function setupCrashReportingForApp(
  appVersion: string,
  deps: CrashReportingDeps = { spawn },
): Promise<LastCrash | null> {
  // 纵深防御：本函数只属于主进程。sidecar 环境里若被调用（入口调度回归、
  // 将来别处复用），必须直接退出 —— 否则 sidecar 会再 spawn 子 sidecar。
  if (isCrashSidecar()) return null
  const last = readLastCrash()

  mkdirSync(crashDir(), { recursive: true })
  pruneStaleCrashIpc()
  const socketPath = crashSocketName()
  const { cmd, args } = sidecarSpawnArgs()
  const child = deps.spawn(cmd, args, {
    env: {
      ...process.env,
      [CRASH_SIDECAR_ENV]: '1',
      JAGENT_CRASH_SOCKET: socketPath,
      JAGENT_CRASH_DIR: crashDir(),
    },
    stdio: ['pipe', 'inherit', 'inherit'],
    detached: false,
    // 发布形态是 GUI 子系统（无 console 可继承）；不做隐藏时 Windows 会给
    // sidecar 新建一个可见控制台窗口（dev 下是 bun.exe，同理）。
    windowsHide: true,
  })
  child.on('error', () => {})

  // 就绪握手：等 sidecar 落标记文件（.app 冷启动可能 1s+）。先清一次，
  // 防 pid 复用留下的陈旧标记被误当就绪。
  const readyFile = child.pid != null ? sidecarReadyPath(child.pid) : null
  if (readyFile) rmSync(readyFile, { force: true })
  const ready = readyFile != null && (await waitForSidecar(readyFile, 5000))
  const opts: CrashReportingOptionsJs = {
    socketPath,
    dumpDir: crashDir(),
    sessionId: `${Date.now()}-${process.pid}`,
    appVersion,
  }
  const installed = ready && setupCrashReporting(opts)
  if (readyFile) rmSync(readyFile, { force: true })
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
export function lastCrashPath(): string {
  return join(crashDir(), 'crash.json')
}

export function readLastCrash(path: string = lastCrashPath()): LastCrash | null {
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
export function dismissLastCrash(path: string = lastCrashPath()): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // 忽略：下次启动会再读到（无害）
  }
}
