//! ACP 子进程 IO（P4）：spawn agent → 握手 → session/new → session/prompt，逐行读 stdout。
//!
//! 协议编解码与 turn 收集在 `jagent_core::acp`（纯函数，已测）；这里只负责进程与管道。
//! 进程 IO 放在后台线程（`std::process`），结果经 channel 回到前台（与 git 流一致）。

use futures::channel::mpsc::UnboundedSender;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, channel};

use jagent_core::acp::{
    AcpCommand, AcpConfigSelector, AcpConfigSource, AcpSessionSummary, Incoming, ReplayedMessage,
    SessionLoadCollector, TurnCollector, builtin_acp_commands, check_initialize, encode_request,
    initialize_params, list_sessions_params, load_session_params, merge_acp_commands,
    parse_commands_from_startup_info, parse_line, parse_session_config_selectors,
    parse_session_list, parse_session_startup_info, prompt_params, reply_to_agent_request,
    session_id_of, set_config_option_params, set_mode_params, set_model_params,
};
use jagent_core::threads::ToolCallTrace;
use serde_json::Value;

/// 流式或定稿的 ACP 轮次快照（正文 + 工具调用列表 + 可选配置项变更 + 可选命令列表变更）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AcpTurnUpdate {
    pub text: String,
    pub tool_calls: Vec<ToolCallTrace>,
    pub config_selectors: Option<Vec<AcpConfigSelector>>,
    pub available_commands: Option<Vec<AcpCommand>>,
}

/// 一个已握手的 ACP 连接（一个 thread 一条）。
pub struct AcpConnection {
    /// Child ownership moves into `process`, allowing a separate disposer to kill it during a turn.
    process: std::sync::Arc<std::sync::Mutex<Child>>,
    stdin: ChildStdin,
    session_id: String,
    next_id: u64,
    /// stdout 读线程送来的入站消息
    rx: Receiver<Incoming>,
    /// 当前会话暴露的配置项选择器（Model / Thinking / Mode）
    pub config_selectors: Vec<AcpConfigSelector>,
    /// 当前会话暴露的斜杠命令列表
    pub available_commands: Vec<AcpCommand>,
    /// `session/new` 返回的启动欢迎信息（如 `pi-acp` 的 `pi vX.Y.Z`、Context、Skills、Extensions 摘要）
    pub startup_info: Option<String>,
    /// 若通过 `session/load` 建立连接，保存回放还原出的历史消息列表
    pub replayed_messages: Vec<ReplayedMessage>,
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

/// 在给定 `PATH` 字符串中解析裸命令名为可执行文件绝对路径。
fn find_in_path_os(command: &str, paths: &std::ffi::OsStr) -> Option<std::path::PathBuf> {
    for dir in std::env::split_paths(paths) {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// 缓存合并了用户 login shell 的 PATH（解决 macOS GUI LaunchServices 启动时 PATH 只有 `/usr/bin:/bin`
/// 导致找不到 fnm/nvm/homebrew 下的 `pi-acp`、`node`、`pi`、`codex` 等命令的问题）。
fn merged_user_path() -> Option<std::ffi::OsString> {
    static CACHED: std::sync::OnceLock<Option<std::ffi::OsString>> = std::sync::OnceLock::new();
    CACHED
        .get_or_init(|| {
            let mut dirs: Vec<std::path::PathBuf> = Vec::new();
            let mut push_unique = |p: std::path::PathBuf| {
                if !p.as_os_str().is_empty() && !dirs.contains(&p) {
                    dirs.push(p);
                }
            };

            if let Some(cur) = std::env::var_os("PATH") {
                for p in std::env::split_paths(&cur) {
                    push_unique(p);
                }
            }

            #[cfg(all(unix, not(test)))]
            {
                let shell = std::env::var("SHELL")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| "/bin/zsh".to_owned());
                if let Ok(out) = Command::new(&shell)
                    .args(["-lc", "printf '__JAGENT_PATH__=%s' \"$PATH\""])
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .output()
                {
                    let s = String::from_utf8_lossy(&out.stdout);
                    if let Some((_, path_part)) = s.rsplit_once("__JAGENT_PATH__=") {
                        for p in std::env::split_paths(path_part.trim()) {
                            push_unique(p);
                        }
                    }
                }
            }

            std::env::join_paths(dirs.iter()).ok()
        })
        .clone()
}

/// 解析 `command` 为可执行文件路径与子进程 `PATH`：
/// - 若 `command` 含路径分隔符（如 `/tmp/.../fake-agent.sh`），直接原样使用且不触发 login shell 探测；
/// - 若当前进程 `PATH` 已能找到该命令，直接返回该绝对路径与当前 `PATH`；
/// - 否则合并 login shell `PATH` 再查找。
fn resolve_command_and_path(command: &str) -> (std::path::PathBuf, Option<std::ffi::OsString>) {
    let p = std::path::Path::new(command);
    let cur_path = std::env::var_os("PATH");
    if p.components().count() > 1 {
        return (p.to_path_buf(), cur_path);
    }
    if let Some(cur) = &cur_path
        && let Some(found) = find_in_path_os(command, cur)
    {
        return (found, cur_path);
    }
    let merged = merged_user_path();
    if let Some(paths) = &merged
        && let Some(found) = find_in_path_os(command, paths)
    {
        return (found, merged);
    }
    (p.to_path_buf(), merged)
}

#[cfg(test)]
const ACP_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
#[cfg(not(test))]
const ACP_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

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
        Self::connect_or_load_with_disposer(command, args, cwd, None, on_spawn)
    }

