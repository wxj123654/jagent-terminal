//! 设置页控件（V4 原型对齐）：Toggle / Select / NumberInput / RangeInput / FontSelect。
//!
//! 像素真源：原型 `index.css` 第二段（`.toggle`/`.sel-trig`/`.sel-pop`/`.num-in`/
//! `.rslider`/`.font-trig`/`.font-pop`），gpuix 对应实现（`ui/controls/*`）为
//! 「原型→GPUI 翻译」的样式字典。控件统一 30 高、r8、inputBg 底 + subtle 边，
//! focus/open 时 accent 边。
//!
//! 焦点环：原型 `:focus-visible` 双环（2px pane 间隙 + 2px ring 色带），gpui 无
//! 多层阴影——按 gpuix R10 结论取等宽硬边近似：贴元素 2px spread 的
//! `rgba(97,175,239,.38)` 色带（[`focus_ring`]）。
//!
//! 弹层（Select / FontSelect）用 `gpui_base::Popover`（V5 起与其他浮层同底座）：
//! 触发器走公开 API 薄适配 [`crate::views::popup::PopupTrigger`]，壳走统一
//! [`crate::views::popup::overlay_shell`]；选中行点击后经 `PopoverState::dismiss`
//! 收起；外点关闭 / Esc 内建。选择器是「数据浏览」类浮层（搜索框 / 字身预览
//! / 勾选槽），条目不走 ctx-menu 菜单组件——保留自定义内容。

use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    App, Bounds, Entity, FocusHandle, InteractiveElement as _, IntoElement, MouseButton,
    MouseDownEvent, MouseMoveEvent, ParentElement as _, Pixels, Stateful,
    StatefulInteractiveElement as _, Styled as _, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_base::Popover;
use gpui_component::input::{Input, InputState};

use crate::icons::{IconName, icon};
use crate::theme::{colors, hex, rgba_css};
use crate::views::popup::{PopupTrigger, overlay_shell};
use crate::views::settings::SettingsView;
use crate::views::settings_defs::FontItem;

/// 焦点环（gpuix `focusRing()`：贴元素 2px spread 的 ring 色）。
pub fn focus_ring() -> Vec<gpui::BoxShadow> {
    vec![gpui::BoxShadow::new(px(0.), px(0.), rgba_css(97, 175, 239, 0.38)).spread_radius(px(2.))]
}

/// 菜单行（.sel-item / .font-row：26 高 r4，hover surface）
fn menu_row(id: gpui::SharedString) -> Stateful<gpui::Div> {
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(px(6.0))
        .h(px(26.0))
        .px(px(8.0))
        .rounded(px(4.0))
        .text_size(px(12.0))
        .text_color(hex(colors::TEXT))
        .cursor_pointer()
        .hover(|d| d.bg(hex(colors::SURFACE)))
}

/// 勾选槽（.ck：14 宽，accent 勾）
fn check_slot(checked: bool) -> gpui::Div {
    div().w(px(14.0)).flex_shrink_0().flex().when(checked, |d| {
        d.child(icon(IconName::Check, 12.0, hex(colors::ACCENT)))
    })
}

/// 控件边色：focus/open 时 accent，平时 subtle
fn control_border(active: bool) -> gpui::Hsla {
    if active {
        hex(colors::FOCUS_BORDER)
    } else {
        hex(colors::BORDER_SUBTLE)
    }
}

// ── Toggle（.toggle：34×20 轨道 + 16px knob；关=surfaceHover 轨 + faint 钮，
//    开=accent 轨 + #fff 钮；space/enter 键盘切换）─────────────────────────

pub fn toggle(
    id: gpui::SharedString,
    handle: &FocusHandle,
    focused: bool,
    checked: bool,
    on_toggle: impl Fn(&mut Window, &mut App) + Clone + 'static,
) -> impl IntoElement {
    let on_key = on_toggle.clone();
    div()
        .id(id)
        .track_focus(handle)
        .relative()
        .w(px(34.0))
        .h(px(20.0))
        .flex_shrink_0()
        .rounded_full()
        .cursor_pointer()
        .when(focused, |d| d.shadow(focus_ring()))
        .when(checked, |d| d.bg(hex(colors::ACCENT)))
        .when(!checked, |d| d.bg(hex(colors::SURFACE_HOVER)))
        .child(
            // knob：top 2，左 2 ↔ 左 16（34-16-2），无边框直跳
            div()
                .absolute()
                .top(px(2.0))
                .when(checked, |d| d.left(px(16.0)))
                .when(!checked, |d| d.left(px(2.0)))
                .size(px(16.0))
                .rounded_full()
                .when(checked, |d| d.bg(gpui::white()))
                .when(!checked, |d| d.bg(hex(colors::FAINT))),
        )
        .on_click(move |_, window, cx| on_toggle.clone()(window, cx))
        .on_key_down(move |event, window, cx| {
            if event.keystroke.key == "space" || event.keystroke.key == "enter" {
                cx.stop_propagation();
                on_key(window, cx);
            }
        })
}

