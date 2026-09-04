/**
 * main.tsx — 装配层（architecture.md §1.2 / §5）。
 *
 * 职责（且仅此三件）：
 * 1. seam 装配：installTerminalElement（renderer.init 之前）+ onSessionEvent
 *    → ThreadStore（全局会话事件，后台也送达）
 * 2. ThreadStore 创建（native 装配在 threads/nativeDeps.ts 工厂）
 *    + 路由 + App 渲染（GPUIX render 一站式：createRenderer + init + createRoot）
 * 3. 全局键位层（Ctrl-Tab / Ctrl-Shift-Tab / Ctrl-,）：窗口级 keyDown，
 *    只处理带修饰键组合，其余透传（硬约束 2：不吃 vim/claude 按键）。
 *    ⚠ T1.6 验证项：TerminalView 聚焦时窗口 keyDown 是否仍到达——
 *    到达则 Ctrl-Tab 全局可用；否则降级「列表/UI 聚焦时生效」并记录。
 */

import { render } from '@gpuix/react'
import { installTerminalElement, onSessionEvent } from '@jagent/native'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { router, activeTargetFromLocation } from './router'
import { createThreadStore } from './threads/store'
import { createNativeThreadDeps } from './threads/nativeDeps'
import { narrowSessionEvent } from './threads/events'
import { createSettingsStore } from './settings/store'
import { fsAdapter } from './settings/file'
import { App } from './plane/AgentPlane'

// ── seam 装配（顺序敏感：先注册元素，再开窗）──────────────────────────
installTerminalElement()

// ── ThreadStore（native 依赖注入收口处：装配工厂 + Phase 2 钩子覆盖）──
const threadStore = createThreadStore(
  createNativeThreadDeps({
    // Phase 2（T2.5）接线处：notify 桌面通知 / closeOnExit 读 settings 终端区
  }),
)

// ── SettingsStore（~/.j-agent/settings.json；S3 事实源）──
// 装配期读盘 await 后再渲染（T2.2 结论：init 是生命周期一部分）
const settingsStore = createSettingsStore(fsAdapter(join(homedir(), '.j-agent', 'settings.json')))
await settingsStore.init()

onSessionEvent((_err, e) => {
  // seam 边界窄化：未知 type 拒绝（events.ts）
  const n = narrowSessionEvent(e)
  if (n) threadStore.onSessionEvent(n)
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
render(<App store={threadStore} settings={settingsStore} />, {
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
