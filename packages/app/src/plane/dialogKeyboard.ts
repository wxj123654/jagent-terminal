/**
 * plane/dialogKeyboard.ts — 弹窗键盘入口（模块单例，W7；sidebarKeyboard
 * 同款纪律：纯 UI 态不进 store/router）。
 *
 * ⌘K/Ctrl-K（keybindings.searchThreads）从「聚焦侧栏搜索框」改为
 * 「打开搜索会话弹窗」（原型语义）。AgentPlane 把 DialogOpener 注册到
 * 模块态；装配层（main.tsx/e2e）focusThreadSearch → openSearch()。
 * 未注册（如局部测试装配）时 no-op。
 */

let opener: { openSearch: () => void } | null = null

export const dialogKeyboard = {
  /** AgentPlane 挂载时注册（卸载置 null） */
  register(o: { openSearch: () => void } | null): void {
    opener = o
  },
  /** 全局键位层消费面（focusThreadSearch 挂点） */
  openSearch(): void {
    opener?.openSearch()
  },
}
