/**
 * tokens.ts — 通用视觉 tokens（ui-extensions.md §5 分类结果）。
 *
 * Zed One Dark 语义色 + 字体。Phase 1 定稿（architecture.md §5）；
 * Phase 2 的 settings appearance 分区若引入主题，再考虑升级为 store 注入。
 *
 * app 域 tokens（布局尺寸 SIZES / git lane 色板 GRAPH_LANE_COLORS）不在这里——
 * 它们留在 packages/app/src/tokens.ts。组件库只收「控件主题」级常量。
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

export const FONT = {
  ui: 'IBM Plex Sans, Segoe UI, system-ui, sans-serif',
  mono: 'JetBrains Mono, Cascadia Code, monospace',
} as const
