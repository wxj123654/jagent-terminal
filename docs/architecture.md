# j-agent 架构契约（纯 Rust gpui）

> 本文是当前架构的权威描述（2026-10 P8 起生效）。重构过程与决策见 `docs/gpui-rewrite.md`；
> 迁移前的 React/GPUIX 架构与行为规格保留在 git 历史（commit `aadecd4` 及之前的
> `packages/`、`docs/` 旧文档），需要对照旧行为时去历史里查，不在工作树维护两份。
>
> 领域词汇表见 `CONTEXT.md`；改代码先读对应章节，签名级契约以本文为准。

## 1. 分层与依赖方向

```
crates/jagent-app      二进制 j-agent：Entity/Render 视图、Action、主题、窗口、
   │                   crash sidecar、watchdog、ACP 进程 IO
   ├──> crates/jagent-core     纯逻辑：settings/threads/workspaces/git/acp 协议。
   │                           不依赖 gpui，普通 #[test] 即可覆盖
   └──> crates/jagent-terminal 终端栈：TerminalPool / TerminalModel / PTY /
                               vendored gpui-terminal 绘制（alacritty_terminal）
```

- **core 与 terminal 互不依赖**；app 是唯一聚合点。
- **规则在 core，视图在 app**：app 只做「把 core 状态画出来、把输入事件翻译成
  core 方法调用」。视图层不放业务规则；core 不 import gpui。
- 版本与依赖治理：gpui 系列 = 精确锁定快照（`gpui-pre =0.3.8`、
  `gpui-component/gpui-base =0.7.1`），升级整体进行，见 AGENTS.md 规则 5 与
  `docs/p0-results.md` §0 的核实记录。

## 2. jagent-core（纯逻辑）

| 模块 | 职责 | 关键类型 |
|---|---|---|
| `threads/model.rs` | 会话域数据模型 | `Thread`（terminal/chat/acp 判别联合）、`SessionView`、`SessionNotice`、`Workspace`、`ActiveTarget`、`PaneTab` |
| `threads/store.rs` | 会话域唯一事实源：spawn/activate/close/rename/cycle/会话视图/通知/工作区操作的全部规则 | `ThreadStore<E: Effects>` |
| `threads/workspaces.rs` | state.json 读写、默认工作区、归属派生 | `Workspace` |
| `threads/conversation.rs` | chat/acp 共享消息规则、EchoAgent 回复 | `Conversation` |
| `settings/` | schema（字段级容错、未知键保留）、store（合并写+回滚）、file（原子写） | `SettingsStore`、`SETTING_DEFS` |
| `presets.rs` | 内置/自定义预设 CRUD 规则 | — |
| `git/` | cli（进程边界）/ parse / graph（lane 状态机）/ store（图状态+流式加载 ticket）/ geometry（行高 lane 宽列宽）/ actions（argv 规则）/ format | `GitGraphStore`、`Ticket` |
| `acp.rs` | ACP 协议层：行分隔 JSON-RPC 编解码 + turn 状态机。进程 IO 在 app | — |
| `new_session.rs` | 新建会话弹窗数据模型（分组/筛选/归属约束） | — |

**Effects 注入是 core 的测试面**：`ThreadStore<E: Effects>` 的副作用（spawn PTY、
notify、写盘）全部经 `Effects` trait 发出；生产实现在 app（`state.rs::GuiEffects`，
notify 目前只记账），测试注入 fake 断言调用序列。新增副作用必须走 Effects，
不得在 core 直接碰进程/时钟/文件。

配置文件兼容性：`settings.json` / `state.json` 与旧 TS 实现互读（serde_json
preserve_order + 未知键原样往返），有回归测试锁定。

## 3. jagent-terminal（终端栈）

结构自 Phase 0 起未变（vendored gpui-terminal + pool/model/pty），P1 迁到
`gpui-pre` 时源码零改动。对外只有根部 re-export 单面；六 pub mod 收私有。
`TerminalPool` 是 gpui Global：会话按 sessionId 持有，**retain 语义**——会话比
视图活得久，切走后 PTY 照跑，BEL/OSC/Exit 事件照发。

## 4. jagent-app（视图与装配）

| 模块 | 职责 |
|---|---|
| `app.rs` | 装配：`gpui_component::init` **必须最先** → theme → state → actions；`open_main_window` 用 `TitleBar::window_options()`（自绘标题栏/拖拽/双击缩放/红绿灯让位） |
| `state.rs` | `AppState`（聚合 threads/settings/git_graph/acp 连接表）+ 终端事件桥 `bridge_terminal_events` |
| `actions.rs` | `actions!` 清单（CycleNext/Prev、ToggleSettings、SearchThreads、NewSession、ToggleSidebar、OpenGitGraph、FocusSettingsSearch、CloseSettings、GitSelect* 等）+ `install`（settings 键位生成 KeyBinding，坏键位不阻塞启动） |
| `theme.rs` | One Dark token → gpui-component 主题映射 |
| `terminal_style.rs` | 设置 → TerminalStyle，flush 到池内活跃终端（字号/色板/闪烁在线生效） |
| `acp_io.rs` | ACP 子进程 IO：spawn/管道/惰性握手/dispose；`AcpCancellation` 在 spawn 前注册处理关闭竞态 |
| `crash.rs` | panic hook → sidecar（`--crash-sidecar`）→ watchdog（默认启动路径，`--app-child` 内部绕过） |
| `views/` | root（壳）/ sidebar / session_tabs / terminal_pane / conversation / git_graph / work_panel / settings / new_session / rename / search_threads / workspace_dialog / nested_scroll |

