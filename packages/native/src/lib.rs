//! @jagent/native — the ONLY cross-language seam (architecture.md §2.3).
//!
//! Exports exactly four things (changes here require a seam-protocol reason):
//! - `createTerminalSession(opts) → sessionId`
//! - `destroyTerminalSession(sessionId)`
//! - `onSessionEvent(cb)` — global session events (title/bell/exit)
//! - element registration happens at module load (`#[module_exports]`):
//!   `terminal` becomes available to JSX from any GPUIX renderer.
//!
//! Renderer assembly itself stays JS-side (`@gpuix/react` `createRenderer` +
//! `renderer.init()`); Rust sees it only through the process-global UI
//! command channel published by gpuix on init (see gpuix `run_on_gpuix`).

mod element;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use element::TerminalElementFactory;
use gpuix_native::custom_elements::register_global_factory;
use jagent_terminal::pool::{set_session_event_fn, SessionEvent as RustSessionEvent};
use jagent_terminal::{SpawnOptions, TerminalPool};

use gpui::BorrowAppContext;

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
    let mut env: Vec<(String, String)> = o
        .env
        .map(|m| m.into_iter().collect())
        .unwrap_or_default();
    // Terminal defaults, mirroring examples/window.rs.
    env.push(("TERM".into(), "xterm-256color".into()));
    env.push(("COLORTERM".into(), "truecolor".into()));
    SpawnOptions {
        cwd: o.cwd.map(PathBuf::from),
        program: o.program,
        args: o.args.unwrap_or_default(),
        env,
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
        RustSessionEvent::Exit { id } => SessionEvent {
            r#type: "exit".into(),
            session_id: *id as f64,
            title: None,
            code: None,
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

/// Run `f` with GPUI app access: via the threaded host channel when the real
/// renderer is live, or directly on the test renderer's VisualTestState under
/// e2e (bun test + TestGpuixRenderer, single-threaded). gpuix patch #6 seam.
fn on_app(
    f: Box<dyn FnOnce(&mut gpui::App) -> anyhow::Result<serde_json::Value> + Send>,
) -> anyhow::Result<serde_json::Value> {
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
    {
        use gpuix_native::{host_ui_commands_ready, run_on_gpuix};
        if host_ui_commands_ready() {
            run_on_gpuix(Box::new(move |cx, _window| {
                cx.update(|cx: &mut gpui::App| f(cx))
                    .map_err(|e: anyhow::Error| anyhow::anyhow!("{e:#}"))
            }))
        } else {
            // No threaded renderer: e2e under TestGpuixRenderer. Its host seam
            // exists on Windows/macOS builds only (gpuix test_renderer cfg).
            #[cfg(target_os = "windows")]
            {
                gpuix_native::run_on_test_app(f)
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = f;
                Err(anyhow::anyhow!(
                    "no GPUI host available (no threaded renderer, no test renderer)",
                ))
            }
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "freebsd")))]
    {
        let _ = f;
        Err(anyhow::anyhow!(
            "terminal sessions are Windows/Linux only for now",
        ))
    }
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
    let value = on_app(Box::new(move |cx: &mut gpui::App| {
        TerminalPool::init_global(cx);
        cx.update_global::<TerminalPool, _>(|pool, cx| pool.create(spawn, cx))
            .map_err(|e| anyhow::anyhow!("{e:#}"))
            .map(|id| serde_json::json!({ "sessionId": id as f64 }))
    }))
    .map_err(host_error)?;
    Ok(value["sessionId"].as_f64().unwrap_or_default())
}

/// Destroy a session: kill the PTY child, drop the model, remove from the
/// pool. Views still bound to it render the placeholder afterwards.
#[napi]
pub fn destroy_terminal_session(session_id: f64) -> Result<()> {
    let id = session_id as u64;
    on_app(Box::new(move |cx: &mut gpui::App| {
        cx.update_global::<TerminalPool, _>(|pool, cx| pool.destroy(id, cx))
            .map_err(|e| anyhow::anyhow!("{e:#}"))
            .map(|_| serde_json::Value::Null)
    }))
    .map_err(host_error)?;
    Ok(())
}
