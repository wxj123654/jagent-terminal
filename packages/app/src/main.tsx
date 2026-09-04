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

import { render, createRenderer } from '@gpuix/react'
import { installTerminalElement, onSessionEvent } from '@jagent/native'
import type { GpuixRenderer } from '@jagent/native'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { router, activeTargetFromLocation, lastNonSettings } from './router'
import { createThreadStore } from './threads/store'
import { createNativeThreadDeps } from './threads/nativeDeps'
import { narrowSessionEvent } from './threads/events'
import { createSettingsStore } from './settings/store'
import { fsAdapter } from './settings/file'
import { settingsKeyboard } from './surfaces/SettingsView'
import { inputFocus } from './ui/keyboard'
import { createGlobalKeydown } from './keybindings'
import { App } from './plane/AgentPlane'

// ── seam 装配（顺序敏感：先注册元素，再开窗）──────────────────────────
installTerminalElement()

// ── SettingsStore（~/.j-agent/settings.json；S3 事实源）──
// 装配期读盘 await 后再建 ThreadStore（T2.5：nativeDeps 读设置面）。
// 首次运行只读不写（实测 ~/.j-agent 不创建，S3 语义正确）
const settingsStore = createSettingsStore(fsAdapter(join(homedir(), '.j-agent', 'settings.json')))
await settingsStore.init()

// ── ThreadStore（native 依赖注入收口处；设置面先行）──
const threadStore = createThreadStore(createNativeThreadDeps(settingsStore))

onSessionEvent((_err, e) => {
  // seam 边界窄化：未知 type 拒绝（events.ts）
  const n = narrowSessionEvent(e)
  if (n) threadStore.onSessionEvent(n)
})

// ── 窗口（renderer 实例自持：`/` 全局聚焦需要 focusElement 命令面）──
// 先建 renderer 再接键位层（闭包引用 renderer，声明顺序即初始化顺序）
const renderer: GpuixRenderer = createRenderer()
renderer.init({
  title: 'j-agent',
  appName: 'j-agent',
  width: 1180,
  height: 760,
  minWidth: 720,
  minHeight: 480,
})

// ── 全局键位层（keybindings.ts：main/e2e 共用语义；布线在此）──
const handleKeyDown = createGlobalKeydown({
  store: threadStore,
  inSettings: () =>
    activeTargetFromLocation(router.history.location.pathname)?.type === 'settings',
  closeSettings: () => threadStore.activate(lastNonSettings()),
  focusSearch: () => {
    const id = settingsKeyboard.searchInputId()
    if (id != null) renderer.focusElement(id)
  },
  inputFocused: () => inputFocus.any,
  settingsQuery: settingsKeyboard.query,
  escConsumed: settingsKeyboard.escConsumed,
  clearEscConsumed: settingsKeyboard.clearEscConsumed,
})

render(<App store={threadStore} settings={settingsStore} />, {
  renderer,
  onEvent: (event) => {
    if (event.eventType === 'keyDown') {
      const m = event.modifiers
      handleKeyDown(event.key ?? '', m?.ctrl ?? false, m?.shift ?? false)
    }
  },
})
