/**
 * ui/Toast.tsx — 操作反馈提示（Phase W7；原型 toast，role=status）。
 *
 * 模块态单例（useToastState 订阅）：store 操作（创建/移除/重命名）经
 * toast() 发消息，AgentPlane 根挂 <ToastHost/> 渲染右下角浮条，4s 自动
 * 消失（新消息重置计时）。anchored deferred 画在一切之上（树序 #2）。
 */

import { useEffect, useSyncExternalStore } from 'react'

import { COLORS, FONT } from './tokens'

/** 浮条投影（对象形态——GPUIX boxShadow 不收 CSS 字符串） */
const FLOAT_SHADOW = {
  offsetX: 0,
  offsetY: 4,
  blurRadius: 16,
  spreadRadius: 0,
  color: 'rgba(0,0,0,0.4)',
} as const

type ToastState = { message: string; seq: number }

let current: ToastState = { message: '', seq: 0 }
const listeners = new Set<() => void>()

/** 发一条 toast（空串忽略；同消息也重置计时——seq 递增） */
export function toast(message: string): void {
  if (!message) return
  current = { message, seq: current.seq + 1 }
  for (const l of listeners) l()
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => listeners.delete(onStoreChange)
}

/** 自动消失延迟（原型 4s） */
const TOAST_TTL_MS = 4000

/** 测试注入口：缩短自动消失延迟（默认 4s 太慢；advanceTime 不驱动 JS 定时器） */
export function ToastHost({ ttlMs = TOAST_TTL_MS }: { ttlMs?: number }) {
  const state = useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  )
  // 自动消失（seq 变化 → 重新计时；卸载时清理）
  useEffect(() => {
    if (!state.message) return
    const timer = setTimeout(() => {
      current = { message: '', seq: current.seq + 1 }
      for (const l of listeners) l()
    }, ttlMs)
    return () => clearTimeout(timer)
  }, [state.seq, state.message, ttlMs])
  if (!state.message) return null
  return (
    <div
      key={state.seq}
      testId="toast"
      style={{
        position: 'absolute',
        right: 16,
        bottom: 16,
        maxWidth: 320,
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 8,
        paddingBottom: 8,
        borderRadius: 6,
        backgroundColor: COLORS.surfaceHover,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        boxShadow: FLOAT_SHADOW,
      }}
    >
      <text
        style={{
          fontSize: 12,
          fontFamily: FONT.ui,
          color: COLORS.textBright,
          whiteSpace: 'normal',
        }}
      >
        {state.message}
      </text>
    </div>
  )
}
