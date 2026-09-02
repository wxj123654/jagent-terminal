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
| 1 双 workspace + napi 壳 + app 最小集 | ⬜ 未开始 |
| 2 ThreadStore 全规则 + settings-core/controls + SettingsView | ⬜ 未开始 |
| 3 settings-presets + chat | ⬜ 未开始 |
| 3+ settings-acp-advanced + ACP + 键位编辑 | ⬜ 未开始 |

**当前指针**：→ Phase 1 / T1.1（前置：`.refs/` 已就绪；新环境需先克隆，见 Phase 0 结论区的 workspace exclude 说明）
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

- [ ] **T1.1** 根 `package.json`（bun workspace：`packages/*`）+ `packages/app/package.json` + 依赖白名单安装（@gpuix/react · @jagent/native · zustand · @tanstack/react-router · zod · immer · dequal）
- [ ] **T1.2** `packages/native`：napi-rs 壳（lib.rs：createRenderer（gpuix 装配 + registry.register(TerminalFactory) + init_zed_subsystems）/ createTerminalSession / destroyTerminalSession / onSessionEvent）；`<150 行`纪律，index.d.ts 生成
- [ ] **T1.3** app 骨架：`main.tsx`（装配 + renderer 事件桥）· `router.ts`（memory history；/ · /thread/$id · /settings?section=$s；useActiveTarget）· R-V1 验证并记录结论
- [ ] **T1.4** `threads/store.ts` 最小集（spawnFromPreset / activate / close + 依赖注入类型 ThreadDeps）+ bun test（fake deps，§3.4 用例集的最小子集）
- [ ] **T1.5** `plane/`（AgentPlane/Sidebar/ThreadList/ThreadRow/Pane）+ `surfaces/registry.ts` + TerminalSurface（全项目唯一 `<terminal>` 写点）
- [ ] **T1.6** 端到端：两个 PTY 并存、切 thread 不销毁后台会话（retain 语义）、焦点模型结论（GPUIX 焦点事件到达顺序 → Ctrl-Tab 可用性，记录降级与否）
- [ ] **T1.7** git commit "Phase 1"

### Phase 1 结论区

- R-V1（RouterProvider@GPUIX）：_未填写_
- 焦点模型（Ctrl-Tab 生效条件 / 是否降级）：_未填写_

---

## Phase 2 —— ThreadStore 全规则 + settings 三切片 + SettingsView

> 锚点：设置契约 §15 第 1–5、9–11 条；桌面通知实现定型（node-notifier vs Rust win32 toast）。

- [ ] **T2.1** ThreadStore 全规则 + bun test 全用例（§3.4：bell→红点→激活清除 · customTitle 冻结 · exit 灰行 vs closeOnExit 移除 · cycle 环形 · close 先导航离开 · displayTitle 四级兜底）
- [ ] **T2.2** settings 三切片：`schema.ts`（zod looseObject + 字段级 catch + SETTING_DEFS）· `file.ts`（fsAdapter 原子写 + memoryAdapter）· `store.ts`（patch/reset/isModified/writeError 回滚时序）+ §6.3 测试面
- [ ] **T2.3** `ui/` 原子（Icon/Tooltip/SettingRow/Toggle/Select/NumberInput/RangeInput/TextInput/Textarea/Badge/PhaseBadge/IconButton）
- [ ] **T2.4** SettingsView（SettingsNav 7 分区 + 搜索 + SettingRow 声明式渲染 + 分区深链）——Term/Notify 分区接真值；Presets/ACP 显示 Phase 徽章
- [ ] **T2.5** 桌面通知定型 + 接线（bell → 非激活 → notify；读 settings.desktop 在装配层）
- [ ] **T2.6** 全局键位层（Ctrl-Tab/Ctrl-Shift-Tab → cycle；Ctrl-, toggle 设置；只吃修饰键组合）
- [ ] **T2.7** 验收锚点核对（§15：1/2/4 core · 3/5/10/11 controls · 9 term-notify）+ commit "Phase 2"

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