    /// 起子进程并完成握手：若提供 `resume_session_id` 则优先调用 `session/load` 恢复历史会话，
    /// 若未提供或 `session/load` 失败则自动回退到 `session/new`。
    pub fn connect_or_load_with_disposer(
        command: &str,
        args: &[String],
        cwd: &std::path::Path,
        resume_session_id: Option<&str>,
        on_spawn: impl FnOnce(AcpDisposer),
    ) -> Result<Self, AcpError> {
        let (resolved_cmd, merged_path) = resolve_command_and_path(command);
        let mut cmd = Command::new(&resolved_cmd);
        cmd.args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(path_env) = &merged_path {
            cmd.env("PATH", path_env);
        }
        let mut child = cmd
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
            config_selectors: Vec::new(),
            available_commands: builtin_acp_commands(),
            startup_info: None,
            replayed_messages: Vec::new(),
        };
        let init = conn.request(
            "initialize",
            &initialize_params("j-agent", env!("CARGO_PKG_VERSION")),
        )?;
        check_initialize(&init).map_err(AcpError::Protocol)?;

        if let Some(sid) = resume_session_id.map(str::trim).filter(|s| !s.is_empty())
            && let Ok(replayed) = conn.load_session(sid, cwd)
        {
            conn.replayed_messages = replayed;
            return Ok(conn);
        }

