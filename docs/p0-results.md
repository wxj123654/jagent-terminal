# P0 结果

> 计划见 `docs/p0-spike.md`，背景见 `docs/gpui-rewrite.md`。本文随实验推进回填；当前只完成步骤 0。

## 0. 联网核实（2026-10-10）

来源：crates.io API（`https://crates.io/api/v1/crates/...`），由用户在本机终端执行，
`curl -A "jagent-research (wxj)"`。crates.io 要求带 `User-Agent`，否则返回空体。

### 0.1 版本矩阵

| crate | 版本 | 发布日期 | license | rust_version | 仓库 |
|---|---|---|---|---|---|
| `gpui-pre` | 0.3.8（共 9 个版本，首版 2026-09-03） | 2026-10-05 | Apache-2.0 | 未声明 | — |
| `gpui-pre-platform` | 0.3.8 | 2026-10-05 | — | — | zed-industries/zed |
| `gpui-component` | 0.7.1 | 2026-10-05 | Apache-2.0 | 未声明 | — |
| `gpui-base` | 0.7.1 | 2026-10-05 | Apache-2.0 | 未声明 | — |
| `gpui-kit` | 0.7.1 | 2026-10-05 | — | — | longbridge/gpui-kit |
| `gpui`（官方） | 0.2.2 | **2025-10-22** | — | — | zed-industries/zed |
| `agent-client-protocol` | 3.3.0 | 2026-10-09 | — | — | agentclientprotocol/rust-sdk |

补充事实：

- `gpui-pre` 描述为 "snapshot of zed@279fe07"；下载量 119,421；owner 仅 `huacnlee`（Jason Lee）一人。
- `gpui-pre` 全部 9 个版本发布于首版之后的约 5 周内，节奏快。

### 0.2 依赖关系（回答 Q-A）

`gpui-component 0.7.1` 的 gpui 系列依赖（均为精确锁定）：

| 依赖 | 要求 | 类别 |
|---|---|---|
| `gpui-pre` | `=0.3.8` | normal（另有一条 dev） |
| `gpui-pre-macros` | `=0.3.8` | normal |
| `gpui-pre-sum-tree` | `=0.3.8` | normal |
| `gpui-base` | `^0.7.1` | normal |
| `gpui-component-macros` | `^0.7.1` | normal |
| `gpui-kit-assets` | `^0.7.1` | normal |

`gpui-base 0.7.1`：normal 依赖 `gpui-pre`、`gpui-pre-macros`、`gpui-pre-sum-tree`（均 `=0.3.8`）；
`gpui-pre-platform`、`gpui-pre-reqwest-client` 仅为 **dev** 依赖。

**Q-A 结论：gpui-component 在 crates.io 上依赖 `gpui-pre =0.3.8`，不是 zed git。**
Context7 文档里 `gpui = { git = zed }` 的示例已过时。方案 A 的前提成立。

### 0.3 由此得出的推论

1. **应用需自行依赖 `gpui-pre-platform =0.3.8`。** gpui-component 与 gpui-base 都只把它当 dev 依赖，
   启动窗口所需的平台层要由应用 crate 声明（推断，E1 编译验证）。
2. **官方 `gpui` 已一年未更新（2025-10-22），不能作为选项。** 与 §0.1 一致，也印证此前"crates.io 官方版本是旧快照"的判断。
3. **`gpui-pre` 的供应链是单点**：一个账号控制全部 gpui 系列快照。风险已写入 `gpui-rewrite.md` §9。
4. **gpui 的两份拷贝不可共存**：`gpui-pre` 与现有 remorses/zed fork 同库名不同包，类型不兼容。
   终端 crate 必须迁到 `gpui-pre`（E2）。
5. **所有 gpui 系列版本均 `=` 精确锁定**，升级只能整体进行，AGENTS.md 规则 5 已按此写成例外。
6. **Q1 的候选依赖存在**：`agent-client-protocol 3.3.0`（2026-10-09）。是否与 gpui 解耦、API 是否覆盖
   现有 TS 客户端（`threads/acp.ts`）未核实。

### 0.4 仍未核实

| 项 | 计划 |
|---|---|
| MSRV | crate 元数据均为空。以 `gpui-component` 文档所称 1.90+ 为下限，实际在 E1 编译时确定，再据此 pin `rust-toolchain.toml`（现为浮动 `stable`） |
| `zed@279fe07` 的提交日期与内容 | 需 GitHub；对 E2 的 API 差异评估有帮助，非阻塞 |
| gpui-component 仓库 `Cargo.toml` 的 `[patch]` 原文 | `raw.githubusercontent.com` 在用户网络下无输出，非阻塞（crates.io 依赖已足以回答 Q-A） |
| `agent-client-protocol` 对 gpui 的耦合与 API 覆盖 | Q1 决定为"做 ACP"之后再查 |
| 搜索摘要中的 issue 编号、star 数 | 不影响决策，E3–E5 以实测为准 |

## 1. 实验结果（E1–E9）

