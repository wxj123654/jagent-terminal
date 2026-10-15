//! 对话面（chat / acp 共享）：conv-head + 消息列表（变高 `list`，follow-tail）+ composer。
//!
//! V6 原型对齐（`index.css` 第二段生效值；gpuix `surfaces/ConversationView.tsx`）：
//! - conv-head 44px：avatar 26² surface 块（accent 图标）+ 标题 600 + 右置状态
//!   （done 点 + 「正在回复 / 已连接」）；
//! - 消息区：列表自身 pt 28（窄 22）/ pb 18；每行根撑满居中 → 内列
//!   min(760,100%) 横距 28（窄 18）。行距用 pb（gpui ListState 测行高时行根
//!   margin 不计入自身尺寸，padding 才算——gpuix 走查 D2 坑）；
//! - user 右对齐气泡（max 620 / accentSoft 底 / rgba(97,175,239,.28) 边 /
//!   12·12·3·12 圆角 / 0 1 2 投影）；assistant = mono role 标签（ASSISTANT /
//!   ERROR）+ markdown 正文（14 / 1.65，error 正文换 bell 色）；
//! - thinking：accent 圆点（4px accentSoft 环）+「正在思考…」；
//! - composer：居中 704 列（底 = pane 向上渐隐）；shell（inputBg r12 + 投影，
//!   焦点换 focusBorder 边 + accentSoft 环）内 textarea + 34² accent 箭头钮
//!   （pendingReply → 灰面）；hint 右对齐 faint 10px。
//!
//! 规则在 core（`begin_send` / `finish_send` / `conversation`）；回声后端与延时在 `state::send_chat`。
//! GPUI list 用原生 FollowMode::Tail，并通过 splice / remeasure_items 增量更新，保留上滚阅读锚点。

use std::rc::Rc;

use gpui::{
    AnyElement, AppContext as _, BoxShadow, Context, Entity, Focusable as _, HighlightStyle, Hsla,
    InteractiveElement as _, IntoElement, ListAlignment, ListState, ParentElement as _, Render,
    StatefulInteractiveElement as _, Styled, Window, div, linear_color_stop, linear_gradient, list,
    prelude::FluentBuilder as _, px, rems,
};
use gpui_component::h_flex;
use gpui_component::{
    input::{InputEvent, Textarea, TextareaState},
    text::{TextView, TextViewStyle},
    v_flex,
};
use jagent_core::threads::{ChatMessage, ConversationKind};

use crate::icons::{IconName, icon};
use crate::state::{AppState, StateChanged, send_acp, send_chat};
use crate::theme::{colors, hex, rgba_css};

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
        // 占位符随线程类型（原型：acp = Ask agent… / chat = Ask…）
        let ph = state
            .read(cx)
            .threads
            .conversation(&thread_id)
            .map(|c| placeholder_for(c.kind))
            .unwrap_or("Ask…");
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 6)
                .submit_on_enter(true)
                .placeholder(ph)
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
            Some(ConversationKind::Acp) => send_acp(&self.state, &self.thread_id, &text, cx),
            _ => send_chat(&self.state, &self.thread_id, &text, cx),
        }
        self.input
            .update(cx, |s, cx| s.set_value(String::new(), window, cx));
    }
}

