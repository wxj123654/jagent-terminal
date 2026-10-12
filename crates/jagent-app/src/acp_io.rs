//! ACP 子进程 IO（P4）：spawn agent → 握手 → session/new → session/prompt，逐行读 stdout。
//!
//! 协议编解码与 turn 收集在 `jagent_core::acp`（纯函数，已测）；这里只负责进程与管道。
//! 进程 IO 放在后台线程（`std::process`），结果经 channel 回到前台（与 git 流一致）。

use futures::channel::mpsc::UnboundedSender;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, channel};

use jagent_core::acp::{
    Incoming, TurnCollector, check_initialize, encode_request, initialize_params, parse_line,
    prompt_params, reply_to_agent_request, session_id_of,
};
use serde_json::Value;

/// 一个已握手的 ACP 连接（一个 thread 一条）。
pub struct AcpConnection {
    /// Child ownership moves into `process`, allowing a separate disposer to kill it during a turn.
    process: std::sync::Arc<std::sync::Mutex<Child>>,
    stdin: ChildStdin,
    session_id: String,
    next_id: u64,
    /// stdout 读线程送来的入站消息
    rx: Receiver<Incoming>,
}

#[derive(Debug)]
pub enum AcpError {
    Spawn(String),
    Protocol(String),
    Io(String),
}

impl std::fmt::Display for AcpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(e) => write!(f, "无法启动 agent：{e}"),
            Self::Protocol(e) => write!(f, "ACP 协议错误：{e}"),
            Self::Io(e) => write!(f, "ACP 管道错误：{e}"),
        }
    }
}

impl std::error::Error for AcpError {}

impl AcpConnection {
    /// 起子进程并完成握手（initialize → session/new）。阻塞直到握手完成或失败，应在后台线程调用。
    pub fn connect(
        command: &str,
        args: &[String],
        cwd: &std::path::Path,
    ) -> Result<Self, AcpError> {
        Self::connect_with_disposer(command, args, cwd, |_| {})
    }

    /// Like `connect`, but publishes a kill handle immediately after spawn, before handshake waits.
    pub fn connect_with_disposer(
        command: &str,
        args: &[String],
        cwd: &std::path::Path,
        on_spawn: impl FnOnce(AcpDisposer),
    ) -> Result<Self, AcpError> {
        let mut child = Command::new(command)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| AcpError::Spawn(format!("{command}: {e}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AcpError::Io("无 stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AcpError::Io("无 stdout".into()))?;
        let process = std::sync::Arc::new(std::sync::Mutex::new(child));
        on_spawn(AcpDisposer(process.clone()));
        let (tx, rx) = channel::<Incoming>();
        std::thread::spawn(move || read_lines(stdout, tx));

        let mut conn = Self {
            process,
            stdin,
            session_id: String::new(),
            next_id: 1,
            rx,
        };
        let init = conn.request(
            "initialize",
            &initialize_params("j-agent", env!("CARGO_PKG_VERSION")),
        )?;
        check_initialize(&init).map_err(AcpError::Protocol)?;
        let cwd_s = cwd.to_string_lossy().into_owned();
        let session = conn.request(
            "session/new",
            &serde_json::json!({ "cwd": cwd_s, "mcpServers": [] }),
        )?;
        conn.session_id = session_id_of(&session).map_err(AcpError::Protocol)?;
        Ok(conn)
    }

    /// 发一条请求并等待它的响应；等待期间收到的 agent 请求按协议自动应答。
    fn request(&mut self, method: &str, params: &Value) -> Result<Value, AcpError> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(&encode_request(id, method, params))?;
        loop {
            match self
                .rx
                .recv()
                .map_err(|_| AcpError::Io(format!("agent 已退出（等待 {method}）")))?
            {
                Incoming::Response { id: rid, result } if rid == id => {
                    return result.map_err(AcpError::Protocol);
                }
                Incoming::Request { id, method, params } => {
                    let line = reply_to_agent_request(id, &method, &params);
                    self.write(&line)?;
                }
                // 握手期间的通知与无关响应忽略
                _ => {}
            }
        }
    }

