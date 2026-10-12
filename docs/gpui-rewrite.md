# j-agent 重构方案：纯 Rust gpui（方案 A）

> 状态：**P0–P8 全部完成（2026-10-12 收官）**。本文转为历史记录；当前架构的
> 权威描述是 `docs/architecture.md`，待办看板在 `TODOLIST.md`。
> （P0 结果见 `docs/p0-results.md`。）
> 依赖版本已于 2026-10-10 经 crates.io 核实（`docs/p0-results.md` §0）。

## 1. 目标与非目标

**目标**

- 去掉 GPUIX、React、bun、napi，变成单一 Rust gpui 二进制，`cargo build` 一条构建路径。
- UI 层按 gpui 范式重写（`Entity` / `Render` / `Action` / `FocusHandle`），不做 TSX 的 1:1 翻译。
- 复用 gpui-component 提供的控件、布局、主题、弹层，减少自建组件。
- 保留产品行为：会话管理（terminal / chat / acp）、工作区、Git 图、设置、通知、崩溃报告。

**非目标**

- 不追像素级还原 `design/prototype-react`。保留信息架构、One Dark token 与设计意图；
  尺寸、圆角、阴影跟 gpui-component 体系走，用主题覆盖。`scripts/cmp` 像素对比不再作验收门槛。
- 不做亮色主题（本期只有暗色）。
- 不保留 Canvas 2D 子系统。
- 不在过渡期同时维护两套构建链。

## 2. 已定决策

| # | 决策 | 来源 |
|---|---|---|
| D1 | 纯 Rust gpui 单二进制，删除 React / bun / napi / gpuix | 用户指令：不使用 gpuix |
| D2 | gpui 版本方案 **A**：`gpui-component 0.7.1` + `gpui-pre =0.3.8`（zed@279fe07 快照），2026-10-10 已核实，见 `docs/p0-results.md` §0 | 用户选定 |
| D3 | 按 gpui 范式重构组件，不 1:1 移植 | 用户指令 |
| D4 | 亮色主题本期不做 | 用户指令 |
| D5 | Canvas 2D（Rust 3334 行 + TS 1694 行 + `vello_cpu`/`cosmic-text`/`image`）整体删除 | 与产品 UI 零耦合，见 §7 |
| D6 | 新建应用 crate，`jagent-terminal` 原样迁入 | 无 JS 桥，过渡期共存无意义 |

**默认值（不阻塞 P0，P0 后复核）**

| # | 议题 | 默认 | 复核时机 |
|---|---|---|---|
| X1 | 嵌套滚动 | **已由 P0 E8 定为方案 b**：上游是"同时滚动"（不可接受）；应用层封装 `on_scroll_wheel` + `stop_propagation`（内层能滚就吃掉事件）已验证有效，不需要补丁；是否复刻旧"到边界不交接"语义、以及内层为 `list` 时是否有效，P3 补测。见 `docs/p0-results.md` E8 | P3 |
| X2 | 渲染 panic 容错 | 不做视图级隔离；panic → 崩溃 sidecar 记录 → watchdog 重启 | P1 |

**待定**

| # | 议题 | 选项 | 最迟决定 |
|---|---|---|---|
| Q1 | chat / ACP 定位 | 原样 Rust 化 / 顺带升级流式 + 权限 UI / 先砍掉只做终端会话管理器 | P4 开始前 |
| Q2 | AGENTS.md 对 gpui 系列依赖的例外 | **已定**：用户同意，已写入 AGENTS.md 规则 5（措辞见 §6.1） | — |

## 3. 范式映射

