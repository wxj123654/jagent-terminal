//! 通知中心浮层（V2 · D8 规范）：侧栏脚铃铛锚定，向上弹出。
//!
//! 数据是 core `ThreadStore::notices`（BEL / 退出 / 回复完成等事件落列，容量 50
//! 丢最旧，不持久化）——比原型 `seed.ts` 的静态 mock 更真。本层只做投影（倒序 +
//! 相对时间）与渲染；「全部已读」「点条目跳转」的规则在 core
//! （`mark_notices_read` / `open_notice`），经 [`NotifSlot`] 回调交给装配层。
//!
//! 像素契约 = 原型 `.notif-pop`（index.css，R9 增补后）：
//! - 壳 min-w 300 / max-w 320，overlay 底 + borderSubtle 1px + r12（--radius-lg）
//!   + shadow `0 14px 38px rgba(0,0,0,.5)`；
//! - 头：12/600「通知」+「全部已读」（check 12）；列表 max-h 300 滚动；
//! - 条目：6px 语气点（ok=done 绿 / warn=running 琥珀 / err=error 红）+
//!   标题 12px + 副 10.5px faint「{sub} · {rel}」。
//!
//! 锚定：`gpui_base::Popover`（`Anchor::BottomLeft` = 弹在 trigger 上方左对齐，
//! offset 10 对应原型 `side="top" align="start" sideOffset={10}`）。V5 起壳走
//! 统一浮层 [`crate::views::popup::overlay_shell`]，触发器走公开 API 薄适配
//! [`crate::views::popup::PopupTrigger`]；deferred 绘制 / occlude / 点外关闭 /
//! Esc 都由 Popover 内建。

use std::rc::Rc;

use gpui::{
    App, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled,
    Window, div, prelude::FluentBuilder as _, px,
};
use gpui_base::Popover;
use jagent_core::threads::{NoticeTone, SessionNotice};

use crate::icons::{IconName, icon};
use crate::theme::{colors, hex};
use crate::views::popup::{PopupTrigger, overlay_shell};
use crate::views::selectable::sel_text_id;

type OpenFn = Rc<dyn Fn(&str, &mut Window, &mut App)>;
type ReadAllFn = Rc<dyn Fn(&mut Window, &mut App)>;

/// 相对时间（原型 `model.ts` 的 `relTime`：刚刚 / N 分钟前 / N 小时前 / N 天前）。
/// 纯函数——`now` 由调用方传入，便于测试。
pub fn rel_time(at_ms: i64, now_ms: i64) -> String {
    let s = (now_ms - at_ms).max(0) / 1000;
    if s < 60 {
        return "刚刚".into();
    }
    if s < 3600 {
        return format!("{} 分钟前", s / 60);
    }
    if s < 86400 {
        return format!("{} 小时前", s / 3600);
    }
    format!("{} 天前", s / 86400)
}

/// 一条通知的展示数据（相对时间在投影时定格，列表期不跳动）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotifModel {
    pub id: String,
    pub tone: NoticeTone,
    pub title: String,
    /// 副文案（工作区名 · 原因），core 已拼好
    pub sub: String,
    pub rel: String,
}

/// 从 core 通知流投影：倒序（新在上）+ 相对时间。
pub fn notif_models(notices: &[SessionNotice], now_ms: i64) -> Vec<NotifModel> {
    notices
        .iter()
        .rev()
        .map(|n| NotifModel {
            id: n.id.clone(),
            tone: n.tone,
            title: n.text.clone(),
            sub: n.sub.clone(),
            rel: rel_time(n.at, now_ms),
        })
        .collect()
}

/// 装配层注入侧栏的通知槽：投影数据 + 未读数（画徽标）+ 两个动作回调。
pub struct NotifSlot {
    pub models: Vec<NotifModel>,
    /// 铃铛红点的水位（core `unread_notice_count`）
    pub unread: usize,
    pub on_open: OpenFn,
    pub on_read_all: ReadAllFn,
}