    fn write(&mut self, line: &str) -> Result<(), AcpError> {
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|()| self.stdin.flush())
            .map_err(|e| AcpError::Io(e.to_string()))
    }

    /// A cheap handle that can dispose the child while this connection is temporarily moved into a background task.
    pub fn disposer(&self) -> AcpDisposer {
        AcpDisposer(self.process.clone())
    }

    /// 发一轮 prompt，阻塞直到 `session/prompt` 响应，返回定稿文本。应在后台线程调用。
    pub fn prompt(
        &mut self,
        text: &str,
        chunks: UnboundedSender<String>,
    ) -> Result<String, AcpError> {
        let session_id = self.session_id.clone();
        let id = self.next_id;
        self.next_id += 1;
        self.write(&encode_request(
            id,
            "session/prompt",
            &prompt_params(&session_id, text),
        ))?;
        let mut turn = TurnCollector::default();
        loop {
            match self
                .rx
                .recv()
                .map_err(|_| AcpError::Io("agent 已退出（等待回复）".into()))?
            {
                Incoming::Notification { method, params } if method == "session/update" => {
                    if let Some(u) = params.get("update") {
                        turn.on_update(u);
                        let _ = chunks.unbounded_send(turn.text_snapshot());
                    }
                }
                Incoming::Response { id: rid, result } if rid == id => {
                    let v = result.map_err(AcpError::Protocol)?;
                    let stop = v
                        .get("stopReason")
                        .and_then(Value::as_str)
                        .unwrap_or("end_turn");
                    return Ok(turn.assemble(stop));
                }
                Incoming::Request { id, method, params } => {
                    let line = reply_to_agent_request(id, &method, &params);
                    self.write(&line)?;
                }
                _ => {}
            }
        }
    }
}

#[derive(Clone)]
pub struct AcpDisposer(std::sync::Arc<std::sync::Mutex<Child>>);
impl AcpDisposer {
    pub fn terminate(&self) {
        if let Ok(mut child) = self.0.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    pub fn is_running(&self) -> bool {
        self.0
            .lock()
            .is_ok_and(|mut child| child.try_wait().ok().flatten().is_none())
    }
}
impl Drop for AcpConnection {
    fn drop(&mut self) {
        AcpDisposer(self.process.clone()).terminate();
    }
}

#[derive(Default)]
struct CancellationState {
    cancelled: bool,
    disposer: Option<AcpDisposer>,
}

/// Registered before spawn, so closing a thread races safely with process creation/handshake.
/// Either `cancel` sees the published disposer, or the late `register` sees `cancelled` and
/// kills it immediately; there is no window in which the child can escape disposal.
#[derive(Clone, Default)]
pub struct AcpCancellation(std::sync::Arc<std::sync::Mutex<CancellationState>>);
impl AcpCancellation {
    pub fn register(&self, disposer: AcpDisposer) {
        let terminate = if let Ok(mut state) = self.0.lock() {
            if state.cancelled {
                true
            } else {
                state.disposer = Some(disposer.clone());
                false
            }
        } else {
            true
        };
        if terminate {
            disposer.terminate();
        }
    }