| 旧（React 范式） | 新（gpui 范式） |
|---|---|
| zustand + immer 的 `ThreadStore` / `SettingsStore` / `GitGraphStore` | `Entity<T>`；直接改字段后 `cx.notify()`；对外 `EventEmitter`；视图 `cx.subscribe` / `cx.observe` |
| 带 hooks 的组件 | `struct` + `impl Render`，由 `Entity` 持有；`useState` 变视图字段 |
| 纯展示组件 | `#[derive(IntoElement)]` + `RenderOnce` |
| TanStack Router（memory） | `ActiveTarget` 枚举字段，放在 ThreadStore |
| 八层键位链、`keyConsumed`、`inputFocus`、`overlayEsc` | `actions!()` + `KeyBinding` + `key_context` + `FocusHandle`；用户重绑时由 settings 重新生成绑定 |
| `DialogHost` + 模块态开关 | gpui-component Root 层（`open_dialog` / `Sheet` / `Notification`） |
| `virtual-list` | 定高行 `uniform_list`；变高内容（对话流、含展开卡片的 Git 图）`list` + `ListState` |
| hover / focus 用 `useState` 模拟 | `.hover()` / `.focus_visible()` / `.active()` |
| `getElementBounds` 轮询 | prepaint / `canvas` 回调取 bounds |
| Promise + `node:child_process` | `cx.spawn` + `background_executor`，结果回写 Entity |
| 三层 `ErrorBoundary` | `Result` + 错误总线 Entity；渲染 panic 见 X2 |
| 模块级单例 | `Global`（`TerminalPool` 已是此模式） |
| bun test + `TestGpuixRenderer` | 纯逻辑 `#[test]`；视图 `#[gpui::test]` + `TestAppContext` |

## 4. 目标工程结构（提案，P1 确认）

```
crates/
  jagent-terminal/   现有，原样迁入（gpui + alacritty_terminal）
  jagent-core/       不依赖 gpui 的纯逻辑：settings schema 与持久化、workspace/state.json、
                     git cli + lane 算法、ACP 客户端、错误码；普通 #[test] 即可覆盖
  jagent-app/        二进制：Entity、视图、Action、主题、窗口、打包入口
```

拆 `jagent-core` 的理由：业务内核（约 5k 行）全是纯逻辑，脱离 gpui 后测试快、编译快；
视图相关状态（ThreadStore 的 Entity 外壳等）留在 `jagent-app`。若 P1 发现拆分收益不足，合并回单 crate。

## 5. 模块迁移映射

规模取自 2026-10 的调研（TS 非测试 ≈2.2 万行；Rust 估算为区间，P0 后重新基线）。

| 旧模块 | 新位置 | 阶段 | 说明 |
|---|---|---|---|
| `crates/jagent-terminal` | 同名 crate | P1 | 仅调整 gpui 依赖写法与 API 差异 |
| `threads/store.ts` + `internal/*`（≈1.2k） | `jagent-app`（Entity）+ `jagent-core`（规则） | P2 | 规则表见 architecture.md §3.3，store.test.ts（1191 行）逐条翻译 |
| `settings/schema.ts` `store.ts` `file.ts`（≈0.7k） | `jagent-core` | P2 | 字段级容错、保留未知 key、原子写；`settings.json` / `state.json` 格式保持兼容 |
| `keybindings.ts` + `ui/keyboard.ts` | Action + KeyContext | P3 | 不迁移实现，只迁移键位表与语义 |
| `sidebar/*` `plane/*` `dialogs/*` | `jagent-app` 视图 | P3 | 优先用 gpui-component 的 sidebar / dialog / popover / menu / tab |
| `surfaces/ConversationView` `EmptyPresets` `FileSurface` | `jagent-app` 视图 | P4 | 变高 `list` + follow-tail；markdown 用 TextView |
| `threads/acp.ts`（335） | `jagent-core` | P4 | 取决于 Q1；是否用现成 ACP crate 需联网核实 |
| `git/cli.ts` `graph.ts` `store.ts` `worktree.ts` | `jagent-core` + Entity | P5 | lane 算法源自 Zed Rust，可对照 Zed 实现 |
| `GitGraphView` `WorkPanel` | `jagent-app` 视图 | P5 | `native/elements/git_graph.rs` 的几何常量与列宽规格可复用 |
| `settings/ui/*`（≈2.6k） | `jagent-app` 视图 | P6 | 评估 gpui-component 的 `setting` 模块 |
| `errors/*` | 错误总线 + `native/{crash,panic}.rs` | P1 / P7 | crash / panic / notify 原样搬 |
| `packages/ui/*`（2.5k） | gpui-component / gpui-base + 主题映射 | P1 | 只留 token 映射与薄包装；33 个图标转 `.svg` 资源，需逐个核对 gpui-component 自带图标覆盖。**控件取舍（P0 实测）**：对话流、Git 图用 gpui 自带 `list` / `uniform_list`，不用 gpui-component 的 VirtualList；输入用 gpui-base 的 `Textarea`（无样式，需自加边框/聚焦环）；markdown 用 `TextView`；`Resizable`、`TitleBar` 从 gpui-component 取 |

## 6. 依赖与版本治理

### 6.1 AGENTS.md 例外（Q2，已写入 AGENTS.md 规则 5）

