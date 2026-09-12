/**
 * plane/dialogKeyboard.ts — 弹窗键盘入口（模块单例，W7；sidebarKeyboard
 * 同款纪律：纯 UI 态不进 store/router）。
 *
 * ⌘K/Ctrl-K（keybindings.searchThreads）从「聚焦侧栏搜索框」改为
 * 「打开搜索会话弹窗」（原型语义）。⌘N（keybindings.newSession，D7）
 * 打开新建会话弹窗（目标 = 当前工作区，由 AgentPlane 闭包计算）。
 * AgentPlane 把入口注册到模块态；装配层（main.tsx/e2e）
 * focusThreadSearch → openSearch() / newSession → newSession()。
 * 未注册（如局部测试装配）时 no-op。
 */

let opener: { openSearch: () => void; newSession: () => void } | null = null

export const dialogKeyboard = {
  /** AgentPlane 挂载时注册（卸载置 null） */
  register(o: { openSearch: () => void; newSession: () => void } | null): void {
    opener = o
  },
  /** 全局键位层消费面（focusThreadSearch 挂点） */
  openSearch(): void {
    opener?.openSearch()
  },
  /** 全局键位层消费面（newSession ⌘N 挂点） */
  newSession(): void {
    opener?.newSession()
  },
}
