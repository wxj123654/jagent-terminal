/**
 * ui/theme/tokens.ts — 配色与字号 token（architecture.md §7）。
 * 单一事实源：本文件消费 0 次，产出 token；所有 Surface 经 ui 控件引用，不散字面量。
 * 单色亮/暗扩展位：DESIGN_THEME 未接入——本期只定义暗色一套。
 *
 * Zed One Dark 语义色（2026-09-12 决策：V2 灰阶回滚，见 TODOLIST）。
 * V2 期新增的 token 键（tile/overlay/faint/focusBorder 等）保留，
 * 色值映射到 One Dark 抬升阶：inputBg < pane < sidebar < app < surface < surfaceHover。
 */

export const COLORS = {
  /** 应用底（窗口根色） */
  app: '#282c34',
  /** 主内容面（工具栏 / pane） */
  pane: '#1e2127',
  /** 侧栏列底色 */
  sidebar: '#21252b',
  /** 自绘顶栏底。与 sidebar 同色，整条顶栏行（含左段）连成一体 */
  titlebar: '#21252b',
  /** 终端/凹陷面 */
  terminal: '#1a1d23',
  /** 抬升表面：hover 面 / 按钮底（One Dark selection） */
  surface: '#2c313a',
  /** 强 hover / 菜单项高亮（按钮加深） */
  surfaceHover: '#333845',
  /** 选中行 / active 面（原 surface 语义拆分——surface 留给 hover 面） */
  surfaceActive: '#2c313a',
  /** tile 底（chip/胶囊钮/当前工作区底；One Dark 并入抬升阶） */
  tile: '#2c313a',
  /** tile hover */
  tileHover: '#333845',
  /** 浮起面（弹窗卡/菜单/通知浮层；比 pane 抬两档） */
  overlay: '#282c34',
  /** 输入凹陷底 */
  inputBg: '#1b1d23',
  /** close × 悬停底 */
  closeHover: '#3a3f4b',
  /** 常规文字（One Dark fg） */
  text: '#abb2bf',
  /** 强文字 */
  textBright: '#d7dae0',
  /** 弱文字（One Dark comment） */
  muted: '#5c6370',
  /** 最弱文字（cwd/版本号/占位/hint；比 muted 亮一档补偿小字号可读性） */
  faint: '#7f848e',
  /** accent（One Dark 蓝；主按钮底/选中标记） */
  accent: '#61afef',
  /** accent 按钮 hover（提亮一档） */
  accentHover: '#82c1f2',
  /** accent 低透明度底（toggle 开启轨道 / focus 环） */
  accentSoft: 'rgba(97, 175, 239, 0.15)',
  /** 表单控件 focus 边框（One Dark 用 accent 实色） */
  focusBorder: '#61afef',
  /** 信息/辅助语义色（git lane、时间等；不用作交互 accent） */
  cyan: '#56b6c2',
  /** 警示/进行中语义色（One Dark 琥珀） */
  amber: '#e5c07b',
  terminalKind: '#98c379',
  acpKind: '#c678dd',
  /** 错误/危险语义（One Dark 红；借历史命名 bell——错误指示灯底色） */
  bell: '#e06c75',
  /** 弱描边（分区线/表格线） */
  border: '#181a1f',
  /** 强描边（输入框/弹窗描边） */
  borderSubtle: '#3e4451',
  /** 已退出态弱化文字（兼作 disabled） */
  exited: '#4b5262',
  /** 空闲选中环（One Dark muted） */
  g300: '#5c6370',
  /** 状态灯四态（One Dark 调和：进行中琥珀 / 待确认紫 / 完成绿 / 错误红） */
  statusRunning: '#e5c07b',
  statusNeed: '#c678dd',
  statusDone: '#98c379',
  statusError: '#e06c75',
} as const

export const FONT = {
  ui: 'IBM Plex Sans, Segoe UI, system-ui, -apple-system, Helvetica Neue, sans-serif',
  mono: 'JetBrains Mono, Cascadia Code, Menlo, Consolas, monospace',
} as const
