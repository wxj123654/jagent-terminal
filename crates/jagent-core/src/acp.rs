//! ACP v1（Agent Client Protocol）客户端的**协议层**：行分隔 JSON-RPC 的编解码与一次 turn 的状态机。
//! 对应旧 `threads/acp.ts` 里不涉及子进程 IO 的部分。
//!
//! 协议（agentclientprotocol.com/protocol/v1）：
//! - 传输 = stdio，UTF-8，行分隔 JSON（每行一个 JSON-RPC 2.0 消息，禁内嵌换行）；
//! - 握手 = `initialize`（protocolVersion:1 + clientCapabilities）→ `session/new`（cwd + mcpServers）→ sessionId；
//! - 对话 = `session/prompt` → 期间 `session/update` 通知流式汇报 → 响应 `{stopReason}`；
//! - agent → client 请求：`session/request_permission`；`fs/*`、`terminal/*` 仅在 client 声明对应
//!   capability 后才会来——我们全部不声明（`{}`），故不会收到。
//!
//! 不依赖 `agent-client-protocol` crate：3.3.0 于 2026-10-09 才发布（crates.io 核实：703 次下载），
//! API 面远大于本客户端所需（整轮返回、自动应答权限），且精确锁定 `agent-client-protocol-schema =1.11.0`。
//! 这里的实现只依赖 serde_json，零新增依赖。要做流式 / 权限 UI 时再重新评估（docs/gpui-rewrite.md Q1）。
//!
//! 进程 IO（spawn / stdin 写 / stdout 读）在 `jagent-app`：它把每行 stdout 喂给 [`Turn::on_line`]，
//! 把返回的待发送消息写回 stdin。本模块全部是纯函数 / 纯状态，可以用文本直接测。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::threads::ToolCallTrace;

/// ACP 会话下拉配置项中的单个候选项（对应 ACP `SessionConfigSelectOption` / `ModelInfo` / `SessionMode`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpSelectChoice {
    /// 选项值 ID（如 `"cpaapi/gemini-4-argon-high"` 或 `"high"`）
    pub value: String,
    /// 展示名称（如 `"Gemini 4 Argon High"` 或 `"Thinking: high"`）
    pub name: String,
    /// 可选分组名（如 provider `"cpaapi"` 或 `SessionConfigSelectGroup.name`）
    pub group: Option<String>,
    /// 可选描述文案
    pub description: Option<String>,
}

/// 标识切换某配置项时使用的 ACP JSON-RPC 方法（兼容新版 `configOptions` 与旧版 `models`/`modes`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AcpConfigSource {
    /// `session/set_config_option` (`{ sessionId, configId, value }`)
    ConfigOption,
    /// `session/set_model` (`{ sessionId, modelId }`)
    LegacyModel,
    /// `session/set_mode` (`{ sessionId, modeId }`)
    LegacyMode,
}

/// ACP 会话暴露的下拉配置选择器（Zed ACP 风格：Model 选择器、Mode / Thinking 选择器等）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpConfigSelector {
    /// 配置项 ID（如 `"model"`, `"thought_level"`, `"mode"`）
    pub id: String,
    /// 语义类别（`"model"`, `"thought_level"`, `"mode"` 等）
    pub category: Option<String>,
    /// 人类可读标题（如 `"Model"`, `"Thinking"`）
    pub name: String,
    /// 当前选中的值 ID
    pub current_value: String,
    /// 候选项列表
    pub options: Vec<AcpSelectChoice>,
    /// 写回协议源
    pub source: AcpConfigSource,
}

impl AcpConfigSelector {
    pub fn is_model(&self) -> bool {
        self.category.as_deref() == Some("model") || self.id == "model"
    }

    pub fn is_thought_level(&self) -> bool {
        self.category.as_deref() == Some("thought_level")
            || self.id == "thought_level"
            || self.id == "thinking"
    }

    pub fn is_mode(&self) -> bool {
        self.category.as_deref() == Some("mode") || self.id == "mode"
    }

    /// 当前选中项的完整展示名。
    pub fn current_label(&self) -> &str {
        self.options
            .iter()
            .find(|o| o.value == self.current_value)
            .map(|o| o.name.as_str())
            .unwrap_or(self.current_value.as_str())
    }

    /// 紧凑胶囊展示名（模型剥离 `provider/` 前缀避免胶囊过宽；其余保持原名）。
    pub fn short_current_label(&self) -> String {
        let raw = self.current_label();
        if self.is_model()
            && let Some((_, rest)) = raw.split_once('/')
            && !rest.trim().is_empty()
        {
            return rest.trim().to_owned();
        }
        raw.to_owned()
    }

    /// 当前选中模型的 provider 分组名（若有）。
    pub fn current_group(&self) -> Option<&str> {
        self.options
            .iter()
            .find(|o| o.value == self.current_value)
            .and_then(|o| o.group.as_deref())
            .or_else(|| {
                if self.is_model() {
                    self.current_value.split_once('/').map(|(p, _)| p)
                } else {
                    None
                }
            })
    }
}

/// ACP 会话暴露的斜杠命令（对应 ACP `AvailableCommand`，如 `/resume`、`/compact`、`/session`、`/skill:tdd`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpCommand {
    /// 命令名（不含前导 `/`，如 `"resume"`、`"compact"`、`"skill:tdd"`）
    pub name: String,
    /// 命令描述文案
    pub description: String,
    /// 可选参数提示（如 `"optional custom instructions"`、`"on|off|toggle"`）
    pub input_hint: Option<String>,
}

/// ACP `session/list` 返回的单条历史会话摘要。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpSessionSummary {
    /// 远端会话 ID（UUID）
    pub session_id: String,
    /// 会话所属工作区目录绝对路径
    pub cwd: String,
    /// 会话标题（首条提问或 `/name` 设置的名称）
    pub title: Option<String>,
    /// ISO-8601 更新时间（如 `"2026-10-17T08:30:00.000Z"`）
    pub updated_at: Option<String>,
}

/// `session/load` 历史回放还原出的单条对话消息（User 提问或带工具链的 Assistant 回复）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplayedMessage {
    pub is_user: bool,
    pub text: String,
    /// 该轮 assistant 的思考正文（`agent_thought_chunk`）；user 消息为空。
    pub thought: String,
    pub tool_calls: Vec<ToolCallTrace>,
}

/// `session/load` 期间收集 Agent 推送的 `user_message_chunk`、`agent_message_chunk`、
/// `tool_call` / `tool_call_update` 等通知，按轮次还原为 `Vec<ReplayedMessage>`。
#[derive(Debug, Default)]
pub struct SessionLoadCollector {
    messages: Vec<ReplayedMessage>,
    current_assistant: Option<TurnCollector>,
    last_user_msg_id: Option<String>,
    assistant_chunk_seq: u64,
    pub config_selectors: Option<Vec<AcpConfigSelector>>,
    pub current_mode_id: Option<String>,
    pub available_commands: Option<Vec<AcpCommand>>,
}

