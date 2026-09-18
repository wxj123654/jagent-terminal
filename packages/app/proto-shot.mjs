/**
 * proto-shot.mjs — j-agent-prototype.html 走查用实现侧截图。
 *
 * 种子数据 1:1 复刻 design/j-agent-prototype.html 的 seedState()：
 *   ws-jt(pin) / ws-df / ws-web 三工作区 + 15 条会话（chat×3 / acp×1 /
 *   terminal×11，含 pin/unread/pendingReply/bell/exited 全状态组合）。
 *   时钟注入 deps.now——createdAt 与原型逐条对齐（排序 = pin → 优先级 →
 *   createdAt desc，截图顺序因此可复现）。
 *
 * 用法：
 *   cd packages/app && bun run proto-shot.mjs [--width 1280] [--height 800] [--states main,home,...]
 *   默认全量：main home chat acp ws git settings panel search tool addws notif
 *   ctxmenu sess-main sess-git sess-file sess-shell sess-add
 *   窄窗（700）单独跑：--width 700 --states narrow
 * 产物：../../.shots/impl-<state>[-<width>].png
 *
 * 种子含 t-ime 会话内三视图（git/file:Sidebar.tsx/shell:1，activeViewId='git'，
 * 对齐原型 seed.ts）——shell 视图绑真 PTY（fixture）。状态名与原型侧
 * scripts/cmp/shot-proto.mjs 一一对应（ws ↔ workspace）。
 *
 * 已知边界：terminal 表面只有 active 会话挂真 PTY（fixture 脚本打印原型
 * 同款提示行）；其余 terminal 行用假 sessionId（不渲染，无影响）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestRoot } from '@gpuix/react/testing'
import { setAutoFreeze } from 'immer'
import { createElement as h } from 'react'

// 截图脚本需要直接改 store.getState() 注入种子消息/通知（store 公共接口
// 无此面）——关 immer autofreeze 才能 mutate。仅本脚本进程生效。
setAutoFreeze(false)

import {
  createTerminalSession,
  destroyTerminalSession,
  installGitGraphRowElement,
  installTerminalElement,
} from '@jagent/native'

import { emitError } from './src/errors/bus.ts'
import { createGitGraphStore } from './src/git/store.ts'
import { createWorktreeStore } from './src/git/worktree.ts'
import { App } from './src/plane/AgentPlane.tsx'
import { navigateTarget, currentActiveThreadId, currentActiveWorkspaceId } from './src/router.tsx'
import { memoryAdapter } from './src/settings/file.ts'
import { createSettingsStore } from './src/settings/store.ts'
import { builtinPresetOf } from './src/threads/presets.ts'
import { createThreadStore } from './src/threads/store.ts'
import { defaultWorkspace } from './src/threads/workspaces.ts'

// ── 参数 ────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const WIDTH = Number(arg('width', 1280))
const HEIGHT = Number(arg('height', 800))
const GEOM = args.includes('--geom')
const STATES = String(
  arg(
    'states',
    'main,home,chat,acp,ws,git,settings,panel,search,tool,addws,notif,ctxmenu,' +
      'sess-main,sess-git,sess-file,sess-shell,sess-add',
  ),
).split(',')
const OUT_DIR = join('..', '..', '.shots')
try {
  mkdirSync(OUT_DIR, { recursive: true })
} catch {
  // bun Windows: recursive mkdir 对已存在目录仍抛 EEXIST
}

// ── 顺序敏感：元素工厂先注册，再建 renderer（createTerminalSession 的
//    test 路径需要本线程 VisualTestState——root 必须先于种子创建）──────
installTerminalElement()
installGitGraphRowElement()
const t = createTestRoot({ width: WIDTH, height: HEIGHT })

// ── 时钟：原型 seed 的 now-N 偏移逐条对齐 ────────────────────────────
const T0 = 1_800_000_000_000 // 固定基准（2027-01），createdAt 确定性
let clock = T0
const setClock = (offsetMs) => {
  clock = T0 - offsetMs
}

// ── settings（内存适配器；侧栏宽 264 与原型一致）─────────────────────
const settings = createSettingsStore(memoryAdapter())
settings.patch('appearance.sidebarWidth', 264)

// ── chat agent：脚本化回复（第 1 条给原型文案，第 2 条永不 resolve →
//    pendingReply 保持「进行中」橙点）─────────────────────────────────
const REPLY_SIDEBAR =
  '已完成。改动点：\n\n- `Sidebar` 头 52px 只留 panelLeft 钮\n- `WorkspaceList` 顶部新增 nav 行组（新建会话 / 搜索）\n- 工作区分组行：箭头 toggle 与点名激活分离\n\n```ts\n<NavRow icon="plus" label="新建会话" />\n<NavRow icon="search" label="搜索" />\n```\n\n右键与「…」共用同一面 ContextMenu。'
let chatCalls = 0
const chatAgent = {
  send(_text) {
    chatCalls++
    if (chatCalls === 1) return Promise.resolve(REPLY_SIDEBAR)
    return new Promise(() => {}) // 永不 resolve → pendingReply
  },
}

// ── 假 sessionId 序列（避开真 PTY 的 1..N；不渲染的会话不需要真会话）──
let fakeSession = 900
const FAKE_PRESET = { id: 'shot-fake', label: 'shot-fake', builtin: false, program: 'cmd.exe' }
const TERM_FIXTURE = join(import.meta.dir, '__fixtures__', 'shot-term.ts')
const REAL_PRESET = {
  id: 'shot-term',
  label: 'shot-term',
  builtin: false,
  program: process.execPath, // bun
  args: [TERM_FIXTURE],
}

const store = createThreadStore(
  {
    spawnSession: async (o) => {
      // shot-term 预设起真 PTY；「会话内 shell 视图」（无 program 的 spawn，
      // 真实路径 = 默认 shell）也起真 PTY（fixture 提示行）；其余假 id
      if (o.program === process.execPath) return createTerminalSession(o)
      if (!o.program)
        return createTerminalSession({ ...o, program: process.execPath, args: [TERM_FIXTURE] })
      return ++fakeSession
    },
    destroySession: async (id) => {
      if (id < 900) {
        try {
          destroyTerminalSession(id)
        } catch {
          /* 已销毁幂等 */
        }
      }
    },
    navigate: navigateTarget,
    notify: () => {},
    closeOnExit: () => false,
    presetOf: (id) =>
      builtinPresetOf(id) ??
      (id === 'shot-fake' ? FAKE_PRESET : id === 'shot-term' ? REAL_PRESET : undefined),
    activeThreadId: currentActiveThreadId,
    activeWorkspaceId: currentActiveWorkspaceId,
    chatAgent,
    createAcpAgent: () => ({ send: async () => 'ok' }),
    now: () => clock,
  },
  {
    initialWorkspaces: [
      {
        ...defaultWorkspace('D:/document/j-agent'),
        name: 'jagent-terminal',
        pin: true,
        createdAt: T0 - 9e6,
      },
      { ...defaultWorkspace('D:/dotfiles'), name: 'dotfiles', createdAt: T0 - 8e6 },
      { ...defaultWorkspace('D:/projects/web'), name: 'web', createdAt: T0 - 7e6 },
    ],
  },
)
const [wsJt, wsDf, wsWeb] = store.getState().workspaces.map((w) => w.id)

