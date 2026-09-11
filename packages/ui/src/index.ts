/**
 * @jagent/ui — j-agent 通用组件库（ui-extensions.md）。
 *
 * 定位：GPUIX 的补充层——包装（统一样式/API）+ 组合组件；仅实际原生缺口
 * 才下沉 Rust（经 @jagent/native 适配），不重写 GPUIX 已有能力。
 * 依赖纪律：只依赖 react + @gpuix/react + 本包内部；不 import app 业务模块
 * （architecture.md §1.2「ui 被所有人依赖，不依赖任何人」的包级落地）。
 *
 * src 布局：controls/ 值输入与操作控件 · overlays/ 浮层与反馈 ·
 * display/ 展示原子 · theme/ 主题 tokens 与共享样式片段；
 * 根下只留跨控件 util（keyboard/platform）与本出口。测试在 __tests__/。
 */

export * from './display/Badge'
export * from './display/Icon'
export * from './controls/IconButton'
export * from './keyboard'
export * from './overlays/Modal'
export * from './controls/NumberInput'
export * from './platform'
export * from './overlays/Popover'
export * from './controls/RangeInput'
export * from './controls/Select'
export * from './theme/style'
export * from './controls/Textarea'
export * from './controls/TextInput'
export * from './overlays/Toast'
export * from './controls/Toggle'
export * from './theme/tokens'
export * from './overlays/Tooltip'