impl SessionLoadCollector {
    fn flush_assistant(&mut self) {
        if let Some(turn) = self.current_assistant.take() {
            let text = turn.assemble_body("end_turn");
            let thought = turn.thought_snapshot();
            let tool_calls = turn.tool_calls_snapshot();
            // 仅当存在实际正文、思考或工具调用时才生成一条 Assistant 消息
            let has_real_text = !text.is_empty() && text != "（turn 结束，无输出）";
            if has_real_text || !thought.is_empty() || !tool_calls.is_empty() {
                self.messages.push(ReplayedMessage {
                    is_user: false,
                    text: if has_real_text { text } else { String::new() },
                    thought,
                    tool_calls,
                });
            }
        }
    }

    /// 处理 `session/load` 期间收到的一条 `session/update` 的 `update` 对象。
    pub fn on_update(&mut self, u: &Value) {
        let Some(kind) = u.get("sessionUpdate").and_then(Value::as_str) else {
            return;
        };
        match kind {
            "user_message_chunk" => {
                let Some(c) = u.get("content") else { return };
                if c.get("type").and_then(Value::as_str) != Some("text") {
                    return;
                }
                let Some(raw_text) = c.get("text").and_then(Value::as_str) else {
                    return;
                };
                let trimmed = raw_text.trim();
                if trimmed.is_empty() {
                    return;
                }
                self.flush_assistant();
                let mid = str_of(u, "messageId");
                if let (Some(mid_str), Some(prev_mid)) = (&mid, &self.last_user_msg_id)
                    && mid_str == prev_mid
                    && let Some(last) = self.messages.last_mut()
                    && last.is_user
                {
                    last.text.push_str(raw_text);
                    return;
                }
                self.last_user_msg_id = mid;
                self.messages.push(ReplayedMessage {
                    is_user: true,
                    text: trimmed.to_owned(),
                    thought: String::new(),
                    tool_calls: Vec::new(),
                });
            }
            "agent_message_chunk" => {
                self.last_user_msg_id = None;
                let turn = self
                    .current_assistant
                    .get_or_insert_with(TurnCollector::default);
                // 若 update 未携带 messageId，为每次独立的回放块赋予递增合成 messageId，使多段回复自然分段
                if u.get("messageId").is_none() {
                    self.assistant_chunk_seq += 1;
                    let mut patched = u.clone();
                    if let Some(obj) = patched.as_object_mut() {
                        obj.insert(
                            "messageId".into(),
                            json!(format!("replay-a-{}", self.assistant_chunk_seq)),
                        );
                    }
                    turn.on_update(&patched);
                } else {
                    turn.on_update(u);
                }
            }
            "agent_thought_chunk" | "tool_call" | "tool_call_update" => {
                self.last_user_msg_id = None;
                let turn = self
                    .current_assistant
                    .get_or_insert_with(TurnCollector::default);
                turn.on_update(u);
            }
            "config_option_update" => {
                let parsed = parse_session_config_selectors(u);
                if !parsed.is_empty() {
                    self.config_selectors = Some(parsed);
                }
            }
            "current_mode_update" => {
                if let Some(mode_id) = str_of(u, "currentModeId").filter(|s| !s.is_empty()) {
                    self.current_mode_id = Some(mode_id);
                }
            }
            "available_commands_update" => {
                let cmds = parse_available_commands_update(u);
                if !cmds.is_empty() {
                    self.available_commands = Some(cmds);
                }
            }
            _ => {}
        }
    }

    /// `session/load` 响应到达后完结并返回还原出的全部历史消息。
    pub fn finish(mut self) -> Vec<ReplayedMessage> {
        self.flush_assistant();
        self.messages
    }
}

/// 一次 prompt turn 的收集器（`session/update` → 拼装 → prompt 响应后定稿）。
#[derive(Debug, Default)]
pub struct TurnCollector {
    text_parts: Vec<String>,
    current_msg_id: Option<String>,
    thought_parts: Vec<String>,
    current_thought_id: Option<String>,
    /// toolCallId → 摘要（按出现序见 `tool_order`）
    tools: HashMap<String, ToolRow>,
    tool_order: Vec<String>,
    /// turn 期间收到的最新 `config_option_update`
    config_selectors: Option<Vec<AcpConfigSelector>>,
    /// turn 期间收到的最新 `current_mode_update`
    current_mode_id: Option<String>,
    /// turn 期间收到的最新 `available_commands_update`
    available_commands: Option<Vec<AcpCommand>>,
    /// 若 `session/new` 已在独立消息中展示了 `startupInfo`，则在 prompt turn 内过滤掉重复推送的同文 chunk。
    ignored_startup_text: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct ToolRow {
    kind: Option<String>,
    title: Option<String>,
    status: Option<String>,
    path: Option<String>,
}

fn str_of(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

/// 从 ACP `tool_call` / `tool_call_update` 对象提取关联文件路径：
/// 优先 `locations[0].path` / `locations[0].uri`（剥离 `file://`），
/// 其次 `rawInput.path` / `rawInput.file_path` / `content[0].path`，
/// 最后尝试从 `title`（如 `"Read crates/x.rs"`）提取带 `/` 或扩展名的路徑 token。
fn extract_tool_path(u: &Value) -> Option<String> {
    if let Some(locs) = u.get("locations").and_then(Value::as_array) {
        for loc in locs {
            if let Some(p) = loc
                .get("path")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                return Some(p.to_owned());
            }
            if let Some(uri) = loc.get("uri").and_then(Value::as_str) {
                let p = uri.strip_prefix("file://").unwrap_or(uri);
                if !p.is_empty() {
                    return Some(p.to_owned());
                }
            }
        }
    }
    for key in ["rawInput", "input", "arguments"] {
        if let Some(inp) = u.get(key) {
            for pk in ["path", "file_path", "filePath", "file"] {
                if let Some(p) = inp
                    .get(pk)
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    return Some(p.to_owned());
                }
            }
        }
    }
    if let Some(title) = u.get("title").and_then(Value::as_str) {
        for token in title.split_whitespace() {
            let clean =
                token.trim_matches(|c: char| matches!(c, '`' | '\'' | '"' | '(' | ')' | ',' | ':'));
            if !clean.is_empty()
                && !clean.starts_with('-')
                && (clean.contains('/')
                    || clean.rsplit_once('.').is_some_and(|(stem, ext)| {
                        !stem.is_empty()
                            && ext.len() <= 8
                            && ext.chars().all(|c| c.is_ascii_alphanumeric())
                    }))
            {
                return Some(clean.to_owned());
            }
        }
    }
    None
}

impl TurnCollector {
    /// 设置需忽略的启动信息文本（避免 `pi-acp` 的 `setTimeout(sendStartupInfoIfPending, 0)` 通知混入后续用户 prompt 回复）。
    pub fn with_ignored_startup_text(mut self, startup_text: Option<String>) -> Self {
        self.ignored_startup_text = startup_text
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        self
    }