// ── 种子辅助 ────────────────────────────────────────────────────────
const lastThread = () => store.getState().threads.at(-1)

async function term(title, wsId, offsetMs, { exited = false, real = false } = {}) {
  setClock(offsetMs)
  await store.spawnFromPreset(real ? 'shot-term' : 'shot-fake', wsId)
  const t = lastThread()
  store.rename(t.id, title)
  // 退出态直接置位——onSessionEvent('exit') 会顺带 pushNotice，与注入的三条重复
  if (exited) {
    const row = store.getState().threads.find((x) => x.id === t.id)
    if (row?.kind === 'terminal') {
      row.status = 'exited'
      row.exitCode = 0
    }
  }
  return t.id
}

async function chat(title, wsId, offsetMs, { pending = false, unread = false, pin = false } = {}) {
  setClock(offsetMs)
  store.createChat(wsId)
  const t = lastThread()
  if (pending) store.sendChatMessage(t.id, title) // user 消息先落（标题改写），再 rename 冻结
  store.rename(t.id, title)
  if (unread) store.setThreadUnread(t.id, true)
  if (pin) store.setThreadPinned(t.id, true)
  return t.id
}

// ── 种子（原型 seedState 数组序）─────────────────────────────────────
// ws-jt：侧栏重构(pin+unread chat) / 终端接入 IME(pending chat) /
//        会话6 / titlebar / patch / IME 候选窗定位(真 PTY) / 旧会话8(exited)
await chat('侧栏重构', wsJt, 8e6, { unread: true, pin: true })
store.sendChatMessage(lastThread().id, '把侧栏换成方案 C：头只留收起钮，新建/搜索下移为 nav 行')
await new Promise((r) => setTimeout(r, 30)) // 等脚本化回复落列
store.rename(lastThread().id, '侧栏重构')

