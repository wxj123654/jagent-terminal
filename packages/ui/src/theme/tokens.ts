/**
 * ui/theme/tokens.ts — 配色与字号 token（architecture.md §7）。
 * 单一事实源：本文件消费 0 次，产出 token；所有 Surface 经 ui 控件引用，不散字面量。
 * 单色亮/暗扩展位：DESIGN_THEME 未接入——本期只定义暗色一套。
 *
 * React 原型定稿板（design/prototype-react/src/index.css 第二段 :root，
 * 694 行起；2026-09-18 R2 决策：以原型浏览器实测为准——该段平级覆盖
 * 第一段 One Dark 值且 React 组件真实消费它）。曾用的 One Dark 第一套
 * 已被取代；语义键不变，muted/faint 恢复「faint 更弱」的正序。
 */

export const COLORS = {
  /** 应用底（窗口根色） */
  app: '#242830',
  /** 主内容面（工具栏 / pane） */
  pane: '#1c1f25',
  /** 侧栏列底色 */
  sidebar: '#20242b',
  /** 自绘顶栏底。与 sidebar 同色，整条顶栏行（含左段）连成一体 */
  titlebar: '#20242b',
  /** 终端/凹陷面 */
  terminal: '#1a1d23',
  /** 抬升表面：hover 面 / 按钮底 */
  surface: '#2a3039',
  /** 强 hover / 菜单项高亮 */
  surfaceHover: '#313844',
  /** 选中行 / active 面（比 surface 亮一档：active tab/行在 hover 面之上） */
  surfaceActive: '#303743',
  /** tile 底（分支钮/胶囊钮/当前工作区底） */
  tile: '#292f38',
  /** tile hover */
  tileHover: '#333b47',
  /** 浮起面（弹窗卡/菜单/通知浮层） */
  overlay: '#242a32',
  /** 输入凹陷底 */
  inputBg: '#171a1f',
  /** close × 悬停底 */
  closeHover: '#383f4b',
  /** 常规文字 */
  text: '#b6beca',
  /** 强文字 */
  textBright: '#eef1f5',
  /** 弱文字 */
  muted: '#818b99',
  /** 最弱文字（cwd/版本号/占位/hint） */
  faint: '#626c79',
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
  border: '#14171c',
  /** 强描边（输入框/弹窗描边/tab active 边） */
  borderSubtle: '#363e49',
  /** 已退出态弱化文字（兼作 disabled） */
  exited: '#4b5262',
  /** 空闲选中环 */
  g300: '#5c6370',
  /** 状态灯四态（进行中琥珀 / 待确认紫 / 完成绿 / 错误红） */
  statusRunning: '#e5c07b',
  statusNeed: '#c678dd',
  statusDone: '#98c379',
  statusError: '#e06c75',
  /** tab 条内凹底（原型 #tb-tabs 字面量 #1b1e24——比 titlebar 更深的槽） */
  tabStrip: '#1b1e24',
  /** 键盘 focus 环外圈（原型 --ring；focus-visible 双环 4px 的外圈色） */
  ring: 'rgba(97, 175, 239, 0.38)',
  /** 玻璃卡面（原型 --card；home 卡/设置 st-card 等半透明抬升面） */
  card: 'rgba(42, 48, 57, 0.72)',
  /** 设置左列底色（原型 .st-nav rgba(32,36,43,.55)——sidebar 色半透明叠 pane） */
  settingsNav: 'rgba(32, 36, 43, 0.55)',
} as const

/** gpui font_family 是单名精确查找（direct_write GetMatchingFonts）——
 *  CSS 逗号列表整串查不到会落内嵌 fallback 字体（走查 D1：所有文本
 *  宽度/行高偏差的根因）。这里按平台给「保证存在」的单名：
 *  win = Segoe UI / Consolas（系统自带）；mac = Helvetica Neue / Menlo；
 *  linux = fontconfig 泛名。IBM Plex Sans / JetBrains Mono 不随应用分发，
 *  不作默认（终端字体同理，见 app settings/schema DEFAULT_TERMINAL_FONT）。 */
export const FONT = {
  ui:
    process.platform === 'darwin'
      ? 'Helvetica Neue'
      : process.platform === 'win32'
        ? 'Segoe UI'
        : 'sans-serif',
  mono:
    process.platform === 'darwin'
      ? 'Menlo'
      : process.platform === 'win32'
        ? 'Consolas'
        : 'monospace',
} as const
