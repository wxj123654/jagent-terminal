# j-agent 统一错误管理方案设计

> 状态：**已实施**（方案 A + B + C + D）
> 设计日期：2026-09-08 · 实施：2026-09-11
> 背景问题：当前任何未捕获错误（JS 异常 / React render 错误 / unhandled rejection / Rust panic）
> 都可能导致应用直接崩溃或窗口无声消失，且错误发生后无处可见、无处可查。

## 一、现状诊断：错误从哪里把应用搞崩

盘点了 `packages/app`、`packages/native`、`crates/jagent-terminal` 后的崩溃面：

| # | 崩溃路径 | 现状 | 后果 |
|---|---------|------|------|
| 1 | JS 未捕获异常 / unhandled rejection | 没有任何全局钩子（无 `process.on('uncaughtException')`） | bun 对齐 Node 语义：打印 + `exit(1)`，窗口直接消失 |
| 2 | React render 错误 | 没有 ErrorBoundary | React 卸载整棵树 → 空窗口或死帧循环 |
| 3 | `void sendConversationMessage(...)` 类 fire-and-forget | store 多处 `void` 调用，reject 路径未完全收口 | 变成 unhandled rejection → 同 #1 崩溃 |
| 4 | napi 命令内的 Rust panic | 无 `catch_unwind`；crates 内 49+ 处 `unwrap()/expect()` | napi-rs 官方明确：panic 不是 FFI 边界的合法错误，同步回调里的未捕获 panic 可终止进程 |
| 5 | GPUI 渲染线程 panic（Windows） | `host.rs` 的 `run_host` 闭包直接跑在 GPUI 线程上，无 panic 防护 | 渲染线程 unwind → 整进程 abort，JS 完全无感知 |
| 6 | 错误可见性 | 57 处散落 try/catch：`console.warn` / 静默吞 / TSF 的 err 槽从不填充 | 用户看不到发生了什么，日志无处可查 |

### 调研依据

- **napi-rs**：期望失败应走 `napi::Result<T>`（JS throw/reject）；panic 需 `#[napi(catch_unwind)]`
  显式捕获且只覆盖该边界；自定义错误码用 `Error<S: AsRef<str>>` → `error.code`；建议用
  `cause` 链而非拼接字符串。来源：<https://napi.rs/docs/concepts/error-handling>
- **Zed 的 crashes crate**：panic hook + signal handler + minidumper sidecar 子进程。panic 时
  先 IPC 把消息发给 sidecar，再主动 `simulate_exception` 生成 minidump 后 abort；崩溃数据
  由 sidecar 写盘（session_id / 版本 / panic span / tags），下次启动时读取并上报。核心洞察：
  **崩溃后进程内什么都不可信，报告必须在进程外**。
  来源：<https://github.com/zed-industries/zed/blob/main/crates/crashes/src/crashes.rs>
- **bun**：`process.on('uncaughtException' / 'unhandledRejection')` 可拦截，拦截后进程不退出
  ——保活窗口的关键手段。
- **@gpuix/react**：完整 react-reconciler 0.31 mutation 宿主配置，ErrorBoundary 是 React 核心
  机制、与宿主无关——在 GPUIX 渲染器下可直接使用。

## 二、方案设计（三个递进方案 + 一个可选补充）

### 方案 A：JS 层统一错误总线 + 区域 ErrorBoundary —— 保活与可见性

纯 `packages/app` 改动，不碰 Rust、不重编 `.node`。目标：应用不再「一错就没」，
错误第一次有了统一去向和 UI 呈现。

```
┌─ 装配层 main.tsx ─────────────────────────────────────┐
│ process.on('uncaughtException')  ─┐                   │
│ process.on('unhandledRejection') ─┤                   │
│ ErrorBoundary(root) componentDidCatch ─┐              │
│ store/async 包装 ────────────────────┤                │
│                                      ▼                │
│                     ══ errors/bus.ts（errorBus）══     │
│              AppError {level, kind, message,          │
│                        context, at, sessionId?}       │
│                    │              │            │      │
│              ▼(subscribe)   ▼(ring 1000)   ▼(追加写)   │
│          Toast UI 层      错误面板      ~/.j-agent/    │
│        (GPUIX 自绘通知)  (Cmd 查历史)  logs/errors-*.log│
└────────────────────────────────────────────────────────┘
```

五个组件：

1. **`errors/bus.ts` — 错误总线（单一事实源）**
   - `AppError = { level: 'fatal'|'error'|'warn', kind: 'render'|'native'|'io'|'protocol'|'acp'|'unknown', message, context?, at, sessionId? }`
   - `emit()` / `subscribe()` + 环形缓冲（1000 条），错误面板可回溯
