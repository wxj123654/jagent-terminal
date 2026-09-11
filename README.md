# j-agent

> Agent Plane —— 把 CLI/TUI agent 跑在真正的原生 GPU 终端里。

j-agent 是一个桌面 Agent 会话管理器（Windows 优先开发中）：Claude Code、Codex、Pi、Amp 这类 CLI agent 与普通 shell 会话**混排在同一个列表**里，每个会话坐在真正的 PTY + GPU 终端仿真器上，而不是 xterm.js 或 WebView。

技术底座：**[GPUIX](https://github.com/remorses/gpuix)**（React → napi → GPUI，GPU 直接渲染，无 Electron / 无 WebView）× **Zed terminal 技术**（alacritty_terminal + vendored gpui-terminal 绘制栈）。视觉基调 Zed One Dark。

> 状态：积极开发中（Phase 2 完成，即将进入 Phase 3）。核心终端栈、会话池与设置系统已全线跑通——两个 PTY 并存、切走 retain、后台 BEL 红点+桌面 toast、exit 灰行、OSC 标题冻结、设置实时生效（字体/色板/光标闪烁）均已 e2e 锁定。Chat / ACP 表面为 Phase 3 占位。

## 核心设计

**JS 拥有 plane，Rust 拥有 terminal，字节流不过 napi。**

- **TerminalPool（Rust 全局）持有会话**；`<terminal sessionId …>` 元素只是视图代理。切换会话 = 卸掉整块 body，未激活 PTY **retain** 照跑——后台 agent 发 BEL，红点照样落到列表行上。
- **会话事件（title / bell / exit）走全局通道**，元素事件只留 focus/blur——后台事件在元素不存在时也能送达。
- **spawn 参数走 napi 命令，外观走元素 props**——改字号、换配色不重开会话。
- **store 依赖注入**：ThreadStore / SettingsStore 零 native 导入，纯 TS 可测；e2e 用 TestGpuixRenderer + 真 PTY。

```
┌────────────────────────────────────────────────────────────────────┐
│ packages/app（React 壳，JS 拥有会话）                                │
│   plane/（AgentPlane/Sidebar/Pane）  threads/（ThreadStore）        │
│   surfaces/（Terminal/Chat/Acp）     settings/（SettingsStore）     │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ napi（唯一的跨语言 seam）
┌──────────────────────────┴─────────────────────────────────────────┐
│ packages/native（薄 napi 壳：元素注册 + 3 个会话命令）                │
│ crates/jagent-terminal（深库：TerminalPool / PTY / 终端仿真与绘制）  │
└────────────────────────────────────────────────────────────────────┘
```

## 仓库布局

```
crates/jagent-terminal/     Rust 深库：pool / model / pty / view(vendored)
packages/native/            @jagent/native：napi 壳（lib/host/element 三文件）
packages/gpuix-native-alias @gpuix/native 别名 → 复用同一 .node 二进制
packages/app/               React 应用：plane / threads / surfaces / settings / ui
e2e/                        TestGpuixRenderer + 真 PTY 端到端测试
docs/                       已拍板契约文档（见下表）
design/                     两个 HTML 可交互原型（布局 / 设置）
.refs/                      参考仓库浅克隆（gitignore，见「构建准备」）
```

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | **代码实现契约**：模块划分、接口签名、依赖方向、测试面、Phase 映射 |
| [`docs/agent-plane-layout.md`](docs/agent-plane-layout.md) | Agent Plane 布局契约（单 pane / 无顶栏 / 混排列表 / 预设菜单） |
| [`docs/settings-ui.md`](docs/settings-ui.md) | 设置界面契约（Pane 表面 / settings.json 事实源 / 7 分区） |
| [`docs/gpuix-zed-terminal-fusion.md`](docs/gpuix-zed-terminal-fusion.md) | 前期调研与硬约束（字节流不过 napi；GPUIX pin GPUI fork） |
| [`TODOLIST.md`](TODOLIST.md) | 跨会话实施看板：进度、每个 Phase 的结论与踩坑记录 |

**改动任何代码前，先读对应契约文档**——落地以它们为准，不要重新发明结构。

## 构建与运行

### 环境要求

- Windows（当前开发平台，ConPTY；GPUIX 本身跨平台）
- Rust stable（rustup，含 MSVC 工具链）
- [bun](https://bun.sh) 1.3+（workspace、测试、跑 app）

### 0. 准备 `.refs/`（一次性，脚本化）

GPUIX pin 了自己的 GPUI fork（`remorses/zed` @gpuix 分支 rev `8b94def`），crates.io 上的 gpui 同号不同 API，**必须本地引用**。本地修改以 patch 文件版本化在 `patches/`（清单见 patches/README.md），重建一条命令：

```bash
bun run setup-refs     # clone → pin → 补丁 → 构建 @gpuix/react dist（幂等；重建加 -- --force）
```

`.refs/` 已 gitignore（可随时删除重建）；对 gpuix/zed 源码的任何修改都经
`bun run export-patches` 导出回 `patches/` 后随主仓库提交，不依赖人肉清单。

### 1. JS 侧

```bash
bun install                        # 根目录（bun workspace）
cd packages/native
bun run build:debug                # napi 编译 → jagent-native.node
cd ../app
bun run dev                        # 真窗口冒烟
```

### 2. Rust 侧

```bash
cargo build                        # jagent-terminal + native
cargo test -p jagent-terminal      # 库单测（含 vendored view 单测）
cargo run -p jagent-terminal --example window   # Phase 0 验证窗口（纯 gpui，不经 React）
```

### 3. 测试

| 面 | 命令 | 覆盖 |
|---|---|---|
| ThreadStore / SettingsStore / schema | `cd packages/app && bun test` | 纯 TS，fake deps / 内存 adapter，零 GPU 零 PTY |
| 端到端 | `cd e2e && bun test` | TestGpuixRenderer + **真 PTY**：并存 / retain / BEL 红点 / exit / 焦点模型 |

e2e 时序注意：PTY 事件消费是 4ms 批处理定时器，断言一律 `until()` 轮询并驱动 fake clock——禁止固定 sleep（详见 `TODOLIST.md` Phase 1 结论区「时序三律」）。

### 4. 打包与应用图标

```bash
bun run build                         # 当前平台可执行文件
bun run build --app                   # macOS：额外生成 JAgent.app（含图标）
bun run build --app --skip-native     # 已有对应 .node 时，只重新编译应用并打包
```

产物位于 `dist/<platform>/`。Windows 构建自动将图标嵌入 `.exe`，需要在 Windows 上执行；macOS 请使用 `.app` 才能在 Finder / Dock 显示图标。Linux 当前仅输出裸二进制，尚无桌面安装集成。

macOS 请从 Finder 打开 `dist/darwin-arm64/JAgent.app`：`dist/darwin-arm64/jagent` 是裸二进制，双击时 macOS 会交给 Terminal 运行（看起来像"多弹一个命令行"），且没有 bundle 身份（Dock 图标 / 崩溃报告上下文都缺失）。打包产物冒烟：`bun scripts/sidecar-tree-smoke.ts [exe]` —— 崩溃监控 sidecar 不得递归 spawn 自己，也不得进入 UI 装配（那会各自开窗）。

图标源稿与多平台文件在 [`packages/app/assets/icons/`](packages/app/assets/icons/README.md)，预览见 [`design/app-icon.html`](design/app-icon.html)。修改 `app.svg` 后运行 `bun run icons` 更新 PNG / ICNS / ICO，再运行 `bun test scripts/icons.test.ts`。普通打包直接使用已入库资产，无需图像工具。

#### Windows：GUI 子系统（双击不再多一个终端窗口）

`dist/windows-x64/jagent.exe` 打包收尾会把 PE 头部 Subsystem 从 3（CUI/console）改成 2（WINDOWS_GUI）——不改的话双击启动时 Windows 会分配一个控制台窗口（`scripts/pe-subsystem.ts`；bun 1.3.13 的 `--windows-hide-console` **实测不生效**，上游修复 PR 在 Rust 重写后按 stale 关闭）。子命令 `bun scripts/pe-subsystem.ts <exe> [--check]` 可查/改任意 exe。

GUI 子系统带来两条硬约束：

- **所有 spawn 必须 `windowsHide: true`**：GUI 进程没有可继承的 console，不隐藏时 Windows 会给子进程新建**可见**控制台窗口（git 面板每次刷新闪黑框、ACP agent 闪 cmd 框）。`git/cli.ts`、`threads/acp.ts`、`settings/file.ts`、`errors/crashReport.ts` 均已处理。注意 **`Bun.spawn` 的 `windowsHide` 在 bun 1.3.13 实测无效**（子进程照样拿到窗口），新增子进程请用 `node:child_process` 的 `spawn`。
- **从 cmd / PowerShell 运行 `jagent.exe` 不再回显 stdout/stderr**（无 console 可写）。排查启动问题看 `~/.j-agent/logs/`（`installErrorLog` + panic hook 落盘）。

#### Windows：图标资源帧声明（任务栏图标不糊）

`bun --windows-icon` 写 PE 图标时会产出**两个** `RT_GROUP_ICON` 组，而主组（`IDI_MYICON`）的 `dwBytesInRes` 只声明第一帧，于是 Windows 认为「这个图标最大只有 16×16」，把 16px 帧放大到任务栏需要的 32px（96 DPI）——图标发糊的根因（ICO 源文件本身七档齐全）。收尾步骤 `scripts/pe-icon-resources.ts` 把两个组都指向含帧最多的 blob 并重算 CheckSum，子命令 `bun scripts/pe-icon-resources.ts <exe> [--check]` 可查/改。

## 技术栈

| 层 | 选型 |
|---|---|
| 渲染 | GPUIX（React 19 reconciler → GPUI，DirectX/Metal/Vulkan） |
| 终端仿真 | alacritty_terminal 0.26（crates.io） |
| 终端绘制 | vendored gpui-terminal（render/input/colors/box_drawing 四文件，MIT/Apache 双证随拷保留，见 `crates/jagent-terminal/src/view/`） |
| 跨语言 | napi-rs 3 |
| 状态 | zustand/vanilla + immer；zod（settings schema，字段级容错） |
| 路由 | TanStack Router（memory 模式，手动桥——R-V1 结论） |

## 开发约定

- **目录按 feature 组织**，不按实现角色组织；crate 上限 2、包上限 2（含 alias）。
- 依赖白名单制：`packages/app` 新增依赖须先进 `docs/architecture.md` §11 白名单；引入版本**必须联网核实**，禁用 pre-release（见 `AGENTS.md`）。
- 一次会话只做一两个任务块；做完更新 `TODOLIST.md`（勾选 + 会话日志追加）。**测试不过不算完成。**

## 许可证

AGPL-3.0-or-later（声明见 `Cargo.toml` workspace 配置）。vendored 的 gpui-terminal 文件保留上游 MIT/Apache-2.0 双许可声明（`crates/jagent-terminal/LICENSE-MIT` / `LICENSE-APACHE`）。