### E1 编译与开窗：通过

环境：macOS，rustc 1.97.1（现有浮动 `stable` 恰为此版本），代码在 `spikes/p0/`。

| 检查项 | 结果 | 证据 |
|---|---|---|
| 依赖解析 | 通过 | `Cargo.lock` 共 820 个包；gpui 系列全为 0.3.8（`gpui-pre*`），无 git 来源 |
| gpui 只有一份 | 通过 | `cargo tree -d` 无 gpui 重复项 |
| 编译 | 通过 | 首次失败仅因自写代码漏了 `use gpui::AppContext`（`cx.new` 来自该 trait），补上后通过；gpui-pre / gpui-component 本身零改动 |
| MSRV | 1.97.1 可用 | 未验证更低版本，下限仍以文档所称 1.90+ 为准 |
| 运行 | 间接通过 | 进程运行 8 秒后仍存活，日志为空，无 panic |
| 渲染与暗色主题 | 通过 | `spikes/p0/tests/shot.rs` 用 `VisualTestAppContext` 在屏幕外窗口（-10000,-10000）渲染并截图，见 E2 截图：Root 标题栏深色背景、白字，终端区深灰背景 |

要点：

- 应用 crate 声明 `gpui-pre-platform =0.3.8`，并用 `gpui_platform::application().run(...)` 启动，证实 §0.3 第 1 条推断。
- 启动写法与 gpui-component 官方文档一致：`gpui_component::init(cx)` 必须第一个调用，窗口首层视图必须是 `Root`。
- 构建开销：`target/` 约 3.2 GB，首次下载加编译耗时数分钟。`.gitignore` 已加 `/spikes/*/target/`。
- 其余编译告警：依赖 `block v0.1.6` 含将被未来 Rust 拒绝的代码（future-incompat）。属 gpui 的传递依赖，记为风险，P1 跟踪。

### E2 终端 crate 兼容：通过（渲染与 PTY 往返已验证；输入、IME、选区未验证）

做法：把 `crates/jagent-terminal` 复制到 `spikes/p0/term/`，**源码一行不改**，只把 `Cargo.toml` 里的 gpui
由 remorses/zed fork 的 path 依赖换成 `gpui-pre =0.3.8`，并去掉 `gpui_platform`（库本身不用，仅示例用）。

| 检查项 | 结果 | 证据 |
|---|---|---|
| 源码是否需要改动 | **否** | `diff -rq term/src crates/jagent-terminal/src` 无差异 |
| `cargo check -p jagent-terminal` | 通过，0 error | 依赖树只有 `gpui-pre v0.3.8`，同时带 `alacritty_terminal 0.26.0`、`thiserror 2.0.21` |
| gpui API 差异清单 | **空** | 原计划记录 `FocusHandle` / `InputHandler` / `UTF16Selection` / `canvas` / `PathBuilder` 等差异，实测均无 |

运行验证（`cargo test --test shot`，macOS，截图 1800x1000 即 900x500 @2x）：

| 检查项 | 结果 | 证据 |
|---|---|---|
| PTY 往返 | 通过 | 用 `init_command` 执行 `echo P0-E2-OK; printf '\033[31mred\033[32m green\033[0m\n'`，直接读 alacritty 网格得到 `P0-E2-OK` 与 `red green` |
| 文本渲染 | 通过 | 截图中可见 shell 提示符、命令回显、输出行 |
| ANSI 颜色 | 通过 | `red` 为红、`green` 为绿，其余为默认灰 |
| 光标 | 通过 | 提示符后有蓝色块光标 |
| 与 gpui-component 共存 | 通过 | 终端 `Entity<TerminalView>` 作为 `Root` 下 `div().flex_1()` 的子元素，布局正常 |

截图与终端网格文本一致，排除了"网格有内容但没画出来"的情况。

**测试方法的两个坑**（P1 搭测试设施时必须带上）：

1. `render_to_image` 只栅格化*最近一次已渲染的帧*，不会自己重绘。PTY 输出到达后必须
   `cx.update(|app| app.refresh_windows())` 再 `run_until_parked()`，否则截图是旧帧（第一次截图只有光标就是这个原因）。
2. macOS 的 AppKit 要求主线程，所以视觉测试必须 `[[test]] harness = false` 并自写 `main`；
   同时 `gpui` 与 `gpui-pre-platform` 要开 `test-support` 与 `font-kit` 特性。

解读：

- 现有 fork（zed `81c99f81`，2026-09-08）与 `gpui-pre`（zed@279fe07，2026-10 初）的 API 在该 crate 用到的表面上完全兼容。
  此前担心的"终端 crate 迁移量不明"被消除：**迁到方案 A 的成本在编译层为零**。
- 已验证的是**编译 + 渲染 + PTY 输出**。键盘输入、IME 组合、选区、滚动条、光标闪烁、box drawing、
  resize 重排尚未验证；窗口真实交互需用户在真机上手测。
- 原 crate 的 `examples/window.rs` 未纳入（它依赖 `gpui_platform::application()`，在 spike 里由
  `main.rs` 取代）。

