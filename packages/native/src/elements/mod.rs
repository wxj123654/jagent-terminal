//! Custom elements — GPUIX `CustomElement` adapter 层（architecture.md §2.4）。
//!
//! 每个文件是一个元素的 GPUIX 绑定：实现 gpuix-native 的 `CustomElement`/
//! `CustomElementFactory`，在 lib.rs 的 install_* napi 命令里注册进
//! 全局工厂表。本层只做协议桥接，无业务规则——terminal.rs 绑定会话池
//! 视图，git_graph.rs 做 canvas 文本绘制（perf 动机见文件头注释）。

pub mod git_graph;
pub mod terminal;
