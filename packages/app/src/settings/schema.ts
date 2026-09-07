/**
 * settings/schema.ts — 设置项唯一清单（architecture.md §6.1 + settings-ui.md §6）。
 *
 * 纪律：新增设置先改这里（= 先上契约表），再出现于 UI。
 * 底座 zod v4：类型从 schema 推导（z.infer 一套维护）；叶子 .catch(default)
 * 让坏值/越界/缺失自动回默认；section 级 .prefault({}) 让整节缺失时叶子各自
 * 回默认（而不是顶层炸）；顶层 looseObject 保留未知 key（往返保真）。
 *
 * label/desc/控件映射与 options 全部对齐 design/settings-ui.html 原型。
 */

import { z } from 'zod'

import { BUILTIN_PRESETS } from '../threads/presets'

/** 终端必须默认到平台自带的等宽字体；不可用字体会让 GPUI 回退到比例 UI 字体。 */
export const DEFAULT_TERMINAL_FONT =
  process.platform === 'darwin' ? 'Menlo' : process.platform === 'win32' ? 'Consolas' : 'monospace'

/**
 * 旧版把未随应用分发的 JetBrains Mono 写成默认值。已落盘用户并没有主动
 * 选择它，却会永久覆盖新默认；在 schema 边界迁移成平台字体。未知字段保持。
 */
export function migrateLegacySettings(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input
  const root = input as Record<string, unknown>
  const terminal = root.terminal
  if (typeof terminal !== 'object' || terminal === null || Array.isArray(terminal)) return input
  const terminalObject = terminal as Record<string, unknown>
  if (terminalObject.fontFamily !== 'JetBrains Mono') return input
  return {
    ...root,
    terminal: { ...terminalObject, fontFamily: DEFAULT_TERMINAL_FONT },
  }
}

// ── 子 schema ────────────────────────────────────────────────────────

const TerminalPresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  builtin: z.boolean(),
  /** 留空 = 系统默认 shell */
  program: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** 作为普通键入打进 shell，不是 exec */
  initCommand: z.string().optional(),
  /** 可选；默认项目根目录 */
  cwd: z.string().optional(),
})

/** ACP 默认 2 示例（原型定稿：codex --acp / claude-code-acp） */
export type AcpAgent = { id: string; label: string; command: string; args: string[] }
export const DEFAULT_ACP_AGENTS: AcpAgent[] = [
  { id: 'acp-codex', label: 'Codex (ACP)', command: 'codex', args: ['--acp'] },
  { id: 'acp-claude', label: 'Claude (ACP)', command: 'claude-code-acp', args: [] },
]

/**
 * section 包裹器：整节缺失时以 `{}` 进入 parse——叶子各自 .catch 回默认
 * （与 parse({}) 同路径，默认值单点定义在叶子，不重复写 section 常量）。
 * 类型断言绕开 prefault 对完整 output 的要求；运行时值就是 {}。
 */
function section<T extends z.ZodObject<any>>(s: T) {
  return s.prefault({} as unknown as z.input<T>)
}

/**
 * 原始 schema（顶层无兜底）——parse({}) 产出全默认 DEFAULTS 的来源。
 * SettingsSchema = Raw.catch(DEFAULTS)：顶层坏到无法逐字段救（如整节类型错）
 * 时整体回默认，UI 永不炸。
 */