### E3 对话流：通过（gpui 自带 `list`，不依赖 gpui-component 的 VirtualList）

做法：`ListState::new(n, ListAlignment::Top, px(600))` + `set_follow_mode(FollowMode::Tail)`，
1 万条变高消息（1–9 行不等），`splice` 追加与"最后一条持续变长"模拟流式，`Window::draw` 真实绘制。
代码：`spikes/p0/tests/e3_chat.rs`。

| 检查项 | 结果 | 数据 |
|---|---|---|
| 1 万条初始布局 | 通过 | 77–81 ms（debug 构建，只测可见项） |
| 流式跟随到底 | 通过 | 200 步追加 / 变长后 `following_tail=true`，视口锚点距末尾 2 条 |
| 稳态绘制耗时 | 通过 | p50 1.47 ms / p95 1.58 ms / max 1.78 ms（debug 构建、屏幕外窗口，含 layout+prepaint+paint，不含 GPU 呈现） |
| 用户上滚后停止跟随 | 通过 | 滚轮上滚后 `following_tail=false` |
| 停止跟随后追加不拽回 | 通过 | 20 次追加前后 scroll-top 条目均为 10001 |
| `scroll_to_end` | 通过 | 调用后 `following_tail=true`，锚点距末尾 1 条，之后继续流式仍跟随 |

**与此前风险判断的关系**：搜索摘要称 gpui-component 的 `VirtualList.scroll_to_bottom` 有 bug。
本实验**绕开了它**，直接用 gpui 的 `list`，follow-tail 语义（`FollowMode::Tail`、用户上滚暂停、回到底部恢复）
是 gpui 自带的，不需要自己实现。对话流应采用此方案，不依赖 gpui-component 的虚拟列表。

注意事项：

1. `ListState::is_scrolled_to_end()` 在存在未测量条目时恒为 `None`（默认只测可见项，1 万条几乎都未测），
   不能作为"是否在底部"的判据；本测试改用 `logical_scroll_top().item_ix` 距 `item_count()` 的差值。
   业务代码若需要"回到底部"按钮，要用同样的方法，或对 `measure_all()` / `with_uniform_item_height()` 做取舍。
2. 帧耗时是 debug 构建、屏幕外窗口的数字，不含 GPU 呈现，只能说明 CPU 侧布局绘制没有数量级问题；
   release + 真实窗口的 16 ms 判定留到 P4。
3. 测试驱动方式：`render_to_image` / 滚轮事件之前必须调用 `Window::draw`；`refresh_windows` +
   `run_until_parked` 在屏幕外窗口不会重绘（第一版因此得到 0.00 ms 的假数据）。

### E4 输入框与 IME：逻辑层通过；真机输入法、候选窗、自增高像素高度未验证

做法：`gpui_base::input::Textarea` + `TextareaState`（`submit_on_enter(true)` + `set_auto_grow(1, 6)`），
通过 `EntityInputHandler`（`replace_and_mark_text_in_range` / `replace_text_in_range`，即 macOS / Windows / Linux
输入法最终落到的同一入口）模拟拼音输入。代码：`spikes/p0/tests/e4_input.rs`。
`Textarea` 是 gpui-base 的**无样式**多行输入（文档原话 "unstyled"），边框、内边距、聚焦环需自己加。

| 检查项 | 结果 | 证据 |
|---|---|---|
| Enter 提交、Shift+Enter 换行 | 通过（action 路径） | 派发 `Enter{shift:false}`：值不变、发出 1 次 `PressEnter`；`Enter{shift:true}`：插入 `\n` |
| 多行累积 | 通过 | 8 个逻辑行 |
| 拼音预编辑原位替换 | 通过 | `n`→`ni`→`nih`→`niha`→`nihao`，每步 `value` 恰为当前预编辑串，**不累加**（Windows 字符重复类 bug 的特征不出现）；标记范围 `Some(0..5)` |
| 上屏 | 通过 | `replace_text_in_range(None,"你好")` 后 `value="你好"`，标记范围清除 |
| 连续第二段 | 通过 | 预编辑 `shijie` 接在 `你好` 之后（`你好shijie`），上屏后 `你好世界`，不污染前文 |
| 取消预编辑 | 通过 | 空串 + `unmark_text` 后仍为 `你好世界`，无残留拼音 |
| 渲染 | 通过 | 截图中 `你好世界` 正确渲染（中文字形、位置在底部输入区） |

**一个需要真机确认的风险（不是已确认的缺陷）**

用 `simulate_keystrokes("enter")` 时 `value` 变成 `"hello\n"`：gpui 测试驱动器会给 `enter` 附带
`key_char="\n"`（`Keystroke::with_simulated_ime`），而组件在提交分支调用 `cx.propagate()`，按键事件继续传播，
于是 `\n` 又被当作文本输入。直接派发 `Enter` action 则行为正确。因此：

