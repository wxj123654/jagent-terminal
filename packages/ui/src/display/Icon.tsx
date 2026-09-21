/**
 * ui/Icon.tsx — SVG 图标原子（architecture.md §7；布局契约 §4「禁止 emoji」）。
 *
 * GPUIX 的 `<svg>` 是叶子元素：整体源码经 `source` prop 交给 gpui 解析，
 * tint 取 style.color。
 *
 * 名集 = 原型 design/prototype-react/src/icons.tsx 的 MAP 键；字形 = 原型实际
 * 渲染的 lucide-react@1.46.0 节点逐字对齐（R10 对账：此前为早期 lucide 同系
 * 手写近似，terminal ▌/gitBranch 拓扑/agent 机器人等与原形同位不同形）。
 * 原型 MAP 中 arrowLeft 无任何消费点（死映射），不收；minimize/maximize
 * 原型同死映射但实现侧 Linux CSD 在用，保留。
 */

import type { ReactElement } from 'react'

const strokeSvg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

const SOURCES = {
  /** chat：会话（lucide circle-dot） */
  chat: strokeSvg('<circle cx="12" cy="12" r="1"/><circle cx="12" cy="12" r="10"/>'),
  /** terminal：终端会话（lucide terminal `>_`） */
  terminal: strokeSvg('<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>'),
  /** acp：ACP 会话（lucide trending-up） */
  acp: strokeSvg('<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>'),
  /** gear：设置入口（lucide settings） */
  gear: strokeSvg(
    '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 0-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
  ),
  /** close：行关闭 / Linux CSD 关闭（lucide x） */
  close: strokeSvg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  /** minimize：Linux CSD 最小化（lucide minus；原型 MAP 死映射，实现侧在用） */
  minimize: strokeSvg('<path d="M5 12h14"/>'),
  /** maximize：Linux CSD 最大化（lucide square；原型 MAP 死映射，实现侧在用） */
  maximize: strokeSvg('<rect width="18" height="18" x="3" y="3" rx="2"/>'),
  /** plus：新建（lucide plus） */
  plus: strokeSvg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  /** chevronDown：预设菜单展开 / select 下拉（lucide chevron-down） */
  chevronDown: strokeSvg('<path d="m6 9 6 6 6-6"/>'),
  /** chevronUp：number stepper 步进钮（lucide chevron-up） */
  chevronUp: strokeSvg('<path d="m18 15-6-6-6 6"/>'),
  /** chevronRight：预设行展开指示（lucide chevron-right） */
  chevronRight: strokeSvg('<path d="m9 18 6-6-6-6"/>'),
  /** reset：恢复默认（lucide rotate-ccw ↺，settings-ui §5.1） */
  reset: strokeSvg(
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  ),
  /** search：设置搜索框（lucide search） */
  search: strokeSvg('<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>'),
  /** copy：预设复制为自定义副本（lucide copy，settings-ui §7） */
  copy: strokeSvg(
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  ),
  /** trash：删除自定义预设（lucide trash-2） */
  trash: strokeSvg(
    '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  ),
  /** folder：工作区 / git 文件树目录（lucide folder） */
  folder: strokeSvg(
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  ),
  /** file：git 文件树叶子 / 会话文件视图（lucide file） */
  file: strokeSvg(
    '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>',
  ),
  /** menu：窄窗口抽屉 toggle（W4 汉堡钮；lucide menu） */
  menu: strokeSvg('<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>'),
  /** bell：会话通知（lucide bell） */
  bell: strokeSvg(
    '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  ),
  /** more：行内「…」管理菜单（lucide ellipsis；r1 描边圆在 sw2 下呈实点） */
  more: strokeSvg(
    '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  ),
  /** gitBranch：顶栏 Git 图入口 / ref 徽章（lucide git-branch） */
  gitBranch: strokeSvg(
    '<path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>',
  ),
  /** tag：git tag 徽章 / 设置分区图标（lucide tag） */
  tag: strokeSvg(
    '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  ),
  /** download：fetch 远端（lucide download） */
  download: strokeSvg(
    '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  ),
  /** panelLeft：收起/展开侧栏（lucide panel-left） */
  panelLeft: strokeSvg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>'),
  /** panelRight：工作面板开关（lucide panel-right） */
  panelRight: strokeSvg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>'),
  /** check：通知「全部已读」/ select 选中勾（lucide check） */
  check: strokeSvg('<path d="M20 6 9 17l-5-5"/>'),
  /** edit：重命名/外观分区图标（lucide pencil） */
  edit: strokeSvg(
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  ),
  /** agent：AI 工具/会话（lucide bot） */
  agent: strokeSvg(
    '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  ),
  /** pin：会话/工作区置顶（lucide pin） */
  pin: strokeSvg(
    '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  ),
  /** home：起始页 ContextTab（lucide house） */
  home: strokeSvg(
    '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  ),
  /** inbox：未归属会话虚拟组（lucide inbox） */
  inbox: strokeSvg(
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  ),
  /** arrowRight：空态 pill 尾标 / composer 发送钮（lucide arrow-right） */
  arrowRight: strokeSvg('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  /** alert：顶栏错误入口（lucide triangle-alert） */
  alert: strokeSvg(
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  ),
} as const

export type IconName = keyof typeof SOURCES

export function Icon({
  name,
  size = 14,
  color,
}: {
  name: IconName
  size?: number
  color?: string
}): ReactElement {
  return <svg source={SOURCES[name]} style={{ width: size, height: size, color, flexShrink: 0 }} />
}
