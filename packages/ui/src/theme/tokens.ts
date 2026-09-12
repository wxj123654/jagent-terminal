/**
 * ui/theme/tokens.ts — 配色与字号 token（architecture.md §7）。
 * 单一事实源：本文件消费 0 次，产出 token；所有 Surface 经 ui 控件引用，不散字面量。
 * 单色亮/暗扩展位：DESIGN_THEME 未接入——本期只定义暗色一套。
 *
 * V2 对齐（desktop-plane-v2.html）：Codex/pi-desktop 单色系——侧栏纯黑、
 * 主区 #181818、终端 #0d0d0d、白 accent、白透明度 tile/hover/active 三档，
 * 醒目面几乎无描边；语义色（git lane / ANSI / 状态灯）保持彩色。
 */

export const COLORS = {
  /** 应用底（侧栏列底色；原型 body #000） */
  app: '#000000',
  /** 主内容面（工具栏 / pane；原型 --g900 #181818） */
  pane: '#181818',
  sidebar: '#000000',
  /** 工具栏底（与 pane 同底；原型 .toolbar 透明叠在 --g900 上） */
  titlebar: '#181818',
  /** 终端/凹陷面（--g1000 #0d0d0d） */
  terminal: '#0d0d0d',
  /** hover 面（--bg-hover 6% 白；行/图标钮悬停底） */
  surface: 'rgba(255,255,255,0.06)',
  /** 强 hover / 菜单项高亮（--bg-active 10% 白） */
  surfaceHover: 'rgba(255,255,255,0.10)',
  /** 选中行 / active 面（--bg-active 10% 白） */
  surfaceActive: 'rgba(255,255,255,0.10)',
  /** tile 底（--bg-tile 3.5% 白：chip/胶囊钮/当前工作区底 4%） */
  tile: 'rgba(255,255,255,0.035)',
  /** tile hover（--bg-tile-hover 6% 白） */
  tileHover: 'rgba(255,255,255,0.06)',
  /** 浮起面（--g800 #212121：弹窗卡/菜单/通知浮层） */
  overlay: '#212121',
  /** 输入凹陷底（--g1000 #0d0d0d） */
  inputBg: '#0d0d0d',
  /** close × 悬停底 */
  closeHover: 'rgba(255,255,255,0.10)',
  /** 常规文字（--text-2 70% 白） */
  text: 'rgba(255,255,255,0.70)',
  /** 强文字（--text-1 纯白） */
  textBright: '#ffffff',
  /** 弱文字（--text-3 52% 白） */
  muted: 'rgba(255,255,255,0.52)',
  /** 最弱文字（--text-4 56% 白：cwd/版本号/占位/hint；比 muted 略亮是
   *  原型事实——text-4 用在更小字号上补偿可读性） */
  faint: 'rgba(255,255,255,0.56)',
  /** accent（V2 白色；主按钮底/选中标记） */
  accent: '#ffffff',
  accentHover: '#ededed',
  /** accent 软化（focus 环；--accent-soft 15% 白） */
  accentSoft: 'rgba(255,255,255,0.15)',
  /** 表单控件 focus 边框（原型 28% 白） */
  focusBorder: 'rgba(255,255,255,0.28)',
  /** 信息/辅助语义色（git lane、时间等；不用作交互 accent） */
  cyan: '#56b6c2',
  /** 警示/进行中语义色 */
  amber: '#ff8549',
  terminalKind: '#98c379',
  acpKind: '#c27aff',
  /** 错误/危险语义（--err #ff6764；借历史命名 bell——错误指示灯底色） */
  bell: '#ff6764',
  /** 弱描边（--line 8% 白：分区线/表格线） */
  border: 'rgba(255,255,255,0.08)',
  /** 强描边（--line-2 14% 白：输入框/弹窗描边） */
  borderSubtle: 'rgba(255,255,255,0.14)',
  /** 已退出态弱化文字（原型 .row.exited = text-4 56% 白；兼作 disabled） */
  exited: 'rgba(255,255,255,0.56)',
  /** 空闲选中环（--g300 #afafaf） */
  g300: '#afafaf',
  /** 状态灯（原型：进行中橙 / 待确认紫 / 完成绿 / 错误红；进行中偏琥珀保持可辨） */
  statusRunning: '#ff8549',
  statusNeed: '#c27aff',
  statusDone: '#40c977',
  statusError: '#ff6764',
} as const

export const FONT = {
  ui: 'IBM Plex Sans, Segoe UI, system-ui, -apple-system, Helvetica Neue, sans-serif',
  mono: 'JetBrains Mono, Cascadia Code, Menlo, Consolas, monospace',
} as const