- 在**测试里**，必须用 `dispatch_action(Enter{..})`，不能用 `simulate_keystrokes("enter")` 来测 composer。
- 在**真实窗口**里是否也会多插一个换行，取决于各平台是否在 Enter 之后再把 `\n` 当字符输入派发。
  macOS 的 Enter 走 `insertNewline:` 命令而非字符输入，推测不会；Windows / Linux 未知。
  **P4 开始前必须在三平台真窗口各手测一次"Enter 提交后输入框是否多出换行"。**
  若会，业务层在 `PressEnter` 里清空输入框即可规避（提交后本来就要清空），代价很小。

**未验证（只能真机）**：输入法候选窗定位；预编辑下划线样式；Windows 字符重复（zed#56327）与
Linux X11 Fcitx（zed#60578）的真实输入法行为——本实验驱动的是组件的 IME 处理逻辑，不经过真实输入法；
自增高的像素高度（本测试只断言了逻辑行数，没有读布局高度）。

### E5 markdown：渲染与选区通过；样式对齐与代码高亮未做

做法：`gpui_base::text::{TextView, TextViewState, TextViewStyle}`，样例含标题（h1/h2）、段落、粗体/斜体、行内代码、
链接、嵌套列表、引用、围栏代码块、表格。代码：`spikes/p0/tests/e5_markdown.rs`，截图 `target/shots/e5.png`。

| 检查项 | 结果 | 证据 |
|---|---|---|
| 各元素渲染 | 通过 | 截图：标题层级、行内代码底色、链接下划线、嵌套列表缩进、引用竖线、代码块底色与等宽字、表格边框与表头均正常；中文换行与行高正常 |
| 选区与复制 | 通过 | `select_all` 后 `selected_text()` 得到 396 字符，含正文、代码块（`ListState`）、表格单元格（`供应链单点`）的文字；截图中选区高亮覆盖所有块，包括表格与代码块内部 |
| 默认 `selectable` | 默认开启 | `TextView::markdown(..)` 的 `selectable` 默认 true；这直接缓解了此前最担心的"gpui 无通用文本选区"（仅限 markdown 渲染的内容） |
| 与 gpui-component 主题联动 | 通过 | `TextViewStyle::from_theme(&gpui_base::Theme::global(cx))`；`Theme::change` 会同步 base 主题（`sync_base`），无需手动同步 |

**两个类型坑**（P3/P4 写业务视图时会反复遇到）：

1. **有两个 `Theme`**：`gpui_component::Theme`（含 `ThemeMode`、颜色表）与 `gpui_base::Theme`（语义 token）。
   `TextViewStyle::from_theme` 要的是后者，`cx.theme()` 返回前者，直接传会类型不匹配。
   用 `gpui_base::Theme::global(cx)`。
2. **`TextView` / `Textarea` 等原语在 `gpui-base`，不是 `gpui-component`**：应用需要直接依赖 `gpui-base =0.7.1`
   （它已是 gpui-component 的传递依赖，不增加下载），并与 gpui-component **同版本锁定**。

**未做（不能算通过）**

| 项 | 状态 |
|---|---|
| 对齐旧实现排版（正文 14px/1.65、代码块 #15181d 圆角 8、内边距 13/14、段落间距 8、行内代码底 inputBg） | **只试了代码块底色与段落间距**，其余未对齐。`TextViewStyle` 暴露的是 `with_foreground/link/selection/code_background/border/paragraph_gap/heading/code_block/inline_code/table*`，**没有行高与字号的直接开关**，需要用 `heading` 闭包与 `code_block: StyleRefinement` 间接设置，或外层 `div` 设 `text_size`/`line_height`。这是 P4 的调样式工作，量未知 |
| 代码块语法高亮 | **未启用**。需要 `gpui-component` 的 `tree-sitter-*` 特性（每种语言一个特性），会增加编译时间与二进制体积；代码块目前是等宽纯文本 |
| 流式 markdown（逐 token 追加时的增量重解析） | **未测**。此前摘要称"每次改动整篇重新解析"，在长回复流式输出时可能是性能点，须在 P4 用真实长文本测 |
| 链接点击、图片、HTML | 未测 |
| 在 `list` 条目里嵌入 `TextView` 的高度测量与 follow-tail 配合 | 未测（E3 的条目是纯文本 `div`） |

### E7 Git 图规模：通过

做法：1 万行，每行 4 个文本列（hash / message / author / date，截断省略），**普通 gpui 元素树，不做 canvas 自绘**。
变体 A：`uniform_list` 定高 26px；变体 B：`list` + `ListState` 变高，选中行与其下方 218px 详情卡片合并为同一个条目，
选中后用 `splice(ix..ix+1, 1)` 通知高度变化。代码：`spikes/p0/tests/e7_graph.rs`。

