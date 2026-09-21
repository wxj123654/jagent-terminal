//! jagent-terminal: terminal session pool + emulator for j-agent.
//!
//! Pure Rust, no napi dependency. Zed-terminal-shaped:
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
//! The GPUIX `<terminal>` custom element lives in `packages/native`
//! (it must implement the gpuix `CustomElement` trait); there is no
//! element module here.

// 模块全部私有：对外契约只有根部 re-export 这一个 interface
// （element/git_graph 之外不再有 jagent_terminal::xxx:: 深路径）。
mod error;
mod model;
mod perf;
mod pool;
mod pty;
mod view;

pub use error::{HostPanic, TerminalError, terminal_error_code};
pub use model::{Event, TerminalModel, TerminalStyle};
pub use perf::{PaintPerfSnapshot, take_paint_perf};
pub use pool::{SessionEvent, SessionEventFn, TerminalPool, set_session_event_fn};
pub use pty::SpawnOptions;
pub use view::{ColorPalette, TerminalRenderer, TerminalView, keystroke_to_bytes};
