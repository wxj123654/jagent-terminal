# Web Canvas 库兼容性分析与阶段验收计划

> 结论日期：2026-09-12。前置研究：[canvas-2d-standard-research.md](./canvas-2d-standard-research.md)。
> 回答的问题：初版 Canvas 2D 实现之后，能不能直接把 Web 生态的 canvas 库（rough.js、uPlot、Chart.js、ECharts 等）用到 j-agent 里？

## 1. 结论

**能，但分层。** 能不能用一个 Web canvas 库，不取决于 ctx 方法数量的覆盖，而取决于它落进哪一层依赖：

| 层 | 库需要的东西 | 我们的现状 |
|---|---|---|
| ① ctx API | 路径/文本/渐变/裁剪/合成/像素 | P0–P3 逐步覆盖（见前置研究 §8） |
| ② canvas 元素与资源 | `getContext` 恒等返回、`document.createElement('canvas')` 离屏画布、`drawImage(canvas)`、`Image` + onload、`toDataURL` | **规划缺口**：P0 的 React prop 通道天然只覆盖挂载在树上的 canvas |
| ③ DOM 宿主 | `rAF`、`devicePixelRatio`、canvas 元素事件（`offsetX/Y`）、`getBoundingClientRect`、模块顶层访问 `window/document` | GPUIX 全没有，需要专门的 host shim 包 |

多数主流库三层全占。因此「实现初版 canvas2d」≠「能跑 web 库」——初版（P0）只够跑最薄的库。

## 2. 主流库分级（按依赖深度）

| 库 | 依赖层 | 最低阶段 | 说明 |
|---|---|---|---|
| rough.js | ①（浅） | **P0/P1** | `RoughCanvas` 构造时只要一个带 `getContext('2d')` 的对象，自取 ctx；无事件、无 DOM 深依赖（源码 src/canvas.ts）。缺口只剩 roundRect/clip 等散点 API |
| d3-shape | ① | P1 | 纯几何库，只产出 path 指令；但喂给 ctx 需要 `Path2D` 或逐命令调用 |
| uPlot | ①+③ | **P2** | 无依赖、canvas 2D 绘制，但交互（十字线、缩放、图例 hover）依赖 canvas 元素上的鼠标事件 + `offsetX/Y` + DPR |
| Chart.js v4 | ①+②+③ | **P2 尾–P3** | roundRect、区域 clip、measureText、DPR、双 canvas（overlay 事件层）、导出 |
| ECharts(zrender) / Konva / fabric | ①+②+③（全占） | **P3 以后** | 离屏 pattern/位图缓存、`globalCompositeOperation`、`getImageData/toDataURL`、完整事件系统、`getBoundingClientRect` |

> 分级以各库当前版本的公开源码/文档为准；实际引入前仍按仓库规则联网核实版本与兼容性。

## 3. 对实现设计的反推（比「能不能」更重要）

### 3.1 surface 从「元素」泛化为「资源」

Konva 整层离屏缓存、Chart.js 内部缓存、ECharts pattern 都靠 `document.createElement('canvas')`——**画布不挂在 React 树上，纯粹当像素暂存器用**。这是标准行为，不是库的怪癖。

因此 P2 的 renderer-scoped command/query seam 设计必须提前考虑：

- 支持**离屏 surface**：不参与布局、不参与 paint，只作为像素容器；
- `drawImage` 接受 surface 引用作为源（`CanvasImageSource` 本就包含 canvas）;
- Rust 侧需要 **surface registry**（按 handle 索引），而不是只按 React element id 索引。

如果 P2 只做「挂载 canvas 的命令通道」，到 P3 才补离屏，会推翻一次接缝设计。代价不大但要提前留位。

### 3.2 P1 需求优先级调整

以下 API 从「可选」升级为「库兼容刚需」：

- `roundRect`（Chart.js v4、大量现代库的默认圆角路径）
- `Path2D`，至少接受 SVG path 字符串构造（d3 生态、图标复用）
- `setLineDash`（虚线图表、rough.js 的手绘感依赖）
- 同步 `measureText`（几乎所有图表库的轴标签布局前置）

### 3.3 canvas-host shim 包

第③层没有捷径，需要一个本仓包（例如 `packages/canvas-host`），提供：

```ts
// 先 shim 后 import —— 顺序是硬约束：
// 不少库在模块顶层就访问 window/document，import 顺序错了直接崩
import { installCanvasHost } from '@jagent/canvas-host'
installCanvasHost({ renderer, dprSource })

import 'chart.js/auto' // 之后才允许
```

职责清单：

- `createElement('canvas')` → 离屏 surface（见 §3.1）
- `Image` stub：`src`（本地路径/data URL）+ `onload`/`onerror`
- `requestAnimationFrame` 映射到 renderer 帧循环（`startFrameLoop` 的节奏，8ms 上限）
- `devicePixelRatio` 取 `window.scale_factor`（带失效通知）
- 事件桥：外层 div 的 GPUIX 事件 → 标准 `pointer/mouse event`（`offsetX/offsetY/target/currentTarget`）→ canvas 上 dispatch
- `getBoundingClientRect` → 最近一次布局的元素 bounds（automation.rs 的 bounds_tracker 数据源）

### 3.4 性能账

Web 库的绘制模式是「每帧全量重绘 + 数千条小命令」（uPlot 冷启动 166k 点 25ms 的量级）。这条路径不走 GPUIX 元素树——**这正是我们想要的**（同 git-graph-row 优化的方向），但瓶颈转移到：

> **JS → Rust 一次 NAPI 往返能装多少条命令？**

- 命令编码必须批量（一次调用一帧的 display list），禁止每 draw call 一次 NAPI；
- P1 的 JSON prop 通道大概率不够（每帧全量 + 数千命令的 stringify/parse），P2 需要二进制批传（`ArrayBuffer`/`Float32Array`）；
- benchmark 必须包含「模拟 uPlot 负载：每帧 5k 命令 × 60fps」这一档，否则「库能跑」只是演示级结论。

## 4. 阶段验收计划

把真实库写进各阶段的验收标准——兼容清单由 demo 页坐实，而不是「感觉 API 差不多了」：

| 阶段 | 验收库与场景 | 通过标准 |
|---|---|---|
| **P0/P1** | rough.js：手绘风格图（形状 + 手绘边框 + 填充纹理） | demo 视觉与浏览器一致；`bun test` 截图对比 |
| **P2** | uPlot 或 d3-shape：交互式时序图（十字线、tooltip、缩放） | 交互不丢事件；60fps 下 draw p90 与手写 canvas 等价负载持平 |
| **P2 尾** | Chart.js v4 官方 demo（line/bar/pie 至少各一） | 默认渲染正确；overlay 事件层工作 |
| **P3** | Chart.js 导出（`toDataURL`）+ Konva 单层 demo | 像素读回正确；离屏缓存生效 |

每个阶段的 conformance 清单（canvas-conformance.json）同步追加这些库用到的 API 项。

## 5. 决策建议

1. 不要为了「跑通 Chart.js」而提前堆 P3 能力——按验收表推进，每阶段一个真实库坐实。
2. P2 的 seam 设计时**预留 surface registry**（§3.1），这是唯一一个「现在不留位、将来要返工」的点。
3. `canvas-host` shim 与 canvas 元素实现解耦成两个包：前者纯 JS（可在 bun test 里单测），后者依赖 native——避免 shim 的回归测试被迫跑像素级 e2e。
