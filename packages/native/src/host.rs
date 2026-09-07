//! host.rs — dispatch closures to the GPUI host (app context).
//!
//! One interface, two adapters:
//! - threaded host channel (real renderer: `run_on_gpuix`, gpuix patch #4)
//! - test renderer's thread-local state (e2e: `run_on_test_app`, gpuix
//!   patch #6)
//!
//! Both channel signatures are locked to `serde_json::Value` by gpuix, so
//! the typed↔JSON boxing happens exactly here, once, at the channel
//! boundary — command functions in lib.rs stay generic over `T`.

use serde::Serialize;
use serde::de::DeserializeOwned;

use jagent_terminal::HostPanic;

/// Run `f` with GPUI app access and return its typed result. Picks the
/// threaded host channel when the real renderer is live, otherwise falls
/// back to the test renderer's thread-local state (e2e).
///
/// Panic safety (docs/error-management.md 方案 B 第 3 步): the closure is
/// wrapped in `catch_unwind` so a panic inside host code cannot abort the
/// GPUI thread / kill the process — it degrades into a typed error the napi
/// layer maps to `ERR_NATIVE_PANIC`. The global panic hook (panic.rs) has
/// already logged/notified by the time we catch. CAVEAT: after a caught
/// panic the GPUI `App` may be in a dirty state; the session involved must
/// be treated as unreliable (subsequent host ops may fail).
pub(crate) fn run_host<T>(
    f: impl FnOnce(&mut gpui::App) -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T>
where
    T: Serialize + DeserializeOwned + Send + 'static,
{
    let boxed = Box::new(move |cx: &mut gpui::App| {
        // AssertUnwindSafe: &mut App is not unwind-safe by construction; we
        // accept the dirty-state risk — the alternative (thread abort) is
        // strictly worse. The error propagates to JS instead.
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(cx))) {
            Ok(res) => res.and_then(|t| serde_json::to_value(&t).map_err(|e| anyhow::anyhow!(e))),
            Err(payload) => Err(anyhow::Error::new(HostPanic(
                crate::panic::panic_payload_str(&payload),
            ))),
        }
    });
    let json = dispatch(boxed)?;
    serde_json::from_value(json).map_err(|e| anyhow::anyhow!("host response decode failed: {e}"))
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "freebsd"))]
fn dispatch(
    f: Box<dyn FnOnce(&mut gpui::App) -> anyhow::Result<serde_json::Value> + Send>,
) -> anyhow::Result<serde_json::Value> {
    use gpuix_native::{host_ui_commands_ready, run_on_gpuix};
    if host_ui_commands_ready() {
        run_on_gpuix(Box::new(move |cx, _window| {
            cx.update(|cx: &mut gpui::App| f(cx))
                .map_err(|e: anyhow::Error| anyhow::anyhow!("{e:#}"))
        }))
    } else {
        // No threaded renderer: e2e under TestGpuixRenderer. Its host seam
        // exists on Windows and macOS builds (gpuix test_renderer cfg).
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            gpuix_native::run_on_test_app(f)
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let _ = f;
            Err(anyhow::anyhow!(
                "no GPUI host available (no threaded renderer, no test renderer)",
            ))
        }
    }
}

// macOS: no GPUI thread — tick() pumps AppKit on the JS main thread, and
// napi sync commands run on that same thread, so host closures execute
// inline through gpuix's thread-local ApplicationHandle (between ticks,
// never re-entrant). Same fallback as Windows: e2e without a real renderer
// lands on run_on_test_app (TestGpuixRenderer's VisualTestState).
#[cfg(target_os = "macos")]
fn dispatch(
    f: Box<dyn FnOnce(&mut gpui::App) -> anyhow::Result<serde_json::Value> + Send>,
) -> anyhow::Result<serde_json::Value> {
    use gpuix_native::{host_ui_commands_ready, run_on_gpuix};
    if host_ui_commands_ready() {
        run_on_gpuix(f)
    } else {
        gpuix_native::run_on_test_app(f)
    }
}

#[cfg(not(any(
    target_os = "windows",
    target_os = "linux",
    target_os = "freebsd",
    target_os = "macos",
)))]
fn dispatch(
    f: Box<dyn FnOnce(&mut gpui::App) -> anyhow::Result<serde_json::Value> + Send>,
) -> anyhow::Result<serde_json::Value> {
    let _ = f;
    Err(anyhow::anyhow!(
        "terminal sessions are unsupported on this platform",
    ))
}
