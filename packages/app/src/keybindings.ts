/**
 * keybindings.ts — 全局键位层（settings-ui §4/§9；architecture D8）。
 *
 * 键盘事件「焦点元素 → 祖先链 → 窗口 root」逐跳派发（T1.6 实测）：终端
 * 聚焦时也会到 root，且 JS 无 stopPropagation 面——元素消费靠
 * ui/keyboard 的 keyConsumed 标记协调。
 *
 * R11：分层链对齐原型 App.tsx useGlobalKeys（逐层一一对应）：
 * 0. keyConsumed 标记（原型 kbCapturing/组件编辑态层）——键位捕获格
 *    全键、Modal/浮层 Esc、设置搜索框 Esc 清空等元素级消费先置位，
 *    root 层见标记跳过整链。
 * 1. 弹窗层（原型 `dialog.kind!=='none' → return`，Radix 自管）：弹窗
 *    开着时全部全局动作让位；Esc 兜底关闭（Radix document 级 Esc 等价
 *    ——焦点不在卡内时 Modal 吃不到；卡内 Esc 已被 keyConsumed 挡在
 *    上一层，不会双重关闭）。
 * 2. 浮层 Esc（原型 `notifOpen || fontPicker` 层）：Popover 栈顶关闭——
 *    焦点不在浮层内时仍生效（overlayEsc 栈）。
 * 3. 设置面生命周期键（Esc / `/`，无修饰键）：仅设置面打开时吃——
 *    terminal 表面时 Esc/`/` 必须透传给 PTY（硬约束 2）。
 *    - Esc：query 非空 → 清空不退出；query 空 → 关闭设置回上一表面。
 *      搜索框聚焦的清空由输入框自理（keyConsumed 在 L0 已挡）。
 *    - `/`：不在输入态时聚焦搜索框（inputFocus 守卫）。
 * 4. searchThreads（⌘K/Ctrl-K → 搜索会话弹窗，W7 改道——原 W4「聚焦
 *    侧栏搜索框」废弃）/ newSession（⌘N/Ctrl-Shift-N → 新建会话弹窗，
 *    D7）/ toggleSidebar（⌘B/Ctrl-B，D2）：仅设置面外命中；三者都是
 *    修饰键组合，不吃裸键（cycle 系/toggleSettings/newSession 的
 *    必含修饰约束在编辑面校验）。
 * 5. 窄窗抽屉 Esc：抽屉开着且无更高层消费 → 关闭（planeKeyboard）。
 * 6. Git 图表面键（无修饰；输入框聚焦时透传）：r/Esc/↑↓/Enter。
 * 7. ctrl 层：cycleNext/cyclePrev/toggleSettings/ctrl-shift-g；其余
 *    修饰键组合与全部裸键透传（⌘ 是 platform 修饰不写 PTY——mac ⌘K
 *    劫持零终端冲突；win ctrl-k 与 ctrl-, 同层）。
 *
 * T3+.2 键位参数化：键位从 settings.keybindings 读（createGlobalKeydown
 * 的 keys getter 注入；每次 keyDown 查快照——修改即时生效）。
 *
 * 从 main.tsx 提取为纯依赖注入形态：e2e 的 createTestRoot 挂点与真窗口
 * 装配共用同一份语义（布线差异注入，nativeDeps 同款纪律）。
 */

import { DEFAULTS, type Settings } from './settings/schema'
import type { ThreadStore } from './threads/store'

export type GlobalKeydown = (key: string, ctrl: boolean, shift: boolean, cmd?: boolean) => void

/** 可编辑键位动作——settings/schema.ts keybindings 节的键集（schema 是真值
 *  单点：动作集、默认值、平台分支全在叶子 catch，此处仅派生类型）。
 *  searchThreads（W7）：打开搜索会话弹窗；设置面打开时不劫持
 *  （⌘K 在设置面内语义留给设置搜索）。 */
export type Keybindings = Settings['keybindings']
export type KeybindingAction = keyof Keybindings

/** 键位默认 = schema DEFAULTS.keybindings（单源；运行时真值从 settings 读，
 *  这里只是无注入时的兜底与 UI 展示参照） */
export const DEFAULT_KEYBINDINGS: Keybindings = DEFAULTS.keybindings

/**
 * 模块单例槽：「组件树内 useEffect 注册实现 / 装配层键位消费」共享脚手架
 * （planeKeyboard/dialogKeyboard 同款生命周期）。未注册（无窗口/局部测试
 * 装配）时 impl() 为 null——消费面自行决定安全 no-op 语义。
 */
