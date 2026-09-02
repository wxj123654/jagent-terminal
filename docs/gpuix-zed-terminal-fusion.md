# GPUIX × Zed AI Plane Terminal 融合

调研日期：2026-09-02  
范围：用 GPUIX 做 Agent Plane UI，把 Zed Terminal Threads 的会话语义和原生 GPU 终端嵌进去。

---

## 1. 结论

能融。该融的不是「把 GPUIX 当终端」，而是：

> **GPUIX 做 Agent Plane 的 React 壳，`gpui-terminal` / Zed `TerminalView` 做 GPU 终端，Zed Terminal Threads 的会话语义把两者焊在一起。**

JS 拥有 plane（列表、切换、通知、预设）。Rust 拥有 terminal（PTY、VTE、绘制、焦点）。字节流不过 napi。

三条错误路线：

1. 用 GPUIX 的 `div` / `text` 仿格子终端
2. 嵌 WebView / xterm.js
3. 整棵抽 Zed `agent_ui`（绑死 Workspace / Project / ACP store）

---

## 2. 两端现状

### 2.1 GPUIX（`remorses/gpuix`，~1.3k stars，Apache-2.0）

React / TypeScript → napi-rs mutation batch → Rust `RetainedTree` → 每帧生成 ephemeral GPUI 元素 → Metal / DirectX / Vulkan。无 Electron、无 WebView。

已具备做 Agent 壳的能力：

| 能力 | 状态 | 用途 |
|---|---|---|
| `div` / `text` / `input` / `textarea` | 有 | 面板、composer |
| `virtual-list` + `followTail` | 有 | thread 列表 |
| `motion.div` | 有 | sidebar 折叠 |
| `anchored` overlay | 有 | 菜单 / tooltip |
| CustomElement 注册表 | 有 | **嵌终端的正式入口** |
| Win / Linux / macOS GPU | 有 | 跨平台 |
| `bun --hot`、独立二进制 | 有 | 开发与分发 |

没有、也不该有：VTE、PTY、ConPTY、OSC 52、应用光标模式。`canvas` 仍是规划项。

Custom element 已有先例：`input`、`img`、`anchored`。未知标签走 `CustomElementRegistry`；非 style/event 的 props 经 `setCustomProp` 到 Rust；事件经 `supported_events()` 回到 React。

注意：GPUIX pin 了自己的 GPUI fork。任何 `gpui-terminal` 都要先对版本。

### 2.2 Zed AI Plane：Terminal Threads

Zed 现在三条 agent 路径并列出现在 Threads Sidebar：

| 路径 | 跑什么 | 配置归属 |
|---|---|---|
| Zed Agent | 原生 agent | Zed 的模型 / tools / skills / MCP |
| External Agents | ACP JSON-RPC 子进程 | 外部 agent 自己 |
| **Terminal Threads** | 真正的 CLI/TUI 坐在 PTY 里 | CLI 自己（auth、订阅、config） |

Terminal Thread 不是新仿真器。源码在 `crates/agent_ui`：

1. `AgentPanel::new_terminal()` → `project.create_terminal_shell()`
2. 包一层已有 `TerminalView`（Alacritty VTE + GPUI 绘制）
3. 塞进 `terminals: HashMap<TerminalId, AgentTerminal>`
4. `BaseView::Terminal { terminal_id }` 让 panel body 显示这个终端
5. 订阅 `TerminalEvent::{TitleChanged, Bell, CloseTerminal, Wakeup}`

Zed 管 **thread 表面**：sidebar 条目、按项目分组、切 thread、通知、工作目录、元数据。CLI 管 **里面跑什么**。ACP 的 diff / accept / file-pick **不会**自动落到 Terminal Thread。

产品规则：

- `agent.terminal_init_command`：当普通输入打进 shell，不是 `exec` 替换进程
- OSC 标题 → sidebar 标题
- BEL（`\x07`）且未聚焦 → 与 agent 完成相同的通知
- 关闭即销毁，不进 Thread History
- Claude：`preferredNotifChannel: "terminal_bell"`
- Amp：`AMP_FORCE_BEL=1`
- Pi：`agent_end` 时 `process.stdout.write("\x07")`
- Codex：`tui.terminal_title` 写 OSC 标题

### 2.3 周边：muxel / Paneflow / gpui-terminal

| 项目 | 角色 | 对我们 |
|---|---|---|
| `zortax/gpui-terminal` | 可嵌入的 `TerminalView`，Alacritty + 任意 Read/Write | **首选 L1 库**。回调：resize / exit / bell / title / OSC 52 |
| muxel | GPUI 原生 multi-agent multiplexer | 产品参考：preset、live status、split。不当库 |
| Paneflow | 同类；JSON-RPC `ai.*` 控制面 | 后期可选控制面，不是第一期 |

