# Settings UI 布局规格

状态：**已拍板并确认**（2026-09-02）
依据：`docs/agent-plane-layout.md`（布局契约）+ 2025–2026 设置 UI 调研（Zed Settings Editor 等）
可交互原型：`design/settings-ui.html`
落地：见 §14 落地顺序（挂靠 `gpuix-zed-terminal-fusion.md` §5 Phase 计划）
视觉基调：Zed One Dark 深色开发者风（与 `design/agent-plane-layout.html` 同一套 tokens）

本文回答一个问题：**j-agent 的全部设置放在哪里、长什么样、怎么改。** 实现应对齐本文件，而不是重新发明设置 chrome。

---

## 1. 拍板结论

| # | 分叉 | 选择 | 含义 |
|---|---|---|---|
| S1 | 设置的位置 | **Pane 特殊表面** | `Ctrl-,` / sidebar 齿轮 → Pane 整块替换为 `SettingsView`；thread sidebar 保留，后台 PTY 继续跑 |
| S2 | 生效模型 | **即时生效 + 单项 reset** | 无全局保存按钮；改过的项出现 modified 标记 + 单项恢复默认 |
| S3 | 事实源 | **settings.json** | JSON 文件是唯一事实源，UI 只是它的表单视图，往返保真 |
| S4 | 预设管理 | **设置内完成** | 内置 5 预设 + 自定义预设的增删改全部在 Settings 的 Presets 分区，预设菜单只负责选用 |
| S5 | 键位编辑 | **第一期只读** | Keybindings 分区为只读表；可编辑键位推迟到 Phase 3 |

明确否决（第一期）：

- 模态 overlay 式设置（表单量级超出 overlay 承载）
- 全局 Save/Cancel 按钮（与即时生效冲突）
- 设置作为 thread 出现在混排列表（设置不是会话，不进 History）
- 图形化主题编辑器、palette 逐色自定义（第一期单主题）
- 在预设菜单里内联编辑预设字段（菜单只选用，编辑进设置）

独立设置窗口（Zed 2025 Settings Editor 的形态）**不否决**，作为 Phase 3+ 备选：待 GPUIX 多窗口能力验证后再升级。第一期用 Pane 表面零新增 API，复用「整块替换 body」既有模式。

---

## 2. 外部参考（2026-09-02 调研）

| 来源 | 采纳点 |
|---|---|
| Zed Settings Editor（zed.dev/blog/settings-ui，2025 秋；`crates/settings_ui`） | 左侧分类导航 + 右侧表单；顶部搜索过滤；类型驱动控件（toggle / dropdown / input）；单项 modified 标记 + reset to default；JSON 文件为事实源、UI 是表单视图、往返保真；即时生效 |
| 设置页通用模式（多份 2025 UX 调研） | ≥8 个分区用持久左侧导航；按用户任务（不是技术模块）分组；即时应用；可深链 |
| Claude Code settings reference（code.claude.com） | `preferredNotifChannel: "terminal_bell"`、model/env/hooks 等字段 → 只作只读约定展示，j-agent 不代管 CLI 自己的配置 |
| Codex CLI config（developers.openai.com） | `~/.codex/config.toml`、`tui.terminal_title` → 同上 |
| 本仓库 `docs/gpuix-zed-terminal-fusion.md` §6.5 | 只信 BEL + OSC → 通知分区不提供「忙碌状态」类设置，避免假忙碌 |

原则性结论：**j-agent 的设置管「壳」，CLI 自己的设置管「里面跑什么」。** 设置界面展示 CLI 侧约定（BEL/OSC 配方）为只读卡片，不做透传编辑器。

---

## 3. 信息架构

```
j-agent window
└── Agent Plane
    ├── Sidebar（thread 列表，保持不变；后台 PTY 继续跑，BEL 仍落在列表）
    │   └── footer 齿轮按钮 = 设置入口
    └── Pane
        ├── ChatView / TerminalView / AcpView / EmptyPresets（见 agent-plane-layout.md）
        └── SettingsView（S1 特殊表面）
            ├── SettingsNav（左列，宽 218px）
            │   ├── 搜索框（"/" 聚焦）
            │   ├── Presets          ★ 预设管理
            │   ├── Notifications    通知
            │   ├── Terminal         终端
            │   ├── Appearance       外观
            │   ├── Keybindings      键位（第一期只读）
            │   ├── ACP Agents       ACP 子进程
            │   └── Advanced         高级 + settings.json 实时视图
            └── SettingsContent（右列，表单区，滚动）
```

