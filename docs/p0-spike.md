# P0 spike：验证方案 A（gpui-component + gpui-pre）

> 目的：用最小代价回答"方案 A 能不能承载 j-agent"。**不改动现有 workspace**，spike 放在独立目录，
> 结论写入 `docs/p0-results.md`，再决定进入 P1 还是转方案 B。
> 总体背景见 `docs/gpui-rewrite.md`。

## 0. 约束

- spike 代码放 `spikes/p0/`，自带 `[workspace]` 表，**不加入**根 `Cargo.toml` 的 members，避免污染现有构建。
  根 `Cargo.toml` 的 `exclude` 需包含 `spikes`（同 `.refs` 的处理方式）。
- 遵守 AGENTS.md：版本必须联网核实；不依赖记忆中的版本号。
- spike 通过后保留结论文档，`spikes/p0/` 在 P1 开始时删除或并入新骨架。

## 步骤 0：联网核实依赖（**已完成 2026-10-10**，结果见 `docs/p0-results.md` §0；Q-A 结论：依赖 `gpui-pre =0.3.8`）

以下保留作为复核清单；0.5 的 commit 内容与 MSRV 仍待 E1 / GitHub 补全。

本会话的沙箱拒绝了 crates.io、GitHub、docs.rs，需要在可联网环境执行（用户终端，或放开沙箱后）。
逐项记录**来源 URL 与查询时间**，回填 `docs/p0-results.md` §0：

| # | 要核实的事实 | 查询来源 |
|---|---|---|
| 0.1 | `gpui-pre` 最新版本、发布日期、owners、license | crates.io API / 页面 |
| 0.2 | `gpui-pre-platform`、`-macros`、`-sum-tree`、`-wgpu`（及 gpui-component 实际依赖的全部 gpui 系列）版本是否同号 | crates.io |
| 0.3 | gpui-component（gpui-kit）最新版本；其 `Cargo.toml` 的 `[workspace.dependencies]` 与 `[patch]` 原文 | GitHub raw |
| 0.4 | gpui-component 的 MSRV / `rust-toolchain.toml` | GitHub raw |
| 0.5 | `gpui-pre` 对应的 Zed commit（看 crate 内 `.cargo_vcs_info.json` 或发布脚本） | crates.io 下载包 / 仓库 |
| 0.6 | 官方 `gpui` crates.io 最新版 | crates.io |
| 0.7 | 是否有现成 ACP crate（供 Q1 决策）；若有，版本与 gpui 无关性 | crates.io |

产出：一张"版本矩阵"，并回答 **Q-A：gpui-component 的依赖写法到底是 zed git 还是 `gpui-pre`？**
（两个来源矛盾，以仓库原文为准。）若为 zed git，方案 A 的前提需要重述，先回报再继续。

## 步骤 1：脚手架

`spikes/p0/Cargo.toml` 依赖：`gpui-component`、对应的 `gpui-pre*`（版本取步骤 0 结果，`=` 精确锁定）、
`alacritty_terminal`（版本沿用现有锁定的 0.26，如与 gpui-pre 无冲突）。
`rust-toolchain.toml` 按步骤 0.4 pin。

验收：`cargo build` 通过；`cargo tree -d` 中 **gpui 只出现一份**。

## 实验清单

每项记录：通过 / 部分 / 失败、证据（截图、帧耗时、日志）、遗留问题。

| # | 实验 | 做法 | 通过标准 | 平台 |
|---|---|---|---|---|
| E1 | 编译与开窗 | 渲染一个带 gpui-component Root 的窗口，主题设为暗色 | 窗口出现，无 panic | macOS；Windows / Linux 至少 CI 编译通过 |
| E2 | 终端 crate 兼容 | 把 `crates/jagent-terminal` 复制进 spike，改依赖到 gpui-pre，修编译错误，渲染一个真实 PTY 会话 | 能输入输出、选区、滚动、IME 组合上屏；**记录所有需改的 gpui API 差异**（`FocusHandle`、`InputHandler`、`UTF16Selection`、`canvas`、`PathBuilder`、`ClipboardItem`、`ScrollWheelEvent` 等） | macOS |
| E3 | 对话流 | gpui `list` + `ListState`（变高）与 gpui-component `v_virtual_list` 各做一版；1 万条消息；流式追加；`scroll_to_bottom` / follow-tail；用户上滚后停止跟随 | 追加无抖动；滚到底可靠；稳态帧耗时不高于 16ms（记录实测） | macOS |
| E4 | 输入框 | gpui-component `Input` 多行：Enter 提交、Shift+Enter 换行、自增高；中文拼音连续输入、候选窗定位 | 组合文字内联渲染，上屏正确，无重复字符 | macOS 必做；Windows / Linux 手测并记录 |
| E5 | markdown | TextView 渲染含标题、列表、表格、行内代码、围栏代码块（tree-sitter 高亮）的样例；尝试对齐 ConversationView 排版 | 渲染正确；可选中复制；列出无法对齐的样式项 | macOS |
| E6 | 布局外壳 | Dock / Resizable / Sidebar：左侧栏 + 主区 + 右侧面板，拖拽宽度，窄屏切抽屉；自绘标题栏（macOS 红绿灯让位、双击缩放、拖窗） | 拖拽跟手；窗口控制行为正确 | macOS；Windows / Linux 编译 |
| E7 | Git 图规模 | 1 万行 `uniform_list` + 点击行下方插入变高卡片（改用 `list`）；行内自绘列（参考 `native/src/elements/git_graph.rs`） | 滚动帧耗时不劣于现状（现状基线见 `docs/git-graph.md`、`docs/perf-analysis.md`，需先复测一次旧实现作对照） | macOS |
| E8 | 嵌套滚动 | 可滚动主区内嵌可滚动列表；触控板连续滚动穿过边界 | 记录是否出现"滚轮漏给父容器"；判断是否可接受（决定 X1） | macOS |
| E9 | 测试能力 | `#[gpui::test]`：模拟按键、点击、读取元素 bounds、截图 | 能写出一个"按快捷键打开对话框并断言内容"的测试；确认无头截图在 macOS 可用，并记录 Windows / Linux 情况 | macOS |

可选（时间允许）：E10 AccessKit 是否默认启用及其对帧耗时的影响；E11 `gpui-ai` 等同类聊天 UI 组件是否可借鉴。

## 决策矩阵

| 结果 | 动作 |
|---|---|
| E1、E2 通过，E3–E9 无阻断项 | 进入 P1，方案 A 成立 |
| E2 需大量改动终端 crate | 记录改动量；若可控（估算 ≤ 数百行）仍进入 P1 |
| E3 或 E7 不达标 | 优先尝试自建 gpui `list` 方案绕开 gpui-component 的组件；不阻断方案 A |
| E4（IME）在目标平台严重失败 | 评估自建输入控件或等待上游修复；**阻断 P4**，不阻断 P1–P3 |
| 步骤 0 发现 gpui-component 实为 zed git 依赖，或 gpui 无法统一为一份 | 转方案 B：固定 zed 上游 rev，适配 gpui-component；重估 §6 |
| E1 / E2 编译层面无法解决 | 转方案 B 或 C，回报用户决策 |

## 产出

`docs/p0-results.md`：

1. §0 版本矩阵与来源 URL（步骤 0）。
2. E1–E9 结果表（通过标准 / 实测值 / 结论 / 证据）。
3. 终端 crate 的 gpui API 差异清单。
4. X1（嵌套滚动）与 Q-A 的结论。
5. 重新基线的工作量估算。
6. 对 `docs/gpui-rewrite.md` 的修订建议（版本、工程结构、阶段计划）。
