# Canvas 2D Rust 光栅后端调研：现成库能否简化实现

> 结论日期：2026-09-20。前置研究：[canvas-2d-standard-research.md](./canvas-2d-standard-research.md)（标准边界与 display-list 路线）、[canvas-web-lib-compat.md](./canvas-web-lib-compat.md)（Web 库分层兼容性）。
> 回答的问题：上一轮规划的「JS ctx → 命令批 → GPUI primitive 回放（P0–P2）→ P3 自建 bitmap」路线，能不能用现成 Rust 光栅库简化？

## 1. 结论

**能，而且会改变路线形状。** GPUI 原生存在「BGRA 位图 → 纹理 → 场景」呈现通道（`window.paint_image` + `RenderImage` + `window.drop_image`，无需改 `.refs`）。把 CPU 光栅库接在这条通道上，**持久 bitmap 语义从第一天就有**——局部 `clearRect`、`globalCompositeOperation` 对既有像素合成、任意 clip、`getImageData`/`putImageData`/`toDataURL` 全部直接成立，原规划 P3 的「真正 bitmap 语义」不再是单独大阶段。

即：原 P0–P2（矢量 display-list）与 P3（bitmap）两条路线，可以合并为一条 **bitmap-first** 路线：

```
JS ctx 调用 → 命令批 → Rust 光栅库写入持久 Pixmap → 脏时包装成 RenderImage → paint_image
```

代价从「像素语义缺失」换成「每帧 CPU 光栅 + 脏时整纹理上传」。同步查询（`measureText`/`getImageData`）变成普通 napi 同步调用，不再需要 renderer-scoped query seam——**上轮 §5.1 的两个硬约束同时消解**。

## 2. 呈现通道（`.refs` 已核实，零补丁）

- `window.paint_image(bounds, image_bounds, corner_radii, Arc<RenderImage>, frame_index, grayscale)`：`gpui/src/window.rs:4577`，经 `sprite_atlas.get_or_insert_with` 按 `RenderImageParams{image_id, frame_index}` 上 atlas。
- `RenderImage::new(SmallVec<[image::Frame;1]>)`：`gpui/src/assets.rs:61`，裸像素帧直接构造；`ImageId` 自增。**每次创建新 id → 新 atlas tile；上一帧的旧 tile 用 `window.drop_image(Arc<RenderImage>)`（window.rs:4726）逐帧移除**，否则 atlas 泄漏。
- 像素格式：Metal atlas polychrome = `BGRA8Unorm`（`gpui_apple/src/metal_atlas.rs:147`）；Windows DirectX atlas 同样 BGRA。**tiny-skia/vello_cpu 的 Pixmap 均为 premultiplied RGBA，上传前需 R↔B swizzle**（参照 `platform.rs` GIF 解码处的 `pixel.swap(0, 2)` 做法；bytemuck 已在锁文件）。
- 静态 canvas 零成本：revision 未变就复用同一 `Arc<RenderImage>`，不重新上传。
- 备选通道 `window.paint_surface` 仅 `cfg(linux/freebsd)`，不可用。
- `image` crate 锁 0.25.10（gpui 依赖）；`Frame::new(RgbaImage)` 即可包装裸 buffer，无需解码。

## 3. 候选库核实结果（版本均经 crates.io/docs.rs 在线核实，2026-09-20）

| 库 | 最新版 | 发布日期 | 许可 | 结论 |
|---|---|---|---|---|
| **vello_cpu** | 0.2.0 | 2026-08-12 | Apache-2.0/MIT | **首选**。Canvas 形态最完整的 CPU rasterizer |
| **tiny-skia** | 0.12.0 | 2026-02-02 | BSD-3 | **稳妥备选**。最成熟（resvg 后端），但无 layer/text |
| raqote | 0.8.5 | 2024-09-11 | BSD-3 | API 最像 Canvas（DrawTarget），但两年未发版、70 open issues，不选 |
| skia-safe | 0.153.3 | 活跃 | MIT | 保真度最高（Chrome Canvas 后端本体），但 binary-cache 拉预编译 Skia、二进制体积与构建成本大，暂不必要 |
| femtovg | 0.27.0 | — | — | **否决**：API 仿 Canvas 但只有 OpenGL 后端，与 Metal/DX12 不兼容 |
| piet | 0.8.0 | — | — | **否决**：Linebender 已转向 vello，维护停滞 |
| deno_canvas | 0.121.0 | 2026-09-16 | MIT | **不能直接依赖**（deno_core/deno_webgpu 扩展形态），但实现是可读参考 |
| vello (wgpu) | 0.10.0 | 2026 | Apache/MIT | **暂不选**：GPU 纹理无法注入 GPUI 场景（Metal 侧无外部纹理通道），留作未来 |
| @napi-rs/canvas | npm 1.0.9 | 2026-09-09 | MIT | **JS 侧捷径**，见 §6 |

