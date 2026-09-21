import type {
  GitCommit, Settings, Thread, Workspace, Notice, ErrItem, UiState, GitState, WorktreeState,
} from './types'

export const GROUP_LIMIT = 4
export const NARROW_BP = 760
export const PANEL_OVERLAY_W = 1100

const now = Date.now()

export function seedWorkspaces(): Workspace[] {
  return [
    { id: 'ws-jt', name: 'jagent-terminal', path: 'D:/document/j-agent', pin: true, expanded: true, createdAt: now - 9e6, paneTab: 'home' },
    { id: 'ws-df', name: 'dotfiles', path: 'D:/dotfiles', expanded: true, createdAt: now - 8e6, paneTab: 'home' },
    { id: 'ws-web', name: 'web', path: 'D:/projects/web', expanded: true, createdAt: now - 7e6, paneTab: 'home' },
  ]
}

export function seedThreads(): Thread[] {
  return [
    { id: 't-sidebar', kind: 'chat', title: '侧栏重构', workspaceId: 'ws-jt', pin: true, unread: true, createdAt: now - 8e6,
      messages: [
        { id: 'm1', role: 'user', text: '把侧栏换成方案 C：头只留收起钮，新建/搜索下移为 nav 行' },
        { id: 'm2', role: 'assistant', text: '已完成。改动点：\n\n- `Sidebar` 头 52px 只留 panelLeft 钮\n- `WorkspaceList` 顶部新增 nav 行组（新建会话 / 搜索）\n- 工作区分组行：箭头 toggle 与点名激活分离\n\n```ts\n<NavRow icon="plus" label="新建会话" />\n<NavRow icon="search" label="搜索" />\n```\n\n右键与「…」共用同一面 ContextMenu。' },
      ],
      pendingReply: false },
    { id: 't-ime2', kind: 'chat', title: '终端接入 IME', workspaceId: 'ws-jt', createdAt: now - 7e6,
      messages: [
        { id: 'm1', role: 'user', text: 'IME 候选窗跟随光标，GPUI 侧怎么拿光标坐标？' },
        { id: 'm2', role: 'assistant', text: '两条路：\n\n1. alacritty model 的 `cursor.point` → cell 行列 → 乘 cell 尺寸得像素坐标\n2. 经 `ime_position` custom prop 透传给元素\n\n候选窗定位在 view 层做，不进 pool。' },
      ],
      pendingReply: true },
    { id: 't-s6', kind: 'terminal', title: '会话 6', workspaceId: 'ws-jt', createdAt: now - 3.4e6, sessionId: 106, status: 'running', cwd: 'D:/document/j-agent' },
    { id: 't-tb', kind: 'terminal', title: 'titlebar 红绿灯让位', workspaceId: 'ws-jt', createdAt: now - 3.3e6, sessionId: 107, status: 'running', cwd: 'D:/document/j-agent' },
    { id: 't-patch', kind: 'terminal', title: '导出 patch 流程', workspaceId: 'ws-jt', createdAt: now - 3.2e6, sessionId: 108, status: 'running', cwd: 'D:/document/j-agent' },
    { id: 't-ime', kind: 'terminal', title: 'IME 候选窗定位', workspaceId: 'ws-jt', createdAt: now - 3.1e6, sessionId: 109, status: 'running', cwd: 'D:/document/j-agent',
      views: [
        { id: 'git', kind: 'git', label: 'Git 图' },
        { id: 'file:packages/app/src/plane/Sidebar.tsx', kind: 'file', label: 'Sidebar.tsx', path: 'packages/app/src/plane/Sidebar.tsx' },
        { id: 'shell:1', kind: 'shell', label: 'Shell 1', cwd: 'D:/document/j-agent', lines: [{ spans: [{ text: '# D:/document/j-agent — Session 内工具', cls: 'c-dim' }] }], draft: '' },
      ],
      activeViewId: 'git' },
    { id: 't-old8', kind: 'terminal', title: '旧会话 8', workspaceId: 'ws-jt', createdAt: now - 3e6, sessionId: 105, status: 'exited', cwd: 'D:/document/j-agent' },
    { id: 't-nvim', kind: 'terminal', title: '同步 nvim 配置', workspaceId: 'ws-df', hasBell: true, createdAt: now - 5e5, sessionId: 110, status: 'running', cwd: 'D:/dotfiles' },
    { id: 't-login', kind: 'terminal', title: '修复登录鉴权回退', hasBell: true, createdAt: now - 4e5, sessionId: 111, status: 'running', cwd: 'D:/document/j-agent' },
    { id: 't-parser', kind: 'chat', title: '重构 parser 状态机', unread: true, createdAt: now - 3e5,
      messages: [{ id: 'm1', role: 'assistant', text: '状态机已拆成 `scan → parse → emit` 三段，错误恢复走 sync 集。' }], pendingReply: false },
    { id: 't-old7', kind: 'terminal', title: '旧会话 7', createdAt: now - 2e5, sessionId: 104, status: 'exited', cwd: 'D:/document/j-agent' },
    { id: 't-old6', kind: 'terminal', title: '旧会话 6', createdAt: now - 1e5, sessionId: 103, status: 'exited', cwd: 'D:/document/j-agent' },
    { id: 't-old5', kind: 'terminal', title: '旧会话 5', createdAt: now - 9e4, sessionId: 102, status: 'exited', cwd: 'D:/document/j-agent' },
    { id: 't-old4', kind: 'terminal', title: '旧会话 4', createdAt: now - 8e4, sessionId: 101, status: 'exited', cwd: 'D:/document/j-agent' },
    { id: 't-acp', kind: 'acp', title: 'Codex (ACP)', createdAt: now - 7e4,
      messages: [{ id: 'm1', role: 'assistant', text: 'ACP session initialized. model: gpt-5-codex' }], pendingReply: false },
  ]
}