| 检查项 | 结果 | 数据（debug 构建、屏幕外窗口、`Window::draw`，不含 GPU 呈现） |
|---|---|---|
| A uniform_list 1 万行 | 通过 | 首帧 6.2 ms；idle p50 6.07 / p90 6.39；滚动 p50 5.94 / p90 6.14 / max 7.11；滚动 120 步后偏移 -10800px |
| B list 1 万行（变高） | 通过 | 首帧 7.3 ms；idle p50 6.61 / p90 6.82；滚动 p50 6.52 / p90 6.72 |
| 选中行下方插入变高卡片 | 通过 | 选中后重绘 4.1 ms；带卡片滚动 p50 6.53 / p90 6.74；截图确认卡片出现在 #418 下方并把后续行下推 |

**release 复测**（`cargo test --release --test e7_graph`，同一台 macOS 机器，同口径：屏幕外窗口、`Window::draw`、不含 GPU 呈现）：

| 变体 | 首帧 | idle p50 / p90 | 滚动 p50 / p90 / max |
|---|---|---|---|
| A uniform_list 1 万行 | 0.55 ms | 0.53 / 0.55 | 0.53 / 0.55 / 0.61 |
| B list 变高 1 万行 | 0.69 ms | 0.56 / 0.58 | 0.57 / 0.60 / 0.73 |
| B 选中后（带 218px 卡片） | 选中重绘 0.38 ms | — | 0.57 / 0.60 |

release 比 debug 快约 11 倍。普通元素树渲染约 30 行可见的 4 列表格，**CPU 侧每帧不到 1 ms**，
滚动与 idle 几乎相同，带卡片也无额外开销。

关键结论：

1. **不再需要为性能把整行改成 canvas 自绘。** 旧实现的瓶颈（`docs/perf-analysis.md` §9.3）是 GPUIX 每帧重建元素树，
   导致 text 节点每帧重跑 taffy 测量。gpui 是保留模式，普通 `div` 行的滚动耗时与 idle 几乎相同
   （A：5.94 vs 6.07 ms），说明开销是固定的每帧布局成本，不随滚动增长。`native/src/elements/git_graph.rs`
   的 canvas 自绘路径可以不迁移，按普通元素重写；仅把它的几何常量和列宽规格（`rowColumns.ts`）带过来。
2. **变高卡片不再需要"卡片行"补丁。** 旧实现用定高虚拟列表，只能把卡片做成单独插入的一行；
   gpui 的 `list` 本身支持变高条目，选中行与卡片合为一个条目即可，卡片展开/收起只需 `splice` 一个条目。
3. **与旧基线的可比性（须克制地读）**：旧基线（滚动 p90 3.9–4.2 ms，idle 3.8–3.9 ms，`docs/perf-analysis.md` §9）来自 GPUIX
   的帧叠加层 HUD，**含 GPU 呈现与 JS 桥**，且是真实窗口；本实验的 0.5–0.7 ms 只是 CPU 侧
   layout+prepaint+paint，不含 GPU 提交，**两者不是同一口径，不能写成"快了 N 倍"**。能下的结论仅是：
   gpui 原生元素树渲染该规模的表格，CPU 侧远低于 16 ms 预算，没有需要靠 canvas 自绘规避的结构性瓶颈。
   真实窗口含 GPU 的数字留到 P5 在真窗口里用 gpui 的帧统计复测。
4. 视觉小问题（与性能无关）：第一版截图里 hash 列换行重叠，原因是未设 `whitespace_nowrap()`；
   加上后正常。这是写 gpui 视图时的常见坑，P5 要写进组件约定：**定宽单行列必须同时设
   `overflow_hidden` + `whitespace_nowrap` + `text_ellipsis`。**

### E6 布局外壳：Resizable 通过；标题栏平台行为未验证
### E8 嵌套滚动：上游是"同时滚动"；应用层 10 行封装即可修成"最内层优先 + 到边界交接"（X1 方案 b 已验证）

代码：`spikes/p0/tests/e6_shell.rs`（`TitleBar` + `h_resizable` 三栏 + 可滚主区内嵌可滚列表），截图 `target/shots/e6_e8.png`、`e6_narrow.png`。

**E6 结果**

| 检查项 | 结果 | 数据 |
|---|---|---|
| 三栏初始尺寸 | 通过 | 220 / 620 / 260，总宽 1100（左右栏按 `size()` 取值，主区吃剩余） |
| 程序化调整（等价拖拽后的状态） | 通过 | `resize_panel(0, 300)` → `[300, 540, 260]`，总宽守恒 |
| `size_range` 夹取 | 通过 | 请求左栏 500，被夹到 360（上限），其余让位 → `[360, 480, 260]` |
| 窄屏分支（<760px） | 通过 | 新开 700px 宽窗口，`viewport_size` 读到 700，走单栏分支，截图正常 |
| `Window::resize` 改变 viewport | **不生效** | 屏幕外测试窗口里 `resize(700x700)` 后 `viewport_size` 仍是 1100x700（测试设施的限制，不是产品问题）。窄屏测试必须新开窗口，不能靠 resize |
| TitleBar 渲染 | 通过 | 截图可见 34px 标题栏与标题文字；macOS 左侧给红绿灯留了 80px 内边距（源码 `TITLE_BAR_LEFT_PADDING`） |

