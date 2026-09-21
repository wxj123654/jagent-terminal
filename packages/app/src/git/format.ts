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

/** ref 名里不可能出现 ", "（git 自己用它做分隔）；含 "/" 视为远程引用。
 *  `HEAD -> main` 按原型拆两个 chip：head「HEAD」+ branch「main」。 */
export function parseRefNames(raw: string): RefDecor[] {
  if (!raw) return []
  return raw
    .split(', ')
    .filter(Boolean)
    .flatMap((part): RefDecor[] => {
      if (part.startsWith('HEAD -> ')) {
        return [
          { kind: 'head', label: 'HEAD' },
          { kind: 'branch', label: part.slice(8) },
        ]
      }
      if (part === 'HEAD') return [{ kind: 'head', label: 'HEAD' }]
      if (part.startsWith('tag: ')) return [{ kind: 'tag', label: part.slice(5) }]
      if (part.includes('/')) return [{ kind: 'remote', label: part }]
      return [{ kind: 'branch', label: part }]
    })
}

/**
 * 相对时间（git graph 行尾 + CDV Date 用）。按 React 原型 seed 文案校准：
 * 今天 → 刚刚 / N 分钟前 / N 小时前；昨天（日历日）→ 「昨天 HH:MM」；
 * 更早 → N 天前 / N 个月前 / N 年前。now 可注入（测试确定性）。
 */
export function relativeTime(unixSec: number, nowMs: number = Date.now()): string {
  const d = new Date(unixSec * 1000)
  const now = new Date(nowMs)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  if (day === today) {
    const s = Math.max(0, Math.floor(nowMs / 1000) - unixSec)
    if (s < 60) return '刚刚'
    const m = Math.floor(s / 60)
    if (m < 60) return `${m} 分钟前`
    return `${Math.floor(m / 60)} 小时前`
  }
  if (day === today - 86400_000) {
    const hh = d.getHours()
    const mm = d.getMinutes()
    return `昨天 ${hh < 10 ? '0' : ''}${hh}:${mm < 10 ? '0' : ''}${mm}`
  }
  const days = Math.round((today - day) / 86400_000)
  if (days < 30) return `${days} 天前`
  const mo = Math.floor(days / 30)
  if (mo < 12) return `${mo} 个月前`
  return `${Math.floor(mo / 12)} 年前`
}
