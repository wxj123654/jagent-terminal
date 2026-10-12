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

use serde_json::{Value, json};

/// 一次 prompt turn 的收集器（`session/update` → 拼装 → prompt 响应后定稿）。
#[derive(Debug, Default)]
pub struct TurnCollector {
    text_parts: Vec<String>,
    current_msg_id: Option<String>,
    /// toolCallId → 摘要（按出现序见 `tool_order`）
    tools: HashMap<String, ToolRow>,
    tool_order: Vec<String>,
}

#[derive(Debug, Default, Clone)]
struct ToolRow {
    kind: Option<String>,
    title: Option<String>,
    status: Option<String>,
}

fn str_of(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

impl TurnCollector {
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
                let mid = str_of(u, "messageId");
                if let (Some(mid), Some(cur)) = (&mid, &self.current_msg_id)
                    && mid != cur
                {
                    self.text_parts.push("\n\n".into()); // 新消息 → 新段落
                }
                if mid.is_some() {
                    self.current_msg_id = mid;
                }
                self.text_parts.push(text.to_owned());
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
            }
            // user_message_chunk（本地已落列）/ thought / plan / usage 等忽略
            _ => {}
        }
    }

    /// 当前已收到的流式正文（尚未加入 tool 汇总与停止原因），用于 UI 实时追加。
    pub fn text_snapshot(&self) -> String {
        self.text_parts.concat()
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

/// `session/prompt` 的参数。
pub fn prompt_params(session_id: &str, text: &str) -> Value {
    json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] })
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
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"想想"}}}}"#,
                r#"{"method":"session/update","params":{"update":{"sessionUpdate":"plan","entries":[]}}}"#,
                r#"{"method":"session/update","params":{"update":{"noKind":true}}}"#,
            ],
        );
        assert_eq!(t.assemble("end_turn"), "（turn 结束，无输出）");
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
}
