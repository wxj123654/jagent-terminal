/**
 * surfaces/settingsKeyboard.ts — 设置面键盘生命周期（模块单例，T2.6；T3+.2
 * 从 SettingsView.tsx 提取为独立模块：KeybindingsSection 捕获格也要消费
 * Esc，避免 SettingsView ↔ SettingsSections 循环 import）。
 *
 * main.tsx 全局键位层需要两件组件内状态：Esc 判据（query 是否已空：非空
 * 时组件层已清空、root 层不连坐关闭）与 `/` 聚焦目标（搜索框元素 id）。
 * 纯 UI 态不进 store/router；Esc 时序依赖「React 状态让出后提交」：root
 * 层读到的永远是本次按键前的 query，两层天然不打架（时序三律同源）。
 */

let searchQuery = ''
let searchInputId: number | null = null
let escConsumedFlag = false

/** 全局键位层消费面（main.tsx）：设置面键盘态只读访问 */
export const settingsKeyboard = {
  /** 搜索框当前 query（'' = Esc 可关设置） */
  query(): string {
    return searchQuery
  },
  /** 搜索框元素 id（`/` 全局聚焦目标；未聚焦过为 null） */
  searchInputId(): number | null {
    return searchInputId
  },
  /** 本次 Esc 已被组件消费（搜索框清空 query / 键位捕获格取消编辑）：
   *  root 层不连坐关设置 */
  escConsumed(): boolean {
    return escConsumedFlag
  },
  /** root 层读取后重置（消费一次性） */
  clearEscConsumed(): void {
    escConsumedFlag = false
  },
  /** 组件层消费 Esc 时同步置位（时序：React 状态同步提交，root 层后到） */
  markEscConsumed(): void {
    escConsumedFlag = true
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
