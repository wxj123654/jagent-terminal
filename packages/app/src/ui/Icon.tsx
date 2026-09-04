/**
 * ui/Icon.tsx — SVG 图标原子（architecture.md §7；布局契约 §4「禁止 emoji」）。
 *
 * GPUIX 的 `<svg>` 是叶子元素：整体源码经 `source` prop 交给 gpui 解析，
 * tint 取 style.color。图标集：chat 圆环点 / terminal 竖条 / acp 折线 /
 * gear / close / plus / chevronDown。24×24 viewBox，stroke 风格（lucide 同系）。
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
  terminal: strokeSvg('<rect x="9" y="5" width="4.5" height="14" rx="1" fill="currentColor" stroke="none"/>'),
  /** acp：折线标记 */
  acp: strokeSvg('<polyline points="4 17 9.5 10.5 13.5 14 20 6"/><polyline points="15 6 20 6 20 11"/>'),
  /** gear：设置入口（SidebarFooter） */
  gear: strokeSvg(
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  ),
  /** close：行关闭 */
  close: strokeSvg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  /** plus：新建 */
  plus: strokeSvg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  /** chevronDown：预设菜单展开 / select 下拉 */
  chevronDown: strokeSvg('<path d="m6 9 6 6 6-6"/>'),
  /** chevronUp：number stepper 步进钮 */
  chevronUp: strokeSvg('<path d="m18 15-6-6-6 6"/>'),
  /** reset：恢复默认（rotate-ccw ↺，settings-ui §5.1） */
  reset: strokeSvg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>'),
  /** search：设置搜索框 */
  search: strokeSvg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
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
