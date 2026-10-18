import type {
  GitCommit, Settings, Thread, Workspace, Notice, ErrItem, UiState, GitState, WorktreeState,
} from './types'

export const GROUP_LIMIT = 4
export const NARROW_BP = 760
export const PANEL_OVERLAY_W = 1100

const now = Date.now()

export function seedWorkspaces(): Workspace[] {
  return [
    { id: 'ws-jt', name: 'jagent-terminal', path: '~/Documents/jagent-terminal', pin: true, expanded: true, createdAt: now - 9e6, paneTab: 'home' },
    { id: 'ws-df', name: 'dotfiles', path: '~/dotfiles', expanded: true, createdAt: now - 8e6, paneTab: 'home' },
    { id: 'ws-web', name: 'web', path: '~/Projects/web', expanded: true, createdAt: now - 7e6, paneTab: 'home' },
  ]
}

export function seedThreads(): Thread[] {
  return [
    { id: 't-sidebar', kind: 'chat', title: '侧栏重构', workspaceId: 'ws-jt', pin: true, unread: true, createdAt: now - 8e6,
      messages: [
        { id: 'm1', role: 'user', text: '把侧栏换成方案 C：头只留收起钮，新建/搜索下移为 nav 行' },
        { id: 'm2', role: 'assistant', text: '已完成。改动点：\n\n- `Sidebar` 头 40px 只留收起钮，与右侧 40px 融合顶栏同高对齐\n- `WorkspaceList` 顶部采用「＋ 新建会话」与「🔍 ⌘K」并排双胶囊动作栏\n- 工作区分组行：展开 toggle 与点击进入 Bento 启动台分离\n\n```tsx\n<div className="sb-actions-bar">\n  <button className="sb-btn-primary">+ 新建会话</button>\n  <button className="sb-btn-search">⌘K</button>\n</div>\n```\n\n右键与「…」共用同一面 ContextMenu。' },
      ],
      pendingReply: false },
    { id: 't-ime2', kind: 'chat', title: '终端接入 IME', workspaceId: 'ws-jt', createdAt: now - 7e6,
      messages: [
        { id: 'm1', role: 'user', text: 'IME 候选窗跟随光标，GPUI 侧怎么拿光标坐标？' },
        { id: 'm2', role: 'assistant', text: '两条路：\n\n1. alacritty model 的 `cursor.point` → cell 行列 → 乘 cell 尺寸得像素坐标\n2. 经 `ime_position` custom prop 透传给元素\n\n候选窗定位在 view 层做，不进 pool。' },
      ],
      pendingReply: true },
    { id: 't-s6', kind: 'terminal', title: '会话 6', workspaceId: 'ws-jt', createdAt: now - 3.4e6, sessionId: 106, status: 'running', cwd: '~/Documents/jagent-terminal' },
    { id: 't-tb', kind: 'terminal', title: 'titlebar 红绿灯让位', workspaceId: 'ws-jt', createdAt: now - 3.3e6, sessionId: 107, status: 'running', cwd: '~/Documents/jagent-terminal' },
    { id: 't-patch', kind: 'terminal', title: '导出 patch 流程', workspaceId: 'ws-jt', createdAt: now - 3.2e6, sessionId: 108, status: 'running', cwd: '~/Documents/jagent-terminal' },
    { id: 't-ime', kind: 'terminal', title: 'IME 候选窗定位', workspaceId: 'ws-jt', createdAt: now - 3.1e6, sessionId: 109, status: 'running', cwd: '~/Documents/jagent-terminal',
      views: [
        { id: 'git', kind: 'git', label: 'Git 图' },
        { id: 'file:packages/app/src/plane/Sidebar.tsx', kind: 'file', label: 'Sidebar.tsx', path: 'packages/app/src/plane/Sidebar.tsx' },
        { id: 'file:packages/app/src/plane/WorkspaceList.tsx', kind: 'file', label: 'WorkspaceList.tsx', path: 'packages/app/src/plane/WorkspaceList.tsx' },
        { id: 'file:packages/app/src/tokens.ts', kind: 'file', label: 'tokens.ts', path: 'packages/app/src/tokens.ts' },
        { id: 'shell:1', kind: 'shell', label: 'Shell 1', cwd: '~/Documents/jagent-terminal', lines: [{ spans: [{ text: '# ~/Documents/jagent-terminal — 伴随 Shell 会话', cls: 'c-dim' }] }], draft: '' },
      ],
      activeViewId: 'main' },
    { id: 't-old8', kind: 'terminal', title: '旧会话 8', workspaceId: 'ws-jt', createdAt: now - 3e6, sessionId: 105, status: 'exited', cwd: '~/Documents/jagent-terminal' },
    { id: 't-nvim', kind: 'terminal', title: '同步 nvim 配置', workspaceId: 'ws-df', hasBell: true, createdAt: now - 5e5, sessionId: 110, status: 'running', cwd: '~/dotfiles' },
    { id: 't-login', kind: 'terminal', title: '修复登录鉴权回退', hasBell: true, createdAt: now - 4e5, sessionId: 111, status: 'running', cwd: '~/Documents/jagent-terminal' },
    { id: 't-parser', kind: 'chat', title: '重构 parser 状态机', unread: true, createdAt: now - 3e5,
      messages: [{ id: 'm1', role: 'assistant', text: '状态机已拆成 `scan → parse → emit` 三段，错误恢复走 sync 集。' }], pendingReply: false },
    { id: 't-old7', kind: 'terminal', title: '旧会话 7', createdAt: now - 2e5, sessionId: 104, status: 'exited', cwd: '~/Documents/jagent-terminal' },
    { id: 't-old6', kind: 'terminal', title: '旧会话 6', createdAt: now - 1e5, sessionId: 103, status: 'exited', cwd: '~/Documents/jagent-terminal' },
    { id: 't-old5', kind: 'terminal', title: '旧会话 5', createdAt: now - 9e4, sessionId: 102, status: 'exited', cwd: '~/Documents/jagent-terminal' },
    { id: 't-old4', kind: 'terminal', title: '旧会话 4', createdAt: now - 8e4, sessionId: 101, status: 'exited', cwd: '~/Documents/jagent-terminal' },
    { id: 't-acp', kind: 'acp', title: 'Codex (ACP)', createdAt: now - 7e4,
      messages: [{ id: 'm1', role: 'assistant', text: 'ACP session initialized. model: gpt-5-codex' }], pendingReply: false },
  ]
}

