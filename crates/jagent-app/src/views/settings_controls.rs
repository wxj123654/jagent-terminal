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
    MouseDownEvent, MouseMoveEvent, ParentElement as _, Pixels, RenderOnce, Stateful,
    StatefulInteractiveElement as _, Styled as _, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_base::Popover;
use gpui_base::actions::Confirm;
use gpui_component::input::{Input, InputState};

use crate::icons::{IconName, icon};
use crate::theme::{accent_alpha, colors, hex};
use crate::views::field;
use crate::views::popup::{PopupTrigger, overlay_shell};
use crate::views::settings::SettingsView;
use crate::views::settings_defs::FontItem;

/// 焦点环（贴元素 2px spread 的 ring 色）。
pub fn focus_ring() -> Vec<gpui::BoxShadow> {
    vec![gpui::BoxShadow::new(px(0.), px(0.), accent_alpha(0.38)).spread_radius(px(2.))]
}

/// 菜单行（.sel-item / .font-row：R9 增补 834 行 min-h 30 / r6，hover surface）
fn menu_row(id: gpui::SharedString) -> Stateful<gpui::Div> {
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(px(6.0))
        .h(px(30.0))
        .px(px(8.0))
        .rounded(px(6.0))
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
        // 关态：原型 surfaceHover 轨在 st-card（surface 系）上几乎隐形——
        // 提一档到 borderSubtle，并给 knob 用 muted，保证「关」也读得出来
        .when(!checked, |d| d.bg(hex(colors::BORDER_SUBTLE)))
        .hover(|d| d.opacity(0.9))
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
                .when(!checked, |d| d.bg(hex(colors::MUTED))),
        )
        .on_click(move |_, window, cx| on_toggle.clone()(window, cx))
        .on_key_down(move |event, window, cx| {
            if event.keystroke.key == "space" || event.keystroke.key == "enter" {
                cx.stop_propagation();
                on_key(window, cx);
            }
        })
}

// ── SelectField（.sel-trig 220×30 + chevron；.sel-pop 同宽菜单 + 勾选槽）──
//
// 键盘契约（原型 Radix Select 同款）：Tab 可聚焦（焦点环）→ Enter/Space/↓
// 打开 → ↑/↓ 循环移动高亮（hover 同步高亮）→ Enter 提交 → Esc 关闭；关闭后
// 焦点回到触发器（Popover 内建归还）。
//
// 实现要点（gpui 事件模型）：
// - 打开态受控：`use_keyed_state` 存 open / 高亮 / 两个 focus handle，Popover
//   用 `.open(open)` 同步、`on_open_change` 回写（外点 / Esc / 点触发器都经此）；
// - 菜单面 `track_focus(menu_focus)` 并交给 `Popover::track_focus`：打开即
//   聚焦菜单面，键盘事件的 dispatch path 才经过菜单面的 listener；
// - Enter 在 Popover 上下文被绑成 `Confirm`（会 toggle 关闭），所以提交要用
//   菜单面上的 `on_action(Confirm)` 截获（冒泡阶段比 Popover 自身更靠里）。
//
// options 用 owned Vec：预设「+」默认下拉的选项随 settings 动态变化。

/// 选择回调（值 id）
type SelectFn = Rc<dyn Fn(&str, &mut Window, &mut App)>;
/// 按下标提交并收起
type CommitFn = Rc<dyn Fn(usize, &mut Window, &mut App)>;

/// 选择器默认宽度（触发器与菜单同宽）
pub const SELECT_W: f32 = 220.0;

pub fn select_field(
    id: &str,
    value: &str,
    options: Vec<(String, String)>,
    on_select: impl Fn(&str, &mut Window, &mut App) + 'static,
) -> SelectField {
    SelectField {
        id: gpui::SharedString::from(id.to_owned()),
        value: value.to_owned(),
        options,
        width: SELECT_W,
        on_select: Rc::new(on_select),
    }
}

/// 选择器每帧的跨帧状态（挂 element state，按 id 隔离）
struct SelectUi {
    open: bool,
    hi: usize,
    trigger_focus: FocusHandle,
    menu_focus: FocusHandle,
}