    pub fn cancel(&self) {
        let disposer = if let Ok(mut state) = self.0.lock() {
            state.cancelled = true;
            state.disposer.take()
        } else {
            None
        };
        if let Some(disposer) = disposer {
            disposer.terminate();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.lock().map(|state| state.cancelled).unwrap_or(true)
    }
}

/// 后台读线程：逐行解析 stdout，送入 channel；EOF 或管道断开即结束（接收端随之得到 `RecvError`）。
fn read_lines(stdout: std::process::ChildStdout, tx: Sender<Incoming>) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if let Some(msg) = parse_line(&line)
            && tx.send(msg).is_err()
        {
            break;
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use futures::StreamExt as _;

    /// 一个最小的假 ACP agent（shell 脚本）：握手 → 对 prompt 回一条 message_chunk 再结束。
    /// 只在 unix 跑；Windows 的 IO 测试登记到未验证清单。
    #[cfg(unix)]
    pub(crate) fn fake_agent_script(dir: &std::path::Path) -> std::path::PathBuf {
        fake_agent_script_with_env(dir, false)
    }

    #[cfg(unix)]
    fn fake_agent_script_with_env(dir: &std::path::Path, blocking: bool) -> std::path::PathBuf {
        let p = dir.join("fake-agent.sh");
        let script = r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}' ;;
    *'"method":"session/new"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s-1"}}' ;;
    *'"method":"session/prompt"'*)
      if [ "__BLOCK_PROMPT__" = "1" ]; then
        echo started >&2
        while IFS= read -r _; do :; done
      fi
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello "}}}}'
      sleep 0.05
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"from fake"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}' ;;
  esac
done
"#;
        let script = script.replace("__BLOCK_PROMPT__", if blocking { "1" } else { "0" });
        std::fs::write(&p, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    #[cfg(unix)]
    #[test]
    fn closing_during_blocked_initialize_kills_child_and_unblocks_connect() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("initialize-blocked");
        let script_path = dir.path().join("blocked-agent.sh");
        std::fs::write(
            &script_path,
            format!(
                "#!/bin/sh\nwhile IFS= read -r line; do\n  case \"$line\" in\n    *initialize*) touch '{}'; while IFS= read -r _; do :; done ;;\n  esac\ndone\n",
                marker.display()
            ),
        ).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cancellation = AcpCancellation::default();
        let callback_cancel = cancellation.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let script = script_path.to_string_lossy().into_owned();
        let cwd = dir.path().to_path_buf();
        let connector = std::thread::spawn(move || {
            AcpConnection::connect_with_disposer(&script, &[], &cwd, move |disposer| {
                callback_cancel.register(disposer.clone());
                tx.send(disposer).unwrap();
            })
        });
        let disposer = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("disposer published before initialize wait");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !marker.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            marker.exists(),
            "agent reached deliberately blocked initialize"
        );
        cancellation.cancel();
        assert!(
            connector.join().unwrap().is_err(),
            "kill releases blocking handshake read"
        );
        assert!(!disposer.is_running(), "disposer kills and reaps the agent");
    }

    #[cfg(unix)]
    #[test]
    fn close_before_disposer_registration_kills_the_late_process() {
        let dir = tempfile::tempdir().unwrap();
        let script = fake_agent_script(dir.path());
        let child = Command::new(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let token = AcpCancellation::default();
        token.cancel();
        let shared = std::sync::Arc::new(std::sync::Mutex::new(child));
        token.register(AcpDisposer(shared.clone()));
        assert!(token.is_cancelled());
        assert!(
            shared.lock().unwrap().try_wait().unwrap().is_some(),
            "late child must be killed immediately"
        );
    }

    #[cfg(unix)]
    #[test]
    fn disposing_an_in_flight_prompt_terminates_its_child() {
        let dir = tempfile::tempdir().unwrap();
        let script = fake_agent_script_with_env(dir.path(), true);
        let mut child = Command::new(&script)
            .current_dir(dir.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let process = std::sync::Arc::new(std::sync::Mutex::new(child));
        let (tx, rx) = channel();
        std::thread::spawn(move || read_lines(stdout, tx));
        let mut conn = AcpConnection {
            process,
            stdin,
            session_id: String::new(),
            next_id: 1,
            rx,
        };
        let init = conn
            .request("initialize", &initialize_params("test", "0"))
            .unwrap();
        check_initialize(&init).unwrap();
        let session = conn
            .request(
                "session/new",
                &serde_json::json!({"cwd":dir.path().to_string_lossy(),"mcpServers":[]}),
            )
            .unwrap();
        conn.session_id = session_id_of(&session).unwrap();
        assert_eq!(conn.session_id, "s-1");
        let disposer = conn.disposer();
        let (chunks, _rx) = futures::channel::mpsc::unbounded();
        let prompt = std::thread::spawn(move || conn.prompt("blocked", chunks));
        std::thread::sleep(std::time::Duration::from_millis(100));
        disposer.terminate();
        assert!(
            prompt.join().unwrap().is_err(),
            "closing the owner terminates blocked ACP IO"
        );
        assert!(!disposer.is_running());
    }

    #[cfg(unix)]
    #[test]
    fn a_fake_agent_completes_handshake_and_one_prompt_turn() {
        let dir = tempfile::tempdir().unwrap();
        let script = fake_agent_script(dir.path());
        let mut conn =
            AcpConnection::connect(script.to_str().unwrap(), &[], dir.path()).expect("握手");
        assert_eq!(conn.session_id, "s-1");
        let (tx, mut rx) = futures::channel::mpsc::unbounded();
        let reply = conn.prompt("hi", tx).expect("一轮");
        assert_eq!(reply, "hello from fake");
        assert_eq!(
            futures::executor::block_on(rx.next()).unwrap(),
            "hello ",
            "首个 chunk 即时推送"
        );
        assert_eq!(
            futures::executor::block_on(rx.next()).unwrap(),
            "hello from fake",
            "第二个 chunk 是累积快照"
        );
    }

    #[test]
    fn a_missing_agent_command_is_a_spawn_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        match AcpConnection::connect("definitely-not-a-real-agent-xyz", &[], dir.path()) {
            Err(AcpError::Spawn(_)) => {}
            Err(e) => panic!("应为 Spawn 错误：{e}"),
            Ok(_) => panic!("不应握手成功"),
        }
    }
}