impl Render for ConversationView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (messages, pending, kind) =
            match self.state.read(cx).threads.conversation(&self.thread_id) {
                Some(c) => (c.messages.to_vec(), c.pending, c.kind),
                None => (vec![], false, ConversationKind::Chat),
            };
        // 线程不存在（刚被关掉）时投影按 chat 回退；标题取线程名
        let title = self
            .state
            .read(cx)
            .threads
            .thread(&self.thread_id)
            .map(|t| t.title())
            .unwrap_or_default();
        let narrow = crate::views::root::is_narrow(f32::from(window.viewport_size().width));
        // composer-shell 的 :focus-within 等价：textarea 自报焦点
        let shell_focused = self.input.read(cx).focus_handle(cx).is_focused(window);

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
        let list_el = list(self.list.clone(), move |ix, _, _cx| {
            let row = match rows.get(ix) {
                Some(m) => message_row(m, narrow),
                None => thinking_row(narrow),
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
        .flex_1()
        // .conv-msgs 纵向内距在列表自身（横向在每行 ConvIn——水平 padding 不能放
        // 列表上，list 行根 width:100% 吃的是列表全宽）
        .pt(px(if narrow { 22.0 } else { 28.0 }))
        .pb(px(18.0));

        let this = cx.entity();
        v_flex()
            .size_full()
            .min_w_0()
            .bg(hex(colors::PANE))
            .child(conv_head(kind, &title, pending))
            .child(list_el)
            .child(composer(
                &self.input,
                pending,
                narrow,
                shell_focused,
                this.downgrade(),
            ))
    }
}

// ── conv-head（原型 .conv-head 44px）────────────────────────────────────────

/// 头条：avatar + 标题（600 + 三件套截断）+ 右置状态点。
fn conv_head(kind: ConversationKind, title: &str, pending: bool) -> gpui::Div {
    h_flex()
        .h(px(44.0))
        .flex_shrink_0()
        .gap(px(8.0))
        .px(px(20.0))
        .border_b_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        // .conv-avatar：26² r7 surface 块 + accent 图标（chat/acp 同用 accent）
        .child(
            div()
                .size(px(26.0))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .rounded(px(7.0))
                .bg(hex(colors::SURFACE))
                .child(icon(avatar_icon(kind), 14.0, hex(colors::ACCENT))),
        )
        .child(
            div()
                .min_w_0()
                .flex_shrink_1()
                .text_size(px(13.0))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(hex(colors::TEXT_BRIGHT))
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(title.to_owned()),
        )
        // margin-left:auto 等价
        .child(div().flex_1())
        // .conv-status：done 点 + 状态文案
        .child(
            h_flex()
                .flex_shrink_0()
                .gap(px(6.0))
                .child(
                    div()
                        .size(px(8.0))
                        .rounded(px(9999.0))
                        .bg(hex(colors::STATUS_DONE)),
                )
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(hex(colors::MUTED))
                        .child(status_text(pending)),
                ),
        )
}

// ── 消息行（原型 .conv-msgs-in / .msg）─────────────────────────────────────

/// 消息行下距（原型 .msg margin-bottom 22）
const MSG_ROW_GAP: f32 = 22.0;
/// thinking 行下距（原型 .thinking margin-bottom 16）
const THINKING_ROW_GAP: f32 = 16.0;
/// ConvIn 内列横距：原型 .conv-msgs-in padding 0 28（窄态 18）
fn conv_in_x_padding(narrow: bool) -> f32 {
    if narrow { 18.0 } else { 28.0 }
}

/// 居中列槽：行根撑满居中 → 内列 min(760,100%) 横距 28（窄 18）。
/// 行距用 `pad_bottom`（padding），margin 在 gpui ListState 测行高时不计入。
fn conv_in(narrow: bool, pad_bottom: f32, child: impl IntoElement) -> gpui::Div {
    div()
        .w_full()
        .flex_shrink_0()
        .flex()
        .justify_center()
        .pb(px(pad_bottom))
        .child(
            div()
                .w_full()
                .max_w(px(760.0))
                .px(px(conv_in_x_padding(narrow)))
                .flex()
                .flex_col()
                .child(child),
        )
}

/// 单条消息行：user 右对齐气泡 / assistant 左对齐 role 标签 + markdown。
fn message_row(m: &ChatMessage, narrow: bool) -> AnyElement {
    if m.is_user() {
        let bubble = user_bubble(&m.text);
        return conv_in(
            narrow,
            MSG_ROW_GAP,
            div().w_full().flex().justify_end().child(bubble),
        )
        .into_any_element();
    }
    let body = div()
        .w_full()
        .flex()
        .flex_col()
        // .msg .role：mono 10 600（error → bell），mb 7
        .child(
            div()
                .mb(px(7.0))
                .font_family("monospace")
                .text_size(px(10.0))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(if m.is_error() {
                    hex(colors::BELL)
                } else {
                    hex(colors::TERMINAL_KIND)
                })
                .child(role_label(m.is_error())),
        )
        .child(markdown_body(m));
    conv_in(narrow, MSG_ROW_GAP, body).into_any_element()
}

