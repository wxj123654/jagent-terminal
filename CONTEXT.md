# CONTEXT —— j-agent 领域词汇表

架构评审与日常开发共用的领域语言。谈到模块时用这里的名字，不造同义词。
架构分层与签名契约见 `docs/architecture.md`；本表只管领域概念。

## 会话域（jagent-core::threads）

| 词 | 含义 | 代码锚点 |
|---|---|---|
| **Thread（会话）** | 一行可激活的工作单元，三类判别联合：`terminal` / `chat` / `acp` | `threads/model.rs::Thread` |
| **ThreadStore** | 会话域唯一事实源与规则收口（spawn/activate/close/cycle/视图/通知全在一处）；泛型 `E: Effects` 注入副作用，测试注 fake | `threads/store.rs::ThreadStore<E>` |
| **Effects** | core 的副作用出口（spawn PTY / notify / 写盘）；生产实现 `GuiEffects` 在 app | `threads/store.rs`（trait）+ `jagent-app/src/state.rs` |
| **Workspace（工作区）** | 项目目录分组（path/name/expanded/lastSession）；会话经 workspaceId 平铺归属，分组是派生视图；state.json 持久化 | `threads/model.rs::Workspace` + `threads/workspaces.rs` |
| **SessionView（会话内视图）** | 会话副页签：`git` / `file` / `shell`；`main` 是虚拟 id = 主面。shell 视图绑独立真 PTY | `threads/model.rs::SessionView` |
| **SessionNotice（通知条目）** | 会话事件流（bell/exit）落通知中心；tone 三档；带 thread_id/view_id 可直达 | `threads/model.rs::SessionNotice` |
| **TerminalPreset（预设）** | 可启动的程序配置（program/args/env/init_command/cwd） | `presets.rs` |
| **ActiveTarget** | 导航目标（thread id / settings / home），ThreadStore 内的枚举字段（旧 TanStack Router 已不存在） | `threads/model.rs::ActiveTarget` |
| **ACP** | agent 会话后端：stdio 行分隔 JSON-RPC（协议层在 core，进程 IO 在 app） | `acp.rs` + `jagent-app/src/acp_io.rs` |

## 设置域（jagent-core::settings）

| 词 | 含义 | 代码锚点 |
|---|---|---|
| **SettingsStore** | 设置事实源；SETTING_DEFS 声明式清单驱动分区/搜索/行渲染；合并写 + 失败回滚 | `settings/store.rs` |
| **FsAdapter** | 设置读写 seam（真盘原子写） | `settings/file.rs` |

## 视图域（jagent-app::views）

| 词 | 含义 | 代码锚点 |
|---|---|---|
| **RootView（壳）** | 顶层布局：侧栏 + 主面 + 会话 tab 条 | `views/root.rs` |
| **Sidebar** | 侧栏：工作区分组树、会话行、通知入口、折叠 | `views/sidebar.rs` |
| **TerminalPane** | 终端表面（`TerminalView` 的宿主）；retain 语义由 TerminalPool 提供 | `views/terminal_pane.rs` |
| **Conversation** | chat/acp 共享消息面：变高 list + follow-tail + composer | `views/conversation.rs` |
| **GitGraph / WorkPanel** | Git 图视图（list + 展开详情）/ 工作面板（status/diff） | `views/git_graph.rs` + `views/work_panel.rs` |
| **nested_scroll 封装** | 嵌套滚动统一封装（内层能滚吃掉滚轮，到边界交外层） | `views/nested_scroll.rs` |

## 终端域（jagent-terminal）

| 词 | 含义 | 代码锚点 |
|---|---|---|
| **TerminalPool** | 会话池（gpui Global）：PTY + TerminalModel 按 sessionId 持有；retain 语义——会话比视图活得久 | `pool.rs` |
| **TerminalModel** | 单会话模型：alacritty Term + 事件消费 + EventEmitter | `model.rs` |

## 崩溃域（jagent-app）

| 词 | 含义 | 代码锚点 |
|---|---|---|
| **sidecar** | 崩溃报告进程（`--crash-sidecar`）：READY 握手、落盘 fsync、64 条保留 | `crash.rs` |
| **watchdog** | 守护启动（默认路径）：重启退出进程、60s/5 次 crash-loop 截止 | `crash.rs` |