7 个分区 ≥ 持久左导航阈值。分区按用户任务命名，不按内部模块。

---

## 4. 打开方式与生命周期

| 动作 | 行为 |
|---|---|
| `Ctrl-,` 或 sidebar 齿轮 | Pane 整块替换为 `SettingsView`（复用 agent-plane-layout.md §8 模式） |
| 再按 `Ctrl-,` / `Esc` | 关闭设置，回到之前 active thread 的表面 |
| `Ctrl-Tab` / `Ctrl-Shift-Tab` | 设置打开时仍切 thread；切走即关闭设置表面 |
| 打开设置时 terminal thread 被 retain | 后台 PTY 不销毁、不 paint；BEL 照常在列表上落红点 |

规则：

- `SettingsView` **不是 thread**：不进混排列表、不进 History、不产生通知
- Sidebar 全程保留（设置希望更宽时用户可自行拖窄 sidebar，但第一期不做全屏设置）
- 打开设置时焦点进入搜索框；关闭时焦点还原到之前的表面（terminal 则还给 `FocusHandle`）

---

## 5. 设置行控件规范

### 5.1 行结构

```
┌───────────────────────────────────────────────┬──────────────┐
│ Label                                  ●      │ [控件]  [↺] │
│ 说明文字（muted，一行）                        │              │
└───────────────────────────────────────────────┴──────────────┘
```

- 左：label + 单行 description（muted）
- 右：控件 + modified 蓝点 + reset 按钮
- **modified 蓝点常显**（键盘可发现）；reset 按钮 hover / focus-within 时出现——不可 hover-only（对齐 agent-plane-layout.md §10 关闭按钮规则）
- reset 点击 = 恢复该项默认值，蓝点消失

### 5.2 控件类型映射

| 设置类型 | 控件 |
|---|---|
| boolean | toggle 开关 |
| 枚举 | select 下拉 |
| 数值（窄范围、视觉反馈有意义，如 sidebar 宽度） | slider + 实时数值 |
| 数值（宽范围，如 scrollback） | number stepper |
| 字符串（字体名、命令） | text input（命令类用 mono） |
| string[] / Record（预设 args/env） | textarea，行式语法（args 每行一个；env 每行 `KEY=VALUE`） |
| 只读约定 / 诊断信息 | 表格 / 代码卡片 |
| 动作（打开文件等） | button |

### 5.3 状态

- 第一期不可用项（其他主题、可编辑键位）**可见但 disabled**，标注 `Phase 2/3` 徽章——让用户知道路线图，而不是功能凭空消失
- 所有控件即时写 `settings.json`；写失败（磁盘/权限）时行内红条提示并回滚显示值

---

## 6. 设置项全清单（settings.json schema）

**所有设置都在这里。** 新增设置必须先进本表再进 UI。

```ts
type Settings = {
  presets: {
    plusDefault: string | null   // "+" 按钮默认预设；null = 跟随 lastUsedPreset
    items: TerminalPreset[]      // 5 内置 + 自定义，见 agent-plane-layout.md §6
  }
  notifications: {
    desktop: boolean             // BEL 且未聚焦 → 桌面通知。默认 true
    sound: boolean               // 通知声音。默认 false
  }
  terminal: {
    fontFamily: string           // 默认 "JetBrains Mono"
    fontSize: number             // 10–22，默认 13；行高由 TerminalView 自管
    cursorBlink: boolean         // 光标闪烁。默认 true；尊重系统 reduced-motion
    scrollbackLines: number      // 1000–100000，默认 10000
    palette: string              // 默认 "one-dark"；第一期唯一
    closeOnExit: boolean         // 进程退出后：false=保留 exited 灰行可看残留（默认），true=直接关闭销毁
  }
  appearance: {
    theme: string                // 默认 "one-dark"；第一期唯一
    sidebarWidth: number         // 200–400，默认 248
  }
  acpAgents: AcpAgent[]          // { id, label, command, args[] }
  advanced: {
    gpuBackend: "auto" | "metal" | "dx12" | "vulkan"   // 默认 auto
  }
}
```