await chat('终端接入 IME', wsJt, 7e6, { pending: true })
await term('会话 6', wsJt, 3.4e6)
await term('titlebar 红绿灯让位', wsJt, 3.3e6)
await term('导出 patch 流程', wsJt, 3.2e6)
const imeId = await term('IME 候选窗定位', wsJt, 3.1e6, { real: true })
await term('旧会话 8', wsJt, 3e6, { exited: true })

// ws-df：同步 nvim 配置（bell 在最终 activate 之后发，否则被 active 抑制）
const nvimId = await term('同步 nvim 配置', wsDf, 5e5)

// 未归属：修复登录鉴权回退(bell) / 重构 parser 状态机(unread chat) /
//         旧会话7/6/5/4(exited) / Codex (ACP)
const loginId = await term('修复登录鉴权回退', undefined, 4e5)
const parserId = await chat('重构 parser 状态机', undefined, 3e5, { unread: true })
await term('旧会话 7', undefined, 2e5, { exited: true })
await term('旧会话 6', undefined, 1e5, { exited: true })
await term('旧会话 5', undefined, 9e4, { exited: true })
await term('旧会话 4', undefined, 8e4, { exited: true })
setClock(7e4)
store.createAcpThread('acp-codex', 'Codex (ACP)')
const acpId = lastThread().id

// parser / acp 的首条 assistant 消息（原型种子静态文案；store 公共接口
// 无「只加 assistant 消息」面——直接 mutate getState 快照，渲染期现读
// 能读到；autofreeze 已在顶部关闭）。
{
  const s = store.getState()
  const p = s.threads.find((t) => t.id === parserId)
  if (p?.kind === 'chat')
    p.messages.push({
      id: 'm-seed',
      role: 'assistant',
      text: '状态机已拆成 `scan → parse → emit` 三段，错误恢复走 sync 集。',
      at: T0 - 3e5,
    })
  const a = s.threads.find((t) => t.id === acpId)
  if (a?.kind === 'acp')
    a.messages.push({
      id: 'm-seed',
      role: 'assistant',
      text: 'ACP session initialized. model: gpt-5-codex',
      at: T0 - 7e4,
    })
}

// 通知中心（原型三条；pushNotice 只覆盖 bell/exit，「已完成回复」与
// 「PTY 写入失败」实现侧无对应事件——直接注入同形条目）
{
  const s = store.getState()
  const rt = Date.now() // relTime 用真实时钟——at 用真值才能出「N 分钟前」
  s.notices.push(
    {
      id: 'nx1',
      tone: 'warn',
      text: '「同步 nvim 配置」等待注意',
      sub: 'dotfiles · BEL',
      at: rt - 3e5,
      threadId: 'shot-none',
      read: false,
    },
    {
      id: 'nx2',
      tone: 'ok',
      text: '「侧栏重构」已完成回复',
      sub: 'jagent-terminal',
      at: rt - 6e5,
      threadId: 'shot-none',
      read: false,
    },
    {
      id: 'nx3',
      tone: 'err',
      text: 'PTY 写入失败：会话 5',
      sub: '未归属 · EPIPE',
      at: rt - 9e5,
      threadId: 'shot-none',
      read: true,
    },
  )
}

