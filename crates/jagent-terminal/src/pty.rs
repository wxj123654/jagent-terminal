//! PTY assembly — Zed `TerminalBuilder` mode.
//!
//! ```text
//! SpawnOptions ──> pty_options() ──> tty::new() ──> EventLoop::new(term, listener, pty) .spawn()
//!                                                        │
//!                                                        └─ Notifier → PtySender (write / resize / shutdown)
//! ```
//!
//! The alacritty `EventLoop` owns the reader/writer threads. Windows uses
//! ConPTY (Win10 1809+); `shell: None` lets the platform pick the default
//! shell.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use alacritty_terminal::event::{Event as AlacTermEvent, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, Notifier};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::Term;
use alacritty_terminal::tty::{self, Options as TtyOptions};

use crate::model::{SessionListener, TermLock};

/// Options for spawning a terminal session (mirrors the napi `SpawnOptions`).
#[derive(Debug, Default, Clone)]
pub struct SpawnOptions {
    /// Working directory; defaults to the process CWD/home.
    pub cwd: Option<PathBuf>,
    /// Program to run; `None` = platform default shell.
    pub program: Option<String>,
    /// Arguments for `program`.
    pub args: Vec<String>,
    /// Extra environment entries (e.g. `AMP_FORCE_BEL=1`).
    pub env: Vec<(String, String)>,
    /// Command typed into the PTY after spawn (NOT exec).
    /// Sent as `write_to_pty(cmd)` + `write_to_pty(b"\x0d")` — Zed
    /// activation_script precedent; `\r` only, PowerShell breaks on `\r\n`.
    pub init_command: Option<String>,
    /// Scrollback history lines (session property, fixed at creation).
    pub scrollback_lines: Option<usize>,
}

/// Window size in terminal cells (alacritty's units).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub columns: u16,
    pub rows: u16,
    pub cell_width: u16,
    pub cell_height: u16,
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self {
            columns: 80,
            rows: 24,
            cell_width: 0,
            cell_height: 0,
        }
    }
}

impl TerminalSize {
    fn to_window_size(self) -> WindowSize {
        WindowSize {
            num_cols: self.columns,
            num_lines: self.rows,
            cell_width: self.cell_width,
            cell_height: self.cell_height,
        }
    }
}

fn pty_options(opts: &SpawnOptions) -> TtyOptions {
    // Terminal identity defaults — session knowledge lives here, not in the
    // napi shell. Callers may override by passing their own entries.
    let mut env = opts.env.clone();
    if !env.iter().any(|(k, _)| k == "TERM") {
        env.push(("TERM".into(), "xterm-256color".into()));
    }
    if !env.iter().any(|(k, _)| k == "COLORTERM") {
        env.push(("COLORTERM".into(), "truecolor".into()));
    }
    TtyOptions {
        shell: opts
            .program
            .clone()
            .map(|program| tty::Shell::new(program, opts.args.clone())),
        working_directory: opts.cwd.clone(),
        drain_on_exit: true,
        env: env.into_iter().collect(),
        #[cfg(not(windows))]
        child_signal_mask: None,
        #[cfg(windows)]
        escape_args: true,
    }
}

/// Owned handle to a running PTY: writer + resizer + shutdown, all through the
/// alacritty event-loop channel (no direct fd/master access).
pub struct PtySender {
    notifier: Notifier,
}

impl PtySender {
    /// Queue raw bytes for the PTY. Empty slices are ignored (alacritty hangs
    /// on zero-length writes).
    pub fn write(&self, bytes: &[u8]) {
        use alacritty_terminal::event::Notify;
        if bytes.is_empty() {
            return;
        }
        self.notifier.notify(bytes.to_vec());
    }

    /// Resize the PTY (kernel + child see the new size).
    pub fn resize(&self, size: TerminalSize) {
        let _ = self.notifier.0.send(alacritty_terminal::event_loop::Msg::Resize(
            size.to_window_size(),
        ));
    }

    /// Ask the event loop (reader/writer threads) to shut down.
    pub fn shutdown(&self) {
        let _ = self
            .notifier
            .0
            .send(alacritty_terminal::event_loop::Msg::Shutdown);
    }
}

/// Open a PTY and spawn the alacritty event loop around `term`.
///
/// Returns the shared term lock and the writer handle. The event loop keeps
/// reading the PTY into `term` (behind its `FairMutex`) and forwards events
/// to `events_tx` via the `SessionListener` embedded in the `Term`.
pub fn open_pty(
    opts: &SpawnOptions,
    size: TerminalSize,
    term: Term<SessionListener>,
    events_tx: futures::channel::mpsc::UnboundedSender<PtyEvent>,
) -> io::Result<(TermLock, PtySender)> {
    let term: TermLock = Arc::new(FairMutex::new(term));
    let pty = tty::new(&pty_options(opts), size.to_window_size(), 0)?;
    let event_loop = EventLoop::new(
        term.clone(),
        SessionListener { tx: events_tx },
        pty,
        true,
        false,
    )?;
    // `spawn` consumes the event loop; take the channel first.
    let notifier = Notifier(event_loop.channel());
    let _join = event_loop.spawn();
    Ok((term, PtySender { notifier }))
}

/// Channel-level event from the alacritty side (term + event loop).
#[derive(Debug)]
pub enum PtyEvent {
    Event(AlacTermEvent),
}
