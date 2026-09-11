# UI 组件扩展架构

> 状态：原则与目录已确认；React 包 `@jagent/ui` 已落地（首批通用控件已迁移，见 §7）；原生扩展与 Rust 库尚未实施。
> 本文补充 [architecture.md](./architecture.md) §1.2 的 UI 分层规则。核心决定：**补充 GPUIX，不重新实现 GPUIX。**

## 1. 目标与非目标

在 `packages/` 下提供组件包，承载 GPUIX 组件的样式/API 包装，以及项目新增的通用组合组件。只有确实需要新增原生能力时，才引入对应 Rust 实现。

已确认的原则：

- GPUIX 已有能力优先复用，不为建立 Rust 组件库而重写 Select、Tooltip、Input 等现有能力。
- 我们新增的通用 Rust 组件应能被纯 Rust GPUI 应用复用，因此其核心不依赖 GPUIX 或 napi。
- **不要求 React 组件库与 Rust 组件库一一对应**：React 包装和组合组件不必拥有 Rust 对等实现。
- 领域能力不因具有视图就归入通用 UI；终端的 PTY、Model、Pool 继续属于终端领域模块。
- 不预建空 Rust 库、通用插件框架或第二套原生运行时。

非目标：重造完整 UI 框架、替换 GPUIX reconciler、让所有基础控件下沉 Rust、保证跨任意 GPUI fork/版本兼容。

## 2. 新组件的归属判断

按以下顺序判断，不从实现语言出发：

| 情况 | 处理方式 | 建议归属 |
|---|---|---|
| GPUIX 已有能力，仅需统一样式或 API | React 薄封装 | `packages/ui` |
| 现有 GPUIX 元素可组合实现 | React 自定义组件 | `packages/ui` |
| 缺少必要原生能力，或组合方案存在已验证的限制 | Rust 实现 + GPUIX 适配 + React API | Rust 扩展库、宿主适配层、`packages/ui` |
| GPUIX 本身的 bug 或通用底层缺陷 | 优先上游修复；本地走现有 patches/MANIFEST/export-patches 流程 | GPUIX 补丁体系 |
| 依赖 settings/thread/router 或包含应用特定语义 | 保留业务组合层 | `packages/app` |

性能下沉必须有测量依据；不能仅凭“Rust 更快”重写现有组件。新增原生能力前应记录现有 GPUIX 方案为什么不够，以及修上游与独立扩展的取舍。

## 3. 建议目录与依赖方向

```text
packages/
  ui/                      # 拟建 @jagent/ui：React 包装、组合、原生组件的 React API
  native/
    src/elements/          # 建议组织方式：GPUIX 适配与注册；当前终端适配在 element.rs
  app/                     # 业务组合、设置、路由、会话
crates/
  jagent-ui/               # 首个实际通用原生扩展出现时再建，纯 GPUI library
  jagent-terminal/         # 现有终端领域模块，保持独立
```

初期适配层作为 `packages/native` 内的模块，不急于拆出独立适配 crate。若将来有第二个 GPUIX 宿主需要复用适配，再评估拆包。

依赖约束：

- `jagent-ui` → 同源兼容的 GPUI 与必要 Rust 基础库；不得依赖 `gpuix-native`、napi、React 协议或应用设置。
- GPUIX 适配层 → GPUIX + Rust 组件；负责 props 同步、事件桥接、视图绑定和清理，不承担业务编排。
- `@jagent/ui` → React + GPUIX；不得反向引用 app 内部模块或直接创建业务会话。
- app → 组件公共 API；负责 settings/thread/router 与组件之间的装配。

纯 Rust 应用直接使用 Rust 核心；React 应用经 GPUIX 适配使用原生扩展。这里只保证新增 Rust 能力可独立使用，不承诺整个 React 组件集合都可用于 Rust。

包边界本身不会自动禁止相对路径越界；实施时应配合公共 exports、类型检查与依赖检查落实约束。

## 4. 原生宿主与生命周期

继续使用唯一 `@jagent/native` 原生宿主。`packages/gpuix-native-alias/index.js` 将 `@gpuix/native` 指向该宿主，使 renderer、注册表、终端池共享同一二进制中的状态。

- 新增 Rust library 可以由宿主链接，不能另建一个包含独立 GPUIX 状态的 `.node` 来承载组件。
- 注册与初始化由宿主显式执行；导入 React 组件包不应暗中注册原生元素、创建窗口或启动业务资源。
- 组件视图生命周期与外部资源生命周期分别定义。现有终端必须保留“卸载视图不销毁会话；显式关闭才销毁会话”的语义。
- 纯 Rust 复用仍要求兼容且来源一致的 GPUI。当前项目使用 GPUIX pin 的 Zed fork，不应仅以版本号相同判断兼容性。