    /// 处理一条 `session/update` 的 `update` 对象。
    pub fn on_update(&mut self, u: &Value) {
        let Some(kind) = u.get("sessionUpdate").and_then(Value::as_str) else {
            return;
        };
        match kind {
            "agent_message_chunk" => {
                let Some(c) = u.get("content") else { return };
                if c.get("type").and_then(Value::as_str) != Some("text") {
                    return;
                }
                let Some(text) = c.get("text").and_then(Value::as_str) else {
                    return;
                };
                if let Some(ignored) = &self.ignored_startup_text
                    && text.trim() == ignored
                {
                    self.ignored_startup_text = None;
                    return;
                }
                Self::push_text_chunk(u, &mut self.text_parts, &mut self.current_msg_id);
            }
            "agent_thought_chunk" => {
                Self::push_text_chunk(u, &mut self.thought_parts, &mut self.current_thought_id);
            }
            "tool_call" => {
                let id = u.get("toolCallId").map(value_to_id).unwrap_or_default();
                if id.is_empty() || self.tools.contains_key(&id) {
                    return;
                }
                self.tools.insert(
                    id.clone(),
                    ToolRow {
                        kind: str_of(u, "kind"),
                        title: str_of(u, "title"),
                        status: str_of(u, "status"),
                        path: extract_tool_path(u),
                    },
                );
                self.tool_order.push(id);
            }
            "tool_call_update" => {
                let id = u.get("toolCallId").map(value_to_id).unwrap_or_default();
                let Some(row) = self.tools.get_mut(&id) else {
                    return;
                };
                if let Some(v) = str_of(u, "kind") {
                    row.kind = Some(v);
                }
                if let Some(v) = str_of(u, "title") {
                    row.title = Some(v);
                }
                if let Some(v) = str_of(u, "status") {
                    row.status = Some(v);
                }
                if let Some(p) = extract_tool_path(u) {
                    row.path = Some(p);
                }
            }
            "config_option_update" => {
                let parsed = parse_session_config_selectors(u);
                if !parsed.is_empty() {
                    self.config_selectors = Some(parsed);
                }
            }
            "current_mode_update" => {
                if let Some(mode_id) = str_of(u, "currentModeId").filter(|s| !s.is_empty()) {
                    self.current_mode_id = Some(mode_id);
                }
            }
            "available_commands_update" => {
                let cmds = parse_available_commands_update(u);
                if !cmds.is_empty() {
                    self.available_commands = Some(cmds);
                }
            }
            // user_message_chunk（本地已落列）/ plan / usage 等忽略
            _ => {}
        }
    }

    /// turn 期间若收到了 `available_commands_update`，返回最新命令列表。
    pub fn available_commands_snapshot(&self) -> Option<Vec<AcpCommand>> {
        self.available_commands.clone()
    }

    /// turn 期间若收到了 `config_option_update` 或 `current_mode_update`，将其应用到现有选择器列表。
    pub fn apply_config_updates(&self, selectors: &mut Vec<AcpConfigSelector>) -> bool {
        let mut changed = false;
        if let Some(new_list) = &self.config_selectors
            && selectors != new_list
        {
            *selectors = new_list.clone();
            changed = true;
        }
        if let Some(mode_id) = &self.current_mode_id {
            for sel in selectors.iter_mut() {
                if (sel.is_mode() || sel.is_thought_level()) && sel.current_value != *mode_id {
                    sel.current_value = mode_id.clone();
                    changed = true;
                }
            }
        }
        changed
    }

    /// 当前已收到的流式正文（尚未加入 tool 汇总与停止原因），用于 UI 实时追加。
    pub fn text_snapshot(&self) -> String {
        self.text_parts.concat()
    }

    /// 当前已收到的思考正文（`agent_thought_chunk`），不进入回复正文。
    pub fn thought_snapshot(&self) -> String {
        self.thought_parts.concat().trim().to_owned()
    }

    /// 把一条 text content chunk 拼进 parts；`messageId` 变化时先插一个段落分隔。
    fn push_text_chunk(u: &Value, parts: &mut Vec<String>, current_id: &mut Option<String>) {
        let Some(c) = u.get("content") else { return };
        if c.get("type").and_then(Value::as_str) != Some("text") {
            return;
        }
        let Some(text) = c.get("text").and_then(Value::as_str) else {
            return;
        };
        let mid = str_of(u, "messageId");
        if let (Some(mid), Some(cur)) = (&mid, &*current_id)
            && mid != cur
            && !parts.is_empty()
        {
            parts.push("\n\n".into());
        }
        if mid.is_some() {
            *current_id = mid;
        }
        parts.push(text.to_owned());
    }

    /// 当前已收到的工具调用列表（按首次出现序），供 UI 实时渲染工具调用卡片。
    pub fn tool_calls_snapshot(&self) -> Vec<ToolCallTrace> {
        self.tool_order
            .iter()
            .filter_map(|id| {
                let row = self.tools.get(id)?;
                Some(ToolCallTrace {
                    id: id.clone(),
                    kind: row.kind.clone(),
                    title: row.title.clone(),
                    status: row.status.clone(),
                    path: row.path.clone(),
                })
            })
            .collect()
    }

    /// prompt 响应后定稿的正文（不含 tool 文本行，适合配合结构化 `tool_calls` 卡片展示）。
    pub fn assemble_body(&self, stop_reason: &str) -> String {
        let mut parts: Vec<String> = vec![];
        let text = self.text_parts.concat();
        let text = text.trim();
        if !text.is_empty() {
            parts.push(text.to_owned());
        }
        if let Some(note) = stop_note(stop_reason) {
            parts.push(format!("> 停止：{note}"));
        }
        if parts.is_empty() {
            // 已有工具调用或思考正文时不回退占位，避免把推理过程装进回复。
            if self.tool_order.is_empty() && self.thought_snapshot().is_empty() {
                "（turn 结束，无输出）".into()
            } else {
                String::new()
            }
        } else {
            parts.join("\n\n")
        }
    }

    /// prompt 响应后定稿：正文 + tool 汇总 bullet 行 + 非 end_turn 的停止注记。
    pub fn assemble(&self, stop_reason: &str) -> String {
        let mut parts: Vec<String> = vec![];
        let text = self.text_parts.concat();
        let text = text.trim();
        if !text.is_empty() {
            parts.push(text.to_owned());
        }
        let tool_lines: Vec<String> = self
            .tool_order
            .iter()
            .filter_map(|id| self.tools.get(id))
            .map(|t| {
                let bits: Vec<&str> = ["tool"]
                    .into_iter()
                    .chain(
                        [&t.kind, &t.title, &t.status]
                            .into_iter()
                            .filter_map(|x| x.as_deref())
                            .filter(|s| !s.is_empty()),
                    )
                    .collect();
                format!("- {}", bits.join(" · "))
            })
            .collect();
        if !tool_lines.is_empty() {
            parts.push(tool_lines.join("\n"));
        }
        if let Some(note) = stop_note(stop_reason) {
            parts.push(format!("> 停止：{note}"));
        }
        if parts.is_empty() {
            "（turn 结束，无输出）".into()
        } else {
            parts.join("\n\n")
        }
    }
}