// ── SelectField（.sel-trig 220×30 + chevron；.sel-pop min-140 菜单 + 勾选槽）──
//
// options 用 owned Vec：预设「+」默认下拉的选项随 settings 动态变化，
// 不要求调用方构造 'static。

pub fn select_field(
    id: &str,
    value: &str,
    options: Vec<(String, String)>,
    on_select: impl Fn(&str, &mut Window, &mut App) + Clone + 'static,
) -> impl IntoElement {
    let id = id.to_owned();
    let value = value.to_owned();
    let options_for_trigger = options.clone();
    Popover::new(gpui::SharedString::from(id.clone()))
        .anchor(gpui::Anchor::TopLeft)
        .offset(px(4.0))
        .trigger(PopupTrigger::new({
            let id = id.clone();
            let value = value.clone();
            let options_for_trigger = options_for_trigger.clone();
            move |open| {
                // 触发器（.sel-trig：open/focus 时 accent 边；值 12px + chevron muted）
                let label = options_for_trigger
                    .iter()
                    .find(|(v, _)| *v == value)
                    .map(|(_, l)| l.clone())
                    .unwrap_or_else(|| value.clone());
                div()
                    .id(gpui::SharedString::from(format!("{id}-trig")))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .w(px(220.0))
                    .h(px(30.0))
                    .pl(px(10.0))
                    .pr(px(8.0))
                    .rounded(px(8.0))
                    .cursor_pointer()
                    .bg(hex(colors::INPUT_BG))
                    .border_1()
                    .border_color(control_border(open))
                    .hover(|d| d.border_color(hex(colors::FOCUS_BORDER)))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_size(px(12.0))
                            .text_color(hex(colors::TEXT_BRIGHT))
                            .child(label),
                    )
                    .child(icon(IconName::ChevronDown, 12.0, hex(colors::MUTED)))
                    .into_any_element()
            }
        }))
        .content({
            let id = id.clone();
            let value = value.clone();
            let options = Rc::new(options);
            move |_, _, cx| {
                // 选中一项后 dismiss（统一浮层菜单同模式）；
                // 行 on_click 需要 'static：v/value/popover 各自 clone
                let popover = cx.entity();
                let mut surface = overlay_shell("sel-pop").min_w(px(140.0)).p(px(4.0));
                for (v, l) in options.iter() {
                    let on_select = on_select.clone();
                    let popover = popover.clone();
                    let selected = v == &value;
                    let v = v.clone();
                    surface = surface.child(
                        menu_row(gpui::SharedString::from(format!("{id}-item-{v}")))
                            .child(check_slot(selected))
                            .child(div().child(l.clone()))
                            .on_click(move |_, window, cx| {
                                cx.stop_propagation();
                                on_select(&v, window, cx);
                                popover.update(cx, |s, cx| s.dismiss(window, cx));
                            }),
                    );
                }
                surface.into_any_element()
            }
        })
}

// ── NumberInput（.num-in 76×30 + 自绘步进列 18 宽；↑/↓ 钮步进）─────────────

pub fn number_input(
    id: &str,
    state: &Entity<InputState>,
    focused: bool,
    on_nudge: impl Fn(i64, &mut Window, &mut App) + Clone + 'static,
) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .w(px(76.0))
        .h(px(30.0))
        .flex_shrink_0()
        .rounded(px(8.0))
        .bg(hex(colors::INPUT_BG))
        .border_1()
        .border_color(control_border(focused))
        .when(focused, |d| d.shadow(focus_ring()))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .h_full()
                .pl(px(8.0))
                .pr(px(4.0))
                .child(
                    Input::new(state)
                        .appearance(false)
                        .h_full()
                        .text_size(px(12.0)),
                ),
        )
        .child(
            // 步进列（gpuix NumberInput：18 宽，↑/↓ 各占半，hover surfaceHover）
            div()
                .flex()
                .flex_col()
                .w(px(18.0))
                .self_stretch()
                .flex_shrink_0()
                .child(stepper_button(
                    gpui::SharedString::from(format!("{id}-inc")),
                    IconName::ChevronUp,
                    on_nudge.clone(),
                ))
                .child(stepper_button(
                    gpui::SharedString::from(format!("{id}-dec")),
                    IconName::ChevronDown,
                    on_nudge,
                )),
        )
}

