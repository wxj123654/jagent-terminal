/**
 * settings/ui/settingsKeyboard.ts — 设置面键盘生命周期（模块单例，T2.6；T3+.2
 * 从 SettingsView.tsx 提取为独立模块：KeybindingsSection 捕获格也要消费
 * Esc，避免 SettingsView ↔ SettingsSections 循环 import）。
 *
 * main.tsx 全局键位层需要三件组件内状态/能力：Esc 判据（query 是否已空）、
 * Esc 清空 query（query 非空而焦点不在搜索框时——原型 settingsQuery='' 层；
 * 搜索框聚焦时由输入框自理 + keyConsumed 标记）、`/` 聚焦目标（搜索框
 * 元素 id）。纯 UI 态不进 store/router；Esc 时序依赖「React 状态让出后
 * 提交」：root 层读到的永远是本次按键前的 query，两层天然不打架
 * （时序三律同源）。
 *
 * R11：escConsumed 三态退役——消费标记泛化为 ui/keyboard 的 keyConsumed
 * （任意键，不止 Esc；捕获格/弹窗/浮层同面消费），root 层在最顶跳读取。
 */

let searchQuery = ''
let searchInputId: number | null = null
let clearQueryImpl: (() => void) | null = null

/** 全局键位层消费面（main.tsx）：设置面键盘态只读访问 + 注册回调 */
export const settingsKeyboard = {
  /** 搜索框当前 query（'' = Esc 可关设置） */
  query(): string {
    return searchQuery
  },
  /** 搜索框元素 id（`/` 全局聚焦目标；未聚焦过为 null） */
  searchInputId(): number | null {
    return searchInputId
  },
  /** root 层 Esc 清空 query（原型：query 非空 Esc = 清空不退出）。
   *  搜索框聚焦时输入框自理（keyConsumed 标记先到），这里是未聚焦兜底；
   *  未注册（设置面未挂载）时 no-op */
  clearQuery(): void {
    clearQueryImpl?.()
  },
  /** SettingsView 挂载登记「清空 query」实现（卸载置 null） */
  registerClearQuery(fn: (() => void) | null): void {
    clearQueryImpl = fn
  },
  /** SettingsView 搜索框挂载/卸载面 */
  setSearchInput(id: number | null): void {
    searchInputId = id
  },
  /** query 提交同步（SettingsView useEffect） */
  setQuery(q: string): void {
    searchQuery = q
  },
}
