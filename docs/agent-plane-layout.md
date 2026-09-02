# Agent Plane 布局规格

状态：**已拍板**  
依据：`docs/gpuix-zed-terminal-fusion.md` §6 / §8  
可交互原型：`design/agent-plane-layout.html`  
视觉基调：Zed One Dark 深色开发者风

本文把调研里的展示分叉落成可实现的布局契约。实现（GPUIX React 壳）应对齐本文件，而不是重新发明 chrome。

---

## 1. 拍板结论

| # | 分叉 | 选择 | 含义 |
|---|---|---|---|
| 1 | 主布局 | **A 单 pane** | 左列表 + 右单一内容区；并行靠列表状态，不靠同时画多个 TUI |
| 2 | Terminal chrome | **C1 无顶栏** | 选中 terminal thread 时右侧全是 `TerminalView`，无 header、无底栏、无第二 composer |
| 3 | Thread 列表 | **D1 混排** | chat / terminal / acp 同一列表、同一套切换与通知；图标区分类型 |
| 4 | 新建 | **E2 预设菜单** | `+` 默认上次预设；三角 / Shift+`+` 打开 Claude / Pi / Codex / Amp / Shell |
| 5 | 状态协议 | **只 BEL + OSC** | 不解析 TUI 输出猜 working / done |
| 6 | 切换 | **整块替换 body** | 换 thread 类型 = 卸掉整块 body；未激活 PTY retain，但不 paint |

明确否决（第一期）：

- 终端内嵌第二 composer（C3）
- tmux 式 split（B）
- 把 Agent Plane 拆成 Chat / Terminal 两个 Plane（D3）
- 输出启发式状态机、ACP diff 画在 Terminal Thread 上
- 用 GPUIX `text` / WebView / xterm 仿格子

---

## 2. 信息架构

```
j-agent window
└── Agent Plane
    ├── Sidebar（会话层，JS 拥有）
    │   ├── Header: "AGENT" + Ctrl-Tab 提示
    │   ├── ThreadList（混排）
    │   └── NewThread: [+ {lastPreset}] [▾ presets]
    └── Pane（按 active thread 整块替换）
        ├── ChatView      → messages + composer
        ├── TerminalView  → native <terminal> only（C1）
        ├── AcpView       → ACP transcript + composer
        ├── SettingsView  → 设置表单（Pane 特殊表面，非 thread；见 docs/settings-ui.md）
        └── EmptyPresets  → 预设卡片（无 thread 时）
```

所有权：

- **JS / ThreadStore**：列表、标题、bell badge、预设、通知、active id
- **Rust / TerminalView**：PTY、VTE、绘制、焦点、resize / exit / title / bell 事件
- 字节流不过 napi；会话事件（title / bell / exit）走全局通道，元素事件只留 focus / blur——实现形状见 `docs/architecture.md` §2（TerminalPool + sessionId 绑定）

---

## 3. 尺寸与间距

| Token | 值 | 用途 |
|---|---|---|
| `--sidebar-w` | `248px` | 左侧栏固定宽；可后续做成可拖，但不小于 200 |
| `--row-h` | `28px` | thread 行高 |
| `--titlebar-h` | OS / 窗口自管 | 产品 Plane 内不再加第二层顶栏 |
| Terminal 外圈 padding | **0** | chrome padding 只存在于 sidebar |
| Chat / ACP 消息区内边距 | `20–24px` | 与 terminal 无关 |
| Composer 区 | chat / acp 专用 | terminal **禁止**出现 |
| 列表行左右 inset | `6px` margin + `8px` padding | hover / active 圆角 `4px` |
| Active 指示条 | 左缘 `2px` accent | 贴在行外侧，不占文字宽 |

字体：

- UI：`IBM Plex Sans` / 系统 UI 栈
- Terminal / OSC 标题 / mono 提示：`JetBrains Mono`（或 Cascadia Code）
- Terminal 字号与行高 **由 TerminalView 自己管**，不继承 chat UI 字体

颜色（Zed One Dark 语义）：

| 角色 | Hex | 用法 |
|---|---|---|
| App / Pane | `#282c34` / `#1e2127` | 主表面 |
| Sidebar | `#21252b` | 列表底 |
| Terminal bg | `#1a1d23` | 独立 palette，不被父 `backgroundColor` 染色 |
| Text | `#abb2bf` / bright `#d7dae0` | 主文字 |
| Muted | `#5c6370` | 次级 |
| Accent | `#61afef` | 选中条、chat 标记、焦点环 |
| Terminal kind | `#98c379` | terminal 图标 |
| ACP kind | `#c678dd` | acp 图标 |
| BEL / destructive | `#e06c75` | needs-you 红点、关闭 hover |
| Border | `#181a1f` / subtle `#3e4451` | 分割线 |