分表：

| 分区 | key | 默认 | 约束 / 说明 |
|---|---|---|---|
| Presets | `presets.plusDefault` | `null` | null=跟随上次使用；可固定为任一预设 id |
| Presets | `presets.items[]` | 5 内置 | 见 §7 预设编辑器 |
| Notifications | `notifications.desktop` | `true` | 仅「未聚焦 + BEL」触发；聚焦即清 |
| Notifications | `notifications.sound` | `false` | 依赖 desktop 开启 |
| Terminal | `terminal.fontFamily` | `"JetBrains Mono"` | mono 字体；不继承 UI 字体 |
| Terminal | `terminal.fontSize` | `13` | 10–22 整数 |
| Terminal | `terminal.cursorBlink` | `true` | 系统 reduced-motion 时强制关 |
| Terminal | `terminal.scrollbackLines` | `10000` | 1000–100000 |
| Terminal | `terminal.palette` | `"one-dark"` | 第一期唯一；terminal 背景独立于父容器 |
| Terminal | `terminal.closeOnExit` | `false` | 落实调研 §6.5「PTY 留着看残留，或直接关」的分叉 |
| Appearance | `appearance.theme` | `"one-dark"` | 第一期唯一，其余项 Phase 2 |
| Appearance | `appearance.sidebarWidth` | `248` | 200–400；拖拽实时写回 |
| Keybindings | —（只读） | — | 见 §9；可编辑 Phase 3 |
| ACP | `acpAgents[]` | 2 示例 | JSON-RPC 子进程命令；凭证走 shell 环境 |
| Advanced | `advanced.gpuBackend` | `"auto"` | GPUIX fork 的后端选择 |

**不进 settings.json 的运行时状态**：`lastUsedPreset`、各 thread 的 `hasBell` / `oscTitle` / `status`、窗口位置——由 ThreadStore / 本地 state 持有；当前激活表面由路由承载（`/thread/$id` · `/settings` · `/`，见 `docs/architecture.md` §3.5），不再单独存 `activeThreadId`。理由：设置是用户意图，运行时是机器记忆；后者频繁自动变化，混入 JSON 会制造无意义 diff。

存储位置：第一期用户级 `~/.j-agent/settings.json`；项目级覆盖（`.j-agent/settings.json`）Phase 2。

---

## 7. 预设编辑器（Presets 分区）

顶部一行 `+` 按钮默认（`presets.plusDefault`）设置，下面是预设列表。

预设行（收起态）：

- 图标 + label + mono 展示 `program args…`（Shell 预设显示「系统默认 shell」）
- 徽章：`内置` / `自定义`；被改过另加 modified 蓝点
- 行尾动作：编辑（展开）、复制、重置（仅内置、仅 modified 时）、删除（仅自定义）

展开态字段：

| 字段 | 控件 | 说明 |
|---|---|---|
| label | text | 列表与预设菜单显示名 |
| program | text (mono) | 可执行文件名或绝对路径；**留空 = 系统默认 shell** |
| args | textarea | 每行一个参数 |
| env | textarea | 每行 `KEY=VALUE`；如 Amp 的 `AMP_FORCE_BEL=1` |
| initCommand | text (mono) | **作为普通键入打进 shell，不是 exec 替换进程**（调研 §2.2 规则） |
| cwd | text (mono) | 可选；默认项目根目录 |

规则：

- 5 个内置预设（claude / pi / codex / amp / shell）**不可删除、id 不可改**，字段可改、可一键重置回默认
- 自定义预设可删；删除前若 `plusDefault` / `lastUsedPreset` 指向它，回退 `null`
- 复制内置预设生成自定义副本（`builtin:false`）
- 列表底部 `+ 新增预设`
- 凭证走 shell 环境；设置界面**不出现任何 API key 输入框**（调研 §2.2「不从 LLM settings 拷 key」）

---

## 8. 通知分区（Notifications）

两个开关（desktop / sound，见 §6）+ 一张**只读约定卡**：

