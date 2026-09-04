/**
 * main.tsx — 装配层（architecture.md §1.2 / §5）。
 *
 * 职责（且仅此三件）：
 * 1. seam 装配：installTerminalElement（renderer.init 之前）+ onSessionEvent
 *    → ThreadStore（全局会话事件，后台也送达）
 * 2. ThreadStore 创建（native 导入收口在本文件）+ 路由 + App 渲染
 *    （GPUIX render 一站式：createRenderer + init + createRoot）
 * 3. 全局键位层（Ctrl-Tab / Ctrl-Shift-Tab / Ctrl-,）：窗口级 keyDown，
 *    只处理带修饰键组合，其余透传（硬约束 2：不吃 vim/claude 按键）。
 *    ⚠ T1.6 验证项：TerminalView 聚焦时窗口 keyDown 是否仍到达——
 *    到达则 Ctrl-Tab 全局可用；否则降级「列表/UI 聚焦时生效」并记录。
 */

import { render } from '@gpuix/react'
import {
  createTerminalSession,
  destroyTerminalSession,
  installTerminalElement,
  onSessionEvent,
} from '@jagent/native'

import { router, navigateTarget, currentActiveThreadId, activeTargetFromLocation } from './router'
import { createThreadStore } from './threads/store'
import { builtinPresetOf } from './threads/presets'
import { App } from './plane/AgentPlane'

// ── seam 装配（顺序敏感：先注册元素，再开窗）──────────────────────────
installTerminalElement()

// ── ThreadStore（native 依赖注入收口处）─────────────────────────────
// napi 命令是同步的（test 路径需本线程 VisualTestState；见 native/lib.rs），
// seam 接口保持 Promise 形态——spawn 在真窗口模式下会短暂阻塞帧循环
// （ConPTY 冷启动 ~1s，用户显式操作，可接受）。
const threadStore = createThreadStore({
  spawnSession: async (o) => createTerminalSession(o),
  destroySession: async (id) => destroyTerminalSession(id),
  navigate: navigateTarget,
  // Phase 2（T2.5 桌面通知定型）前：BEL 通知只落 console
  notify: (t) => console.log(`[notify] bell: t${t.sessionId}`),
  // Phase 2 前默认不关（settings 终端区接线后读真值）
  closeOnExit: () => false,
  presetOf: builtinPresetOf,
  activeThreadId: currentActiveThreadId,
})

onSessionEvent((_err, e) => {
  threadStore.onSessionEvent(e)
})

// ── 全局键位层 ──────────────────────────────────────────────────────
function handleKeyDown(key: string, ctrl: boolean, shift: boolean): void {
  if (!ctrl) return // 只吃修饰键组合，其余透传
  if (key === 'tab') {
    threadStore.cycle(shift ? -1 : 1)
  } else if (key === ',') {
    // Ctrl-, toggle 设置（设置面 ⇄ 上一个非设置目标）
    const cur = activeTargetFromLocation(router.history.location.pathname)
    if (cur?.type === 'settings') threadStore.activate(null)
    else threadStore.activate({ type: 'settings' })
  }
}

// ── 窗口 ────────────────────────────────────────────────────────────
render(<App store={threadStore} />, {
  title: 'j-agent',
  appName: 'j-agent',
  width: 1180,
  height: 760,
  minWidth: 720,
  minHeight: 480,
  onEvent: (event) => {
    if (event.eventType === 'keyDown') {
      const m = event.modifiers
      // 记录到达顺序（T1.6 焦点模型结论的数据点：终端聚焦时窗口级
      // keyDown 是否仍到达）
      if (m?.ctrl) console.log('[key]', event.key, m)
      handleKeyDown(event.key ?? '', m?.ctrl ?? false, m?.shift ?? false)
    }
  },
})