export const RawSettingsSchema = z.looseObject({
  presets: section(
    z.object({
      /** "+" 按钮默认预设；null = 跟随 lastUsedPreset */
      plusDefault: z.string().nullable().catch(null),
      items: z.array(TerminalPresetSchema).catch(BUILTIN_PRESETS),
    }),
  ),
  notifications: section(
    z.object({
      desktop: z.boolean().catch(true),
      sound: z.boolean().catch(false),
    }),
  ),
  terminal: section(
    z.object({
      fontFamily: z.string().catch(DEFAULT_TERMINAL_FONT),
      fontSize: z.number().int().min(10).max(22).catch(13),
      cursorBlink: z.boolean().catch(true),
      scrollbackLines: z.number().int().min(1000).max(100000).catch(10000),
      palette: z.string().catch('one-dark'),
      closeOnExit: z.boolean().catch(false),
    }),
  ),
  appearance: section(
    z.object({
      theme: z.string().catch('one-dark'),
      sidebarWidth: z.number().int().min(200).max(400).catch(248),
    }),
  ),
  acpAgents: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        command: z.string(),
        args: z.array(z.string()).catch([]),
      }),
    )
    .catch(DEFAULT_ACP_AGENTS),
  keybindings: section(
    z.object({
      /** 键位串语法同 GPUIX keystroke：'ctrl-tab' / 'ctrl-,' / '/'（modifier '-' 连接，
       *  单字符 '-' 键不可表达——已知限制）。语义约束在编辑面校验（见
       *  KeybindingsSection）：cycleNext/cyclePrev/toggleSettings 必须含 ctrl（全局修饰键层，
       *  硬约束 2 不吃裸键）；focusSearch 必须无修饰（设置面裸键层） */
      cycleNext: z.string().catch('ctrl-tab'),
      cyclePrev: z.string().catch('ctrl-shift-tab'),
      toggleSettings: z.string().catch('ctrl-,'),
      focusSearch: z.string().catch('/'),
      /** W4：聚焦工作区侧栏搜索框。默认平台化（mac ⌘K 不写 PTY 零冲突；
       *  win ctrl-k 属修饰组合层）。mac/win 同 schema——键位串自带 cmd- 前缀 */
      searchThreads: z.string().catch(process.platform === 'darwin' ? 'cmd-k' : 'ctrl-k'),
    }),
  ),
  advanced: section(
    z.object({
      gpuBackend: z.enum(['auto', 'metal', 'dx12', 'vulkan']).catch('auto'),
      /** 性能 HUD：开启后标题栏右侧显示整 app 帧率/整帧耗时/终端 paint/CPU/内存
       * （GPUIX 内建 profiler 整帧直方图 + 终端 paint 打点两层；500ms 轮询） */
      perfHud: z.boolean().catch(false),
      /** 屏幕帧覆盖层：GPUIX 内建调试 overlay（整帧 p90/p99/max 可视化，
       * full 模式画在场景之上）；与 HUD 的数字同源（getDebugFrameOverlayStats） */
      frameOverlay: z.boolean().catch(false),
    }),
  ),
})

export type Settings = z.infer<typeof RawSettingsSchema>

/** 全默认快照（叶子 catch + section prefault 使 parse({}) 即全默认） */
export const DEFAULTS: Settings = RawSettingsSchema.parse({})

/** 对外 parse 面：顶层兜底，坏到救不回时整体回默认 */
export const SettingsSchema = RawSettingsSchema.catch(DEFAULTS)

// ── SettingsPath：递归 dot-path（数组值整体视为叶子，不递归元素）──────

type PathOf<T, P extends string = ''> = T extends readonly unknown[]
  ? P
  : T extends object
    ? {
        [K in keyof T]-?: PathOf<T[K], P extends '' ? K & string : `${P}.${K & string}`>
      }[keyof T]
    : P

export type SettingsPath = PathOf<Settings>

// ── SETTING_DEFS / SECTIONS（settings-ui.md §6 分表 + 原型文案）──────

export type SettingControl =
  | { type: 'toggle' }
  | { type: 'select'; options: { value: string; label: string }[] }
  | { type: 'number'; min: number; max: number; step?: number }
  | { type: 'range'; min: number; max: number; step?: number }
  | { type: 'text'; mono?: boolean }
  | { type: 'textarea'; rows?: number }

export type SettingSectionId =
  | 'presets'
  | 'notifications'
  | 'terminal'
  | 'appearance'
  | 'keybindings'
  | 'acp'
  | 'advanced'

export type SettingDef = {
  /** 'terminal.fontSize' */
  path: SettingsPath
  section: SettingSectionId
  label: string
  description?: string
  control: SettingControl
  /** 第一期不可用项 → disabled + Phase 徽章（settings-ui.md §5.3） */
  phase?: 2 | 3
}

export const SECTIONS: { id: SettingSectionId; label: string }[] = [
  { id: 'presets', label: 'Presets · 预设' },
  { id: 'notifications', label: 'Notifications · 通知' },
  { id: 'terminal', label: 'Terminal · 终端' },
  { id: 'appearance', label: 'Appearance · 外观' },
  { id: 'keybindings', label: 'Keybindings · 键位' },
  { id: 'acp', label: 'ACP Agents · 外部 agent' },
  { id: 'advanced', label: 'Advanced · 高级' },
]