export function seedNotices(): Notice[] {
  return [
    { id: 'n1', tone: 'warn', title: '「同步 nvim 配置」等待注意', sub: 'dotfiles · BEL', at: now - 3e5 },
    { id: 'n2', tone: 'ok', title: '「侧栏重构」已完成回复', sub: 'jagent-terminal', at: now - 6e5 },
    { id: 'n3', tone: 'err', title: 'PTY 写入失败：会话 5', sub: '未归属 · EPIPE', at: now - 9e5 },
  ]
}

export function seedErrors(): ErrItem[] {
  return [{ level: 'error', area: 'native', message: 'PTY write failed: EPIPE (session 102)', at: now - 9e5 }]
}

export function seedSettings(): Settings {
  return {
    notifications: { desktop: true, sound: false },
    terminal: { fontFamily: 'JetBrains Mono', fontSize: 13, cursorBlink: true, scrollbackLines: 10000, palette: 'one-dark', closeOnExit: false },
    appearance: { theme: 'one-dark', sidebarWidth: 264 },
    keybindings: { cycleNext: 'ctrl-tab', cyclePrev: 'ctrl-shift-tab', toggleSettings: 'ctrl-,', focusSearch: '/', searchThreads: 'ctrl-k', toggleSidebar: 'ctrl-b', newSession: 'ctrl-shift-n' },
    presets: {
      plusDefault: null,
      items: [
        { id: 'pi', label: 'Pi', initCommand: 'pi', category: 'agent', builtin: true, description: '在项目中对话、读写代码、调用工具' },
        { id: 'claude', label: 'Claude Code', initCommand: 'claude', category: 'agent', builtin: true, description: '使用 Claude Code 的终端界面' },
        { id: 'codex', label: 'Codex', initCommand: 'codex', category: 'agent', builtin: true, description: '使用 Codex CLI 的终端界面' },
        { id: 'amp', label: 'Amp', program: 'amp', category: 'agent', builtin: true, description: '使用 Amp 的终端界面' },
        { id: 'shell', label: 'Shell', category: 'tool', builtin: true, description: '运行命令、脚本和开发服务' },
      ],
    },
    acpAgents: [
      { id: 'acp-codex', label: 'Codex (ACP)', command: 'codex', args: ['--acp'] },
      { id: 'acp-claude', label: 'Claude (ACP)', command: 'claude-code-acp', args: [] },
    ],
    advanced: { gpuBackend: 'auto', perfHud: false, frameOverlay: false },
  }
}

