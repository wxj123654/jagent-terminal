/**
 * plane/sidebarKeyboard.ts — 工作区侧栏搜索键盘生命周期（模块单例，W4；
 * surfaces/settingsKeyboard.ts 同款纪律：纯 UI 态不进 store/router）。
 *
 * main.tsx 的 searchThreads（⌘K/Ctrl-K）全局聚焦需要搜索框元素 id——
 * gpuix React ref 在挂载时拿到带 .id 的实例，经模块态透出到装配层。
 * query 同步上报：Sidebar Esc 层级判据（非空清空 / 空+抽屉态关抽屉）。
 */

let searchInputId: number | null = null
let searchQuery = ''

/** 全局键位层消费面（main.tsx）：侧栏搜索态只读访问 */
export const sidebarKeyboard = {
  /** 搜索框元素 id（⌘K 聚焦目标；Sidebar 卸载（窄窗口抽屉关）为 null） */
  searchInputId(): number | null {
    return searchInputId
  },
  /** 搜索框当前 query */
  query(): string {
    return searchQuery
  },
  /** Sidebar 搜索框挂载/卸载面 */
  setSearchInput(id: number | null): void {
    searchInputId = id
  },
  /** query 提交同步（onChange） */
  setQuery(q: string): void {
    searchQuery = q
  },
}
