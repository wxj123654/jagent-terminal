---
name: j-agent Obsidian Indigo Design System
description: 全高侧栏 + 悬浮圆角画布岛 + 单行融合顶栏 + Obsidian Indigo 现代深色界面（正式实现的视觉映射在 crates/jagent-app/src/theme.rs）
colors:
  app: "#0b0d12"
  sidebar: "#0d0f15"
  pane: "#12151e"
  terminal: "#12151e"
  surface: "#181c27"
  hover: "#1e2330"
  selected: "#23293a"
  border: "#1e2330"
  border-subtle: "#283042"
  text: "#c3cad9"
  bright: "#f2f5fa"
  muted: "#7e889b"
  faint: "#555e70"
  accent: "#6366f1"
  accent-hover: "#818cf8"
  on-accent: "#f2f5fa"
  green: "#34d399"
  red: "#f87171"
  amber: "#fbbf24"
  purple: "#c084fc"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  terminal:
    fontFamily: '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.85
rounded:
  control: "6px"
  navigation: "7px"
  island: "10px"
  dialog: "10px"
  window: "11px"
spacing:
  small: "6px"
  medium: "12px"
  large: "20px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "7px 13px"
  button-secondary:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.bright}"
    rounded: "{rounded.control}"
    padding: "7px 13px"
  session-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.bright}"
    rounded: "{rounded.navigation}"
---

# Design System: j-agent Obsidian Indigo

## Overview

采用 **Arc 风格左右对称双悬浮圆角岛 (Dual Floating Islands) + 单行 40px 融合工作台顶栏** 架构，搭配 **Obsidian Indigo（黑曜石靛蓝）** 高对比深色主题（灵感源自 Arc / Linear / Raycast）。

- **左右对称双悬浮圆角岛**：左悬浮导航岛（`#sidebar`）与右悬浮工作台画布岛（`#main`）并排悬浮于 `#07090e` 黑曜石底座之上，共享 `6px` 呼吸间距、`10px` 圆角、`1px solid #283042` 微光内描边与水平对称的 `40px` 岛内顶栏，消除传统直角侧栏与圆角主画布的风格割裂。
- **顶栏副页签定数上限 + 溢出下拉收纳**：会话内副页签（SessionTabs）在 40px 顶栏中部最多展示 `主视图 + 2 个副视图`，超出项自动折叠进右侧 `[+N ▾]` 下拉浮层（支持关键词过滤、当前激活项自动置前、单条关闭与一键关闭全部副视图），彻底杜绝多页签撑爆顶栏。
- **右栏专职导航器 + 主画布宽幅预览**：右侧面板专职承担「工作区变更分组列表」与「项目文件目录树」导航，点击任意文件直接在左侧宽敞的主画布打开 `FileSurface`（内置 `Unified Diff | 并排对比 | 完整源码` 三态分段切换器），彻底解决窄栏内文件列表与 Diff 抢占空间的问题。

## Colors

- **accent / on-accent**：焦点、主要操作及当前工具标识；不用于大面积背景装饰。
- **sidebar / terminal / surface**：分别承担应用导航、工具内容和抬升提示。
- **text / bright / muted**：普通、强调和次级文字。原型将次级文字提亮，保证常见选中背景上的可读性。
- **green / red / amber**：终端语义、通知及差异；图标、文字或符号同时表达状态，不仅依靠颜色。
- **border**：控件与浮层边界。列表分组优先使用间距，避免处处画框。

## Typography

导航使用系统 UI 字体，代码和 TUI 内容使用系统等宽字体；没有在线字体请求。等宽字体承担代码与终端本身，而非装饰标签。

界面文字以 12–13px 为主，辅助说明 11px；对话框标题 15px，空工作区标题 23px。移动预览表单输入 16px，避免浏览器自动放大。长路径可换行，侧栏标题单行省略并保留完整 accessible name 和 title。

## Layout & Multi-Page Architecture (UI/UX Pro Max)

单窗口全高侧栏 + 悬浮圆角画布岛 + 单行融合顶栏（40px，严禁子页面重复叠加内部顶栏）。常规侧栏 248px–276px，1100px 以下为 250px；760px 以下改为模态抽屉。