// 错误总线（titlebar ⚠1）
emitError({
  level: 'error',
  kind: 'native',
  message: 'PTY write failed: EPIPE (session 102)',
  context: 'shot',
})

// bell：红点直接置位（真 bell 事件会顺带 pushNotice，与注入的三条重复）
store.activate({ type: 'thread', id: imeId })
// t-ime 会话内视图（对齐原型 seed.ts：views=[git, file:Sidebar.tsx,
// shell:1]，activeViewId='git'）——走真实 store 动作生成同形数据：
// openGitGraph 需活跃会话路由（activeThreadId 经 router），activate 后
// 小等一站再调
await new Promise((r) => setTimeout(r, 30))
store.openGitGraph()
store.openSessionFile(imeId, 'packages/app/src/plane/Sidebar.tsx')
await store.addSessionShell(imeId) // shell:1 —— spawnSession 无 program → fixture 真 PTY
store.activateSessionView(imeId, 'git')
{
  const s = store.getState()
  const nv = s.threads.find((t) => t.id === nvimId)
  if (nv?.kind === 'terminal') nv.hasBell = true
  const lg = s.threads.find((t) => t.id === loginId)
  if (lg?.kind === 'terminal') lg.hasBell = true
}

// ── git 假数据（原型 gitCommits 同序；refNames 走 %D 格式）────────────
const nowSec = Math.floor(Date.now() / 1000)
const COMMITS = [
  {
    sha: 'a4f2c91aaaaaaa000000000000000000000001',
    parents: ['b8e1d03bbbbbbb000000000000000000000001'],
    refNames: ['HEAD -> main', 'origin/main'],
    shortSha: 'a4f2c91',
    authorName: 'you',
    authorEmail: 'you@x',
    timestamp: nowSec - 12 * 60,
    committerName: 'you',
    committerEmail: 'you@x',
    subject: '侧栏方案 C：nav 行下移，头部只留收起钮',
  },
  {
    sha: 'b8e1d03bbbbbbb000000000000000000000001',
    parents: ['c7a9f22ccccccc000000000000000000000001'],
    refNames: [],
    shortSha: 'b8e1d03',
    authorName: 'you',
    authorEmail: 'you@x',
    timestamp: nowSec - 3600,
    committerName: 'you',
    committerEmail: 'you@x',
    subject: '工作面板：变更 tab + 内联 unified diff',
  },
  {
    sha: 'c7a9f22ccccccc000000000000000000000001',
    parents: ['e91c4a7eeeeeee000000000000000000000001', 'd3b55e8ddddddd000000000000000000000001'],
    refNames: [],
    shortSha: 'c7a9f22',
    authorName: 'you',
    authorEmail: 'you@x',
    timestamp: nowSec - 7200,
    committerName: 'you',
    committerEmail: 'you@x',
    subject: 'merge: feat/sidebar-c → main',
  },
  {
    sha: 'd3b55e8ddddddd000000000000000000000001',
    parents: ['e91c4a7eeeeeee000000000000000000000001'],
    refNames: ['feat/sidebar-c'],
    shortSha: 'd3b55e8',
    authorName: 'you',
    authorEmail: 'you@x',
    timestamp: nowSec - 3 * 3600,
    committerName: 'you',
    committerEmail: 'you@x',
    subject: '通知中心：铃铛 + 未读红点 + 全部已读',
  },
  {
    sha: 'e91c4a7eeeeeee000000000000000000000001',
    parents: ['f26d890ffffff000000000000000000000001'],
    refNames: [],
    shortSha: 'e91c4a7',
    authorName: 'you',
    authorEmail: 'you@x',
    timestamp: nowSec - 5 * 3600,
    committerName: 'you',
    committerEmail: 'you@x',
    subject: '键位参数化：四动作从 settings.keybindings 读',
  },
  {
    sha: 'f26d890ffffff000000000000000000000001',
    parents: ['05be3c1000000000000000000000000000001'],
    refNames: ['tag: v0.1'],
    shortSha: 'f26d890',
    authorName: 'you',
    authorEmail: 'you@x',
    timestamp: nowSec - 86400 - 2 * 3600,
    committerName: 'you',
    committerEmail: 'you@x',
    subject: '终端外观走元素 props：字号/色板/光标闪烁实时生效',
  },
  {
    sha: '05be3c1000000000000000000000000000001',
    parents: ['17aa94d111111000000000000000000000000001'],
    refNames: [],
    shortSha: '05be3c1',
    authorName: 'you',
    authorEmail: 'you@x',
    timestamp: nowSec - 86400 - 6 * 3600,
    committerName: 'you',
    committerEmail: 'you@x',
    subject: '会话事件走全局通道：title / bell / exit',
  },
  {
    sha: '17aa94d111111000000000000000000000000001',
    parents: ['92cd1f6222222000000000000000000000000001'],
    refNames: [],
    shortSha: '17aa94d',
    authorName: 'you',
    authorEmail: 'you@x',
    timestamp: nowSec - 2 * 86400,
    committerName: 'you',
    committerEmail: 'you@x',
    subject: 'TerminalPool：切走 retain，后台 PTY 照跑',
  },
  {
    sha: '92cd1f6222222000000000000000000000000001',
    parents: [],
    refNames: [],
    shortSha: '92cd1f6',
    authorName: 'you',
    authorEmail: 'you@x',
    timestamp: nowSec - 3 * 86400,
    committerName: 'you',
    committerEmail: 'you@x',
    subject: 'init: GPUIX × Zed terminal 骨架',
  },
]
const COMMIT_FILES = {
  a4f2c91: ['packages/app/src/plane/Sidebar.tsx', 'packages/app/src/plane/WorkspaceList.tsx'],
  b8e1d03: ['packages/app/src/plane/WorkPanel.tsx', 'packages/app/src/git/worktree.ts'],
  c7a9f22: ['packages/app/src/plane/WorkspaceList.tsx'],
  d3b55e8: ['packages/app/src/plane/Sidebar.tsx', 'packages/app/src/threads/store.ts'],
  e91c4a7: ['packages/app/src/keybindings.ts', 'packages/app/src/settings/schema.ts'],
  f26d890: ['packages/app/src/surfaces/TerminalSurface.tsx'],
  '05be3c1': ['packages/app/src/threads/events.ts'],
  '17aa94d': ['crates/jagent-terminal/src/pool.rs'],
  '92cd1f6': ['Cargo.toml', 'packages/app/src/main.tsx'],
}
const COMMIT_BODY = {
  a4f2c91: '头部图标条撤下，新建/搜索改为全宽文字行。\n工作区分组行：箭头 toggle 与点名激活分离。',
  b8e1d03: '<1100px 转 absolute overlay，不压缩终端。',
  c7a9f22: '合并侧栏方案 C 分支。',
}

