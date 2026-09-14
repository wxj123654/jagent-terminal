/**
 * sidebar-shot.mjs — Sidebar 截图（codex-sidebar-v2 方案 C 对比用）。
 *
 * 跑法：cd packages/app && bun run sidebar-shot.mjs [outPng]
 * 产物：默认 ../../.shots/sidebar-impl.png
 *
 * 数据复刻 design/codex-sidebar-v2.html 的 state.projects：
 *   jagent-terminal（6 会话：pendingReply / pin+unread / idle×4）
 *   dotfiles（1 会话：bell=等待注意）
 *   web（空组）
 *   未归属（7 会话：pendingReply / unread / idle×5）
 * active = jagent 的「IME 候选窗定位」（设计无 active；实现侧展示 .on 态）。
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createTestRoot } from '@gpuix/react/testing'
import { createElement as h } from 'react'

import { Sidebar } from './src/plane/Sidebar.tsx'
import { navigateTarget, currentActiveThreadId } from './src/router.tsx'
import { memoryAdapter } from './src/settings/file.ts'
import { createSettingsStore } from './src/settings/store.ts'
import { builtinPresetOf } from './src/threads/presets.ts'
import { createThreadStore } from './src/threads/store.ts'
import { defaultWorkspace } from './src/threads/workspaces.ts'

const out = process.argv[2] ?? join('..', '..', '.shots', 'sidebar-impl.png')
try {
  mkdirSync(dirname(out), { recursive: true })
} catch {
  // bun Windows: recursive mkdir 对已存在目录仍抛 EEXIST
}

const settings = createSettingsStore(memoryAdapter())
settings.patch('appearance.sidebarWidth', 264)

let nextSession = 1
const store = createThreadStore(
  {
    spawnSession: async () => nextSession++,
    destroySession: async () => {},
    navigate: navigateTarget,
    notify: () => {},
    closeOnExit: () => false,
    presetOf: (id) => builtinPresetOf(id),
    activeThreadId: currentActiveThreadId,
    chatAgent: { send: () => new Promise(() => {}) }, // 永不 resolve → pendingReply 保持
    createAcpAgent: () => ({ send: async () => 'ok' }),
  },
  {
    initialWorkspaces: [
      defaultWorkspace('/w/jagent-terminal'),
      defaultWorkspace('/w/dotfiles'),
      defaultWorkspace('/w/web'),
    ],
  },
)
const [wsJ, wsD] = store.getState().workspaces.map((w) => w.id)

async function term(title, wsId, { bell = false, unread = false } = {}) {
  await store.spawnFromPreset('shell', wsId)
  const t = store.getState().threads.at(-1)
  store.rename(t.id, title)
  // bell 延迟返回：spawn 即 activate，此刻发 bell 会被 isTargetActive 抑制——
  // 由调用方在最终 activate 之后发（见底部）
  if (unread) store.setThreadUnread(t.id, true)
  return { id: t.id, sessionId: t.sessionId, bell }
}

// ── jagent-terminal（设计序：run / pin+unread / idle×4）──
// 注意：sendChatMessage 首条 user 消息会覆盖 title——先 send 再 rename。
async function chatP(title, wsId, opts = {}) {
  store.createChat(wsId)
  const t = store.getState().threads.at(-1)
  if (opts.pending) store.sendChatMessage(t.id, title)
  store.rename(t.id, title)
  if (opts.unread) store.setThreadUnread(t.id, true)
  if (opts.pin) store.setThreadPinned(t.id, true)
  return t.id
}

await chatP('终端接入 IME', wsJ, { pending: true })
await chatP('侧栏重构', wsJ, { unread: true, pin: true })
const activeId = await chatP('IME 候选窗定位', wsJ)
await chatP('titlebar 红绿灯让位', wsJ)
await chatP('导出 patch 流程', wsJ)
await chatP('会话 6', wsJ)

// ── dotfiles（queue = bell 等待注意）──
const dotfilesTerm = await term('同步 nvim 配置', wsD, { bell: true })

// ── 未归属（7 条：run / unread / idle×5）──
await chatP('修复登录鉴权回退', undefined, { pending: true })
await chatP('重构 parser 状态机', undefined, { unread: true })
await chatP('调研 Metal 渲染管线', undefined)
await chatP('写 release notes', undefined)
await chatP('Bump gpuix 依赖', undefined)
await chatP('旧会话 6', undefined)
await chatP('旧会话 7', undefined)

// active = IME 候选窗定位（jagent 组 → 当前工作区高亮）
store.activate({ type: 'thread', id: activeId })

// bell 必须在最终 activate 之后发——active 会话的 bell 会被抑制（契约 §7）
if (dotfilesTerm.bell) {
  store.onSessionEvent({ type: 'bell', sessionId: dotfilesTerm.sessionId })
}

const dialog = {
  openToolMenu: () => {},
  openAddWorkspace: () => {},
  openSearch: () => {},
  openRename: () => {},
  openErrors: () => {},
}

const t = createTestRoot({ width: 264, height: 900 })
t.render(
  h(Sidebar, {
    store,
    settings,
    dialog,
    platform: 'win',
    version: '0.1',
    onNewSession: () => {},
    onCollapse: () => {},
  }),
)
t.renderer.flush()
await new Promise((r) => setTimeout(r, 80))
t.renderer.flush()
t.renderer.captureScreenshot(out)
console.log('saved:', out)
t.unmount()