### 8 大核心页面布局规范

1. **空工作区启动台 (`empty_presets.rs`)**：采用 **Bento Launchpad 分层布局**（最大宽 720px），顶部展示工作区目录与 Git 状态胶囊；第一层双大卡突出高频主动作（「启动 AI Coding Agent `⌘N`」与「新建交互式终端 `⌘T`」）；第二层为 3 列紧凑预设矩阵；底部附带最近活跃会话一键恢复列表。
2. **AI 对话 / ACP 主面 (`conversation.rs`)**：**彻底移除内部重复的 44px `conv-head`**，将会话标题与「已连接 / 思考中」状态胶囊内联至外层 40px 融合顶栏；对话流内支持可折叠的 **Agent 工具执行链卡片**；底部升级为悬浮 **Composer 舱**（支持 `@文件` 上下文胶囊、模型选择与快捷键提示）。
3. **终端主面 + 会话内副视图 (`terminal_pane.rs` + `session_tabs.rs`)**：将会话内副页签作为紧凑胶囊组内联进 40px 顶栏中部，采用 **定数上限（最多 2 个副页签）+ `[+N ▾]` 溢出下拉收纳浮层**（支持搜索过滤与一键关闭全部副视图）；终端 PTY 画布四周预留 `12px × 16px` 呼吸内边距，底部配备 26px 轻量状态条。
4. **右侧变更/文件树导航栏 + 主画布宽幅预览 (`work_panel.rs` + `FileSurface`)**：右侧面板（296px）专职做「工作区变更分组列表（Modified / Untracked / Deleted）」与「可折叠项目文件目录树」导航器，不再在窄栏内挤压渲染代码；点击任意文件直接在左侧宽敞的主画布副页签打开宽幅 `FileSurface`，顶部配备 **`[Unified Diff | 并排对比 | 完整源码]`** 三态分段切换器。
5. **Git 提交图谱 (`git_graph.rs`)**：顶部 40px 精简过滤栏（分支下拉 + `↑2 ↓0` 同步胶囊 + 远程开关 + 常驻搜索框）；行内展开 CDV 详情时 **左侧保留拓扑走廊使彩色分支竖线全程贯穿不断裂（并引出拐角虚线指向右侧详情舱）**，右侧内嵌圆角详情舱采用 **42% : 58% 黄金分割双栏**（左栏 74px 标签对齐 + 可跳转 Parents 胶囊，右栏变更文件树 +点击在主画布打开宽幅 Diff）。
6. **设置中心 (`settings.rs` / `SettingsWindow`)**：采用 **多窗口独立桌面窗口（Multi-Window）** 架构——点击侧栏设置按钮或按 `⌘,` 弹出带独立原生标题栏与搜索框的设置窗口，不打断主窗口会话；设置窗口右侧内容区 **横向与纵向 100% 填满**（移除 `max-width` 留白限制，`Presets` 与 `ACP Agents` 采用左列表+右详情编辑器的 Master-Detail 全高双栏，`Keybindings` 采用双列网格，`Terminal`/`Appearance`/`Notifications`/`Advanced` 下半区配备实时预览与诊断面板）。
7. **新建会话 & 搜索面板 (`new_session.rs` / `search_threads.rs`)**：统一采用 **Raycast / Linear 风格无框 Spotlight 命令面板**（顶部 46px 放大镜搜索输入 + 工作区胶囊切换条 + 2 列预设网格 / 实时高亮列表 + 底部快捷键提示栏）。
8. **添加工作区 & 通知中心浮层 (`workspace_dialog.rs` / `notif_center.rs`)**：添加工作区弹窗采用「路径输入框 + 右侧『浏览…』联体按钮 + 名称自动推导预览」结构化表单；通知中心浮层锚定于侧栏左下角，支持未读计数徽标与点击一键跳转对应会话。

### 双滚动区域与嵌套滚动规范 (`nested_scroll.rs`)

全应用统一采用 **「保留嵌套滚动 + 统一滚轮边缘穿透 (Edge Handoff) / 分栏滚轮隔离 (Scroll Containment) + 极简悬浮滚动条」** 架构：