```
CLI 侧 BEL / OSC 约定（j-agent 只信任这两个信号）
  Pi      .pi/extensions/zed-bell.ts 在 agent_end 写 \x07
  Amp     env AMP_FORCE_BEL=1
  Claude  settings.json → preferredNotifChannel: "terminal_bell"
  Codex   tui.terminal_title → OSC 标题
```

约定卡是产品文档，不是配置入口：点击各项仅展示「去哪改」，不代管 CLI 配置。分区里**没有**「忙碌状态 / 完成检测」类设置——那是明确否决项（输出启发式状态机）。

---

## 9. 搜索与 Keybindings

搜索：

- 搜索框置顶 nav，`/` 全局聚焦（不在输入态时）
- 过滤范围：设置项 label / description / key 路径、预设名、键位表动作名
- 命中行所属分区在 nav 上显示计数徽章；0 命中分区置灰
- label 内 `<mark>` 高亮；`Esc` 清空；无结果显示空态 + 清除按钮
- 搜索不改分区结构，只是过滤视图（对齐 Zed 行为）

Keybindings（第一期只读表）：

| 动作 | 键 |
|---|---|
| 循环切换 thread（混排） | `Ctrl-Tab` / `Ctrl-Shift-Tab` |
| 打开 / 关闭设置 | `Ctrl-,` |
| 聚焦设置搜索 | `/` |
| 返回 / 清空搜索 | `Esc` |
| 新建（默认预设）/ 预设菜单 | `+` 单击 / `Shift +`（按钮手势） |

---

## 10. Advanced 分区

- `advanced.gpuBackend` 下拉
- **settings.json 实时视图**：只读代码块展示当前序列化 JSON，任何修改即时反映——证明「JSON 是事实源、UI 是表单视图」
- 「在编辑器中打开 settings.json」按钮
- 诊断信息（只读）：版本、GPUIX fork pin 说明、平台（Windows / ConPTY）

---

## 11. 键盘与无障碍

- 所有控件原生可聚焦，`:focus-visible` 环（accent）
- icon-only 按钮（reset ↺、删除、复制）必须有 `aria-label`
- modified 状态不只靠颜色：reset 按钮本身可被键盘聚焦即等价可发现；蓝点之外 tooltip 说明「已修改」
- toggle 用真 checkbox（role 正确），slider 用 `input[type=range]`
- 尊重 `prefers-reduced-motion`：过渡、光标闪烁关
- 搜索框 `role=searchbox`；nav 为 `tablist`，分区为 `tab`（方向键切换）

---

## 12. 组件树（实现对齐）

```tsx
<SettingsView settings={settings} onChange={patch}>
  <SettingsNav sections={SECTIONS} activeId={activeSection}
    query={query} onQuery={setQuery} onPick={setActiveSection} />
  <SettingsContent>
    {activeSection === "presets" && <PresetsSection
      presets={settings.presets}
      onPatch={patch} onResetPreset={resetPreset}
      onDuplicate={duplicatePreset} onAdd={addPreset} onDelete={deletePreset} />}
    {activeSection === "notifications" && <>
      <SettingRow path="notifications.desktop" … />
      <SettingRow path="notifications.sound" … />
      <CliConventionsCard />  {/* 只读 */}
    </>}
    {/* terminal / appearance / keybindings / acp / advanced 同构 */}
  </SettingsContent>
</SettingsView>
```

入口（挂到 agent-plane-layout.md §9 的 Sidebar footer）：

```tsx
<IconButton icon="gear" label="设置（Ctrl-,）" onClick={openSettings} />
```

---

## 13. 与其他文档的关系

| 文件 | 角色 |
|---|---|
| `design/settings-ui.html` | 可点击蓝本：7 分区导航、搜索过滤、即时生效 + modified/reset、预设编辑器、JSON 实时视图 |
| 本文件 | 设置实现契约；GPUIX 阶段按此验收 |
| `docs/agent-plane-layout.md` | Plane 布局契约；SettingsView 是其 Pane 的第五种表面（非 thread kind） |
| `docs/gpuix-zed-terminal-fusion.md` | 调研与架构；§6.5 通知分叉在此落实为 `notifications.*` 与 `terminal.closeOnExit` |

