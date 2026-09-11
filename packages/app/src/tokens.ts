/**
 * app/src/tokens.ts — app 域布局 tokens（ui-extensions.md §5 分类结果）。
 *
 * 通用视觉 tokens（COLORS/FONT）已迁 `@jagent/ui`（packages/ui）。
 * 这里只留 app 布局面与领域色板，不进组件库：
 * - SIZES：侧栏 / 侧栏行 / 顶栏等布局尺寸（消费方全在 plane/ 布局面）
 * - GRAPH_LANE_COLORS：git graph lane 色板（docs/git-graph.md §3.2，git 域）
 */

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
  sidebarWidth: 264,
  rowHeight: 28,
  rowMarginX: 6,
  rowPaddingX: 8,
  rowRadius: 10,
  activeBarWidth: 2,
  /** 自绘顶栏高度（Zed platform_title_bar_height：非 Windows 为 max(1.75rem, 34px)） */
  titleBarHeight: 34,
  /** 主栏工具栏高（原型 --toolbar-h；Phase D0） */
  toolbarHeight: 46,
  /** 侧栏头高（原型 .sb-head 52px，含红绿灯让位；Phase D0） */
  sidebarHeadHeight: 52,
} as const
