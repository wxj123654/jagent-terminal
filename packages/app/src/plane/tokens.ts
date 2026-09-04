/**
 * plane/tokens.ts — 颜色 / 尺寸 tokens（agent-plane-layout.md §3，TS 常量形态）。
 *
 * Zed One Dark 语义色 + 布局尺寸。Phase 1 定稿（architecture.md §5）；
 * Phase 2 的 settings appearance 分区若引入主题，再考虑升级为 store 注入。
 */

export const COLORS = {
  app: '#282c34',
  pane: '#1e2127',
  sidebar: '#21252b',
  terminal: '#1a1d23',
  text: '#abb2bf',
  textBright: '#d7dae0',
  muted: '#5c6370',
  accent: '#61afef',
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
} as const

export const FONT = {
  ui: 'IBM Plex Sans, Segoe UI, system-ui, sans-serif',
  mono: 'JetBrains Mono, Cascadia Code, monospace',
} as const