export function createKeyboardSlot<T extends object>(): {
  register: (impl: T | null) => void
  impl: () => T | null
} {
  let impl: T | null = null
  return {
    register: (next) => {
      impl = next
    },
    impl: () => impl,
  }
}

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
  /** root 层 Esc 清空设置搜索 query（原型 settingsQuery='' 层；未接线 no-op） */
  clearSettingsQuery?: () => void
  /** 关闭设置：回到上一个非设置目标（settings-ui §4；无则 null → '/'） */
  closeSettings: () => void
  /** 元素级已消费本次按键（ui/keyboard keyConsumed.take——一次性，读取即复位）。
   *  键位捕获格全键 / Modal·浮层 Esc / 设置搜索框 Esc 清空等先置位，root 跳过 */
  keyConsumed?: () => boolean
  /** 弹窗开着（原型 `dialog.kind!=='none'` 层）：开着时全部全局动作让位 */
  dialogOpen?: () => boolean
  /** Esc 兜底关闭弹窗（焦点不在卡内时；Radix document 级 Esc 等价物） */
  closeDialog?: () => void
  /** 浮层 Esc 栈（原型 notifOpen/fontPicker 层；ui/keyboard overlayEsc）：
   *  返回 true = 栈顶浮层已关（消费） */
  overlayEsc?: () => boolean
  /** 打开搜索会话弹窗（W7 searchThreads；装配层 → dialogKeyboard.openSearch） */
  openSearch: () => void
  /** ⌘B/Ctrl-B 收起/展开侧栏（Phase D2；窄窗口抽屉态同效） */
  toggleSidebar: () => void
  /** ⌘N（原型）：新建会话——打开工具弹窗（目标 = 当前工作区；装配层注入） */
  newSession?: () => void
  /** Esc：窄窗抽屉打开时吃掉关闭之；返回 true = 已消费（对话框
   *  打开时不触发——弹窗 Esc 由 Modal 自己处理） */
  drawerEsc?: () => boolean
  /** Git 图打开时吃无修饰键（↑↓/enter/escape/r）；返回 true = 已消费。
   *  激活判定在闭包内（workspace 路由 + paneTab==='git'）——非激活必返回 false
   *  透传（硬约束 2：不吃 vim/claude 按键） */
  gitGraphKey?: (key: string) => boolean
  /** Ctrl+Shift+G（git-graph.md §4.3）：当前工作区切 Git 图 tab。一期硬编码
   *  不进 settings.keybindings（T3+.2 四动作之外） */
  openGitGraph?: () => void
  /** 键位真值（默认 DEFAULT_KEYBINDINGS；装配层注入 settings 读取——即时生效） */
  keys?: () => Keybindings
}): GlobalKeydown {
  const {
    store,
    inSettings,
    focusSearch,
    openSearch,
    toggleSidebar,
    newSession,
    drawerEsc,
    inputFocused,
    settingsQuery,
    clearSettingsQuery,
    closeSettings,
    keyConsumed,
    dialogOpen,
    closeDialog,
    overlayEsc,
    gitGraphKey,
    openGitGraph,
    keys,
  } = opts
  const kb = (): Keybindings => keys?.() ?? DEFAULT_KEYBINDINGS
  return (key, ctrl, shift, cmd = false) => {
    // L0 元素级消费标记（原型 kbCapturing/组件编辑态层）：键位捕获格全键、
    // Modal/浮层 Esc、设置搜索框 Esc 清空等已在焦点跳消费——root 跳过
    if (keyConsumed?.()) return
    // L1 弹窗层（原型 `dialog.kind!=='none' → return`）：全局动作全部
    // 让位；Esc 兜底关闭（焦点不在卡内时——卡内 Esc 已被 L0 挡）
    if (dialogOpen?.()) {
      if (key === 'escape' && !ctrl && !cmd) closeDialog?.()
      return
    }
    // L2 浮层 Esc（原型 notifOpen/fontPicker 层）：栈顶浮层关闭
    if (key === 'escape' && !ctrl && !cmd && overlayEsc?.()) return
    // L3 设置面生命周期键（无修饰键；仅设置面打开时吃）
    if (!ctrl && inSettings()) {
      if (key === 'escape') {
        // 原型：query 非空 → 清空不退出；空 → 关闭设置
        if (settingsQuery() === '') closeSettings()
        else clearSettingsQuery?.()
        return
      }
      if (keystrokeMatches(kb().focusSearch, key, ctrl, shift) && !inputFocused()) {
        focusSearch()
        return
      }
    }
    // 会话搜索弹窗（W7）：设置面打开时不劫持（⌘K 留给设置面语义）
    if (!inSettings() && keystrokeMatches(kb().searchThreads, key, ctrl, shift, cmd)) {
      openSearch()
      return
    }
    // 新建会话（D7 ⌘N）：同修饰层
    if (!inSettings() && keystrokeMatches(kb().newSession, key, ctrl, shift, cmd)) {
      newSession?.()
      return
    }
    // 收起/展开侧栏（D2 ⌘B）：cmd/ctrl 修饰层，不吃终端裸键
    if (keystrokeMatches(kb().toggleSidebar, key, ctrl, shift, cmd)) {
      toggleSidebar()
      return
    }
    // 窄窗抽屉 Esc（D18）：设置面/弹窗各管各的，这里只在抽屉开着且无
    // 弹窗时吃（装配层闭包判定）
    if (key === 'escape' && !ctrl && !cmd && drawerEsc?.()) return
    // Git 图表面键（无修饰；输入框聚焦时透传，否则吃 vim/终端键）
    if (!ctrl && !inSettings() && !inputFocused() && gitGraphKey?.(key)) return
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
    } else if (ctrl && shift && openGitGraph && key === 'g') {
      openGitGraph()
    }
  }
}
