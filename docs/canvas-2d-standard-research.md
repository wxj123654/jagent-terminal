# GPUIX React Canvas 2D：标准边界与本地实现可行性

> 结论日期：2026-09-11。目标是判断 j-agent 能否不先修改 `.refs/gpuix`，在本仓提供 React 可用、接口尽量兼容 Web Canvas 2D 的模块。

## 1. 结论

可以在本仓实现 `<Canvas>` 和 `getContext('2d')`，并由本仓的 native crate 注册 GPUIX `<canvas>` custom element；首期不需要修改 `.refs/gpuix`，也不需要新增依赖。

但必须区分两种目标：

1. **Web 接口兼容子集**：方法名、状态规则和调用方式跟随标准，覆盖基础矩形、路径、变换、颜色、文本等；本仓现有 GPUI 能力足以实现。这是合理的首期目标。
2. **完整 Canvas 2D 标准一致性**：需要持久 output bitmap、像素读回、任意区域透明清除、完整合成/混合、任意路径裁剪、图片源与安全污染、CSS 颜色/字体语义、完整 TextMetrics、序列化以及 context lost 等。GPUI 的 `canvas(...)` 是每帧向 scene 提交 primitive 的绘制闭包，不是可读写的持久 framebuffer；仅靠 display list 回放不能满足完整语义。

因此首期不能笼统宣称“W3C Canvas compliant”。应公开一份**兼容性清单**，说明跟随 WHATWG Canvas 2D，并以选定的 Web Platform Tests（WPT）用例记录通过范围。

## 2. 规范目标

当前应以 WHATWG HTML Living Standard 的 Canvas 章节作为主规范：

