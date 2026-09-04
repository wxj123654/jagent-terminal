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

import { homedir } from 'node:os'
import { join } from 'node:path'
import { render, createRenderer } from '@gpuix/react'
import { installTerminalElement, onSessionEvent } from '@jagent/native'
import type { GpuixRenderer } from '@jagent/native'

import { createGlobalKeydown } from './keybindings'
import { App } from './plane/AgentPlane'
import type { WindowControls } from './plane/TitleBar'
import { router, activeTargetFromLocation, lastNonSettings } from './router'
import { fsAdapter } from './settings/file'
import { createSettingsStore } from './settings/store'
import { settingsKeyboard } from './surfaces/settingsKeyboard'
import { narrowSessionEvent } from './threads/events'
import { createNativeThreadDeps } from './threads/nativeDeps'
import { createThreadStore } from './threads/store'
import { inputFocus } from './ui/keyboard'
import { PLATFORM } from './ui/platform'

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
  // 自绘顶栏（plane/TitleBar.tsx）：mac/win 隐系统条；linux 保持
  // Server decorations（WM 标题栏在上，TitleBar 退化为内容导航条）
  titlebarTransparent: PLATFORM !== 'linux',
})

// ── 全局键位层（keybindings.ts：main/e2e 共用语义；布线在此）──
// ── 窗口控制 seam（TitleBar 注入；闭包 renderer）──
const windowControls: WindowControls = {
  startMove: () => void renderer.startWindowMove(),
  doubleClick: () => void renderer.titlebarDoubleClick(),
}
const handleKeyDown = createGlobalKeydown({
  store: threadStore,
  inSettings: () => activeTargetFromLocation(router.history.location.pathname)?.type === 'settings',
  closeSettings: () => threadStore.activate(lastNonSettings()),
  focusSearch: () => {
    const id = settingsKeyboard.searchInputId()
    if (id != null) renderer.focusElement(id)
  },
  inputFocused: () => inputFocus.any,
  settingsQuery: settingsKeyboard.query,
  escConsumed: settingsKeyboard.escConsumed,
  clearEscConsumed: settingsKeyboard.clearEscConsumed,
  // 键位真值 = settings 快照（修改即时生效，无需重启；T3+.2）
  keys: () => settingsStore.get().keybindings,
})

render(
  <App store={threadStore} settings={settingsStore} windowControls={windowControls} />,
  {
    renderer,
    onEvent: (event) => {
      if (event.eventType === 'keyDown') {
        const m = event.modifiers
        handleKeyDown(event.key ?? '', m?.ctrl ?? false, m?.shift ?? false)
      }
    },
  },
)
