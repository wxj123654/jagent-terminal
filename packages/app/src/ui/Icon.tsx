/**
 * ui/Icon.tsx — SVG 图标原子（architecture.md §7；布局契约 §4「禁止 emoji」）。
 *
 * GPUIX 的 `<svg>` 是叶子元素：整体源码经 `source` prop 交给 gpui 解析，
 * tint 取 style.color。图标集：chat 圆环点 / terminal 竖条 / acp 折线 /
 * gear / close / minimize / maximize / plus / chevronDown。24×24 viewBox，stroke 风格（lucide 同系）。
 */

import type { ReactElement } from 'react'

const strokeSvg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

const SOURCES = {
  /** chat：圆环点 */
  chat: strokeSvg(
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>',
  ),
  /** terminal：竖条 ▌ */
  terminal: strokeSvg(
    '<rect x="9" y="5" width="4.5" height="14" rx="1" fill="currentColor" stroke="none"/>',
  ),
  /** acp：折线标记 */
  acp: strokeSvg(
    '<polyline points="4 17 9.5 10.5 13.5 14 20 6"/><polyline points="15 6 20 6 20 11"/>',
  ),
  /** gear：设置入口（SidebarFooter） */
  gear: strokeSvg(
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  ),
  /** close：行关闭 / Linux CSD 关闭 */
  close: strokeSvg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  /** minimize：Linux CSD 最小化 */
  minimize: strokeSvg('<path d="M5 12h14"/>'),
  /** maximize：Linux CSD 最大化（空心方框） */
  maximize: strokeSvg('<rect x="5" y="5" width="14" height="14" rx="1"/>'),
  /** plus：新建 */
  plus: strokeSvg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  /** chevronDown：预设菜单展开 / select 下拉 */
  chevronDown: strokeSvg('<path d="m6 9 6 6 6-6"/>'),
  /** chevronUp：number stepper 步进钮 */
  chevronUp: strokeSvg('<path d="m18 15-6-6-6 6"/>'),
  /** reset：恢复默认（rotate-ccw ↺，settings-ui §5.1） */
  reset: strokeSvg(
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  ),
  /** search：设置搜索框 */
  search: strokeSvg(
    '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  ),
  /** copy：预设复制为自定义副本（settings-ui §7） */
  copy: strokeSvg(
    '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  ),
  /** trash：删除自定义预设 */
  trash: strokeSvg(
    '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  ),
  /** chevronRight：预设行展开指示（原型 .chev） */
  chevronRight: strokeSvg('<path d="m9 18 6-6-6-6"/>'),
  /** folder：工作区 / git 文件树目录 */
  folder: strokeSvg(
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  ),
  /** file：git 文件树叶子 */
  file: strokeSvg(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  ),
  /** menu：窄窗口抽屉 toggle（W4 汉堡钮） */
  menu: strokeSvg(
    '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  ),
  /** bell：会话通知（Phase W 对齐原型 workspace-plane bell 图标） */
  bell: strokeSvg(
    '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
  ),
  /** more：行内「…」管理菜单（Phase W 对齐原型 session-more） */
  more: strokeSvg(
    '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
  ),
  /** gitBranch：顶栏 Git 图入口 / ref 徽章 */
  gitBranch: strokeSvg(
    '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M6 8.5v7"/><path d="M8.5 6h5.5a3 3 0 0 1 3 3v6"/>',
  ),
  /** tag：git tag 徽章 */
  tag: strokeSvg(
    '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.5"/>',
  ),
  /** download：fetch 远端 */
  download: strokeSvg(
    '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>',
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
  return (
    <svg
      source={SOURCES[name]}
      style={{ width: size, height: size, color, flexShrink: 0 }}
    />
  )
}
