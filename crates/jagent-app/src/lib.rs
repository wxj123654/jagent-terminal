//! j-agent 桌面应用：gpui 视图、Action、主题、窗口。
//!
//! 与 `jagent-core`（纯逻辑，普通 `#[test]`）分层：这里的状态机 / 规则全部在 core，
//! app 只做"把 core 的状态画出来、把输入事件翻译成 core 的方法调用"。

pub mod acp_io;
pub mod actions;
pub mod app;
pub mod crash;
pub mod icons;
pub mod state;
pub mod terminal_style;
pub mod theme;
pub mod views;