        let cwd_s = cwd.to_string_lossy().into_owned();
        let session = conn.request(
            "session/new",
            &serde_json::json!({ "cwd": cwd_s, "mcpServers": [] }),
        )?;
        conn.session_id = session_id_of(&session).map_err(AcpError::Protocol)?;
        let parsed = parse_session_config_selectors(&session);
        if !parsed.is_empty() {
            conn.config_selectors = parsed;
        }
        if let Some(startup) = parse_session_startup_info(&session) {
            let from_startup = parse_commands_from_startup_info(Some(&startup));
            conn.available_commands =
                merge_acp_commands(from_startup, std::mem::take(&mut conn.available_commands));
            conn.startup_info = Some(startup);
        }
        conn.drain_post_handshake_updates();
        Ok(conn)
    }

    /// 当前绑定的远端 ACP `sessionId`。
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// 调用 `session/list` 拉取指定工作区目录下的历史会话列表。
    pub fn list_sessions(&mut self, cwd: Option<&str>) -> Result<Vec<AcpSessionSummary>, AcpError> {
        let resp = self.request("session/list", &list_sessions_params(cwd, None))?;
        Ok(parse_session_list(&resp))
    }

    /// 调用 `session/load` 恢复指定历史会话，并收集回放的完整多轮对话历史。
    pub fn load_session(
        &mut self,
        target_session_id: &str,
        cwd: &std::path::Path,
    ) -> Result<Vec<ReplayedMessage>, AcpError> {
        let cwd_s = cwd.to_string_lossy().into_owned();
        let id = self.next_id;
        self.next_id += 1;
        let params = load_session_params(target_session_id, &cwd_s);
        self.write(&encode_request(id, "session/load", &params))?;

        let mut collector = SessionLoadCollector::default();
        loop {
            match self
                .rx
                .recv_timeout(ACP_REQUEST_TIMEOUT)
                .map_err(|_| AcpError::Io("agent 未响应或已退出（等待 session/load）".into()))?
            {
                Incoming::Response { id: rid, result } if rid == id => {
                    let v = result.map_err(AcpError::Protocol)?;
                    self.session_id = target_session_id.to_owned();
                    let parsed = parse_session_config_selectors(&v);
                    if !parsed.is_empty() {
                        self.config_selectors = parsed;
                    } else if let Some(sels) = collector.config_selectors.take() {
                        self.config_selectors = sels;
                    }
                    if let Some(cmds) = collector.available_commands.take() {
                        self.available_commands =
                            merge_acp_commands(cmds, std::mem::take(&mut self.available_commands));
                    }
                    self.drain_post_handshake_updates();
                    return Ok(collector.finish());
                }
                Incoming::Request { id, method, params } => {
                    let line = reply_to_agent_request(id, &method, &params);
                    self.write(&line)?;
                }
                Incoming::Notification { method, params } if method == "session/update" => {
                    if let Some(u) = params.get("update") {
                        collector.on_update(u);
                    }
                }
                _ => {}
            }
        }
    }

    /// 吸收 `session/new` 响应后紧随其后的异步初始化通知（例如 `pi-acp` 在 `setTimeout(..., 0)` 中推送的
    /// `available_commands_update` 与重复的 `startupInfo` 通知）。
    fn drain_post_handshake_updates(&mut self) {
        let wait_for_async = self.startup_info.is_some();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(120);
        loop {
            let next = if wait_for_async {
                let Some(rem) = deadline.checked_duration_since(std::time::Instant::now()) else {
                    break;
                };
                self.rx.recv_timeout(rem).ok()
            } else {
                self.rx.try_recv().ok()
            };
            let Some(msg) = next else {
                break;
            };
            match msg {
                Incoming::Notification { method, params } if method == "session/update" => {
                    if let Some(u) = params.get("update") {
                        let mut turn = TurnCollector::default()
                            .with_ignored_startup_text(self.startup_info.clone());
                        turn.on_update(u);
                        turn.apply_config_updates(&mut self.config_selectors);
                        if let Some(cmds) = turn.available_commands_snapshot() {
                            self.available_commands = merge_acp_commands(
                                cmds,
                                std::mem::take(&mut self.available_commands),
                            );
                            break;
                        }
                    }
                }
                Incoming::Request { id, method, params } => {
                    if let Ok(line) =
                        Ok::<String, AcpError>(reply_to_agent_request(id, &method, &params))
                    {
                        let _ = self.write(&line);
                    }
                }
                _ => {}
            }
        }
    }

    /// 发一条请求并等待它的响应；等待期间收到的 agent 请求按协议自动应答，配置更新通知同步到 `config_selectors`。
    fn request(&mut self, method: &str, params: &Value) -> Result<Value, AcpError> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(&encode_request(id, method, params))?;
        loop {
            match self
                .rx
                .recv_timeout(ACP_REQUEST_TIMEOUT)
                .map_err(|_| AcpError::Io(format!("agent 未响应或已退出（等待 {method}）")))?
            {
                Incoming::Response { id: rid, result } if rid == id => {
                    return result.map_err(AcpError::Protocol);
                }
                Incoming::Request { id, method, params } => {
                    let line = reply_to_agent_request(id, &method, &params);
                    self.write(&line)?;
                }
                Incoming::Notification { method, params } if method == "session/update" => {
                    if let Some(u) = params.get("update") {
                        let mut turn = TurnCollector::default();
                        turn.on_update(u);
                        turn.apply_config_updates(&mut self.config_selectors);
                        if let Some(cmds) = turn.available_commands_snapshot() {
                            self.available_commands = merge_acp_commands(
                                cmds,
                                std::mem::take(&mut self.available_commands),
                            );
                        }
                        if self.startup_info.is_none() {
                            let snap = turn.text_snapshot();
                            let trimmed = snap.trim();
                            if !trimmed.is_empty() {
                                self.startup_info = Some(trimmed.to_owned());
                            }
                        }
                    }
                }
                // 其余无关通知与响应忽略
                _ => {}
            }
        }
    }

    /// 切换当前 ACP 会话的某个配置项（如模型 `model`、思考等级 `thought_level` 或模式 `mode`）。
    pub fn set_config_value(
        &mut self,
        config_id: &str,
        value: &str,
        source: AcpConfigSource,
    ) -> Result<Vec<AcpConfigSelector>, AcpError> {
        for sel in &mut self.config_selectors {
            if sel.id == config_id {
                sel.current_value = value.to_owned();
            }
        }
        let session_id = self.session_id.clone();
        let resp = match source {
            AcpConfigSource::ConfigOption => self.request(
                "session/set_config_option",
                &set_config_option_params(&session_id, config_id, value),
            )?,
            AcpConfigSource::LegacyModel => {
                self.request("session/set_model", &set_model_params(&session_id, value))?
            }
            AcpConfigSource::LegacyMode => {
                self.request("session/set_mode", &set_mode_params(&session_id, value))?
            }
        };
        let parsed = parse_session_config_selectors(&resp);
        if !parsed.is_empty() {
            self.config_selectors = parsed;
        }
        Ok(self.config_selectors.clone())
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

    /// 发一轮 prompt，阻塞直到 `session/prompt` 响应，返回定稿文本（含文本化 tool 摘要，供旧测试用）。
    pub fn prompt(
        &mut self,
        text: &str,
        chunks: UnboundedSender<String>,
    ) -> Result<String, AcpError> {
        let (tx, rx) = futures::channel::mpsc::unbounded::<AcpTurnUpdate>();
        let forward = std::thread::spawn(move || {
            use futures::StreamExt as _;
            futures::executor::block_on(async move {
                let mut rx = rx;
                while let Some(u) = rx.next().await {
                    let _ = chunks.unbounded_send(u.text);
                }
            });
        });
        let session_id = self.session_id.clone();
        let id = self.next_id;
        self.next_id += 1;
        self.write(&encode_request(
            id,
            "session/prompt",
            &prompt_params(&session_id, text),
        ))?;
        let mut turn =
            TurnCollector::default().with_ignored_startup_text(self.startup_info.clone());
        let res = loop {
            match self
                .rx
                .recv()
                .map_err(|_| AcpError::Io("agent 已退出（等待回复）".into()))
            {
                Ok(Incoming::Notification { method, params }) if method == "session/update" => {
                    if let Some(u) = params.get("update") {
                        turn.on_update(u);
                        let changed = turn.apply_config_updates(&mut self.config_selectors);
                        if let Some(cmds) = turn.available_commands_snapshot() {
                            self.available_commands = merge_acp_commands(
                                cmds,
                                std::mem::take(&mut self.available_commands),
                            );
                        }
                        let _ = tx.unbounded_send(AcpTurnUpdate {
                            text: turn.text_snapshot(),
                            tool_calls: turn.tool_calls_snapshot(),
                            config_selectors: changed.then(|| self.config_selectors.clone()),
                            available_commands: turn.available_commands_snapshot(),
                        });
                    }
                }
                Ok(Incoming::Response { id: rid, result }) if rid == id => {
                    let v = match result.map_err(AcpError::Protocol) {
                        Ok(v) => v,
                        Err(e) => break Err(e),
                    };
                    let stop = v
                        .get("stopReason")
                        .and_then(Value::as_str)
                        .unwrap_or("end_turn");
                    break Ok(turn.assemble(stop));
                }
                Ok(Incoming::Request { id, method, params }) => {
                    let line = reply_to_agent_request(id, &method, &params);
                    if let Err(e) = self.write(&line) {
                        break Err(e);
                    }
                }
                Ok(_) => {}
                Err(e) => break Err(e),
            }
        };
        drop(tx);
        let _ = forward.join();
        res
    }

    /// 发一轮 prompt，流式推送结构化 `AcpTurnUpdate`（正文 + 工具调用），结束时返回结构化定稿。
    pub fn prompt_structured(
        &mut self,
        text: &str,
        chunks: UnboundedSender<AcpTurnUpdate>,
    ) -> Result<AcpTurnUpdate, AcpError> {
        let session_id = self.session_id.clone();
        let id = self.next_id;
        self.next_id += 1;
        self.write(&encode_request(
            id,
            "session/prompt",
            &prompt_params(&session_id, text),
        ))?;
        let mut turn =
            TurnCollector::default().with_ignored_startup_text(self.startup_info.clone());
        loop {
            match self
                .rx
                .recv()
                .map_err(|_| AcpError::Io("agent 已退出（等待回复）".into()))?
            {
                Incoming::Notification { method, params } if method == "session/update" => {
                    if let Some(u) = params.get("update") {
                        turn.on_update(u);
                        let changed = turn.apply_config_updates(&mut self.config_selectors);
                        if let Some(cmds) = turn.available_commands_snapshot() {
                            self.available_commands = merge_acp_commands(
                                cmds,
                                std::mem::take(&mut self.available_commands),
                            );
                        }
                        let _ = chunks.unbounded_send(AcpTurnUpdate {
                            text: turn.text_snapshot(),
                            tool_calls: turn.tool_calls_snapshot(),
                            config_selectors: changed.then(|| self.config_selectors.clone()),
                            available_commands: turn.available_commands_snapshot(),
                        });
                    }
                }
                Incoming::Response { id: rid, result } if rid == id => {
                    let v = result.map_err(AcpError::Protocol)?;
                    let stop = v
                        .get("stopReason")
                        .and_then(Value::as_str)
                        .unwrap_or("end_turn");
                    turn.apply_config_updates(&mut self.config_selectors);
                    if let Some(cmds) = turn.available_commands_snapshot() {
                        self.available_commands =
                            merge_acp_commands(cmds, std::mem::take(&mut self.available_commands));
                    }
                    return Ok(AcpTurnUpdate {
                        text: turn.assemble_body(stop),
                        tool_calls: turn.tool_calls_snapshot(),
                        config_selectors: (!self.config_selectors.is_empty())
                            .then(|| self.config_selectors.clone()),
                        available_commands: (!self.available_commands.is_empty())
                            .then(|| self.available_commands.clone()),
                    });
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
  req_id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -z "$req_id" ] && req_id=1
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1}}\n' "$req_id" ;;
    *'"method":"session/new"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"s-1"}}\n' "$req_id" ;;
    *'"method":"session/prompt"'*)
      if [ "__BLOCK_PROMPT__" = "1" ]; then
        echo started >&2
        while IFS= read -r _; do :; done
      fi
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello "}}}}'
      sleep 0.05
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"from fake"}}}}'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$req_id" ;;
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
            config_selectors: Vec::new(),
            available_commands: Vec::new(),
            startup_info: None,
            replayed_messages: Vec::new(),
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
    pub(crate) fn fake_agent_script_with_tools(dir: &std::path::Path) -> std::path::PathBuf {
        let p = dir.join("fake-agent-tools.sh");
        let script = r#"#!/bin/sh
while IFS= read -r line; do
  req_id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -z "$req_id" ] && req_id=1
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1}}\n' "$req_id" ;;
    *'"method":"session/new"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"s-1","configOptions":[{"type":"select","id":"model","category":"model","name":"Model","currentValue":"cpaapi/gpt-6-astra","options":[{"value":"cpaapi/gpt-6-astra","name":"cpaapi/GPT-6 Astra"},{"value":"cpaapi/claude-sonnet-5-5-high","name":"cpaapi/Claude Sonnet 5.5 High"}]},{"type":"select","id":"thought_level","category":"thought_level","name":"Thinking","currentValue":"medium","options":[{"value":"low","name":"Thinking: low"},{"value":"medium","name":"Thinking: medium"},{"value":"high","name":"Thinking: high"}]}],"_meta":{"piAcp":{"startupInfo":"pi v1.3.0\\n---\\n\\n## Context\\n- /repo/AGENTS.md\\n"}}}}\n' "$req_id"
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"pi v1.3.0\n---\n\n## Context\n- /repo/AGENTS.md\n"}}}}' ;;
    *'"method":"session/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"sessions":[{"sessionId":"s-prev-42","cwd":"/repo","title":"上次重构会话","updatedAt":"2026-10-17T09:15:00.000Z"}]}}\n' "$req_id" ;;
    *'"method":"session/load"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-prev-42","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"上次的问题"}}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-prev-42","update":{"sessionUpdate":"tool_call","toolCallId":"tc-old","kind":"read","title":"Read README.md","locations":[{"path":"README.md"}],"status":"completed"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-prev-42","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"上次的回答"}}}}'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"configOptions":[{"type":"select","id":"model","category":"model","name":"Model","currentValue":"cpaapi/claude-sonnet-5-5-high","options":[{"value":"cpaapi/gpt-6-astra","name":"cpaapi/GPT-6 Astra"},{"value":"cpaapi/claude-sonnet-5-5-high","name":"cpaapi/Claude Sonnet 5.5 High"}]}]}}\n' "$req_id" ;;
    *'"method":"session/set_config_option"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"configOptions":[{"type":"select","id":"model","category":"model","name":"Model","currentValue":"cpaapi/claude-sonnet-5-5-high","options":[{"value":"cpaapi/gpt-6-astra","name":"cpaapi/GPT-6 Astra"},{"value":"cpaapi/claude-sonnet-5-5-high","name":"cpaapi/Claude Sonnet 5.5 High"}]},{"type":"select","id":"thought_level","category":"thought_level","name":"Thinking","currentValue":"medium","options":[{"value":"low","name":"Thinking: low"},{"value":"medium","name":"Thinking: medium"},{"value":"high","name":"Thinking: high"}]}]}}\n' "$req_id" ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"tool_call","toolCallId":"tc-1","kind":"read","title":"Read src/lib.rs","locations":[{"path":"src/lib.rs"}],"status":"pending"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"tool_call_update","toolCallId":"tc-1","status":"completed"}}}'
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"checked src/lib.rs"}}}}'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$req_id" ;;
  esac