**E6 未验证（只能真窗口手测）**：真实鼠标拖动分隔条的跟手程度；红绿灯位置与让位；双击标题栏缩放；拖动窗口；
Windows / Linux 的自绘窗口控制按钮。屏幕外测试窗口里这些平台行为都不存在。另外 `ResizableState`
的持久化（`on_resize` / `ResizablePanelEvent::Resized`）只确认 API 存在，没有写读写测试。

**E8 结果（嵌套滚动）**

方法：外层 `overflow_y_scroll` 主区内含一个 200px 高、内容 1440px 的内层可滚列表。指针位置在阶段开始时固定一次，
每步用内层的真实 bounds 检查"指针仍在内层且在窗口内"（上两版有缺陷：一次让指针随内层移动，导致外层一滚指针就移出窗口；
一次的"指针在内层"检查是自己比自己的恒真式——这两版的数据都作废）。

| 阶段 | 结果 |
|---|---|
| 阶段 1：内层远离边界，指针在内层上滚 15 步（每步 -10px） | **15/15 步外层与内层同时移动**（`both_moved=15`，`only_inner=0`）：每步 d_outer=-10、d_inner=-10 |
| 阶段 2：内层已到底，指针仍在内层上继续滚 4 步 | **4/4 步外层继续移动**，内层不动（d_inner=0） |

原因（读 `gpui-pre-0.3.8/src/elements/div.rs` 的滚轮处理器）：每个可滚动 `div` 的处理器只要
`hitbox.should_handle_scroll(window)` 为真，就**无条件**累加自己的滚动偏移，没有 `stop_propagation`，
也不判断自己是否还能滚动。内层与外层的 hitbox 都包含指针位置，所以**同一个滚轮事件让两层同时滚动**。

后果（对应产品里的嵌套场景：侧栏列表、Git 详情文件树、会话视图内的代码块/表格）：

- 在内层滚动时，外层页面**一起滚走**，内层随之被带出可视区——这是此前 gpuix-zed `0003` 补丁要解决的问题
  （补丁：滚动序列锁定到某一个容器，序列内只有它可动）。
- 内层到底后继续滚，外层会接着滚（"边界交接"）。浏览器默认也是这样（scroll chaining）；
  `0003` 补丁刻意**不交接**。两种行为都有道理，需要产品选择。

**X1 决策**（`gpui-rewrite.md` 中的默认"先接受上游"不成立，因为"同时滚动"比"边界交接"更糟）：

| 方案 | 做法 | 代价 |
|---|---|---|
| a | 避免嵌套滚动：设计上让每个区域只有一个可滚容器（列表用 `list`/`uniform_list` 自带滚动，面板内容不再套滚动 div） | 无补丁、无依赖；约束 UI 设计，代码块/表格要"限高不滚动"或"点击展开" |
| b | 在应用层自建"滚动序列锁定"：给可滚容器包一层，用 `on_scroll_wheel` + `cx.stop_propagation()` 实现"最内层能滚就吃掉事件" | 纯应用代码，约百行；需要每个嵌套点显式使用封装 |
| c | 把 `0003` 补丁移植到 `gpui-pre` | `gpui-pre` 是 crates.io 精确锁定的包，打补丁就要 `[patch.crates-io]` 指向本地副本，破坏"精确锁定快照"的治理（`gpui-rewrite.md` §6），**不推荐** |

**方案 b 已验证（同一测试，内层加 `on_scroll_wheel`）**

内层容器的滚轮处理器里，**内层还能朝该方向滚动时调用 `cx.stop_propagation()`**，否则放行：

```rust
.on_scroll_wheel({
    let h = inner_scroll_handle.clone();
    move |ev, window, cx| {
        let dy = f32::from(ev.delta.pixel_delta(window.line_height()).y);
        let off = f32::from(h.offset().y);
        let max = f32::from(h.max_offset().y);
        // offset 向下滚为负：可向下 = off > -max；可向上 = off < 0
        if (dy < 0.0 && off > -max) || (dy > 0.0 && off < 0.0) {
            cx.stop_propagation();
        }
    }
})
```

| 阶段 | 无封装（上游） | 有封装 |
|---|---|---|
| 1：内层中部滚 15 步 | 15/15 步外层与内层同时动 | **0/15 步外层动，15/15 步仅内层动** |
| 2：内层到底后继续滚 4 步 | 4/4 步外层继续动 | 4/4 步外层继续动（边界交接，浏览器默认语义） |

即：`stop_propagation` 在滚轮冒泡阶段**能**阻止外层处理器。

**X1 结论**：选方案 **b**，作为 `jagent-app` 里的一个小封装（例如 `nested_scroll(inner_handle)`），
所有"可滚动面板内再套可滚动区域"的地方统一使用；方案 a（尽量少嵌套）作为设计原则保留。
**不需要 `gpuix-zed/0003` 补丁，也不动 `gpui-pre`**，与"精确锁定快照"的治理一致。

