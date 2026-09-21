# CONTEXT —— j-agent 领域词汇表

架构评审与日常开发共用的领域语言。谈到模块时用这里的名字，不造同义词。
架构词汇（module / interface / depth / seam / adapter / leverage / locality）
见 `docs/architecture.md` 与 codebase-design 惯例，本表只管领域概念。

## 会话域（threads/）

| 词 | 含义 | 代码锚点 |
|---|---|---|
| **Thread（会话）** | 一行可激活的工作单元，三类判别联合：`terminal` / `chat` / `acp`。id 前缀 `t`/`c`/`a` | `threads/store.ts` |
| **ThreadStore** | 会话域唯一事实源与规则收口（§3.3 规则表全部在一处）。外部 interface 不变；实现按簇在 `threads/internal/` | `threads/store.ts` + `threads/internal/` |
| **Workspace（工作区）** | 项目目录分组（path + name + expanded + lastSession）；会话经 `workspaceId` 平铺归属，分组是派生视图 | `threads/workspaces.ts` |
| **SessionView（会话内视图）** | 会话标题栏副页签：`git` / `file` / `shell`；`'main'` 是虚拟 id = 主面。shell 视图绑独立真 PTY（`view.sessionId ≠ thread.sessionId`） | `threads/internal/sessionViews.ts` |
| **SessionNotice（通知条目）** | 真实会话事件流（bell/exit）落通知中心；tone 三档 ok/warn/err；带 threadId/viewId 可直达 | `threads/internal/notices.ts` |
| **TerminalPreset（预设）** | 可启动的程序配置（program/args/env/initCommand/cwd）；`spawnFromPreset` 消费 | `threads/presets.ts` |
| **ChatAgent** | 会话后端 seam：chat 用 EchoAgent（默认）、acp 用 JSON-RPC 子进程连接，同一个 interface | `threads/chat.ts` + `threads/acp.ts` |
| **ActiveTarget** | 导航目标（thread / settings / null），从路由派生——router 是导航唯一事实源，store 不存 active | `router.tsx` |

## 设置域（settings/）

| 词 | 含义 | 代码锚点 |
|---|---|---|
| **SettingsStore** | 设置事实源；zod schema 单源（SETTING_DEFS 声明式清单驱动分区/搜索/行渲染） | `settings/store.ts` + `settings/schema.ts` |
| **Settings UI** | 设置路由表面（`/settings`，非 thread surface）：SettingsView + 分区组件 + settingsKeyboard 模块单例 | `settings/ui/` |
| **FileAdapter** | 设置读写 seam（真盘 / 内存两个 adapter——测试面） | `settings/file.ts` |

## 平面域（plane/ · sidebar/ · dialogs/）

| 词 | 含义 | 代码锚点 |
|---|---|---|
| **AgentPlane（壳）** | 顶层布局：sidebar 248px + pane 剩余 | `plane/AgentPlane.tsx` |
| **Pane** | 唯一表面调度：ActiveTarget → surface 整块替换（含 workspaces 订阅做 pane 内调度） | `plane/Pane.tsx` |
| **Sidebar 族** | 侧栏组件群：Sidebar / WorkspaceList / ThreadRow / ContextMenu / WorkspaceEmpty / WorkspacePage | `sidebar/` |
| **Dialog 族** | 弹窗组件群：DialogHost + Crash/Error/Rename/Search/Tool/Workspace 六弹窗 | `dialogs/` |
| **Surface** | 按 `thread.kind` 注册的表面组件（Terminal/Chat/Acp/File/Empty），ConversationView 是 chat/acp 共享消息面 | `surfaces/registry.ts` |

## git 域（git/）与 fs 域

| 词 | 含义 | 代码锚点 |
|---|---|---|
| **GitGraphStore** | git 图状态（与 ThreadStore 平行的第二个 store） | `git/store.ts` |
| **Worktree（worktree 工作面）** | 工作区 paneTab='git' 时的主面：GitGraphView + WorkPanel；`useWorktree` 是数据 hook | `git/useWorktree.ts` + `git/components/` |
| **readTextFile** | 文件读取共享 adapter（git 与 FileSurface 两个消费方——seam 因第二个 adapter 坐实） | `fs/readTextFile.ts` |

## native 域（Rust 侧）

| 词 | 含义 | 代码锚点 |
|---|---|---|
| **TerminalPool** | 会话池（gpui Global）：PTY + TerminalModel 按 sessionId 持有；retain 语义——会话比视图活得久 | `crates/jagent-terminal/src/pool.rs` |
| **TerminalModel** | 单个会话模型：alacritty Term + 事件消费 task + gpui EventEmitter | `crates/jagent-terminal/src/model.rs` |
| **CustomElement 适配层** | GPUIX `CustomElement` 实现集合：`<terminal>` 与 `<git-graph-row>`；只做协议桥接 | `packages/native/src/elements/` |
| **napi seam** | 唯一跨语言 seam：lib.rs 协议镜像 + napi 命令；修改理由只允许是 seam 协议变化 | `packages/native/src/lib.rs` |

## 横切

| 词 | 含义 | 代码锚点 |
|---|---|---|
| **装配层** | main.tsx + threads/nativeDeps.ts：唯一允许碰 native 与两侧 store 的 JS 代码 | `main.tsx` + `threads/nativeDeps.ts` |
| **错误总线** | native/JS 错误统一收口（toast/报告）；Rust panic 经 guarded + hook 进总线 | `errors/` + `packages/native/src/panic.rs` |
