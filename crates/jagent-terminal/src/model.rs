//! TerminalModel — gpui entity wrapping the emulator state.
//!
//! Zed `Terminal` reduced to what j-agent needs:
//!
//! - alacritty `Term` behind `FairMutex` (shared with the event loop threads)
//! - PTY sender for input/resize
//! - one consumer task pumping `PtyEvent`s with the Zed 4ms batching scheme:
//!   first event processed immediately (low latency), then a 4ms window
//!   aggregates the rest (`Wakeup` flagged separately, cap 100 events)
//! - re-emits `Event::{Title, Bell, Exit, Wakeup}` on the gpui event bus
//!   (views subscribe for repaints) and forwards session-level events to the
//!   global sink in [`crate::pool`] (napi ThreadsafeFunction in Phase 1).

use std::sync::Arc;
use std::time::Duration;

use alacritty_terminal::event::{Event as AlacTermEvent, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::Column;
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::Config as TermConfig;
use alacritty_terminal::term::{Term, TermMode};
use futures::channel::mpsc::UnboundedSender;
use futures::StreamExt;
use gpui::{App, AppContext, Context, Entity, EventEmitter, Pixels, SharedString};

use crate::pool::{forward_session_event, SessionEvent};
use crate::pty::{open_pty, PtySender, SpawnOptions, TerminalSize};

/// Events forwarded out of a terminal session on the gpui event bus.
/// Views subscribe to `Wakeup` for repaints; the pool sink receives
/// title/bell/exit through a separate path (see module docs).
#[derive(Debug, Clone)]
pub enum Event {
    /// OSC 0/2 title change.
    Title(String),
    /// BEL received.
    Bell,
    /// PTY child exited.
    Exit,
    /// Grid has new content; views should repaint.
    Wakeup,
}

/// `EventListener` impl piping alacritty events into the model's channel.
#[derive(Clone)]
pub struct SessionListener {
    pub tx: UnboundedSender<crate::pty::PtyEvent>,
}

impl EventListener for SessionListener {
    fn send_event(&self, event: AlacTermEvent) {
        use crate::pty::PtyEvent;
        let _ = self.tx.unbounded_send(PtyEvent::Event(event));
    }
}

pub type AlacTerm = Term<SessionListener>;
pub type TermLock = Arc<FairMutex<AlacTerm>>;

/// Initial/resize dimensions for the alacritty grid.
#[derive(Debug, Clone, Copy)]
pub struct TermDimensions {
    pub columns: usize,
    pub rows: usize,
}

impl TermDimensions {
    pub fn new(columns: usize, rows: usize) -> Self {
        Self { columns, rows }
    }
}

impl Dimensions for TermDimensions {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.columns
    }
    fn last_column(&self) -> Column {
        Column(self.columns.saturating_sub(1))
    }
}

/// Appearance + behaviour that the view reads every frame. Mutated via
/// `set_style` (element props in Phase 1); changes take effect without
/// recreating the session. `PartialEq` powers `set_style`'s idempotence.
#[derive(Debug, Clone, PartialEq)]
pub struct TerminalStyle {
    pub font_family: SharedString,
    pub font_size: Pixels,
    pub line_height_multiplier: f32,
    pub padding: gpui::Edges<Pixels>,
    /// Palette id ("one-dark"), resolved by the view via `colors::by_name`.
    pub palette: SharedString,
    /// When false the cursor is drawn steady (no blink timer activity).
    pub cursor_blink: bool,
}

/// 平台默认等宽字体。Consolas 是 Windows 字体——在 macOS 上解析不到
/// family，字形落到不可预测的 fallback（豆腐块/宽窄不一）；Menlo 是
/// macOS 自带等宽字体；Linux 走 fontconfig 的通用 monospace。
pub fn default_font_family() -> &'static str {
    if cfg!(target_os = "macos") {
        "Menlo"
    } else if cfg!(target_os = "windows") {
        "Consolas"
    } else {
        "monospace"
    }
}

impl Default for TerminalStyle {
    fn default() -> Self {
        Self {
            font_family: default_font_family().into(),
            font_size: gpui::px(14.0),
            line_height_multiplier: 1.2,
            padding: gpui::Edges::all(gpui::px(8.0)),
            palette: "one-dark".into(),
            cursor_blink: true,
        }
    }
}