---

## 4. Sidebar 列表行

最小信息（每行）：

1. **图标**（SVG，禁止 emoji）
   - chat：圆环点
   - terminal：竖条 ▌
   - acp：折线标记
2. **标题**：`customTitle ?? oscTitle ?? initCommand ?? "Terminal"`
3. **状态**
   - `hasBell && !focused` → 红点（needs-you）
   - `status === "exited"` → 灰色行 + `exited` 微标签
   - 第一期不做 busy spinner
4. **关闭按钮**：默认隐藏；hover / focus-within / active 时出现

标题规则：

- 单行 ellipsis
- 完整标题只进 tooltip
- `customTitle` 一旦手改，**不再被 OSC 覆盖**（冻结）
- Codex 类长标题（`spinner · project · run-state · thread-title`）依赖 ellipsis + tooltip，不换行

交互：

| 操作 | 行为 |
|---|---|
| 单击行 | `activate(id)`；若有 BEL → 清红点 / 清通知 |
| 双击标题 | 行内重命名 → 写入 `customTitle` |
| 关闭 | terminal：销毁 PTY 并从列表移除；不进 History |
| Delete / Backspace（行聚焦） | 同关闭 |
| Ctrl-Tab / Ctrl-Shift-Tab | 在混排列表中循环 |

---

## 5. Pane 表面

### 5.1 Terminal（C1）

```
┌──────────────────────────────────────┐
│                                      │
│         native TerminalView          │
│         (PTY · 全高 · 无 chrome)      │
│                                      │
└──────────────────────────────────────┘
```

- 无顶栏、无底栏、无 composer
- 焦点必须交给 `TerminalView` 的 `FocusHandle`；GPUIX `onKeyDown` 不得先吃 vim / claude 按键
- 选区 / 滚轮全部进 TerminalView；外层禁止 `overflow: scroll` 包一层
- 背景用 terminal 自己的 ColorPalette

### 5.2 Chat

- 薄顶栏可保留（类型 pill + 标题）—— 只属于 chat 表面，不共享给 terminal
- `virtual-list` 消息 + 底 composer
- composer 只把输入送进 chat agent，与 PTY stdin 无关

### 5.3 ACP

- 与 chat 同构的 transcript + composer
- 顶部可用 ACP pill 标明「外部 JSON-RPC，不是 PTY」
- ACP 的 diff / accept **不**画在 Terminal Thread 上

### 5.4 空状态（E2）

无 thread（或用户清空后）时，Pane 显示预设卡片网格：

- Claude / Pi / Codex / Amp / Shell
- 每项绑定 `program / args / env / initCommand`
- 选中后 spawn，并更新 `lastUsedPreset`

---

## 6. 新建与预设

```
[+ Claude] [▾]
```

| 手势 | 行为 |
|---|---|
| 单击 `+` | spawn `lastUsedPreset`（默认 Claude） |
| 单击 `▾` 或 Shift+`+` | 打开预设菜单 |
| 菜单项 / 空状态卡片 | spawn 该预设，并写入 `lastUsedPreset` |

`initCommand` 语义：作为**普通键入**打进 shell，不是 `exec` 替换进程。  
凭证走 shell 环境；不从 LLM settings 拷 key。

预设最小字段：

```ts
type TerminalPreset = {
  id: string                       // 内置固定为 claude/pi/codex/amp/shell；自定义任意唯一串
  label: string
  builtin: boolean                 // 内置不可删、id 不可改；复制内置 → builtin:false
  program?: string                 // 留空 = 系统默认 shell
  args?: string[]
  env?: Record<string, string>
  initCommand?: string             // 作为普通键入打进 shell，不是 exec
  cwd?: string                     // 可选；默认项目根目录
}
```

---

## 7. 状态与通知

第一期只信任：

| 信号 | 展示 |
|---|---|
| 未聚焦 + BEL | sidebar 红点 + 可选桌面通知 |
| 聚焦 / activate 该 thread | 清红点、清通知 |
| OSC title 变 | 更新列表标题（无 `customTitle` 时） |
| 进程 exit | 行变灰 + `exited`；PTY 可留看残留，或关闭销毁 |
| 无信号 | 不装假 busy spinner |

CLI 约定（产品侧文档化即可）：

- Pi：`agent_end` → `\x07`
- Amp：`AMP_FORCE_BEL=1`
- Claude：`preferredNotifChannel: "terminal_bell"`
- Codex：`tui.terminal_title` → OSC

---

## 8. 切换与生命周期

```
activate(threadId):
  1. 卸掉当前 Pane body（不要 display:none 藏着）
  2. 按 kind 挂载 ChatView | TerminalView | AcpView
  3. 若 kind=terminal：把焦点交给 TerminalView
  4. 清该 thread 的 hasBell / 通知
```