/// user 气泡（原型 .msg.user .bubble）：max 620 / accentSoft 底 /
/// rgba(97,175,239,.28) 边 / 12·12·3·12 圆角 / 0 1 2 投影；换行拆多段 text。
fn user_bubble(text: &str) -> gpui::Div {
    div()
        .max_w(px(620.0))
        .flex()
        .flex_col()
        .rounded_tl(px(12.0))
        .rounded_tr(px(12.0))
        .rounded_br(px(3.0))
        .rounded_bl(px(12.0))
        .border_1()
        .border_color(rgba_css(97, 175, 239, 0.28))
        .bg(rgba_css(97, 175, 239, 0.15))
        .py(px(10.0))
        .px(px(14.0))
        .shadow(bubble_shadow())
        .children(text.split('\n').map(|line| {
            div()
                .text_size(px(14.0))
                .line_height(px(21.0))
                .text_color(hex(colors::TEXT_BRIGHT))
                .child(if line.is_empty() {
                    " ".to_owned()
                } else {
                    line.to_owned()
                })
        }))
}

/// assistant 正文（.msg .body）：max 700 / 14 / 1.65；error 换 bell。
fn markdown_body(m: &ChatMessage) -> TextView {
    let md_style = TextViewStyle::default()
        // 原型 p/ul margin 6+6 相邻合并 = 12px（gpui rem 基准 16）
        .paragraph_gap(rems(0.75))
        // pre：#15181d 底 + borderSubtle 边 + r8 + 13·14 内距
        .code_block(
            gpui::StyleRefinement::default()
                .bg(hex("#15181d"))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .rounded(px(8.0))
                .py(px(13.0))
                .px(px(14.0)),
        )
        // inline code：inputBg 底
        .inline_code(HighlightStyle {
            background_color: Some(hex(colors::INPUT_BG)),
            ..Default::default()
        });
    TextView::markdown(m.id.clone(), m.text.clone())
        .max_w(px(700.0))
        .text_size(px(14.0))
        .line_height(px(23.1))
        .text_color(if m.is_error() {
            hex(colors::BELL)
        } else {
            hex(colors::TEXT)
        })
        .style(md_style)
}

/// thinking 占位行（原型 .thinking）：accent 圆点 + 4px accentSoft 环。
fn thinking_row(narrow: bool) -> AnyElement {
    let dot = div()
        .size(px(7.0))
        .flex_shrink_0()
        .rounded(px(9999.0))
        .bg(hex(colors::ACCENT))
        .shadow(thinking_dot_shadow());
    conv_in(
        narrow,
        THINKING_ROW_GAP,
        h_flex().gap(px(8.0)).child(dot).child(
            div()
                .text_size(px(12.0))
                .text_color(hex(colors::MUTED))
                .child("正在思考…"),
        ),
    )
    .into_any_element()
}

// ── composer（原型 .composer / .composer-shell / .send-btn）────────────────