- [WHATWG HTML Standard — The canvas element](https://html.spec.whatwg.org/multipage/canvas.html)
- 历史 [W3C HTML Canvas 2D Context Recommendation](https://www.w3.org/TR/2015/REC-2dcontext-20151119/) 发布于 2015-11-19；W3C 的[发布历史](https://www.w3.org/standards/history/2dcontext/)记录该独立规范已于 2021-01-28 retired。

所以“符合 W3C 标准”在本项目中应解释为：

- 接口和行为跟随当前 WHATWG Living Standard；
- 历史 W3C Recommendation 只作为基础子集参考；
- 用 WPT 的明确测试集合说明兼容度，不做无边界的“完全兼容”声明。

WHATWG 当前 `CanvasRenderingContext2D` 不是少量绘图方法，而是由多组 mixin 组成，包括 state、transform、compositing、image smoothing、fill/stroke styles、shadow、filter、rect、path、text、drawImage、ImageData、line styles 和 text styles；并关联 `Path2D`、`CanvasGradient`、`CanvasPattern`、`TextMetrics`、`ImageData`、`DOMMatrix` 等对象。接口定义见[规范 2D rendering context](https://html.spec.whatwg.org/multipage/canvas.html#the-2d-rendering-context)。

## 3. 为什么 GPUI display list 不能直接等同标准 Canvas

浏览器 Canvas 2D 的核心是持久 output bitmap。绘制调用会改变 bitmap；后续操作可依赖已有像素。规范还要求：

- `save()` / `restore()` 保存和恢复完整 drawing state；drawing state 包含 transform、clip、样式、filter、alpha、compositing、阴影、文字和线型设置等；current path 本身不属于 drawing state。
- `reset()` 清空 bitmap、path 和 state stack，并恢复默认状态。
- `clearRect()` 把裁剪区域内对应像素清为 transparent black，而不是画一个透明矩形。
- `getImageData()` / `putImageData()` 操作真实像素；`willReadFrequently` 甚至允许实现为读回优化选择 CPU backing。
- `globalCompositeOperation`、clip、shadow、filter 与既有像素共同决定结果。

以上语义见 [Canvas state](https://html.spec.whatwg.org/multipage/canvas.html#canvas-state)、[Drawing rectangles](https://html.spec.whatwg.org/multipage/canvas.html#drawing-rectangles-to-the-canvas) 和 [Pixel manipulation](https://html.spec.whatwg.org/multipage/canvas.html#pixel-manipulation)。

GPUI `canvas(...)` 的闭包每帧向窗口 scene 写入 path、quad、text、image primitive。它非常适合高性能自绘，但没有元素级、可同步读回的持久 framebuffer。因此：

- 完整清屏可以通过丢弃旧 display list 表达；
- 任意区域 `clearRect()`、复杂 composite、像素读回无法仅靠按顺序重放矢量命令严格表达；
- 若需要这些行为，最终必须引入 offscreen bitmap/raster surface，或扩展 GPUI 提供区域渲染和读回。

## 4. 本仓已有实现接缝

### 4.1 可直接复用的 native custom element 生命周期

`.refs/gpuix/packages/native/src/custom_elements/mod.rs` 已提供：

- `CustomElementFactory::create(id)`：元素首次出现时创建持久实例；
- `CustomElement::set_prop`：只接收变化后的 custom props；
- `CustomElement::render`：每个 GPUI frame 返回元素；
- `destroy`：React unmount 时清理。

`packages/native/src/git_graph.rs` 已证明本仓可以：

- 在 native crate 自己实现 custom element；
- 用 `gpui::canvas` paint；
- 在 custom element 实例中跨帧保存 typed 数据和缓存；
- 通过 `packages/native/src/lib.rs` 在 renderer 初始化前注册 factory。

GPUIX React 类型目前已经把 `canvas` 列为 intrinsic element，但只给了通用 `Props`；native 默认 registry 没有 Canvas factory。也就是说，这个名字和接缝已经存在，缺的是实现。

### 4.2 首期无需改 `.refs/gpuix`

可在本仓增加：

- `packages/native/src/canvas.rs`：`CanvasElementFactory`、typed display list、GPUI replay；
- `packages/native/src/lib.rs`：`installCanvasElement()`；
- `packages/native/index.js` / `index.d.ts`：由 napi-rs 重新生成；
- 本仓 React `Canvas` module：标准形状的 ref 与 JS context；
- `packages/app/src/main.tsx`：在 `renderer.init()` 前注册；
- unit、TestRenderer 和像素测试。

若只在 wrapper 内部使用类型收窄，首期不必修改 GPUIX 的 `host.ts` / `jsx-runtime.d.ts`。将来要让任意调用方直接写裸 `<canvas>` 并获得强类型 props，再走 patch/MANIFEST/export-patches 流程扩展上游类型。

现有 global factory table 在首个 `CustomElementRegistry::with_defaults()` 中会被 drain；多 renderer/重复建 renderer 的注册生命周期是已有风险，Canvas 测试必须覆盖。

## 5. 推荐的深模块设计

外部 seam 应是一个 React module，调用者只需知道标准形状的 interface：

```tsx
const ref = useRef<GpuixCanvasElement>(null)

useEffect(() => {
  const ctx = ref.current?.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, 640, 360)
  ctx.fillStyle = '#ff5050'
  ctx.fillRect(10, 10, 80, 40)
}, [])

return <Canvas ref={ref} width={640} height={360} style={{ flexGrow: 1 }} />
```

建议分成三个内部 adapter，但不暴露给调用者：

1. **JS context/state adapter**：实现标准属性、path、save/restore stack、参数验证；每次调用更新逻辑状态并追加规范化命令。
2. **transport adapter**：把一个事件循环内的命令合批为 immutable display-list revision，经已有 React custom prop / mutation batch 发送。
3. **native replay adapter**：仅在 revision 变化时解析成 Rust typed scene；paint 热路径只回放缓存 path/text/image，不解析 JSON、不长期持锁。

React ref 不能直接使用 GPUIX `PublicInstance`：现有 ref 只是 `{id,type,props}`，没有 `getContext`。`Canvas` wrapper 应用 `forwardRef` + `useImperativeHandle` 暴露标准形状的元素对象。

### 5.1 自动提交，不公开 `commit()`

显式 `commit()` 不是普通 `CanvasRenderingContext2D` 的标准接口，不应成为调用者必须了解的规则。实现内部可以 microtask/rAF 合批并自动 invalidate；测试可有私有 flush seam。

但是，标准中的同步查询方法（如 `measureText()`、`getImageData()`）不能等待异步 React commit：

- `measureText()` 首期需要同步 native query，或提供可证明一致的 JS 字体测量实现；
- `getImageData()` 必须等有真实 backing bitmap 后才能实现；
- 在未实现前应从兼容清单标为 unsupported，不能返回虚假近似值。

## 6. 能力和标准差距矩阵

| 能力 | 本仓 GPUI 基础 | 首期判断 |
|---|---|---|
| `width` / `height` 与 resize reset | custom prop + instance state | 可实现；backing size 与 CSS layout size必须分离 |
| `save` / `restore` | JS state stack | 可实现；需复制标准列出的完整已支持状态 |
| transform / DOMMatrix 子集 | affine matrix + GPUI/Lyon transform | 可实现基础六参数矩阵 |
| `fillRect` / `strokeRect` | quad/path | 可实现 |
| 基础 path fill/stroke | GPUI path builder/Lyon | 可实现 line/quadratic/cubic/arc 子集；逐项核对 cap/join/miter/dash/fill rule |
| solid CSS colors | 项目已有颜色解析片段 | 可实现有限格式；完整 CSS Color 语法不是现成能力 |
| text draw | TextSystem + ShapedLine | 可实现基础字体/对齐；完整 CSS font shorthand、方向和 TextMetrics 很难 |
| gradients/patterns/shadow/filter | 能力不完整 | 后置；不能先声称支持 |
| `drawImage` | GPUI RenderImage + `<img>` 已有 decode/cache | 需设计稳定资源句柄、裁剪和安全模型 |
| 任意 clip / composite | window scene 能力不足以覆盖全部组合 | 需要 offscreen raster/backing |
| 局部透明 `clearRect` | display list 无法严格表达 | 需要 backing bitmap或命令切割 |
| `ImageData` / `toDataURL` / `toBlob` | 无元素 framebuffer 读回 | 需要 CPU bitmap或 GPUI patch |
| origin-clean / taint | 无浏览器 origin/CORS 模型 | native 本地语境需定义不同安全策略，不能宣称浏览器一致 |
| focus/fallback DOM/accessibility | GPUIX 有部分事件/a11y seam | 与 HTMLCanvasElement DOM 行为不同；外层 React 元素负责 |
| OffscreenCanvas/Worker | 无对应 worker ownership/transfer seam | 不在首期范围 |

## 7. 标准测试策略

Web Platform Tests 仓库在 `html/canvas` 下维护 Canvas 测试，生成测试的更新命令由其 README 说明为 `wpt update-built --include canvas`：

- [WPT Canvas tests](https://github.com/web-platform-tests/wpt/tree/master/html/canvas)
- [WPT license](https://github.com/web-platform-tests/wpt/blob/master/LICENSE.md)：BSD 3-Clause。

本项目不是浏览器，不能原样宣称跑通整套 DOM/WPT harness。建议维护 `canvas-conformance.json`：

- 每个标准 member 标记 `pass` / `partial` / `unsupported`；
- 对纯 2D 算法和像素结果选择性移植 WPT case；
- 保留 WPT 测试文件的来源 URL、commit、许可证头；
- interface 测试覆盖默认值、非法值忽略、NaN/Infinity、save/restore、resize reset；
- 像素测试在 debug `.node` 下运行，结束后恢复 release `.node`；
- benchmark 覆盖大量命令、长 display list、动画、resize 和 text cache。

## 8. 分阶段建议

### P0：本仓-only，标准形状的核心矢量子集

- `<Canvas ref width height style>`；backing width/height 默认值按标准为 300×150；
- `getContext('2d')`，重复调用返回同一 context，其他 context id 返回 `null`；
- 自动批处理/invalidate；
- `fillStyle` / `strokeStyle` / `globalAlpha` 的受支持子集；
- `save` / `restore` / `resetTransform` / 六参数 transform；
- rect + 基础 path + solid fill/stroke；
- 基础 `fillText`；只有后端能生成真实字形轮廓时才加入 `strokeText`；
- width/height 属性被赋值时清空内容和状态（即使值未改变），CSS layout size 改变不触发该 reset；
- 明确的 compatibility manifest。

P0 叫“WHATWG Canvas 2D core-compatible subset”，不叫完整标准实现。

### P1：正确性、资源和性能

- path/text typed cache；
- DPR 和 layout resize 契约；
- 完整参数验证和默认值；
- 本地/data URL 图片与资源句柄；
- display-list compaction、命令数/坐标/字符串预算；
- 以实际 benchmark 决定是否从 JSON prop 升级为 binary batch。

### P2：按真实需求扩展 GPUIX seam

只有测到 React prop transport 是瓶颈，或需要同步 query/完整 pointer 事件时，再修改 `.refs/gpuix`：

- renderer-scoped `invokeElementCommand`；
- binary batch；
- custom element 同步 query；
- 补齐 pointer/focus/capture 事件；
- Canvas 专属 JSX 类型。

### P3：真正 bitmap 语义

选择 CPU raster surface 或 GPUI offscreen/render-target patch，完成：

- 局部 clear；
- 完整 clip/composite/shadow/filter；
- `ImageData`、导出、读回；
- 图片污染/安全策略；
- 更大范围 WPT 像素一致性。

这是从“接口兼容子集”走向“标准实现”的关键阶段，工作量显著大于 P0。

## 9. 决策建议

若目标只是让本项目的 Git 图、图表等代码使用熟悉的 Canvas 2D interface，可以先实施 P0；但必须命名为兼容子集，从第一天按标准默认值和异常规则写测试，不发明公开 `commit()`。

若“符合 W3C/WHATWG 标准”是硬要求，推荐顺序相反：先建立 renderer-scoped imperative command/query seam，再选择 backing bitmap/raster backend，优先保证同步查询、clear、clip、composite 和像素语义；GPUI 只负责把最新 bitmap 作为纹理呈现。此时 display list 只能作为批处理/重放优化，不能成为事实状态。

就用户本次明确提出的标准要求，默认应采用后一条路线，并在通过约定的 WPT 清单之前不宣称完整兼容。
