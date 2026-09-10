/**
 * ui/keyboard.ts — 文本输入焦点登记（T2.6 键位层的输入态判定面）。
 *
 * 为什么存在：GPUIX 键盘事件「焦点元素 + 窗口 root」两跳，全局键位层
 * （main.tsx）需要知道「当前是否有文本输入框聚焦」来决定 `/` 这类
 * 无修饰键是否抢焦点（settings-ui §9：`/` 不在输入态时才聚焦搜索）。
 * renderer 事件流无 getFocusedElement 面，控件自报是唯一通路。
 *
 * 纯 UI 态、非业务数据：模块单例（router 同款定位），不进任何 store。
 * ui/ 零依赖纪律（§1.2）——本文件不得 import 项目内其他模块。
 */

let inputFocusCount = 0

export const inputFocus = {
  /** 任意文本输入框聚焦时 true（`/` 全局键的守卫） */
  get any(): boolean {
    return inputFocusCount > 0
  },
  /** 控件 onFocus 调用；与 release 严格配对（GPUIX focus/blur 事件天然成对） */
  acquire(): void {
    inputFocusCount++
  },
  /** 控件 onBlur 调用 */
  release(): void {
    inputFocusCount--
  },
}
