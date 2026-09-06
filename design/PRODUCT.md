# j-agent 原型

<!-- impeccable:product-schema 1 -->

## Platform

web

这里记录浏览器可交互原型，不代表正式应用改用 Web 技术。正式应用仍是 GPUIX + 原生 PTY。

## Users

在多个项目目录之间切换、使用 pi 和各种 CLI / TUI 工具的开发者。

## Product Purpose

用工作区组织终端会话：选择项目，再在该项目目录中使用工具，而不是把所有会话混在一个无归属的列表里。

## Operating Context

用户已确认本轮交付独立 HTML 原型，侧栏采用 Codex 式工作区分组：多个工作区同时可见，展开后显示各自的工具会话。

## Capabilities and Constraints

- 工作区对应项目目录；会话属于一个工作区，新建时继承其 cwd。
- pi 是主要入口，也可使用 Shell、lazygit、yazi、btop 和自定义命令。
- 保留单一内容区；不同工具呈现自己的 TUI，不额外增加聊天 composer、标签栏或分屏。
- 原型只演示交互，不读取目录、不启动进程、不调用模型、不修改文件；刷新恢复示例。
- 不改现有应用、Rust 终端与 `.refs/`；正式工作区数据模型及持久化尚未实施。
- 现有已拍板实现契约仍位于 `../docs/agent-plane-layout.md`；此处是待评审的新方案。

## Brand Commitments

保持 j-agent 名称、现有深色开发者界面语境；工作区组织参考 Codex。

## Evidence on Hand

已有原型 `agent-plane-layout.html`、`settings-ui.html`；正式界面 `../packages/app/src/plane/` 与 `../packages/app/src/ui/tokens.ts`。
