/**
 * dialogs/dialogKeyboard.ts — 弹窗键盘入口（模块单例，W7；planeKeyboard/
 * settingsKeyboard 同款纪律：纯 UI 态不进 store/router）。
 *
 * ⌘K/Ctrl-K（keybindings.searchThreads）=「打开搜索会话弹窗」（原型语义；
 * 原 W4「聚焦侧栏搜索框」废弃）。⌘N（keybindings.newSession，D7）
 * 打开新建会话弹窗（目标 = 当前工作区，由 AgentPlane 闭包计算）。
 * AgentPlane 把入口注册到模块态；装配层（main.tsx/e2e）
 * openSearch → openSearch() / newSession → newSession()。
 * 未注册（如局部测试装配）时 no-op。
 *
 * R11（原型 useGlobalKeys 弹窗层）：`dialog.kind!=='none'` 时全局键位
 * 层整体让位（Radix Dialog 自管语义）——isOpen/close 供 root 层判活与
 * Esc 兜底关闭（焦点不在卡内时；卡内 Esc 由 modal-card 置 keyConsumed
 * 挡在上游，到不了这里）。
 */

import { createKeyboardSlot } from '../keybindings'

const slot = createKeyboardSlot<{
  openSearch: () => void
  newSession: () => void
  /** 弹窗开着（DialogState.kind !== 'none'） */
  isOpen: () => boolean
  /** 关闭弹窗（root 层 Esc 兜底——Radix document 级 Esc 的等价物） */
  close: () => void
}>()

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
  /** 弹窗开着 → root 键位层吞掉全部全局动作（原型 dialog 层 return） */
  isOpen(): boolean {
    return slot.impl()?.isOpen() ?? false
  },
  /** root 层 Esc 兜底关闭（焦点不在卡内时；卡内 Esc 已被消费标记挡） */
  close(): void {
    slot.impl()?.close()
  },
}
