/**
 * plane/planeKeyboard.ts — 工作台平面键盘入口（模块单例；Phase D2）。
 *
 * 与 dialogKeyboard/settingsKeyboard 同款纪律：真窗口装配层（main.tsx）经
 * 模块态调进，组件树内 useEffect 注册实现——避免 main ↔ AgentPlane 循环
 * props。⌘B/Ctrl-B 收起/展开侧栏、窄窗抽屉 Esc 走这里。
 * 槽生命周期 = keybindings.createKeyboardSlot。
 */

import { createKeyboardSlot } from '../keybindings'

const slot = createKeyboardSlot<{ toggle: () => void; escape: () => boolean }>()

export const planeKeyboard = {
  /** AgentPlane useEffect 注册（卸载置 null） */
  register: slot.register,
  /** main.tsx 键位层入口（⌘B）；未注册（无窗口）时安全 no-op */
  toggleSidebar(): void {
    slot.impl()?.toggle()
  },
  /** Esc（D18）：抽屉开着 → 关闭并返回 true 吃掉；否则 false 放行 */
  escape(): boolean {
    return slot.impl()?.escape() ?? false
  },
}