muxel 的 working / awaiting-input / done 比 Zed 强，但依赖各 CLI 的输出指纹或 hook。第一期只用 BEL + OSC。

---

## 3. 目标架构

```
┌──────────────────────────────────────────────────────────┐
│  GPUIX React 壳（Agent Plane UI）                          │
│  sidebar / thread list / overlays / motion                 │
│                                                            │
│   <thread-list/>              <terminal … />               │
│          │                            │                    │
│          │ JS 状态机                  │ CustomElement      │
└──────────┼────────────────────────────┼────────────────────┘
           │                            │
           ▼                            ▼
   ThreadStore (JS)            Rust TerminalView
   title / bell / status       alacritty_terminal + PTY
   init command / notify       Title / Bell / Exit / Resize
```

### L1 原生终端（Rust）

优先 `gpui-terminal` + `portable-pty`（Windows ConPTY）。PTY I/O 留在 Rust：读线程 → flume → `cx.notify()`。不要把格子字节泵到 Node。

### L2 GPUIX CustomElement

```tsx
<terminal
  cwd={thread.cwd}
  initCommand={thread.initCommand}
  env={thread.env}
  onTitle={(e) => renameThread(id, e.title)}
  onBell={() => notifyThread(id)}
  onExit={(e) => closeThread(id, e.code)}
  onFocus={() => clearBadge(id)}
/>
```

焦点必须交给 `TerminalView` 自己的 `FocusHandle`。GPUIX 的 `onKeyDown` 不能先吃掉 vim / claude TUI。

> 注（2026-09-02）：上面是调研期的示意。落地形状已定为 TerminalPool + `sessionId` 绑定 + 全局会话事件通道（spawn 走 `createTerminalSession` 命令），见 `docs/architecture.md` §2。

### L3 会话层（对标 Terminal Threads）

```ts
type TerminalThread = {
  id: string
  cwd: string
  title: string
  initCommand?: string
  env?: Record<string, string>
  status: "idle" | "running" | "needs-you" | "exited"  // 调研期示意
  hasBell: boolean
  createdAt: number
  customTitle?: string
}
```

> 注（2026-09-02）：落地后 `status` 简化为 `running | exited`，needs-you 由 `hasBell` 表达（R3）；完整形状见 `docs/architecture.md` §3.1 / `docs/agent-plane-layout.md` §9。

规则对齐 Zed：init command 是键入；标题优先 OSC，可手动覆盖；BEL 且未聚焦才通知；关闭销毁 PTY；凭证走 shell 环境，不从 LLM settings 拷 key。

---

## 4. 硬约束

1. 终端必须是 native custom element。JS 只拥有会话。
2. 焦点归 TerminalView。
3. init command 是「键入」不是 exec。
4. BEL + OSC title 是唯一稳定的跨 CLI 协议。ACP 是另一条路。
5. Windows 走 ConPTY（Win10 1809+）。
6. PTY 字节不到 JS。事件只上报 title / bell / exit / resize。
7. GPUIX 的 GPUI 是 pin 过的 fork，Phase 0 必须验证 `gpui-terminal` 版本，对不上就 vendoring `TerminalView`。

---

## 5. 落地顺序

**Phase 0** 独立 Rust 窗口：`gpui-terminal` + PTY 跑 `claude` / `pi`，确认 Windows ConPTY、真彩色、应用光标、BEL、OSC title、GPUI 版本。

**Phase 1** `<terminal>` custom element。React 只传 `cwd/env/initCommand`，收 `onTitle/onBell/onExit`。用 sidebar 切两个 PTY。

**Phase 2** Terminal Thread 语义：ThreadStore、init command、BEL 通知、关闭不归档、与 chat thread 混排。同期启动设置基础：`settings-core` / `settings-controls` / `settings-term-notify` 切片（`docs/settings-ui.md` §14）。

**Phase 3** 预设、内置 BEL/title 约定、未聚焦 badge、`Ctrl-Tab`、再考虑 ACP / worktree / split / JSON-RPC。同期收尾设置：`settings-presets`（随预设落地）。

**Phase 3+** `settings-acp-advanced`（随 ACP 接入：ACP 分区、JSON 实时视图、键位编辑解锁）。

---

## 6. UI 展示：要拍板的分叉

调研已经把「能不能融」关掉了。后面真正决定产品形状的是展示，不是协议。下面每个分叉都有推荐。未拍板前不要写布局代码。

### 6.1 主布局：一次看几个终端