/// toolCallId 可能是字符串或数字（旧实现 `String(u.toolCallId ?? '')`）。
fn value_to_id(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 停止原因 → 注记（end_turn 无注记）。
fn stop_note(reason: &str) -> Option<&'static str> {
    match reason {
        "max_tokens" => Some("达到 token 上限"),
        "max_turn_requests" => Some("达到单轮请求上限"),
        "refusal" => Some("agent 拒绝继续"),
        "cancelled" => Some("已取消"),
        _ => None,
    }
}

/// 入站一行的分类结果。
#[derive(Debug, PartialEq)]
pub enum Incoming {
    /// 对我方请求的响应：`Ok(result)` / `Err(message)`
    Response {
        id: u64,
        result: Result<Value, String>,
    },
    /// agent → client 的请求，需回复
    Request {
        id: u64,
        method: String,
        params: Value,
    },
    /// 通知（无 id）
    Notification { method: String, params: Value },
}

/// 解析入站一行。空行 / 非 JSON / 不合规格的行返回 `None`（规范禁止非 JSON 行，但容错无害）。
pub fn parse_line(line: &str) -> Option<Incoming> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let msg: Value = serde_json::from_str(line).ok()?;
    let id = msg.get("id").and_then(Value::as_u64);
    if let Some(method) = msg.get("method").and_then(Value::as_str) {
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        return Some(match id {
            Some(id) => Incoming::Request {
                id,
                method: method.to_owned(),
                params,
            },
            None => Incoming::Notification {
                method: method.to_owned(),
                params,
            },
        });
    }
    let id = id?;
    let result = match msg.get("error") {
        Some(e) => Err(format!(
            "ACP 错误 {}：{}",
            e.get("code").map_or_else(|| "?".into(), Value::to_string),
            e.get("message").and_then(Value::as_str).unwrap_or("")
        )),
        None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
    };
    Some(Incoming::Response { id, result })
}

/// 编码一条出站请求（一行，含换行）。
pub fn encode_request(id: u64, method: &str, params: &Value) -> String {
    format!(
        "{}\n",
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    )
}

fn encode_response(id: u64, result: &Value) -> String {
    format!(
        "{}\n",
        json!({ "jsonrpc": "2.0", "id": id, "result": result })
    )
}

fn encode_error(id: u64, code: i64, message: &str) -> String {
    format!(
        "{}\n",
        json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
    )
}

/// 自动应答 agent 请求（目前仅权限；无 UI——后续接权限面时替换）。
/// 权限：`allow_once` > `allow_always` > 首项；无选项 → `cancelled`。其余方法 → `-32601`。
/// 返回要写回 stdin 的一行。
pub fn reply_to_agent_request(id: u64, method: &str, params: &Value) -> String {
    if method == "session/request_permission" {
        let options: Vec<&Value> = params
            .get("options")
            .and_then(Value::as_array)
            .map(|a| a.iter().collect())
            .unwrap_or_default();
        let by_kind = |k: &str| {
            options
                .iter()
                .find(|o| o.get("kind").and_then(Value::as_str) == Some(k))
        };
        let pick = by_kind("allow_once")
            .or_else(|| by_kind("allow_always"))
            .or_else(|| options.first());
        let result = match pick.and_then(|o| o.get("optionId")) {
            Some(oid) => json!({ "outcome": "selected", "optionId": oid }),
            None => json!({ "outcome": "cancelled" }),
        };
        return encode_response(id, &result);
    }
    encode_error(id, -32601, &format!("j-agent 未实现该方法：{method}"))
}

/// 握手请求参数。
pub fn initialize_params(client_name: &str, client_version: &str) -> Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": {},
        "clientInfo": { "name": client_name, "version": client_version },
    })
}

/// 校验 `initialize` 的结果：协议版本必须是 1。
pub fn check_initialize(result: &Value) -> Result<(), String> {
    match result.get("protocolVersion") {
        Some(Value::Number(n)) if n.as_u64() == Some(1) => Ok(()),
        other => Err(format!(
            "ACP 协议版本不兼容（agent 返回 {}）",
            other.map_or("undefined".into(), Value::to_string)
        )),
    }
}

/// 取 `session/new` 的 sessionId。
pub fn session_id_of(result: &Value) -> Result<String, String> {
    result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "session/new 未返回 sessionId".into())
}

/// 从 `session/new` 响应的 `_meta` 中提取 Agent 启动欢迎信息（如 `pi-acp` 的 `_meta.piAcp.startupInfo`：
/// 包含 `pi vX.Y.Z`、`## Context`、`## Skills`、`## Prompts`、`## Extensions`）。
pub fn parse_session_startup_info(result: &Value) -> Option<String> {
    let raw = result
        .get("_meta")
        .and_then(|m| {
            m.get("piAcp")
                .and_then(|p| p.get("startupInfo"))
                .or_else(|| m.get("startupInfo"))
        })
        .or_else(|| result.get("startupInfo"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    Some(raw.to_owned())
}

/// `session/prompt` 的参数。
pub fn prompt_params(session_id: &str, text: &str) -> Value {
    json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] })
}

/// `session/set_config_option` 的参数。
pub fn set_config_option_params(session_id: &str, config_id: &str, value: &str) -> Value {
    json!({
        "sessionId": session_id,
        "configId": config_id,
        "value": value,
    })
}

/// `session/set_mode` 的参数。
pub fn set_mode_params(session_id: &str, mode_id: &str) -> Value {
    json!({
        "sessionId": session_id,
        "modeId": mode_id,
    })
}

/// `session/set_model` 的参数。
pub fn set_model_params(session_id: &str, model_id: &str) -> Value {
    json!({
        "sessionId": session_id,
        "modelId": model_id,
    })
}

/// `session/list` 的参数。
pub fn list_sessions_params(cwd: Option<&str>, cursor: Option<&str>) -> Value {
    let mut map = serde_json::Map::new();
    if let Some(c) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        map.insert("cwd".into(), json!(c));
    }
    if let Some(cur) = cursor.map(str::trim).filter(|s| !s.is_empty()) {
        map.insert("cursor".into(), json!(cur));
    }
    Value::Object(map)
}

/// `session/load` 的参数。
pub fn load_session_params(session_id: &str, cwd: &str) -> Value {
    json!({
        "sessionId": session_id,
        "cwd": cwd,
        "mcpServers": [],
    })
}

/// 解析 `session/list` 响应中的 `sessions` 数组。
pub fn parse_session_list(result: &Value) -> Vec<AcpSessionSummary> {
    let Some(arr) = result.get("sessions").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        let Some(session_id) = item
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let cwd = item
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_owned();
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let updated_at = item
            .get("updatedAt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        out.push(AcpSessionSummary {
            session_id: session_id.to_owned(),
            cwd,
            title,
            updated_at,
        });
    }
    out
}