const gitStore = createGitGraphStore({
  findRepoRoot: async () => 'D:/document/j-agent',
  spawnGitLog: (_cwd, onChunk) => {
    queueMicrotask(() => onChunk(COMMITS))
    return { cancel() {}, done: Promise.resolve({ ok: true }) }
  },
  showCommitBody: async (_cwd, sha) => COMMIT_BODY[sha.slice(0, 7)] ?? '',
  listChangedFiles: async (_cwd, sha) =>
    (COMMIT_FILES[sha.slice(0, 7)] ?? []).map((p) => ({ path: p, added: 10, deleted: 2 })),
  listBranches: async () => [
    { name: 'main', current: true },
    { name: 'feat/sidebar-c', current: false },
    { name: 'fix/ime-candidate', current: false },
  ],
  runGit: async () => '',
})

// ── worktree 假数据（原型 wt.files + DIFFS）──────────────────────────
const WT_FILES = [
  { path: 'packages/app/src/plane/Sidebar.tsx', status: 'm', added: 42, deleted: 18 },
  { path: 'packages/app/src/plane/WorkspaceList.tsx', status: 'm', added: 96, deleted: 31 },
  { path: 'packages/app/src/tokens.ts', status: 'm', added: 6, deleted: 2 },
  { path: 'packages/ui/src/display/Icon.tsx', status: 'm', added: 12, deleted: 0 },
  { path: 'design/j-agent-prototype.html', status: 'a', added: 812, deleted: 0 },
  { path: 'packages/app/src/plane/ToolMenu.tsx', status: 'd', added: 0, deleted: 88 },
]
const WT_DIFF =
  'diff --git a/packages/app/src/plane/Sidebar.tsx b/packages/app/src/plane/Sidebar.tsx\nindex 1111111..2222222 100644\n--- a/packages/app/src/plane/Sidebar.tsx\n+++ b/packages/app/src/plane/Sidebar.tsx\n@@ -44,6 +44,18 @@ export function Sidebar({\n   const drag = useTitleBarDrag(windowControls)\n   return (\n-    <div testId="sidebar">\n+    <div testId="sidebar" style={{ width }}>\n       <SidebarHeader />\n       <WorkspaceList />\n+      {/* 脚：设置 + 通知铃 + 版本号 */}\n       <SidebarFooter />'