AGENTS.md 禁止 pre-release 并要求联网核实版本。方案 A 的 `gpui-pre` 是第三方重新打包的
Zed gpui 快照，包名带 `pre`，且 gpui 本体 0.x 无稳定承诺。建议在 AGENTS.md 增补：

> gpui 系列依赖（`gpui-pre*`、`gpui-component` / `gpui-kit`）因生态现状只能使用精确锁定的
> 快照版本（`=x.y.z`），不受规则 1 的"正式 release"限制；仍须满足规则 2、3，且升级须整体进行。



### 6.2 约束

- 同一工程只能有一份 gpui。`gpui-pre` 与 remorses/zed fork 不可共存（同名 crate 类型不兼容）。
  迁移完成后 `.refs/` 中的 gpuix 与 zed fork 不再被依赖。
- 本地与 CI 均精确 pin Rust 1.97.1（`rust-toolchain.toml` + `dtolnay/rust-toolchain@1.97.1`）；这是 P0 实测可构建 gpui-pre 0.3.8 的版本，低版本仍未验证。
- `Cargo.lock` 将首次真正记录 gpui 版本（此前为 path 依赖，不记录 rev）。

## 7. 资产处置台账

> **P8 执行注记（2026-10-12）**：§7.3 清单已全部执行；§7.2 的过渡期规格（旧 TS 源码、
> architecture 旧 §3、settings-ui/git-graph/agent-plane-layout/error-management、
> nested-scroll-research、perf-analysis、ui-detail-audit、todo-archive）一并删除，
> 需要时从 git 历史 `aadecd4` 取。`docs/p0-*.md` 与本文作为重构历史记录保留。

### 7.1 本次已删除（均为 git 跟踪文件，可从历史恢复）

| 文件 | 理由 |
|---|---|
| `docs/canvas-2d-standard-research.md` `canvas-conformance.json` `canvas-rust-raster-research.md` `canvas-web-lib-compat.md` | D5：Canvas 2D 整体删除；全仓无业务代码消费 `<Canvas>`，仅 `main.tsx` 安装与自身测试 |
| `docs/gpuix-zed-terminal-fusion.md` | GPUIX 融合调研，前提已不存在 |
| `docs/ui-extensions.md` | 讨论如何扩展 GPUIX，前提已不存在 |
| `docs/desktop-plane-v2-gap-analysis.md` | 旧灰阶 V2 差异清单，与现行 One Dark 配色已脱节，全仓无引用 |
| `docs/prototype-react-diff.md` `prototype-visual-diff.md` `prototype-walkthrough-report.md` | React 原型像素对比报告；D3 后不再作验收门槛 |

删除后以下文件仍引用上述文档，属于已知悬空引用，随 P8 重写 README / TODOLIST / architecture 一并处理，
不在此处零碎修补：`README.md`、`TODOLIST.md`、`docs/architecture.md`、`docs/agent-plane-layout.md`、
`docs/settings-ui.md`、`docs/todo-archive.md`、`docs/ui-detail-audit.md`、`design/agent-plane-layout.html`、
`scripts/cmp/*`、`packages/app/src/canvas/*`。

### 7.2 保留，作为迁移期规格 / 参照

| 资产 | 用途 | 清理时机 |
|---|---|---|
| `packages/app` `packages/ui` 的 TS 源码与 499 个测试 | 业务规则规格；P2 起把测试逐条翻译成 Rust | P8 |
| `docs/architecture.md`（含未提交改动）§3 | ThreadStore 规则表，P2 的直接输入 | P8 重写 |
| `docs/settings-ui.md` `git-graph.md` `agent-plane-layout.md` | P3–P6 的产品行为规格 | 各阶段完成后改写 |
| `docs/error-management.md` | 错误管理方案 A–D，其中 B、C、D 仍适用 | P1 / P7 改写 |
| `docs/nested-scroll-research.md` + `patches/gpuix-zed/0003` | X1 失败时的备选方案 | X1 复核后 |
| `docs/perf-analysis.md` | §6.3 终端 paint 全量重绘的结论与新实现相关；其余 React 相关部分作废 | P1 后精简 |
| `docs/ui-detail-audit.md`（**未跟踪**） | UX 缺陷清单（tooltip 缺失、hover 规范、Esc 嵌套连坐等）作为新实现的需求输入 | P3 后 |
| `docs/todo-archive.md`（**未跟踪**） | 历史记录 | P8 |
| `native/{crash,panic,notify}.rs`、`elements/git_graph.rs` | 直接复用或参考 | P1 / P5 |

