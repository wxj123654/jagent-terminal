/**
 * errors/log.ts — 错误落盘（方案 A 第 4 组件）。
 *
 * 按天追加 `~/.j-agent/logs/errors-YYYYMMDD.log`，保留 7 天（install 时
 * 清一次旧档；运行期不重复扫）。fire-and-forget：写失败静默（绝不能再
 * emit——会经 bus 钩子死循环），dev 模式打 stderr。
 *
 * 目录可注入（单测/隔离用）；传 null 卸载。
 */

import { mkdir, appendFile, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { AppError } from './bus'
import { onErrorEmitted } from './bus'

const KEEP_DAYS = 7
const NAME_PREFIX = 'errors-'
const NAME_SUFFIX = '.log'

let activeDir: string | null = null
let uninstall: (() => void) | null = null

/** 安装落盘钩子（幂等；dir=null 卸载）。返回实际生效目录。 */
export function installErrorLog(
  dir: string | null = join(homedir(), '.j-agent', 'logs'),
): string | null {
  if (uninstall) {
    uninstall()
    uninstall = null
  }
  activeDir = dir
  if (dir == null) return null
  uninstall = onErrorEmitted((e) => void appendErrorLog(e))
  void pruneOldLogs(dir).catch(() => {})
  return dir
}

/** 当前生效目录（诊断/测试读）。 */
export function errorLogDir(): string | null {
  return activeDir
}

function dayStamp(at: number): string {
  const d = new Date(at)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}${m}${day}`
}

function formatLine(e: AppError): string {
  const iso = new Date(e.at).toISOString()
  const ctx = e.context ? ` ${e.context}:` : ''
  const head = `${iso} [${e.level}/${e.kind}]${ctx} ${e.message.replace(/\n/g, ' ')}`
  if (!e.detail) return `${head}\n`
  const detail = e.detail
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
  return `${head}\n${detail}\n`
}

async function appendErrorLog(e: AppError): Promise<void> {
  if (activeDir == null) return
  try {
    await mkdir(activeDir, { recursive: true })
    await appendFile(
      join(activeDir, `${NAME_PREFIX}${dayStamp(e.at)}${NAME_SUFFIX}`),
      formatLine(e),
      'utf8',
    )
  } catch (err) {
    // 落盘失败静默（不能 emit 反噬总线）；dev 下可见
    if (process.env.JAGENT_DEV === '1') console.error('[jagent] error log write failed:', err)
  }
}

/** 删除超过保留期的旧日志（install 时执行一次）。 */
export async function pruneOldLogs(dir: string): Promise<void> {
  const cutoff = Date.now() - KEEP_DAYS * 86400_000
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return // 目录不存在 = 无旧档
  }
  await Promise.all(
    names
      .filter((n) => n.startsWith(NAME_PREFIX) && n.endsWith(NAME_SUFFIX))
      .filter((n) => {
        const day = n.slice(NAME_PREFIX.length, -NAME_SUFFIX.length)
        if (!/^\d{8}$/.test(day)) return false
        const ts = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`)
        return Number.isFinite(ts) && ts < cutoff
      })
      .map((n) => unlink(join(dir, n)).catch(() => {})),
  )
}
