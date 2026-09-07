//! crash.rs — 进程外崩溃报告（docs/error-management.md 方案 C）。
//!
//! Zed crashes crate 同源技术（EmbarkStudios crash-handling），适配
//! j-agent 的「无独立 exe」形态：**同一入口、两个进程两种角色**——
//!
//! ```text
//! 主进程（app）                          sidecar 子进程
//! ┌────────────────────────┐            ┌──────────────────────────┐
//! │ setup_crash_reporting  │            │ run_crash_monitor        │
//! │  minidumper Client ────────── IPC ─────── minidumper Server     │
//! │  CrashHandler attach   │  socket    │  ServerHandler           │
//! │  panic hook 接管       │            │   dump→crash.json→退出    │
//! └────────────────────────┘            └──────────────────────────┘
//! ```
//!
//! 主进程：HELLO（会话元信息）先发；panic → send_message(PANIC) +
//! `ping()`（ACK：保证 sidecar 先处理 PANIC）再 `abort()`——SIGABRT 被
//! 处理器捕获 → on_crash 回调 send_message(SIGNAL) + `request_dump`
//! （SIGNAL 不覆盖已有 PANIC）→ 默认终止。纯 native 崩溃（SEGV 等）
//! 不走 panic hook，直接进 on_crash。
//!
//! sidecar（独立入口 `scripts/crash-handler.ts` / `--crash-handler`）：收到 dump
//! 请求 → 写 .dmp + crash.json（HELLO + 最后 PANIC/SIGNAL 信息）→ 清理
//! 超额旧 dump → server loop 退出 → TSF 通知 JS 退出进程。
//!
//! 降级：sidecar 起不来 / IPC 连不上 → setup 返回 false，panic hook 仍装
//! （panic.log 留痕），只是无 dump。
//!
//! 平台注：macOS 上 minidumper 的 IPC 同时走 UDS（消息）与 mach port
//! （dump 请求，CrashContext 经 task port 传递）；SocketName::Path 两用。
//! **mach port 名不能含 `/`**（CString 直接当 port 名）——JS 侧传进来
//! 的 socket_path 必须是合法 mach 名（例 `jagent.crash.<pid>`），不能是
//! 目录路径。Linux/Windows 可以是真路径。

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use minidumper::ServerHandler;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

/// 应用层消息 kind（client → server；u32 首字段）
mod msg_kind {
    pub const HELLO: u32 = 1;
    pub const PANIC: u32 = 2;
    pub const SIGNAL: u32 = 3;
}

static CRASH_CLIENT: OnceLock<Option<Arc<minidumper::Client>>> = OnceLock::new();

/// 已安装 crash 处理器且 IPC 可达（panic hook 的 abort 分支用；pub(crate)
/// 供 panic.rs 查询）。
pub(crate) fn crash_client_ready() -> bool {
    CRASH_CLIENT.get().is_some_and(|c| c.is_some())
}

/// panic hook 的 C 接管分支（panic.rs 调用）：发 PANIC 消息后由调用方
/// `abort()`——dump 由 SIGABRT 的 on_crash 回调完成（统一上下文路径）。
pub(crate) fn forward_panic_to_sidecar(message: &str, thread: &str, location: Option<&str>) {
    let Some(Some(client)) = CRASH_CLIENT.get() else {
        return;
    };
    // 手写 JSON、栈缓冲：panic hook 里 serde_json / format! 分配可能再炸
    // （实测 `failed to initiate panic, error 5`）。字段做最小转义。
    let mut buf = String::with_capacity(256);
    buf.push('{');
    buf.push_str("\"message\":\"");
    json_escape_into(&mut buf, message);
    buf.push_str("\",\"thread\":\"");
    json_escape_into(&mut buf, thread);
    buf.push_str("\",\"location\":");
    if let Some(loc) = location {
        buf.push('"');
        json_escape_into(&mut buf, loc);
        buf.push('"');
    } else {
        buf.push_str("null");
    }
    buf.push('}');
    let _ = client.send_message(msg_kind::PANIC, buf.as_bytes());
    // ping 有 ACK：同一 socket 顺序保证 server 先处理完 PANIC 再回 PONG。
    // 否则 abort 太快会丢掉还在内核缓冲里的 PANIC（实测 crash.json.kind=signal）。
    let _ = client.ping();
}

