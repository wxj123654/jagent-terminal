/**
 * errors/native.ts — napi 调用收口（方案 A 第 5 组件 + B 的 onNativePanic 接线）。
 *
 * nativeDeps 的 spawnSession/destroySession reject 路径在此 emit
 * （kind='native'）后原样 rethrow——store 层的既有兑底逻辑不变，只是
 * 错误从此可见。fire-and-forget 调用点（如 store.close 的 destroySession）
 * 在错误已被 trackNative 上报的前提下用裸 catch 防空 rejection。
 *
 * Rust panic 转发（B 方案 onNativePanic TSF）：registerNativePanicHandler
 * 装配一次——native 层 panic（被 catch_unwind 拦住或后台线程）→ 总线
 * fatal；进程若随后 abort（C 方案 dump 路径），这条也已在日志/总线里。
 */

import { describeUnknown, emitError } from './bus'

/** 记录一次 native 层错误（不改变返回/抛出行为）。 */
export function reportNativeError(context: string, e: unknown): void {
  const d = describeUnknown(e)
  emitError({
    level: 'error',
    kind: 'native',
    message: d.message,
    detail: d.detail,
    context,
  })
}

/**
 * 包装一个 Promise 面 native 调用：reject → emit(kind:'native') + rethrow。
 * 调用方（nativeDeps）保持 async 签名不变。
 */
export async function trackNative<T>(context: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    reportNativeError(context, e)
    throw e
  }
}

/**
 * Rust panic 转发接线（B 方案）。@jagent/native 的 onNativePanic 可用时
 * 注册（不可用 = 旧 .node 未重编，静默跳过——seam 向后兼容）；幂等。
 */
/** Rust panic 事件（B 方案 onNativePanic TSF；与 SessionEvent 同款两参契约） */
export type NativePanicEvent = {
  message: string
  thread: string
  location?: string
}

let panicHandlerInstalled = false
export function registerNativePanicHandler(
  onNativePanic: ((cb: (err: null, e: NativePanicEvent) => void) => void) | undefined,
): boolean {
  if (panicHandlerInstalled || !onNativePanic) return false
  panicHandlerInstalled = true
  onNativePanic((_err, e) => {
    emitError({
      level: 'fatal',
      kind: 'panic',
      message: `原生层异常：${e.message}`,
      detail: [e.location ? `at ${e.location}` : null, `thread: ${e.thread}`]
        .filter(Boolean)
        .join(' · '),
      context: 'onNativePanic',
    })
  })
  return true
}
