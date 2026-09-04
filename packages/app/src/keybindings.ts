/**
 * keybindings.ts — 全局键位层（settings-ui §4/§9；architecture D8）。
 *
 * 键盘事件「焦点元素 + 窗口 root」两跳（T1.6 实测）：终端聚焦时也会到
 * root。分层规则：
 * - 修饰键组合全局吃：Ctrl-Tab / Ctrl-Shift-Tab → cycle；Ctrl-, → toggle
 *   设置。其余修饰键组合与全部裸键透传（硬约束 2：不吃 vim/claude 按键）。
 * - 设置面生命周期键（Esc / `/`，无修饰键）：仅设置面打开时吃——
 *   terminal 表面时 Esc/`/` 必须透传给 PTY。
 *   - Esc：双跳时序（焦点元素先、root 后，同一按键）——搜索框消费 Esc
 *     （query 非空 → 清空）时同步置「已消费」标记，root 层后到看到标记
 *     则不连坐关闭（React 状态同步提交，useEffect 先于 root handler 跑完，
 *     「读旧 query」防御不成立——实测）；query 空且无标记 → 关闭设置。
 *   - `/`：不在输入态时聚焦搜索框（inputFocus 守卫）。
 *
 * 从 main.tsx 提取为纯依赖注入形态：e2e 的 createTestRoot 挂点与真窗口
 * 装配共用同一份语义（布线差异注入，nativeDeps 同款纪律）。
 */

import type { ThreadStore } from './threads/store'

export type GlobalKeydown = (key: string, ctrl: boolean, shift: boolean) => void

export function createGlobalKeydown(opts: {
  store: Pick<ThreadStore, 'cycle' | 'activate'>
  /** 当前是否在设置面（activeTarget 派生） */
  inSettings: () => boolean
  /** 聚焦设置搜索框（renderer.focusElement(searchInputId)） */
  focusSearch: () => void
  /** 任意文本输入框聚焦中（ui/keyboard 模块态） */
  inputFocused: () => boolean
  /** 设置搜索框当前 query（SettingsView 模块态） */
  settingsQuery: () => string
  /** 关闭设置：回到上一个非设置目标（settings-ui §4；无则 null → '/'） */
  closeSettings: () => void
  /** 搜索框已消费本次 Esc（SettingsView 模块态，一次性） */
  escConsumed: () => boolean
  /** 重置 Esc 消费标记（root 层读取后调） */
  clearEscConsumed: () => void
}): GlobalKeydown {
  const {
    store,
    inSettings,
    focusSearch,
    inputFocused,
    settingsQuery,
    escConsumed,
    clearEscConsumed,
    closeSettings,
  } = opts
  return (key, ctrl, shift) => {
    // 设置面生命周期键（无修饰键；仅设置面打开时吃）
    if (!ctrl && inSettings()) {
      if (key === 'escape') {
        if (escConsumed()) {
          clearEscConsumed()
          return
        }
        if (settingsQuery() === '') closeSettings()
        return
      }
      if (key === '/' && !inputFocused()) {
        focusSearch()
        return
      }
    }
    // 修饰键组合层（其余透传）
    if (!ctrl) return
    if (key === 'tab') {
      // 设置打开时 Ctrl-Tab 切走 = 自动离开设置（activeTarget 随
      // activeThreadId 派生，settings-ui §4「切走即关闭」）
      store.cycle(shift ? -1 : 1)
    } else if (key === ',') {
      if (inSettings()) closeSettings()
      else store.activate({ type: 'settings' })
    }
  }
}
