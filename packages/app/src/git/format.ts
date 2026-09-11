/**
 * git/format.ts — 纯格式化工具（docs/git-graph.md §3.3 / §2.1）。
 *
 * parseRefNames：`%D` 装饰字符串 → 徽章描述数组。输入样例：
 *   "HEAD -> main, origin/main, tag: v1.0"（detached HEAD 时为 "HEAD"，
 *   普通提交为空串）。零 IO，行为由 format.test.ts 锁定。
 */

export type RefKind = 'head' | 'branch' | 'remote' | 'tag'

export interface RefDecor {
  kind: RefKind
  label: string
}

/** ref 名里不可能出现 ", "（git 自己用它做分隔）；含 "/" 视为远程引用 */
export function parseRefNames(raw: string): RefDecor[] {
  if (!raw) return []
  return raw
    .split(', ')
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith('HEAD -> ')) return { kind: 'head', label: part.slice(8) }
      if (part === 'HEAD') return { kind: 'head', label: 'HEAD' }
      if (part.startsWith('tag: ')) return { kind: 'tag', label: part.slice(5) }
      if (part.includes('/')) return { kind: 'remote', label: part }
      return { kind: 'branch', label: part }
    })
}

/**
 * 相对时间（git graph 行尾用）。粗粒度中文短句，与 Zed 的 "2 hours ago"
 * 同信息量。now 可注入（测试确定性）。
 */
export function relativeTime(unixSec: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor(nowMs / 1000) - unixSec)
  if (s < 60) return '刚刚'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo} 个月前`
  return `${Math.floor(mo / 12)} 年前`
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTH = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * vscode-git-graph 风格绝对时间：
 * `Fri May 29 2026 20:15:57 GMT+0800 (中国标准时间)`
 * timeZone 可注入（测试确定性）；缺省用运行时本地时区。
 */
export function formatCommitDate(unixSec: number, timeZone?: string): string {
  const d = new Date(unixSec * 1000)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone ?? undefined,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  })
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value])) as Record<
    string,
    string
  >
  const weekday = parts.weekday ?? WEEKDAY[d.getUTCDay()]
  const month = parts.month ?? MONTH[d.getUTCMonth()]
  const day = parts.day ?? pad2(d.getUTCDate())
  const year = parts.year ?? String(d.getUTCFullYear())
  const hour = parts.hour ?? pad2(d.getUTCHours())
  const minute = parts.minute ?? pad2(d.getUTCMinutes())
  const second = parts.second ?? pad2(d.getUTCSeconds())
  const offsetRaw = parts.timeZoneName ?? 'GMT+0000'
  // longOffset → "GMT+08:00"；vgg 无冒号
  const offset = offsetRaw.replace(/GMT([+-])(\d{2}):?(\d{2})/, 'GMT$1$2$3')
  const tzName =
    offset.includes('+0800') || offset.includes('+08')
      ? '中国标准时间'
      : offsetRaw.replace(/^GMT/, '').trim() || 'Local'
  return `${weekday} ${month} ${day} ${year} ${hour}:${minute}:${second} ${offset} (${tzName})`
}