文本栈（所有 CPU rasterizer 都需要外配）：

| 库 | 版本 | 用途 | 备注 |
|---|---|---|---|
| cosmic-text | 0.19.0 | shaping+layout | **已在锁文件**（GPUI Linux 文本路径） |
| swash | 0.2.10 | 字形光栅化进 pixmap | 已在锁文件 |
| fontdb | 0.24.0（锁 0.23.0） | 字体发现 | 已在锁文件（usvg 链） |
| parley | 0.11.1 | shaping（vello 生态配套） | Deno canvas2d 同款 |
| resvg/usvg | 0.48.1（锁 0.46.0） | SVG `drawImage` 源 | 已在树内 |

## 4. 关键先例：Deno 官方 Canvas 2D 就是这条路线

denoland/deno PR #35215（2026-06，open）：`OffscreenCanvasRenderingContext2D` 用 **vello(wgpu) + vello_cpu** 双后端实现，代码在 `ext/web/canvas2d`，MIT。

- CPU 后端用于 `willReadFrequently`、小画布、超纹理上限、频繁读回——**正是我们的全部场景**。
- 已实现的语义面可作为我们的兼容清单参考：Path2D、CanvasGradient、CanvasPattern、ImageData、`beginLayer/endLayer`、FontFace/FontFaceSet、CSS Color 4/5 解析、增强 TextMetrics。
- 其已知限制即 vello 生态当前边界：`shadowBlur` 只有偏移无高斯模糊（vello#476）、CSS `filter()` 解析但不渲染（vello#1695）、短角段粗 stroke 渲染错误（vello#1063）。
- **该代码不能当依赖用**（绑死 deno_core op 机制），但可作为状态机映射的参考实现逐段对照。

## 5. vello_cpu vs tiny-skia 能力面对照

| Canvas 需要 | vello_cpu 0.2.0 | tiny-skia 0.12.0 |
|---|---|---|
| 持久 pixmap + 读回 | `Pixmap`（PremulRgba8，`data_mut`） | `Pixmap`（`data_mut`/`take_demultiplied`） |
| fill/stroke path | kurbo `BezPath`（含 dash via `set_stroke`） | `tiny-skia-path`（含 `Stroke::dash`） |
| transform | `set_transform`/`transform`（Affine） | `Transform` |
| save/restore | `save_current_state`/`restore_state` 内建 | 无（JS 侧状态栈自理，本就计划如此） |
| clip | `push_clip_path`/`push_clip_layer` | `ClipMask`（mask 灰度图） |
| globalAlpha/composite | `push_opacity_layer`/`push_blend_layer`/`set_blend_mode` | Paint `blend_mode`；单 path 半透明重叠需手工离屏 pixmap 再 `draw_pixmap` |
| gradient/pattern | `set_paint`（peniko：linear/radial/sweep/image pattern）+ `set_paint_transform` | `LinearGradient`/`RadialGradient`（0.12 起两点锥形）/`SweepGradient`/`Pattern` |
| 图片 `drawImage` | `Image` paint（`ImageSource::Pixmap`） | `draw_pixmap` |
| shadow/filter | `push_filter_layer`——**复杂 filter 会 panic**（官方声明） | 无 filter；shadow 需手工 blur pass |
| 文本 | `glyph_run`（接外部 shaped run，`glifo` feature） | 无；swash 光栅化字形贴 pixmap |
| 多线程 | `multithreading` feature（rayon，可选） | 无 |
| 成熟度 | **0.2.0，2026-08 首发**，官方自述 API/Resources 仍在打磨 | 极成熟（resvg/无数下游），锁文件已有 0.11.4 |
| 生态对齐 | Linebender 主线，Deno canvas2d 同款后端 | 同上生态但定位更底层 |