fn json_escape_into(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
}

#[napi(object)]
pub struct CrashReportingOptionsJs {
    /// IPC socket 路径（macOS/Linux 为 UDS 路径，Windows 由 minidumper
    /// 映射为 named pipe）。调用方保证唯一（app 用 crash-<pid>.sock）。
    pub socket_path: String,
    /// dump 与 crash.json 的目录（~/.j-agent/crashes）。
    pub dump_dir: String,
    /// 会话 id（app 启动时生成；写进 crash.json）。
    pub session_id: String,
    /// 应用版本（写进 crash.json）。
    pub app_version: String,
}

/// 主进程装配：连接 sidecar → 安装 crash 处理器 → 发 HELLO。
/// 返回 false = sidecar 不可达（降级：panic hook 照装、无 dump）。
#[napi]
pub fn setup_crash_reporting(opts: CrashReportingOptionsJs) -> bool {
    let client =
        match minidumper::Client::with_name(minidumper::SocketName::path(&opts.socket_path)) {
            Ok(c) => Arc::new(c),
            Err(_) => {
                let _ = CRASH_CLIENT.set(None);
                return false;
            }
        };

    // 崩溃处理器：send SIGNAL 消息 + 请求 dump → 返回 false（走默认行为，
    // 进程以崩溃码终止）。回调处于受损上下文：只做小 payload 发送与
    // request_dump（minidumper 信号安全设计内）。
    let cb_client = client.clone();
    // SAFETY: 回调只调用 minidumper Client 的 send_message/request_dump
    // （信号安全面）；不做分配以外的复合操作。payload 栈上小格式化。
    let event = unsafe {
        crash_handler::make_crash_event(move |ctx: &crash_handler::CrashContext| {
            // SIGNAL 仅作兜底（纯 native 崩溃无 PANIC 消息）；sidecar 侧
            // 已有 PANIC 时不会被这条覆盖。payload 固定、栈上、无分配。
            let _ = cb_client.send_message(msg_kind::SIGNAL, b"{\"signal\":0}".as_slice());
            let _ = cb_client.request_dump(ctx);
            false.into()
        })
    };
    match crash_handler::CrashHandler::attach(event) {
        Ok(handler) => std::mem::forget(handler), // 进程生命期持有
        Err(_) => {
            let _ = CRASH_CLIENT.set(None);
            return false;
        }
    }

    // HELLO：会话元信息（sidecar 存内存，dump 时写 crash.json）
    let hello = serde_json::json!({
        "sessionId": opts.session_id,
        "appVersion": opts.app_version,
        "pid": std::process::id(),
    });
    let hello_ok = client
        .send_message(msg_kind::HELLO, hello.to_string())
        .is_ok();
    let _ = CRASH_CLIENT.set(Some(client));
    hello_ok
}

// ── sidecar 面 ───────────────────────────────────────────────────────────

#[napi(object)]
pub struct CrashMonitorOptionsJs {
    pub socket_path: String,
    pub dump_dir: String,
    /// 保留的 .dmp 上限（含新写的；超出删最旧）。默认 5。
    pub max_dumps: Option<f64>,
}

/// monitor 结束原因（TSF payload；reason: 'dumped' | 'error'）。
#[napi(object, js_name = "CrashMonitorDone")]
pub struct CrashMonitorDoneJs {
    pub reason: String,
    pub detail: Option<String>,
}

