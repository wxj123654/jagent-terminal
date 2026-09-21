/**
 * app/src/tokens.ts — app 域布局 tokens（ui-extensions.md §5 分类结果）。
 *
 * 通用视觉 tokens（COLORS/FONT）已迁 `@jagent/ui`（packages/ui）。
 * 这里只留 app 布局面与领域色板，不进组件库：
 * - SIZES：侧栏 / 侧栏行 / 顶栏等布局尺寸（消费方全在 plane/ 布局面）
 * - GRAPH_LANE_COLORS：git graph lane 色板（docs/git-graph.md §3.2，git 域）
 */

/** git graph lane 色板（docs/git-graph.md §3.2）：8 色轮转，冷色调和 */
export const GRAPH_LANE_COLORS = [
  '#61afef', // 蓝
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
  sidebarWidth: 264,
  /** 侧栏会话行高（原型 .t-row 32px——第二段 CSS 覆盖 30） */
  rowHeight: 32,
  /** 侧栏行左右外距（原型 .sb-scroll padding 8px） */
  rowMarginX: 8,
  rowPaddingX: 8,
  /** 侧栏行圆角（原型 --radius 8px——第二段统一 nav/ws/t-row/ibtn/ghost；
      more-link/empty-hint 保持 5px 不用本键） */
  rowRadius: 8,
  activeBarWidth: 2,
  /** 工作面板宽（原型 --panel-w 默认 280，可拖 244–720） */
  panelWidth: 280,
  panelWidthMin: 244,
  panelWidthMax: 720,
  /** 工作面板覆盖阈值（原型 <1100px 转为浮层） */
  panelOverlayWidth: 1100,
  /** 主栏工具栏高（原型 #titlebar-main 实测 44px——第二段 CSS 覆盖
      --toolbarH:40；两行顶栏的第一行） */
  toolbarHeight: 44,
  /** 顶栏标签行高（原型 #tb-tabs 实测 38px，覆盖 --tabbarH:36；
      SessionTabs / ContextTab 条） */
  tabBarHeight: 38,
  /** 自绘顶栏总高（视觉占地）= main 44 + tabs 38 + 根底边 1px
      （Taffy 定高盒 border 在盒内：main/tabs 各自的 1px 分隔线已在定高内）；
      GitGraphView 列表高度 / 弹层坐标换算用 */
  topChrome: 83,
  /** 侧栏头高（原型 .sb-head 46px——第二段 CSS 覆盖 var(--sbHeadH):52；
      含 mac 红绿灯让位 + 1px 底部分隔线） */
  sidebarHeadHeight: 46,
} as const