**与旧补丁行为的差异（需产品确认）**：旧 `0003` 是"序列锁定、到边界**不交接**"（500ms 空闲或位移 ≥10px 才开新序列）。
方案 b 是"最内层优先、到边界**交接**"。后者是浏览器默认行为，实现简单，但用户在内层滚到底后继续滚，
外层会突然开始滚动。若要保留旧"不交接"语义，需要在封装里加序列判定（`ScrollWheelEvent.touch_phase` + 空闲计时），
约再多几十行，但这是**精确复刻旧体验**，建议先用简单版，P3 手测后再决定是否需要。

**本实验仍未覆盖**：触控板惯性滚动（`TouchPhase::Moved` 之后的惯性事件）；三层及以上嵌套；
内层是 `list` / `uniform_list`（它们自带滚动处理，不是 `div` 的 `overflow_y_scroll`）时同样的封装是否有效——
Git 图与对话流恰好是这种情况，**P3 必须补测**。

### E9 测试能力：部分通过

| 能力 | 结果 |
|---|---|
| 屏幕外窗口 + 截图（macOS） | 通过，见上。窗口开在 (-10000,-10000)，不出现在桌面，也不截取桌面 |
| 读取 UI 之外的内部状态断言 | 通过：从 `TerminalPool` 读 alacritty 网格文本 |
| 模拟按键 / 文本输入 / 滚轮 / action | 通过：`simulate_keystrokes`、`simulate_input`、`simulate_event(ScrollWheelEvent)`、`dispatch_action` 均在 E3/E4/E6 中使用并产生预期状态变化 |
| 读取元素 bounds | 通过：`ScrollHandle::bounds()` / `offset()` / `max_offset()`（E6/E8）；`debug_bounds(selector)` 仅在 `TestAppContext`，未使用 |
| 真实绘制驱动 | 通过：`Window::draw(app).clear(app)`；**`refresh_windows` + `run_until_parked` 在屏幕外窗口不重绘**，截图和耗时读数都必须先 `draw` |
| 主线程约束 | macOS AppKit 要求主线程：视觉测试必须 `[[test]] harness = false` 自写 `main`；断言用 `assert!`/panic，退出码非 0 表示失败 |
| 测试驱动器的假象 | `simulate_keystrokes("enter")` 会附带 `key_char="\n"`（`with_simulated_ime`），传播到文本输入后多出换行；测 Enter 语义必须用 `dispatch_action`（E4） |
| `Window::resize` | 屏幕外窗口里不改变 `viewport_size`；测试窄屏要新开窗口（E6） |
| Windows / Linux 无头截图 | **未验证**；`gpui-pre` 的 `render_to_image` 在无 `HeadlessRenderer` 时会 bail |
| 沙箱内运行 | 视觉测试在 Bash 沙箱里 SIGTRAP（`com.apple.hiservices-xpcservice` 连接无效，AppKit 需要系统服务），必须在用户终端运行 |

## 2. P0 总结

### 2.1 决策矩阵对照（`docs/p0-spike.md`）

| 预设条件 | 实测 | 结论 |
|---|---|---|
| E1、E2 通过，E3–E9 无阻断项 → 进入 P1，方案 A 成立 | E1、E2 通过；E3、E5、E7 通过；E4、E6、E9 逻辑层通过；E8 找到可行方案 | **方案 A 成立，可以进入 P1** |
| E2 需大量改动终端 crate | 0 行改动 | 不触发 |
| E3 或 E7 不达标 → 自建 `list` 绕开 gpui-component | E3、E7 都直接用 gpui 自带 `list` / `uniform_list` 达标 | 不触发；对话流与 Git 图**不依赖 gpui-component 的 VirtualList** |
| E4（IME）在目标平台严重失败 → 阻断 P4 | 逻辑层通过；**真机输入法三平台未测** | **P4 开始前的硬性前置检查**，不阻断 P1–P3 |
| 步骤 0 发现 gpui-component 依赖 zed git → 转方案 B | 实际依赖 `gpui-pre =0.3.8` | 不触发 |

### 2.2 已确认的好消息

1. 终端 crate **零改动**迁到 `gpui-pre`，PTY 往返 + ANSI 颜色 + 光标渲染正常（E2）。
2. 对话流直接用 gpui `list`，`FollowMode::Tail` 自带"用户上滚暂停、回到底部恢复"，不用自己实现 follow-tail（E3）。
3. Git 图用**普通元素树**即可，1 万行 CPU 侧每帧 <1ms（release），不需要 canvas 自绘，变高卡片用 `list` 条目合并即可，不再需要"卡片行"补丁（E7）。
4. markdown 的渲染与跨块选区复制开箱可用（E5），缓解了此前"gpui 无通用文本选区"的最大担忧（仅限 markdown 渲染内容）。
5. 嵌套滚动：应用层约 10 行封装即可修好，**不需要打补丁**（E8），与"精确锁定快照"的治理一致。
6. 多行输入框内建 `submit_on_enter`、自增高、IME 预编辑/上屏/取消逻辑（E4）。