### 7.3 P8 统一删除

`packages/{app,ui,native,gpuix-native-alias}`、`e2e/`、`patches/`、`scripts/` 中的 bun / PE / refs /
napi / cmp 脚本、`.refs/`、`canvas` 全套、`bun.lock`、`package.json`，以及 `design/` 下的 React 原型
（153M，含依赖）。`design/DESIGN.md` 与 `PRODUCT.md` 保留并改写为新实现的设计说明。

> 未提交的 TS 改动（SearchDialog、ToolDialog、Sidebar、ThreadRow 等 17 个文件）属于旧 UI 打磨，
> 随 P8 一并被删除；若其中有想先落入新实现的需求，请在 P3 前提出。

## 8. 阶段计划

| 阶段 | 内容 | 出口 |
|---|---|---|
| **P0** ✅ | spike，见 `docs/p0-spike.md`、结果 `docs/p0-results.md` | 已完成：方案 A 可编译可渲染；E1–E9 有结论；未验证项见 p0-results §2.3 |
| P1 | 新建 workspace 骨架；迁入 `jagent-terminal`（P0 证实零改动）；**提炼视觉测试辅助**（`harness=false`、`Window::draw`、截图；见 p0-results E9）；自绘标题栏三平台真窗口手测；pin toolchain（本机 1.97.1 可编译，更低版本未验）；错误总线与 crash/panic；删除 `spikes/p0/` | 单会话终端窗口可用；macOS 视觉测试可在用户终端/CI 运行；三平台编译通过 |
| P2 | `jagent-core`：settings / state / workspace / ThreadStore 规则；翻译 TS 测试 | 翻译后的测试全绿；配置文件与旧版互读兼容 |
| P3 | 外壳：侧栏、会话 tab、窄屏抽屉、Action 化键位、对话框、Toast；**嵌套滚动封装**（X1，补测 `list` 内层、惯性、是否复刻"不交接"）；分隔条真窗口手测 | 对照 architecture.md §3.3 规则表通过；嵌套滚动封装在 `list` 内层有效 |
| P4 | 会话面：空态、对话流、composer、markdown、ACP（受 Q1 约束）。**开始前硬性前置：三平台真机中文输入法手测**（候选窗、Windows 字符重复、X11 Fcitx、Enter 提交后是否多出换行） | 流式追加不抖动，滚到底可靠；流式 markdown 增量解析成本可接受；输入法三平台通过 |
| P5 | Git：数据层、图视图（普通元素树，不做 canvas 自绘；展开卡片并入 `list` 条目）、WorkPanel、diff | 1 万提交真窗口（含 GPU）滚动无掉帧（E7 的 0.5 ms 不含 GPU） |
| P6 | 设置页 | 与 settings-ui.md 对照 |
| P7 | 发布：CI 三平台、macOS `.app` 与签名、Windows 子系统与图标、崩溃 sidecar 与 watchdog 集成测试 | 三平台产物可启动 |
| P8 | 清理 §7.3，重写 README / TODOLIST / architecture | 仓库只剩 Rust 工作区 |

工作量：此前按 1:1 翻译估算新写 Rust 19k–25k 行（不含终端栈与测试）。P0 之后**不给新总数**——
E3–E8 每项只验证了一条代表性路径，现在给数字只是换一种方式的猜测。已确认缩小的项与仍未知的项见
`docs/p0-results.md` §2.5。

## 9. 风险与未核实项

**已知缺口（gpui 无现成方案，须靠 gpui-component 或自建）**

| 缺口 | 风险 |
|---|---|
| 多行输入 + IME | gpui-component `Input` 的 IME / auto-grow / Enter 提交绑定需实测 |
| 普通文本跨元素选区与复制 | gpui 无原生支持；先确认哪些文本必须可选（消息正文、commit 消息、diff） |
| markdown 样式 | TextView 对齐原有排版（正文 14px / 1.65 行高等）需大量调样式 |
| 变高虚拟列表 follow-tail | 据搜索摘要 gpui-component `VirtualList.scroll_to_bottom` 有 bug，需实测或改用 gpui `list` |
| 列表 / 表格滚动性能 | 据搜索摘要有严重卡顿报告，需在 Git 图规模下实测 |
| 中文 IME | 摘要称 Windows 字符重复、Linux X11 Fcitx 出错后永久失效，须三平台手测 |