#[derive(Default)]
struct MonitorState {
    hello: Mutex<Option<serde_json::Value>>,
    last_event: Mutex<Option<(u32, serde_json::Value)>>,
}

struct MonitorHandler {
    state: Arc<MonitorState>,
    dump_dir: PathBuf,
    max_dumps: usize,
}

impl ServerHandler for MonitorHandler {
    fn create_minidump_file(&self) -> Result<(fs::File, PathBuf), std::io::Error> {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        fs::create_dir_all(&self.dump_dir)?;
        let path = self.dump_dir.join(format!("jagent-{ts}.dmp"));
        let file = fs::File::create(&path)?;
        Ok((file, path))
    }

    fn on_minidump_created(
        &self,
        result: Result<minidumper::MinidumpBinary, minidumper::Error>,
    ) -> minidumper::LoopAction {
        match result {
            Ok(bin) => {
                self.write_crash_json(&bin.path);
                self.prune_old_dumps();
            }
            Err(e) => {
                eprintln!("[jagent-crash-monitor] dump failed: {e}");
            }
        }
        // sidecar 生命周期 = 等一个 dump；写完即退
        minidumper::LoopAction::Exit
    }

    fn on_message(&self, kind: u32, buffer: Vec<u8>) {
        let Ok(text) = String::from_utf8(buffer) else {
            return;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            return;
        };
        match kind {
            msg_kind::HELLO => *self.state.hello.lock().unwrap() = Some(value),
            msg_kind::PANIC => {
                // PANIC 永远覆盖：abort 产生的 SIGABRT 会再发一条 SIGNAL，
                // 不能把 panic 消息盖掉（crash.json.kind 必须是 panic）。
                *self.state.last_event.lock().unwrap() = Some((kind, value))
            }
            msg_kind::SIGNAL => {
                let mut slot = self.state.last_event.lock().unwrap();
                if slot.as_ref().is_none_or(|(k, _)| *k != msg_kind::PANIC) {
                    *slot = Some((kind, value));
                }
            }
            _ => {}
        }
    }
}

impl MonitorHandler {
    fn write_crash_json(&self, dump_path: &std::path::Path) {
        let (kind, event) = self
            .state
            .last_event
            .lock()
            .unwrap()
            .clone()
            .unwrap_or((msg_kind::SIGNAL, serde_json::json!({})));
        let mut doc = serde_json::json!({
            "schema": "jagent.crash.v1",
            "at": SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            "kind": if kind == msg_kind::PANIC { "panic" } else { "signal" },
            "message": event.get("message").and_then(|v| v.as_str()).unwrap_or(""),
            "location": event.get("location").and_then(|v| v.as_str()),
            "thread": event.get("thread").and_then(|v| v.as_str()).unwrap_or(""),
            "dumpPath": dump_path.to_string_lossy(),
        });
        if let Some(hello) = self.state.hello.lock().unwrap().clone() {
            for key in ["sessionId", "appVersion", "pid"] {
                if let Some(v) = hello.get(key) {
                    doc[key] = v.clone();
                }
            }
        }
        if let Err(e) = fs::write(
            self.dump_dir.join("crash.json"),
            serde_json::to_vec_pretty(&doc).unwrap_or_default(),
        ) {
            eprintln!("[jagent-crash-monitor] crash.json write failed: {e}");
        }
    }

    fn prune_old_dumps(&self) {
        let Ok(entries) = fs::read_dir(&self.dump_dir) else {
            return;
        };
        let mut dumps: Vec<(SystemTime, PathBuf)> = entries
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "dmp"))
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                Some((meta.modified().ok()?, e.path()))
            })
            .collect();
        if dumps.len() <= self.max_dumps {
            return;
        }
        dumps.sort_by_key(|(t, _)| *t);
        let excess = dumps.len() - self.max_dumps;
        for (_, path) in dumps.into_iter().take(excess) {
            let _ = fs::remove_file(path);
        }
    }
}