### 2.3 必须在后续阶段兑现的未验证项（按阻断程度排序）

| # | 未验证 | 为什么重要 | 何时必须做 |
|---|---|---|---|
| 1 | **三平台真机中文输入法**：候选窗定位、预编辑下划线、Windows 字符重复（zed#56327）、Linux X11 Fcitx（zed#60578）、**Enter 提交后是否多出换行** | 这是此前评估里最大的外部风险，且只能真机测 | **P4 开始前**（阻断 P4） |
| 2 | 窗口真实交互：标题栏拖动/双击缩放/红绿灯让位、分隔条真实拖动跟手、Windows/Linux 自绘窗口按钮 | 屏幕外测试窗口里这些都不存在 | P1（标题栏）、P3（分隔条） |
| 3 | 嵌套滚动封装对 `list` / `uniform_list` 内层是否有效；触控板惯性；是否复刻旧"到边界不交接" | Git 图与对话流恰是这种情况 | P3 |
| 4 | 真实窗口（含 GPU 呈现）下的帧耗时；E7 的 0.5 ms 不含 GPU | 判断是否有掉帧 | P5 |
| 5 | 流式 markdown 的增量重解析成本；`TextView` 嵌在变高 `list` 条目里的测量与 follow-tail | 长回复流式输出是核心场景 | P4 |
| 6 | markdown 排版对齐（字号/行高无直接开关）；代码高亮的特性与体积取舍 | 视觉保真与编译时间 | P4 |
| 7 | Windows / Linux：编译、无头截图、`gpui-pre` 平台层 | 目前只在 macOS 上验证 | P1（编译）、P7（CI） |
| 8 | `future-incompat` 告警：传递依赖 `block v0.1.6` 含将被未来 Rust 拒绝的代码 | 升级 Rust 工具链时可能编译失败 | P1 记录，随 `gpui-pre` 升级跟踪 |
| 9 | MSRV 未声明；本机 1.97.1 可编译，更低版本未验证 | 要 pin `rust-toolchain.toml` | P1 |

### 2.4 对 `docs/gpui-rewrite.md` 的修订

- **X1 已定**：方案 b（应用层封装），见 E8。
- **工程结构**：应用需直接依赖 `gpui-base =0.7.1`（`TextView` / `Textarea` 等原语在其中，且与 gpui-component 同版本锁定）；
  `Resizable` 从 `gpui-component` 取（`gpui-base` 的 `resizable` 模块私有）。
- **控件取舍**：对话流、Git 图用 gpui 自带 `list` / `uniform_list`，**不使用** gpui-component 的 VirtualList；
  输入用 `Textarea`（无样式，需自加边框/聚焦环）；markdown 用 `TextView`。
- **组件约定（P3 起写入编码规范）**：定宽单行列必须同时 `overflow_hidden` + `whitespace_nowrap` + `text_ellipsis`；
  有两个 `Theme`（`gpui_component::Theme` 与 `gpui_base::Theme`）；测 Enter 用 `dispatch_action`。
- **测试设施**：视觉测试 `harness = false`；`Window::draw` 才会真实重绘；沙箱内无法运行，需用户终端或 CI。
  这些要在 P1 做成可复用的测试辅助（`spikes/p0/tests/` 的写法可直接提炼）。

### 2.5 重新基线的工作量

此前按"1:1 翻译 TSX"估算新写 Rust 19k–25k 行（不含终端栈与测试）。P0 之后可以确认**哪些会缩小**，
但不给新的总数——E3–E8 每项只验证了一条代表性路径，业务视图的实际行数仍取决于样式对齐与交互细节，
现在给数字只是换一种方式的猜测。能说的：

| 项 | 方向 | 依据 |
|---|---|---|
| 终端栈迁移 | 从"未知"变为 **0 行** | E2 |
| 对话流 follow-tail | 不用自写 | E3：`FollowMode::Tail` 自带 |
| Git 图 canvas 自绘（`git_graph.rs` 420 行）+ "卡片行"补丁 | 不迁移 | E7 |
| 文本选区（旧估约 1,400 行） | 对 markdown 内容不用自写 | E5；非 markdown 的普通文本仍需逐处判断 |
| 嵌套滚动补丁（627 行 diff） | 换成约 10–100 行应用封装 | E8 |
| `packages/ui` 控件层（2.5k TS） | 大部分由 gpui-component / gpui-base 取代，剩主题映射与薄包装 | E4、E5、E6 |
| markdown 排版调样式 | **未知，可能不小** | E5 未对齐 |
| 输入法真机兼容 | **未知** | E4 未测 |

### 2.6 P0 结论

**方案 A 成立，进入 P1。** P1 的第一件事是把本 spike 中证明可行的写法固化：新建 workspace 骨架、
把 `spikes/p0/term` 迁成正式 `crates/jagent-terminal`、提炼视觉测试辅助、pin 工具链。
`spikes/p0/` 在 P1 开始时删除（结论已在本文）。
