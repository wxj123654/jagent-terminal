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
