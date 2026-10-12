//! jagent-terminal: terminal session pool + emulator for j-agent.
//!
//! Zed-terminal-shaped:
//!
//! - [`pool`]: global [`TerminalPool`] owning sessions (`Entity<TerminalModel>`)
//!   keyed by `u64`. Retain semantics: sessions outlive views.
//! - [`model`]: [`TerminalModel`] — alacritty `Term` behind `FairMutex`, PTY
//!   sender, 4ms-batched event consumer task, gpui `EventEmitter`.
//! - [`pty`]: PTY assembly (Zed `TerminalBuilder` mode: `tty::new` +
//!   `EventLoop::spawn`).
//! - [`view`]: terminal rendering (vendored from gpui-terminal, adapted to
//!   render [`TerminalModel`] instead of owning a PTY).
//!
//! Views live in `jagent-app`（`views/terminal_pane.rs` 宿主 `view::TerminalView`）；
//! 本 crate 只有根部 re-export 这一个 interface。

// 模块全部私有：对外契约只有根部 re-export 这一个 interface
// （不再有 jagent_terminal::xxx:: 深路径）。
mod error;
mod model;
mod perf;
mod pool;
mod pty;
mod view;

pub use error::{HostPanic, TerminalError, terminal_error_code};
pub use gpui::Pixels;
pub use model::{Event, TerminalModel, TerminalStyle};
pub use perf::{PaintPerfSnapshot, take_paint_perf};
pub use pool::{SessionEvent, SessionEventFn, TerminalPool, set_session_event_fn};
pub use pty::SpawnOptions;
pub use view::{ColorPalette, TerminalRenderer, TerminalView, keystroke_to_bytes};
