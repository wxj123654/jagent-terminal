/**
 * errors/bus.ts — 错误总线（单一事实源；docs/error-management.md 方案 A）。
 *
 * 所有运行时错误（JS 异常 / render 错误 / unhandled rejection / napi
 * reject / Rust panic 转发 / 崩溃残留）的唯一去向：emit 进总线，订阅方
 * （Toast、错误面板、落盘）各自消费。环形缓冲 1000 条供面板回溯。
 *
 * 模块态单例（与 ui/Toast 同款纪律）：App props 注入的是 store，错误面
 * 天然进程级，无 per-window 语义。
 */

export type AppErrorLevel = 'fatal' | 'error' | 'warn'

export type AppErrorKind =
  | 'render' // React render 错误（ErrorBoundary 捕获）
  | 'native' // napi 命令 reject（thiserror 结构化或 anyhow 裸串）
  | 'io' // 文件读写（settings/state/logs）
  | 'protocol' // ACP/JSON-RPC 协议层
  | 'acp' // ACP 连接/子进程
  | 'crash' // 上次会话崩溃残留（crash.json；C 方案）
  | 'panic' // Rust panic 转发（onNativePanic TSF；B 方案）
  | 'unknown'

export type AppError = {
  /** 自增 id（订阅方靠它判重） */
  id: number
  level: AppErrorLevel
  kind: AppErrorKind
  /** 一行摘要（面板/Toast 显示） */
  message: string
  /** 完整 stack / 错误链（面板详情、落盘用） */
  detail?: string
  /** 来源标注：'createTerminalSession' / 'boundary:pane' / … */
  context?: string
  /** epoch ms */
  at: number
  /** 会话 id（crash 上报关联；C 方案注入，普通错误可空） */
  sessionId?: string
}

/** 环形缓冲上限（面板回溯窗口；超出丢最旧） */
const RING_LIMIT = 1000

const ring: AppError[] = []
const listeners = new Set<(e: AppError | null) => void>()
/** emit 钩子（落盘等副作用；log.ts 注册——bus 不反向依赖 log，避免环） */
const emitHooks = new Set<(e: AppError) => void>()

let nextId = 1

export type AppErrorInput = Omit<AppError, 'id' | 'at'> & { at?: number }

/** 发一条错误进总线；返回完整 AppError（含分配的 id/at）。 */
export function emitError(input: AppErrorInput): AppError {
  const e: AppError = {
    id: nextId++,
    at: input.at ?? Date.now(),
    level: input.level,
    kind: input.kind,
    message: input.message,
    detail: input.detail,
    context: input.context,
    sessionId: input.sessionId,
  }
  ring.push(e)
  if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT)
  for (const hook of emitHooks) {
    try {
      hook(e)
    } catch {
      // 钩子失败不能反噬错误链（尤其落盘失败再 emit 会死循环）
    }
  }
  for (const l of listeners) {
    try {
      l(e)
    } catch {
      // 订阅方（UI）抛错不阻断其他订阅方
    }
  }
  return e
}

/** 订阅变更：新错误传 AppError，清空传 null。返回退订函数。 */
export function subscribeErrors(fn: (e: AppError | null) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 注册 emit 钩子（落盘）。返回卸载函数。 */
export function onErrorEmitted(fn: (e: AppError) => void): () => void {
  emitHooks.add(fn)
  return () => emitHooks.delete(fn)
}

/** 环形缓冲快照（新→旧；面板渲染用）。 */
export function listErrors(): AppError[] {
  return [...ring].reverse()
}

/** 清空缓冲（面板「清空」按钮）；订阅方收到 null 信号。 */
export function clearErrors(): void {
  ring.length = 0
  for (const l of listeners) {
    try {
      l(null)
    } catch {
      // 同上：单个订阅方失败不阻断
    }
  }
}

/** error+fatal 计数（TitleBar 角标）。 */
export function errorCount(): number {
  let n = 0
  for (const e of ring) if (e.level === 'error' || e.level === 'fatal') n++
  return n
}

/** 测试隔离：清空全部状态。 */
export function resetErrorBusForTest(): void {
  ring.length = 0
  listeners.clear()
  emitHooks.clear()
  nextId = 1
}

/** 从 unknown 提取 message + detail（Error / string / 其他）。 */
export function describeUnknown(e: unknown): { message: string; detail?: string } {
  if (e instanceof Error) {
    return { message: e.message || e.name, detail: e.stack }
  }
  if (typeof e === 'string') return { message: e }
  try {
    return { message: JSON.stringify(e) }
  } catch {
    return { message: String(e) }
  }
}