/// 铃铛 + 通知浮层（原型 Sidebar 脚 `.ibtn` + `Pop.notif-pop`）。
/// 返回的元素直接作为侧栏脚的铃铛槽位；点击触发，向上弹出。
pub fn bell_popover(slot: NotifSlot) -> impl IntoElement {
    let unread = slot.unread;
    Popover::new("notif-popover")
        .anchor(gpui::Anchor::BottomLeft)
        .offset(px(10.0))
        .trigger(PopupTrigger::new(move |is_open| {
            bell_trigger(is_open, unread).into_any_element()
        }))
        .content(move |_, _, _| notif_panel(&slot).into_any_element())
}

fn bell_trigger(is_open: bool, unread: usize) -> impl IntoElement {
    // 原型 `.ibtn`：28×28 r8 muted；hover surface + 提亮；浮层开着时保持提亮
    div()
        .id("open-notifications")
        .relative()
        .flex()
        .items_center()
        .justify_center()
        .size(px(28.0))
        .rounded(px(8.0))
        .flex_shrink_0()
        .cursor_pointer()
        .hover(|h| h.bg(hex(colors::SURFACE)))
        .child(icon(
            IconName::Bell,
            16.0,
            if is_open {
                hex(colors::TEXT_BRIGHT)
            } else {
                hex(colors::MUTED)
            },
        ))
        // 原型 `.badge-dot`：7px 点 + 1.5px sidebar 描边（10px 盒，右下 2.5）
        .when(unread > 0, |d| {
            d.child(
                div()
                    .absolute()
                    .right(px(2.5))
                    .top(px(2.5))
                    .size(px(10.0))
                    .rounded_full()
                    .bg(hex(colors::STATUS_ERROR))
                    .border_1()
                    .border_color(hex(colors::SIDEBAR)),
            )
        })
}

/// 浮层本体（壳 + 头 + 列表）。无内部状态，直接以函数产出元素树。
fn notif_panel(slot: &NotifSlot) -> impl IntoElement {
    let on_read_all = slot.on_read_all.clone();
    let unread = slot.unread;
    let head = div()
        .id("notif-head")
        .flex()
        .flex_row()
        .items_center()
        .pt(px(10.0))
        .pr(px(8.0))
        .pb(px(8.0))
        .pl(px(12.0))
        .border_b_1()
        .border_color(hex(colors::BORDER))
        .child(
            div()
                .flex_1()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .child(
                    div()
                        .text_size(px(12.0))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .child("通知中心"),
                )
                .when(unread > 0, |d| {
                    d.child(
                        div()
                            .px(px(6.0))
                            .rounded_full()
                            .bg(crate::theme::accent_alpha(0.16))
                            .border_1()
                            .border_color(crate::theme::accent_alpha(0.35))
                            .font_family("monospace")
                            .text_size(px(10.0))
                            .text_color(hex(colors::ACCENT_HOVER))
                            .child(format!("{unread} 未读")),
                    )
                }),
        )
        // 原型 `.notif-clear`：h20 padding 0 7 gap 4 r4 11px muted；hover surface
        .child(
            div()
                .id("notif-clear")
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .h(px(20.0))
                .pl(px(7.0))
                .pr(px(7.0))
                .rounded(px(4.0))
                .cursor_pointer()
                .hover(|h| h.bg(hex(colors::SURFACE)))
                .child(icon(IconName::Check, 12.0, hex(colors::MUTED)))
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(hex(colors::MUTED))
                        .child("全部已读"),
                )
                .on_click(move |_, w, cx| on_read_all(w, cx)),
        );

    // 浮层自身不滚，列表是唯一滚动区——不是嵌套滚动，直接 overflow_y_scroll
    let list = if slot.models.is_empty() {
        // 原型 `.notif-empty`：11.5 muted 居中
        div()
            .id("notif-list")
            .max_h(px(300.0))
            .overflow_y_scroll()
            .pt(px(4.0))
            .pb(px(4.0))
            .child(
                div()
                    .text_size(px(11.5))
                    .text_color(hex(colors::MUTED))
                    .p(px(14.0))
                    .text_center()
                    .child("暂无通知"),
            )
    } else {
        div()
            .id("notif-list")
            .max_h(px(300.0))
            .overflow_y_scroll()
            .pt(px(4.0))
            .pb(px(4.0))
            .children(slot.models.iter().map(|m| notif_item(m, &slot.on_open)))
    };

    // 原型 `.notif-pop` 壳（统一浮层壳 + notif 特有宽 300–320、无 padding）
    overlay_shell("notif-pop")
        .min_w(px(300.0))
        .max_w(px(320.0))
        .flex()
        .flex_col()
        .child(head)
        .child(list)
}