const worktree = createWorktreeStore({
  status: async () => ({ root: 'D:/document/j-agent', branch: 'main', files: WT_FILES }),
  diff: async (_root, path) => (path.endsWith('Sidebar.tsx') ? WT_DIFF : ''),
  readFile: async () => null,
})

// ── 渲染 ────────────────────────────────────────────────────────────
t.render(
  h(App, {
    store,
    settings,
    gitStore,
    worktree,
    version: '0.1',
    windowControls: { startMove() {}, doubleClick() {}, minimize() {}, maximize() {}, close() {} },
  }),
)

const flush = async (ms = 120) => {
  t.renderer.flush()
  await new Promise((r) => setTimeout(r, ms))
  t.renderer.flush()
}
const shot = (name) => {
  const suffix = WIDTH === 1280 ? '' : `-${WIDTH}`
  const out = join(OUT_DIR, `impl-${name}${suffix}.png`)
  t.renderer.captureScreenshot(out)
  console.log('saved:', out)
  if (GEOM) dumpGeom(name)
}

/**
 * --geom：连同截图导出整棵元素树的实测几何（bounds + 文本 + 关键样式）到
 * .shots/cmp/geom-impl-<state>.json。原型侧的同名脚本是
 * .shots/cmp/geom-proto.mjs（chrome getBoundingClientRect），两边逐字段
 * 比对即可做像素级核对，不必靠肉眼看截图。
 */
function dumpGeom(name) {
  const root = t.renderer.getRoot()
  const nodes = []
  const walk = (el, depth, path) => {
    if (!el) return
    const b = t.renderer.getElementBounds(el.id)
    const s = el.style ?? {}
    nodes.push({
      path,
      depth,
      type: el.type,
      testId: el.testId ?? null,
      text: el.text ?? null,
      x: b ? +b.x.toFixed(1) : null,
      y: b ? +b.y.toFixed(1) : null,
      w: b ? +b.width.toFixed(1) : null,
      h: b ? +b.height.toFixed(1) : null,
      bg: s.backgroundColor ?? null,
      color: s.color ?? null,
      fs: s.fontSize ?? null,
      fw: s.fontWeight ?? null,
      pl: s.paddingLeft ?? null,
      pr: s.paddingRight ?? null,
      ml: s.marginLeft ?? null,
      mt: s.marginTop ?? null,
      gap: s.gap ?? null,
      br: s.borderRadius ?? null,
      bl: s.borderLeftWidth ?? null,
    })
    let i = 0
    for (const cid of el.children ?? []) {
      walk(t.renderer.getElement(cid), depth + 1, `${path}/${i}`)
      i++
    }
  }
  walk(root, 0, '')
  const out = join(OUT_DIR, 'cmp', `geom-impl-${name}${WIDTH === 1280 ? '' : `-${WIDTH}`}.json`)
  try {
    mkdirSync(join(OUT_DIR, 'cmp'), { recursive: true })
  } catch {}
  writeFileSync(out, JSON.stringify(nodes, null, 0))
  console.log('geom:', out, nodes.length, 'nodes')
}
const clickTestId = (testId, button = 0) => {
  const el = t.renderer.findByTestId(testId)
  if (!el) throw new Error(`testId not found: ${testId}`)
  const b = t.renderer.getElementBounds(el.id)
  if (!b) throw new Error(`no bounds: ${testId}`)
  // getElementBounds 返回 {x,y,width,height}（gpuix eac7181 起，数组形态已废）
  t.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2, button)
}
/** 关弹窗：Esc 走焦点元素冒泡到 Modal；兜底点遮罩 */
const closeDialog = async () => {
  // Esc 走焦点元素冒泡到 Modal（nativeSimulateKeyDown 需要元素 id——
  // 用根元素；Modal 的 keydown 在卡片上，冒泡链从焦点起）
  const root = t.renderer.getRoot()
  if (root) t.renderer.nativeSimulateKeyDown(root.id, 'escape')
  await flush(60)
  const scrim = t.renderer.findByTestId('modal-scrim')
  if (scrim) {
    const b = t.renderer.getElementBounds(scrim.id)
    if (b) t.renderer.nativeSimulateClick(b.x + 10, b.y + 10)
    await flush(60)
  }
}