原型右下角 Demo Controls **不是产品 UI**，只用于演示 modified 状态与重置。

---

## 14. 落地顺序

设置不单独立项，挂在 `docs/gpuix-zed-terminal-fusion.md` §5 的既有 Phase 上。依赖决定切片：

| 切片 | 内容 | 依赖 | 挂靠 Phase |
|---|---|---|---|
| `settings-core` | schema + 读写层 + SettingsView 骨架 | settings.json 读写、Pane 整块替换（activate 机制） | Phase 2 起步 |
| `settings-controls` | 标准行控件库 + modified/reset + 搜索 | GPUIX 表单控件（input / select / textarea） | Phase 2 |
| `settings-term-notify` | Terminal / Notifications 分区接真值 | BEL 通知管线（Phase 2）、gpui-terminal 字段（Phase 0 验证） | Phase 2 收尾 |
| `settings-presets` | Presets 分区 CRUD + 新建接线 | 预设数据模型、`+` / 空状态卡片（Phase 3 起点） | Phase 3 |
| `settings-acp-advanced` | ACP 分区、JSON 实时视图、键位编辑解锁 | ACP agent 接入（Phase 3+） | Phase 3+ |

切片定义：

1. **settings-core**：`Settings` schema + 默认值合并 + 即时写入 + 修改检测（diff vs 默认）；`SettingsView` 骨架（7 分区导航、`Ctrl-,` / `Esc` 生命周期、焦点进搜索框）。验收锚点：§15 第 1–2、4 条
2. **settings-controls**：标准行控件（toggle / select / number / text / range）+ modified 蓝点 + 单项 reset + 搜索（过滤 / 高亮 / 计数 / 空态 / `/`）+ Phase 徽章渲染。验收锚点：§15 第 3、5、10、11 条
3. **settings-term-notify**：字体 / 字号 / scrollback / palette 写到 TerminalView；`notifications.desktop` / `sound` 接 BEL 通知管线；`terminal.closeOnExit` 接 exit 流程；通知分区约定卡只读。验收锚点：§15 第 9 条
4. **settings-presets**：内置不可删可重置、自定义增删改复制；接线 `+` 按钮、空状态卡片、`plusDefault` 与 `lastUsedPreset`（运行时态，不写 settings.json）。验收锚点：§15 第 7–8 条
5. **settings-acp-advanced**：ACP agent 列表（随 ACP 接入）、settings.json 实时视图、「在编辑器中打开」、S5 解锁为可编辑键位。验收锚点：§15 第 6 条

横切：§15 第 12 条（focus-visible / aria-label / reduced-motion）随各切片一并验收，不单独挂靠。

规则：

- 每个切片独立可验收；UI 无真值可接时先落 schema 与控件（值暂不生效），不阻塞并行
- `lastUsedPreset`、`hasBell` 等运行时状态由 ThreadStore / 本地 state 持有；激活表面由路由承载——永不出现在 settings.json
- Keybindings 分区在切片 5 之前保持只读表（S5）

---

## 15. 验收清单（设置）

- [ ] `Ctrl-,` / 齿轮打开；`Esc` / `Ctrl-,` / 切 thread 关闭；设置不进列表、不进 History
- [ ] 打开设置时 sidebar 保留；后台 terminal retain 不 paint；BEL 照常落红点
- [ ] 7 分区左导航；`/` 聚焦搜索；过滤 + 高亮 + 计数 + 空态
- [ ] 所有修改即时生效，无全局保存按钮
- [ ] 修改项显示蓝点；reset 恢复默认且蓝点消失；reset 可键盘触达
- [ ] settings.json 为事实源：实时视图随修改同步；「在编辑器中打开」可用
- [ ] 预设：内置 5 个不可删可重置；自定义可增删改；复制内置 → 自定义
- [ ] `plusDefault` 删除目标预设后回退 null；lastUsedPreset 不写入 settings.json
- [ ] 通知分区无「忙碌检测」类设置；CLI 约定卡只读
- [ ] 第一期不可用项 disabled + Phase 徽章，不隐藏
- [ ] 无 API key 输入框；凭证走 shell 环境
- [ ] focus-visible 全覆盖；icon-only 按钮有 aria-label；reduced-motion 生效