export function seedUi(): UiState {
  return {
    sidebarHidden: false, drawerOpen: false,
    panelOpen: false, panelTab: 'changes', panelWidth: 280,
    dialog: { kind: 'none' }, notifOpen: false,
    settingsSection: 'presets', settingsQuery: '',
    toolFilter: '', toolWs: null, searchQuery: '', searchCursor: 0,
    expandedPreset: null, expandedAgent: null, kbCapturing: null,
    gitFindOpen: false, gitFindDraft: '',
    fontPicker: null,
    tabs: [{ type: 'thread', id: 't-sidebar' }, { type: 'thread', id: 't-ime' }, { type: 'thread', id: 't-acp' }],
    navBack: [], navFwd: [],
    winW: 1280, winH: 800,
  }
}

export function seedGit(): GitState {
  return {
    branch: 'main', showRemote: true, selectedSha: null, findIdx: 0,
    branches: [
      { name: 'main', current: true, up: 'origin/main' },
      { name: 'feat/sidebar-c', current: false, up: '' },
      { name: 'fix/ime-candidate', current: false, up: 'origin/fix/ime-candidate' },
      { name: 'dev', current: false, up: '' },
    ],
  }
}

export function seedWorktree(): WorktreeState {
  return {
    status: 'ok', selected: null, branch: 'main',
    files: [
      { path: 'packages/app/src/plane/Sidebar.tsx', status: 'm', added: 42, deleted: 18 },
      { path: 'packages/app/src/plane/WorkspaceList.tsx', status: 'm', added: 96, deleted: 31 },
      { path: 'packages/app/src/tokens.ts', status: 'm', added: 6, deleted: 2 },
      { path: 'packages/ui/src/display/Icon.tsx', status: 'm', added: 12, deleted: 0 },
      { path: 'design/j-agent-prototype.html', status: 'a', added: 812, deleted: 0 },
      { path: 'packages/app/src/plane/ToolMenu.tsx', status: 'd', added: 0, deleted: 88 },
    ],
  }
}

/* ═══ 设置定义（schema.ts SETTING_DEFS）═══ */
export interface SettingDef {
  path: string
  section: string
  label: string
  desc: string
  type: 'toggle' | 'font' | 'number' | 'select' | 'range' | 'text'
  min?: number
  max?: number
  step?: number
  options?: { value: string; label: string }[]
  mono?: boolean
}

export const SECTIONS = [
  { id: 'presets', label: 'Presets · 预设' },
  { id: 'notifications', label: 'Notifications · 通知' },
  { id: 'terminal', label: 'Terminal · 终端' },
  { id: 'appearance', label: 'Appearance · 外观' },
  { id: 'keybindings', label: 'Keybindings · 键位' },
  { id: 'acp', label: 'ACP Agents · 外部 agent' },
  { id: 'advanced', label: 'Advanced · 高级' },
]