2. **`errors/guards.ts` — 全局守卫**（main.tsx 第一行安装）
   - `uncaughtException` → `emit(level:'error')`，不退出；若错误发生在渲染循环内导致帧泵死，退化为日志留痕
   - `unhandledRejection` → `emit` + 记录（dev 模式直接打全栈）
3. **`errors/ErrorBoundary.tsx` — 区域隔离**
   - 三层布防：App 根一层（最后防线，fallback = 全屏错误页 + 重试按钮）、每个 ThreadPanel 一层（单个 thread 渲染崩了只崩那格，显示「此会话渲染异常 + 重试」）、Settings 一层
   - 重试 = 换 `key` 强制重挂载该子树
   - `componentDidCatch` → `errorBus.emit({kind:'render'})`，render 错误也进总线
4. **`errors/log.ts` — 落盘**：按天追加 `~/.j-agent/logs/errors-YYYYMMDD.log`，保留 7 天（与 state.json 同目录体系）
5. **`errors/native.ts` — napi 调用收口**：把 `createTerminalSession` / `destroyTerminalSession`
   等 Promise 面包一层，reject → `AppError{kind:'native'}`；store 里散落的 `console.warn` 替换为 `bus.emit({level:'warn'})`

改动面：约 6 个新文件 + main.tsx 装配 + store 散点替换。风险低。

局限：#4/#5（Rust panic）完全管不住——进程照样死。

### 方案 B：A + Rust 结构化错误 + panic 收编 —— 覆盖 FFI 边界

在 A 之上把 Rust 侧的错误从「anyhow 裸字符串」升级为「结构化、可分支、panic 不炸进程」。

1. **thiserror 错误类型贯穿**（`crates/jagent-terminal` + native）：

   ```rust
   #[derive(Debug, thiserror::Error)]
   pub enum TerminalError {
       #[error("spawn failed: {0}")]
       Spawn(#[from] std::io::Error),
       #[error("session {0} not found")]
       SessionNotFound(u64),
       #[error("invalid spawn options: {0}")]
       InvalidOptions(String),
   }
   ```

   napi 侧实现 `AsRef<str>` 映射稳定错误码（`ERR_TERMINAL_SPAWN` 等），用 `set_cause` 保留错误链
   ——JS 侧按 `error.code` 分支：可重试 / 可忽略 / 需提示。

2. **`#[napi(catch_unwind)]`** 给 `create_terminal_session` / `destroy_terminal_session`：
   JS 线程同步命令内的 panic 从「终止进程」变「JS throw」。

3. **`host.rs` 的 `run_host` 闭包内自包 `catch_unwind`**（关键招）：

   ```rust
   let boxed = Box::new(move |cx| {
       std::panic::catch_unwind(std::panic::UnwindSafe(|| f(cx)))
           .unwrap_or_else(|p| Err(anyhow::anyhow!(
               "host closure panicked: {}", panic_payload_str(&p))))
   });
   ```

   panic 不逃出闭包 → GPUI 线程不 abort → 通过 host 通道正常变成 JS 错误 → 走 A 的总线显示。
   注意：catch 后 GPUI `App` 上下文可能处于脏状态，需把该 session 标记为坏死（下次操作返回
   `SessionNotFound`），而不是当没事继续。

4. **全局 panic hook**（Rust 侧）：`thread name + payload + location` 写
   `~/.j-agent/logs/panic.log`；新增 `onNativePanic` TSF 通道 → bus `emit({level:'fatal'})` →
   UI 显示「原生层异常，状态已保存，建议重启」。仍会 abort 的场景（GPUI 内部 panic、OOM）
   也至少留下了 panic.log。

改动面：crates + native + gpuix patch（若 `run_on_gpuix` 需要 panic 安全加固）+ 重编 `.node` +
app 接 TSF。中等工作量。

### 方案 C：B + 进程外崩溃报告（Zed 式 minidump sidecar）—— 崩溃也能留全尸

Zed 的核心洞察：崩溃后进程内什么都不可信，报告必须在进程外。适配 j-agent 的形态：

- 引入 EmbarkStudios 的 `crash_handler`（signal handler，Windows SEH 支持）+ `minidumper`
- sidecar 进程：Zed 用自身 exe 变道（`--crash-handler`）；j-agent 没有 exe →
  `bun scripts/crash-handler.ts` 作独立子进程，Unix socket / 命名管道 IPC
- panic / SIGSEGV / abort 时：主进程 hook 先 IPC 发 panic 消息 → `request_dump` → sidecar 写
  `.dmp` + `crash.json`（session_id、版本、panic span、tags——对齐 Sentry 字段 schema，Zed 同款）
- 下次启动 `main.tsx` 读 crash.json → 提示「上次会话异常退出（原因 + 位置），查看详情 /
  提交报告」；本地留存，将来可接 Sentry
- 独有价值：**纯 native 崩溃**（access violation 等，根本不走 unwind）也只有这条路径能抓到
  ——A/B 完全无能为力