done
"#;
        std::fs::write(&p, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
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

    #[test]
    #[ignore = "spawns external pi-acp/pi process; run explicitly with --ignored"]
    fn pi_acp_completes_real_handshake_when_installed() {
        let (resolved, _) = resolve_command_and_path("pi-acp");
        if !resolved.is_file() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut conn = AcpConnection::connect("pi-acp", &[], dir.path())
            .expect("pi-acp 应成功完成 initialize + session/new 握手");
        assert!(!conn.session_id.is_empty(), "应返回非空 sessionId");
        assert!(
            conn.config_selectors.iter().any(|s| s.is_model()),
            "pi-acp 握手后应返回 model 选择器"
        );
        assert!(
            conn.config_selectors.iter().any(|s| s.is_thought_level()),
            "pi-acp 握手后应返回 thought_level 选择器"
        );

        // 测试真实切换 thinking level
        if let Some(think_sel) = conn
            .config_selectors
            .iter()
            .find(|s| s.is_thought_level())
            .cloned()
            && let Some(target_opt) = think_sel
                .options
                .iter()
                .find(|o| o.value != think_sel.current_value)
                .or_else(|| think_sel.options.first())
        {
            let updated = conn
                .set_config_value(&think_sel.id, &target_opt.value, think_sel.source)
                .expect("pi-acp 切换 thinking 等级应成功");
            let after = updated.iter().find(|s| s.is_thought_level()).unwrap();
            assert_eq!(after.current_value, target_opt.value);
        }

        // 测试真实切换 model
        if let Some(model_sel) = conn.config_selectors.iter().find(|s| s.is_model()).cloned()
            && let Some(target_opt) = model_sel
                .options
                .iter()
                .find(|o| o.value != model_sel.current_value)
                .or_else(|| model_sel.options.first())
        {
            let updated = conn
                .set_config_value(&model_sel.id, &target_opt.value, model_sel.source)
                .expect("pi-acp 切换模型应成功");
            let after = updated.iter().find(|s| s.is_model()).unwrap();
            assert_eq!(after.current_value, target_opt.value);
        }

        conn.disposer().terminate();
    }
}
