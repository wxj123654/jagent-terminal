/**
 * git/generation.ts — 代际计数器：mount/refresh 使进行中的旧异步回调作废。
 *
 * GitGraphStore（流代际 + 详情代际）与 WorktreeStore（加载代际）同款纪律：
 * 新一代开启时旧代自增失效，回调 isCurrent 判废后丢弃——防止切 cwd 后
 * 旧流/旧详情写回新挂载。
 */
export function createGeneration(): {
  /** 开启新一代并返回代际号（旧代即刻作废） */
  next: () => number
  /** 回调内判废：false = 已被新一代取代，丢弃 */
  isCurrent: (g: number) => boolean
  /** 当前代际号：借用判废而不换代（select 类操作——连选由状态字段自行判别，
   *  只要求「之后发生 mount/refresh 则作废水中的回调」） */
  current: () => number
} {
  let current = 0
  return {
    next: () => ++current,
    isCurrent: (g) => g === current,
    current: () => current,
  }
}