Zed Terminal Threads = 左列表 + 右单 pane。muxel = 可分割多 pane。

```
A. Zed 式（推荐第一期）              B. muxel 式
┌────────┬──────────────────┐      ┌────┬─────────┬─────────┐
│ claude │                  │      │proj│ claude  │  pi     │
│ pi  ●  │   一个 Terminal  │      │    ├─────────┼─────────┤
│ amp    │                  │      │    │ amp     │ shell   │
└────────┴──────────────────┘      └────┴─────────┴─────────┘
```

| | A 单 pane | B 多 pane |
|---|---|---|
| TUI 高度 | 满 | 被切碎，claude/codex 很难用 |
| 心智 | 和 chat thread 同一套 | 变成 multiplexer |
| 实现 | GPUIX flex 即可 | 要 split 树、拖拽、焦点链 |
| 并行感知 | 靠 sidebar 状态 | 一眼看见多个画面 |

**推荐 A。** 并行靠列表状态，不靠同时画多个 TUI。允许以后「弹出独立窗口」，那是 Phase 3。

### 6.2 切到 Terminal Thread 时，chrome 有多少

TUI agent（Claude Code / Codex / Pi）要几乎整块高度。chrome 多一像素都在抢行数。

```
C1 纯终端（推荐）          C2 薄顶栏               C3 顶栏 + 底 composer
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│ $ claude        │      │ pi · main · ●   │      │ pi · main · ●   │
│                 │      ├─────────────────┤      ├─────────────────┤
│  (TUI 全高)     │      │ $ claude        │      │  (TUI)          │
│                 │      │                 │      ├─────────────────┤
└─────────────────┘      └─────────────────┘      │ Ask…            │
```

| | C1 | C2 | C3 |
|---|---|---|---|
| 行数 | 最大 | 少 1 行 | 少很多，TUI 崩 |
| 标题 / cwd / 状态 | 只在 sidebar | 当前 thread 也看得到 | 同 C2，但有第二输入面 |
| 和 chat 一致性 | 切换时完全换表面 | 顶栏可复用 chat 的 header | 错误地复用 chat composer |

**推荐 C1，顶栏信息全部进 sidebar。** 若 OSC 标题太长看不清，用 C2，顶栏高度锁死 28–32px，禁止第二输入框。

C3 是明确否决项：终端 thread 的输入面就是 PTY。再放 composer 会造成「这句话进模型还是进 stdin」的歧义，也和 vim / claude 抢 Ctrl-C、Enter、Esc。

### 6.3 Thread 列表：混排还是分开

```
D1 混排（推荐）                 D2 分段                    D3 两个 Plane
┌──────────────┐               ┌──────────────┐            Chat | Terminal
│ ◎ 修登录     │ chat          │ CHAT         │
│ ▌ claude ●   │ term          │  ◎ 修登录    │
│ ◎ ACP Codex  │ acp           │ TERMINAL     │
│ ▌ pi         │ term          │  ▌ claude ●  │
└──────────────┘               └──────────────┘
```

Zed 选 D1：同一套 `Ctrl-Tab`、同一套通知、同一套「这个项目在跑什么」。Terminal 用终端图标区分，不单独开 dock。

**推荐 D1。** D3 会把「Agent Plane」拆成两个产品。D2 可作视觉分组，不要变成两个数据模型。

列表行最小信息：

- 图标：chat / terminal / acp
- 标题：`customTitle ?? oscTitle ?? initCommand ?? "Terminal"`
- 状态点：无 / 工作中（可省略第一期）/ needs-you（BEL）/ exited
- 关闭按钮 hover 才出现

OSC 标题可能很长（Codex：`spinner · project · run-state · thread-title`）。规则：

- sidebar 单行 ellipsis
- `customTitle` 一旦手改，不再被 OSC 覆盖
- 完整标题只进 tooltip

### 6.4 空状态与新建

```
E1 直接开 shell（Zed）     E2 预设卡片（推荐）
+ 菜单选 Terminal          ┌─────────────────────────┐
立刻 PTY + init_command    │  开一个 Terminal Thread │
                           │  [Claude] [Pi] [Codex]  │
                           │  [Amp]    [Shell]       │
                           └─────────────────────────┘
```

Zed 靠一条全局 `terminal_init_command`，所以「新建 = 永远开同一个 CLI」。我们同时要跑 Pi / Claude / Codex，全局一条不够。

**推荐 E2：** `+` 打开预设，每项带 `program / args / env / initCommand`。选完再 spawn。保留「纯 Shell」项。`lastUsedPreset` 决定 `+` 单击的默认，Shift+`+` 或 `+` 旁小三角打开菜单。

