/**
 * keybindings.ts — 全局键位层（settings-ui §4/§9；architecture D8）。
 *
 * 键盘事件「焦点元素 + 窗口 root」两跳（T1.6 实测）：终端聚焦时也会到
 * root。分层规则：
 * - 修饰键组合全局吃：Ctrl-Tab / Ctrl-Shift-Tab → cycle；Ctrl-, → toggle
 *   设置；⌘K/Ctrl-K → searchThreads（聚焦工作区侧栏搜索框；W4）。其余
 *   修饰键组合与全部裸键透传（硬约束 2：不吃 vim/claude 按键）。⌘ 是
 *   platform 修饰不写 PTY（memory#5③）——mac ⌘K 劫持零终端冲突；win
 *   ctrl-k 与 ctrl-, 同层（修饰组合层），键位可改。
 * - 设置面生命周期键（Esc / `/`，无修饰键）：仅设置面打开时吃——
 *   terminal 表面时 Esc/`/` 必须透传给 PTY。
 *   - Esc：双跳时序（焦点元素先、root 后，同一按键）——搜索框/键位捕获格
 *     消费 Esc 时同步置「已消费」标记，root 层后到看到标记则不连坐关闭
 *     （React 状态同步提交，useEffect 先于 root handler 跑完，「读旧
 *     query」防御不成立——实测）；query 空且无标记 → 关闭设置。
 *   - `/`：不在输入态时聚焦搜索框（inputFocus 守卫）。
 *
 * T3+.2 键位参数化：四动作键位从 settings.keybindings 读（createGlobalKeydown
 * 的 keys getter 注入；每次 keyDown 查快照——修改即时生效）。语义约束由
 * 编辑面校验保证（cycleNext/cyclePrev/toggleSettings 必含 ctrl、focusSearch 必无修饰），
 * 运行时只按层归属匹配：ctrl 层匹配 cycle/toggle，无修饰层（设置面内）匹配
 * focusSearch。Esc 是平台语义（清空/返回），不参与配置。
 *
 * 从 main.tsx 提取为纯依赖注入形态：e2e 的 createTestRoot 挂点与真窗口
 * 装配共用同一份语义（布线差异注入，nativeDeps 同款纪律）。
 */

import type { ThreadStore } from './threads/store'

export type GlobalKeydown = (key: string, ctrl: boolean, shift: boolean, cmd?: boolean) => void

/** 可编辑键位动作（settings.keybindings 的 TS 镜像；schema 是真值单点）。
 *  searchThreads（W4）：聚焦工作区侧栏搜索框；设置面打开时不劫持
 *  （⌘K 在设置面内语义留给设置搜索）。 */
export type KeybindingAction =
  | 'cycleNext'
  | 'cyclePrev'
  | 'toggleSettings'
  | 'focusSearch'
  | 'searchThreads'
export type Keybindings = Record<KeybindingAction, string>

/**
 * keystroke 串（'ctrl-shift-tab' / 'cmd-k' / '/'）是否命中事件参数。
 * modifier 以 '-' 连接；'cmd' = platform 修饰（mac ⌘ / win Win）；含 alt
 * 的绑定永不命中（事件面只有 ctrl/shift/cmd）。单字符 '-' 键在此语法不
 * 可表达（split 退化）——编辑面拒绝，属已知限制。
 */
export function keystrokeMatches(
  ks: string,
  key: string,
  ctrl: boolean,
  shift: boolean,
  cmd = false,
): boolean {
  const parts = ks.split('-')
  const k = parts[parts.length - 1] ?? ''
  if (k === '' || parts.includes('alt')) return false
  const hasCtrl = parts.includes('ctrl')
  const hasShift = parts.includes('shift')
  const hasCmd = parts.includes('cmd')
  return key === k && ctrl === hasCtrl && shift === hasShift && cmd === hasCmd
}

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
  /** 搜索框/键位捕获格已消费本次 Esc（模块态，一次性） */
  escConsumed: () => boolean
  /** 重置 Esc 消费标记（root 层读取后调） */
  clearEscConsumed: () => void
  /** 聚焦工作区侧栏搜索框（W4 searchThreads；Sidebar ref → 模块态 id） */
  focusThreadSearch: () => void
  /** 键位真值（默认 DEFAULT_KEYBINDINGS；装配层注入 settings 读取——即时生效） */
  keys?: () => Keybindings
}): GlobalKeydown {
  const {
    store,
    inSettings,
    focusSearch,
    focusThreadSearch,
    inputFocused,
    settingsQuery,
    escConsumed,
    clearEscConsumed,
    closeSettings,
    keys,
  } = opts
  const kb = (): Keybindings => keys?.() ?? DEFAULT_KEYBINDINGS
  return (key, ctrl, shift, cmd = false) => {
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
      if (keystrokeMatches(kb().focusSearch, key, ctrl, shift) && !inputFocused()) {
        focusSearch()
        return
      }
    }
    // 工作区搜索（W4）：设置面打开时不劫持（⌘K 留给设置面语义）
    if (!inSettings() && keystrokeMatches(kb().searchThreads, key, ctrl, shift, cmd)) {
      focusThreadSearch()
      return
    }
    // 修饰键组合层（其余透传）
    if (!ctrl) return
    if (keystrokeMatches(kb().cycleNext, key, ctrl, shift)) {
      // 设置打开时 Ctrl-Tab 切走 = 自动离开设置（activeTarget 随
      // activeThreadId 派生，settings-ui §4「切走即关闭」）
      store.cycle(1)
    } else if (keystrokeMatches(kb().cyclePrev, key, ctrl, shift)) {
      store.cycle(-1)
    } else if (keystrokeMatches(kb().toggleSettings, key, ctrl, shift)) {
      if (inSettings()) closeSettings()
      else store.activate({ type: 'settings' })
    }
  }
}

/** 键位默认（与 settings/schema.ts keybindings section 的叶子 catch 同值；
 *  运行时真值从 settings 读，这里只是无注入时的兜底与 UI 展示参照） */
export const DEFAULT_KEYBINDINGS: Keybindings = {
  cycleNext: 'ctrl-tab',
  cyclePrev: 'ctrl-shift-tab',
  toggleSettings: 'ctrl-,',
  focusSearch: '/',
  // mac ⌘K（platform 修饰不写 PTY，劫持零终端冲突）；win ctrl-k
  // （修饰组合层，同 ctrl-,；键位可改）
  searchThreads: process.platform === 'darwin' ? 'cmd-k' : 'ctrl-k',
}