export function seedNotices(): Notice[] {
  return [
    { id: 'n1', tone: 'warn', title: '「同步 nvim 配置」等待注意', sub: 'dotfiles · BEL', at: now - 3e5, threadId: 't-nvim', read: false },
    { id: 'n2', tone: 'ok', title: '「侧栏重构」已完成回复', sub: 'jagent-terminal · AI 对话', at: now - 6e5, threadId: 't-sidebar', read: false },
    { id: 'n3', tone: 'err', title: 'PTY 写入失败：会话 5', sub: '未归属 · EPIPE', at: now - 9e5, threadId: 't-old5', read: true },
  ]
}

export function seedErrors(): ErrItem[] {
  return [{ level: 'error', area: 'native', message: 'PTY write failed: EPIPE (session 102)', at: now - 9e5 }]
}

export function seedSettings(): Settings {
  return {
    notifications: { desktop: true, sound: false, agentDone: true, exitError: true },
    terminal: { fontFamily: 'JetBrains Mono', fontSize: 13, cursorBlink: true, scrollbackLines: 10000, palette: 'one-dark', closeOnExit: false },
    appearance: { theme: 'one-dark', sidebarWidth: 264, islandGap: 6, fontScale: '100' },
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
      { id: 'acp-pi', label: 'Pi (ACP)', command: 'pi-acp', args: [] },
      { id: 'acp-codex', label: 'Codex (ACP)', command: 'codex', args: ['--acp'] },
      { id: 'acp-claude', label: 'Claude (ACP)', command: 'claude-code-acp', args: [] },
    ],
    advanced: { gpuBackend: 'auto', perfHud: false, frameOverlay: false, crashGuard: true },
  }
}