**未核实（均来自搜索摘要，P0 步骤 0 回填）**

- 已核实（2026-10-10，crates.io）：`gpui-pre 0.3.8`（zed@279fe07，Apache-2.0，owner 仅 `huacnlee`）；
  `gpui-component 0.7.1` 依赖 `gpui-pre =0.3.8`；官方 `gpui` 停在 0.2.2（2025-10-22）。
  **供应链为单点**：全部 gpui 系列快照由同一账号发布，且 crate 元数据均未声明 MSRV。
- MSRV：元数据为空，E1 编译时确定。
- `agent-client-protocol 3.3.0`（2026-10-09）存在，对 gpui 的耦合与 API 覆盖未核实（Q1 之后再查）。
- 所有 issue 编号、star 数。
- AccessKit 在所选版本是否默认启用、是否影响性能。
- 上游 gpui 是否已修复嵌套滚动（`zed#63786` 据补丁注释为关闭未合并）。

**仓库内待订正的事实**

- `crates/jagent-terminal/Cargo.toml` 与根 `README.md:70` 写的 rev `8b94def` 是 Phase 0 遗留的过时注释；
  实际 pin 为 gpuix `7ac9880` + zed `81c99f81`（与 `patches/README.md` 一致）。随 P1 迁移自然消失。

**P0 新发现（已落入 p0-results）**

- 应用须直接依赖 `gpui-base =0.7.1`，与 `gpui-component` 同版本锁定；有两个 `Theme`（`gpui_component::Theme` 与 `gpui_base::Theme`），`TextViewStyle::from_theme` 要后者。
- 视觉测试在 Bash 沙箱内会 SIGTRAP，必须在用户终端或 CI 运行；`Window::draw` 才会真实重绘；`simulate_keystrokes("enter")` 有驱动器假象，测 Enter 用 `dispatch_action`。
- 传递依赖 `block v0.1.6` 有 future-incompat 告警；MSRV 未声明。

