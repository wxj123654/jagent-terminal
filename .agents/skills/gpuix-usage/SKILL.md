---
name: gpuix-usage
description: j-agent 的 gpuix UI 用法与坑位记录。写/改 gpuix 界面代码（anchored 浮层、Popover、Modal、ContextMenu、圆角卡片、deferred/occlude）时查阅。
---

# gpuix 用法记录

j-agent 的 UI 跑在 gpuix（`.refs/gpuix`，React → Rust/gpui 渲染）。本文件记录
各组件的用法与已踩过的坑；新增条目按组件分节，每条写清「现象 → 根因 → 写法」。

## anchored：面色必须写在元素自身

`<anchored>`（`packages/native/src/custom_elements/anchored.rs`）渲染时检查
**自身** `style` 有无不透明背景，没有就强制填充 `#1A1A1A`（防 deferred 浮层
透出页面）。这个兜底矩形会从子级圆角卡片的透明角透出，表现为浮层四角出现
黑色三角块。

**写法**：背景 + 圆角（即"面色"）放在 `<anchored style>` 上，子级只留布局/
内边距。参考 `Modal.tsx`、`GitGraphView.tsx` 的菜单——它们一直是对的。

```tsx
// 对：面色在 anchored 自身
<anchored position={pos} deferred occlude
  style={{ backgroundColor: COLORS.overlay, borderRadius: 6 }}>
  <div style={{ padding: 4 }}>…</div>
</anchored>

// 错：面色只在子级 → anchored 吃 #1A1A1A 兜底，圆角透出黑三角
<anchored position={pos} deferred occlude>
  <div style={{ backgroundColor: COLORS.overlay, borderRadius: 6 }}>…</div>
</anchored>
```

子级样式由调用方覆盖时（如 `Popover` 的 `style` prop），把
`backgroundColor`/`background`/`borderRadius` 提取出来同步给 `<anchored>`，
见 `packages/ui/src/overlays/Popover.tsx` 的 `surface` 写法。

## flex 子元素负 margin 会把父容器宽度塌成 0

**现象**：flex row 容器内给某个子元素写 `marginRight: -4`（等负外边距），
Taffy 布局会把**父容器自身宽度**算成只剩 padding——所有兄弟元素按自然
位置排版但溢出到容器外（视觉重叠、命中盒错位：点在"子元素 bounds 中心"
实际落在容器外，click 既不命中它也不命中父级）。

**写法**：别用负 margin 做"贴边收回"（如 tab 内 × 钮想少占 4px）。改用
收窄父级 padding（`paddingRight: 4`）或正常正 margin。实例：
`SessionTabs` 的 `.tab` 曾用 `marginRight:-4` 让 × 钮视觉回收 padding，
实测父 tab 宽塌成 16px（=左右 padding）。

## 事件命中：deepest 有 handler 的元素

GPUIX/gpui 的鼠标事件**不冒泡**——命中链上 deepest **带 handler** 的元素
接收事件，祖先 handler 不会同次触发。推论：

- 行内交互钮（×/「…」）自身挂 onClick 即独立命中，无需
  stopPropagation/抑制位。
- 装饰子元素（text/svg/icon）一律 `pointerEvents: 'none'` 穿透到父级
  命中盒（ThreadRow 注释 §20-21 同款纪律）；不带 handler 的叶子本身
  会被跳过、不影响父级命中。

`getElementBounds` 返回的是 **content-box**（不含元素自身 border）：
定高 40 + borderBottomWidth 1 的元素 bounds.h = 39。换算窗口 chrome
总高时用 border-box（定高值 + 根元素自身 border）。
