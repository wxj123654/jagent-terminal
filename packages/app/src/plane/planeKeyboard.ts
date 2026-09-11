/**
 * plane/planeKeyboard.ts — 工作台平面键盘入口（模块单例；Phase D2）。
 *
 * 与 sidebarKeyboard/dialogKeyboard/settingsKeyboard 同款纪律：真窗口装配
 * 层（main.tsx）经模块态调进，组件树内 useEffect 注册实现——避免 main
 * ↔ AgentPlane 循环 props。⌘B/Ctrl-B 收起/展开侧栏走这里。
 */

let toggleSidebarFn: (() => void) | null = null

export const planeKeyboard = {
  /** AgentPlane useEffect 注册（卸载置 null） */
  register(fn: (() => void) | null): void {
    toggleSidebarFn = fn
  },
  /** main.tsx 键位层入口（⌘B）；未注册（无窗口）时安全 no-op */
  toggleSidebar(): void {
    toggleSidebarFn?.()
  },
}
