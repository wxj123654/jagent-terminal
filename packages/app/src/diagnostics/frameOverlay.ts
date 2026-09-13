/**
 * diagnostics/frameOverlay.ts — 屏幕帧 overlay 同步（advanced.frameOverlay
 * → renderer.setDebugFrameOverlay；从 main.tsx 提取）。
 *
 * 整帧耗时直方图的屏幕可视化（full 模式画在场景之上，profiler feature 已编
 * 译进 .node）。settings.subscribe 是全量回调——本模块内做 appliedMode 去重，
 * 只在实际变化时调 native；native 面未就绪/失败时置空允许下次订阅重试。
 * 初值创建时应用一次。返回解绑函数。
 */

import type { SettingsStore } from '../settings/store'

export function watchFrameOverlay(
  renderer: { setDebugFrameOverlay(mode: string): unknown },
  settings: SettingsStore,
): () => void {
  let appliedMode: string | null = null
  const apply = () => {
    const mode = settings.get().advanced.frameOverlay ? 'full' : 'hidden'
    if (mode === appliedMode) return
    appliedMode = mode
    try {
      renderer.setDebugFrameOverlay(mode)
    } catch {
      appliedMode = null // native 面未就绪/失败：置空允许下次订阅重试
    }
  }
  const unsubscribe = settings.subscribe(apply)
  apply()
  return unsubscribe
}