## 10. 进度（2026-10-11）

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 spike | ✅ | `docs/p0-results.md` |
| P1 骨架 | ✅ | 根 workspace 重建为 `crates/*`；`jagent-terminal` 迁到 `gpui-pre`（源码仅改 Cargo.toml 与 1 行注释）；本地与 CI 固定 Rust 1.97.1（P0 已验证；本机已有 stable 版本号相同）。`j-agent` 可构建、开窗、起终端。
| P2 纯逻辑 | ✅ | `jagent-core`：settings（schema/store/file）、presets、threads（model/store/workspaces）、acp 协议层、git（types/parse/graph/store/cli/format/actions）。**270 个测试**，包含纯规则 `#[test]` 与 GPUI 状态覆盖；关键规则做过变异检查 |
| P3 外壳 | ✅ | 在先前实现上补齐缺陷：CycleNext/Prev 会关闭 Settings 并调用 core `cycle()`；SearchThreads Action 打开标题搜索弹窗；`/` 将焦点送入 Settings 搜索框；Workspace 头可折叠，截断提示和 show-all 展开/收起可点击并落盘；空态页提供新建会话按钮；WorkPanel handle-backed 内层滚动及虚拟 `gpui::list` 的 child wheel 测试覆盖；`nested_scroll` harness=false GPUI 真实 wheel 测试验证 List 行吃事件、边界允许 parent 处理。另有侧栏分组状态 GPUI 测试；全 app 当前 75 项通过（含 ACP cancel、真实 git 刷新、会话移除通知等回归；另有 harness=false GPUI 视觉测试）。（含 `#[gpui::test]`：行菜单写 store、拖宽落盘、重命名提交、添加工作区先校验后落盘、Shell 视图 PTY 创建销毁、宽度阈值）；`cargo test -p jagent-core` 270 通过；`shell_shot` 屏幕外截图 `SHELL OK`。**偏差**：①行菜单移除项无危险红字（gpui-component 0.7.1 的 `PopupMenuItem` 无 danger 样式）；②副页签「+」直接新建 Shell，不再弹「打开 Git 图 / 新建 Shell」浮层；③副页签中键关闭未做；④添加工作区的「浏览…」原生目录选择未接，留 P7；⑤窄屏抽屉仅覆盖侧栏，未做滑入动画。**未验证（真机）**：三平台中文输入法、窄屏真窗口手感、拖宽的真实鼠标拖动（当前只测落盘路径）。 |
| P4 会话面 | ✅（真机输入法除外） | `views/conversation.rs`：变高 `gpui::list` + 原生 `FollowMode::Tail`；新增 per-row 滚轮冒泡监听，向上滚时 `pause_following_tail()`，向下回到底部恢复 Tail；消息变化通过局部 `splice` / `remeasure_items` 更新，保持 scroll anchor。composer 使用 `TextareaState::auto_grow(1,6).submit_on_enter(true)`；assistant/error 行 Markdown，用户消息纯文本；空态显示 preset 卡片。ACP 使用 stdio，支持握手期间和 prompt 期间取消：预先注册的 `AcpCancellation` 处理 spawn/close 竞态，关闭时 kill/wait 后后台 read 解除阻塞。测试含 ACP blocked-initialize→cancel→connect 返回错误并 child reaped（0.26 秒独立进程测试）、close-before-register 竞态、prompt 期间 dispose。core 全绿 270；app 单元测试 75，集成 sidecar 1、watchdog 2，另有 harness=false nested_scroll、shell_shot、terminal_settings。**未验证（真机）**：三平台中文输入法、Windows/Linux ACP IO；官方 agent 和流式大文档性能。 |
| P5 Git 视图 | ✅（1 万提交帧耗时除外） | `views/git_graph.rs`：可变高 `gpui::list`（commit 行 + 同列表内联详情）、普通 GPUI 元素树（明确不使用 canvas）、共享 `git::geometry` 的行高 / lane 宽 / 列宽、ref 标签、选中/查找淡化、搜索、分支 chip、上下键/按钮导航、刷新/清除、GitGraph KeyContext；选中提交异步加载 body + numstat + unified patch，搜索命中间循环移动。`views/work_panel.rs`：真实 git status/numstat、变更/文件 tab、文件选择、tracked 文件 unified diff、添加/删除/hunk 行分类、刷新、非 repo/加载/干净状态。测试：图视图 geometry/展开 Entry、WorkPanel 真实 repo status→diff/切换文件时清除旧 diff、commit body/files/patch 请求代际、同路径 ABA stale patch 等；Git 图显式刷新即使 cwd 相同也重新跑 git log，真实仓库新增提交后刷新可见；最终全 workspace check/build/test 通过（app 75 unit + sidecar 1 + watchdog 2、core 270、terminal 41；harness=false 测试输出 `NESTED_SCROLL OK`、`SHELL OK`、`TERMINAL_SETTINGS OK`）。**明确不做 / 偏差**：①真实 lane 三次贝塞尔弯线未画（只画普通元素竖线/节点，避免 canvas；几何计算仍由 core `line_strokes` 提供）；②commit/ref 右键操作菜单及危险操作确认未迁（core argv 规则保留）；③分支目前只显示 chip，不做下拉/checkout；④WorkPanel 不做未跟踪文件内容预览、拖宽/overlay；⑤1 万提交真窗口滚动帧耗时尚未测，登记为未验证，按目标不阻塞。 |
| P6 设置页 | ✅（明确偏差见证据） | `views/settings.rs`：7 分区 nav + schema 路径搜索（分区与字段行过滤）、即时写回与单项 reset、modified 蓝点；TerminalStyle 每次 flush 应用到池内活跃终端，字号/闪烁/字体可在线生效；Preset 内置重置时同步所有已缓存字段编辑器；args 与 ACP argv 使用逐行 Textarea，参数含空格不拆分；Advanced GPU backend 选择、perf HUD/frameOverlay 开关、settings.json 序列化实时快照、写失败错误提示。入口为 `Ctrl-,` 与侧栏齿轮；设置不创建 thread，设置时保留 Sidebar；Esc 关闭，切 thread 关闭设置；设置表面不显示会话 tab。证据：settings 覆盖 7 分区、搜索、patch/reset 写盘、旧 `settings.json` 未知字段往返保真、preset 写盘失败回滚后编辑值一致；最终全 workspace check/build/test 通过（app 75 unit + sidecar 1 + watchdog 2、core 270、terminal 41；terminal_settings 输出 `TERMINAL_SETTINGS OK`），含 settings 写盘失败后 preset store rollback 和 editor-value 恢复测试。**偏差**：①打开时未自动聚焦搜索（GPUI InputState::focus 需要其自身 Context，构造器只有 SettingsView Context）；②焦点环/aria 与 reset 固定槽未逐行符合原型；③字体输入为自由文本而非系统字体选择；④搜索没有 label mark 高亮/命中计数，预设/ACP 空态有过滤但搜索分区 nav 无计数；⑤ACP args 与预设 args/env 使用逐行 Textarea（每行一个 argv / KEY=VALUE），含空格 argv 往返有测试；⑥配置文件“在编辑器打开”未接；GPU backend 是构建时选择，设置页仅保存偏好并明确标记为不切换运行中 GPU；⑦高级 perf HUD/frameOverlay 设置写盘，绘制集成待后续/平台侧。**未验证（真机）**：中文 IME 输入搜索/字体字段，详见 P4 未验证清单。 |
| P7 发布 | ✅（Developer ID 公证与三端真实启动除外） | 新增 `.github/workflows/rust-release.yml`（macOS/Linux/Windows 独立 Rust 构建/全 workspace tests/release artifact；签名 secrets 未提供，按用户选择只 ad-hoc）、macOS `scripts/package-macos-app.sh`、Windows `winresource` `build.rs` 图标/版本资源与 PE RT_GROUP_ICON #1 校验脚本；`j-agent --version` / `--crash-sidecar` / `--watchdog` 发布入口；panic hook 把结构化报告交给 sidecar，sidecar READY 握手、落盘 fsync ACK、64 条保留；watchdog 60 秒 5 次 crash-loop 截止；普通启动默认进入 watchdog，内部 `--app-child` 才绕过；app 子进程正常退出时显式 kill/wait 回收 sidecar。集成测试：sidecar panic→JSON 持久化、真实 watchdog 子进程重启/截止。验证（先前 Rust 1.97.1 成功结果，当前复跑说明见任务记录）：发布入口默认 watchdog，release smoke 覆盖 fail-loop 与 child 正常退出；macOS `.app` 由本机 Release binary 打包，`plutil -lint`、`codesign --verify --deep --strict` 成功；`j-agent --version` 输出 0.1.0；shell_shot `SHELL OK`。**明确未验证**：CI 远程 workflow 未实际运行；Windows/Linux 交叉编译与真机启动、Windows PE 图标校验脚本（仅 Windows runner 能跑）；正式 Developer ID 签名/公证（用户选择继续 ad-hoc）；macOS Finder 启动、三端产物真实启动。**边界/偏差**：sidecar 仅 Rust panic JSON 元数据，不捕获 SIGSEGV/abort/OOM，也不产 minidump/崩溃 UI；`j-agent` 默认即由 watchdog 启动，`--watchdog` 为显式等价入口、内部 `--app-child` 绕过。CI 远端矩阵仍未实际运行。 |
| P8 清理 | ✅（2026-10-12） | 先以 `044bd9f` 提交 P0–P7 全量成果（含旧 TS 链与 `.scratch` 备份）作安全点，再删除 `packages/`、`e2e/`、`patches/`、scripts/ 的 bun/PE/refs 脚本（留 `package-macos-app.sh` + `check-windows-icon.ps1`）、`package.json`/`bun.lock`、旧 CI `build.yml`、design/ 原型（留 `DESIGN.md`/`PRODUCT.md`）、八个旧契约文档（settings-ui / git-graph / agent-plane-layout / error-management / nested-scroll-research / perf-analysis / todo-archive / ui-detail-audit）、oxlint/oxfmt 配置、gpuix-usage skill；本地清 `.refs/`（299M）/`node_modules`/`dist`/`.shots`/`spikes`。重写 README / TODOLIST / `docs/architecture.md` / CONTEXT.md 为 Rust 工作区语境。`cargo check/build/test --workspace` 全绿。旧 React 版与全部行为规格在 git 历史 `aadecd4` 可查 |