export const SETTING_DEFS: SettingDef[] = [
  { path: 'notifications.desktop', section: 'notifications', label: '桌面通知', desc: 'BEL 且未聚焦时弹出系统通知；聚焦该 thread 即清除', type: 'toggle' },
  { path: 'notifications.sound', section: 'notifications', label: '通知声音', desc: '通知附带提示音（依赖桌面通知开启）', type: 'toggle' },
  { path: 'terminal.fontFamily', section: 'terminal', label: '字体', desc: '终端专用 mono 字体，不继承 UI 字体', type: 'font' },
  { path: 'terminal.fontSize', section: 'terminal', label: '字号', desc: '行高与 cell 尺寸由 TerminalView 自管', type: 'number', min: 10, max: 22, step: 1 },
  { path: 'terminal.cursorBlink', section: 'terminal', label: '光标闪烁', desc: '系统 reduced-motion 开启时自动关闭', type: 'toggle' },
  { path: 'terminal.scrollbackLines', section: 'terminal', label: '回滚行数', desc: 'scrollback 缓冲区大小', type: 'number', min: 1000, max: 100000, step: 500 },
  { path: 'terminal.palette', section: 'terminal', label: '调色板', desc: '终端背景与 16 色独立于父容器', type: 'select', options: [{ value: 'one-dark', label: 'One Dark' }] },
  { path: 'terminal.closeOnExit', section: 'terminal', label: '退出后直接关闭', desc: '进程 exit 后：开=直接销毁该行；关=保留 exited 灰行查看残留（默认保留）', type: 'toggle' },
  { path: 'appearance.theme', section: 'appearance', label: '主题', desc: 'V2 单色暗色（值名 one-dark 为落盘兼容）', type: 'select', options: [{ value: 'one-dark', label: 'Mono Dark（默认）' }, { value: 'one-dark-pro', label: 'One Dark Pro · Phase 2' }, { value: 'light', label: 'Light · Phase 2' }] },
  { path: 'appearance.sidebarWidth', section: 'appearance', label: '侧栏宽度', desc: 'thread 列表宽度，拖拽时实时写回', type: 'range', min: 200, max: 400, step: 2 },
  { path: 'advanced.gpuBackend', section: 'advanced', label: 'GPU 后端', desc: 'GPUIX（pinned GPUI fork）渲染后端', type: 'select', options: [{ value: 'auto', label: 'Auto（推荐）' }, { value: 'dx12', label: 'DirectX 12' }, { value: 'vulkan', label: 'Vulkan' }, { value: 'metal', label: 'Metal' }] },
  { path: 'advanced.perfHud', section: 'advanced', label: '性能指标 HUD', desc: '在标题栏右上角显示整 app 帧率、整帧耗时（p90/max）、终端 paint 与 CPU/内存（500ms 刷新）', type: 'toggle' },
  { path: 'advanced.frameOverlay', section: 'advanced', label: '屏幕帧覆盖层', desc: 'GPUIX 内建调试 overlay：把整帧耗时直方图直接画在画面上（与 HUD 数字同源）', type: 'toggle' },
]

export const DEFAULTS: Record<string, unknown> = {
  'notifications.desktop': true, 'notifications.sound': false,
  'terminal.fontFamily': 'JetBrains Mono', 'terminal.fontSize': 13, 'terminal.cursorBlink': true,
  'terminal.scrollbackLines': 10000, 'terminal.palette': 'one-dark', 'terminal.closeOnExit': false,
  'appearance.theme': 'one-dark', 'appearance.sidebarWidth': 264,
  'advanced.gpuBackend': 'auto', 'advanced.perfHud': false, 'advanced.frameOverlay': false,
  'keybindings.cycleNext': 'ctrl-tab', 'keybindings.cyclePrev': 'ctrl-shift-tab', 'keybindings.toggleSettings': 'ctrl-,',
  'keybindings.focusSearch': '/', 'keybindings.searchThreads': 'ctrl-k', 'keybindings.toggleSidebar': 'ctrl-b', 'keybindings.newSession': 'ctrl-shift-n',
}

export const KEY_ACTIONS = [
  { action: 'cycleNext', label: '下一个 thread（循环切换）' },
  { action: 'cyclePrev', label: '上一个 thread（循环切换）' },
  { action: 'toggleSettings', label: '打开 / 关闭设置' },
  { action: 'focusSearch', label: '聚焦设置搜索' },
  { action: 'searchThreads', label: '搜索会话（⌘K/Ctrl-K）' },
  { action: 'toggleSidebar', label: '收起 / 展开侧栏（⌘B/Ctrl-B）' },
  { action: 'newSession', label: '新建会话（⌘N）' },
]