## 6. JS 侧捷径：@napi-rs/canvas（npm 1.0.9）

完全不同的省力方式：它是 skia-safe 上**完整实现的 Canvas API**，本身就是个 .node addon。用法：

```
bun 侧 createCanvas → ctx 全套 API（含 Path2D/measureText/getImageData/toDataURL）
→ getImageData 拿裸 RGBA → 经我们自有 napi 上传 → RenderImage → paint_image
```

- **零 Rust canvas 代码**，API 覆盖面直接拉满，天然可当像素对比 oracle。
- 风险三件套：① Bun 对 napi addon 是「best effort」（napi-rs 官方 CI 对 Bun 是 continue-on-error；2024-12 的 wrap finalizer 崩过、已修）；② **oven-sh/bun#23904：`bun build --compile` 的 Windows 产物加载该 .node segfault**——与我们打包路径正面冲突，未经实机验证不能依赖；③ 额外 ~几十 MB Skia 二进制进产物。
- 定位建议：**不作为生产路径的 ctx 实现**；作为开发期参照（oracle diff）与快速原型可以引入 devDependency。

## 7. 对原规划的修订

原 P0–P3 在 bitmap-first 路线下重排：

| 原阶段 | bitmap-first 下的变化 |
|---|---|
| P0 矢量子集 | 仍做，但落到 Pixmap 而非 GPUI path primitive；`clearRect`/clip/composite 顺带成立 |
| P1 正确性/资源 | 不变；measureText 走 fontdb+parley/cosmic-text 同步返回 |
| P2 传输/seam | **大幅缩水**：不再需要 binary display-list 编码，命令通道可以用「napi 方法直调 Rust ctx 对象」（deno_canvas/@napi-rs/canvas 同款形态，napi 调用 ~µs 级）；只剩「脏 pixmap → RenderImage」一个上传点。surface registry 需求不变（离屏 Pixmap 天然支持 `drawImage(canvas)`） |
| P3 bitmap 语义 | **消失**——从第一天就是 bitmap。剩余差距收敛为 filter/shadowBlur/宽域色彩等 vello 生态已知边界 |

新增的性能账（替代原「NAPI 命令数」账）：

- 每脏帧一次整纹理上传：1280×720×4B ≈ 3.7MB，60fps ≈ 220MB/s——PCIe/Metal 均富裕；静态内容零上传（复用 Arc）。
- CPU 光栅吞吐是主变量：vello_cpu SIMD u8 pipeline + 可选 rayon 多线程，uPlot 型 5k 细 stroke/帧属其设计甜区；benchmark 保留「5k cmd × 60fps」档。
- atlas tile 生命周期：每脏帧 `drop_image` 旧 `RenderImage`，否则纹理泄漏。

## 8. 决策建议

1. **主路线改为 bitmap-first**：`vello_cpu 0.2.0` 作为 rasterizer 引入 `packages/native`，ctx 状态机留在 Rust 侧（napi 直调），呈现走 `paint_image`。文本首版用已在树内的 cosmic-text+swash+fontdb（GPUI Linux 同款栈），parley 留作 vello 对齐备选。
2. **tiny-skia 0.12.0 作为降级方案**：若 vello_cpu 0.2.x 的 API 动荡踩坑（尤其 `Resources` 生命周期、filter panic），平替成本是一个 adapter 层——两条 API 形状接近（RenderContext vs Paint+Pixmap），前期隔离好 backend trait 即可互换。
3. 不动的结论：`canvas-host` shim 包（上轮 §3.3）、surface registry 预留（上轮 §3.1）、`canvas-conformance.json` + WPT 选测、rough.js→uPlot→Chart.js 验收阶梯全部照旧。
4. `@napi-rs/canvas` 进 devDependency 做像素 oracle，不进产物依赖（bun --compile Windows 崩溃风险未验证）。
5. 先写 backend trait + vello_cpu 原型跑通 `fillRect/path/text/clearRect/getImageData` 最小闭环，再按上轮 §4 验收表推进。