1. **内层优先 + 边缘穿透 (`nested_scrollable` / `nested_max_h_scrollable` / `.nested-scroll`)**：
   - 覆盖场景：① 启动台 Bento 会话列表（`#bento-sessions-list` 204px 内嵌于 `#bento-launchpad`）；② Git 图谱行内展开 CDV 左右双栏（左栏 `#git-cdv-body` 多行提交说明 + 右栏 `#git-cdv-files` 变更文件树内嵌于 `#git-list`）；③ 设置中心高级页 `#settings-json-view`（280px 内嵌于 `#settings-content`）。
   - 交互契约：当内层容器在滚轮方向上仍有可移动余量时，消费滚轮并阻止冒泡（包含触达边界的最后一步，通过 `clamp_and_recover_before_offset` 还原 GPUI Bubble 阶段预加前的真实偏移）；当内层已触顶/触底或内容未溢出时，放行事件由外层主滚动容器无缝接管。
2. **独立分栏滚轮隔离 (`isolated_scrollable` / `isolated_panel_scrollable` / `.isolated-scroll`)**：
   - 覆盖场景：右侧 `WorkPanel`（`#work-panel-scroll`）、设置窗口左导航轨（`#settings-nav-list`）与右内容区（`#settings-content`）、主画布 `FileSurface`（`#main-file-surface`）。
   - 交互契约：始终钳制偏移量并 `stop_propagation()`，切换页签/分区/文件时自动重置 `ScrollHandle` 回顶；在并排对比（`FileSurfaceMode::Split`）下采用固定吸顶双栏对比表头（`#split-diff-header`）+ 下方单轴同步滚动双栏代码区。
3. **极简滚动指示 (`with_minimal_scroll_indicators`)**：
   - 仅当内容实际溢出（`max_offset > 1.5px`）时按需渲染右缘 `3px` 半透明胶囊滑块与上下边缘溢出渐隐遮罩；Web 原型中 `.nested-scroll` 默认隐藏滑块、仅在 `:hover` 时浮现 `4px` 细微胶囊，彻底消除双粗滚动条并立的视觉干扰。

## Elevation & Depth

普通界面靠底色区分层级。窗口、对话框与临时提示才使用柔和、有偏移的阴影；没有发光描边和装饰性渐变。对话框使用浏览器 top layer，避免被滚动容器裁切。

## Shapes

紧凑圆角控件与细线 SVG 图标。图标统一为 24-unit viewBox、1.65 描边，在界面中以 12–18px 显示；可交互图标外有独立命中区域。

## Components

- **按钮**：主要按钮用于空工作区的启动动作；侧栏新建按钮采用中性背景。所有控件有 hover 和可见焦点，按压不改变布局。
- **工作区与会话行**：当前状态用 `aria-current`，展开用 `aria-expanded`。会话管理入口在选中、hover、focus-within 时可见，窄屏常显。
- **表单**：可见 label、独立提示、字段级错误与焦点定位；错误不是只在通知条里提示。
- **浮层**：原生 `<dialog>` 承担工具选择、短表单和窄屏工作区导航；Esc 可退出。工具列表支持过滤与方向键选择。
- **反馈**：普通颜色过渡 140ms ease-out；对话框淡入 / 小幅位移 160ms。reduced-motion 下全部取消。
- **终端示意**：工具各自的内容与输入区保持在工具表面内部；模拟内容始终有明确标记。

## Do's and Don'ts

- **Do** 保持目录、工作区、会话三者归属明确，使用用户可理解的项目和工具名称。
- **Do** 提供键盘等价操作，并尊重中文输入法组合阶段和终端控制键。
- **Do** 在狭窄预览中改变导航结构，而不是把桌面窗口整体缩小。
- **Don't** 将原型中的 HTML 文字布局当作正式终端仿真方案。
- **Don't** 从静态 TUI 输出推断真实任务状态，或把示例数据呈现为真实执行结果。
- **Don't** 让工作区局部原型的尺寸与 token 自动覆盖正式应用的已拍板设计。
