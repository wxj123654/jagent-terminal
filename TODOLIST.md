# j-agent 实施 TODOLIST（会话接力文件）

> **给下一个 session 的说明**：本文件是跨会话实施看板。每个 session 开工前先读本文件 + `docs/architecture.md`（代码契约，签名级），做完一块就更新本文件（勾选 + 在文末「会话日志」追加一行）。不要重读全部文档——按当前任务需要读对应章节。

## 环境事实（已确认）

- Windows 11，工作目录 `D:/document/j-agent`
- bun 1.3.13（workspace + 测试全走 bun）、cargo/rustc 1.97.1、node 24（fnm）
- 本地**没有** gpuix / gpui-terminal / zed 的 clone（Phase 0 需要时浅克隆到 `D:/document/j-agent/.refs/`，gitignore 掉）
- GPUUIX pin 自己的 GPUI fork —— gpui-terminal 必须先对版本（Phase 0 结论项）

## 文档索引（均已拍板，落地以它们为准，不要重新发明）

| 文档 | 内容 |
|---|---|
| `docs/architecture.md` | **代码实现契约**（模块/签名/依赖方向/测试面/Phase 映射 §10）。改动先读它 |
| `docs/agent-plane-layout.md` | Agent Plane 布局契约（A 单 pane / C1 无顶栏 / D1 混排 / E2 预设） |
| `docs/settings-ui.md` | 设置界面契约（S1–S5 / 7 分区 / §14 落地顺序 / §15 验收清单） |
| `docs/gpuix-zed-terminal-fusion.md` | 调研与硬约束（§4 硬约束 6：字节流不过 napi；GPUIX pin GPUI fork） |
| `design/*.html` | HTML 原型（布局/设置/交互方案），样式对齐用 |

**待评审工作区方案（不是实现契约）**：`design/workspace-plane.html`，操作说明 `design/workspace-plane.md`。用户已选择独立 HTML、Codex 式工作区分组；正式应用尚未迁移。落地拆解见下方 **Phase W（工作区平面迁移）**。

## 进度看板

| Phase | 状态 |
|---|---|
| 0 Rust 终端骨架 + window.rs 验证 | ✅ 完成（结论见 Phase 0 结论区） |
| 1 双 workspace + napi 壳 + app 最小集 | ✅ 完成（结论见 Phase 1 结论区） |
| 2 ThreadStore 全规则 + settings-core/controls + SettingsView | ✅ 完成（T2.1–T2.7） |
| 3 settings-presets + chat | ✅ 完成（T3.1+T3.2） |
| 3+ settings-acp-advanced + ACP + 键位编辑 | ✅ 完成（T3+.1–T3+.3） |
| W 工作区平面迁移 | ✅ W0–W5 完成（含 ctrl-tab PTY 真 bug 修复）|
| G Git 树（commit graph） | ✅ G1–G3 完成（docs/git-graph.md；只读 graph + workspace tab）|

**当前指针**：→ Phase G 收官 ✅（G1–G3：只读 Git 图 + workspace tab + 键位；真机视觉验收待用户）· 待办：G4 另立设计（status/commit 面板）；真窗口手验清单（W3/W4/W5 + G 的 Ctrl+Shift+G 与键盘导航）
**约束**：一次会话只做一两个任务块；做到哪更新到哪；测试不过不算完成。

---

## Phase 0 —— Rust 终端骨架（crates/jagent-terminal + examples/window.rs）

> 目标：纯 Rust（不经 GPUIX/React）验证终端栈。**本 Phase 的调研结论决定 view.rs 依赖 gpui-terminal 还是 vendoring**（architecture.md §8.1）。

- [x] **T0.1** git init + 根 `Cargo.toml`（cargo workspace：`crates/*` + `packages/native`，后者 Phase 1 建目录时再进 workspace）+ `.gitignore` + `rust-toolchain.toml`
- [x] **T0.2** 浅克隆 `.refs/gpuix`、`.refs/gpui-terminal`（zortax）；查 gpuix 的 GPUI fork 版本（其 Cargo.toml 里 gpui 依赖指向）vs gpui-terminal 依赖的 gpui 版本 → **写结论进本文件 Phase 0 结论区**（注：对版实验曾经做过一次，结论已存项目记忆 #13，重做可先读记忆再验证）
- [x] **T0.3** `crates/jagent-terminal` 骨架：`pool.rs`（TerminalPool：HashMap<u64, Entity<TerminalModel>>，gpui Global 承载，见结论区修订）· `model.rs`（TerminalModel：alacritty Term + FairMutex + 事件消费 task 4ms 批处理，Zed Terminal 同构）· `pty.rs`（tty::new + EventLoop::spawn，Zed TerminalBuilder 模式）· `view.rs` vendored（见结论区）· `element.rs` 占位
- [x] **T0.4** `examples/window.rs`：纯 gpui 窗口，直接 pool create + TerminalView 渲染 model，跑默认 shell
- [x] **T0.5** 验证清单逐项过（architecture §8.3）：Windows ConPTY ✓ · 真彩色（窗口人工验收）· 应用光标模式（随 vim 类 TUI 人工验收）· BEL 触发事件 ✓（实测 `[session] BELL`）· OSC title ✓（实测 `[session] title: "phase0-title"`）· Exit 单次 ✓
- [x] **T0.6** 版本对版结论回写：view.rs 策略（依赖 vs vendoring）写进本文件 + architecture.md §8.1（含 §2.2 POOL static→Global 修订 R5）
- [x] **T0.7** cargo test 通过（30 passed，含 vendored 单测）；git commit "Phase 0"

### Phase 0 结论区（T0.2/T0.6 填写）

- **gpui fork 对版结论**：gpuix submodule pin = remorses/zed @gpuix 分支 commit `8b94def`（2026-08-27，与项目记忆 #13 一致，未漂移）。fork 的 crates/gpui 版本号 `0.2.2` 与 crates.io 上 gpui 0.2.2（2025-10-22 发布）**同号不同 API**（fork 新 ~10 个月：`ShapedLine::paint` 多 `TextAlign + Option<Pixels>` 两参、`FocusHandle::focus` 变三参 `(window, cx)`、`WindowTextSystem` 拆分等）。gpui-terminal（zortax，依赖 `gpui = "0.2.2"`）**无法直接用 crates.io 版编译，也必须 patch 到 fork**——「依赖 vs vendoring」实际是「[patch.crates-io] vs vendoring」。跨 workspace path 依赖还有个坑：gpui 的 `*.workspace = true` 继承会被消费者 workspace 抢走，解法 = fork 的 gpui/Cargo.toml 加显式 `workspace = "../.."` + 我们根 Cargo.toml `[workspace] exclude = [".refs"]`（否则 "member of the wrong workspace"）。
- **view.rs 策略：vendoring**（fusion.md 硬约束 7 落点）。理由：(1) 依赖方式同样要改 gpui-terminal 的 gpui 指向，成本不比 vendor 低；(2) 我们要把 view 从「持有 PTY reader 线程」改成「绑定 Entity<TerminalModel>」（architecture D2 retain 语义），结构性改动本来就绕不开；(3) 实测 vendoring 只需 4 个文件（render/input/colors/box_drawing，mouse/clipboard 是上游 TODO 未接线，event/terminal 被 model.rs 替代），改动极小：render.rs 两处 fork API 适配 + `Term<GpuiEventProxy>`→`Term<SessionListener>`。LICENSE-MIT/LICENSE-APACHE 已随拷贝保留。alacritty_terminal 用 crates.io 0.26.0（最新稳定，2026-04；Zed fork 同代 0.26.1-dev），gpui-terminal 上游 0.25.1 直接升代无 API 断裂。crate edition 2024（vendored input.rs 用 let-chains）。
- **POOL 修订（R5，architecture.md §2.2）**：`static OnceLock<Mutex<TerminalPool>>` 不可行——gpui `Entity`/`Subscription` 非 `Send`。改为 gpui `Global`（`cx.set_global`/`update_global`）承载会话表；跨线程事件转发拆出独立 `static OnceLock<SessionEventFn>`（其类型本身 Send+Sync）。语义不变：全局一份、retain、create/destroy/get。
- **ConPTY/BEL/OSC 实测备注**：Windows ConPTY + 默认 PowerShell 正常（shell 自报 title 事件）；BEL：`[Console]::Write(...([char]7)+([char]7))` 双 BEL 触发（单 BEL 紧跟 OSC 会被吃成 OSC 终止符——测试序列问题非实现问题）；OSC 0/2 title 到达；`exit` → Exit+ChildExit 需去重（已修，`exited` 标志先查后发）。init_command 键入 `
`（`
`）正常，无 PowerShell 续行问题。

---

## Phase 1 —— workspace + napi 壳 + app 最小集

> 锚点：布局契约 §12 —— 单 pane、无 chrome、两个 PTY sidebar 切换、焦点模型结论；**R-V1：RouterProvider 在 GPUIX reconciler 下是否可用**（保底：router.subscribe + useSyncExternalStore 手动桥，接口不变）。

- [x] **T1.1** 根 `package.json`（bun workspace：`packages/*`）+ `packages/app/package.json` + 依赖白名单安装（@gpuix/react · @jagent/native · zustand · @tanstack/react-router · zod · immer · dequal）
- [x] **T1.2** `packages/native`：napi 壳（lib.rs：installTerminalElement + createTerminalSession / destroyTerminalSession / onSessionEvent）；lib.rs 174 行（其中 seam 镜像类型 ~60 行，见结论区），index.d.ts 生成，导出合并实测通过
- [x] **T1.3** app 骨架：`main.tsx`（装配 + renderer 事件桥）· `router.tsx`（memory history；/ · /thread/$id · /settings?section=$s；useActiveTarget）· R-V1 验证并记录结论
- [x] **T1.4** `threads/store.ts` 最小集（spawnFromPreset / activate / close + 依赖注入类型 ThreadDeps）+ bun test（fake deps，§3.4 用例集的最小子集）——实际已实现全规则（rename/cycle/onSessionEvent 全量），13 用例全过，T2.1 只补测试面
- [x] **T1.5** `plane/`（AgentPlane/Sidebar/ThreadList/ThreadRow/Pane + tokens + NewThreadButton）+ `surfaces/registry.ts` + TerminalSurface（全项目唯一 `<terminal>` 写点）+ Chat/Acp 占位 + EmptyPresets + `ui/Icon.tsx` + `threads/useThreadStore.ts`
- [x] **T1.6** 端到端：`e2e/terminal.e2e.test.tsx` 5 用例全绿（两个 PTY 并存、retain + 后台 bell 红点、activate 清红点、exit 灰行 + close 全清、焦点模型）；真窗口冒烟通过
- [x] **T1.7** git commit "Phase 1"

### Phase 1 结论区

- **napi 导出合并（实测）**：jagent-native cdylib 链接 gpuix-native rlib 后，gpuix 全部 napi 导出（GpuixRenderer / TestGpuixRenderer / hasTestGpuixRenderer）与本项目 4 命令（installTerminalElement / createTerminalSession / destroyTerminalSession / onSessionEvent）合并在**同一个 jagent-native.node**（ctor 注册跨 crate 生效，无丢符号）。JS 侧 `@gpuix/react` 的 `import "@gpuix/native"` 经 `packages/gpuix-native-alias`（workspace 包，name=@gpuix/native，re-export @jagent/native）指向同一二进制 —— 单 .node 保证 registry/pool 全局唯一。
- **createRenderer 修订（对 architecture.md §2.3）**：Rust 侧不构造 GpuixRenderer（实例由 JS 侧 `@gpuix/react createRenderer()` 创建并拥有）；装配命令改为 `installTerminalElement()`（幂等，main.tsx 在 renderer.init 之前调）。原因：① napi 3 无 `#[module_exports]` 宏 ② Rust 再 new 一个 GpuixRenderer 会产生双实例。Rust 侧访问 GPUI 线程走 gpuix 全局通道（见下）。
- **gpuix 本地补丁清单**（.refs/gpuix，每处带 `j-agent patch` 注释，`git -C .refs/gpuix diff` 可见）：
  1. `zed/crates/gpui/Cargo.toml` 显式 workspace root（Phase 0 遗留）
  2. `packages/native/src/lib.rs`：`pub mod custom_elements`（原私有）
  3. `custom_elements/mod.rs`：`GLOBAL_FACTORIES` 全局注册表 + `register_global_factory()`（with_defaults 时 drain）
  4. `renderer.rs`：`UiCommand::RunHost`（GPUI 线程回调 + 30s 超时）+ `HOST_UI_COMMANDS` 全局通道（init_threaded 发布）+ `pub fn run_on_gpuix()`（自由函数，不依赖 JS 持有的实例）
  5. `renderer.rs`：`pub struct GpuixView`（原 pub(crate)；外部 crate impl CustomElement 必须能命名该类型）
  6. `.gitmodules`（Phase 0 遗留）
