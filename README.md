# j-agent

> Agent Plane —— 把 CLI/TUI agent 跑在真正的原生 GPU 终端里。

j-agent 是一个桌面 Agent 会话管理器：Claude Code、Codex、Pi、Amp 这类 CLI agent
与普通 shell 会话**混排在同一个列表**里，每个会话坐在真正的 PTY + GPU 终端仿真器上
（Zed terminal 技术栈：alacritty_terminal + gpui），而不是 xterm.js 或 WebView。

技术底座：**纯 Rust + [gpui](https://github.com/zed-industries/zed)**（经
`gpui-pre` 快照分发）+ `gpui-component` 控件层。2026-10 从 React/GPUIX/napi
架构整体重写为单一 Rust 工作区（过程与决策见 `docs/gpui-rewrite.md`）。

## 构建

```sh
cargo run                 # 开发运行（自动起一个 shell 会话）
cargo test --workspace    # 全量测试（视觉测试需 macOS 主线程，见下）
cargo build --release     # 发布构建
```

- 工具链 pin 1.97.1（`rust-toolchain.toml`）；gpui 系列依赖精确锁定
  （`gpui-pre =0.3.8` / `gpui-component =0.7.1`），升级整体进行（AGENTS.md 规则 5）。
- 三个 `harness = false` 视觉/事件测试（`shell_shot` / `nested_scroll` /
  `terminal_settings`）需要 AppKit 主线程与系统服务，在沙箱/CI 之外的终端跑。

## 仓库布局

```
crates/jagent-core/       纯逻辑（无 gpui）：settings / threads 规则 / git 数据层 /
                          ACP 协议 / 预设。普通 #[test]，当前 270 个
crates/jagent-terminal/   终端栈：TerminalPool（retain 语义）/ PTY / vendored
                          gpui-terminal 绘制。当前 41 个测试
crates/jagent-app/        二进制 j-agent：gpui 视图、Action 键位、主题、窗口、
                          crash sidecar、watchdog。75 单元测试 + 3 视觉 + 3 集成
docs/architecture.md      架构契约（分层/依赖方向/视图范式/测试面）
docs/gpui-rewrite.md      React → Rust 重写的过程记录与决策
docs/p0-results.md        依赖核实与 P0 spike 实验结论
CONTEXT.md                领域词汇表
scripts/                  发布脚本：package-macos-app.sh / check-windows-icon.ps1
.github/workflows/        rust-release.yml（macOS/Linux/Windows CI）
```

## 运行形态

- `j-agent` 默认由内置 watchdog 启动（崩溃自动重启，60s 内 5 次截止）；
  panic 经 sidecar（`--crash-sidecar`）落结构化 JSON 报告。
- 数据目录 `~/.j-agent/`（settings.json / state.json / 崩溃报告），
  与旧 React 版配置互读兼容。
- macOS 打包：`scripts/package-macos-app.sh release`（ad-hoc 签名）；
  Windows 版本资源（图标/PE 校验）由 build.rs + CI 脚本处理。

## 设计速览

- **规则在 core，视图在 app**：`ThreadStore<E: Effects>` 收口全部会话规则，
  副作用经 Effects 注入（测试注 fake，生产 `GuiEffects`）。
- **TerminalPool 是 gpui Global**：会话比视图活得久——切走的会话 PTY 照跑，
  后台 BEL 照样落通知。
- 对话流用 `gpui::list` + 原生 `FollowMode::Tail`；Git 图 1 万提交普通元素树
  CPU 侧 <1ms/帧；嵌套滚动统一走 `views/nested_scroll` 封装。

详细契约（模块表、视图范式约定、测试面、明确不做清单）见
`docs/architecture.md`。