/**
 * 标量设置声明表（分区导航 groupBy section、搜索过滤、SettingRow 声明式
 * 渲染的数据源）。Presets 列表 / ACP Agents 为结构性数据（列表 CRUD），
 * 不走此表（§6.1）；Keybindings 第一期只读表。plusDefault 随 Presets 分区
 * 手写（选项动态来自 presets.items）。
 */
export const SETTING_DEFS: SettingDef[] = [
  // Notifications
  {
    path: 'notifications.desktop',
    section: 'notifications',
    label: '桌面通知',
    description: 'BEL 且未聚焦时弹出系统通知；聚焦该 thread 即清除',
    control: { type: 'toggle' },
  },
  {
    path: 'notifications.sound',
    section: 'notifications',
    label: '通知声音',
    description: '通知附带提示音（依赖桌面通知开启）',
    control: { type: 'toggle' },
  },
  // Terminal
  {
    path: 'terminal.fontFamily',
    section: 'terminal',
    label: '字体',
    description: '终端专用 mono 字体，不继承 UI 字体',
    control: { type: 'text', mono: true },
  },
  {
    path: 'terminal.fontSize',
    section: 'terminal',
    label: '字号',
    description: '行高与 cell 尺寸由 TerminalView 自管',
    control: { type: 'number', min: 10, max: 22, step: 1 },
  },
  {
    path: 'terminal.cursorBlink',
    section: 'terminal',
    label: '光标闪烁',
    description: '系统 reduced-motion 开启时自动关闭',
    control: { type: 'toggle' },
  },
  {
    path: 'terminal.scrollbackLines',
    section: 'terminal',
    label: '回滚行数',
    description: 'scrollback 缓冲区大小',
    control: { type: 'number', min: 1000, max: 100000, step: 500 },
  },
  {
    path: 'terminal.palette',
    section: 'terminal',
    label: '调色板',
    description: '终端背景与 16 色独立于父容器',
    control: { type: 'select', options: [{ value: 'one-dark', label: 'One Dark' }] },
  },
  {
    path: 'terminal.closeOnExit',
    section: 'terminal',
    label: '退出后直接关闭',
    description: '进程 exit 后：开=直接销毁该行；关=保留 exited 灰行查看残留（默认保留）',
    control: { type: 'toggle' },
  },
  // Appearance
  {
    path: 'appearance.theme',
    section: 'appearance',
    label: '主题',
    description: '第一期仅 One Dark',
    control: {
      type: 'select',
      options: [
        { value: 'one-dark', label: 'One Dark（默认）' },
        { value: 'one-dark-pro', label: 'One Dark Pro · Phase 2' },
        { value: 'light', label: 'Light · Phase 2' },
      ],
    },
  },
  {
    path: 'appearance.sidebarWidth',
    section: 'appearance',
    label: '侧栏宽度',
    description: 'thread 列表宽度，拖拽时实时写回',
    control: { type: 'range', min: 200, max: 400, step: 2 },
  },
  // Advanced
  {
    path: 'advanced.gpuBackend',
    section: 'advanced',
    label: 'GPU 后端',
    description: 'GPUIX（pinned GPUI fork）渲染后端',
    control: {
      type: 'select',
      options: [
        { value: 'auto', label: 'Auto（推荐）' },
        { value: 'dx12', label: 'DirectX 12' },
        { value: 'vulkan', label: 'Vulkan' },
        { value: 'metal', label: 'Metal' },
      ],
    },
  },
  {
    path: 'advanced.perfHud',
    section: 'advanced',
    label: '性能指标 HUD',
    description:
      '在标题栏右上角显示整 app 帧率、整帧耗时（p90/max）、终端 paint 与 CPU/内存（500ms 刷新；整帧行来自 GPUIX profiler，term 行来自终端渲染管线）',
    control: { type: 'toggle' },
  },
  {
    path: 'advanced.frameOverlay',
    section: 'advanced',
    label: '屏幕帧覆盖层',
    description: 'GPUIX 内建调试 overlay：把整帧耗时直方图直接画在画面上（与 HUD 数字同源）',
    control: { type: 'toggle' },
  },
]