/// Default scrollback when `SpawnOptions::scrollback_lines` is `None`.
pub const DEFAULT_SCROLLBACK_LINES: usize = 10_000;
/// Zed's cap.
pub const MAX_SCROLLBACK_LINES: usize = 100_000;

/// The terminal session model. One per PTY; lives in the pool, not in views.
pub struct TerminalModel {
    id: u64,
    term: TermLock,
    pty: Option<PtySender>,
    style: TerminalStyle,
    scrollback_lines: usize,
    /// Set once `Exit`/`ChildExit` is observed; further input is dropped.
    exited: bool,
}

impl EventEmitter<Event> for TerminalModel {}

impl TerminalModel {
    /// Spawn a session: open the PTY, create the term, start the consumer
    /// task (4ms batching). The pool assigns the id right after via
    /// [`set_id`](Self::set_id); events only forward once the id is set.
    pub fn new(opts: &SpawnOptions, cx: &mut App) -> Entity<Self> {
        let scrollback = opts
            .scrollback_lines
            .unwrap_or(DEFAULT_SCROLLBACK_LINES)
            .min(MAX_SCROLLBACK_LINES);
        let term_config = TermConfig {
            scrolling_history: scrollback,
            ..Default::default()
        };

        let (events_tx, mut events_rx) = futures::channel::mpsc::unbounded::<crate::pty::PtyEvent>();
        let default_size = TerminalSize::default();
        let dims = TermDimensions::new(default_size.columns as usize, default_size.rows as usize);
        let term = Term::new(
            term_config,
            &dims,
            SessionListener {
                tx: events_tx.clone(),
            },
        );

        let (term, pty) = match open_pty(opts, default_size, term, events_tx.clone()) {
            Ok(handle) => handle,
            Err(error) => {
                // Surface the spawn failure as an immediately-exited session.
                return cx.new(|_| Self {
                    id: 0,
                    term: Arc::new(FairMutex::new(Term::new(
                        TermConfig::default(),
                        &dims,
                        SessionListener { tx: events_tx },
                    ))),
                    pty: None,
                    style: TerminalStyle::default(),
                    scrollback_lines: scrollback,
                    exited: true,
                })
                .tap_error(error);
            }
        };

        // Consumer task: Zed's 4ms batching scheme.
        cx.new(|cx: &mut Context<Self>| {
            cx.spawn(async move |this, cx| {
                while let Some(event) = events_rx.next().await {
                    if this
                        .update(cx, |model, cx| model.process_pty_event(event, cx))
                        .is_err()
                    {
                        break;
                    }

                    'outer: loop {
                        let mut events = Vec::new();
                        let mut timer = futures::FutureExt::fuse(
                            cx.background_executor().timer(Duration::from_millis(4)),
                        );
                        let mut wakeup = false;
                        loop {
                            futures::select_biased! {
                                _ = timer => break,
                                event = events_rx.next() => {
                                    if let Some(event) = event {
                                        if matches!(
                                            event,
                                            crate::pty::PtyEvent::Event(AlacTermEvent::Wakeup)
                                        ) {
                                            wakeup = true;
                                        } else {
                                            events.push(event);
                                        }
                                        if events.len() > 100 {
                                            break;
                                        }
                                    } else {
                                        break;
                                    }
                                }
                            }
                        }

                        if events.is_empty() && !wakeup {
                            break 'outer;
                        }

                        let result = this.update(cx, |model, cx| {
                            if wakeup {
                                model.process_wakeup(cx);
                            }
                            for event in events {
                                model.process_pty_event(event, cx);
                            }
                        });
                        if result.is_err() {
                            break;
                        }
                    }
                }
            })
            .detach();

            Self {
                id: 0,
                term,
                pty: Some(pty),
                style: TerminalStyle::default(),
                scrollback_lines: scrollback,
                exited: false,
            }
        })
    }

    /// Assign the pool id (called once by the pool right after creation).
    pub fn set_id(&mut self, id: u64) {
        self.id = id;
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    fn process_pty_event(&mut self, event: crate::pty::PtyEvent, cx: &mut Context<Self>) {
        let crate::pty::PtyEvent::Event(event) = event;
        match event {
            AlacTermEvent::Title(title) => {
                if self.id != 0 {
                    forward_session_event(&SessionEvent::Title {
                        id: self.id,
                        title: title.clone(),
                    });
                }
                cx.emit(Event::Title(title));
            }
            AlacTermEvent::ResetTitle => {
                if self.id != 0 {
                    forward_session_event(&SessionEvent::Title {
                        id: self.id,
                        title: String::new(),
                    });
                }
                cx.emit(Event::Title(String::new()));
            }
            AlacTermEvent::Bell => {
                if self.id != 0 {
                    forward_session_event(&SessionEvent::Bell { id: self.id });
                }
                cx.emit(Event::Bell);
            }
            AlacTermEvent::ChildExit(status) => {
                // ChildExit carries the exit status; alacritty also sends a
                // bare Exit — forward once, preferring the one with a code.
                if !self.exited {
                    self.exited = true;
                    if self.id != 0 {
                        forward_session_event(&SessionEvent::Exit {
                            id: self.id,
                            code: status.code(),
                        });
                    }
                    cx.emit(Event::Exit);
                }
            }
            AlacTermEvent::Exit => {
                // Stream end without a child status (rare): exit code unknown.
                if !self.exited {
                    self.exited = true;
                    if self.id != 0 {
                        forward_session_event(&SessionEvent::Exit { id: self.id, code: None });
                    }
                    cx.emit(Event::Exit);
                }
            }
            AlacTermEvent::Wakeup => self.process_wakeup(cx),
            AlacTermEvent::PtyWrite(data) => self.write_to_pty(data.as_bytes()),
            AlacTermEvent::ClipboardStore(_, _) | AlacTermEvent::ClipboardLoad(_, _) => {}
            AlacTermEvent::MouseCursorDirty
            | AlacTermEvent::ColorRequest(_, _)
            | AlacTermEvent::TextAreaSizeRequest(_)
            | AlacTermEvent::CursorBlinkingChange => {}
        }
    }

    fn process_wakeup(&mut self, cx: &mut Context<Self>) {
        cx.emit(Event::Wakeup);
    }

    // ---- public API (pool / view / napi shell) ----

    /// Write raw bytes to the PTY (keyboard input, init command).
    pub fn write_to_pty(&self, bytes: &[u8]) {
        if self.exited {
            return;
        }
        if let Some(pty) = &self.pty {
            pty.write(bytes);
        }
    }

    /// Resize term + PTY to `columns x rows` (cell size in pixels).
    pub fn resize(&self, columns: usize, rows: usize, cell_width: u16, cell_height: u16) {
        self.term.lock().resize(TermDimensions::new(columns, rows));
        if let Some(pty) = &self.pty {
            pty.resize(TerminalSize {
            columns: columns as u16,
            rows: rows as u16,
                cell_width,
                cell_height,
            });
        }
    }

    /// Current terminal mode flags (APP_CURSOR etc. — used by input encoding).
    pub fn mode(&self) -> TermMode {
        *self.term.lock().mode()
    }

    /// Run `f` with shared access to the alacritty term (rendering, search...).
    pub fn with_term<R>(&self, f: impl FnOnce(&AlacTerm) -> R) -> R {
        let guard = self.term.lock();
        f(&guard)
    }

    /// Run `f` with exclusive access (scroll, selection...).
    pub fn with_term_mut<R>(&self, f: impl FnOnce(&mut AlacTerm) -> R) -> R {
        let mut guard = self.term.lock();
        f(&mut guard)
    }

    pub fn term_lock(&self) -> TermLock {
        self.term.clone()
    }

    pub fn style(&self) -> &TerminalStyle {
        &self.style
    }

    /// Idempotent: a no-op when the style is unchanged (callers may invoke
    /// per-frame; only real changes notify/repaint).
    pub fn set_style(&mut self, style: TerminalStyle, cx: &mut Context<Self>) {
        if self.style != style {
            self.style = style;
            cx.notify();
        }
    }

    pub fn scrollback_lines(&self) -> usize {
        self.scrollback_lines
    }

    pub fn is_exited(&self) -> bool {
        self.exited
    }

    /// Ask the PTY event loop to shut down (called by pool destroy).
    pub fn shutdown(&self) {
        if let Some(pty) = &self.pty {
            pty.shutdown();
        }
    }
}

/// Small helper to log spawn errors on the error path of `TerminalModel::new`.
trait TapError {
    fn tap_error(self, error: std::io::Error) -> Self;
}

impl TapError for Entity<TerminalModel> {
    fn tap_error(self, error: std::io::Error) -> Self {
        eprintln!("jagent-terminal: failed to open pty: {error}");
        self
    }
}
