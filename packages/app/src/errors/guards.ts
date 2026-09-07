/**
 * errors/guards.ts — 进程级全局守卫（方案 A #1/#3）。
 *
 * bun 对齐 Node 语义：无 listener 时 uncaughtException/unhandledRejection
 * 打印后 exit(1)——窗口无声消失。安装守卫后拦截 → 错误总线，进程保活。
 * main.tsx 第一件事调用 installGlobalGuards()（幂等）。
 *
 * 已知边界：若异常发生在渲染帧循环内部并已破坏帧泵，保活后窗口可能
 * 停止刷新——此时总线+落盘仍留痕（「退化为日志」），用户可手动重启。
 */

import { describeUnknown, emitError } from './bus'

let installed = false
let onUncaught: ((e: Error) => void) | null = null
let onRejection: ((reason: unknown, promise: Promise<unknown>) => void) | null = null

/** 安装全局守卫（幂等；e2e 与真窗口共用）。 */
export function installGlobalGuards(): void {
  if (installed) return
  installed = true

  onUncaught = (e) => {
    const d = describeUnknown(e)
    emitError({
      level: 'error',
      kind: 'unknown',
      message: `未捕获异常：${d.message}`,
      detail: d.detail,
      context: 'uncaughtException',
    })
    // 不 re-throw、不 exit：吞下这一条，进程继续跑。
    // dev 模式全栈直达 stderr（可辨识）；release 只进总线/日志。
    if (process.env.JAGENT_DEV === '1') console.error('[jagent] uncaughtException:', e)
  }
  onRejection = (reason) => {
    const d = describeUnknown(reason)
    emitError({
      level: 'error',
      kind: 'unknown',
      message: `未处理的 Promise 拒绝：${d.message}`,
      detail: d.detail,
      context: 'unhandledRejection',
    })
    if (process.env.JAGENT_DEV === '1') console.error('[jagent] unhandledRejection:', reason)
  }
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onRejection)
}

/** 测试隔离：卸载已挂的 listener。 */
export function resetGuardsForTest(): void {
  if (onUncaught) process.off('uncaughtException', onUncaught)
  if (onRejection) process.off('unhandledRejection', onRejection)
  onUncaught = null
  onRejection = null
  installed = false
}
