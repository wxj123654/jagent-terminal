//! 对话（chat / acp）的只读投影，以及 chat 后端的本地回声。
//!
//! 对应旧 `threads/chat.ts` 的 `createEchoAgent`（2026-09-05 拍板：默认本地模拟，ACP / LLM 接入时替换调用点）。

use super::model::{ChatMessage, Thread};
use super::store::ConversationKind;

/// 一段对话的只读投影：UI 直接按它渲染，不复制消息。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Conversation<'a> {
    pub kind: ConversationKind,
    pub messages: &'a [ChatMessage],
    /// agent 回复进行中：发送被禁用，消息尾显示占位
    pub pending: bool,
}

impl<'a> Conversation<'a> {
    /// 终端会话没有对话，返回 `None`。
    pub fn of(thread: &'a Thread) -> Option<Self> {
        match thread {
            Thread::Chat(t) => Some(Self {
                kind: ConversationKind::Chat,
                messages: &t.messages,
                pending: t.pending_reply,
            }),
            Thread::Acp(t) => Some(Self {
                kind: ConversationKind::Acp,
                messages: &t.messages,
                pending: t.pending_reply,
            }),
            Thread::Terminal(_) => None,
        }
    }
}

/// chat 后端的本地回声（文案与旧 `createEchoAgent` 一致；引用前 200 个字符）。
pub fn echo_reply(text: &str) -> String {
    let head: String = text.chars().take(200).collect();
    format!(
        "（echo stub）收到：{head}\n\nchat 后端尚未接线 —— Phase 3+ 换 ACP / LLM adapter，此处只是回声。"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::threads::{ChatThread, ThreadCommon};

    fn chat(pending: bool, messages: Vec<ChatMessage>) -> Thread {
        Thread::Chat(ChatThread {
            id: "c".into(),
            title: "Chat".into(),
            created_at: 0,
            messages,
            pending_reply: pending,
            common: ThreadCommon::default(),
        })
    }

    #[test]
    fn a_chat_thread_projects_its_messages_and_pending_flag() {
        let t = chat(true, vec![]);
        let c = Conversation::of(&t).expect("chat 有对话");
        assert_eq!(c.kind, ConversationKind::Chat);
        assert!(c.pending && c.messages.is_empty());
    }

    #[test]
    fn echo_reply_quotes_at_most_200_characters_and_keeps_the_stub_notice() {
        let r = echo_reply(&"字".repeat(300));
        assert!(r.starts_with("（echo stub）收到："));
        assert_eq!(r.matches('字').count(), 200, "按字符截断，不切坏多字节字符");
        assert!(r.contains("chat 后端尚未接线"));
    }
}