export const FIXED_KEYS: [string, string][] = [
  ['返回 / 清空搜索', 'Esc（平台语义）'],
  ['新建 / 预设菜单', '+ 单击 / Shift +'],
]

export const CONVENTIONS: [string, string][] = [
  ['Pi', '.pi/extensions/zed-bell.ts 在 agent_end 写 \\x07'],
  ['Amp', 'env AMP_FORCE_BEL=1'],
  ['Claude', 'settings.json → preferredNotifChannel: "terminal_bell"'],
  ['Codex', 'tui.terminal_title → OSC 标题'],
]

/* ═══ 字体选择器候选（原型用常见字体表 + document.fonts.check 过滤）═══ */
export const FONT_CANDIDATES = [
  'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Courier New', 'Fira Code', 'Fira Mono',
  'JetBrains Mono', 'JetBrains Mono NL', 'Source Code Pro', 'IBM Plex Mono', 'Iosevka',
  'Hack', 'Inconsolata', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono',
  'Lucida Console', 'Menlo', 'SF Mono', 'Monaco', 'Victor Mono', 'Cousine', 'Roboto Mono',
  'Noto Sans Mono', 'Intel One Mono', 'Geist Mono', 'Maple Mono', 'Sarasa Mono SC',
  'Microsoft YaHei UI', 'Microsoft YaHei', 'SimSun', 'NSimSun', 'SimHei', 'KaiTi', 'DengXian',
  'Segoe UI', 'Segoe UI Variable', 'Arial', 'Helvetica', 'Times New Roman', 'Georgia',
  'Verdana', 'Tahoma', 'Trebuchet MS', 'Calibri', 'Cambria', 'Inter', 'PingFang SC',
  'Hiragino Sans GB', 'Noto Sans CJK SC', 'Noto Serif CJK SC', 'WenQuanYi Micro Hei',
]

/* ═══ Git 图数据 ═══ */
export const LANE_COLORS = ['#61afef', '#98c379', '#c678dd', '#e5c07b', '#56b6c2', '#e06c75', '#d19a66', '#be5046']
export const LANE_W = 13
export const PAD_X = 8
export const MIN_LANES = 6
export const GIT_ROW_H = 26

export const GIT_COMMITS: GitCommit[] = [
  { sha: 'a4f2c91', msg: '侧栏方案 C：nav 行下移，头部只留收起钮', author: 'you', time: '12 分钟前', lane: 0, lanes: [0], refs: [{ k: 'head', t: 'HEAD' }, { k: 'branch', t: 'main' }, { k: 'remote', t: 'origin/main' }], files: ['packages/app/src/plane/Sidebar.tsx', 'packages/app/src/plane/WorkspaceList.tsx'], body: '头部图标条撤下，新建/搜索改为全宽文字行。\n工作区分组行：箭头 toggle 与点名激活分离。' },
  { sha: 'b8e1d03', msg: '工作面板：变更 tab + 内联 unified diff', author: 'you', time: '1 小时前', lane: 0, lanes: [0], files: ['packages/app/src/plane/WorkPanel.tsx', 'packages/app/src/git/worktree.ts'], body: '<1100px 转 absolute overlay，不压缩终端。' },
  { sha: 'c7a9f22', msg: 'merge: feat/sidebar-c → main', author: 'you', time: '2 小时前', lane: 0, lanes: [0, 1], merge: { from: 1, to: 0 }, files: ['packages/app/src/plane/WorkspaceList.tsx'], body: '合并侧栏方案 C 分支。' },
  { sha: 'd3b55e8', msg: '通知中心：铃铛 + 未读红点 + 全部已读', author: 'you', time: '3 小时前', lane: 1, lanes: [0, 1], refs: [{ k: 'branch', t: 'feat/sidebar-c' }], files: ['packages/app/src/plane/Sidebar.tsx', 'packages/app/src/threads/store.ts'], body: '' },
  { sha: 'e91c4a7', msg: '键位参数化：四动作从 settings.keybindings 读', author: 'you', time: '5 小时前', lane: 0, lanes: [0], files: ['packages/app/src/keybindings.ts', 'packages/app/src/settings/schema.ts'], body: '' },
  { sha: 'f26d890', msg: '终端外观走元素 props：字号/色板/光标闪烁实时生效', author: 'you', time: '昨天 21:40', lane: 0, lanes: [0], refs: [{ k: 'tag', t: 'v0.1' }], files: ['packages/app/src/surfaces/TerminalSurface.tsx'], body: '' },
  { sha: '05be3c1', msg: '会话事件走全局通道：title / bell / exit', author: 'you', time: '昨天 18:02', lane: 0, lanes: [0], files: ['packages/app/src/threads/events.ts'], body: '' },
  { sha: '17aa94d', msg: 'TerminalPool：切走 retain，后台 PTY 照跑', author: 'you', time: '2 天前', lane: 0, lanes: [0], files: ['crates/jagent-terminal/src/pool.rs'], body: '' },
  { sha: '92cd1f6', msg: 'init: GPUIX × Zed terminal 骨架', author: 'you', time: '3 天前', lane: 0, lanes: [0], files: ['Cargo.toml', 'packages/app/src/main.tsx'], body: '' },
]