#[derive(IntoElement)]
pub struct SelectField {
    id: gpui::SharedString,
    value: String,
    options: Vec<(String, String)>,
    width: f32,
    on_select: SelectFn,
}

impl SelectField {
    #[allow(dead_code)]
    pub fn width(mut self, width: f32) -> Self {
        self.width = width;
        self
    }
}

/// 高亮循环移动（空列表恒 0）
pub fn cycle_index(cur: usize, len: usize, delta: isize) -> usize {
    if len == 0 {
        return 0;
    }
    (cur as isize + delta).rem_euclid(len as isize) as usize
}

impl RenderOnce for SelectField {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let Self {
            id,
            value,
            options,
            width,
            on_select,
        } = self;
        let ui =
            window.use_keyed_state(gpui::SharedString::from(format!("{id}-ui")), cx, |_, cx| {
                SelectUi {
                    open: false,
                    hi: 0,
                    trigger_focus: cx.focus_handle().tab_stop(true),
                    menu_focus: cx.focus_handle(),
                }
            });
        let (open, trigger_focus, menu_focus) = {
            let u = ui.read(cx);
            (u.open, u.trigger_focus.clone(), u.menu_focus.clone())
        };
        let trigger_focused = trigger_focus.is_focused(window);
        let current_idx = options.iter().position(|(v, _)| *v == value).unwrap_or(0);
        let label = options
            .iter()
            .find(|(v, _)| *v == value)
            .map(|(_, l)| l.clone())
            .unwrap_or_else(|| value.clone());
        let options = Rc::new(options);

        Popover::new(id.clone())
            .anchor(gpui::Anchor::TopLeft)
            .offset(px(4.0))
            .open(open)
            .track_focus(&menu_focus)
            .on_open_change({
                let ui = ui.clone();
                move |next, _, cx| {
                    ui.update(cx, |u, cx| {
                        u.open = *next;
                        // 每次打开高亮回到当前值（原型 Radix 同款）
                        if *next {
                            u.hi = current_idx;
                        }
                        cx.notify();
                    });
                }
            })
            .trigger(PopupTrigger::new({
                let id = id.clone();
                let ui = ui.clone();
                move |open| {
                    let ui = ui.clone();
                    div()
                        .id(gpui::SharedString::from(format!("{id}-trig")))
                        .debug_selector({
                            let id = id.clone();
                            move || format!("{id}-trig")
                        })
                        .track_focus(&trigger_focus)
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(8.0))
                        .w(px(width))
                        .h(px(field::FIELD_H))
                        .pl(px(10.0))
                        .pr(px(8.0))
                        .rounded(px(field::FIELD_RADIUS))
                        .cursor_pointer()
                        .bg(hex(colors::INPUT_BG))
                        .border_1()
                        .border_color(control_border(open || trigger_focused))
                        .when(trigger_focused && !open, |d| d.shadow(focus_ring()))
                        .hover(|d| d.border_color(hex(colors::FOCUS_BORDER)))
                        // ↓ 也能打开（Enter/Space 由 Popover 的 Confirm 绑定负责）
                        .on_key_down(move |ev, _, cx| {
                            if ev.keystroke.key == "down" && !ev.keystroke.modifiers.modified() {
                                cx.stop_propagation();
                                ui.update(cx, |u, cx| {
                                    u.open = true;
                                    u.hi = current_idx;
                                    cx.notify();
                                });
                            }
                        })
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_size(px(field::FIELD_TEXT))
                                .text_color(hex(colors::TEXT_BRIGHT))
                                .child(label.clone()),
                        )
                        .child(icon(
                            if open {
                                IconName::ChevronUp
                            } else {
                                IconName::ChevronDown
                            },
                            12.0,
                            hex(colors::MUTED),
                        ))
                        .into_any_element()
                }
            }))
            .content({
                let id = id.clone();
                move |_, _, cx| {
                    let popover = cx.entity();
                    let hi = ui.read(cx).hi.min(options.len().saturating_sub(1));
                    let len = options.len();
                    let commit: CommitFn = {
                        let options = options.clone();
                        let on_select = on_select.clone();
                        let popover = popover.clone();
                        Rc::new(move |i, window, cx| {
                            if let Some((v, _)) = options.get(i) {
                                on_select(v, window, cx);
                            }
                            popover.update(cx, |s, cx| s.dismiss(window, cx));
                        })
                    };
                    let mut surface = overlay_shell(gpui::SharedString::from(format!("{id}-pop")))
                        .debug_selector({
                            let id = id.clone();
                            move || format!("{id}-pop")
                        })
                        .track_focus(&menu_focus)
                        .w(px(width))
                        .p(px(4.0))
                        .on_action({
                            let commit = commit.clone();
                            move |_: &Confirm, window, cx| commit(hi, window, cx)
                        })
                        .on_key_down({
                            let ui = ui.clone();
                            move |ev, _, cx| {
                                let delta = match ev.keystroke.key.as_str() {
                                    "down" => 1,
                                    "up" => -1,
                                    _ => return,
                                };
                                cx.stop_propagation();
                                ui.update(cx, |u, cx| {
                                    u.hi = cycle_index(u.hi, len, delta);
                                    cx.notify();
                                });
                            }
                        });
                    for (i, (v, l)) in options.iter().enumerate() {
                        let commit = commit.clone();
                        let ui = ui.clone();
                        surface = surface.child(
                            menu_row(gpui::SharedString::from(format!("{id}-item-{v}")))
                                .debug_selector({
                                    let sel = format!("{id}-item-{v}");
                                    move || sel
                                })
                                .when(i == hi, |d| d.bg(hex(colors::SURFACE)))
                                .child(check_slot(*v == value))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .overflow_hidden()
                                        .whitespace_nowrap()
                                        .text_ellipsis()
                                        .when(*v == value, |d| {
                                            d.text_color(hex(colors::TEXT_BRIGHT))
                                        })
                                        .child(l.clone()),
                                )
                                .on_hover(move |hovered, _, cx| {
                                    if *hovered {
                                        ui.update(cx, |u, cx| {
                                            if u.hi != i {
                                                u.hi = i;
                                                cx.notify();
                                            }
                                        });
                                    }
                                })
                                .on_click(move |_, window, cx| {
                                    cx.stop_propagation();
                                    commit(i, window, cx);
                                }),
                        );
                    }
                    surface.into_any_element()
                }
            })
    }
}