### 10.1 视图层的真实体量（用于判断剩余工作）

| 旧 TSX 视图 | 行数 | 新 gpui 视图 |
|---|---|---|
| sidebar | 1,876 | 分组/行/截断/右键菜单/rename/拖宽/工作区表单/窄屏抽屉已做；工作区折叠与 show-all/fewer 可点击，真机拖动手感未验 |
| plane（AgentPlane / TitleBar / SessionTabs / Pane） | 1,603 | 标题栏、session tab、Settings 表面与主布局已做；窗口/真机差异见各阶段偏差 |
| dialogs | 1,449 | 新建会话、重命名、添加工作区、Git 图视图已迁；原生文件选择器和破坏性 Git 操作确认本期不做（当前没有稳定原生选择器 seam，Git 危险操作缺独立安全确认流程） |
| surfaces（对话 / 空态 / 文件） | 1,275 | chat/ACP 对话、空态、终端已做；FileSurface 本期不做，留待后续阶段确定文件浏览/编辑产品合同 |
| settings/ui | 2,597 | `views/settings.rs` 1,900+ 行，七分区字段编辑、ACP/preset CRUD、搜索与 reset 已接；focus/accessibility/preview 偏差见 P6。旧 TSX 与 Rust 新视图行数口径不同，不再计算新视图总行数比例。
| git/components | 2,016 | Git 图 + WorkPanel + commit/worktree diff 已实现；曲线、右键 git 操作、文件 preview、面板拖宽明确不做 |
| diagnostics / errors | 332 | settings 写错误有行内提示；独立全局 diagnostics/errors surface 本期不做，仅保留 sidecar/watchdog 日志和局部错误（缺少独立产品状态/交互合同） |
| **合计** | **11,148** | **不作总行数比例对比** |

