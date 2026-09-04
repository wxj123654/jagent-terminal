/**
 * main.tsx — 装配层（architecture.md §1.2 / §5）。
 *
 * 职责（且仅此三件）：
 * 1. seam 装配：installTerminalElement（必须在 renderer.init 之前——模块
 *    顶层调用即满足）+ onSessionEvent 事件桥（Phase 1 先落 console，
 *    T1.4 接 ThreadStore.onSessionEvent）
 * 2. 路由 + App 渲染（GPUIX render 一站式：createRenderer + init + createRoot）
 * 3. 全局键位层（Ctrl-Tab / Ctrl-, —— T1.6 焦点结论后接线）
 */

import { render } from '@gpuix/react'
import { installTerminalElement, onSessionEvent } from '@jagent/native'

import { router } from './router'
import { App } from './plane/AgentPlane'

// ── seam 装配（顺序敏感：先注册元素，再开窗）──────────────────────────
installTerminalElement()

onSessionEvent((e) => {
  // T1.4：转发 threadStore.onSessionEvent(e)。Phase 1 骨架先落 console。
  console.log(`[session] ${e.type} ${e.sessionId}${e.title ? `: ${e.title}` : ''}`)
})

// ── 窗口 ────────────────────────────────────────────────────────────
render(<App />, {
  title: 'j-agent',
  appName: 'j-agent',
  width: 1180,
  height: 760,
  minWidth: 720,
  minHeight: 480,
  onEvent: (event) => {
    if (event.eventType === 'keyDown') {
      // T1.6：Ctrl-Tab / Ctrl-Shift-Tab → cycle；Ctrl-, → toggle settings。
      // 先记录到达顺序（焦点模型结论的数据点）。
      console.log('[key]', event.key, event.modifiers)
    }
  },
})