/* ═══ 工作面板 diff / 预览数据 ═══ */
export const DIFFS: Record<string, string> = {
  'packages/app/src/plane/Sidebar.tsx': `@@ -44,6 +44,18 @@ export function Sidebar({\n   const drag = useTitleBarDrag(windowControls)\n   return (\n-    <div testId="sidebar">\n+    <div testId="sidebar" style={{ width }}>\n       <SidebarHeader />\n       <WorkspaceList />\n+      {/* 脚：设置 + 通知铃 + 版本号 */}\n       <SidebarFooter />`,
  'packages/app/src/plane/WorkspaceList.tsx': `@@ -120,9 +120,12 @@\n   const menuItems = (m: MenuState) => {\n-    return [{ id: 'remove', label: '移除' }]\n+    return [\n+      { id: 'pin', label: t.pin ? '取消置顶' : '置顶' },\n+      { id: 'rename', label: '重命名…' },\n+      { id: 'unread', label: t.unread ? '标记为已读' : '标记为未读' },\n+      'sep',\n+      { id: 'remove', label: '移除', danger: true },\n+    ]`,
}

export const PREVIEWS: Record<string, string> = {
  'packages/app/src/tokens.ts': `export const GRAPH_LANE_COLORS = [\n  '#61afef', // 蓝\n  '#98c379', // 绿\n  '#c678dd', // 紫\n  '#e5c07b', // 琥珀\n  '#56b6c2', // 青\n  '#e06c75', // 红\n] as const\n\nexport const SIZES = {\n  sidebarWidth: 264,\n  rowHeight: 28,\n  rowMarginX: 8,\n  rowPaddingX: 8,\n  rowRadius: 6,\n  panelWidth: 280,\n  panelOverlayWidth: 1100,\n  titleBarHeight: 34,\n  toolbarHeight: 46,\n  sidebarHeadHeight: 52,\n} as const`,
  'packages/app/src/plane/Sidebar.tsx': `export function Sidebar({ store, settings, dialog }) {\n  const width = useSettingsValue(settings, s => s.appearance.sidebarWidth)\n  const unread = useThreadStore(store, s => s.notices.length - s.noticesRead)\n  return (\n    <div testId="sidebar" style={{ width, backgroundColor: COLORS.sidebar }}>\n      <SidebarHeader onCollapse={onCollapse} />\n      <WorkspaceList store={store} dialog={dialog} />\n      <SidebarFooter unread={unread} />\n    </div>\n  )\n}`,
}
