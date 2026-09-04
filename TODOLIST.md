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
| `design/*.html` | 两个 HTML 原型（布局/设置），样式对齐用 |

## 进度看板

| Phase | 状态 |
|---|---|
| 0 Rust 终端骨架 + window.rs 验证 | ✅ 完成（结论见 Phase 0 结论区） |
| 1 双 workspace + napi 壳 + app 最小集 | ✅ 完成（结论见 Phase 1 结论区） |
| 2 ThreadStore 全规则 + settings-core/controls + SettingsView | ✅ 完成（T2.1–T2.7） |
| 3 settings-presets + chat | ⬜ 未开始（下一入口：T3.1） |
| 3+ settings-acp-advanced + ACP + 键位编辑 | ⬜ 未开始 |

**当前指针**：→ Phase 3 / T3.1（Presets 分区 CRUD：自定义预设 id + builtin:false + cwd?；lastUsedPreset 运行时态不进 JSON）
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

- [ ] **T3.1** Presets 分区 CRUD（自定义预设：id + builtin:false + cwd?；lastUsedPreset 运行时态不进 JSON）
- [ ] **T3.2** ChatSurface 实装（chat thread 骨架 → 最小可用）
- [ ] **T3.3** 验收锚点（§15 第 7–8 条）+ commit "Phase 3"

## Phase 3+ —— acp/advanced/键位

- [ ] **T3+.1** ACP Agents 分区 + AcpSurface（ACP JSON-RPC 子进程）
- [ ] **T3+.2** Advanced 分区 + 键位编辑解锁（第一期只读 → 可编辑）
- [ ] **T3+.3** 验收锚点（§15 第 6 条）+ commit

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
