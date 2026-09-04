//! @jagent/native — the ONLY cross-language seam (architecture.md §2.3).
//!
//! Exports exactly five napi commands (changes here require a seam-protocol
//! reason):
//! - `installTerminalElement()` — register the `<terminal>` element factory
//!   with GPUIX (must run before the renderer is initialized)
//! - `createTerminalSession(opts) → sessionId`
//! - `destroyTerminalSession(sessionId)`
//! - `onSessionEvent(cb)` — global session events (title/bell/exit)
//! - `notifyDesktop(title, body, sound)` — Windows toast (T2.5)
//!
//! Everything else is protocol mirroring (SpawnOptionsJs / SessionEvent) and
//! host dispatch ([`host`]). Renderer assembly itself stays JS-side
//! (`@gpuix/react` `createRenderer` + `renderer.init()`); Rust sees it only
//! through the process-global UI command channel (see gpuix `run_on_gpuix`).

mod element;
mod host;
mod notify;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use gpui::BorrowAppContext;

use element::TerminalElementFactory;
use gpuix_native::custom_elements::register_global_factory;
use jagent_terminal::pool::{set_session_event_fn, SessionEvent as RustSessionEvent};
use jagent_terminal::{SpawnOptions, TerminalPool};

/// Register the `<terminal>` element factory with GPUIX. Must run before the
/// renderer is initialized (`main.tsx` calls it at startup, before
/// `renderer.init()`); idempotent (a second call just re-registers the type).
#[napi]
pub fn install_terminal_element() {
    register_global_factory(Box::new(TerminalElementFactory));
}

/// Mirror of `SpawnOptions` (Rust) — see architecture.md §2.3. Appearance
/// settings do NOT belong here: they are element props, applied live.
#[napi(object)]
#[derive(Default)]
pub struct SpawnOptionsJs {
    pub cwd: Option<String>,
    pub program: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub init_command: Option<String>,
    pub scrollback_lines: Option<u32>,
}

fn to_spawn_options(opts: Option<SpawnOptionsJs>) -> SpawnOptions {
    let o = opts.unwrap_or_default();
    SpawnOptions {
        cwd: o.cwd.map(PathBuf::from),
        program: o.program,
        args: o.args.unwrap_or_default(),
        env: o.env.map(|m| m.into_iter().collect()).unwrap_or_default(),
        init_command: o.init_command,
        scrollback_lines: o.scrollback_lines.map(|v| v as usize),
    }
}

/// Global session event payload (R2): one channel for title/bell/exit,
/// delivered even when the element is unmounted (background PTY).
#[napi(object)]
pub struct SessionEvent {
    pub r#type: String,
    pub session_id: f64,
    pub title: Option<String>,
    pub code: Option<f64>,
}

fn session_event_to_js(e: &RustSessionEvent) -> SessionEvent {
    match e {
        RustSessionEvent::Title { id, title } => SessionEvent {
            r#type: "title".into(),
            session_id: *id as f64,
            title: Some(title.clone()),
            code: None,
        },
        RustSessionEvent::Bell { id } => SessionEvent {
            r#type: "bell".into(),
            session_id: *id as f64,
            title: None,
            code: None,
        },
        RustSessionEvent::Exit { id, code } => SessionEvent {
            r#type: "exit".into(),
            session_id: *id as f64,
            title: None,
            code: code.map(|c| c as f64),
        },
    }
}

/// Register the global session-event callback (once, at app startup).
/// TSF protocol: `cb(null, e)` — the payload is the SECOND argument
/// (first is the error slot). In JS: `onSessionEvent((_err, e) => ...)`.
#[napi(ts_args_type = "cb: (err: null, e: import('./index').SessionEvent) => void")]
pub fn on_session_event(cb: ThreadsafeFunction<SessionEvent>) {
    let tsf = cb;
    set_session_event_fn(Arc::new(move |e: &RustSessionEvent| {
        let payload = session_event_to_js(e);
        tsf.call(Ok(payload), ThreadsafeFunctionCallMode::Blocking);
    }));
}

fn host_error(e: anyhow::Error) -> Error {
    Error::from_reason(format!("{e:#}"))
}

/// Spawn a terminal session: PTY + model + pool registration. Resolves with
/// the sessionId that `<terminal sessionId>` binds to.
///
/// Synchronous on purpose: the test path (run_on_test_app) needs this-thread
/// access to VisualTestState (thread_local), and napi async fns run on the
/// tokio runtime — a different thread. The JS seam keeps its Promise shape
/// via a thin async wrapper at the injection site (main.tsx / e2e).
#[napi]
pub fn create_terminal_session(opts: Option<SpawnOptionsJs>) -> Result<f64> {
    let spawn = to_spawn_options(opts);
    let id = host::run_host(move |cx: &mut gpui::App| {
        TerminalPool::init_global(cx);
        cx.update_global::<TerminalPool, _>(|pool, cx| pool.create(spawn, cx))
            .map_err(|e| anyhow::anyhow!("{e:#}"))
    })
    .map_err(host_error)?;
    Ok(id as f64)
}

/// Destroy a session: kill the PTY child, drop the model, remove from the
/// pool. Views still bound to it render the placeholder afterwards.
#[napi]
pub fn destroy_terminal_session(session_id: f64) -> Result<()> {
    let id = session_id as u64;
    host::run_host(move |cx: &mut gpui::App| {
        cx.update_global::<TerminalPool, _>(|pool, cx| pool.destroy(id, cx))
            .map_err(|e| anyhow::anyhow!("{e:#}"))
    })
    .map_err(host_error)?;
    Ok(())
}

/// Show a desktop toast (Windows). Fire-and-forget on a detached thread:
/// failures log to stderr and never reject — notifications are a
/// non-critical path (bell → notify, settings.desktop gates the call).
#[napi]
pub fn notify_desktop(title: String, body: String, sound: bool) {
    notify::show(&title, &body, sound);
}
