//! panic.rs — Rust panic 收编（docs/error-management.md 方案 B 第 3/4 步）。
//!
//! 全局 panic hook（进程内只装一次）做四件事，全部尽力而为：
//! 1. 追加 `~/.j-agent/logs/panic.log`（线程/消息/位置）；
//! 2. TSF 通知 JS（`onNativePanic`）→ 错误总线 fatal；
//! 3. `IN_GUARDED` 命中（napi `catch_unwind` 边界内的 panic）→ 不做更多
//!    处理，让 unwind 继续走 `guarded()` 的 catch → JS throw（code
//!    ERR_NATIVE_PANIC）；默认 hook 打印跳过（错误已在 JS 面可见）；
//! 4. 其余 panic（宿主外/后台线程）→ 交回默认 hook（保持终端输出）。
//!    方案 C 会在此分支接管：IPC 通知 sidecar → dump → abort。
//!
//! guarded 边界的 thread-local 标志用 RAII 复位——unwind 期间 Drop 保证
//! 执行，标志不会卡死在线程上。

use std::any::Any;
use std::cell::Cell;
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::OnceLock;

use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

/// JS 面事件（`onNativePanic` TSF payload，两参契约同 `SessionEvent`）。
/// js_name 对齐 SessionEvent 命名（Event 后缀）。
#[napi(object, js_name = "NativePanicEvent")]
pub struct NativePanicJs {
    pub message: String,
    pub thread: String,
    pub location: Option<String>,
}

type PanicTsf = ThreadsafeFunction<NativePanicJs>;

static PANIC_TSF: OnceLock<PanicTsf> = OnceLock::new();
static PANIC_LOG_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
static HOOK_INIT: OnceLock<()> = OnceLock::new();

thread_local! {
    /// `guarded()` 内为 true：panic 会被本地 catch_unwind 拦下转 JS throw，
    /// hook 不应走 dump/abort 分支。
    static IN_GUARDED: Cell<bool> = const { Cell::new(false) };
}

pub(crate) fn is_in_guarded() -> bool {
    IN_GUARDED.with(|g| g.get())
}

struct GuardedFlag;
impl GuardedFlag {
    fn new() -> Self {
        IN_GUARDED.with(|g| g.set(true));
        GuardedFlag
    }
}
impl Drop for GuardedFlag {
    fn drop(&mut self) {
        IN_GUARDED.with(|g| g.set(false));
    }
}

/// 注册 TSF（`on_native_panic` 命令调用；后装的覆盖先装的——测试隔离用）。
pub fn set_panic_tsf(tsf: PanicTsf) {
    let _ = PANIC_TSF.set(tsf);
}

/// 安装全局 panic hook（幂等；log_dir=None 时不写盘）。
pub fn install_hook(log_dir: Option<PathBuf>) {
    let _ = PANIC_LOG_DIR.set(log_dir);
    HOOK_INIT.get_or_init(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let thread = std::thread::current();
            let thread_name = thread.name().unwrap_or("<unnamed>").to_string();
            let message = panic_payload_str(info.payload());
            let location = info.location().map(|l| l.to_string());

            // 尽力写盘/通知——自身失败绝不能再 panic（hook 里再 panic =
            // `failed to initiate panic, error 5` 直接 abort，dump 丢失）。
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                append_panic_log(&thread_name, &message, location.as_deref());
            }));
            if is_in_guarded() {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    notify_js(&message, &thread_name, location.as_deref());
                }));
                return;
            }
            // 方案 C 接管点：crash client 可用 → 发 PANIC 消息后 abort。
            // 不再 notify_js（进程即将死，JS 也救不了；TSF 在 hook 里不安全）。
            if crate::crash::crash_client_ready() {
                crate::crash::forward_panic_to_sidecar(&message, &thread_name, location.as_deref());
                std::process::abort();
            }
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                notify_js(&message, &thread_name, location.as_deref());
            }));
            default(info);
        }));
    });
}

/// panic payload → String（&str / String / 其他）。
pub fn panic_payload_str(payload: &(dyn Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

fn append_panic_log(thread: &str, message: &str, location: Option<&str>) {
    let Some(Some(dir)) = PANIC_LOG_DIR.get().map(|d| d.as_deref()) else {
        return;
    };
    let mut line = String::new();
    let _ = write!(
        line,
        "[{:?}] thread={} message={:?}",
        std::time::SystemTime::now(),
        thread,
        message
    );
    if let Some(loc) = location {
        let _ = write!(line, " location={loc}");
    }
    line.push('\n');
    // 同步追加（panic 场景：进程可能马上死，异步写不可靠）
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("panic.log"))
    {
        let _ = f.write_all(line.as_bytes());
    }
}

fn notify_js(message: &str, thread: &str, location: Option<&str>) {
    if let Some(tsf) = PANIC_TSF.get() {
        tsf.call(
            Ok(NativePanicJs {
                message: message.to_string(),
                thread: thread.to_string(),
                location: location.map(str::to_string),
            }),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }
}

/// napi 同步命令的 panic 防护罩（方案 B 第 2 步，替代裸
/// `#[napi(catch_unwind)]`——需要 thread-local 标志与 hook 分工）。
/// panic → `Err(code=ERR_NATIVE_PANIC)`，JS 侧 throw 可捕获；guard 标志
/// 经 Drop 在 unwind 中可靠复位。
pub(crate) fn guarded<T>(
    f: impl FnOnce() -> std::result::Result<T, napi::Error<String>>,
) -> std::result::Result<T, napi::Error<String>> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _flag = GuardedFlag::new();
        f()
    })) {
        Ok(res) => res,
        Err(payload) => Err(napi::Error::new(
            "ERR_NATIVE_PANIC".to_string(),
            format!("native panic: {}", panic_payload_str(&*payload)),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guarded_catches_panic_and_resets_flag() {
        assert!(!is_in_guarded());
        let out = guarded::<()>(|| panic!("boom inside guard"));
        assert!(out.is_err());
        assert_eq!(out.unwrap_err().status, "ERR_NATIVE_PANIC");
        // Drop 已复位（非 unwind 泄漏）
        assert!(!is_in_guarded());
    }

    #[test]
    fn guarded_passes_through_ok_and_err() {
        assert_eq!(guarded(|| Ok(7)).unwrap(), 7);
        let err = guarded::<u8>(|| Err(napi::Error::new("ERR_X".to_string(), "nope"))).unwrap_err();
        assert_eq!(err.status, "ERR_X");
    }

    #[test]
    fn payload_str_variants() {
        assert_eq!(panic_payload_str(&"static"), "static");
        assert_eq!(panic_payload_str(&String::from("owned")), "owned");
        assert_eq!(panic_payload_str(&42u8), "non-string panic payload");
    }
}