P3–P7 已各有对应实现、未验证项或明确不做决定（详见各阶段证据）；P8 清理仍刻意不做。旧视图总行数不可再用单一百分比概括，因为新实现按 gpui 原生组件和纯 Rust 状态边界重组，且已明确记录未迁项目。

### 10.2 验收修复与遗留

本轮修复后的当前工作树证据：`RUSTUP_TOOLCHAIN=stable cargo check --locked --workspace --all-targets`、`cargo build --locked --workspace` 和 `cargo test --locked --workspace` 均退出 0；测试摘要 app 75 / core 270（263 基线无回退）/ terminal 41，sidecar 1、watchdog 2；nested_scroll、shell_shot、terminal_settings 均打印 OK。父代理在同一快照上实跑并退出 0；独立验收子代理仅只读静态检查。ACP blocked-initialize cancellation 通过独立进程测试（0.26s），不再使用会等待阻塞 GPUI task 的 `run_until_parked` fixture；握手阻塞生命周期由 `acp_io::tests::closing_during_blocked_initialize_kills_child_and_unblocks_connect` 独立进程测试覆盖（0.26s）。Release app 构建成功；`j-agent --version`、崩溃重启截止 smoke、watchdog 正常子进程退出 smoke 均通过。macOS 包 `plutil -lint` 与 `codesign --verify --deep --strict` 通过。当前 Rust rustc 1.97.1 / cargo 1.97.1；pin 为 1.97.1，使用本机现有 stable（同版本）测试。

Sonnet 6.1 复验 findings 已逐项修复：Action/分组展开；WorkPanel 嵌套滚动真实 wheel handoff；ListState 增量 anchor；ACP register-before-spawn cancellation + blocked initialize 子进程测试；Git detail ticket 同时门控 patch；TerminalStyle 传播至已存在/新建 PTY；设置失败 rollback 后将全部编辑器同步到最终 store snapshot；逐行 argv 保留空格；watchdog 默认启动与文档一致；Rust/CI pin 1.97.1。最终 6.1sol 独立验收正在进行。

### 10.3 已知偏差与遗留（P8 后更新）

1. ~~P8 没有做~~ → **已完成（2026-10-12）**，见 §10 P8 行。旧 TS / e2e / patches / `.refs/` / design 原型
   已删除；行为规格与 4,782 行组件测试在 git 历史 `aadecd4` 可查。
2. ~~architecture.md / README / TODOLIST 仍是旧架构描述~~ → 已重写；当前架构以
   `docs/architecture.md` 为准。
3. `.scratch/uncommitted-ts-before-rewrite.patch`（旧 TS 17 个未提交文件，1722 行）已随 `044bd9f`
   入库归档；P3 前未提出落入新实现的需求，按 §7.3 决定不落。
4. **未验证（仍需真机）**：三平台中文输入法、Windows/Linux 编译与运行、标题栏真实拖动/红绿灯、
   真窗口帧耗时、CI 远端矩阵。清单与可选重开项转至 `TODOLIST.md`。
5. `jagent-core::acp` 只有**协议层**；子进程 IO（spawn / 管道 / 惰性握手 / dispose）在 `jagent-app::acp_io`。
6. 桌面通知（`Effects::notify`）目前只记账，不真正弹系统通知（旧 `notify.rs` 的 Windows toast 未迁）。