await flush(600) // 真 PTY 输出 + worktree mount 落定

for (const state of STATES) {
  switch (state) {
    case 'main':
      // 原型默认路由 = t-ime + activeViewId='git'（会话内 Git 图页）
      store.activate({ type: 'thread', id: imeId })
      store.activateSessionView(imeId, 'git')
      await flush(300)
      shot('main')
      break
    case 'home':
      navigateTarget(null)
      await flush()
      shot('home')
      break
    case 'chat': {
      const id = store.getState().threads.find((x) => x.title === '侧栏重构').id
      store.activate({ type: 'thread', id })
      await flush()
      shot('chat')
      break
    }
    case 'ws':
      store.activate({ type: 'workspace', id: wsWeb })
      await flush()
      shot('ws')
      break
    case 'git':
      store.activate({ type: 'workspace', id: wsJt })
      store.setWorkspacePaneTab(wsJt, 'git')
      await flush(300)
      shot('git')
      break
    case 'settings':
      navigateTarget({ type: 'settings' })
      await flush()
      shot('settings')
      break
    case 'panel':
      navigateTarget({ type: 'thread', id: imeId })
      store.activateSessionView(imeId, 'git') // 原型 ?view=panel：t-ime 默认停在 git 视图
      await flush()
      clickTestId('panel-toggle')
      await flush()
      worktree.select('packages/app/src/plane/Sidebar.tsx')
      await flush()
      shot('panel')
      // 面板是持续态：不关会污染后续 search/tool/notif/ctxmenu 截图
      // （原型的 ?view=search 等不带面板）。
      clickTestId('panel-toggle')
      await flush()
      break
    case 'search':
      clickTestId('nav-search')
      await flush()
      shot('search')
      await closeDialog()
      break
    case 'tool':
      clickTestId('nav-new-chat')
      await flush()
      shot('tool')
      await closeDialog()
      break
    case 'notif':
      await closeDialog()
      clickTestId('open-notifications')
      await flush()
      shot('notif')
      break
    case 'ctxmenu': {
      await closeDialog()
      const row = t.renderer.findByTestId(`row-${imeId}`)
      const b = t.renderer.getElementBounds(row.id)
      t.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2, 2) // 右键
      await flush()
      shot('ctxmenu')
      // 关菜单：Esc 必须发到 Popover 内容盒（autoFocus 焦点在 context-menu
      // 上，发 root 不会向上冒泡）——不关会一直挂着污染后续 sess-* 截图
      {
        const menu = t.renderer.findByTestId('context-menu')
        if (menu) t.renderer.nativeSimulateKeyDown(menu.id, 'escape')
        await flush(60)
        if (t.renderer.findByTestId('context-menu')) {
          // 兜底：onMouseDownOutside（点侧栏空白）
          t.renderer.nativeSimulateClick(600, 500)
          await flush(60)
        }
      }
      break
    }
    case 'acp':
      store.activate({ type: 'thread', id: acpId })
      await flush()
      shot('acp')
      break
    case 'addws':
      clickTestId('add-workspace')
      await flush()
      shot('addws')
      await closeDialog()
      break
    // ── 会话内视图（原型 t-ime 的 SessionTabs 页签；sess-add=「+」浮层）──
    case 'sess-main':
    case 'sess-git':
    case 'sess-file':
    case 'sess-shell': {
      const viewId = {
        'sess-main': 'main',
        'sess-git': 'git',
        'sess-file': 'file:packages/app/src/plane/Sidebar.tsx',
        'sess-shell': 'shell:1',
      }[state]
      store.activate({ type: 'thread', id: imeId })
      store.activateSessionView(imeId, viewId)
      await flush(300) // git lane 计算 / FileSurface 真读盘 / shell PTY 输出
      shot(state)
      break
    }
    case 'sess-add': {
      store.activate({ type: 'thread', id: imeId })
      store.activateSessionView(imeId, 'git')
      await flush()
      clickTestId('session-add')
      await flush()
      shot('sess-add')
      // 收浮层：Esc 到 pop 内容盒（autoFocus 挂载即聚焦）
      const pop = t.renderer.findByTestId('session-add-pop')
      if (pop) t.renderer.nativeSimulateKeyDown(pop.id, 'escape')
      await flush(60)
      break
    }
    case 'narrow':
      shot('narrow')
      break
    case 'errors':
      clickTestId('error-indicator')
      await flush()
      shot('errors')
      await closeDialog()
      break
    case 'font':
      navigateTarget({ type: 'settings' })
      await flush()
      // 设置分区深链：terminal 分区（字体选择器所在）
      {
        const { navigateSettingsSection } = await import('./src/router.tsx')
        navigateSettingsSection('terminal')
      }
      await flush()
      clickTestId('setting-terminal.fontFamily')
      await flush(300) // 字体清单懒加载
      shot('font')
      await closeDialog()
      break
    case 'crash': {
      // 崩溃残留弹窗只在 App 挂载时读 lastCrash（useState 初值）——
      // 重渲染注入无效，需独立 root 首渲带 prop。
      const t2 = createTestRoot({ width: WIDTH, height: HEIGHT })
      t2.render(
        h(App, {
          store,
          settings,
          gitStore,
          worktree,
          version: '0.1',
          lastCrash: {
            kind: 'panic',
            message: 'called `Option::unwrap()` on a `None` value',
            location: 'crates/jagent-terminal/src/pool.rs:97',
            dumpPath: 'C:/Users/x/AppData/Roaming/j-agent/crash/minidump.dmp',
            appVersion: '0.1',
            at: Date.now() - 86400_000,
          },
          windowControls: {
            startMove() {},
            doubleClick() {},
            minimize() {},
            maximize() {},
            close() {},
          },
        }),
      )
      t2.renderer.flush()
      await new Promise((r) => setTimeout(r, 120))
      t2.renderer.flush()
      const out = join(OUT_DIR, `impl-crash${WIDTH === 1280 ? '' : `-${WIDTH}`}.png`)
      t2.renderer.captureScreenshot(out)
      console.log('saved:', out)
      t2.unmount()
      break
    }
    case 'hidden':
      // 侧栏收起（Ctrl-B 同路径：planeKeyboard 模块态）
      {
        const { planeKeyboard } = await import('./src/plane/planeKeyboard.ts')
        planeKeyboard.toggleSidebar()
      }
      await flush()
      shot('hidden')
      break
    default:
      console.warn('unknown state:', state)
  }
}

// 清理真 PTY（会话本体 + 会话内 shell 视图各自绑一个）
for (const th of store.getState().threads) {
  if (th.kind === 'terminal' && th.sessionId < 900) {
    try {
      destroyTerminalSession(th.sessionId)
    } catch {}
  }
  for (const v of th.views ?? []) {
    if (v.kind === 'shell' && v.sessionId < 900) {
      try {
        destroyTerminalSession(v.sessionId)
      } catch {}
    }
  }
}
t.unmount()
console.log('done')