// ── NumberInput（.num-in 30 高 + mono 值 + 自绘步进列 18 宽；↑/↓ 钮步进）──
//
// 宽 96：scrollback 上限 100000（6 位）在 12px mono 下约 44px，76 宽扣掉步进列
// 与库 Input 的默认 10px 水平内边距后只剩 ~30px，会被裁成「100(」。

/// 数字框宽度
pub const NUMBER_W: f32 = 96.0;

pub fn number_input(
    id: &str,
    state: &Entity<InputState>,
    focused: bool,
    on_nudge: impl Fn(i64, &mut Window, &mut App) + Clone + 'static,
) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .w(px(NUMBER_W))
        .h(px(field::FIELD_H))
        .flex_shrink_0()
        .rounded(px(field::FIELD_RADIUS))
        .bg(hex(colors::INPUT_BG))
        .border_1()
        .border_color(control_border(focused))
        .when(focused, |d| d.shadow(focus_ring()))
        .overflow_hidden()
        .child(
            div().flex_1().min_w_0().h_full().pl(px(10.0)).child(
                Input::new(state)
                    .appearance(false)
                    .h_full()
                    // 库默认 input_px(10)：外层已给 pl 10，这里清零免得双倍
                    .px(px(0.0))
                    .font_family(field::mono_family())
                    .text_size(px(field::FIELD_TEXT))
                    .text_color(hex(colors::TEXT_BRIGHT)),
            ),
        )
        .child(
            // 步进列（18 宽，左分隔线；↑/↓ 各占半，hover surfaceHover）
            div()
                .flex()
                .flex_col()
                .w(px(18.0))
                .self_stretch()
                .flex_shrink_0()
                .border_l_1()
                .border_color(hex(colors::BORDER_SUBTLE))
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

#[cfg(test)]
mod select_tests {
    use std::cell::RefCell;

    use gpui::{Context, Modifiers, Render, TestAppContext};

    use super::*;

    #[test]
    fn cycle_index_wraps_both_ways_and_tolerates_empty() {
        assert_eq!(cycle_index(0, 3, 1), 1);
        assert_eq!(cycle_index(2, 3, 1), 0, "↓ 到底回首");
        assert_eq!(cycle_index(0, 3, -1), 2, "↑ 到顶回尾");
        assert_eq!(cycle_index(5, 0, 1), 0);
    }

    struct Harness {
        value: Rc<RefCell<String>>,
    }

    impl Render for Harness {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let value = self.value.clone();
            let current = value.borrow().clone();
            div().p(px(20.0)).child(select_field(
                "sel",
                &current,
                vec![
                    ("a".into(), "Alpha".into()),
                    ("b".into(), "Beta".into()),
                    ("c".into(), "Gamma".into()),
                ],
                move |v, _, _| *value.borrow_mut() = v.to_owned(),
            ))
        }
    }

    fn setup(cx: &mut TestAppContext) -> (Rc<RefCell<String>>, &mut gpui::VisualTestContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::install(cx).expect("主题安装");
        });
        let value = Rc::new(RefCell::new("a".to_owned()));
        let (_, vcx) = cx.add_window_view({
            let value = value.clone();
            move |_, _| Harness { value }
        });
        vcx.update(|window, cx| window.draw(cx).clear(cx));
        (value, vcx)
    }

    fn redraw(cx: &mut gpui::VisualTestContext) {
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
    }

    /// 菜单与触发器同宽（原型 Radix Select 的 trigger-width 菜单）。
    #[gpui::test]
    fn menu_matches_trigger_width_and_click_picks(cx: &mut TestAppContext) {
        let (value, cx) = setup(cx);
        let trig = cx.debug_bounds("sel-trig").expect("触发器在屏");
        assert_eq!(trig.size.width, px(SELECT_W));
        cx.simulate_click(trig.center(), Modifiers::default());
        redraw(cx);
        let pop = cx.debug_bounds("sel-pop").expect("点开后菜单在屏");
        assert_eq!(pop.size.width, trig.size.width, "菜单与触发器同宽");
        let item = cx.debug_bounds("sel-item-c").expect("选项在屏").center();
        cx.simulate_click(item, Modifiers::default());
        redraw(cx);
        assert_eq!(*value.borrow(), "c");
        assert!(cx.debug_bounds("sel-pop").is_none(), "选中后收起");
    }

    /// 键盘：打开后 ↓↓ 从当前值（Alpha）移到 Gamma，Enter 提交并收起；
    /// 再打开 ↑ 从 Gamma 回到 Beta，Esc 关闭不提交。
    #[gpui::test]
    fn keyboard_navigates_commits_and_escapes(cx: &mut TestAppContext) {
        let (value, cx) = setup(cx);
        let trig = cx.debug_bounds("sel-trig").expect("触发器在屏").center();
        cx.simulate_click(trig, Modifiers::default());
        redraw(cx);
        assert!(cx.debug_bounds("sel-pop").is_some());
        cx.simulate_keystrokes("down down");
        redraw(cx);
        cx.simulate_keystrokes("enter");
        redraw(cx);
        assert_eq!(*value.borrow(), "c", "↓↓ + Enter 选中第三项");
        assert!(cx.debug_bounds("sel-pop").is_none(), "Enter 提交后收起");

        cx.simulate_click(trig, Modifiers::default());
        redraw(cx);
        cx.simulate_keystrokes("up");
        redraw(cx);
        cx.simulate_keystrokes("escape");
        redraw(cx);
        assert!(cx.debug_bounds("sel-pop").is_none(), "Esc 关闭");
        assert_eq!(*value.borrow(), "c", "Esc 不提交");

        // 焦点归还触发器：Enter 直接重开（键盘全程不碰鼠标）
        cx.simulate_keystrokes("enter");
        redraw(cx);
        assert!(
            cx.debug_bounds("sel-pop").is_some(),
            "触发器聚焦时 Enter 打开"
        );
        cx.simulate_keystrokes("escape");
        redraw(cx);
        cx.simulate_keystrokes("down");
        redraw(cx);
        assert!(cx.debug_bounds("sel-pop").is_some(), "触发器聚焦时 ↓ 打开");
    }
}