fn split_provider_group(value: &str, name: &str, is_model: bool) -> (Option<String>, String) {
    if is_model
        && let Some((prov, _)) = value.split_once('/')
        && !prov.trim().is_empty()
    {
        let group = prov.trim().to_owned();
        let prefix = format!("{group}/");
        let clean_name = name
            .strip_prefix(&prefix)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(name)
            .to_owned();
        return (Some(group), clean_name);
    }
    (None, name.to_owned())
}

fn parse_select_choice(
    opt: &Value,
    default_group: Option<&str>,
    is_model: bool,
) -> Option<AcpSelectChoice> {
    let value = opt
        .get("value")
        .or_else(|| opt.get("modelId"))
        .or_else(|| opt.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let raw_name = opt
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(value);
    let (inferred_group, clean_name) = match default_group {
        Some(g) => (Some(g.to_owned()), raw_name.to_owned()),
        None => split_provider_group(value, raw_name, is_model),
    };
    let description = opt
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    Some(AcpSelectChoice {
        value: value.to_owned(),
        name: clean_name,
        group: inferred_group,
        description,
    })
}

/// 从 `session/new`、`session/load`、`session/set_config_option` 响应或 `config_option_update` 通知中
/// 提取会话配置选择器列表（优先读取标准 `configOptions`，并对仅返回 `models` / `modes` 的旧版 Agent 自动补齐）。
pub fn parse_session_config_selectors(result: &Value) -> Vec<AcpConfigSelector> {
    let mut out: Vec<AcpConfigSelector> = Vec::new();

    if let Some(arr) = result.get("configOptions").and_then(Value::as_array) {
        for item in arr {
            // 仅处理 select 类型的配置项（或带 options 数组的项）
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or("select");
            if item_type != "select" {
                continue;
            }
            let Some(id) = item
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let category = item
                .get("category")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            let is_model = category.as_deref() == Some("model") || id == "model";
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(id)
                .to_owned();
            let current_value = item
                .get("currentValue")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();

            let mut choices = Vec::new();
            if let Some(opts) = item.get("options").and_then(Value::as_array) {
                for entry in opts {
                    // 支持 SessionConfigSelectGroup（嵌套 options）与扁平 SessionConfigSelectOption
                    if let Some(sub_opts) = entry.get("options").and_then(Value::as_array) {
                        let group_name = entry
                            .get("name")
                            .or_else(|| entry.get("group"))
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty());
                        for sub in sub_opts {
                            if let Some(c) = parse_select_choice(sub, group_name, is_model) {
                                choices.push(c);
                            }
                        }
                    } else if let Some(c) = parse_select_choice(entry, None, is_model) {
                        choices.push(c);
                    }
                }
            }
            if choices.is_empty() {
                continue;
            }
            let current_value = if current_value.is_empty() {
                choices[0].value.clone()
            } else {
                current_value
            };
            out.push(AcpConfigSelector {
                id: id.to_owned(),
                category,
                name,
                current_value,
                options: choices,
                source: AcpConfigSource::ConfigOption,
            });
        }
    }

    // 兼容仅返回 `models: { currentModelId, availableModels }` 的 Agent
    if !out.iter().any(AcpConfigSelector::is_model)
        && let Some(models_obj) = result.get("models").and_then(Value::as_object)
        && let Some(avail) = models_obj.get("availableModels").and_then(Value::as_array)
    {
        let choices: Vec<AcpSelectChoice> = avail
            .iter()
            .filter_map(|m| parse_select_choice(m, None, true))
            .collect();
        if !choices.is_empty() {
            let current_value = models_obj
                .get("currentModelId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| choices[0].value.clone());
            out.insert(
                0,
                AcpConfigSelector {
                    id: "model".into(),
                    category: Some("model".into()),
                    name: "Model".into(),
                    current_value,
                    options: choices,
                    source: AcpConfigSource::LegacyModel,
                },
            );
        }
    }

    // 兼容仅返回 `modes: { currentModeId, availableModes }` 的 Agent
    if !out.iter().any(|s| s.is_mode() || s.is_thought_level())
        && let Some(modes_obj) = result.get("modes").and_then(Value::as_object)
        && let Some(avail) = modes_obj.get("availableModes").and_then(Value::as_array)
    {
        let choices: Vec<AcpSelectChoice> = avail
            .iter()
            .filter_map(|m| parse_select_choice(m, None, false))
            .collect();
        if !choices.is_empty() {
            let current_value = modes_obj
                .get("currentModeId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| choices[0].value.clone());
            out.push(AcpConfigSelector {
                id: "mode".into(),
                category: Some("mode".into()),
                name: "Mode".into(),
                current_value,
                options: choices,
                source: AcpConfigSource::LegacyMode,
            });
        }
    }

    out
}

/// 默认内置的 ACP 斜杠命令（含 `/resume` 会话恢复及 `pi-acp` 的 `builtinAvailableCommands`）。
pub fn builtin_acp_commands() -> Vec<AcpCommand> {
    vec![
        AcpCommand {
            name: "resume".into(),
            description: "Resume a previous session in this workspace".into(),
            input_hint: Some("optional filter".into()),
        },
        AcpCommand {
            name: "compact".into(),
            description: "Manually compact the session context".into(),
            input_hint: Some("optional custom instructions".into()),
        },
        AcpCommand {
            name: "autocompact".into(),
            description: "Toggle automatic context compaction".into(),
            input_hint: Some("on|off|toggle".into()),
        },
        AcpCommand {
            name: "session".into(),
            description: "Show session stats (messages, tokens, cost, session file)".into(),
            input_hint: None,
        },
        AcpCommand {
            name: "export".into(),
            description: "Export session to an HTML file in the session cwd".into(),
            input_hint: None,
        },
        AcpCommand {
            name: "name".into(),
            description: "Set session display name".into(),
            input_hint: Some("<name>".into()),
        },
        AcpCommand {
            name: "steering".into(),
            description: "Get/set pi steering message delivery mode".into(),
            input_hint: Some("all | one-at-a-time".into()),
        },
        AcpCommand {
            name: "follow-up".into(),
            description: "Get/set pi follow-up message delivery mode".into(),
            input_hint: Some("all | one-at-a-time".into()),
        },
        AcpCommand {
            name: "changelog".into(),
            description: "Show pi changelog".into(),
            input_hint: None,
        },
    ]
}

/// 合并命令列表（按 `name` 去重，保留排在前面的项）。
pub fn merge_acp_commands(primary: Vec<AcpCommand>, fallback: Vec<AcpCommand>) -> Vec<AcpCommand> {
    let mut out = Vec::new();
    for cmd in primary.into_iter().chain(fallback) {
        let name = cmd.name.trim().trim_start_matches('/').to_owned();
        if name.is_empty() || out.iter().any(|c: &AcpCommand| c.name == name) {
            continue;
        }
        out.push(AcpCommand { name, ..cmd });
    }
    out
}

/// 从 `session/new` 的 `startupInfo` Markdown 文本（`## Skills` / `## Prompts` 段落）中提取可用命令，
/// 并与内置斜杠命令合并，确保一打开 ACP 会话就能用 `/` 触发所有技能与内置命令。
pub fn parse_commands_from_startup_info(startup_info: Option<&str>) -> Vec<AcpCommand> {
    let mut extracted = Vec::new();
    if let Some(info) = startup_info {
        #[derive(Clone, Copy, PartialEq, Eq)]
        enum Section {
            None,
            Skills,
            Prompts,
        }
        let mut section = Section::None;
        for raw_line in info.lines() {
            let line = raw_line.trim();
            if let Some(heading) = line.strip_prefix("## ") {
                let h = heading.trim().to_ascii_lowercase();
                section = match h.as_str() {
                    "skills" => Section::Skills,
                    "prompts" => Section::Prompts,
                    _ => Section::None,
                };
                continue;
            }
            if section == Section::None {
                continue;
            }
            if let Some(item) = line.strip_prefix("- ").map(str::trim)
                && !item.is_empty()
                && item != "(none)"
            {
                let item = item.trim_start_matches('/');
                match section {
                    Section::Skills => {
                        let name = if item.starts_with("skill:") {
                            item.to_owned()
                        } else {
                            format!("skill:{item}")
                        };
                        extracted.push(AcpCommand {
                            name,
                            description: format!("Load skill {item}"),
                            input_hint: Some("optional task or instructions".into()),
                        });
                    }
                    Section::Prompts => {
                        extracted.push(AcpCommand {
                            name: item.to_owned(),
                            description: format!("Run prompt template /{item}"),
                            input_hint: None,
                        });
                    }
                    Section::None => {}
                }
            }
        }
    }
    merge_acp_commands(extracted, builtin_acp_commands())
}

/// 解析 ACP `available_commands_update` 通知中的 `availableCommands` 数组，并与内置命令合并。
pub fn parse_available_commands_update(u: &Value) -> Vec<AcpCommand> {
    let Some(arr) = u.get("availableCommands").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut parsed = Vec::new();
    for item in arr {
        let Some(name) = item
            .get("name")
            .and_then(Value::as_str)
            .map(|s| s.trim().trim_start_matches('/'))
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let description = item
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_owned();
        let input_hint = item
            .get("input")
            .and_then(|inp| inp.get("hint"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        parsed.push(AcpCommand {
            name: name.to_owned(),
            description,
            input_hint,
        });
    }
    if parsed.is_empty() {
        Vec::new()
    } else {
        merge_acp_commands(parsed, builtin_acp_commands())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(turn: &mut TurnCollector, lines: &[&str]) {
        for l in lines {
            if let Some(Incoming::Notification { method, params }) = parse_line(l)
                && method == "session/update"
                && let Some(u) = params.get("update")
            {
                turn.on_update(u);
            }
        }
    }

    #[test]
    fn parse_line_classifies_responses_requests_and_notifications() {
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","id":3,"result":{"x":1}}"#),
            Some(Incoming::Response {
                id: 3,
                result: Ok(json!({"x":1}))
            })
        );
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32000,"message":"boom"}}"#),
            Some(Incoming::Response {
                id: 4,
                result: Err("ACP 错误 -32000：boom".into())
            })
        );
        assert!(matches!(
            parse_line(
                r#"{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{}}"#
            ),
            Some(Incoming::Request { id: 9, .. })
        ));
        assert!(matches!(
            parse_line(r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#),
            Some(Incoming::Notification { .. })
        ));
    }

    #[test]
    fn parse_line_tolerates_garbage_and_blank_lines() {
        assert_eq!(parse_line(""), None);
        assert_eq!(parse_line("   "), None);
        assert_eq!(parse_line("not json"), None);
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0"}"#),
            None,
            "既无 method 也无 id"
        );
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","id":"str","result":1}"#),
            None,
            "非数字 id 不是我们发出的请求"
        );
    }

    #[test]
    fn encode_request_is_one_line_with_a_trailing_newline() {
        let s = encode_request(1, "initialize", &initialize_params("j-agent", "0.1.0"));
        assert!(
            s.ends_with('\n') && s.matches('\n').count() == 1,
            "禁内嵌换行"
        );
        let v: Value = serde_json::from_str(s.trim()).unwrap();
        assert_eq!(
            (
                v["jsonrpc"].as_str(),
                v["id"].as_u64(),
                v["method"].as_str()
            ),
            (Some("2.0"), Some(1), Some("initialize"))
        );
        assert_eq!(v["params"]["protocolVersion"], 1);
        assert_eq!(
            v["params"]["clientCapabilities"],
            json!({}),
            "不声明 fs/terminal 能力"
        );
        assert_eq!(v["params"]["clientInfo"]["name"], "j-agent");
    }

    #[test]
    fn prompt_params_carry_the_text_even_when_it_contains_newlines() {
        let s = encode_request(
            7,
            "session/prompt",
            &prompt_params("sess-1", "line1\nline2"),
        );
        assert_eq!(
            s.matches('\n').count(),
            1,
            "文本里的换行被 JSON 转义，不破坏行分隔"
        );
        let v: Value = serde_json::from_str(s.trim()).unwrap();
        assert_eq!(v["params"]["prompt"][0]["text"], "line1\nline2");
    }

    #[test]
    fn handshake_checks_protocol_version_and_session_id() {
        assert!(check_initialize(&json!({"protocolVersion":1})).is_ok());
        assert!(
            check_initialize(&json!({"protocolVersion":2}))
                .unwrap_err()
                .contains("不兼容")
        );
        assert!(
            check_initialize(&json!({}))
                .unwrap_err()
                .contains("undefined")
        );
        assert_eq!(session_id_of(&json!({"sessionId":"s1"})).unwrap(), "s1");
        assert!(session_id_of(&json!({})).unwrap_err().contains("sessionId"));
        assert!(session_id_of(&json!({"sessionId":5})).is_err());
    }

    #[test]
    fn permission_requests_prefer_allow_once_then_allow_always_then_first() {
        let pick = |opts: Value| -> Value {
            let line = reply_to_agent_request(
                5,
                "session/request_permission",
                &json!({ "options": opts }),
            );
            serde_json::from_str::<Value>(line.trim()).unwrap()["result"].clone()
        };
        let o = |id: &str, k: &str| json!({"optionId": id, "kind": k});
        assert_eq!(
            pick(json!([
                o("r", "reject_once"),
                o("a", "allow_always"),
                o("o", "allow_once")
            ])),
            json!({"outcome":"selected","optionId":"o"})
        );
        assert_eq!(
            pick(json!([o("r", "reject_once"), o("a", "allow_always")])),
            json!({"outcome":"selected","optionId":"a"})
        );
        assert_eq!(
            pick(json!([o("r", "reject_once"), o("x", "reject_always")])),
            json!({"outcome":"selected","optionId":"r"}),
            "首项"
        );
        assert_eq!(pick(json!([])), json!({"outcome":"cancelled"}));
    }

    #[test]
    fn unknown_agent_requests_get_method_not_found() {
        let line = reply_to_agent_request(8, "fs/read_text_file", &json!({}));
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(
            (v["id"].as_u64(), v["error"]["code"].as_i64()),
            (Some(8), Some(-32601))
        );
        assert!(
            v["error"]["message"]
                .as_str()
                .unwrap()
                .contains("fs/read_text_file")
        );
    }

    #[test]
    fn message_chunks_join_and_a_new_message_id_starts_a_new_paragraph() {
        let mut t = TurnCollector::default();
        feed(
            &mut t,
            &[
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","messageId":"m1","content":{"type":"text","text":"你好，"}}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","messageId":"m1","content":{"type":"text","text":"世界"}}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","messageId":"m2","content":{"type":"text","text":"第二段"}}}}"#,
            ],
        );
        assert_eq!(t.assemble("end_turn"), "你好，世界\n\n第二段");
    }

    #[test]
    fn non_text_chunks_and_unknown_updates_are_ignored() {
        let mut t = TurnCollector::default();
        feed(
            &mut t,
            &[
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"image","data":"x"}}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"plan","entries":[]}}}"#,
                r#"{"method":"session/update","params":{"update":{"noKind":true}}}"#,
            ],
        );
        assert_eq!(t.assemble("end_turn"), "（turn 结束，无输出）");
        assert!(t.thought_snapshot().is_empty());
    }

    #[test]
    fn thought_chunks_stay_out_of_the_reply_and_split_on_message_id() {
        let mut t = TurnCollector::default();
        feed(
            &mut t,
            &[
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","messageId":"t1","content":{"type":"text","text":"先看"}}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","messageId":"t1","content":{"type":"text","text":"协议"}}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"image","data":"x"}}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","messageId":"t2","content":{"type":"text","text":"再答"}}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"正文"}}}}"#,
            ],
        );
        assert_eq!(t.thought_snapshot(), "先看协议\n\n再答");
        assert_eq!(t.assemble_body("end_turn"), "正文");
        assert_eq!(t.text_snapshot(), "正文");
    }

    #[test]
    fn thought_only_turn_does_not_invent_reply_text() {
        let mut t = TurnCollector::default();
        feed(
            &mut t,
            &[
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"  只有思考  "}}}}"#,
            ],
        );
        assert_eq!(t.thought_snapshot(), "只有思考");
        assert_eq!(t.assemble_body("end_turn"), "");
    }

    #[test]
    fn tool_calls_are_summarised_in_first_seen_order_and_updates_patch_the_row() {
        let mut t = TurnCollector::default();
        feed(
            &mut t,
            &[
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"开始"}}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"a","kind":"read","title":"Read x.rs","status":"pending"}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"b","title":"Run tests"}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"a","title":"重复 id 忽略"}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"a","status":"completed"}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"zzz","status":"completed"}}}"#,
            ],
        );
        assert_eq!(
            t.assemble("end_turn"),
            "开始\n\n- tool · read · Read x.rs · completed\n- tool · Run tests"
        );
    }

    #[test]
    fn numeric_tool_call_ids_are_accepted() {
        let mut t = TurnCollector::default();
        feed(
            &mut t,
            &[
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":7,"title":"n"}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":7,"status":"done"}}}"#,
            ],
        );
        assert_eq!(t.assemble("end_turn"), "- tool · n · done");
    }

    #[test]
    fn non_end_turn_stop_reasons_append_a_note() {
        let mut t = TurnCollector::default();
        feed(
            &mut t,
            &[
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"半截"}}}}"#,
            ],
        );
        assert_eq!(t.assemble("end_turn"), "半截");
        assert_eq!(t.assemble("max_tokens"), "半截\n\n> 停止：达到 token 上限");
        assert_eq!(t.assemble("refusal"), "半截\n\n> 停止：agent 拒绝继续");
        assert_eq!(t.assemble("cancelled"), "半截\n\n> 停止：已取消");
        assert_eq!(t.assemble("something_new"), "半截", "未知原因无注记");
    }

    #[test]
    fn an_empty_turn_has_a_placeholder_and_a_note_only_turn_keeps_just_the_note() {
        let t = TurnCollector::default();
        assert_eq!(t.assemble("end_turn"), "（turn 结束，无输出）");
        assert_eq!(t.assemble("cancelled"), "> 停止：已取消");
    }

    #[test]
    fn a_full_scripted_session_round_trips_through_the_codec() {
        // 模拟 agent 的整段 stdout，逐行喂入，核对分类与最终文本。
        let stdout = [
            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}"#,
            r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s-9"}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}"#,
            r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#,
        ];
        let mut turn = TurnCollector::default();
        let mut responses = HashMap::new();
        for line in stdout {
            match parse_line(line).unwrap() {
                Incoming::Response { id, result } => {
                    responses.insert(id, result.unwrap());
                }
                Incoming::Notification { params, .. } => turn.on_update(&params["update"]),
                Incoming::Request { .. } => unreachable!(),
            }
        }
        check_initialize(&responses[&1]).unwrap();
        assert_eq!(session_id_of(&responses[&2]).unwrap(), "s-9");
        assert_eq!(
            turn.assemble(responses[&3]["stopReason"].as_str().unwrap()),
            "done"
        );
    }

    #[test]
    fn tool_calls_snapshot_extracts_locations_raw_input_and_title_paths() {
        let mut t = TurnCollector::default();
        feed(
            &mut t,
            &[
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t1","kind":"read","title":"Read config","locations":[{"path":"crates/jagent-core/src/acp.rs"}],"status":"pending"}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t2","kind":"edit","title":"Patch file","rawInput":{"file_path":"src/main.rs"},"status":"pending"}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"t3","kind":"read","title":"Read `README.md`","status":"completed"}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed"}}}"#,
            ],
        );
        let snap = t.tool_calls_snapshot();
        assert_eq!(snap.len(), 3);
        assert_eq!(
            (
                snap[0].id.as_str(),
                snap[0].kind.as_deref(),
                snap[0].path.as_deref(),
                snap[0].status.as_deref()
            ),
            (
                "t1",
                Some("read"),
                Some("crates/jagent-core/src/acp.rs"),
                Some("completed")
            )
        );
        assert_eq!(snap[1].path.as_deref(), Some("src/main.rs"));
        assert_eq!(snap[2].path.as_deref(), Some("README.md"));
        assert_eq!(
            t.assemble_body("end_turn"),
            "",
            "有结构化工具调用但无正文时不回退（turn 结束，无输出）占位"
        );
    }

    #[test]
    fn parse_session_config_selectors_extracts_model_and_thought_level_with_provider_groups() {
        let session_new = json!({
            "sessionId": "s-1",
            "configOptions": [
                {
                    "type": "select",
                    "id": "model",
                    "category": "model",
                    "name": "Model",
                    "currentValue": "cpaapi/gemini-4-argon-high",
                    "options": [
                        { "value": "openai-codex/gpt-5.5", "name": "openai-codex/GPT-5.5", "description": null },
                        { "value": "cpaapi/gemini-4-argon-high", "name": "cpaapi/Gemini 4 Argon High", "description": null }
                    ]
                },
                {
                    "type": "select",
                    "id": "thought_level",
                    "category": "thought_level",
                    "name": "Thinking",
                    "currentValue": "high",
                    "options": [
                        { "value": "low", "name": "Thinking: low" },
                        { "value": "high", "name": "Thinking: high" }
                    ]
                }
            ]
        });
        let mut selectors = parse_session_config_selectors(&session_new);
        assert_eq!(selectors.len(), 2);
        assert!(selectors[0].is_model());
        assert_eq!(selectors[0].current_group(), Some("cpaapi"));
        assert_eq!(selectors[0].short_current_label(), "Gemini 4 Argon High");
        assert_eq!(
            selectors[0].options[0].group.as_deref(),
            Some("openai-codex")
        );
        assert_eq!(selectors[0].options[0].name, "GPT-5.5");

        assert!(selectors[1].is_thought_level());
        assert_eq!(selectors[1].short_current_label(), "Thinking: high");

        // 模拟收到 current_mode_update
        let mut turn = TurnCollector::default();
        turn.on_update(&json!({
            "sessionUpdate": "current_mode_update",
            "currentModeId": "low"
        }));
        assert!(turn.apply_config_updates(&mut selectors));
        assert_eq!(selectors[1].current_value, "low");
        assert_eq!(selectors[1].short_current_label(), "Thinking: low");
    }

    #[test]
    fn parse_session_config_selectors_falls_back_to_legacy_models_and_modes() {
        let legacy = json!({
            "sessionId": "s-2",
            "models": {
                "currentModelId": "anthropic/claude-sonnet",
                "availableModels": [
                    { "modelId": "anthropic/claude-sonnet", "name": "anthropic/Claude Sonnet" }
                ]
            },
            "modes": {
                "currentModeId": "architect",
                "availableModes": [
                    { "id": "code", "name": "Code" },
                    { "id": "architect", "name": "Architect" }
                ]
            }
        });
        let selectors = parse_session_config_selectors(&legacy);
        assert_eq!(selectors.len(), 2);
        assert_eq!(selectors[0].source, AcpConfigSource::LegacyModel);
        assert_eq!(selectors[0].short_current_label(), "Claude Sonnet");
        assert_eq!(selectors[1].source, AcpConfigSource::LegacyMode);
        assert_eq!(selectors[1].short_current_label(), "Architect");
    }

    #[test]
    fn parse_session_startup_info_and_turn_collector_deduplication() {
        let session_new = json!({
            "sessionId": "s-pi",
            "_meta": {
                "piAcp": {
                    "startupInfo": "pi v1.3.0\n---\n\n## Context\n- /repo/AGENTS.md\n"
                }
            }
        });
        let startup = parse_session_startup_info(&session_new).expect("应解析出 startupInfo");
        assert!(startup.starts_with("pi v1.3.0"));

        // 当 pi-acp 在 setTimeout(..., 0) 中把同一段 startupInfo 作为 agent_message_chunk 重发时，
        // 带 ignored_startup_text 的 TurnCollector 应自动跳过它，不污染真实回复。
        let mut turn = TurnCollector::default().with_ignored_startup_text(Some(startup.clone()));
        turn.on_update(&json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": startup }
        }));
        turn.on_update(&json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "真正的助手回复" }
        }));
        assert_eq!(turn.assemble_body("end_turn"), "真正的助手回复");
    }

    #[test]
    fn parse_commands_from_startup_info_and_available_commands_update() {
        let startup =
            "**pi v1.3.0**\n\n## Skills\n- tdd\n- codebase-design\n\n## Prompts\n- review\n";
        let cmds = parse_commands_from_startup_info(Some(startup));
        assert!(cmds.iter().any(|c| c.name == "skill:tdd"));
        assert!(cmds.iter().any(|c| c.name == "skill:codebase-design"));
        assert!(cmds.iter().any(|c| c.name == "review"));
        assert!(cmds.iter().any(|c| c.name == "compact"));

        let mut turn = TurnCollector::default();
        turn.on_update(&json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": [
                {
                    "name": "skill:tdd",
                    "description": "Test-driven development workflow",
                    "input": { "hint": "feature description" }
                }
            ]
        }));
        let updated = turn.available_commands_snapshot().expect("应捕获命令更新");
        let tdd = updated.iter().find(|c| c.name == "skill:tdd").unwrap();
        assert_eq!(tdd.description, "Test-driven development workflow");
        assert_eq!(tdd.input_hint.as_deref(), Some("feature description"));
    }

    #[test]
    fn session_list_and_session_load_collector_replay_multi_turn_history() {
        let list_resp = json!({
            "sessions": [
                {
                    "sessionId": "sess-001",
                    "cwd": "/work/proj",
                    "title": "修复 ACP 模型切换",
                    "updatedAt": "2026-10-17T08:30:00.000Z"
                }
            ]
        });
        let sessions = parse_session_list(&list_resp);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "sess-001");
        assert_eq!(sessions[0].title.as_deref(), Some("修复 ACP 模型切换"));

        let mut collector = SessionLoadCollector::default();
        collector.on_update(&json!({
            "sessionUpdate": "user_message_chunk",
            "content": { "type": "text", "text": "看看 Cargo.toml" }
        }));
        collector.on_update(&json!({
            "sessionUpdate": "agent_thought_chunk",
            "messageId": "th-1",
            "content": { "type": "text", "text": "先定位清单" }
        }));
        collector.on_update(&json!({
            "sessionUpdate": "agent_thought_chunk",
            "messageId": "th-1",
            "content": { "type": "text", "text": "再读内容" }
        }));
        collector.on_update(&json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "正在读取文件…" }
        }));
        collector.on_update(&json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tc-9",
            "kind": "read",
            "title": "Read Cargo.toml",
            "locations": [{ "path": "Cargo.toml" }],
            "status": "completed"
        }));
        collector.on_update(&json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "读取完成，包含 3 个 workspace 成员。" }
        }));
        let replayed = collector.finish();
        assert_eq!(replayed.len(), 2);
        assert!(replayed[0].is_user);
        assert_eq!(replayed[0].text, "看看 Cargo.toml");
        assert!(!replayed[1].is_user);
        assert_eq!(replayed[0].thought, "");
        assert_eq!(replayed[1].thought, "先定位清单再读内容");
        assert_eq!(
            replayed[1].text,
            "正在读取文件…\n\n读取完成，包含 3 个 workspace 成员。"
        );
        assert_eq!(replayed[1].tool_calls.len(), 1);
        assert_eq!(
            replayed[1].tool_calls[0].path.as_deref(),
            Some("Cargo.toml")
        );
    }
}
