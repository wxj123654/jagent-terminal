//! Phase 0 verification window (architecture.md §8.3).
//!
//! Pure gpui window, no GPUIX/React: `TerminalPool::create` + a
//! `TerminalView` bound to the session, running the default shell.
//!
//! Verification checklist (run manually):
//! - Windows ConPTY works (shell prompt appears, input round-trips)
//! - true color (24-bit) renders
//! - application cursor mode (vim/htop arrow keys)
//! - BEL (`printf '\a'` / PowerShell `` "`a" ``) → prints `[session] Bell`
//! - OSC title (`printf '\e]2;x\007'`) → prints `[session] Title`
//! - `exit` → prints `[session] Exit`, window stays (pool retains nothing
//!   after destroy; here we just observe)
//!
//! Usage: `cargo run -p jagent-terminal --example window [-- "<init command>"]`

use std::sync::Arc;

use gpui::prelude::*;
use gpui::{App, AppContext};
use jagent_terminal::pool::set_session_event_fn;
use jagent_terminal::{SessionEvent, SpawnOptions, TerminalPool, TerminalView};

fn main() {
    #[cfg(windows)]
    enable_per_monitor_dpi();

    let app = gpui_platform::application();
    app.run(|cx: &mut App| {
        // Global pool + session-event sink (prints title/bell/exit).
        TerminalPool::init_global(cx);
        set_session_event_fn(Arc::new(|event: &SessionEvent| match event {
            SessionEvent::Title { id, title } => println!("[session {id}] title: {title:?}"),
            SessionEvent::Bell { id } => println!("[session {id}] BELL"),
            SessionEvent::Exit { id, code } => println!("[session {id}] EXIT (code {code:?})"),
        }));

        // TERM/COLORTERM defaults live in the crate (pty.rs), not here.
        let opts = SpawnOptions {
            init_command: std::env::args().nth(1),
            ..Default::default()
        };

        let session_id = cx
            .update_global::<TerminalPool, _>(|pool, cx| pool.create(opts, cx))
            .expect("failed to create terminal session");
        println!("session {session_id} spawned");

        let bounds = gpui::Bounds::centered(
            None,
            gpui::size(gpui::px(1100.0), gpui::px(750.0)),
            cx,
        );

        let window = cx
            .open_window(
                gpui::WindowOptions {
                    window_bounds: Some(gpui::WindowBounds::Windowed(bounds)),
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some("j-agent · Phase 0".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                move |window, cx| {
                    let model = cx
                        .default_global::<TerminalPool>()
                        .get(session_id)
                        .expect("session still in pool");
                    let view = cx.new(|cx| TerminalView::new(model, cx));
                    let handle = view.read(cx).focus_handle().clone();
                    handle.focus(window, cx);
                    view
                },
            )
            .expect("failed to open window");
        let _ = window;
    });
}

/// Per-monitor DPI awareness without an embedded manifest (a .node cannot
/// ship one). Mirrors gpuix-native `renderer.rs`.
#[cfg(windows)]
fn enable_per_monitor_dpi() {
    use windows::Win32::UI::HiDpi::{
        AreDpiAwarenessContextsEqual, GetThreadDpiAwarenessContext,
        SetProcessDpiAwarenessContext, SetThreadDpiAwarenessContext,
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };

    unsafe {
        let current = GetThreadDpiAwarenessContext();
        if AreDpiAwarenessContextsEqual(current, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
            .as_bool()
        {
            return;
        }
        if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).is_ok() {
            return;
        }
        if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE).is_ok() {
            return;
        }
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}
