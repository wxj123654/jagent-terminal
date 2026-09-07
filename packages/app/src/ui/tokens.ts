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
  /** 自绘顶栏底。与 sidebar 同色，整条顶栏行（含左段）连成一体。 */
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
  /** accent 按钮 hover（提亮一档；原型 .button.primary:hover #a2cffa 同意图） */
  accentHover: '#82c1f2',
  /** accent 低透明度底（toggle 开启轨道 / 焦点环，原型 --accent-soft） */
  accentSoft: 'rgba(97, 175, 239, 0.15)',
  /** 自定义徽章青（原型 --cyan） */
  cyan: '#56b6c2',
  /** 琥珀（git tag 徽章 / lane 色板同源） */
  amber: '#e5c07b',
  terminalKind: '#98c379',
  acpKind: '#c678dd',
  bell: '#e06c75',
  border: '#181a1f',
  borderSubtle: '#3e4451',
  /** exited 行：整行压灰（含文字） */
  exited: '#4b5262',
} as const

/** git graph lane 色板（docs/git-graph.md §3.2）：8 色轮转，One Dark 调和 */
export const GRAPH_LANE_COLORS = [
  '#61afef', // accent 蓝
  '#98c379', // 绿
  '#c678dd', // 紫
  '#e5c07b', // 琥珀
  '#56b6c2', // 青
  '#e06c75', // 红
  '#d19a66', // 橙
  '#be5046', // 砖红
] as const

export const SIZES = {
  // 默认侧栏宽；运行时以 settings.appearance.sidebarWidth（200–400）为准——
  // 布局面（Sidebar/SidebarHeader/ToolMenu/AgentPlane drawer）经 useSettingsValue 消费
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