工作量：大（sidecar 进程管理、IPC、dump 符号化、隐私脱敏）。适合有真实用户 / 上报需求之后。

### 可选补充 D：launcher watchdog（成本极低，随手可加）

`scripts/launcher.ts`：spawn app 子进程并监控退出——非零退出 → 读日志尾部 →
`notifyDesktop` 通知 → 自动重启（带 crash-loop 频率保护）。工作区状态已有 `state.json`
持久化兜底，重启后可恢复；PTY 会话会丢（本来就是运行时态）。与 A/B/C 任意组合。

## 三、对比与推荐路线

| | A 总线+边界 | B +Rust收编 | C +崩溃报告 | D watchdog |
|---|---|---|---|---|
| 覆盖 #1-3 JS 崩溃 | ✅ | ✅ | ✅ | ✅(事后重启) |
| 覆盖 #4 napi panic | ❌ | ✅ | ✅ | ✅(事后) |
| 覆盖 #5 GPUI线程 panic | ❌ | 部分（host 通道内） | ✅ | ✅(事后) |
| 纯 native 崩溃(SEGV) | ❌ | ❌ | ✅ | ✅(事后) |
| 用户可见错误反馈 | ✅ | ✅ | ✅ | 通知 |
| 工作量 | 小（~1-2 天） | 中（+2-3 天） | 大（+3-5 天） | 极小（半天） |
| 改动范围 | packages/app | +crates/native/gpuix patch | +新进程+IPC | +脚本 |

推荐路线（渐进）——**已一次落地 A+B+C+D**（用户 2026-09-11 要求直接上 C）。

## 四、落地对照（2026-09-11）

### 方案 A（`packages/app/src/errors/`）

| 组件 | 文件 | 行为 |
|---|---|---|
| 错误总线 | `bus.ts` | `emitError` / 环形缓冲 1000 / `subscribeErrors` |
| 全局守卫 | `guards.ts` | `uncaughtException` / `unhandledRejection` → 总线，进程保活 |
| ErrorBoundary | `ErrorBoundary.tsx` | 三层：App 根 / pane / settings；retry 换 key |
| 落盘 | `log.ts` | `~/.j-agent/logs/errors-YYYYMMDD.log`，保留 7 天 |
| napi 收口 | `native.ts` | `trackNative` / `trackVoid` / `onNativePanic` |
| 可见面 | `ErrorIndicator.tsx` + `plane/ErrorDialog.tsx` | 顶栏徽章 + 历史面板 |
| Toast | `toastWire.ts` | error/fatal → 右下角 4s |

### 方案 B（Rust 结构化 + panic 收编）

- `crates/jagent-terminal/src/error.rs`：`TerminalError` / `HostPanic` + 稳定 `error.code`（`ERR_TERMINAL_*` / `ERR_NATIVE_PANIC`）
- `packages/native/src/panic.rs`：全局 panic hook（`panic.log` + TSF）+ `guarded()` catch_unwind 罩住 create/destroy
- `packages/native/src/host.rs`：`run_host` 闭包 `catch_unwind`，panic 变 `HostPanic` 而非 GPUI 线程 abort

### 方案 C（进程外 minidump）

```
主进程                              sidecar
setupCrashReporting  ──IPC──►  scripts/crash-handler.ts
CrashHandler::attach            minidumper::Server
panic hook → PANIC + ping       on_message / on_minidump_created
abort / SEGV → request_dump     → ~/.j-agent/crashes/{jagent-*.dmp, crash.json}
```

- **独立 sidecar 入口**（`scripts/crash-handler.ts`）：dev 直接 bun 该脚本；发布形态 `<exe> --crash-handler`。**禁止** sidecar 再走 `main.tsx`（会再次 spawn 自己）。
- **macOS IPC 名**：mach port **不能含 `/`**，用 `jagent.crash.<pid>`（`crashSocketName()`）。Linux/Windows 用路径 socket。
- panic 路径：hook 里 `send_message(PANIC)` + `ping()`（ACK 保证 server 先处理 PANIC）再 `abort()`；sidecar 的 SIGNAL 不覆盖已有 PANIC。
- 下次启动读 `crash.json` → `CrashDialog`（「上次会话异常退出」）。
- 验证：`bun scripts/crash-smoke.ts panic|sigsegv`（本机 2026-09-11 两条均通过，产出 .dmp + crash.json）。

依赖（crates.io 联网核实，禁止 beta）：`crash-handler 0.8.0` + `minidumper 0.11.0` + `thiserror 2.0.20`。

### 方案 D（watchdog）

`scripts/launcher.ts`：spawn app，非零退出 → 读日志尾部 → `notifyDesktop` → 3s 后重启；60s 内 ≥ 5 次放弃（防 crash-loop）。

```
bun scripts/launcher.ts            # dev
bun scripts/launcher.ts --compiled # 发布二进制
```