> 实现注记：active 状态由 TanStack Router（memory 模式）承载，`/thread/$id` · `/settings` · `/` 即 Pane 表面；本文语义不变，实现形状见 `docs/architecture.md` §3.5。

后台 terminal entity：

- **retain**（切走不能丢 PTY）
- **不要每帧 paint**（仅当 `BaseView` 指向它时 `render()`）
- 关闭 = 销毁，不进 Thread History

---

## 9. 组件树（实现对齐）

```tsx
<AgentPlane>
  <Sidebar>
    <ThreadList items={threads} activeId={activeId}
      onActivate={activate} onClose={close} onRename={rename} />
    <NewThreadButton lastPreset={lastUsedPreset}
      onDefaultSpawn={() => spawn(lastUsedPreset)}
      onOpenPresets={…} />
    <SidebarFooter>
      <IconButton icon="gear" label="设置（Ctrl-,）" onClick={openSettings} />
    </SidebarFooter>
  </Sidebar>

  <Pane>
    {active == null && <EmptyPresets onPick={spawnFromPreset} />}
    {active?.type === "settings" && <SettingsView />}
    {thread?.kind === "chat" && <ChatView thread={thread} />}
    {thread?.kind === "acp" && <AcpView thread={thread} />}
    {thread?.kind === "terminal" && (
      // spawn 参数（cwd/env/initCommand/scrollbackLines）走 createTerminalSession
      // napi 命令；title/bell/exit 走全局 onSessionEvent 通道（后台也送达）。
      // sessionId 绑定 = retain 语义的实现基础，详见 docs/architecture.md §2
      <terminal
        sessionId={thread.sessionId}
        fontFamily={…} fontSize={…} cursorBlink={…} palette={…}
        onFocus={() => clearBadge(thread.id)}
      />
    )}
  </Pane>
</AgentPlane>
```

`TerminalThread` 形状（对齐调研 §3；status 简化说明见 `docs/architecture.md` §2.5 R3——needs-you 由 `hasBell` 表达，展示语义不变）：

```ts
type TerminalThread = {
  id: string              // `t${sessionId}`
  sessionId: number
  cwd: string
  initCommand?: string
  env?: Record<string, string>
  status: "running" | "exited"
  hasBell: boolean
  createdAt: number
  customTitle?: string
  oscTitle?: string
  preset?: string             // TerminalPreset.id（内置或自定义）
  exitCode?: number | null
}
```

---

## 10. 无障碍与交互质量

- 所有可操作控件有可见 `:focus-visible` 环（accent）
- 关闭等 icon-only 按钮必须有 `aria-label`
- 状态不只靠颜色：BEL 红点之外，tooltip / 文案可表达 needs-you；exited 有文字微标签
- 尊重 `prefers-reduced-motion`（光标闪烁等可关掉）
- 关闭按钮不可「只在 hover 才能用」——键盘 focus-within 时也要可见（原型已做；实现需保持）

---

## 11. 与原型的关系

| 文件 | 角色 |
|---|---|
| `design/agent-plane-layout.html` | 可点击蓝本：混排、C1 全高终端、预设、BEL/OSC/exit、重命名冻结 |
| `design/settings-ui.html` | 设置蓝本：7 分区、搜索、即时生效 + modified/reset、预设编辑器、JSON 实时视图 |
| `docs/settings-ui.md` | 设置界面契约：SettingsView 为 Pane 特殊表面（S1–S5 拍板）；`settings.json` 为事实源 |
| `docs/architecture.md` | 代码实现契约：模块划分、接口签名、跨语言 seam（TerminalPool + sessionId + 全局事件通道）；本文 §9 组件树已按其 §2 修订 |
| 本文件 | 布局实现契约；GPUIX 阶段按此验收 |
| `docs/gpuix-zed-terminal-fusion.md` | 调研与架构；§8 默认建议已被本文锁定 |

原型右下角 Demo Controls **不是产品 UI**，只用于演示 BEL / OSC / Exit。

---

## 12. 验收清单（布局）

- [ ] 同时只显示一个 pane；无 split
- [ ] 激活 terminal 时右侧无顶栏、无 composer
- [ ] 列表混排 chat / terminal / acp，图标可区分
- [ ] `+` 使用 last preset；菜单含五个预设
- [ ] BEL 仅在未聚焦时红点；activate 后清除
- [ ] OSC 更新标题；`customTitle` 冻结后不覆盖
- [ ] 长标题单行 ellipsis + tooltip
- [ ] 切 thread 类型是整块替换，不是隐藏
- [ ] Terminal 外圈 padding = 0；焦点在 TerminalView
- [ ] 关闭 terminal = 销毁，不进 History