### 6.5 状态与通知怎么露

第一期只信任两件事：OSC title、BEL。不要解析 TUI 输出猜 working / done。

| 信号 | 展示 |
|---|---|
| 未聚焦 + BEL | sidebar 红点 + 桌面通知（可关声音） |
| 聚焦该 thread | 清红点、清通知 |
| OSC title 变 | 改列表标题（若无 customTitle） |
| 进程 exit | 列表变灰 + 「exited」，PTY 可留着看残留，或直接关 |
| 无信号 | 不装 busy spinner，避免假忙碌 |

Pi 配方已有：`.pi/extensions/zed-bell.ts` 在 `agent_end` 写 `\x07`。Amp / Claude 同样只接 BEL。

通知点进 thread = `activate` + 清 badge，对齐 Zed。

### 6.6 Chat 与 Terminal 切换时的表面替换

这是最容易做丑的点。两种 thread 的 body 完全不是同一种东西：

- Chat：`virtual-list` 消息 + composer
- Terminal：一块原生 `TerminalView`，自己抓键盘

**规则：切换 thread 类型 = 卸掉整块 body，不要在同一棵树里藏着互相 `display:none`。** 原因：

1. 隐藏的 TerminalView 仍占 PTY 和 GPU 文字 atlas
2. 焦点链会乱：composer 和 TUI 抢 FocusHandle
3. 未聚焦的 PTY 必须继续跑，但 **不要继续 paint**；Rust 侧只在 `BaseView` 指向它时 `render()`

未激活的 terminal entity 要 retain（否则切回来 PTY 没了），但 `GpuixView` 不要每帧 build 它的格子。

### 6.7 颜色、字体、padding

TUI 对 cell 尺寸极其敏感。

- 字体：必须 monospace，字号与行高由 terminal 自己管，不要跟 chat 的 UI 字体混
- padding：TerminalView 外圈 0。chrome 的 padding 只存在于 sidebar
- 背景：terminal 用自己的 palette（默认跟 chat 深色表面接近，但由 ColorPalette 决定，不被父 `div` 的 `backgroundColor` 染色）
- 选区 / 滚轮：全部进 TerminalView，不要让外层 `overflow: scroll` 包它

### 6.8 明确不做（第一期）

- 终端内嵌第二 composer
- 输出启发式状态机（working / awaiting-input）
- tmux 式 split
- 把 ACP diff/accept 画在 Terminal Thread 上
- 滚动回放 / 把 PTY 历史当 chat 消息渲染
- 用 GPUIX `text` 重绘格子

---

## 7. 推荐的第一期画面

```
┌─ j-agent ─────────────────────────────────────────────┐
│                                                       │
│  ┌─────────────┬──────────────────────────────────┐   │
│  │ AGENT       │                                  │   │
│  │             │                                  │   │
│  │ ◎ 修登录    │   native TerminalView            │   │
│  │ ▌ claude  ● │   (PTY, 全高, 无 composer)       │   │
│  │ ▌ pi        │                                  │   │
│  │ ◎ ACP Codex │                                  │   │
│  │             │                                  │   │
│  │ + Claude ▾  │                                  │   │
│  └─────────────┴──────────────────────────────────┘   │
└───────────────────────────────────────────────────────┘
```

交互：

- 左列混排 chat / terminal / acp，图标区分
- 选中 terminal 行 → 右侧整块换成 `<terminal>`
- 选中 chat 行 → 右侧换成消息列表 + composer
- `+` 默认上次预设，三角选 Claude / Pi / Codex / Amp / Shell
- BEL 未聚焦 → 该行红点；点进去消失
- 标题来自 OSC，手改后冻结
- 无顶栏、无底栏、无 split

这已经是 Zed Terminal Threads 的最小复刻，同时用 GPUIX 的 React 壳保住 chat 迭代速度。

---

## 8. 拍板状态

第 6 节分叉已锁定，详见 **`docs/agent-plane-layout.md`**。可交互原型：`design/agent-plane-layout.html`。设置界面分叉（第 7 条）见 **`docs/settings-ui.md`**，原型：`design/settings-ui.html`。

1. 布局：**单 pane**（A）
2. chrome：**无顶栏**（C1）
3. 列表：**混排**（D1）
4. 新建：**预设菜单**（E2）
5. 状态：**只 BEL + OSC**
6. 切换：**整块替换 body，后台 PTY retain 但不 paint**
7. 设置：**S1–S5**（Pane 特殊表面 / 即时生效 / settings.json 事实源 / 预设进设置 / 键位只读）→ `docs/settings-ui.md`，落地切片见其 §14
