/**
 * ui/keyboard.ts — 键盘层共享态（T2.6 输入态判定 + R11 消费标记/浮层栈）。
 *
 * 为什么存在：GPUIX 键盘事件「焦点元素 → 祖先链 → 窗口 root」逐跳派发，
 * JS 侧无 stopPropagation 面——元素 handler 吃掉按键后 root 全局键位层
 * （main.tsx）仍会收到同一事件。两个方向的协调都靠控件自报：
 *
 * - `inputFocus`：当前是否有文本输入框聚焦（`/` 这类无修饰键是否抢焦点，
 *   settings-ui §9）。
 * - `keyConsumed`：本次按键已被元素级 handler 消费（键位捕获格全键 /
 *   Modal·浮层 Esc 等），root 层见标记跳过——对应原型 useGlobalKeys 的
 *   kbCapturing/组件编辑态层。
 * - `overlayEsc`：浮层 Esc 栈（LIFO）——Popover 类浮层挂载期间登记
 *   close；焦点不在浮层内时 root 层也能关栈顶（原型 notifOpen/
 *   fontPicker 层语义）。焦点在浮层内时元素级 Esc 已置 keyConsumed，
 *   root 层在上游被挡——焦点内/外两条路径各关一次、不重复。
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

let consumedFlag = false

/** 「本次按键已被元素级 handler 消费」一次性标记（T2.6 escConsumed 的
 *  R11 泛化——从设置面 Esc 专用扩到任意键）：元素 handler 消费按键后
 *  置位，root 键位层 take() 读到即跳过。消费一次性——读取即复位；
 *  未接线 root 的测试装配下滞留无后果（下一次 take 清零）。 */
export const keyConsumed = {
  /** 元素 handler 消费按键后置位（须在 root 层到达前调用） */
  mark(): void {
    consumedFlag = true
  },
  /** root 键位层读取（读取即复位，一次性） */
  take(): boolean {
    const v = consumedFlag
    consumedFlag = false
    return v
  },
}

const overlayStack: (() => void)[] = []

/** 浮层 Esc 栈（R11）：原型 `notifOpen || fontPicker` 层的等价物——
 *  浮层开着但焦点不在其内时，Esc 经 root 层关栈顶。登记/注销由浮层
 *  原语（Popover）挂载/卸载驱动，调用方零感知。 */
export const overlayEsc = {
  /** 浮层挂载时登记关闭回调，返回注销函数（unmount cleanup 调） */
  push(close: () => void): () => void {
    overlayStack.push(close)
    return () => {
      const i = overlayStack.indexOf(close)
      if (i >= 0) overlayStack.splice(i, 1)
    }
  },
  /** Esc：栈非空 → 关栈顶并返回 true（已消费）；空 → false 放行 */
  escape(): boolean {
    const top = overlayStack.at(-1)
    if (!top) return false
    top()
    return true
  },
}
