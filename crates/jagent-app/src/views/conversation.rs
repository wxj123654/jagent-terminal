//! 对话面（chat）：消息列表（变高 `list`，follow-tail）+ composer。对应旧 `surfaces/ConversationView.tsx` 的 chat 路径。
//!
//! 规则在 core（`begin_send` / `finish_send` / `conversation`）；回声后端与延时在 `state::send_chat`。
//! GPUI list 用原生 FollowMode::Tail，并通过 splice / remeasure_items 增量更新，保留上滚阅读锚点。

use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, InteractiveElement, IntoElement,
    ListAlignment, ListState, ParentElement, Render, Styled, Window, div, list,
    prelude::FluentBuilder as _, px,
};
use gpui_component::{
    ActiveTheme, Disableable as _,
    button::{Button, ButtonVariants as _},
    input::{InputEvent, Textarea, TextareaState},
    v_flex,
};
use jagent_core::threads::{ChatMessage, MessageRole};

use crate::state::{AppState, StateChanged, send_acp, send_chat};

pub struct ConversationView {
    state: Entity<AppState>,
    thread_id: String,
    input: Entity<TextareaState>,
    list: ListState,
    /// 上一帧消息快照；只增量替换/重测变更条目，保留 GPUI list 的 scroll anchor。
    rendered_messages: Vec<(String, String)>,
    rendered_pending: bool,
    scrolled_away_from_tail: std::rc::Rc<std::cell::Cell<bool>>,
}

impl ConversationView {
    pub fn new(
        state: Entity<AppState>,
        thread_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 6)
                .submit_on_enter(true)
        });
        cx.subscribe_in(&input, window, |this, _, ev: &InputEvent, window, cx| {
            if matches!(ev, InputEvent::PressEnter { shift: false, .. }) {
                this.send(window, cx);
            }
        })
        .detach();
        cx.subscribe(&state, |_, _, _: &StateChanged, cx| cx.notify())
            .detach();
        Self {
            state,
            thread_id,
            input,
            list: {
                let list = ListState::new(0, ListAlignment::Top, px(480.0));
                list.set_follow_mode(gpui::FollowMode::Tail);
                list
            },
            rendered_messages: vec![],
            rendered_pending: false,
            scrolled_away_from_tail: std::rc::Rc::new(std::cell::Cell::new(false)),
        }
    }

    /// 发送。等待中或空白时不动输入框，保留用户已写的内容。
    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let pending = self
            .state
            .read(cx)
            .threads
            .conversation(&self.thread_id)
            .is_some_and(|c| c.pending);
        let text = self.input.read(cx).value().to_string();
        if pending || text.trim().is_empty() {
            return;
        }
        // 按线程类型分派：chat → 本地回声；acp → 子进程
        let kind = self
            .state
            .read(cx)
            .threads
            .conversation(&self.thread_id)
            .map(|c| c.kind);
        match kind {
            Some(jagent_core::threads::ConversationKind::Acp) => {
                send_acp(&self.state, &self.thread_id, &text, cx)
            }
            _ => send_chat(&self.state, &self.thread_id, &text, cx),
        }
        self.input
            .update(cx, |s, cx| s.set_value(String::new(), window, cx));
    }
}

impl Render for ConversationView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (messages, pending) = match self.state.read(cx).threads.conversation(&self.thread_id) {
            Some(c) => (c.messages.to_vec(), c.pending),
            None => (vec![], false),
        };

        let snapshot: Vec<_> = messages
            .iter()
            .map(|m| (m.id.clone(), m.text.clone()))
            .collect();
        if snapshot != self.rendered_messages || pending != self.rendered_pending {
            let plan = plan_list_update(
                &self.rendered_messages,
                self.rendered_pending,
                &snapshot,
                pending,
            );
            if plan.replace_old.start != plan.replace_old.end || plan.insert_count > 0 {
                self.list.splice(plan.replace_old, plan.insert_count);
            }
            for range in plan.remeasure {
                self.list.remeasure_items(range);
            }
            if !self.scrolled_away_from_tail.get() {
                self.list.set_follow_mode(gpui::FollowMode::Tail);
            }
            self.rendered_messages = snapshot;
            self.rendered_pending = pending;
        }

        let rows = Rc::new(messages);
        let list_for_scroll = self.list.clone();
        let scrolled_away_from_tail = self.scrolled_away_from_tail.clone();
        let list_el = list(self.list.clone(), move |ix, _, cx| {
            let row = match rows.get(ix) {
                Some(m) => message_row(m, cx),
                None => thinking_row(cx),
            };
            let list = list_for_scroll.clone();
            let scrolled_away_from_tail = scrolled_away_from_tail.clone();
            div()
                .on_scroll_wheel(move |event: &gpui::ScrollWheelEvent, window, _cx| {
                    let dy = f32::from(event.delta.pixel_delta(window.line_height()).y);
                    if dy > 0.0 {
                        list.pause_following_tail();
                        scrolled_away_from_tail.set(true);
                    } else if dy < 0.0 && list.is_scrolled_to_end() == Some(true) {
                        list.set_follow_mode(gpui::FollowMode::Tail);
                        scrolled_away_from_tail.set(false);
                    }
                })
                .child(row)
                .into_any_element()
        })
        .flex_1();

        let this = cx.entity();
        v_flex().size_full().child(list_el).child(
            div()
                .flex()
                .flex_row()
                .gap_2()
                .p_3()
                .child(div().flex_1().min_w_0().child(Textarea::new(&self.input)))
                .child(
                    Button::new("chat-send")
                        .primary()
                        .label("发送")
                        .disabled(pending)
                        .on_click(move |_, window, cx| {
                            this.update(cx, |v, cx| v.send(window, cx));
                        }),
                ),
        )
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ListUpdatePlan {
    replace_old: std::ops::Range<usize>,
    insert_count: usize,
    remeasure: Vec<std::ops::Range<usize>>,
}