## 5. React 包的迁移边界

不能将现有 `packages/app/src/ui` 整体搬迁视为既定方案。先按语义分类：

- Select、Tooltip 等包装，以及通用输入、按钮、徽章等，是优先评估的迁移候选。
- `SettingRow` 依赖应用 `SettingDef`；可保留业务适配，仅提取通用表单行，不把设置 schema 搬入组件库。
- `PhaseBadge` 虽无业务 import，但包含项目路线图语义；`PerfHud` 包含终端性能指标。两者不因依赖少就自动进入通用库。
- tokens 混有通用视觉值、侧栏布局值和 Git lane 色板；需分类，不能一并认定为通用主题。
- `inputFocus` 涉及组件与应用键位层共享状态；迁移时必须确认唯一实例及作用域，不复制单例。
- 组件单测可随组件迁移；依赖 TitleBar、settings 等的集成测试保留在应用层或拆分。

主题初期复用现有设计规范，不立即建立跨语言主题生成系统。出现新增 Rust 组件时，再明确主题值如何传入，避免 Rust 与 TS 各自维护漂移的视觉常量。

## 6. 已发现的限制与实施前验证

以下来自当前源码检查，不代表已修复或已通过运行验证：

1. **注册作用域**：GPUIX `custom_elements/mod.rs` 中全局 factory 表在 `with_defaults()` 使用 `drain(..)`。一次注册不能据此保证后续多个 renderer 自动获得相同 factory；多窗口及多 renderer 测试需明确注册方案。
2. **事件契约**：`TerminalSurface.tsx` 声明 `onFocus/onBlur`，但 `packages/native/src/element.rs` 仍标记发送事件为 TODO。类型声明不等于运行时支持。
3. **跨包实例**：已验证（首批迁移后）——`packages/ui` 与 `packages/app` 的 `react` / `@gpuix/react` symlink realpath 完全一致（bun `.bun` store 同一实体）；注意 workspace 消费方必须显式声明 `"@jagent/ui": "workspace:*"` 才会得到 symlink（e2e 曾因此解析失败）。
4. **类型入口**：新增原生元素的 JSX augmentation 与公开 props 应由相应 API 所有者提供，不能依赖 app 偶然包含某个声明文件；新包需验证 `jsxImportSource`、类型入口和消费者检查。
5. **构建顺序**：新包若引用 `.refs` 中的 GPUIX，仍要求 `setup-refs` 先于 `bun install`；需验证 workspace、CI 与原生构建，而非假定无影响。

首个原生扩展必须覆盖：props 更新和移除、事件实际到达、挂载/卸载/重绑、焦点、主题传递、资源所有权；若声明支持多 renderer，还要覆盖注册作用域。

## 7. 实施进度

1. [x] 现有 UI 通用/业务分类完成：控件层（Badge/Icon/IconButton/Modal/NumberInput/Popover/RangeInput/Select/Textarea/TextInput/Toast/Toggle/Tooltip + tokens(COLORS/FONT)/style/keyboard/platform）迁 `@jagent/ui`；SettingRow/PhaseBadge/PerfHud + SIZES/GRAPH_LANE_COLORS 留 app（业务/布局域）。
2. [x] React 包已建立并全量验证：bun workspace 接线、typecheck、fmt/lint、根 bun test 349 全绿（与基线一致）、e2e 17 全绿、export-patches --check 通过、跨包单实例确认。**ui 包约定（2026-09-12 拍板）**：测试统一放 `src/__tests__/`；源码分类目——`controls/`（值输入与操作控件）、`overlays/`（浮层与反馈）、`display/`（展示原子）、`theme/`（tokens 与共享样式片段），根下只留跨控件 util（keyboard/platform）与出口；app 测试位置暂不变。
3. [ ] 出现具体原生缺口后，先验证 GPUIX 现有能力不足，再建立 Rust 核心及适配；不预建空库。
4. [ ] 首个新增 Rust 组件同时验证纯 GPUI 消费和 React→GPUIX 适配消费，形成契约测试。

后续新组件直接落 `packages/ui`；app 内 `src/ui/` 只剰业务组件（SettingRow/PhaseBadge/PerfHud），不再新增通用控件。

本文只沉淀架构决策，不新增依赖、不修改 `.refs`、不表示包迁移或原生扩展已经完成。