/// sidecar 装配：启动 minidumper Server（后台线程）等待主进程崩溃请求。
/// dump 完成/失败 → TSF 回调（JS 侧 process.exit）。返回 false = socket
/// 绑定失败（主进程会因连不上而降级）。JS 侧 stdin EOF 时直接 exit。
#[napi(
    ts_args_type = "opts: CrashMonitorOptionsJs, onDone: (err: null, e: import('./index').CrashMonitorDone) => void"
)]
pub fn run_crash_monitor(
    opts: CrashMonitorOptionsJs,
    on_done: ThreadsafeFunction<CrashMonitorDoneJs>,
) -> bool {
    let socket_path = opts.socket_path.clone();
    let socket = PathBuf::from(&socket_path);
    let dump_dir = PathBuf::from(opts.dump_dir);
    if let Err(e) = fs::create_dir_all(&dump_dir) {
        eprintln!("[jagent-crash-monitor] dump dir unavailable: {e}");
        return false;
    }
    let handler = Arc::new(MonitorHandler {
        state: Arc::new(MonitorState::default()),
        dump_dir,
        max_dumps: opts.max_dumps.map(|v| v as usize).unwrap_or(5),
    });

    let server = match minidumper::Server::with_name(minidumper::SocketName::path(&socket_path)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[jagent-crash-monitor] bind failed: {e}");
            return false;
        }
    };

    // run 阻塞至 Exit（dump 完成/失败）——后台线程跑，TSF 回调通知 JS。
    // shutdown 恒 false（不主动停）；stale_timeout None（主进程不 ping，
    // 靠 JS 侧 stdin EOF / dump 完成退出）。
    std::thread::spawn(move || {
        let mut server = server;
        let shutdown = AtomicBool::new(false);
        let result = server.run(Box::new(ArcUnwrapHandler(handler)), &shutdown, None);
        let (reason, detail) = match result {
            Ok(()) => ("dumped".to_string(), None),
            Err(e) => ("error".to_string(), Some(format!("{e}"))),
        };
        // socket 文件清理（macOS/Linux UDS；server Drop 亦处理，双保险）
        let _ = fs::remove_file(&socket);
        on_done.call(
            Ok(CrashMonitorDoneJs { reason, detail }),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    });
    true
}

/// Arc<MonitorHandler> → Box<dyn ServerHandler>（run 收 Box；Arc 解包）。
struct ArcUnwrapHandler(Arc<MonitorHandler>);
impl ServerHandler for ArcUnwrapHandler {
    fn create_minidump_file(&self) -> Result<(fs::File, PathBuf), std::io::Error> {
        self.0.create_minidump_file()
    }
    fn on_minidump_created(
        &self,
        result: Result<minidumper::MinidumpBinary, minidumper::Error>,
    ) -> minidumper::LoopAction {
        self.0.on_minidump_created(result)
    }
    fn on_message(&self, kind: u32, buffer: Vec<u8>) {
        self.0.on_message(kind, buffer)
    }
}

// ── 调试触发（test-support 构建限定；e2e/手动验证崩溃链路用） ───────────

/// 触发真实崩溃验证报告链路。仅 test-support feature 构建导出。
/// kind: "panic"（Rust panic → hook → abort）| "sigsegv"（native 段错误）。
#[cfg(feature = "test-support")]
#[napi]
pub fn debug_trigger_crash(kind: String) {
    match kind.as_str() {
        "panic" => {
            // 裸 panic（不经 guarded）：hook 接管——发 PANIC 消息 + abort
            panic!("debug panic (jagent crash-reporting verification)");
        }
        "sigsegv" => {
            // volatile null 写：不被优化删除，产生 EXC_BAD_ACCESS/SIGSEGV
            // → on_crash 回调（纯 native 崩溃路径）
            unsafe { std::ptr::write_volatile(std::ptr::null_mut::<u8>(), 0) }
        }
        _ => {}
    }
}