export function seedUi(): UiState {
  return {
    sidebarHidden: false, drawerOpen: false,
    panelOpen: false, panelTab: 'changes', panelWidth: 296,
    dialog: { kind: 'none' }, notifOpen: false,
    settingsWindowOpen: false, settingsWinMaximized: false,
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
    status: 'ok', selected: 'packages/app/src/plane/Sidebar.tsx', branch: 'main',
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
  { path: 'notifications.agentDone', section: 'notifications', label: 'Agent 回复完成提醒', desc: 'AI 对话或 ACP 代理在后台完成长耗时工具调用链时写入通知中心', type: 'toggle' },
  { path: 'notifications.exitError', section: 'notifications', label: '进程非零退出码告警', desc: '当后台 PTY 进程以 exit code != 0 异常退出时主动推送错误通知', type: 'toggle' },
  { path: 'terminal.fontFamily', section: 'terminal', label: '字体', desc: '终端专用 mono 字体，不继承 UI 字体', type: 'font' },
  { path: 'terminal.fontSize', section: 'terminal', label: '字号', desc: '行高与 cell 尺寸由 TerminalView 自管', type: 'number', min: 10, max: 22, step: 1 },
  { path: 'terminal.cursorBlink', section: 'terminal', label: '光标闪烁', desc: '系统 reduced-motion 开启时自动关闭', type: 'toggle' },
  { path: 'terminal.scrollbackLines', section: 'terminal', label: '回滚行数', desc: 'scrollback 缓冲区大小', type: 'number', min: 1000, max: 100000, step: 500 },
  { path: 'terminal.palette', section: 'terminal', label: '调色板', desc: '终端背景与 16 色独立于父容器', type: 'select', options: [{ value: 'one-dark', label: 'Obsidian Dark (16-Color ANSI)' }] },
  { path: 'terminal.closeOnExit', section: 'terminal', label: '退出后直接关闭', desc: '进程 exit 后：开=直接销毁该行；关=保留 exited 灰行查看残留（默认保留）', type: 'toggle' },
  { path: 'appearance.theme', section: 'appearance', label: '主题色板', desc: '应用外壳与工作台配色方案（实时同步主窗口）', type: 'select', options: [{ value: 'one-dark', label: 'Obsidian Indigo（默认）' }, { value: 'one-dark-pro', label: 'One Dark Pro' }, { value: 'light', label: 'Daylight Clean' }] },
  { path: 'appearance.sidebarWidth', section: 'appearance', label: '侧栏宽度', desc: '全高工作区导航栏宽度，支持拖拽边缘实时写回', type: 'range', min: 200, max: 400, step: 2 },
  { path: 'appearance.islandGap', section: 'appearance', label: '悬浮画布岛边距', desc: '右侧主工作台圆角画布岛相对窗口底座的呼吸外边距', type: 'range', min: 0, max: 12, step: 2 },
  { path: 'appearance.fontScale', section: 'appearance', label: '界面 UI 密度与缩放', desc: '控制侧栏、顶栏与面板的文字与行高密度（不影响终端字号）', type: 'select', options: [{ value: '95', label: '紧凑 (95%)' }, { value: '100', label: '标准 (100% · 默认)' }, { value: '110', label: '舒适 (110%)' }] },
  { path: 'advanced.gpuBackend', section: 'advanced', label: 'GPU 渲染后端', desc: 'GPUI（pinned fork）底层图形光栅化 API', type: 'select', options: [{ value: 'auto', label: 'Auto（推荐 · Metal / DX12）' }, { value: 'dx12', label: 'DirectX 12' }, { value: 'vulkan', label: 'Vulkan' }, { value: 'metal', label: 'Metal (Apple Silicon)' }] },
  { path: 'advanced.perfHud', section: 'advanced', label: '性能指标 HUD', desc: '在标题栏右上角显示整 app 帧率、整帧耗时（p90/max）、终端 paint 与 CPU/内存（500ms 刷新）', type: 'toggle' },
  { path: 'advanced.frameOverlay', section: 'advanced', label: '屏幕帧耗时直方图', desc: 'GPUI 内建调试 overlay：把整帧耗时分布直接叠加在画面右下角', type: 'toggle' },
  { path: 'advanced.crashGuard', section: 'advanced', label: 'Crash Sidecar 守护进程', desc: '独立进程监听主进程信号与 panic，自动在 ~/.j-agent/crashes 生成 minidump', type: 'toggle' },
]

export const DEFAULTS: Record<string, unknown> = {
  'notifications.desktop': true, 'notifications.sound': false, 'notifications.agentDone': true, 'notifications.exitError': true,
  'terminal.fontFamily': 'JetBrains Mono', 'terminal.fontSize': 13, 'terminal.cursorBlink': true,
  'terminal.scrollbackLines': 10000, 'terminal.palette': 'one-dark', 'terminal.closeOnExit': false,
  'appearance.theme': 'one-dark', 'appearance.sidebarWidth': 264, 'appearance.islandGap': 6, 'appearance.fontScale': '100',
  'advanced.gpuBackend': 'auto', 'advanced.perfHud': false, 'advanced.frameOverlay': false, 'advanced.crashGuard': true,
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
export const LANE_COLORS = ['#6366f1', '#34d399', '#c084fc', '#fbbf24', '#38bdf8', '#f87171', '#f472b6', '#a78bfa']
export const LANE_W = 13
export const PAD_X = 8
export const MIN_LANES = 6
export const GIT_ROW_H = 30

export const GIT_COMMITS: GitCommit[] = [
  { sha: 'a4f2c91', parents: ['b8e1d03'], msg: '侧栏方案 C：nav 行下移，头部只留收起钮', author: 'you', time: '12 分钟前', lane: 0, lanes: [0], refs: [{ k: 'head', t: 'HEAD' }, { k: 'branch', t: 'main' }, { k: 'remote', t: 'origin/main' }], files: ['packages/app/src/plane/Sidebar.tsx', 'packages/app/src/plane/WorkspaceList.tsx', 'packages/app/src/tokens.ts'], fileStats: { 'packages/app/src/plane/Sidebar.tsx': [42, 18], 'packages/app/src/plane/WorkspaceList.tsx': [96, 31], 'packages/app/src/tokens.ts': [6, 2] }, body: '头部图标条撤下，新建/搜索改为并排双胶囊动作栏。\n工作区分组行：展开 toggle 与点击进入 Bento 启动台分离。' },
  { sha: 'b8e1d03', parents: ['c7a9f22'], msg: '工作面板：变更 tab + Master-Detail 上下分栏 diff', author: 'you', time: '1 小时前', lane: 0, lanes: [0], files: ['packages/app/src/plane/WorkPanel.tsx', 'packages/app/src/git/worktree.ts'], fileStats: { 'packages/app/src/plane/WorkPanel.tsx': [84, 29], 'packages/app/src/git/worktree.ts': [31, 8] }, body: '<1100px 转 absolute overlay，不压缩终端。' },
  { sha: 'c7a9f22', parents: ['e91c4a7', 'd3b55e8'], msg: 'merge: feat/sidebar-c → main', author: 'you', time: '2 小时前', lane: 0, lanes: [0, 1], merge: { from: 1, to: 0 }, files: ['packages/app/src/plane/WorkspaceList.tsx'], fileStats: { 'packages/app/src/plane/WorkspaceList.tsx': [12, 4] }, body: '合并侧栏方案 C 分支。' },
  { sha: 'd3b55e8', parents: ['e91c4a7'], msg: '通知中心：铃铛 + 未读红点 + 点击一键跳转会话', author: 'you', time: '3 小时前', lane: 1, lanes: [0, 1], refs: [{ k: 'branch', t: 'feat/sidebar-c' }], files: ['packages/app/src/plane/Sidebar.tsx', 'packages/app/src/threads/store.ts'], fileStats: { 'packages/app/src/plane/Sidebar.tsx': [38, 9], 'packages/app/src/threads/store.ts': [24, 3] }, body: '' },
  { sha: 'e91c4a7', parents: ['f26d890'], msg: '键位参数化：七动作从 settings.keybindings 读', author: 'you', time: '5 小时前', lane: 0, lanes: [0], files: ['packages/app/src/keybindings.ts', 'packages/app/src/settings/schema.ts'], fileStats: { 'packages/app/src/keybindings.ts': [45, 19], 'packages/app/src/settings/schema.ts': [18, 6] }, body: '' },
  { sha: 'f26d890', parents: ['05be3c1'], msg: '终端外观走元素 props：字号/色板/光标闪烁实时生效', author: 'you', time: '昨天 21:40', lane: 0, lanes: [0], refs: [{ k: 'tag', t: 'v0.1' }], files: ['packages/app/src/surfaces/TerminalSurface.tsx'], fileStats: { 'packages/app/src/surfaces/TerminalSurface.tsx': [64, 22] }, body: '' },
  { sha: '05be3c1', parents: ['17aa94d'], msg: '会话事件走全局通道：title / bell / exit', author: 'you', time: '昨天 18:02', lane: 0, lanes: [0], files: ['packages/app/src/threads/events.ts'], fileStats: { 'packages/app/src/threads/events.ts': [52, 11] }, body: '' },
  { sha: '17aa94d', parents: ['92cd1f6'], msg: 'TerminalPool：切走 retain，后台 PTY 照跑', author: 'you', time: '2 天前', lane: 0, lanes: [0], files: ['crates/jagent-terminal/src/pool.rs'], fileStats: { 'crates/jagent-terminal/src/pool.rs': [118, 14] }, body: '' },
  { sha: '92cd1f6', parents: [], msg: 'init: GPUI × Zed terminal 骨架', author: 'you', time: '3 天前', lane: 0, lanes: [0], files: ['Cargo.toml', 'packages/app/src/main.tsx'], fileStats: { 'Cargo.toml': [42, 0], 'packages/app/src/main.tsx': [86, 0] }, body: '' },
]

/* ═══ 工作面板 diff / 预览数据 ═══ */
export const DIFFS: Record<string, string> = {
  'packages/app/src/plane/Sidebar.tsx': `@@ -44,8 +44,22 @@ export function Sidebar({\n   const width = useStore(s => s.settings.appearance.sidebarWidth)\n   const notices = useStore(s => s.notices)\n+  const unread = notices.filter(n => !n.read).length\n   return (\n-    <div testId="sidebar">\n+    <div id="sidebar" style={{ width }}>\n+      {/* 左悬浮导航岛 40px 顶栏（与右悬浮工作台岛 1:1 镜像对齐） */}\n       <SidebarHeader />\n+      <SidebarActionsBar />\n       <WorkspaceList />\n+      {/* 底部通知中心 + 版本状态 + 独立设置窗口入口 */}\n       <SidebarFooter unread={unread} />\n     </div>\n   )`,
  'packages/app/src/plane/WorkspaceList.tsx': `@@ -120,9 +120,16 @@\n   const menuItems = (m: MenuState) => {\n-    return [{ id: 'remove', label: '移除' }]\n+    return [\n+      { id: 'pin', label: t.pin ? '取消置顶' : '置顶' },\n+      { id: 'rename', label: '重命名…' },\n+      { id: 'unread', label: t.unread ? '标记为已读' : '标记为未读' },\n+      'sep',\n+      { id: 'remove', label: '移除', danger: true },\n+    ]\n   }`,
  'packages/app/src/tokens.ts': `@@ -1,6 +1,8 @@\n export const GRAPH_LANE_COLORS = [\n-  '#61afef',\n-  '#98c379',\n+  '#6366f1', // Obsidian Indigo\n+  '#34d399', // Emerald\n+  '#c084fc', // Purple\n+  '#fbbf24', // Amber\n ] as const`,
  'packages/ui/src/display/Icon.tsx': `@@ -12,4 +12,16 @@ export function Icon({ name, size = 14 }: IconProps) {\n   return (\n     <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.65}>\n+      {PATHS[name]}\n     </svg>\n   )\n }`,
}

export const PREVIEWS: Record<string, string> = {
  'packages/app/src/tokens.ts': `export const GRAPH_LANE_COLORS = [\n  '#6366f1', // 靛蓝\n  '#34d399', // 翠绿\n  '#c084fc', // 亮紫\n  '#fbbf24', // 琥珀\n  '#38bdf8', // 天青\n  '#f87171', // 珊瑚红\n] as const\n\nexport const SIZES = {\n  sidebarWidth: 264,\n  islandGap: 6,\n  islandRadius: 10,\n  titleBarHeight: 40,\n  rowHeight: 30,\n  rowRadius: 8,\n  panelWidth: 296,\n  panelOverlayWidth: 1100,\n} as const`,
  'packages/app/src/plane/Sidebar.tsx': `import { useStore } from '@/store'\nimport { Icon } from '@/icons'\n\nexport function Sidebar() {\n  const width = useStore(s => s.settings.appearance.sidebarWidth)\n  const notices = useStore(s => s.notices)\n  const unread = notices.filter(n => !n.read).length\n\n  return (\n    <div id="sidebar" style={{ width }}>\n      <SidebarHeader />\n      <SidebarActionsBar />\n      <WorkspaceList />\n      <SidebarFooter unread={unread} />\n    </div>\n  )\n}`,
  'packages/app/src/plane/WorkspaceList.tsx': `import { useStore } from '@/store'\nimport { sortWorkspaces, sortThreads } from '@/model'\n\nexport function WorkspaceList() {\n  const workspaces = useStore(s => s.workspaces)\n  const threads = useStore(s => s.threads)\n  const route = useStore(s => s.route)\n\n  return (\n    <div className="sb-scroll">\n      {sortWorkspaces(workspaces).map(ws => (\n        <WorkspaceGroup key={ws.id} ws={ws} threads={threads} route={route} />\n      ))}\n    </div>\n  )\n}`,
  'packages/ui/src/display/Icon.tsx': `import type { SVGProps } from 'react'\n\nexport interface IconProps extends SVGProps<SVGSVGElement> {\n  name: string\n  size?: number\n}\n\nexport function Icon({ name, size = 14, ...rest }: IconProps) {\n  return (\n    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.65} {...rest} />\n  )\n}`,
  'design/j-agent-prototype.html': `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8" />\n  <title>j-agent ·的双悬浮圆角岛工作台</title>\n</head>\n<body>\n  <div id="root"></div>\n</body>\n</html>`,
}