fn stepper_button(
    id: gpui::SharedString,
    ic: IconName,
    on_nudge: impl Fn(i64, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let up = matches!(ic, IconName::ChevronUp);
    div()
        .id(id)
        .flex_1()
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .hover(|d| d.bg(hex(colors::SURFACE_HOVER)))
        .child(icon(ic, 10.0, hex(colors::MUTED)))
        .on_click(move |_, window, cx| on_nudge(if up { 1 } else { -1 }, window, cx))
}

// ── RangeInput（.rslider 200×18 hit / 3px 轨 / 13px thumb + .range-val）────
//
// 拖拽语义同 gpuix：mouseDown 即跳到点击比例位；move 仅在按下且 hover 时生效
// （拖出 hit 区自然停在最后值——gpui 无窗口级捕获，gpuix 同）；键盘
// ←/→/home/end 步进。

/// 滑条拖拽态（挂在 SettingsView 上，跨 render 复用）
#[derive(Default)]
pub struct RangeDrag {
    pub active: bool,
    /// paint 阶段记录的 hit 区窗口坐标（canvas prepaint 每帧刷新）
    pub bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
}

#[allow(clippy::too_many_arguments)]
pub fn range_input(
    id: gpui::SharedString,
    handle: &FocusHandle,
    focused: bool,
    value: i64,
    min: i64,
    max: i64,
    step: i64,
    drag: &RangeDrag,
    on_change: impl Fn(i64, &mut Window, &mut App) + Clone + 'static,
) -> impl IntoElement {
    let width = 200.0f32;
    let ratio = (value - min) as f32 / (max - min) as f32;
    let value_at = {
        let bounds = drag.bounds.clone();
        move |x: f32| -> Option<i64> {
            let b = bounds.get()?;
            if b.size.width <= px(0.) {
                return None;
            }
            let ratio = ((x - f32::from(b.origin.x)) / f32::from(b.size.width)).clamp(0.0, 1.0);
            let n = (min as f32 + ratio * (max - min) as f32).clamp(min as f32, max as f32);
            Some(((n / step as f32).round() as i64) * step)
        }
    };
    let down = {
        let value_at = value_at.clone();
        let on_change = on_change.clone();
        move |ev: &MouseDownEvent, window: &mut Window, cx: &mut App| {
            if let Some(v) = value_at(f32::from(ev.position.x)) {
                on_change(v, window, cx);
            }
        }
    };
    let mv = {
        let value_at = value_at.clone();
        let on_change = on_change.clone();
        move |ev: &MouseMoveEvent, window: &mut Window, cx: &mut App| {
            if let Some(v) = (ev.pressed_button == Some(MouseButton::Left))
                .then(|| value_at(f32::from(ev.position.x)))
                .flatten()
            {
                on_change(v, window, cx);
            }
        }
    };
    let key = {
        let on_change = on_change.clone();
        move |ev: &gpui::KeyDownEvent, window: &mut Window, cx: &mut App| {
            let next = match ev.keystroke.key.as_str() {
                "left" | "down" => Some((value - step).max(min)),
                "right" | "up" => Some((value + step).min(max)),
                "home" => Some(min),
                "end" => Some(max),
                _ => None,
            };
            if let Some(v) = next {
                cx.stop_propagation();
                on_change(v, window, cx);
            }
        }
    };
    let track_cell = drag.bounds.clone();
    div()
        .id(id)
        .track_focus(handle)
        .relative()
        .w(px(width))
        .h(px(18.0))
        .flex_shrink_0()
        .rounded_full()
        .cursor_pointer()
        .when(focused, |d| d.shadow(focus_ring()))
        // paint 阶段记录 hit 区窗口坐标（每帧刷新，拖拽换算用）
        .child(gpui::canvas(
            move |bounds, _, _| track_cell.set(Some(bounds)),
            |_, _, _, _| {},
        ))
        // 底轨（3px surfaceHover 垂直居中）+ 填充（accent）
        .child(
            div()
                .absolute()
                .left_0()
                .right_0()
                .top(px(7.5))
                .h(px(3.0))
                .rounded(px(2.0))
                .bg(hex(colors::SURFACE_HOVER)),
        )
        .child(
            div()
                .absolute()
                .left_0()
                .top(px(7.5))
                .h(px(3.0))
                .w(px((ratio * width).clamp(0.0, width)))
                .rounded(px(2.0))
                .bg(hex(colors::ACCENT)),
        )
        // 拇指（13px 圆 textBright；focus/drag 时 accent 边）
        .child(
            div()
                .absolute()
                .top(px(2.5))
                .left(px(ratio * (width - 13.0)))
                .size(px(13.0))
                .rounded_full()
                .bg(hex(colors::TEXT_BRIGHT))
                .when(focused || drag.active, |d| {
                    d.border_1().border_color(hex(colors::FOCUS_BORDER))
                }),
        )
        .on_mouse_down(MouseButton::Left, down)
        .on_mouse_move(mv)
        .on_key_down(key)
}

/// 滑条右侧实时数值（.range-val：mono 12 bright，min-w 44 右对齐）
pub fn range_value(value: i64, suffix: &str) -> impl IntoElement {
    div()
        .min_w(px(44.0))
        .text_right()
        .font_family("monospace")
        .text_size(px(12.0))
        .text_color(hex(colors::TEXT_BRIGHT))
        .child(format!("{value}{suffix}"))
}

// ── FontSelect（.font-trig + .font-pop：弹层内搜索 + 字身预览 + 自由输入）──
//
// 键盘导航（原型 onKeyDown）：↑/↓ 循环移动 hi、Enter 提交 hi 项、Esc 关闭
// （Popover 内建 Cancel 之外再显式 dismiss + stop_propagation，防 Esc 连坐
// 关掉整个设置面）。搜索词/高亮在 SettingsView 上，content 闭包经 weak 回读。

pub fn font_select(
    value: &str,
    items: Vec<FontItem>,
    hi: usize,
    search: Entity<InputState>,
    search_handle: FocusHandle,
    weak: WeakEntity<SettingsView>,
    on_commit: impl Fn(&str, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let value = value.to_owned();
    let value_for_trigger = value.clone();
    Popover::new("font-popover")
        .anchor(gpui::Anchor::TopLeft)
        .offset(px(4.0))
        .track_focus(&search_handle)
        .on_open_change({
            let weak = weak.clone();
            let search = search.clone();
            move |open, window, cx| {
                if *open {
                    // 重开时重置搜索态（原型 fontPicker = { path, q: '', hi: 0 }）；
                    // set_value 不发 Change 事件，view.font_query 双清保持一致
                    let _ = weak.update(cx, |v, cx| {
                        v.font_query.clear();
                        v.font_hi = 0;
                        cx.notify();
                    });
                    search.update(cx, |s, cx| s.set_value("", window, cx));
                }
            }
        })
        .trigger(PopupTrigger::new(move |open| {
            font_trigger(&value_for_trigger, open).into_any_element()
        }))
        .content({
            // content 存的是可重复调用的 builder：items/on_commit 走 Rc 共享，
            // 键盘导航与行点击闭包各自 clone（都要求 'static）
            let items = Rc::new(items);
            let on_commit = Rc::new(on_commit);
            move |_, _, cx| {
                let popover = cx.entity();
                #[allow(clippy::type_complexity)]
                let commit_and_close: Rc<dyn Fn(&str, &mut Window, &mut App)> = {
                    let popover = popover.clone();
                    Rc::new(move |name: &str, window: &mut Window, cx: &mut App| {
                        on_commit(name, window, cx);
                        popover.update(cx, |s, cx| s.dismiss(window, cx));
                    })
                };
                // 键盘导航（挂弹层根，input 冒泡到此）
                let key_nav = {
                    let weak = weak.clone();
                    let commit_and_close = commit_and_close.clone();
                    let items = items.clone();
                    move |ev: &gpui::KeyDownEvent, window: &mut Window, cx: &mut App| {
                        let len = items.len();
                        match ev.keystroke.key.as_str() {
                            "down" if len > 0 => {
                                cx.stop_propagation();
                                let _ = weak.update(cx, |v, cx| {
                                    v.font_hi = (v.font_hi + 1) % len;
                                    cx.notify();
                                });
                            }
                            "up" if len > 0 => {
                                cx.stop_propagation();
                                let _ = weak.update(cx, |v, cx| {
                                    v.font_hi = (v.font_hi + len - 1) % len;
                                    cx.notify();
                                });
                            }
                            "enter" if len > 0 => {
                                cx.stop_propagation();
                                let name = items
                                    .get(hi.min(len - 1))
                                    .map(|i| i.name.clone())
                                    .unwrap_or_default();
                                commit_and_close(&name, window, cx);
                            }
                            "escape" => {
                                cx.stop_propagation();
                                popover.update(cx, |s, cx| s.dismiss(window, cx));
                            }
                            _ => {}
                        }
                    }
                };
                let n = items.len();
                let mut list = overlay_shell("font-pop")
                    .w(px(280.0))
                    .p(px(4.0))
                    .on_key_down(key_nav)
                    // 搜索行（.font-search：28 高 + 底边 + search 图标 + 无边 input）
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .h(px(28.0))
                            .px(px(8.0))
                            .border_b_1()
                            .border_color(hex(colors::BORDER))
                            .child(icon(IconName::Search, 12.0, hex(colors::MUTED)))
                            .child(
                                div().flex_1().min_w_0().child(
                                    Input::new(&search)
                                        .appearance(false)
                                        .h_full()
                                        .text_size(px(12.0)),
                                ),
                            ),
                    );
                if n == 0 {
                    list = list.child(
                        div()
                            .px(px(8.0))
                            .py(px(6.0))
                            .text_size(px(11.5))
                            .text_color(hex(colors::MUTED))
                            .child("无匹配字体"),
                    );
                } else {
                    // 列表（.font-list：max 264 滚动；行 26 高 + 字身预览 + free 行 mono）
                    let mut rows = div()
                        .id("font-list")
                        .max_h(px(264.0))
                        .overflow_y_scroll()
                        .pt(px(4.0));
                    for (i, it) in items.iter().enumerate() {
                        let commit_and_close = commit_and_close.clone();
                        let selected = it.name == value;
                        let name = it.name.clone();
                        rows = rows.child(
                            menu_row(gpui::SharedString::from(format!("font-row-{i}")))
                                .child(check_slot(selected))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .overflow_hidden()
                                        .whitespace_nowrap()
                                        .text_ellipsis()
                                        .when(it.free, |d| {
                                            // 自由输入行（.font-row.free）：mono + bright
                                            d.font_family("monospace")
                                                .text_size(px(12.0))
                                                .text_color(hex(colors::TEXT_BRIGHT))
                                        })
                                        .when(!it.free, |d| {
                                            // 字身预览（.nm 12.5）：行文字用该字体渲染
                                            d.font_family(gpui::SharedString::from(it.name.clone()))
                                                .text_size(px(12.5))
                                                .when(selected, |d| {
                                                    d.text_color(hex(colors::ACCENT))
                                                })
                                        })
                                        .child(if it.free {
                                            format!("使用 \"{}\"", it.name)
                                        } else {
                                            it.name.clone()
                                        }),
                                )
                                .when(i == hi, |d| d.bg(hex(colors::SURFACE_HOVER)))
                                .on_click(move |_, window, cx| {
                                    cx.stop_propagation();
                                    commit_and_close(&name, window, cx);
                                }),
                        );
                    }
                    list = list.child(rows);
                }
                list.into_any_element()
            }
        })
}

/// 触发器（.font-trig：min-180×30，mono 值 + chevron）
fn font_trigger(value: &str, active: bool) -> impl IntoElement {
    div()
        .id("font-trigger")
        .flex()
        .items_center()
        .justify_between()
        .gap(px(8.0))
        .min_w(px(180.0))
        .h(px(30.0))
        .pl(px(10.0))
        .pr(px(8.0))
        .rounded(px(8.0))
        .cursor_pointer()
        .bg(hex(colors::INPUT_BG))
        .border_1()
        .border_color(control_border(active))
        .hover(|d| d.border_color(hex(colors::FOCUS_BORDER)))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .font_family("monospace")
                .text_size(px(12.0))
                .text_color(hex(colors::TEXT_BRIGHT))
                .child(value.to_owned()),
        )
        .child(icon(IconName::ChevronDown, 12.0, hex(colors::MUTED)))
}