/// 单条通知（原型 `.notif-item`：6px 语气点 + 12px 标题 + 10.5px 副文案）。
fn notif_item(m: &NotifModel, on_open: &OpenFn) -> impl IntoElement {
    let dot_color = match m.tone {
        NoticeTone::Ok => hex(colors::STATUS_DONE),
        NoticeTone::Warn => hex(colors::STATUS_RUNNING),
        NoticeTone::Err => hex(colors::STATUS_ERROR),
    };
    let id = m.id.clone();
    div()
        .id(gpui::ElementId::Name(format!("notif-item-{}", m.id).into()))
        .flex()
        .flex_row()
        .gap(px(8.0))
        .pt(px(7.0))
        .pr(px(10.0))
        .pb(px(7.0))
        .pl(px(12.0))
        .cursor_pointer()
        .hover(|h| h.bg(hex(colors::SURFACE)))
        .on_click({
            let on_open = on_open.clone();
            move |_, w, cx| on_open(&id, w, cx)
        })
        .child(
            // 语气点：6px，标题行首对齐（原型 margin-top 5 落在 12px 行高的中线上）
            div()
                .size(px(6.0))
                .rounded_full()
                .bg(dot_color)
                .mt(px(5.0))
                .flex_shrink_0(),
        )
        .child(
            div()
                .min_w_0()
                .flex_1()
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(hex(colors::TEXT))
                        .line_height(px(17.0))
                        .child(
                            sel_text_id(
                                gpui::ElementId::Name(format!("notif-title-{}", m.id).into()),
                                m.title.clone(),
                            )
                            .cursor_ibeam(false),
                        ),
                )
                .child(
                    div()
                        .mt(px(2.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .gap(px(6.0))
                        .child(
                            div()
                                .text_size(px(10.5))
                                .text_color(hex(colors::FAINT))
                                .child(
                                    sel_text_id(
                                        gpui::ElementId::Name(format!("notif-sub-{}", m.id).into()),
                                        format!("{} · {}", m.sub, m.rel),
                                    )
                                    .cursor_ibeam(false),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(10.0))
                                .text_color(hex(colors::ACCENT_HOVER))
                                .child("跳转 →"),
                        ),
                ),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use jagent_core::threads::SessionNotice;

    fn notice(id: &str, tone: NoticeTone, at: i64) -> SessionNotice {
        SessionNotice {
            id: id.into(),
            tone,
            text: format!("通知 {id}"),
            sub: "工作区 · BEL".into(),
            at,
            thread_id: "t1".into(),
            read: false,
            view_id: None,
        }
    }

    #[test]
    fn rel_time_follows_the_prototype_tiers() {
        let now = 1_000_000_000i64 * 1_000;
        assert_eq!(rel_time(now - 59_000, now), "刚刚");
        assert_eq!(rel_time(now - 60_000, now), "1 分钟前");
        assert_eq!(rel_time(now - 119_000, now), "1 分钟前", "向下取整");
        assert_eq!(rel_time(now - 3_600_000, now), "1 小时前");
        assert_eq!(rel_time(now - 86_400_000, now), "1 天前");
    }

    #[test]
    fn rel_time_never_shows_the_future() {
        // 时钟回拨 / 抖动：负差按 0 处理
        assert_eq!(rel_time(5_000, 0), "刚刚");
    }

    #[test]
    fn models_are_newest_first_and_carry_the_relative_time() {
        let notices = vec![
            notice("n1", NoticeTone::Warn, 900_000),
            notice("n2", NoticeTone::Ok, 600_000),
            notice("n3", NoticeTone::Err, 300_000),
        ];
        let now = 1_000_000;
        let m = notif_models(&notices, now);
        assert_eq!(
            m.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
            ["n3", "n2", "n1"],
            "倒序：新通知在上"
        );
        assert_eq!(m[0].rel, "11 分钟前");
        assert_eq!(m[0].title, "通知 n3");
    }

    #[test]
    fn empty_notices_project_to_an_empty_list() {
        assert!(notif_models(&[], 0).is_empty());
    }
}