- **lib.rs 行数说明**：174 行（<150 目标微超）；超出部分是 SpawnOptions/SessionEvent 两个 seam 镜像 napi object（~60 行）——协议本身，非业务泄漏。napi 3 细节：ThreadsafeFunction 单泛型（无 ErrorStrategy）、async fn 需 napi feature "async"（= tokio_rt）。
- **已声明未接线（Phase 2 补）**：`palette` / `cursorBlink` props（view 需加 set_palette / blink 支持）；元素事件 focus/blur（待 R-V2 焦点验证后发）。
- **@gpuix/react 引用方式**：`file:../../.refs/gpuix/packages/react`（需先在 .refs/gpuix 里 `bun install && bun run build:react` 产出 dist，与 pin 的 Rust 同 rev）；npm 版 0.7.0 存在但 JS↔Rust 协议不保证与 8b94def 匹配，不用。
- R-V1（RouterProvider@GPUIX）：**不可用，保底手动桥生效并验证**。三个坑与解法：(a) RouterProvider 崩在 MatchesInner `router._rendered[0]`（GPUIX reconciler 渲染时序下 ack 未就绪）；(b) `router.state` 每次组装新对象 → uSES getSnapshot 不稳定（无限循环）→ 订阅回调里递增版本号、getSnapshot 返回原始值、渲染期现读 `history.location.pathname`；(c) **Transitioner 契约**：router-core 在 `history.subscribers` 非空时不自行 `load()`（core router.js `if (!this.history.subscribers.size) this.load(...)`）→ 桥的订阅回调必须 `void router.load()`，否则第二次导航起挂起（实测 settings→'/' 永不生效；连空函数订阅者都能触发）。另：`router.subscribe(fn)` 是事件级 API（需 eventType 首参，单参静默无效）——订阅源用 `router.history.subscribe`。最终形态见 router.tsx 注释；navigate 一律 fire-and-forget（promise resolve 依赖 Matches acknowledgment，手动桥下不触发，无人 await）。全导航序列（/→settings→/→thread/$id→/）实测通过；依赖版本：@tanstack/react-router 1.170.32（latest）+ router-core 1.171.27（官方配对，resolutions 锁回 1.170.32 无必要已移除）
- 焦点模型（Ctrl-Tab 生效条件 / 是否降级）：**全局可用，无需降级**。TerminalView 聚焦时窗口级 keyDown（gpui `on_root_key_event`，Bubble 阶段）仍到达——vendored view 的 `on_key_down` 不调 `stop_propagation`（只写 PTY 后放行）。e2e 第 5 用例固定验证（simulateKeystrokes('ctrl-tab') → 窗口回调收到）。已知副作用：ctrl-tab 被 `keystroke_to_bytes` 的 `tab` 分支（无 ctrl 判断）映射成 `\t` 写进 PTY——shell 忽略，无害；要消除可在 input.rs 给 ctrl+tab 加忽略分支（待真用例出现再做）。
- **gpuix 补丁 #6/#7（e2e seam）**：#6 `test_renderer.rs::run_on_test_app()`（host 闭包直接跑在本线程 VisualTestState，bun test 单线程等价于 GPUI 线程往返）+ `renderer.rs::host_ui_commands_ready()`（探测线程化通道是否存活）+ `lib.rs` 条件 re-export。存在原因：TestGpuixRenderer 不跑 `init_threaded`，HOST_UI_COMMANDS 不发布。
- **gpuix 补丁 #8（test 窗口隐藏化，2026-09-05，详见 patches/README.md）**：修 Windows 上每次 bun test 弹空白窗口。根因链：`VisualTestAppContext::open_offscreen_window` 传 `show:true`（macOS 靠 (-10000,-10000) 屏幕外位置隐形）→ Windows `retrieve_window_placement` 的 `check_given_bounds` 对完全屏幕外 bounds 返回 false → fallback `display.default_bounds()`（主屏居中）→ `SetWindowPlacement(SW_SHOWNOACTIVATE)` 真显示窗口（空白：test renderer 只在 flush/advanceTime 画帧）。修复两处（均在 zed fork）：① `gpui/src/app/visual_test_context.rs` `show: cfg!(not(windows))`；② `gpui_windows/src/window.rs` show:false 分支补 `SetWindowPos` 用**原始 params.bounds**（非被 clamp 的 placement）应用位置尺寸。验证：EnumWindows 采样无测试窗口、截图 1180x760 尺寸精确 + 非空（隐藏窗口 flip-model swapchain 渲染/读回正常）。注：尺寸验证必须走截图尺寸或 hit-test 边界，不能信 placement（被 clamp 污染）。
- **oxc 格式化/lint 工具链（2026-09-05）**：选型 oxfmt@^0.66（beta 豁免，dev 工具链特例）+ oxlint@^1.81（type-aware stable）。对比过 Biome 2.5（全 stable 但 97% Prettier 兼容/自研类型推理）与 Prettier 3.9；oxfmt 默认 100 列恰贴项目风格、100% Prettier JS/TS 兼容目标、VoidZero 生态。配置 `.oxfmtrc.json`：单引号/无分号/100 列/JSX 双引号/sortImports 尊重空行分组（partitionByNewline+newlinesBetween:false 互斥约束）；排除 *.md/*.toml/design（Cargo.toml 归 cargo 生态、设计稿手工排版）；sortPackageJson 默认开。一次性全量接管 commit 30758d1（43 文件）+ .git-blame-ignore-revs，本地已设 blame.ignoreRevsFile。oxlint 首扫 6 处未用导入已清零。日常：bun run fmt / fmt:check / lint。
- **.refs 补丁体系脚本化（2026-09-05，取代人肉清单；2026-09-09 第一批收缩后 gpuix 只剩 0002）**：gpuix/zed 本地修改从「工作树未提交 diff + README 手工重放」升级为 quilt 风格补丁目录——当前 `patches/gpuix/`（1 个：jagent-native-seam）+ `patches/gpuix-zed/`（2 个：gpui-workspace-root、hide-offscreen-test-window），每源文件恰属一个 patch（`scripts/refs-config.ts` MANIFEST，无 hunk 拆分）；`bun run setup-refs` 一条命令重建（clone → fetch pin `e948b20` → apply → submodule → apply → build:react，幂等，-- --force 重建；快速路径按 pin/补丁/staged/未管理改动/dist 存在性检查，不只看工作树非空），`bun run export-patches` 反向导出（--check 防 CI 漂移）。业界选型：cargo git 依赖不可行（gpuix→zed submodule，rust-lang/cargo #9622/#15775）；fork+分支需维护双 fork（单人项目成本>收益）。全量重放验证：删 .refs/gpuix 重建→cargo check→build:debug→bun test（87）+bun test e2e/（9）全绿；注意根 `bun test` 不自动收 e2e workspace（独立 package.json），e2e 必须显式 `bun test e2e/`。补丁 #6~#8 的编号体系移入 patches/README.md 对应表。
- **napi 命令同步化**：create/destroy_terminal_session 从 `async fn` 改同步。原因：napi async 体跑 tokio 线程，而 test 路径的 `run_on_test_app` 依赖主线程 `thread_local TEST_STATE`——同步化后在 JS 调用线程执行，两条路径统一。JS 侧注入点包 `async (o) => createTerminalSession(o)` 保 Promise 形态；副作用：真窗口 spawn 短暂阻塞帧循环（ConPTY 冷启动 ~1s，用户显式操作，可接受；Phase 2 若在意可回 async + 主线程泵）。napi features 的 "async"（tokio_rt）随之移除。
- **TSF 两参坑（T1.2 起潜伏，e2e 暴露）**：`onSessionEvent` 的 ThreadsafeFunction 回调签名是 `(err, e)`——payload 在第二参。旧代码 `(e) => ...` 里 e 恒为 null，所有 session 事件被静默丢弃（T1.3 只验了路由序列，从未真验事件到达）。已修：lib.rs ts_args_type 改双参 + main.tsx/e2e 消费处 `(_err, e) => ...`。
- **e2e 面落成**：`e2e/terminal.e2e.test.tsx`（bun workspace 新成员 `e2e`）5 用例：① EmptyPresets 卡片 ② spawn shell+bell 两行并存 + terminal 元素进树 ③ retain：切走后后台 bell → hasBell + activate 清除 ④ exit → 灰行保留 + exited 标签 + close 全清回 EmptyPresets ⑤ 焦点模型。**时序三律**：PTY 事件消费 task 的 4ms 定时器挂 test dispatcher fake clock——轮询必须 `advanceTime()` 驱动；React 对 store/router 更新的提交需 macrotask 让出；TSF 回调也靠让出后调度。断言一律 `until()` 轮询，禁止固定 sleep（首版固定 sleep flaky 实证）。bell 会话用注入的自定义预设（短命 PowerShell 双 BEL，BELL_PRESET）——ThreadDeps.presetOf 注入设计的首次兑现。
- **zustand useStore 类型坑**：ThreadStore 接口（getState/subscribe，无 getInitialState）不满足 zustand React 包 useStore 的 StoreApi 约束 → 新增 `threads/useThreadStore.ts`（useSyncExternalStore 直桥；selector 必须返回原始值或稳定引用——immer 结构共享保证）。
- **GPUIX 事件冒泡注记**：JS 侧无 stopPropagation 面（EventPayload.elementId 是注册者自身，非深层目标）。行内按钮 vs 父行点击冲突用 mouseDown 抑制 ref 挡一次（ThreadRow 关闭钮，见文件头注释）。
- **杂项**：根 package.json resolutions 残留清除（@tanstack/router-core 1.170.32 不存在——T1.3 结论本已移除，本次清干净）；Sidebar/EmptyPresets 边框只能用 borderWidth+全局 borderColor（StyleDesc 无单边色）；SVG 图标走 `<svg source={svgString}>`（gpui 叶子元素，tint 取 style.color，lucide 同系 24×24 stroke 风格）。

---

## Phase 2 —— ThreadStore 全规则 + settings 三切片 + SettingsView

> 锚点：设置契约 §15 第 1–5、9–11 条；桌面通知实现定型（node-notifier vs Rust win32 toast）。

- [x] **T2.1** ThreadStore 全规则 + bun test 全用例（§3.4）—— 补齐：exitCode 贯通 · cycle 无 active 基准（修正 n-2 怪分支）· activeThreadId 未注入回退 · spawn 传参 + cwd 兑底 · title 空串忽略；17 用例全绿
- [x] **T2.2** settings 三切片：`schema.ts`（zod looseObject + 叶子 .catch + section prefault + SETTING_DEFS 11 defs + SECTIONS 7 分区）· `file.ts`（fsAdapter 原子写+自建目录 + memoryAdapter 失败注入）· `store.ts`（patch/reset/isModified/writeError 回滚时序 + gen 合并写 + init()装配期读盘）+ §6.3 测试面 17 用例
- [x] **T2.3** `ui/` 原子（Icon/Tooltip/SettingRow/Toggle/Select/NumberInput/RangeInput/TextInput/Textarea/Badge/PhaseBadge/IconButton）+ tokens 迁入 ui/ + 16 组件用例；附带修复 Phase 1 点击命中 bug（见结论区）
- [x] **T2.4** SettingsView（SettingsNav 7 分区 + 搜索 + SettingRow 声明式渲染 + 分区深链）——Term/Notify 分区接真值；Presets/ACP 显示 Phase 徽章；9 组件用例
- [x] **T2.5** 桌面通知定型 + 接线（bell → 非激活 → notify；读 settings.desktop 在装配层）——含 palette/cursorBlink/scrollback 通路一并接通
- [x] **T2.6** 全局键位层（Ctrl-Tab/Ctrl-Shift-Tab → cycle；Ctrl-, toggle 设置；修饰键组合外只吃设置面 Esc/`/`）
- [x] **T2.7** 验收锚点核对（§15：1/2/4 core · 3/5/10/11 controls · 9 term-notify 全达成）+ commit "Phase 2"

### Phase 2 结论区

- **T2.1 行为修正**：① cycle 无 active 基准原为 `(idx+dir+n)%n`，idx=-1 且 dir=-1 会落到 n-2 怪分支——改为 dir=1→首个、dir=-1→末个；② spawnSession 的 cwd 未做 `?? process.cwd()` 兑底（thread.cwd 有）——同源化，两端保证一致。另抓到测试名字符串里 `'/'` 截断变除法的坑（bun 显示测试名 NaN，tsc 才报错）。
- **T2.2 契约扩展与实现注记**：① `SettingsStore` 增加 `init(): Promise<void>`（装配期读盘+parse+首帧 set；契约接口是 UI 消费面，缺生命周期方法，main.tsx 需 await 后渲染——T2.4 接线）；② zod 4.5.4 `prefault` 类型面要求完整 output——用 `section()` helper（`{} as z.input<T>` 断言）保持默认值单点定义在叶子 .catch；③ 写盘合并：gen 计数器，旧快照排队中被新 patch 超越则跳过；写失败 gen++ 作废在途写 + 回滚到 persisted（最后确认落盘快照，非 patch 前快照——交错 patch 时正确），成功路径仅在有 writeError 时才 set 清除（省无效 notify）；④ fsAdapter 首次运行目录不存在会 ENOENT——write 前 mkdir recursive（真盘验证抓到，memoryAdapter 测不出）；⑤ ACP 默认 2 示例取自原型：codex --acp / claude-code-acp；⑥ SETTING_DEFS 11 defs（notifications 2 + terminal 6 + appearance 2 + advanced 1），plusDefault 随 Presets 分区手写（选项动态），Keybindings 只读、Presets/ACP 结构性不走 defs。
- **T2.3 GPUIX 平台事实（决定控件实现形态）**：① 无 button/checkbox/select/range 原生元素——GPUIX ElementType 仅 div/text/img/svg/canvas/input/textarea/anchored/code/diff/markdown/virtual-list；Toggle/RangeInput/IconButton 自绘（div + tabIndex + 键盘 space/enter/方向键），Select 封装 @gpuix/react 自带的 shadcn 形态 Select 族（anchored 悬浮/外点关闭/↑↓enter esc 键盘导航内建），Tooltip 同理封装自带的 Tooltip 族（Tip：label 必填、asChild 合并进 trigger）。② input 是纯文本编辑器（无 type 语义）：NumberInput 自绘 stepper（↑↓钮 + ↑↓键）+ draft 状态（中间态/越界不回调，onBlur 回显生效值）。③ StyleDesc 无 :focus-visible、无 transition、无 inset box-shadow——focus 环 = onFocus/onBlur state + focusRing()（spread 2 外扩），toggle knob 用 left 定位直跳。④ 无 aria 面：契约 §11 的 aria-label 等价物 = IconButton 强制 label（Tooltip 文案）+ testId + 键盘可达；「toggle 用真 checkbox」降级为键盘可达 + props.checked 可读。⑤ RangeInput 定位两级降级：renderer 实例鸭子调 getElementBounds（GpuixRenderer/TestGpuixRenderer 都有，仅 NativeRenderer TS 接口未列）→ 比例定位；无 bounds → deltaX/startValue 增量拖拽；拖出轨道自然停（GPUIX mouseMove 只发 hover 元素，无窗口级捕获）。
- **T2.3 重大发现：GPUIX 事件不冒泡（Phase 1 误解修正）**：hit-test 命中 deepest 有 paint 的元素，handler 只在命中元素上找，不向祖先传播（点击命中子 text/div 时父 onClick 不触发；svg 无 hitbox 不指；父显式 backgroundColor transparent 也救不了被子覆盖的区域）。Phase 1 的「事件冒泡注记」与 suppressClick 防御不成立，已删。**修复模式：装饰子元素 pointerEvents:'none' 让命中穿透到 handler 容器**（实测有效）。连带修复 Phase 1 遗留 bug：ThreadRow 点标题/bell 点不激活行、EmptyPresets 点卡片文字不 spawn、NewThreadButton/Sidebar 菌单点文字失效——全部加 pe:none，e2e 新增第 6 用例锁定（点行文字区 → activate）。ui/ 新原子（Toggle/RangeInput 轨道层）同模式。图标 svg 天然不指 hitbox，无需处理。
- **T2.3 结构注记**：tokens.ts 迁 plane/ → ui/（架构 §1.2「ui 被所有人依赖不依赖任何人」，git mv 保留历史），新增 accentSoft/cyan 色；SettingRow 对 settings/schema 仅 type-only import（编译期擦除，运行时零耦合，D7 声明式渲染的展示原子）；SettingRow 的 reset 钮 modified 时常显半透明而非 hover-only（GPUIX 无 :focus-within，hover-only 伤键盘可达）；textarea/input 的文本在 native 编辑器内不进 getAllText（断言只能走回调面）。
- **T2.4 实现注记**：① 文件面：surfaces/SettingsView.tsx（Nav+搜索+右列调度）+ SettingsSections.tsx（DefsSection 真值渲染/CliConventionsCard 只读约定卡/KeybindingsSection 只读表/PlaceholderSection Presets·ACP 占位卡）+ settings/useSettings.ts（uSES 订阅桥，patch/reset/writeError 后整树重渲染）+ router.tsx 增 useSettingsSection/navigateSettingsSection（?section=$s 深链；memory history 的 search 对象/字符串双形态防御）。② 搜索面（§9）：hitsBySection = defs(label/desc/path)+键位动作名+预设名+ACP 名子串；计数徽章、0 命中置灰+onClick guard；无命中空态+清除按钮；搜索框 Esc 清空；label/desc 高亮 = SettingRow 新增 highlightQuery prop（GPUIX highlight wash 替代 <mark>，amber 28%）。③ main.tsx：top-level await settingsStore.init()（bun ESM 支持；首次运行只读不写——实测 ~/.j-agent 不创建，S3 语义正确）；fsAdapter(~/.j-agent/settings.json)。④ App props 增 settings（props 注入纪律不变），e2e 同步补 createSettingsStore(memoryAdapter()) 隔离真盘。⑤ 测试时序：纯 JS navigate 后 React 提交需 macrotask 让出再 flush（navigateSection helper，时序三律同源）；测试间全局 router 的 section 状态串扰（顺序敏感，需各自 navigateSection 锚定）。⑥ T2.4 不含：`/` 聚焦搜索、Ctrl-,/Esc 关闭设置（T2.6 键位层）；终端外观/通知/closeOnExit 消费（T2.5）；Advanced JSON 实时视图（Phase 3+）。
- **T2.5 桌面通知定型：Rust 侧自实现（notify.rs，零新增 crate）**。选型依据：① gpui 无系统通知平台 API（zed#58354 draft 已关未合，fork 8b94def 不含）；② notify-rust Windows 后端默认借 PowerShell AUMID（toast 来源显示 "Windows PowerShell"）、自定义 AUMID 仍需自建快捷方式；③ node-notifier 10.x spawn 2017 年 SnoreToast 二进制，同样借身份；④ 自研零依赖（windows crate 0.61 已在 fork 依赖树）：SetCurrentProcessExplicitAppUserModelID(dev.jagent.Terminal) + 开始菜单 j-agent.lnk（IShellLinkW+IPropertyStore 写 PKEY_AppUserModelID，每进程首调重写，幂等）+ WinRT ToastNotificationManager 手拼 XML（sound=false 必须 EXPLICIT `<audio silent>`，平台默认有声）。失败一律 eprintln 静默（非关键路径）；detached thread 跑 COM（apartment 不污染 JS 线程）。**冒烟实证**：真 toast × 3（含静音路径）+ %APPDATA%\...\Programs\j-agent.lnk 创建成功；注意 bun -e 一次性进程会杀 detached thread（产品路径常驻进程无此问题）。已知限制：toast 点击启动快捷方式目标（dev=宿主进程），拉起既有窗口未接线（红点路径是 in-app 兜底）。
- **T2.5 接线面**：① nativeDeps.createNativeThreadDeps(settings, overrides) 签名扩 settings——notify 读 notifications.desktop/sound（desktop=false 静默 skip）、closeOnExit 读 terminal.closeOnExit、spawnSession 补 scrollbackLines 兑底；主调用点（main/e2e）装配顺序调整为 settings 先行。② SurfaceProps 增 settings（registry 类型 + Pane 传递，chat/acp 后续受益）——architecture.md §4 契约扩展。③ TerminalSurface 读 useSettings().terminal 四项（fontFamily/fontSize/palette/cursorBlink）——设置变化→重渲染→setCustomProp→model.set_style 幂等→sync_style 调和（palette 换色板不重建会话）；e2e 第 7 用例锁定（含 sessionId 不变不变量）。④ Rust 侧：TerminalStyle 增 palette/cursor_blink；colors.rs by_name（'one-dark' 色板：bg #282c34 系，未知名回退 ANSI default）；view.rs 500ms blink 循环（cx.spawn async，weak view，cursor_blink=false 时静默停翻）+ render 时 renderer.cursor_visible=blink_on（无焦点/blink off 不画光标）；element.rs apply_style 写两项（Phase 1 遗留 TODO 清偿）；render.rs TerminalRenderer.cursor_visible 字段。⑤ spawn 路径补 scrollbackLines（element 的 prop 只是样式，scrollback 在 SpawnOptions）。注：设置默认 palette='one-dark' 生效后窗口从 ANSI 深色变 one-dark——真窗口人工验收项。
- **T2.6 实现注记**：① 键位层提取 src/keybindings.ts（createGlobalKeydown 依赖注入形态，main.tsx 与 e2e 挂点共用同一语义；布线差异注入，nativeDeps 同款纪律）。② 分层：修饰键组合（Ctrl-Tab/Ctrl-,）全局吃 + 设置面生命周期键（Esc/`/`，无修饰键，仅 inSettings() 时吃——terminal 表面时透传给 PTY，硬约束 2）。③ **Esc 双跳时序（重大实测）**：键盘事件「焦点元素 → root」两跳，且 React 状态在焦点元素回调内**同步提交**（useEffect 先于 root handler 跑完）——「root 读旧 query 跳过」的防御不成立；改为搜索框 onKeyDown 同步置「已消费」标记（escConsumed），root 层见标记不连坐关闭。④ 关闭设置 = activate(lastNonSettings())：router 桥订阅回调里维护「最后一个非设置目标」（settings-ui §4「回到之前 surface」；activate(null) 只回 EmptyPresets）。⑤ `/` 聚焦：renderer.focusElement(searchInputId)——id 由 React ref 回调获取（**autoFocus 程序化聚焦不派发 JS onFocus 事件**，事件侧拿不到 id；inputFocus 守卫误判无后果：字符照进搜索框 + focusSearch 无操作）。⑥ ui/keyboard.ts：文本输入焦点登记单例（inputFocus.acquire/release，四个 ui 控件 onFocus/onBlur 上报；ui/ 零依赖纪律不破——负计数不影响 any 判定）。⑦ main.tsx 装配变 createRenderer() 自持实例（`/` 需要命令面）+ render({renderer}) 注入。⑧ e2e 第 8 用例：Ctrl-, 开 → 打字 → `/` 守卫 → Esc×2（清空/关闭）→ cycle；**全量跑时 threads 遗留污染**——cycle 落点按数组序断言不假设回 tid。

---

## Phase 3 —— settings-presets + chat

- [x] **T3.1** Presets 分区 CRUD（自定义预设：id + builtin:false + cwd?；lastUsedPreset 运行时态不进 JSON）——详见 Phase 3 结论区
- [x] **T3.2** ChatSurface 实装（chat thread 骨架 → 最小可用；后端拍板 EchoAgent + seam）——详见 Phase 3 结论区
- [x] **T3.3** 验收锚点（§15 第 7–8 条，T3.1 已达成；本块核对）+ commit "Phase 3"

### Phase 3 结论区（T3.1）
- **store CRUD 面（settings-ui.md §12 回调面 → SettingsStore 五方法）**：addPreset（id=`custom-${Date.now().toString(36)}` 唯一化 + builtin:false，返回 id）/ updatePreset（PresetPatch 类型面锁 id+builtin 不可改；normalizePreset 归一：program/initCommand/cwd 空串、args 空数组、env 空对象 → undefined，**args 空串行过滤**——编辑中间态空行不进 JSON）/ deletePreset（内置 no-op；plusDefault===id → null；lastUsedPreset 是 ThreadStore 运行态，settings 不碰，消费侧兑底——NewThreadButton target 链 plusDefault??lastUsedPreset??首项天然兜底）/ duplicatePreset（id `-{src}-copy` 递增后缀 + label 「 副本」+ builtin:false）/ resetPreset（仅内置回 BUILTIN 出厂）。全部走同一 commit()/enqueueWrite 写链（写失败回滚/writeError/合并写免费复用）。提取 commit() 后 patch 也走它。
- **PresetsSection 组件面**：plusDefault Select（''=跟随上次使用 → patch null）+ 列表卡（head 命中容器显式 backgroundColor + 装饰 pe:none；内置/自定义 Badge + 行级/字段级 mod-dot = presetModified/presetFieldModified（threads/presets.ts，dequal vs BUILTIN）+ 复制/重置（仅内置且 modified）/删除（仅自定义）IconButton）+ 展开编辑器六字段（label/program/initCommand/cwd 即时 TextInput；args/env LinesField）+ 底部新增（label=`自定义 ${n+1}`，新增/复制后自动展开）+ writeError 分区顶部红条。LinesField 见下条。
- **重大平台发现 ①：GPUIX click 在子元素自带 listener 时会冒泡到父 listener**（T2.3「不冒泡」结论修正：仅纯 paint 装饰（无 listener）不冒泡；子有 onClick → 事件沿 hitbox 链 bubble，实测 log=[child,parent]）。ThreadRow 关闭钮没踩坑纯靠 onMouseDown+同步移除元素逃逸。JS 无 stopPropagation 面 → 修复模式 = **抑制 ref**：按钮 handler 先置位（冒泡 deepest-first），head onClick 消费后跳过。React 状态同步提交保证同批可靠。
- **重大平台发现 ②：TestGpuixRenderer 路径完全不派发 React focus/blur 事件**（点击/focusElement 都不发；T2.6「autoFocus 不发」的推广——测试里 inputFocus.acquire 永不触发，负计数不影响 any 判定）。产品路径（真窗口点击聚焦）正常。→ LinesField **提交面不依赖 blur**：onChange 即时提交原始行（store 层归一过滤）+ draft 只管显示（编辑中间态尾随换行不回写受控值，无光标跳动）+ onBlur 仅归一显示。测试完全可驱动。
- **重大平台发现 ③：GPUIX textarea 的 enter=Submit、shift-enter 才插入换行**（custom_elements/input.rs KeyBinding："enter"→Submit / "shift-enter"→Newline）。行式字段（args 每行一个参数）的真实换行手势 = shift-enter，产品语义不变。
- **keystroke 语法坑**：`' X'` 首字符空格被解析器吞（用显式 `space` 键名）；`'-'` 是 modifier 连接符语法（Keystroke::parse），单字符 '-' 不可表达——测试数据避开。
- **接线面（BUILTIN_PRESETS 硬编码 → settings 快照）**：NewThreadButton（+settings props，Sidebar/AgentPlane 传递；target = plusDefault ?? lastUsedPreset ?? 首项）· EmptyPresets（Pane 传 settings，卡片摘要 presetCommandSummary）· nativeDeps.presetOf（查 settings items，含自定义；e2e override 改为 settings 优先 + BELL_PRESET 叠加，不再替换真语义）· SettingsView.hitsBySection（预设命中吃动态 items，presetMatches）。threads/presets.ts 新增 presetCommandSummary/presetMatches/presetModified/presetFieldModified（数据中心单点，UI 零逻辑）。
- **e2e 第 9 用例**（T3.1 全链）：settings.addPreset → spawnFromPreset 走真 nativeDeps.presetOf → 真 ConPTY spawn → NewThreadButton label 跟随 → 进程 exit → exited 灰行 → close 清理 + deletePreset。
- **测试总量**：settings 37（+10 CRUD）· PresetsSection 9（新）· SettingsView 调整（真分区断言）· 单测 87 + e2e 9 + cargo 33 全绿 · tsc 干净 · 真窗口 mount 冒烟 ✓。附：Phase 2 收官提交误入的 mona-lisa.html/mona-shot.png（T2.5 通知调试产物）工作区已删，随下次 commit 清理。

### Phase 3 结论区（T3.2，chat 实装）

- **后端拍板（2026-09-05 用户确认）**：chat「最小可用」= **EchoAgent stub + ChatAgent seam**——composer 输入的唯一去处是 `threads/chat.ts` 的 `ChatAgent` 接口（`send(text) → Promise<string>`），默认 EchoAgent（600ms 模拟思考），ACP/LLM 接入时只换 adapter，UI/状态机不动；新建入口 = **+ 预设菜单底部固定「New Chat」项**（分隔线下；EmptyPresets 保持纯预设语义）。直连 LLM API（流式/错误面工作量 + 与「凭证走 shell 环境」哲学冲突）与纯骨架（无 seam 可换）均否。
- **store 面**：ChatThread 扩展 messages + pendingReply；接口增 createChat（push+activate）/ sendChatMessage（状态机单点：空串与 pendingReply 双忽略；user 落列 → chatAgent.send → 回复/错误落列；close 后迟到的回复丢弃——不复活已删行）；rename 扩展 chat（直接写 title）；首条 user 消息截断 32 字符改写 title（title===默认值哨兵，手改后冻结）。ThreadDeps 增 chatAgent（必填；nativeDeps 默认 EchoAgent，e2e override 零延迟）。
- **ChatSurface 面**：薄顶栏（CHAT pill + 标题，36px）+ `<virtual-list alignment="bottom" followTail>` 消息区 + composer（textarea autoFocus + enter=Submit 发送 / shift-enter 换行 + Send 钮，pendingReply 禁发）。user 消息右对齐气泡（accentSoft）；assistant 走 GPUIX `<markdown source>`（GFM，未来 ACP/LLM 富文本免费）+ role 标签（ASSISTANT/ERROR）。thinking… 占位跟 pendingReply。
- **平台发现（记忆 #29 增补）**：① simulateKeystrokes 的**空格不仅首字符被吞，中间空格也吞**（e2e 'hello e2e' 打不进去，改 'helloe2e' 通过）——测试数据一律无空格。② **markdown 是 native 元素：内容不进 getAllText**（getPaintedText 也不可靠）——断言走 `findByType('markdown')` 的 `customProps.source`。③ **点击可聚焦元素会把键盘焦点从 textarea 抢走**（Send 钮点击后 simulateKeystrokes 进 void）——后续打字用例先 `renderer.focusElement(composer.id)` 拉回。
- **测试数据流纪律**：ChatSurface 是纯 props 组件（同 TerminalSurface），组件测试必须经订阅壳渲染（useThreadStore selector = Pane 同构）——直接 render 死 props 测不到消息更新链。
- **测试总量**：单测 92（store +7 chat · ChatSurface.test 6 新）+ e2e 10（chat 全链新）全绿 · tsc 干净 · fmt/lint 清零 · 真窗口 mount 冒烟 ✓。architecture.md 已同步（§1.1 目录树 chat.ts / §3.1 ChatThread / §3.2 deps+接口 / §3.3 规则表 / §4 registry）。

## Phase 3+ —— acp/advanced/键位

- [x] **T3+.1** ACP Agents 分区 + AcpSurface（ACP JSON-RPC 子进程）——详见下方结论区
- [x] **T3+.2** Advanced 分区 + 键位编辑解锁（S5 只读 → 可编辑）——详见下方结论区
- [x] **T3+.3** 验收锚点（§15 第 6 条）+ commit —— 见下方结论区

### Phase 3+ 结论区（T3+.3 验收）

- **§15 第 6 条「settings.json 为事实源：实时视图随修改同步；『在编辑器中打开』可用」核对达成**：① 实时视图与写盘同源——store 的 `serializeSettings()` 同一函数既写盘（commit 快照）又渲染 Advanced 分区 markdown code block，无两套序列化；修改即时反映由 uSES 订阅驱动（e2e 第 12 用例锁定：改键 ctrl-. 后 JSON 视图含新值 + `"keybindings"` section）。② 「在编辑器中打开」：memory adapter 无 path 按钮不渲染（e2e 断言 byTestId undefined）；darwin `open` 分支真机调用实测通过（无 throw，fire-and-forget 语义）；真盘 adapter 携带 path 产品路径渲染。③ 全量验证：app 单测 134 + e2e 12（macOS 全绿，09-09 fixture 修复生效）+ cargo 37 + tsc/fmt:check/lint 干净 + 真窗口冒烟 mount complete。④ 代码已在 T3+.1/T3+.2 提交（a22ba9f/836f9be），本块收官补工作区原型入库（design/ 6 文件，独立 commit）+ .impeccable 工具产物 gitignore。

### Phase 3+ 结论区（T3+.2，键位可编辑 + Advanced）

- **键位数据面**：settings.json 新增 `keybindings` section（四动作：cycleNext/cyclePrev/toggleSettings/focusSearch，叶子 string.catch 默认 'ctrl-tab'/'ctrl-shift-tab'/'ctrl-,','/'）。键位串语法同 GPUIX keystroke（modifier '-' 连接）；单字符 '-' 键不可表达（split 退化，编辑面拒绝，已知限制）；含 alt 的绑定永不命中（事件面只有 ctrl/shift）。
- **keybindings.ts 参数化**：createGlobalKeydown 增 opts.keys getter（默认 DEFAULT_KEYBINDINGS 常量兜底）——每次 keyDown 查 settings 快照，修改即时生效无需重启。keystrokeMatches(ks, key, ctrl, shift) 匹配器导出。语义约束在编辑面保证（运行时只按层归属匹配）：cycle*/toggleSettings 必含 ctrl（全局修饰键层，硬约束 2 不吃裸键）；focusSearch 必无修饰（设置面裸键层）。Esc（清空/返回）与 +/Shift+ 菜单是平台语义，不参与配置（只读行）。
- **settingsKeyboard 提取**（surfaces/settingsKeyboard.ts 模块单例，从 SettingsView.tsx 提出）：query/searchInputId/escConsumed 三态 + markEscConsumed 公开——搜索框与键位捕获格两个 Esc 消费源统一面；提取动机 = KeybindingsSection（SettingsSections.tsx）要消费它，避免 SettingsView ↔ SettingsSections 循环 import。
- **捕获格（KeyCap）**：点击/enter 进入编辑态（高亮「按下新组合…」）；修饰键单独按忽略；无效组合拒绝并提示（裸键→「需含 Ctrl」/focusSearch 带修饰→「需无修饰键」/不支持的键/'-' 语法限制）；有效即 settings.patch 即时写入；Esc 取消（markEscConsumed 防 root 层连坐关设置——双跳时序）；键白名单 = 单字符 || tab/enter/方向/home/end/pgup/pgdn/backspace/delete/f1-f12。冲突检测：两动作同串 → 双方 amber 警示行（运行时按声明序取首命中，不阻止保存）。modified 蓝点 + ↺ reset（settings.reset 通用面）。
- **Advanced 分区**：gpuBackend（defs）+ 诊断卡（版本/GPUIX pin/平台只读）+ settings.json 实时视图（serializeSettings 与写盘同源；markdown fenced code block 渲染 + maxHeight 280 overflowY scroll；订阅快照修改即时反映）+ 「在编辑器中打开」（file.ts openInSystemApp：win32 cmd /c start、darwin open、其余 xdg-open，fire-and-forget 失败仅 warn；仅真盘 adapter 有 path——fsAdapter 携带 FileAdapter.path，memory 无 → 按钮不渲染，测试面零注入）。store 接口增 filePath()/serializeSettings 导出。
- **平台发现（e2e 实测）**：GPUIX simulateKeystrokes 的 ctrl-. 组合键不产生文本输入（input 不进字符）；'tab' 是焦点移动键也不进文本——搜索断言用普通字符子串（'esc' 命中 'Esc（平台语义）'）。Esc 关设置前需先清 query（T2.6 同语义，收尾 Esc×2）。
- **测试面**：SettingsView.test 12 用例（+3：改键写入/reset 恢复、冲突双方警示、Esc 取消编辑不连坐）；单测 117 + e2e 12 全绿；tsc/fmt/lint 干净；真窗口冒烟 mount complete。