/// 输入区：居中 704 列；底 = pane 向上渐隐（linear-gradient(to top, pane 75%, transparent)）。
fn composer(
    input: &Entity<TextareaState>,
    pending: bool,
    narrow: bool,
    shell_focused: bool,
    this: gpui::WeakEntity<ConversationView>,
) -> gpui::Div {
    div()
        .flex_shrink_0()
        .flex()
        .flex_col()
        .items_center()
        .pt(px(10.0))
        .pb(px(14.0))
        .pl(px(if narrow { 14.0 } else { 20.0 }))
        .pr(px(if narrow { 14.0 } else { 20.0 }))
        .bg(composer_bg())
        .child(
            v_flex()
                .w_full()
                .max_w(px(704.0))
                .gap(px(6.0))
                // .composer-shell：inputBg r12 盒（textarea + send 钮）
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_end()
                        .gap(px(8.0))
                        .pt(px(7.0))
                        .pb(px(7.0))
                        .pl(px(12.0))
                        .pr(px(7.0))
                        .border_1()
                        .border_color(if shell_focused {
                            hex(colors::FOCUS_BORDER)
                        } else {
                            hex(colors::BORDER_SUBTLE)
                        })
                        .rounded(px(12.0))
                        .bg(hex(colors::INPUT_BG))
                        .shadow(composer_shadow(shell_focused))
                        // textarea：透明无框，13/18，min-h 32（7+18+7）
                        .child(
                            Textarea::new(input)
                                .appearance(false)
                                .flex_1()
                                .min_h(px(32.0))
                                .text_size(px(13.0))
                                .line_height(px(18.0))
                                .py(px(7.0))
                                .px(px(2.0))
                                .text_color(hex(colors::TEXT_BRIGHT)),
                        )
                        // .send-btn：34² accent 箭头钮；pending → 灰面
                        .child(send_button(pending, this)),
                )
                // .composer-hint：右对齐 faint 10px
                .child(
                    div().w_full().flex().justify_end().px(px(4.0)).child(
                        div()
                            .text_size(px(10.0))
                            .text_color(hex(colors::FAINT))
                            .child("Enter 发送 · Shift + Enter 换行"),
                    ),
                ),
        )
}

/// 发送钮（原型 .send-btn 34² / r8 / accent 底 + #17202a 深字箭头；
/// pending → surface 底 / borderSubtle 边 / muted 箭头）。
fn send_button(
    pending: bool,
    this: gpui::WeakEntity<ConversationView>,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id("chat-send")
        .flex()
        .items_center()
        .justify_center()
        .size(px(34.0))
        .flex_shrink_0()
        .border_1()
        .rounded(px(8.0))
        .border_color(if pending {
            hex(colors::BORDER_SUBTLE)
        } else {
            hex(colors::ACCENT)
        })
        .bg(if pending {
            hex(colors::SURFACE)
        } else {
            hex(colors::ACCENT)
        })
        .when(!pending, |d| d.hover(|h| h.bg(hex(colors::ACCENT_HOVER))))
        .child(icon(
            IconName::ArrowRight,
            15.0,
            if pending {
                hex(colors::MUTED)
            } else {
                hex("#17202a")
            },
        ))
        .on_click(move |_, window, cx| {
            let _ = this.update(cx, |v, cx| v.send(window, cx));
        })
}

// ── 可测的映射 / 投影常量 ────────────────────────────────────────────────────

/// composer 底渐变：原型 `linear-gradient(to top, var(--pane) 75%, transparent)`。
fn composer_bg() -> gpui::Background {
    let mut transparent_pane = hex(colors::PANE);
    transparent_pane.a = 0.0;
    linear_gradient(
        0.0, // to top
        linear_color_stop(hex(colors::PANE), 0.75),
        linear_color_stop(transparent_pane, 1.0),
    )
}

/// composer-shell 投影。原型 :focus-within 是双阴影（3px accentSoft 环 + 下落影），
/// gpui 单阴影取环；非焦点 = `0 8px 24px rgba(0,0,0,.2)` 下落影。
fn composer_shadow(focused: bool) -> Vec<BoxShadow> {
    if focused {
        vec![BoxShadow::new(px(0.0), px(0.0), accent_soft()).spread_radius(px(3.0))]
    } else {
        vec![BoxShadow::new(px(0.0), px(8.0), black(0.2)).blur_radius(px(24.0))]
    }
}

/// user 气泡投影：`0 1px 2px rgba(0,0,0,.2)`。
fn bubble_shadow() -> Vec<BoxShadow> {
    vec![BoxShadow::new(px(0.0), px(1.0), black(0.2)).blur_radius(px(2.0))]
}

/// thinking 圆点环：`0 0 0 4px var(--accentSoft)`。
fn thinking_dot_shadow() -> Vec<BoxShadow> {
    vec![BoxShadow::new(px(0.0), px(0.0), accent_soft()).spread_radius(px(4.0))]
}

/// accentSoft = rgba(97,175,239,.15)（旧 tokens）。
fn accent_soft() -> Hsla {
    rgba_css(97, 175, 239, 0.15)
}

fn black(a: f32) -> Hsla {
    gpui::hsla(0.0, 0.0, 0.0, a)
}