**视图范式约定**（写新视图必守）：

- 状态 = `Entity<T>` + `cx.notify()`；跨实体用 `cx.subscribe`/`cx.observe`。
- 虚拟列表：定高行 `uniform_list`，变高（对话流、Git 图展开详情）`gpui::list` +
  `ListState`，follow-tail 用原生 `FollowMode::Tail`。**不用 gpui-component
  VirtualList**。
- 定宽单行列必须同时 `overflow_hidden` + `whitespace_nowrap` + `text_ellipsis`。
- 嵌套滚动：可滚容器内再套可滚区域（含 `list`）时用 `views/nested_scroll`
  的封装（内层能滚就 `stop_propagation` 吃掉滚轮；到边界交给外层）。
- 有两个 `Theme`：`gpui_component::Theme`（`cx.theme()`）与 `gpui_base::Theme`
  （`TextViewStyle::from_theme` 要后者，用 `gpui_base::Theme::global(cx)`）。
- markdown 用 `gpui_base::text::TextView`；多行输入用 `TextareaState`
  （`submit_on_enter` + `auto_grow`），无样式需自加边框/聚焦环。
- 测 Enter 语义用 `dispatch_action`，不能用 `simulate_keystrokes("enter")`
  （测试驱动器会附带 `key_char="\n"` 造成多换行假象）。

## 5. 键位

- 动作清单在 `actions.rs` 的 `actions!`；绑定由 settings 键位表生成
  （`actions::install`），用户重绑后重新生成。
- 平台语义键（Esc 层级、菜单键）不进配置表。
- `OpenGitGraph`（Ctrl-Shift-G）硬编码不进 settings。

## 6. 崩溃与发布链

- 进程形态：`j-agent` 默认由 watchdog 启动；`--crash-sidecar` 是 sidecar 入口；
  `--app-child` 绕过 watchdog（内部用）。
- panic hook 把结构化 JSON 报告交给 sidecar（READY 握手、落盘 fsync ACK、
  64 条保留）；watchdog 60s/5 次 crash-loop 截止；app 正常退出时显式回收 sidecar。
- **不产 minidump、不捕获 SIGSEGV/abort/OOM**（P7 边界，见 gpui-rewrite §10）。
- 发布：`.github/workflows/rust-release.yml`（macOS/Linux/Windows）；
  macOS 打包 `scripts/package-macos-app.sh`；Windows 图标资源校验
  `scripts/check-windows-icon.ps1`。这两个脚本是 scripts/ 仅存的成员。
- 工具链 pin 1.97.1（`rust-toolchain.toml` + CI），P0 实测可构建 gpui-pre 0.3.8。

## 7. 测试面

| 层 | 形态 | 当前规模 |
|---|---|---|
| core | 普通 `#[test]`（含 store 规则、git 解析、settings 容错） | 270 |
| app 单元 | `#[gpui::test]`（TestAppContext；视图行为、store 写回、Action） | 75 |
| app 视觉/事件 | `harness = false` 自写 main（AppKit 主线程）：`shell_shot`（屏幕外窗口截图）、`nested_scroll`（真实滚轮）、`terminal_settings`（设置→PTY 在线生效） | 3 |
| app 集成 | `crash_sidecar`、`watchdog`（真实子进程） | 1 + 2 |
| terminal | 普通 `#[test]`（模型/输入/渲染逻辑） | 41 |

视觉测试约束（p0-results E9）：沙箱内 SIGTRAP，须在用户终端或 CI 跑；
`Window::draw` 才真实重绘（`refresh_windows + run_until_parked` 在屏幕外窗口
不重绘）；`Window::resize` 不改 viewport，测窄屏要新开窗口。

## 8. 已知的明确边界（不视为缺陷）

- FileSurface、原生目录选择器、Git 危险操作确认、独立全局错误面板、Git 图
  贝塞尔弯线：**明确不做**（gpui-rewrite §10.1 各阶段记录了理由）。
- 桌面通知（`Effects::notify`）只记账不弹系统通知。
- 未真机验证项（三平台中文 IME、Windows/Linux 运行、真实拖动手感、真窗口
  帧耗时）清单见 `docs/gpui-rewrite.md` §10 各阶段「未验证」条目。
