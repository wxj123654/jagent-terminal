/**
 * plane/dialogKeyboard.ts — 弹窗键盘入口（模块单例，W7；planeKeyboard/
 * settingsKeyboard 同款纪律：纯 UI 态不进 store/router）。
 *
 * ⌘K/Ctrl-K（keybindings.searchThreads）=「打开搜索会话弹窗」（原型语义；
 * 原 W4「聚焦侧栏搜索框」废弃）。⌘N（keybindings.newSession，D7）
 * 打开新建会话弹窗（目标 = 当前工作区，由 AgentPlane 闭包计算）。
 * AgentPlane 把入口注册到模块态；装配层（main.tsx/e2e）
 * openSearch → openSearch() / newSession → newSession()。
 * 未注册（如局部测试装配）时 no-op。
 */

import { createKeyboardSlot } from '../keybindings'

const slot = createKeyboardSlot<{ openSearch: () => void; newSession: () => void }>()

export const dialogKeyboard = {
  /** AgentPlane 挂载时注册（卸载置 null） */
  register: slot.register,
  /** 全局键位层消费面（keybindings.openSearch 挂点） */
  openSearch(): void {
    slot.impl()?.openSearch()
  },
  /** 全局键位层消费面（newSession ⌘N 挂点） */
  newSession(): void {
    slot.impl()?.newSession()
  },
}