/// 占位符随线程类型（原型 ConversationView 的 ph）。
fn placeholder_for(kind: ConversationKind) -> &'static str {
    match kind {
        ConversationKind::Acp => "Ask agent…",
        ConversationKind::Chat => "Ask…",
    }
}

/// conv-avatar 图标：chat = agent / acp = acp（色恒 accent，不换紫）。
fn avatar_icon(kind: ConversationKind) -> IconName {
    match kind {
        ConversationKind::Acp => IconName::Acp,
        ConversationKind::Chat => IconName::Agent,
    }
}

/// 状态点旁的文案（pendingReply → 正在回复）。
fn status_text(pending: bool) -> &'static str {
    if pending { "正在回复" } else { "已连接" }
}

/// assistant role 标签（error → ERROR）。
fn role_label(error: bool) -> &'static str {
    if error { "ERROR" } else { "ASSISTANT" }
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
                // vec![1..2] = 重测下标 1 这一行；collect 写法反而掩盖意图
                #[allow(clippy::single_range_in_vec_init)]
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

    // ── V6 布局 / 投影对齐 ──────────────────────────────────────────────

    /// 占位符 / 头像 / 状态文案 / role 标签随线程类型与 pending 变化
    #[test]
    fn mapping_helpers_follow_the_prototype_text() {
        assert_eq!(placeholder_for(ConversationKind::Acp), "Ask agent…");
        assert_eq!(placeholder_for(ConversationKind::Chat), "Ask…");
        assert_eq!(avatar_icon(ConversationKind::Chat), IconName::Agent);
        assert_eq!(avatar_icon(ConversationKind::Acp), IconName::Acp);
        assert_eq!(status_text(true), "正在回复");
        assert_eq!(status_text(false), "已连接");
        assert_eq!(role_label(true), "ERROR");
        assert_eq!(role_label(false), "ASSISTANT");
    }

    /// composer 投影：焦点 = 3px accentSoft 环；非焦点 = 0 8 24 黑 20% 下落影
    #[test]
    fn composer_shadow_swaps_between_focus_ring_and_drop_shadow() {
        let focused = composer_shadow(true);
        assert_eq!(focused.len(), 1);
        let f: gpui::Rgba = focused[0].color.into();
        assert!((f.a - 0.15).abs() < 1e-6, "焦点环用 accentSoft");
        assert_eq!(focused[0].spread_radius, px(3.0));
        assert_eq!(focused[0].blur_radius, px(0.0));

        let idle = composer_shadow(false);
        assert_eq!(idle.len(), 1);
        assert_eq!(idle[0].offset.y, px(8.0));
        assert_eq!(idle[0].blur_radius, px(24.0));
        assert_eq!(idle[0].spread_radius, px(0.0));
    }

    /// 气泡 / thinking 点投影值 = 原型字面量
    #[test]
    fn bubble_and_thinking_dot_shadows_match_the_css_literals() {
        let b = bubble_shadow();
        assert_eq!((b[0].offset.y, b[0].blur_radius), (px(1.0), px(2.0)));
        let t = thinking_dot_shadow();
        assert_eq!(t[0].spread_radius, px(4.0));
        assert_eq!(t[0].blur_radius, px(0.0));
    }

    /// composer 底渐变：to top（angle 0），pane 75% → 透明
    #[test]
    fn composer_gradient_is_a_non_solid_fade() {
        let bg = composer_bg();
        // Background 内部字段私有：只能断言不是纯色（渐变路径）且不透明端可见
        assert!(bg.as_solid().is_none(), "渐变背景不应退化为纯色");
        assert!(!bg.is_transparent());
    }

    /// ConvIn 内距：宽屏 28 / 窄屏 18；消息行距 22、thinking 16
    #[test]
    fn conv_padding_constants_match_the_prototype() {
        // 值即布局契约本身，防回归改错
        assert_eq!(conv_in_x_padding(false), 28.0);
        assert_eq!(conv_in_x_padding(true), 18.0);
        assert_eq!(MSG_ROW_GAP, 22.0);
        assert_eq!(THINKING_ROW_GAP, 16.0);
    }
}
