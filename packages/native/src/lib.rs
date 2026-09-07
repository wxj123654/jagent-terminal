//! @jagent/native — the ONLY cross-language seam (architecture.md §2.3).
//!
//! Exports napi commands (changes here require a seam-protocol reason):
//! - `installTerminalElement()` — register the `<terminal>` element factory
//!   with GPUIX (must run before the renderer is initialized)
//! - `applyWindowAppearance()` — force native chrome to the dark theme
//! - `createTerminalSession(opts) → sessionId`
//! - `destroyTerminalSession(sessionId)`
//! - `onSessionEvent(cb)` — global session events (title/bell/exit)
//! - `notifyDesktop(title, body, sound)` — Windows toast (T2.5)
//! - `pickDirectory(cb)` — native folder picker for add-workspace (W3):
//!   macOS NSOpenPanel (modal on the JS/main thread) / Windows IFileOpenDialog
//!   (detached STA thread); callback `(err, path | null)`.
//!
//! Everything else is protocol mirroring (SpawnOptionsJs / SessionEvent) and
//! host dispatch ([`host`]). Renderer assembly itself stays JS-side
//! (`@gpuix/react` `createRenderer` + `renderer.init()`); Rust sees it only
//! through the process-global UI command channel (see gpuix `run_on_gpuix`).

mod appearance;
mod crash;
mod element;
mod host;
mod notify;
mod panic;
mod picker;

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
use jagent_terminal::terminal_error_code;
use jagent_terminal::{perf, HostPanic, SpawnOptions, TerminalError, TerminalPool};

/// Register the `<terminal>` element factory with GPUIX. Must run before the
/// renderer is initialized (`main.tsx` calls it at startup, before
/// `renderer.init()`). A second call currently pushes another factory; the
/// first `GpuixView` still drains the global table (gpuix 0002).
#[napi]
pub fn install_terminal_element() {
    register_global_factory(Box::new(TerminalElementFactory));
}

/// Match native window chrome to the dark UI (Zed `init_app_appearance`).
/// On macOS this sets `GPUIApplication.appearance` to DarkAqua so traffic-light
/// glyphs use the dark-theme artwork. Prefer letting `renderer.init` do this
/// (after GPUIApplication exists, before the first NSWindow). Calling the
/// stock `NSApplication` class first freezes the AppKit singleton.
/// A no-op on platforms without the override.
#[napi]
pub fn apply_window_appearance() {
    appearance::apply_dark();
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

fn host_error(e: anyhow::Error) -> napi::Error<String> {
    // 错误码映射（docs/error-management.md 方案 B）：稳定 code → JS
    // error.code。TerminalError 优先（typed），HostPanic 其次（panic 收编），
    // 其余 host 链路错误统一 ERR_TERMINAL_HOST。
    if let Some(te) = e.downcast_ref::<TerminalError>() {
        return napi::Error::new(terminal_error_code(te).to_string(), format!("{te}"));
    }
    if let Some(hp) = e.downcast_ref::<HostPanic>() {
        return napi::Error::new("ERR_NATIVE_PANIC".to_string(), format!("{hp}"));
    }
    napi::Error::new("ERR_TERMINAL_HOST".to_string(), format!("{e:#}"))
}

/// Spawn a terminal session: PTY + model + pool registration. Resolves with
/// the sessionId that `<terminal sessionId>` binds to.
///
/// Synchronous on purpose: the test path (run_on_test_app) needs this-thread
/// access to VisualTestState (thread_local), and napi async fns run on the
/// tokio runtime — a different thread. The JS seam keeps its Promise shape
/// via a thin async wrapper at the injection site (main.tsx / e2e).
///
/// Panic 边界（方案 B）：guarded catch_unwind——panic 变 JS throw
/// （code ERR_NATIVE_PANIC），不再终止进程。
#[napi]
pub fn create_terminal_session(opts: Option<SpawnOptionsJs>) -> Result<f64, String> {
    let spawn = to_spawn_options(opts);
    panic::guarded(move || {
        let id = host::run_host(move |cx: &mut gpui::App| {
            TerminalPool::init_global(cx);
            cx.update_global::<TerminalPool, _>(|pool, cx| pool.create(spawn, cx))
                .map_err(|e| anyhow::anyhow!("{e:#}"))
        })
        .map_err(host_error)?;
        Ok(id as f64)
    })
}

/// Destroy a session: kill the PTY child, drop the model, remove from the
/// pool. Views still bound to it render the placeholder afterwards.
/// Unknown id → throw with code ERR_TERMINAL_SESSION_NOT_FOUND.
#[napi]
pub fn destroy_terminal_session(session_id: f64) -> Result<(), String> {
    let id = session_id as u64;
    panic::guarded(move || {
        host::run_host(move |cx: &mut gpui::App| {
            cx.update_global::<TerminalPool, _>(|pool, cx| pool.destroy(id, cx))
                .map_err(|e| anyhow::anyhow!("{e:#}"))
        })
        .map_err(host_error)?;
        Ok(())
    })
}

/// Show a desktop toast (Windows). Fire-and-forget on a detached thread:
/// failures log to stderr and never reject — notifications are a
/// non-critical path (bell → notify, settings.desktop gates the call).
#[napi]
pub fn notify_desktop(title: String, body: String, sound: bool) {
    notify::show(&title, &body, sound);
}

/// Native folder picker (W3). Callback contract mirrors `onSessionEvent`:
/// payload is the SECOND argument — `pickDirectory((_err, path) => ...)`.
/// `path === null` = cancelled / unavailable. On macOS the modal loop runs
/// synchronously on the JS/main thread (the panel pumps AppKit); on Windows
/// it runs on a detached STA thread. The JS side treats this as async (the
/// callback may fire on a later tick in both cases).
#[napi(ts_args_type = "cb: (err: null, path: string | null) => void")]
pub fn pick_directory(cb: ThreadsafeFunction<Option<String>>) {
    picker::pick_directory(Box::new(move |path| {
        cb.call(Ok(path), ThreadsafeFunctionCallMode::NonBlocking);
    }));
}

/// 绘制统计快照（性能 HUD 数据源；docs/perf-analysis.md）。
/// `count`/`totalNs` 为进程生命期累计（调用方差分得速率/均值）；
/// `maxNs` 是自上次调用以来的单次峰值（读后即清）。
/// 直接读无锁原子——不走 GPUI host 通道，任意线程可调。
#[napi(object)]
pub struct PaintPerfJs {
    pub count: f64,
    pub total_ns: f64,
    pub max_ns: f64,
}

#[napi]
pub fn take_paint_perf() -> PaintPerfJs {
    let s = perf::take_paint_perf();
    PaintPerfJs {
        count: s.count as f64,
        total_ns: s.ns_total as f64,
        max_ns: s.ns_max as f64,
    }
}

/// 注册 Rust panic 转发（方案 B 第 4 步）：panic hook → JS 错误总线
/// （level fatal）。TSF 协议同 `onSessionEvent`：payload 是第二个参数。
#[napi(ts_args_type = "cb: (err: null, e: import('./index').NativePanicEvent) => void")]
pub fn on_native_panic(cb: ThreadsafeFunction<panic::NativePanicJs>) {
    panic::set_panic_tsf(cb);
}

/// 安装全局 Rust panic hook（方案 B）：panic.log 落盘 + onNativePanic 转发。
/// `logDir` 传 null 则不写盘（仍转发 TSF）。幂等；建议在 renderer.init
/// 之前调用（越早覆盖面越大）。
#[napi]
pub fn install_native_panic_hook(log_dir: Option<String>) {
    panic::install_hook(log_dir.map(std::path::PathBuf::from));
}
