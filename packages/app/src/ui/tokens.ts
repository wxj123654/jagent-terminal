/**
 * ui/tokens.ts — 颜色 / 尺寸 tokens（agent-plane-layout.md §3，TS 常量形态）。
 *
 * Zed One Dark 语义色 + 布局尺寸。Phase 1 定稿（architecture.md §5）；
 * Phase 2 的 settings appearance 分区若引入主题，再考虑升级为 store 注入。
 * 位置：ui/ 原子层（architecture §1.2「ui 被所有人依赖，不依赖任何人」）。
 */

export const COLORS = {
  app: '#282c34',
  pane: '#1e2127',
  sidebar: '#21252b',
  /** 自绘顶栏底（与 sidebar 同色：整条顶栏与左栏连成一体，Zed 同款） */
  titlebar: '#21252b',
  terminal: '#1a1d23',
  /** 抬升表面：active 行底 / 按钮底 / 通用 hover（One Dark selection） */
  surface: '#2c313a',
  /** 抬升表面的 hover（按钮加深） */
  surfaceHover: '#333845',
  /** 凹陷表面：rename 输入框 / 菜单底 */
  inputBg: '#1b1d23',
  /** 行内关闭钮 hover */
  closeHover: '#3a3f4b',
  text: '#abb2bf',
  textBright: '#d7dae0',
  muted: '#5c6370',
  accent: '#61afef',
  /** accent 低透明度底（toggle 开启轨道 / 焦点环，原型 --accent-soft） */
  accentSoft: 'rgba(97, 175, 239, 0.15)',
  /** 自定义徽章青（原型 --cyan） */
  cyan: '#56b6c2',
  terminalKind: '#98c379',
  acpKind: '#c678dd',
  bell: '#e06c75',
  border: '#181a1f',
  borderSubtle: '#3e4451',
  /** exited 行：整行压灰（含文字） */
  exited: '#4b5262',
} as const

export const SIZES = {
  sidebarWidth: 248,
  rowHeight: 28,
  rowMarginX: 6,
  rowPaddingX: 8,
  rowRadius: 4,
  activeBarWidth: 2,
  /** 自绘顶栏高度（Zed platform_title_bar_height：非 Windows 为 max(1.75rem, 34px)） */
  titleBarHeight: 34,
} as const

export const FONT = {
  ui: 'IBM Plex Sans, Segoe UI, system-ui, sans-serif',
  mono: 'JetBrains Mono, Cascadia Code, monospace',
} as const
