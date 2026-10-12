//! error.rs — 结构化错误（沿用旧错误管理方案 B 的稳定错误码契约；跨语言 seam
//! 已随 P8 移除，消费方是 `jagent-app`）。
//!
//! `anyhow` stays for internal plumbing; `TerminalError` carries stable
//! error codes（`terminal_error_code`）so callers can branch:
//! retry / ignore / prompt.
//!
//! Design note: spawn failures are NOT here. `TerminalModel::new` keeps the
//! Zed semantics (failed spawn → immediately-exited session surfaced through
//! the `Exit` session event); only synchronous seam errors are typed.

use std::fmt;

/// Errors surfaced synchronously to the embedding app.
#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    /// `destroy(id)` on an id the pool never held (or already removed).
    #[error("no terminal session {0}")]
    SessionNotFound(u64),
    /// Invalid spawn options rejected before any side effect.
    #[error("invalid spawn options: {0}")]
    InvalidOptions(String),
    /// The GPUI host dispatch failed before/inside the closure (incl. a
    /// caught host panic — see `host::HostPanic`).
    #[error("host dispatch failed: {0}")]
    Host(String),
}

/// 稳定错误码：调用方按此分支（可重试/可忽略/需提示）。
pub fn terminal_error_code(e: &TerminalError) -> &'static str {
    match e {
        TerminalError::SessionNotFound(_) => "ERR_TERMINAL_SESSION_NOT_FOUND",
        TerminalError::InvalidOptions(_) => "ERR_TERMINAL_INVALID_OPTIONS",
        TerminalError::Host(_) => "ERR_TERMINAL_HOST",
    }
}

/// Marker carried inside `anyhow::Error` when a host closure panicked and was
/// caught by `catch_unwind`（旧 napi 层曾把它映射为 `ERR_NATIVE_PANIC` 以区分
/// "host 不可靠"与"命令被拒绝"；gpui 版里由调用方自行分支）。
#[derive(Debug)]
pub struct HostPanic(pub String);

impl fmt::Display for HostPanic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "host closure panicked: {}", self.0)
    }
}
impl std::error::Error for HostPanic {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_forms() {
        assert_eq!(
            TerminalError::SessionNotFound(7).to_string(),
            "no terminal session 7"
        );
        assert_eq!(
            TerminalError::InvalidOptions("cwd missing".into()).to_string(),
            "invalid spawn options: cwd missing"
        );
        let e: anyhow::Error = TerminalError::SessionNotFound(3).into();
        assert!(e.downcast_ref::<TerminalError>().is_some());
    }

    #[test]
    fn host_panic_downcast_through_anyhow() {
        let e: anyhow::Error = HostPanic("boom".into()).into();
        let hp = e.downcast_ref::<HostPanic>().unwrap();
        assert_eq!(hp.0, "boom");
        assert!(e.downcast_ref::<TerminalError>().is_none());
    }
}