### Phase 3+ 结论区（T3+.1，ACP）

- **ACP 协议调研（2026-09-05，agentclientprotocol.com + GitHub schema 源）**：稳定版 = **v1**（v2 是 draft，codex --acp / claude-code-acp 实现 v1）。传输 = stdio + 行分隔 JSON-RPC 2.0（非 LSP 的 Content-Length 帧）。握手链 = initialize（protocolVersion:1 + clientCapabilities）→ session/new（cwd 绝对路径 + mcpServers）→ sessionId；对话 = session/prompt（prompt: ContentBlock[]）→ 期间 session/update 通知流式汇报（sessionUpdate: agent_message_chunk / tool_call / tool_call_update / agent_thought_chunk / plan / usage_update…；ContentChunk 带 messageId，变 messageId = 新消息）→ 响应 {stopReason: end_turn|max_tokens|max_turn_requests|refusal|cancelled}。agent→client 请求：session/request_permission（options: allow_once/allow_always/reject_once/reject_always）；fs/*、terminal/* 仅在 client 声明对应 capability 后才会来——我们全不声明（{}）故不会收到。自研客户端零依赖（与 notify.rs/Rust toast 同款纪律，官方 TS SDK 引入成本高于手写 ~300 行）。
- **threads/acp.ts（AcpConnection = ChatAgent + dispose）**：惰性握手（首次 send 才 initialize+session/new，失败置空可重试）；send = prompt + 收集器（文本块拼接、messageId 变化分段落、tool_call/tool_call_update 汇总为 markdown bullet 行、非 end_turn 附「> 停止：xxx」注记、全空回「（turn 结束，无输出）」）；权限自动应答 allow_once > allow_always > 首项（无 UI，后续接权限面时替换）；进程退出/spawn 失败 reject 全部在途请求并附 stderr 尾部（codex 未装时首条消息直接看到原因）；dispose kill 子进程。**Windows 坑：npm 全局 CLI 是 .cmd shim，node spawn 不带 shell 解析不到 → win32 走 shell:true + 自拼引号**（args 含 %/引号的极端转义是已知限制）。
- **store 面（chat/acp 同构状态机单点 sendConversationMessage）**：AcpThread 完整化（agentId + messages + pendingReply + autoTitle 哨兵）；createAcpThread(agentId, label)——label 由调用方从 settings 快照传入（store 不读 settings，DI 纪律不变）；连接情建（每 thread 一次，createAcpAgent 同步 throw → error 行不置 pending）；close → 连接 dispose；ChatAgent 接口增可选 dispose（EchoAgent 无资源不实现）。store 测试 31 用例（+7 acp）。
- **设置面**：SettingsStore 增 addAcpAgent/updateAcpAgent/deleteAcpAgent（同一写链/回滚面；无 builtin/modified 概念——默认 2 项也只是可删改示例；args 空串行过滤同 presets）；AcpAgentsSection（列表卡 + 三字段编辑器 label/command/args，占位卡下岗；PlaceholderSection 死代码已删）；搜索 hitsBySection 改吃动态 acpAgents（原来用 DEFAULT_ACP_AGENTS 常量，改配置后搜索命中会漂移）。FieldRow/LinesField/ModDot 提取到 surfaces/listEditorParts.tsx（Presets/AcpAgents 共享）。
- **UI 面**：ConversationView 提取（chat/acp 共享消息面：pill+标题+virtual-list followTail+composer；差异全参数化 testId/pill/placeholder/onSend）；ChatSurface 变薄壳（6 用例不改动全绿）；AcpSurface = ACP pill（acpKind 紫）+ sendAcpMessage。NewThreadButton 菜单：预设 → 分隔线 → New Chat → 分隔线（有 agent 时）→ agent 项（testId=new-acp-$id，Icon acp + label + mono 命令摘要）。nativeDeps.createAcpAgent 默认实现读 settings.acpAgents（e2e 不覆盖即可测真链）。
- **测试面**：__fixtures__/fake-acp-agent.ts（bun 脚本假 agent，FAKE_ACP_MODE 七种行为：echo/tools/permission/refusal/crash/badline/version2）经 process.execPath 真 spawn——acp.test.ts 10 用例覆盖协议面（含 dispose 后进程终止断言 kill(pid,0)）；AcpSurface.test 3 用例；settings CRUD +3；e2e 第 11 用例全链（settings 注入 fake 配置 → 菜单 → 真子进程 JSON-RPC → 回复 markdown → close）。测试总量：单测 114 + e2e 11 + cargo 33 全绿 · tsc/fmt/lint 干净 · 真窗口冒烟（mount complete）。
- **归档注记**：存量 acp thread 不追配置变更（删配置/改命令只影响新 thread——store 情建 + unknown agentId 错误行兑底）；权限 UI/工具卡/thought 块/流式增量/turn 取消都是后续升级面（ChatAgent seam 形态不变，换 adapter 即可）。

---

## Phase W —— 工作区平面迁移（原型 → 原生 app）

> 锚点：`design/workspace-plane.html`（待评审方案）+ `design/PRODUCT.md` + `design/DESIGN.md`。原型已通过交互测试与独立审查（ship）；本 Phase 把工作区分组与多 TUI 会话模型落进 `packages/app`，不改变既有 PTY / `<terminal>` 架构（硬约束 2–4 不变）。**用户评审通过原型后才开工**。

- [x] **W0** 原型评审定稿（2026-09-06 定稿）：两轮迭代验收（新建会话弹窗布局修复 + 本地目录选择「浏览…」）+ 用户放行开工 Phase W；「本地目录选择」已列为原生必做项（W3 目录选择 seam）；工具清单与交互细节以 `design/workspace-plane.md` 为准
- [x] **W1** 数据层：`threads/workspaces.ts` + ThreadStore 工作区改造 + state.json 持久化——详见 Phase W 结论区

### Phase W 结论区（W1，数据层）

- **数据模型（拍板）**：平铺 + 归属字段，**不嵌套**——`Thread.workspaceId?`（可选：W1 旧 UI 调用点零改动，W2 迁移后全带），threads 保持混排创建序（Ctrl-Tab cycle 环形语义与事件定位 R4 不变），分组 = 派生视图 `workspaceSessions(threads, wsId)`（TODOLIST 原案「Workspace 含 sessions[]」按此落地）。`Workspace = {id/name/path/expanded/lastSession/createdAt}`。
- **cwd 继承链（拍板）**：`preset.cwd ?? workspace.path ?? process.cwd()`——preset 显式 cwd = 用户配置意图优先；否则继承工作区目录（工具在项目目录里跑是工作区的存在意义）。显式传入的 workspaceId 不存在 → throw（三个创建入口同判）。
- **持久化（拍板：独立 state.json）**：`~/.j-agent/state.json`，与 settings.json 分文件（工作区含运行时态 expanded/lastSession，语义是「应用状态」非「用户设置」）。threads 不持久化（PTY 重启即死，恢复行无意义）；lastSession 持久化后可能指向死 id——activateWorkspace 存在性校验兑底。复用 FileAdapter（原子写）；`ThreadDeps.persistWorkspaces?`（fire-and-forget，装配层注入，测试不注入则跳过）。**首启只读不写**（对齐 settings S3：不动工作区不落盘，重启重建同默认值）；state.json 为空/损坏 → 装配层建默认工作区 `defaultWorkspace(process.cwd())`（name = basename）。
- **zod 容错坑（实测）**：`z.array(WorkspaceSchema).catch([])` 是**整组回退**——单行损坏会把全部工作区抹成空（默认工作区重建，用户改名/归属态全丢）。修法：array 元素层 `z.unknown()` + 逐行 `safeParse` 过滤（坏行剔除、坏字段 catch 回默认），单行坏不炸全局。
- **store 规则增补**：activate 带 workspaceId 的 thread → `lastSession` 记录（实际变化才 persist，produce 同步执行用局部标记判 touch）；close 该会话 → lastSession 置 null（「最后一个会话被移除回工作区起始页」的数据面，空态 UI 是 W2）；removeWorkspace 连带 close 归属会话（复用 close 单点：destroy/dispose/导航兑底）；activateWorkspace 死 id/无 lastSession → activate(null)；toggleWorkspaceExpanded 只翻转不导航（点箭头与点行分离，原型契约）。
- **main.tsx 装配**：state.json 读取在 settingsStore.init() 之后（同 await 装配期）；persistWorkspaces 失败仅 warn。真窗口冒烟：mount complete + 首启不写 state.json ✓；装配链路真盘写读往返（fsAdapter + serialize + parse）独立验证 ✓。
- **测试面**：workspaces.test 8（parse 容错 4 + 往返 1 + 构造派生 3）+ store.test 新增 13（CRUD/persist 4 + 归属与 cwd 5 + activate/close/remove 4）；存量 31 用例零改动全过（向后兼容实证）。app 155 + e2e 12 + tsc/fmt/lint 全绿。architecture.md §1.1/§3.1/§3.2/§3.3 已同步。
- [x] **W2** 侧栏 UI：工作区分组树 + ToolMenu + 添加工作区 + 搜索——详见 Phase W 结论区（W2）

### Phase W 结论区（W2，侧栏 UI）

- **结构变更（原案微调）**：① 原型「顶部新建会话按钮 + 工作区行 ＋」收敛为**工作区行 ＋ 唯一入口**（消除「当前工作区」歧义；全局空态兜底仍是 EmptyPresets——其 onPick 带第一工作区归属）；NewThreadButton/ThreadList 删除，菜单演化为 ToolMenu（anchored deferred，新增目标工作区头 name+mono cwd；testId：入口 `new-menu-$wsId`、预设项 `tool-preset-$presetId`、new-chat/new-acp 承袭）。② 原型「添加工作区对话框」落地为**侧栏内联表单**（GPUIX 无居中模态原语，anchored 是相对 trigger 定位——内联表单零浮层复杂度；「浏览…」按钮 W3 目录选择 seam 后补，当前目录手输 + placeholder 说明）。
- **WorkspaceGroup 行交互**：点行 = activateWorkspace（恢复 lastSession）；点箭头 = 仅 toggle（抑制 ref 模式防冒泡连坐，T3.1 同款）；双击 = rename（行内 input，与 ThreadRow 同构）；hover 显示移除钮（onMouseDown 同步移除逃逸冒泡——ThreadRow 关闭钮同款）。空工作区（expanded 无会话）引导行文案。
- **搜索**：`searchThreads(threads, workspaces, query, presetLabelOf?)` 纯函数（workspaces.ts）——命中面 = 标题 + 工具名（terminal→preset label / chat / acp）+ cwd + 工作区 name/path，大小写不敏感；结果行 = ThreadRow 无缩进 + suffix 工作区名（muted mono）。
- **uSES 快照稳定性（新坑实测）**：selector 返回 `searchThreads(...)` 新数组会让 useSyncExternalStore 判快照不稳定（无限渲染）——订阅 `s.threads`/`s.workspaces` 稳定引用（immer 结构共享），命中列表**渲染期现算**（SettingsView hitsBySection 同模式）。
- **e2e 迁移**：装配 `initialWorkspaces: [defaultWorkspace(process.cwd())]`（与 main.tsx 首启同构）+ spawnFromPreset 全带归属（无归属行不进分组树——e2e 断言经 UI 行可见性）；菜单入口 testId 换 `new-menu-$wsId`；T3.1「+ 按钮 label 跟随」断言改「归属行出现在分组树」（plusDefault→label 联动随 NewThreadButton 退役，lastUsedPreset→EmptyPresets/ToolMenu 无单点展示面，纯 store 断言保留）。
- **测试面**：WorkspaceList.test 9（分组渲染/缩进/toggle 不激活/点行恢复/空态引导/菜单目标头+项/预设 spawn 归属+cwd/chat 归属/添加表单必填+basename/搜索三路命中+空态）+ searchThreads 纯函数 2；app 166 + e2e 12 全绿；真窗口冒烟 mount complete + 无交互不写盘复验（state.json 首启只读不写 ✓）。
- [x] **W3** 目录选择 seam：packages/native 增 pickDirectory——详见 Phase W 结论区（W3）

### Phase W 结论区（W3，目录选择 seam）

- **gpuix 盘点结论**：pin 的 rev 零 dialog/picker 导出（grep OpenPanel/IFileDialog/FileDialog/pickDirectory 全空），自建。
- **实现（packages/native/src/picker.rs）**：`pickDirectory(cb)` TSF 回调面（两参契约同 onSessionEvent——payload 在第二参）。**macOS**：NSOpenPanel 在 JS/主线程同步跑模态（gpuix 在调用线程跑 GPUI；runModal 自泵 AppKit，panel 交互正常、身后窗口暂停重绘=模态语义）；objc 0.2 msg_send（appearance.rs 同款），canChooseDirectories/!files/!multiple。**Windows**：IFileOpenDialog 走 detached STA 线程 + CoInitializeEx（notify.rs 同款），FOS_PICKFOLDERS|FOS_FORCEFILESYSTEM，SIGDN_FILESYNCHRONOUS 取路径；windows crate 0.61 现有 features（Win32_UI_Shell/Win32_System_Com）已覆盖零新增。**TSF call 统一 NonBlocking**：macOS 在 JS 线程内回调（Blocking 会等 JS → 死锁），统一 NonBlocking 从任意线程安全入队。
- **JS 注入链**：main.tsx 包装 `() => Promise<string|null>` → App → Sidebar → WorkspaceList → AddWorkspaceForm prop（windowControls 同款 seam 纪律；plane/ 零 @jagent/native 直 import，§1.2 不破）。未注入（测试默认）「浏览…」不渲染（「在编辑器中打开」同款模式）。选择后：填 path + **名称空时**自动 basename（尊重手输）。
- **验证**：cargo test 37 + napi build（darwin-arm64 .node + index.d.ts pickDirectory 导出 ✓）；WorkspaceList.test +1（未注入无按钮 / fake 选择填值+自动名称 / 取消不动已填值）；app 167 + e2e 12 + tsc/fmt/lint 全绿；真窗口 mount ✓。**NSOpenPanel 真交互（面板弹出/选择/取消）待用户真机验收**——agent shell 弹模态面板无法自动断言。
- [x] **W4** 空态与键盘：详见 Phase W 结论区（W4）

### Phase W 结论区（W4，空态与键盘）

- **⌘K/Ctrl-K 聚焦侧栏搜索**：keybindings.ts 新动作 `searchThreads`（默认 mac cmd-k / win ctrl-k，schema 平台分支 catch）。**keystrokeMatches 扩 cmd 语法**（'cmd-' 前缀；EventModifiers.cmd 即 mac ⌘/win Win）。层级：设置面打开时**不劫持**（⌘K 语义留给设置面）；⌘ 是 platform 修饰不写 PTY（硬约束 2 天然零冲突）。Sidebar 搜索框 ref → `plane/sidebarKeyboard`（模块态，settingsKeyboard 同款纪律）→ main.tsx focusThreadSearch。**元素 blur 无 API**（renderer.blur 是窗口级）——Esc 空值时不强 blur。
- **Esc 层级定稿**：组件编辑态（已有，搜索框/重命名/捕获格）→ query 非空清空 → 窄窗口抽屉态关抽屉（onEscEmpty prop）→ 宽窗口 no-op（保持焦点直接打字）。
- **窄窗口抽屉（760px）**：AgentPlane useWindowSize（poll 100ms；TestRenderer 构造传 width/height → 测试可控断点，fallback 800×600 保宽态）。窄态：Pane 全宽 + drawerOpen 时 **scrim+Sidebar 后渲染**（GPUI 树序绘制 CONSTRAINTS #2——覆盖层必须后画）；TitleBar 汉堡钮（新 Icon menu）toggle；scrim 点击/Esc 关。
- **设置面键位表**：KEY_ACTIONS +searchThreads 行；KeyCap 捕获格支持 cmd（'cmd-' 前缀构造；requireCtrl 校验放宽为 ctrl 或 cmd）。
- **测试**：keybindings.test 5（cmd 匹配/设置面不劫持/改绑即时生效）+ AgentPlane.test 3（宽常驻/窄抽屉开-关/Esc 关抽屉）。app 175 + e2e 12 + tsc/fmt/lint 全绿。跨断点动态变宽 offscreen 无法模拟（窗口尺寸构造后不变）——真窗口手验项。
- [x] **W5** 验收锚点：详见 Phase W 结论区（W5）

### Phase W 结论区（W5，e2e 收口）

- **原型清单对齐核对**：工作区归属/恢复最近会话 ✓（W1/W2+e2e）、草稿保留 → 原生语境 = PTY scrollback retain（T1.6 已锁，HTML 原型的示例输入不移植）、工具筛选 ✓（本轮补 ToolMenu 筛选框：label/program/args/initCommand 子串 + 空态 + Esc 清空）、自定义命令 = ACP agents 项 ✓、搜索 ✓（W2+本轮）、移除回退 ✓（语义修正见下）、窄窗口抽屉 ✓（W4）。
- **e2e Phase W describe（5 用例）**：添加工作区 → spawn 归属 → 侧栏双分组；Ctrl-Tab 跨工作区 cycle（真事件管线环形流转）；activateWorkspace 恢复 lastSession + close 回退空态（临时 w3 自包含）；⌘K 路由（见已知问题）；removeWorkspace 连锁 close + 回起始页。
- **真 bug 修复（本轮最大收获）**：`keystroke_to_bytes` 对 **ctrl-tab 返回 `\t`**——终端聚焦时 Ctrl-Tab 被当裸 tab 写入 PTY，root 键位层收不到 → **真窗口里会话切换一直失效**。修：tab 分支带 control 修饰返回 None（透传 root；裸 tab/shift-tab 语义不变）。cargo 新增 `ctrl_tab_not_swallowed_by_terminal`。
- **removeWorkspace 语义定稿**：close active thread → activate(null) 回起始页（close 单点既有语义，非「切相邻」）——e2e 锁定；未来若要 Zed 式「切相邻」是行为变更再议。
- **e2e 写法坑**：①until 循环里 `prev` 必须在事件派发**前**取（after 结构死锁等下一次变化）；②describe 间不隔离——Phase W 用例不假设前面 describe 的 threads 池状态（retain 池有遗留），「最后 spawn 的」用 `.at(-1)` 定位；③单跑 `-t` 用例时依赖前置用例赋值的变量会 undefined——自包含或全 describe 跑。
- **已知问题（未解，记录）**：terminal 元素在场时 GPUI 焦点在帧渲染后被抢回——`focusElement` + 后续 `simulateKeystrokes` 在 TestRenderer 下键击丢失（无 terminal 场景三条聚焦路径全通：autoFocus/focusElement+simulate/nativeSimulateKeystrokes 原子）。疑与 terminal paint 闭包 `handle_input` 每帧注册 InputHandler 有关。**真窗口 ⌘K 打字是否受影响待手验**——若真窗口也丢键，开专项修（gpuix/gpui 层）。打字进 query 的行为由 AgentPlane.test（无 terminal 场景）闭环锁定。

### Phase W 结论区（W7.1，新建会话弹窗布局对齐原型）

- **改动**：ToolDialog 按原型 tool-dialog 三列行重排——①工具行 `20px 图标 | 名称+描述两行（minWidth 0）| 右侧命令码`（minHeight 36，hover 抬底）；②分组标签「AI 编程 / 终端工具」（option-group-label 等价；pi/claude/codex/amp = AI 编程，shell+New Chat+ACP = 终端工具）；③pi 行「默认」徽标（recommended）；④弹窗固定高 560（Modal 新 height prop：min(height, vh-48)，列表区 flexGrow+overflowY 独立滚动——原型固定高形态）；⑤SelectField 新 width:'fill'（撑满），cwd 行单独一段（原型 tool-context small 等价）；⑥内置预设加 description 字段（TerminalPreset 可选 + zod schema 同步 + pi 排序提前——默认工具置顶，store.test 期望更新）。
- **测试**：筛选用例收尾改 X 关闭（filter 聚焦后 scrim 命中失效——TestRenderer 已知限制复现）。app 188 + e2e 17 全绿；截图目检（分组/描述行/默认徽标/命令码右对齐）。

### Phase W 结论区（W7，弹窗形态恢复 + Toast）

- **背景**：用户指出原型丰富的弹窗形态在落地时被收敛（W2「GPUIX 无居中模态原语」判断过时——anchored 支持 position 显式坐标 + deferred）。确认全面恢复弹窗 + toast。
- **Modal 原语（ui/Modal.tsx）**：anchored `position={x,y}` + deferred（画在一切之上）+ occlude；全屏 scrim 点击关闭；ModalHeading（X 钮）/ModalBody/ModalActions（主/次/danger）。**GPUIX 关键事实（本轮实测，两条）**：① absolute 定位需要最近定位祖先 relative——无 relative 时四边全 0 塌缩为 0×0 不渲染（Web 直觉失效）；Modal 覆盖层根用 absolute + 自身 pointerEvents none（scrim auto），**要求挂载点在 relative 容器内**（AgentPlane 内容行天然满足；测试 Harness 需包一层）。② Modal 根若用 width/height 100% 参与 flex 布局，0 高塌缩会连带整树渲染成空（树全空排查时先查覆盖层布局形态）。
- **四弹窗（plane/DialogHost.tsx 单点状态）**：DialogState 联合（tool/addWorkspace/search/manageSession），AgentPlane 根挂载，入口（行 ＋/空组引导/添加工作区/会话 …/起始页）全改经 DialogOpener 回调。①ToolDialog（新建会话）：工作区 SelectField（多工作区时）+ cwd 展示 + 筛选 + 预设/New Chat/ACP 列表——取代 ToolMenu（已删）。②WorkspaceDialog（添加工作区）：名称/目录/浏览…（pickDirectory 经 AgentPlane 注入）+ 校验（全空/相对路径/重复目录三态报错）。③SearchDialog（⌘K）：跨工作区命中 + ↑↓ 导航 + Enter 激活 + Esc 清空。④SessionDialog（管理会话）：上下文行 + 重命名 + danger 移除——取代 W6 的行内 anchored 菜单。
- **⌘K 改道**：keybindings.focusThreadSearch 语义从「聚焦侧栏搜索框」→「打开搜索弹窗」（原型语义）。装配层经 plane/dialogKeyboard.ts 模块态（AgentPlane useEffect 注册 opener；main.tsx/e2e 调 openSearch）。**e2e 坑**：测试挂点 onKeyDown 只传 ctrl/shift 没传 cmd——mac 上 ⌘K 修饰丢失永不匹配（真窗口 main.tsx 是传的）。
- **Toast（ui/Toast.tsx）**：模块态单例 toast(message) + ToastHost（右下浮条，seq 驱动重置计时；ttlMs prop 测试注入）。**advanceTime 不驱动 JS setTimeout**（只推进 gpui 动画时钟）——自动消失断言用短 ttl。
- **TestRenderer 已知限制（W7 新增两条，真窗口不受影响）**：① input 聚焦（nativeSimulateKeystrokes 自带 focus）后，对 deferred 层元素的 nativeSimulateClick 命中失效（IME 态？）——规避：优先走元素自身 onKeyDown（Enter 提交）或先用 focusElement 重置；scrim 点击只在无输入交互的用例可靠。② SearchDialog Enter 激活里 onClose 与 store.activate 的同批 setState 竞态（激活成功但弹窗不卸载）——测试用 api.set 显式收尾；真窗口 React 18 自动批处理无此问题。
- **测试**：Dialogs.test 新增 6（搜索命中/Enter/空态、管理会话 rename/移除、toast）；WorkspaceList.test 11 用例改弹窗形态（occlude 收尾纪律：开弹窗用例必须关掉，否则吞掉后续用例点击）；WorkspaceEmpty.test Harness 补 relative 容器。app 188（+6）+ e2e 17 全绿；三弹窗 + toast 截图目检（居中/遮罩/actions 右对齐/cwd 展示）。

### Phase W 结论区（W6，原型对齐补遗：工作区起始页 + 行管理菜单）

- **背景**：用户复核发现实现与原型有多处偏差；对齐范围经确认 = 工作区起始页（#1）+ 空组可点引导（#8）+ 会话行 … 菜单/bell 图标/已退出中文化（#9）。侧栏 276px/标题行/底部计数/顶栏面包屑/顶部新建按钮**有意保持现状**（后两者是 W2 定稿的决策）。
- **工作区起始页**：①router 新目标 `{type:'workspace', id}`（路径 /workspace/$id；`ActiveTarget` 联合扩展，`navigateTarget`/`activeTargetFromLocation` 同步；新增 `currentActiveWorkspaceId` 装配读侧）。②store 语义三点：close 归属会话 → 兑底 activate({type:'workspace'})（原 activate(null)，原型「会话移除后回工作区起始页」）；activateWorkspace 空/死 lastSession → workspace 目标（原 null）；removeWorkspace 后若路由仍指向该 workspace → activate(null) 全局兑底（ThreadDeps 新增 `activeWorkspaceId?: () => string | null`，nativeDeps 注入）。③Pane 路由分支渲染 `WorkspaceEmpty`（plane/，非 thread kind 不进 registry）：folder+名称+path+引导文案+「新建 pi 会话」primary（pi 预设 id 查 settings，被删则隐藏）+「选择其他工具」（复用 ToolMenu，anchored 到按钮容器）+ 其余预设快捷 pills；「所有工具从工作区目录启动」说明。顶栏标题 workspace 目标 → 工作区名。新 token `accentHover`（primary 按钮 hover 提亮）。
- **空组引导行**：纯文字「空工作区——点 ＋」→ 可点按钮「创建第一个会话」（testId workspace-create-first-$id，点击 setMenuOpen(true) 复用行 ＋ 的 ToolMenu 链）。
- **会话行（ThreadRow）**：✕ 直删钮 → 「…」管理菜单（anchored end+deferred：重命名→行内编辑、移除会话→store.close；hover/focus/active 可见，键盘 Delete 直删保留，Esc 关菜单优先于取消编辑）；bell 红点 → bell 图标（新 icon）；exited → 已退出。icon 库新增 bell/more（原型 paths 同源）。
- **新发现（GPUIX 事实）**：anchored `occlude` 只是 gpui BlockMouse（阻止命中穿透），**无内建外点关闭**；gpuix 窗口级监听只有 key 事件（RootEventHandlers 无 mouse）→ 菜单打开后除再点 trigger/pick 项外无关闭路径（W2 ToolMenu 既有行为，本轮记录为已知问题；修法需全局 pointerdown 或 anchored 失焦回调，后续专项）。测试面：occlude 层吞点击，开菜单的用例必须 pick 自收敛，否则吞掉后续用例的点击。
- **测试**：WorkspaceEmpty.test 新增 4（渲染/primary spawn/ToolMenu 打开+pick/快捷 pill spawn）；WorkspaceList.test 空组用例改断言+pick 收敛；store.test activateWorkspace/removeWorkspace 用例改 workspace 目标断言（补 activeWorkspaceId 注入）；e2e exited 断言中文化 + close 兑底断言改「工作区起始页」。app 181（+4）+ e2e 17 + tsc/fmt/lint 全绿；TestRenderer 截图目检起始页居中布局与侧栏空组引导。
- **测试**：e2e 12→17；AgentPlane.test +1（⌘K 无 terminal 闭环）；WorkspaceList.test +1（ToolMenu 筛选）；cargo 37→38。app 177 + e2e 17 + cargo 38 全绿。

---

## 验收锚点速查（settings-ui.md §15）

core→1/2/4 · controls→3/5/10/11 · term-notify→9 · presets→7/8 · acp-advanced→6 · 第12条（无障碍）横切随切片验收。
## 硬约束速查（违反 = 返工）

1. 字节流不过 napi（fusion §4-6）
2. `<terminal>` 只在 TerminalSurface.tsx 出现一次；props = sessionId + 外观，spawn 走 createTerminalSession
3. 会话事件走全局 onSessionEvent；元素事件只有 focus/blur
4. destroy() 不动会话（retain 语义在 Pool）
5. initCommand 键入不是 exec：write_to_pty(cmd) + `\x0d`（PowerShell 用 `\r`）
6. 依赖白名单之外新增依赖须先进 architecture.md §11 表
7. 新增设置先上 schema.ts/SETTING_DEFS 再进 UI

---

## Phase G —— Git 树（commit graph；docs/git-graph.md）

- [x] **G1** 数据层：`git/cli.ts`（Bun.spawn 流式 log + LineBuffer + findRepoRoot/showPatch）+ `git/graph.ts`（Zed GraphData::add_commits + to_commit_lines 的 TS 同构移植，含 would_overlap 修正）+ `git/format.ts`（%D 徽章解析 + 相对时间）+ tokens GRAPH_LANE_COLORS 色板
- [x] **G2** 视图与集成：`git/store.ts`（GitGraphStore：mount 幂等/seq 代际/patch 时序丢弃）+ `git/graphSvg.ts`（行内 lane 几何 → 按色分组 svg）+ `git/components/GitGraphView.tsx`（工具条/虚拟列表/diff 详情列）+ `plane/WorkspacePage.tsx`（起始页/Git 图 tab）+ workspaces.paneTab 持久化 + keybindings（Ctrl+Shift+G + gitGraphKey 无修饰层 ↑↓/Enter/Esc/R）
- [x] **G3** 打磨：视口跟随（ref 拿 virtual-list id + scrollToItem seam 注入链 App→Pane→WorkspacePage→GitGraphView）；6 万提交合成压测 0.02s/37.5MB heap/maxLanes=2/零 UNSET 残留；本仓真进程冒烟（流式 chunk/字段形状/顺序不变量）

### Phase G 结论区

- **不 vendor Zed crates**（6.5 万行 Rust 拖半棵依赖树且 UI 是 gpui-Rust）：拿三样——`git log --format=%H%x00%P%x00%D...` + --date-order 流式 chunk 512、lane 状态机逐行移植、光学参数。TS 层 Bun.spawn 直调 git CLI，native/Rust 零改动（D1）。
- **gpuix 事实**：`<svg>` 单色叶子（每色一个 source 叠放，stroke=currentColor）；`<canvas>` 只有元素名无实现；`<diff>`/`<code>`/`<anchored>`/`<virtual-list>` 白捡；virtual-list 行由 gpui list 内部渲染，TestRenderer 拿不到行 bounds（nativeSimulateClick 不可达，点击管线真机验证）。
- **useSyncExternalStore 纪律再次生效**：selector 返回对象字面量 → Maximum update depth exceeded（DiffDetail 初版踩坑，已改整 state + 现算）。
- 合成压测两版拓扑错误（游离提交/sha 冲突）曾伪装成算法 bug——最小复现（10 提交 merge）先证算法正确再修数据。
- 全绿：typecheck + fmt + lint + app 240（新增 graph 11 / format 2+ / cli 12 / store 9 / graphSvg 5 / GitGraphView 3 / keybindings 4）。

---

## 应用图标与打包

- [x] 原创 `>` + 几何 `j` 图标：继承 One Dark 石墨 / accent 蓝，SVG 源稿及多尺寸 PNG、macOS ICNS、Windows ICO 位于 `packages/app/assets/icons/`；深浅底尺寸预览为 `design/app-icon.html`。
- [x] `bun run icons` 可复现生成：`@resvg/resvg-js` **2.6.2**（npm registry `latest` 联网核实为稳定版；仅根开发依赖，无 peer 约束，不改 app 依赖 / Rust crate）。本机 ImageMagick MSVG 渲染器会漏掉 gradient/path/stroke，因此弃用它生成，仅用于独立解码校验。PNG 带来源 / SVG SHA-256，ICO/ICNS 内嵌同一 PNG。
- [x] `scripts/build.ts`：macOS `Resources/app.icns` + `CFBundleIconFile` + 复制后签名；Windows `--windows-icon`，跨宿主提前明确失败（官方文档确认依赖 Windows 资源 API，`--skip-native` 也不能跨宿主嵌图标）。Linux 仍是裸二进制，尚未接 `.desktop`。
- [x] 验证：图标 12 + refs 10 + app 240 测试全过，typecheck / lint / 定向 fmt 通过；`bun run build --app --skip-native`、plutil、ICNS 字节比对、codesign strict 验签、iconutil / ImageMagick 独立解码均通过。
- [ ] Windows 真机 `.exe` 图标与用户 Dock/Finder 外观验收（本机为 macOS，未声称 Windows 已实测）。

---

## 会话日志（每 session 追加一行：日期 · 做了什么 · 下一步）

- 2026-09-02 · 四份契约文档定稿（architecture.md 签名级）；TODOLIST.md 创建 · 下一步：Phase 0 T0.1
- 2026-09-02 · Phase 0 探索（T0.1 git init / T0.2 克隆与对版实验 / vendoring 起步）后应用户要求**整体回滚清空**，项目重头开始（实验结论已存项目记忆 #13）· 下一步：Phase 0 T0.1 重做
- 2026-09-02 · **Phase 0 完成**：T0.1 workspace（exclude .refs）· T0.2 对版确认（fork 8b94def 未漂移；同号 0.2.2 不同 API）· T0.3 crate 骨架（pool=gpui Global 修订 R5 / model 4ms 批处理 / pty=tty+EventLoop）· view vendoring（4 文件 + 2 处 fork API 适配）· T0.4-0.5 window.rs 实测 ConPTY/BEL/OSC/Exit 全过（EXIT 去重修复）· cargo test 30 过 · 下一步：Phase 1 T1.1（bun workspace + 依赖白名单）
- 2026-09-04 · **T1.1–T1.3 完成**：bun workspace（app/native/gpuix-native-alias 三包 + file: 引用 .refs 的 @gpuix/react）· napi 壳（导出合并进单一 .node 实测 ✓；gpuix 5 处本地补丁：pub mod custom_elements / GLOBAL_FACTORIES / RunHost+HOST_UI_COMMANDS / run_on_gpuix / pub GpuixView；installTerminalElement 替代 createRenderer）· app 骨架（main/router/AgentPlane 最小形态）· **R-V1 结论：RouterProvider 不可用**，手动桥（版本号快照 + history 订阅 + router.load() Transitioner 契约）全导航序列实测通过 · 下一步：T1.5 plane/surfaces + T1.6 端到端 + commit Phase 1
- 2026-09-04 · **Phase 1 完成**：T1.5 plane/surfaces 全量（Sidebar/ThreadList/ThreadRow 行内 rename+红点+exited/NewThreadButton 预设菜单/Pane 整块替换/TerminalSurface 唯一 <terminal> 写点/EmptyPresets/tokens/Icon/useThreadStore 直桥）· T1.6 e2e 5 用例全绿（两个真 ConPTY 并存、retain+后台 bell、activate 清红点、exit 灰行+close、**焦点结论：无需降级**）· 重大修复：TSF 两参坑（事件自 T1.2 起全部被静默丢弃）· gpuix 补丁 #6/#7（run_on_test_app + host_ui_commands_ready）· napi 同步化（test 路径 thread_local）· 下一步：Phase 2 T2.1（ThreadStore 补测试面）→ T2.2 settings 三切片
- 2026-09-04 · **架构审查修复（improve-codebase-architecture 五候选全部落地）**：① 删除 crates/jagent-terminal/src/element.rs 死模块（TerminalFactory 零引用，元素实现唯一住所 = packages/native/element.rs）· ② native 壳深化：TERM/COLORTERM 默认 env 下沉 pty.rs（壳回纯协议镜像）+ 新 host.rs（run_host<T> 一个 interface 两 adapter，serde_json 装箱收敛一处）+ set_style 幂等（PartialEq 比较，消除每帧无效 notify；element.rs 注释与实现对齐）· ③ tokens 收编全部裸 hex（COLORS +surface/surfaceHover/inputBg/closeHover，组件零裸 hex）· ④ 提取 threads/nativeDeps.ts 装配工厂（main/e2e 同一布线，差异项覆盖；§1.2 native 收口清单同步修订）· ⑤ threads/events.ts 判别联合窄化（narrowSessionEvent 边界映射，store 消费 switch 穷尽）+ **exit code 贯通**（alacritty ChildExit 带码：model 区分 ChildExit/Exit 先到先转发 → SessionEvent::Exit{code} → napi → store.exitCode，契约 §2.2 不再漂移）· 验证：cargo test 30 过 + bun test 13 过 + e2e 5 用例全绿（真 PTY）· 下一步：Phase 2 T2.1
- 2026-09-04 · **T2.1 + T2.2 完成**：T2.1 补齐 ThreadStore 测试面（17 用例：exitCode/cycle 无 active/未注入回退/spawn 传参+cwd 同源/title 空串；含 cycle n-2 怪分支行为修正）· T2.2 settings 三切片落地（schema：looseObject+叶子 catch+section prefault+11 defs；file：fsAdapter 原子写+mkdir 自建+memoryAdapter；store：gen 合并写+persisted 回滚锚点+writeError 时序；17 用例含未知 key 往返/越界回默认/合并写/失败作废）· fsAdapter 真盘验证抓 ENOENT 缺陷并修 · tsc 干净 + 39 测试全绿（34 单测 + 5 e2e）· 下一步：T2.3（ui/ 原子）→ T2.4（SettingsView）
- 2026-09-05 · **T2.3 完成**：12 个 ui/ 原子（Tooltip 封装 @gpuix/react Tooltip 族 / SelectField 封装其 Select 族 / Toggle+RangeInput+IconButton 自绘（GPUIX 无这些原生元素）/ NumberInput draft+stepper / TextInput / Textarea / Badge+PhaseBadge / SettingRow 声明式行 / style.ts focusRing / Icon 扩 reset/search/chevronUp）· tokens 迁 ui/（§1.2 ui 零依赖）· **重大发现：GPUIX 事件不冒泡**（hit-test 命中 deepest，父 handler 收不到子元素区的点击；Phase 1「冒泡注记」是误解，suppressClick 已删）；修复模式 = 装饰层 pointerEvents:'none'，连带修好 ThreadRow/EmptyPresets/NewThreadButton/Sidebar 的点文字失效 bug，e2e 第 6 用例锁定 · 50 单测 + 6 e2e 全绿 · 下一步：T2.4（SettingsView）
- 2026-09-05 · **T2.4 完成**：SettingsView/SettingsSections/useSettings 订阅桥/router 深链 hook · Term/Notify/Appearance/Advanced 行接真值（patch 落盘+modified+reset+writeError 红条实测）· 搜索全链（过滤/计数/置灰/空态/清除/Esc/highlight wash 高亮）· Presets/ACP Phase 3 占位卡 + Keybindings 只读表 + CLI 约定卡 · main.tsx await init（首次运行零写盘验证）· App props 增 settings，e2e 同步 · 59 单测 + 6 e2e 全绿 + 真窗口冒烟 · 下一步：T2.5（桌面通知定型 + 接线）
- 2026-09-05 · **T2.5 完成**：桌面通知定型为 Rust 自研 WinRT toast（notify.rs：AUMID+开始菜单 .lnk+手拼 XML，零新增 crate；notify-rust/node-notifier 均借 PowerShell 身份被否）· 真机冒烟：toast×3+快捷方式落盘 ✓ · 接线：nativeDeps(settings) 签名扩展（notify/closeOnExit/scrollback 真值）· SurfaceProps+settings · TerminalSurface 读 useSettings 四项（palette/cursorBlink/fontFamily/fontSize）· Rust：TerminalStyle 增 palette/cursor_blink、colors by_name（one-dark 色板）、view blink 定时器、element TODO 清偿 · e2e 第 7 用例（设置→props 联动+sessionId 不变）· 66 单测+7 e2e+cargo 33 全绿 · 下一步：T2.6（全局键位层）
- 2026-09-05 · **T2.6 + T2.7 完成（Phase 2 收官）**：键位层提取 keybindings.ts（DI 形态 main/e2e 共用）· Esc 双跳时序实测（React 同步提交→「已消费」标记方案）· 关闭设置回 lastNonSettings（router 桥维护）· `/` 聚焦走 ref 取 id（autoFocus 不发 JS focus 事件）+ renderer.focusElement · ui/keyboard.ts 输入焦点登记 · main.tsx 自持 renderer 实例 · e2e 第 8 用例（全量跑 threads 遗留污染→数组序断言）· §15 锚点 1/2/3/4/5/9/10/11 逐条核对达成 · 67 单测+8 e2e+tsc+cargo 全绿+真窗口冒烟 · architecture.md 契约同步（SurfaceProps/keybindings/键位层修订）· commit "Phase 2" · 下一步：Phase 3 T3.1（Presets 分区 CRUD）
- 2026-09-05 · **T3.1 完成（settings-presets 切片）**：SettingsStore 预设 CRUD 五方法（规则单点：plusDefault 删除回退/内置不可删/副本后缀/空字段归一+args 空行过滤，同一写链回滚面）· PresetsSection 实装（plusDefault Select + 列表卡 CRUD + 六字段编辑器 + 搜索过滤，占位卡换下岗）· LinesField 即时提交模式（提交不依赖 blur）· **三大平台发现回写记忆 #29**：listener 冒泡（抑制 ref 模式）/ TestRenderer 不派发 focus/blur / textarea enter=Submit shift-enter=换行 · 接线面全换 settings 快照（NewThreadButton/EmptyPresets/presetOf/hitsBySection）· e2e 第 9 用例（自定义预设真 PTY 全链）· 87 单测+9 e2e+cargo 33 全绿 · 下一步：T3.2（ChatSurface）
- 2026-09-05 · **T3.2 + T3.3 完成（Phase 3 收官）**：chat 后端拍板（EchoAgent + ChatAgent seam；入口 = + 菜单固定 New Chat 项）· threads/chat.ts（接口 + EchoAgent 600ms）· store 扩展（createChat/sendChatMessage 状态机/首条消息改标题/rename 兼 chat/close 弃迟到回复；ThreadDeps.chatAgent）· ChatSurface 实装（顶栏 pill + virtual-list followTail + markdown assistant + composer enter=Submit）· 平台发现回写记忆 #29（keystroke 中间空格也吞/markdown 不进 getAllText/点击抢焦点）· 单测 92 + e2e 10 全绿 · architecture.md 同步 · commit "Phase 3" · 下一步：Phase 3+ T3+.1（ACP Agents 分区 + AcpSurface）
- 2026-09-05 · **T3+.1 完成（ACP 接入）**：ACP v1 协议调研（稳定版 v1；stdio 行分隔 JSON-RPC；initialize→session/new→session/prompt + session/update 流式；request_permission 自动应答）· threads/acp.ts 自研零依赖客户端（AcpConnection=ChatAgent+dispose；情建握手/收集器拼装/进程错误带 stderr 尾/Windows .cmd shim 需 shell:true）· store chat/acp 同构状态机单点（AcpThread 完整化 + autoTitle 哨兵 + 连接情建/close dispose）· SettingsStore ACP CRUD 三方法 + AcpAgentsSection（占位卡下岗）+ 搜索动态化 · ConversationView 提取（chat/acp 共享）· NewThreadButton agent 项 · fake-acp-agent.ts 七模式假 agent 真子进程测试 · 单测 114 + e2e 11 + cargo 33 全绿 · 下一步：T3+.2（Advanced 分区 + 键位编辑解锁）
- 2026-09-05 · **T3+.2 完成（键位可编辑 + Advanced 分区）**：schema 增 keybindings section（四动作叶子 catch 默认）· keybindings.ts 键位参数化（keys getter 注入即时生效 + keystrokeMatches 导出；Esc/菜单键为平台语义不参与配置）· settingsKeyboard 提取独立模块（搜索框与键位捕获格双 Esc 消费源，避免循环 import）· KeybindingsSection 捕获式改键（点击/enter 进入 → 组合即时写入；语义约束校验 cycle*/toggle 必含 ctrl、focusSearch 必无修饰；冲突双方警示；蓝点+reset）· AdvancedSection（诊断卡[版本/GPUIX pin/平台] + settings.json 实时视图 markdown code block + 「在编辑器中打开」openInSystemApp 仅真盘 adapter）· file.ts FileAdapter.path + openInSystemApp · store filePath()/serializeSettings · 搜索键位命中动态化（keybindingHits 吃快照）· e2e 第 12 用例（改键 ctrl-. 即时生效 + JSON 视图 + 动态命中；Esc×2 收尾）· 平台发现：GPUIX 组合键不产生文本输入/tab 是焦点移动键（测试搜索断言避开）· 单测 117 + e2e 12 全绿 · 仓库推 github.com/wxj123654/jagent-terminal
- 2026-09-06 · **自绘顶栏（Zed platform_title_bar 模式移植，三平台）**：gpuix 补丁 0002 扩展（UiCommand::StartWindowMove/TitlebarDoubleClick + napi startWindowMove()/titlebarDoubleClick() + StyleDesc.windowControlArea→gpui window_control_area + build_host_container 应用）；TS 类型面最初在补丁 0004，**2026-09-09 已迁到项目 `gpuix.d.ts`** · app 侧 TitleBar.tsx（mac：armed+首次 move 才 startMove 的 Zed should_move 模式 + 双击 zoom；win：整条 windowControlArea:"drag" + 右侧三键 Segoe Fluent 图形 min/max/close 全部 NC 命中测试零 JS 回调，按钮 pointerEvents:auto 切断外层 drag 命中链（对齐 Zed .occlude()）；linux：Server decorations 系统标题栏在上，本条退化为内容导航条）· SidebarHeader 承担 mac 红绿灯让位（Zed 融合模式：让位宽在这一段，AGENT 文本 marginLeft=71+12）· main.tsx titlebarTransparent=非 linux + WindowControls 注入 seam（闭包 renderer，测试 spy）· **gpuix 布局陷阱：横向 flex item 不吃 padding 占位（paddingLeft 会让段落从 x=83 起步把 TitleBar 推出窗口），内缩改用子项 margin** · getElementBounds 语义：x/y=content-box 起点、w/h=盒宽（右缘断言要用绝对窗口宽）· 测试基建局限：click_count 恒 1，双击→zoom 只能真机手验 · 平台常量去平台化：TRAFFIC_LIGHT_WIDTH=71 纯常量（组件按注入 platform prop 决定让位，测试可跨平台断言）· 单测 125 + tsc + oxfmt + oxlint 全绿；双击 zoom/拖拽手感/红绿灯让位待真机验收 · 下一步：真机验收 + linux CSD（windowDecorations 选项 gpuix 未暴露，后续可扩）
- 2026-09-04 · **macOS 适配（窗口不上屏根因修复）**：新 Mac 上 `bun run dev` 窗口创建但永不上屏 · 三连环修复：① Metal 工具链缺失（Xcode 15+ 需单独下载：`xcodebuild -downloadComponent MetalToolchain`）② `alacritty_terminal` 0.26 无 `child_signal_mask` 字段（代码写超前，上游未发版；删掉等价于默认行为的 `None` 行）③ **根因：gpuix `render()` 帧循环条件 `!injected && instanceof GpuixRenderer`** —— 当时 main.tsx 显式传 renderer（闭包引用 focusElement）被 injected 分支跳过 startFrameLoop，Windows 无恙（GPUI 自跑阻塞循环）但 **macOS 上 tick() 是唯一 AppKit 泵** → 窗口记录存在但 kCGWindowIsOnscreen=false 永不显示。当时先去掉 `!injected` 固化为补丁 0003；**2026-09-09 第一批收缩已删除该补丁**，改为项目 `appWindow.ts` 用公开 `startFrameLoop` 泵同一 injected renderer。踩坑记录：bun workspace file: 依赖悬空 symlink（重跑根目录 bun install 即愈）；**进程诊断陷阱：pgrep -f 匹配到 bash wrapper（命令行含同样字符串）导致 CPU/窗口全查错对象，CGWindowList/osascript AX 受 TCC 权限影响结果飘忽，窗口在屏与否最终以用户眼睛为准**
- 2026-09-05 · **下拉菜单浮层修复（NewThreadButton 背景被列表盖住）**：用户截图报菜单「无背景色」· 诊断：最小复现（e2e 临时脚本 + TestRenderer captureScreenshot）证明 absolute div 布局/样式链路全正常（bounds 正确、bg 解析正常），但**真实 sidebar 结构下后画的 ThreadRow 盖住先画的 absolute 菜单**——GPUI 按树序绘制，无 CSS stacking context，absolute 不提升层级（active 行不透明 surface 块盖住菜单区域 + 透明行文字叠在菜单上 = 截图症状）· 修复：菜单换 gpuix `<anchored>` 自定义元素（`gpui::anchored` + `gpui::deferred` priority 浮层，画在所有内容之上；architecture.md §5.3 本来就写的「anchored 菜单」，是实现偏离了设计）——side=bottom align=start gap=4 deferred occlude，面板样式（bg/border/radius/padding）上移到 anchored style，宽度从「inset 拉伸=trigger 宽」改为内容宽 + minWidth 200 / maxWidth 侧栏内宽（anchored 不支持 inset 拉伸）· anchored 工厂 gpuix 默认注册开箱即用，JSX 类型 @gpuix/react 内置 AnchoredProps（无需 augmentation）· 验证：tsc + 119 单测全绿 + e2e T3.2/T3+.1/T3+.2 菜单全链通过 + captureScreenshot 视觉确认（面板 bg/border/分隔线完整、无重影）；T1.6 4 fail 为基线既有 macOS 平台差异（powershell fixture）非本次引入 · 平台发现：anchored 无 fill 时 native 强制 bg 0x1A1A1A 兜底（deferred 层画在 window blur 之上，透底坑他们踩过）
- 2026-09-05 · **终端输入修复（中文 IME + pi 软光标）**：用户报「无法输入中文、pi 看不到光标，Zed 终端正常」· 诊断：① 无 InputHandler → macOS IME 组合文本（setMarkedText:）无接收点被静默丢弃；② pi 默认隐藏硬件光标（showHardwareCursor=false）用 SGR 7 反色 cell 画软光标，而渲染器不处理 Flags::INVERSE（fg/bg 不交换 → 深色主题下光标块隐形）· 修复（对齐 Zed terminal 架构，双平台同构）：可打印字符不再 key_down 直写 PTY（input.rs 返回 None 不消费 → 平台文本路径 macOS insertText/Windows WM_CHAR → view.rs TerminalInputHandler::replace_text_in_range 写 PTY；组合文本 replace_and_mark → ime_state，画在光标处下划线+背景，期间隐藏硬件光标；候选窗 bounds_for_range=光标+cell_width×utf16 偏移；window.handle_input 在 canvas paint 闭包注册）· render.rs layout_row INVERSE 交换 fg/bg + paint 加 marked_text 参数 + cursor_bounds() · 顺手修：cmd/platform 修饰误写 PTY bug、6 个 vendoring 遗留 doctest crate 名（gpui_terminal→jagent_terminal + lib.rs re-export keystroke_to_bytes）、打字重置闪烁相位 · 37 lib + 6 doc + napi 编译全绿 · 架构知识存记忆 #5（双路径输入模型）· 用户真机验收通过（中文输入 + pi 光标可见）
- 2026-09-09 · **红绿灯绿色按钮符号**：暗色 UI 跟系统浅色时，AppKit 用 Aqua 画 zoom 符号（发灰/发白）。对齐 Zed `init_app_appearance`：窗口 init 后 `App::set_window_appearance(Dark)` → DarkAqua。走现有 `run_host`，不扩 gpuix patch。
- 2026-09-09 · **标题栏对齐 Zed Tahoe**：用户对照截图后，红绿灯让位仍按旧值 71，AGENT 贴灯、标题光学偏上。按 Zed `TRAFFIC_LIGHT_PADDING`（SDK 26+ = 78）改为 Darwin ≥ 25 用 78；顶栏整行（含 SidebarHeader）统一 `COLORS.titlebar`；标签 `marginTop:1` 光学下移。测试按常量断言 label x=`TRAFFIC_LIGHT_WIDTH+12`。
- 2026-09-09 · **gpuix 补丁第一批收缩**：删除 gpuix 0001（浅克隆改 `.gitmodules`，setup 已 `--depth 1`）/ 0003（帧循环改上游 `render()`）/ 0004（标题栏 TS 声明）以及 0002 内 input `vertical_offset`；新增 `packages/app/src/appWindow.ts`（公开 `startFrameLoop` 生命周期：复用同一 renderer、热重载停旧循环、关窗退出、`stop()` 清理）与 `gpuix.d.ts`（`declare module '@gpuix/react'` 增补 `windowControlArea` / `startWindowMove` / `titlebarDoubleClick`）；`scripts/refs-state.ts` 供 setup/export 共用，检查两仓 pin、实际补丁、staged、未管理改动、多余 patch、必需 dist 存在性。e2e T1.6 的 PowerShell fixture 改为本机 `process.execPath` + `e2e/__fixtures__/bell.ts` 文件握手（切后台后再发双 BEL）。验证：app 130 / e2e 12 / refs-state 10 全绿、typecheck、export --check、setup 快速路径通过。未实施：标题栏原生迁项目、workspace 归属实验、Windows 测试窗隐藏替代、factory drain 多 renderer 契约。下一步：第二批标题栏迁出。
- 2026-09-08 · **设置界面 input 布局修复（贴顶/重叠/溢出三连）**：用户报「设置界面 input 布局有问题」· 诊断：e2e 临时脚本（TestRenderer captureScreenshot，复刻 terminal.e2e.test.tsx 装配 + navigateSettingsSection 逐分区截图）+ PNG 逐行像素扫描（文字 y 范围 vs 框 y 范围）量化——**所有单行 input 文字贴顶**（pad_top 3-6px vs pad_bot 24-28px @2x）；Presets 展开表单 InitCommand 行 label 列溢出盖住 input；ACP 分区整块超宽（描述 text max-content 撑开 column 链，垃圾桶图标切半）· 根因与修复（全部工程内，未动 .refs）：① 单行 input 贴顶 = native input 文字元素是 measured 布局、高度恰为一行（EditorTextElement clamp 到 line_height，vertical_offset 恒 0——记忆 #9 的 native 修复对单行 input 天然失效），壳样式（28 高/border/bg/padding）压在 input 自身上时该行顶对齐盒顶；照 gpuix 官方 example-app composer 模式重构 TextInput：**视觉壳外置到 div（alignItems center），input 本体只 flexGrow 放文字**；NumberInput 外层 alignItems stretch→center + 步进列 alignSelf:stretch ② FieldRow label 列（130px）装不下 InitCommand+initCommand → key 文字 minWidth:0+ellipsis 截断（web 原型靠 input 不透明背景盖住溢出，GPUIX 树序不同必须自己截）③ ACP 根 div 加 minWidth:0（覆盖 flex item min-width:auto，否则 text max-content 一路撑开 scroll 链），whiteSpace normal 需要确定宽约束才 wrap；Presets 底部说明同补 whiteSpace · 验证：像素扫描 offset -11px→-2px（字形自然分布）、截图逐分区目检、tsc+125 单测+oxfmt/oxlint 全绿、e2e 8 pass（T1.6 4 fail 为既存 macOS powershell fixture 基线）· 下一步：真机验收
- 2026-09-06 · **工作区与多 TUI 交互原型**：用户确认独立 HTML + Codex 式工作区分组，新增 `design/workspace-plane.html`；工作区展开/切换、恢复最近会话、cwd 继承、pi/Claude Code/Codex CLI/Shell/lazygit/yazi/btop/自定义命令、新建/搜索/重命名/移除、BEL 示例清除、草稿保留及窄屏抽屉。全部模拟，不访问文件系统、不执行命令、不连接模型；未改原生应用与 `.refs`。`design/workspace-plane.test.mjs` 复用已有 Playwright + Chrome，10 组通过、0 运行时错误，截图覆盖桌面/紧凑/窄屏及工具关键状态；独立 reviewer 代行 finish-reviewer，结论 ship（原型范围）。设计记录位于 `design/PRODUCT.md`、`design/DESIGN.md`，操作说明 `design/workspace-plane.md`。检索返回 FAQ 落地页模板，不适用于本任务，未采用；保留既有深色系统。检测器 HTML parser 缺失降级 regex，不将空结果当完整认证。下一步：用户评审原型后，再决定正式工作区状态与原生 UI 落地。
- 2026-09-06 · **原型两轮迭代**：①新建会话弹窗布局修复（用户报「元素有点乱」）：工具项与自定义命令统一 3 列网格对齐、弹窗框架固定高度仅列表内滚（消除筛选/空态跳动）、自定义命令拆入固定 footer 常驻、工作区行横排压紧 + cwd 单行省略；新增 `design/workspace-dialog.test.mjs` 回归（4 视口几何断言）。②添加工作区本地目录选择（用户要求「本地选择而不是输入」）：「浏览…」按钮，showDirectoryPicker 优先、webkitdirectory 回退（实测回退路径触发正常），选择后自动填路径与名称。下一步：任务拆分已进 TODOLIST Phase W（W0–W5），等用户评审原型后开工。
- 2026-09-06 · **Phase 3+ 收官（T3+.3）**：§15 第 6 条锚点核对达成（JSON 实时视图与写盘同源 + e2e 第 12 用例锁定；「在编辑器中打开」darwin open 分支实测 + memory 无 path 不渲染）· 全量：app 134 + e2e 12（macOS 全绿）+ cargo 37 + tsc/fmt/lint 干净 + 真窗口冒烟 · 工作区原型补入库（design/ 6 文件 + .impeccable gitignore）· 下一步：Phase W W0（用户评审工作区原型）
- 2026-09-06 · **Phase W 开工：W0 定稿 + W1 数据层完成**：W0 = 两轮迭代验收 + 用户放行 · W1 = threads/workspaces.ts（Workspace 类型 + state.json zod schema 逐行容错 + defaultWorkspace/workspaceSessions）+ ThreadStore 改造（平铺+workspaceId 归属不嵌套、cwd 链 preset.cwd→workspace.path→CWD、activateWorkspace 恢复 lastSession/死 id 回起始页、removeWorkspace 连锁 close、persistWorkspaces fire-and-forget）+ main.tsx state.json 装配（首启只读不写，空/损坏→默认工作区）· zod array.catch 整组回退坑（单行坏抹全部→逐行 safeParse）· 测试 workspaces 8 + store 13 新增，存量 31 零改动全过；app 155 + e2e 12 + tsc/fmt/lint 全绿 · 下一步：W2（侧栏工作区分组树 UI）
- 2026-09-06 · **W2 完成（侧栏 UI）**：Sidebar 改工作区分组树（WorkspaceList：WorkspaceGroup 行[箭头 toggle 不激活/点行恢复 lastSession/双击 rename/hover 移除] + ThreadRow indent 缩进 + 空工作区引导 + AddWorkspaceForm 内联表单）· ToolMenu（NewThreadButton 演化：目标工作区头 name+cwd + 预设/New Chat/ACP 全带 workspaceId）· 搜索（searchThreads 四路命中 + 结果行 suffix 工作区名）· uSES 快照稳定性坑（selector 新数组炸 → 稳定引用 + 渲染期现算）· e2e 迁移（装配默认工作区 + spawn 归属 + 菜单 testId）· WorkspaceList.test 9 + searchThreads 2 新增；app 166 + e2e 12 全绿 · 下一步：W3 目录选择 seam
- 2026-09-06 · **W3 完成（目录选择 seam）**：gpuix 盘点零 dialog 导出 → packages/native/picker.rs 自建（mac NSOpenPanel 主线程模态 / win IFileOpenDialog detached STA；TSF NonBlocking 防 JS 线程死锁；windows crate features 零新增）· prop 注入链 main→App→Sidebar→WorkspaceList→AddWorkspaceForm（未注入隐藏按钮）· 浏览后填 path+空名自动 basename · WorkspaceList.test +1（fake picker 全路径）· app 167 + e2e 12 + cargo 37 全绿 · NSOpenPanel 真交互待用户真机验收 · 下一步：W4（⌘K/Ctrl-K + Esc 层级 + 窄窗口抽屉）
- 2026-09-06 · **W4 完成（空态与键盘）**：keybindings 增 searchThreads（⌘K/Ctrl-K 聚焦侧栏搜索；keystrokeMatches 扩 cmd 语法；设置面不劫持；platform 修饰不写 PTY 零冲突）· Esc 层级定稿（编辑态→清 query→关抽屉→no-op；无元素级 blur API）· 窄窗口抽屉 760px（useWindowSize + 树序后画覆盖层 + 汉堡钮 Icon menu + scrim/Esc 关）· KeyCap 捕获格支持 cmd-· keybindings.test 5 + AgentPlane.test 3 · app 175 + e2e 12 全绿 · 下一步：W5（工作区面 e2e 收口）
- 2026-09-10 · **Phase G 完成（Git 树只读 graph）**：调研 Zed git 三层（git CLI 数据层/git_store 协调层/git_ui 视图层 6.5 万行）→ 设计 docs/git-graph.md（用户拍板 workspace 内 tab + 一期只读）→ 落地 G1 数据层（cli.ts 流式 Bun.spawn + graph.ts lane 状态机同构移植 + format.ts）→ G2 视图（GitGraphStore/graphSvg 按色分组 svg/GitGraphView + WorkspacePage tab + workspaces.paneTab + Ctrl+Shift+G 与 gitGraphKey 键位层）→ G3 打磨（scrollToItem 视口跟随 seam 链、6 万提交压测 0.02s/maxLanes=2/零残留）· 全绿 typecheck/fmt/lint/app 240 · 坑：DiffDetail selector 对象字面量炸 uSES（改整 state）；合成数据拓扑错曾伪装算法 bug（最小复现先证清白）；TestRenderer 拿不到 virtual-list 行 bounds（点击管线真机验）· 下一步：用户真机验收（Ctrl+Shift+G → Git 图 tab），G4 status/commit 另立设计
- 2026-09-10 · **Phase G 视觉自验收官**：TestRenderer captureScreenshot 两轮（graph + 选中详情）· **重大发现：gpuix `<virtual-list>`/`<diff scroll>` 列表元素不吃 flexGrow/absolute 对边拉伸，只认显式 height**（A–E 五组对照实验锁定；chat 的 ConversationView 消息区同构同病，真窗口行为待用户验证）· 修复：列表高度 = useWindowSize() 减已知 chrome（顶栏/tab 条/工具条/错误条），行宽 = 窗口宽 − 详情列，diff 体同理 · 详情列 `<diff>` 在 TestRenderer 不绘制（native custom element 同 markdown 限制）→ 一期自绘 DiffBody（逐行着色，文件头 muted/@@ accent/+绿/−红，---/+++ 前缀判断须先于 -/+）· lane 几何/merge 曲线/main 徽章/选中高亮/三列对齐截图全过 · 排障教训：连续 python 字符串补丁错位导致「实验状态漂移」（A–E 的 style 残留叠加），5 轮黑屏假象；二分时先核对文件实际状态再改 · app 240 + e2e 17 + typecheck + lint + fmt 全绿 · 待用户真机：Ctrl+Shift+G 实测 + chat 消息区是否同样需要高度修复
- 2026-09-06 · **W5 完成（e2e 收口，Phase W 收官）**：原型清单全项对齐（草稿保留=PTY retain 不移植；工具筛选本轮补 ToolMenu 筛选框）· e2e 12→17（Phase W describe：归属/cycle/恢复/移除/⌘K 路由）· **ctrl-tab 真 bug 修复**（终端聚焦时被当 \\t 写 PTY → 会话切换失效；input.rs ctrl+tab 返 None 透传 root；cargo 38）· removeWorkspace 语义定稿（回起始页）· 已知问题记录：terminal 在场 GPUI 焦点帧后抢回（TestRenderer programmatic focus+打字丢键；真窗口待手验）· app 177 + e2e 17 全绿
- 2026-09-06 · **应用图标完成**：原创石墨底 `>` + 蓝色几何 `j`，SVG/九档 PNG/ICNS/ICO 入库，`bun run icons`（resvg 开发依赖）可复现，`design/app-icon.html` 深浅底+小尺寸预览；macOS `.app` 资源与 plist 接线、Windows `--windows-icon` + 跨宿主明确拒绝；12 图标 + 10 refs + 240 app 测试、tsc（含 scripts）、lint/fmt、macOS build/plist/字节比对/strict 签名/独立解码均通过。独立 reviewer 代行 finish-reviewer，结论 ship（资产与本机范围），无阻塞项；未改 .refs、未重编 Rust。下一步：用户视觉确认；Windows 发布前真机验证 Explorer 图标。