/// Minimal contiguous splice around structural changes; unchanged prefix/suffix (including
/// the current scroll anchor) remain in the GPUI list's sum tree.
fn plan_list_update(
    old: &[(String, String)],
    old_pending: bool,
    new: &[(String, String)],
    new_pending: bool,
) -> ListUpdatePlan {
    let old_len = old.len() + usize::from(old_pending);
    let new_len = new.len() + usize::from(new_pending);
    let same_identity = |old_ix: usize, new_ix: usize| -> bool {
        match (old.get(old_ix), new.get(new_ix)) {
            (Some((old_id, _)), Some((new_id, _))) => old_id == new_id,
            (None, None) => {
                old_pending && new_pending && old_ix == old.len() && new_ix == new.len()
            }
            _ => false,
        }
    };
    let mut prefix = 0;
    while prefix < old_len.min(new_len) && same_identity(prefix, prefix) {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < old_len - prefix
        && suffix < new_len - prefix
        && same_identity(old_len - suffix - 1, new_len - suffix - 1)
    {
        suffix += 1;
    }

    let mut remeasure = Vec::new();
    for ix in 0..prefix {
        if let (Some((old_id, old_text)), Some((new_id, new_text))) = (old.get(ix), new.get(ix))
            && old_id == new_id
            && old_text != new_text
        {
            remeasure.push(ix..ix + 1);
        }
    }
    for offset in 0..suffix {
        let old_ix = old_len - suffix + offset;
        let new_ix = new_len - suffix + offset;
        if let (Some((old_id, old_text)), Some((new_id, new_text))) =
            (old.get(old_ix), new.get(new_ix))
            && old_id == new_id
            && old_text != new_text
        {
            remeasure.push(new_ix..new_ix + 1);
        }
    }
    ListUpdatePlan {
        replace_old: prefix..old_len - suffix,
        insert_count: new_len - prefix - suffix,
        remeasure,
    }
}

fn message_row(m: &ChatMessage, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let is_user = matches!(m.role, MessageRole::User);
    let content = if is_user {
        div()
            .max_w(px(560.0))
            .px_3()
            .py_2()
            .rounded(px(10.0))
            .bg(theme.secondary)
            .child(m.text.clone())
            .into_any_element()
    } else if m.is_error() {
        div()
            .max_w(px(640.0))
            .px_3()
            .py_2()
            .rounded(px(8.0))
            .border_1()
            .border_color(theme.danger)
            .text_color(theme.danger)
            .child(gpui_component::text::markdown(m.text.clone()))
            .into_any_element()
    } else {
        div()
            .max_w(px(640.0))
            .px_3()
            .py_2()
            .text_color(theme.foreground)
            .child(gpui_component::text::markdown(m.text.clone()))
            .into_any_element()
    };
    div()
        .w_full()
        .py_1()
        .px_3()
        .flex()
        .when(is_user, |d| d.justify_end())
        .child(content)
        .into_any_element()
}

fn thinking_row(cx: &App) -> AnyElement {
    div()
        .w_full()
        .py_1()
        .px_3()
        .text_color(cx.theme().muted_foreground)
        .child("…")
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, text: &str) -> (String, String) {
        (id.into(), text.into())
    }

    #[test]
    fn appending_a_message_only_inserts_after_existing_scroll_anchor() {
        let old = vec![msg("u1", "question"), msg("a1", "answer")];
        let new = vec![
            msg("u1", "question"),
            msg("a1", "answer"),
            msg("u2", "next"),
        ];
        assert_eq!(
            plan_list_update(&old, false, &new, false),
            ListUpdatePlan {
                replace_old: 2..2,
                insert_count: 1,
                remeasure: vec![],
            }
        );
    }

    #[test]
    fn streaming_growth_remeasures_only_the_changed_row_and_never_resets_the_list() {
        let old = vec![msg("u1", "question"), msg("a1", "hel")];
        let new = vec![msg("u1", "question"), msg("a1", "hello\nworld")];
        assert_eq!(
            plan_list_update(&old, false, &new, false),
            ListUpdatePlan {
                replace_old: 2..2,
                insert_count: 0,
                remeasure: vec![1..2],
            }
        );
    }

    #[test]
    fn scrolled_reader_pauses_tail_and_returns_to_follow_mode_at_bottom() {
        let state = ListState::new(40, ListAlignment::Top, px(480.0));
        state.set_follow_mode(gpui::FollowMode::Tail);
        assert!(state.is_following_tail());
        state.pause_following_tail();
        assert!(!state.is_following_tail());
        state.set_follow_mode(gpui::FollowMode::Tail);
        assert!(
            state.is_following_tail(),
            "explicit return to bottom resumes tail following"
        );
    }

    #[test]
    fn pending_placeholder_is_incrementally_inserted_and_removed() {
        let rows = vec![msg("u1", "question")];
        assert_eq!(
            plan_list_update(&rows, false, &rows, true),
            ListUpdatePlan {
                replace_old: 1..1,
                insert_count: 1,
                remeasure: vec![],
            }
        );
        assert_eq!(
            plan_list_update(&rows, true, &rows, false),
            ListUpdatePlan {
                replace_old: 1..2,
                insert_count: 0,
                remeasure: vec![],
            }
        );
    }
}
