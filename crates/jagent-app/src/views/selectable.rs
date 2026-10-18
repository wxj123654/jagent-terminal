//! 通用可选择纯文本/富样式文本原语（修复 `gpui_base::SelectableText` 的三项缺陷）：
//!
//! 1. **自动重绘选区**：`gpui_base::SelectableText::new` 未调用
//!    `TextSelectionHandle::refresh_window_on_change`，导致真实窗口下鼠标拖选时不触发
//!    `window.refresh()`，选区高亮与 `projected_copy_text` 不更新。本组件在 `prepaint`
//!    阶段持久化 `(TextSelectionHandle, Subscription)`，选区变化即刻刷新窗口。
//! 2. **合法阶段访问 ElementState**：`gpui::Window::with_element_state` 要求在 `prepaint`
//!    或 `paint` 阶段调用（且 `gpui::list` 在 `request_layout` 测高阶段可能对同一行调用
//!    两次 `layout_as_root`）。本组件将 `with_element_state` 严格放在 `prepaint` 阶段。
//! 3. **自动文档顺序 + 省略号截断容错**：默认按 `prepaint` 绘制序自动分配单调递增的
//!    `document_order`，支持跨多行/跨组件拖选；当外层开启 `.text_ellipsis()` 发生截断时，
//!    自动对齐 `layout.text()` 使得选区不因 `text.len() != layout.len()` 失效，且选到
//!    末尾省略号时自动还原复制完整未截断原文。

use std::{
    cell::RefCell,
    ops::Range,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};

use gpui::{
    App, BorderStyle, Bounds, Corners, CursorStyle, Edges, Element, ElementId, GlobalElementId,
    Hitbox, HitboxBehavior, Hsla, InspectorElementId, IntoElement, LayoutId, PaintQuad, Pixels,
    Point, SharedString, StyledText, TextStyleRefinement, Window, transparent_black,
};
use gpui_base::{TextSelectionHandle, TextSelectionRegistration, TextSelectionRun};

static NEXT_DOCUMENT_ORDER: AtomicU64 = AtomicU64::new(1);

fn next_document_order() -> u64 {
    NEXT_DOCUMENT_ORDER.fetch_add(1, Ordering::Relaxed)
}

struct RetainedSelectableState {
    handle: TextSelectionHandle,
    _sub: gpui::Subscription,
    copied_text: Rc<RefCell<String>>,
    order: u64,
    last_text: SharedString,
}

pub struct SelectableTextPrepaintState {
    handle: TextSelectionHandle,
    hitbox: Hitbox,
    order: u64,
    copied_text: Rc<RefCell<String>>,
}

/// 参与窗口级 [`TextSelection`] 的可选择文本元素（支持单段拖选、双击选词、三击选行、跨块拖选与 Cmd/Ctrl+C 复制）。
pub struct SelectableText {
    id: ElementId,
    handle: Option<TextSelectionHandle>,
    text: SharedString,
    styled_text: StyledText,
    document_order: Option<u64>,
    text_style: Option<TextStyleRefinement>,
    selection_color: Option<Hsla>,
    cursor_ibeam: bool,
}

impl SelectableText {
    /// 创建带显式 `ElementId` 的可选择纯文本。
    pub fn new(id: impl Into<ElementId>, text: impl Into<SharedString>) -> Self {
        let text = text.into();
        Self {
            id: id.into(),
            handle: None,
            styled_text: StyledText::new(text.clone()),
            text,
            document_order: None,
            text_style: None,
            selection_color: None,
            cursor_ibeam: true,
        }
    }

    /// 创建带自定义 [`StyledText`]（例如搜索高亮 spans）的可选择文本。
    pub fn with_styled(
        id: impl Into<ElementId>,
        text: impl Into<SharedString>,
        styled_text: StyledText,
    ) -> Self {
        Self {
            id: id.into(),
            handle: None,
            text: text.into(),
            styled_text,
            document_order: None,
            text_style: None,
            selection_color: None,
            cursor_ibeam: true,
        }
    }

    /// 创建共享外部 [`TextSelectionHandle`] 的可选择文本。
    pub fn with_handle(
        id: impl Into<ElementId>,
        handle: TextSelectionHandle,
        text: impl Into<SharedString>,
    ) -> Self {
        let text = text.into();
        Self {
            id: id.into(),
            handle: Some(handle),
            styled_text: StyledText::new(text.clone()),
            text,
            document_order: None,
            text_style: None,
            selection_color: None,
            cursor_ibeam: true,
        }
    }

    /// 显式指定文档阅读顺序（默认按每帧 prepaint 顺序自动递增）。
    pub fn document_order(mut self, order: u64) -> Self {
        self.document_order = Some(order);
        self
    }

    /// 覆盖文本排版样式（默认继承父容器 `div` 的文本样式）。
    pub fn text_style(mut self, style: TextStyleRefinement) -> Self {
        self.text_style = Some(style);
        self
    }

    /// 覆盖选区高亮底色（默认使用主题选区色 `#6366f140`）。
    pub fn selection_color(mut self, color: Hsla) -> Self {
        self.selection_color = Some(color);
        self
    }

    /// 是否在悬浮时显示文本 I-Beam 光标（默认 `true`；在整行可点击的按钮/条目内可设 `false`）。
    pub fn cursor_ibeam(mut self, ibeam: bool) -> Self {
        self.cursor_ibeam = ibeam;
        self
    }

    fn paint_selection(
        layout: &gpui::TextLayout,
        range: Range<usize>,
        color: Hsla,
        window: &mut Window,
    ) {
        let (Some(start), Some(end)) = (
            layout.position_for_index(range.start),
            layout.position_for_index(range.end),
        ) else {
            return;
        };
        for bounds in selection_quad_bounds(start, end, layout.bounds(), layout.line_height()) {
            window.paint_quad(PaintQuad {
                bounds,
                background: color.into(),
                corner_radii: Corners::default(),
                border_widths: Edges::default(),
                border_color: transparent_black(),
                border_style: BorderStyle::default(),
            });
        }
    }
}

fn selection_quad_bounds(
    start: Point<Pixels>,
    end: Point<Pixels>,
    bounds: Bounds<Pixels>,
    line_height: Pixels,
) -> Vec<Bounds<Pixels>> {
    if start.y == end.y {
        return vec![Bounds::from_corners(
            start,
            Point::new(end.x, end.y + line_height),
        )];
    }

    let mut quads = vec![Bounds::from_corners(
        start,
        Point::new(bounds.right(), start.y + line_height),
    )];
    if end.y > start.y + line_height {
        quads.push(Bounds::from_corners(
            Point::new(bounds.left(), start.y + line_height),
            Point::new(bounds.right(), end.y),
        ));
    }
    quads.push(Bounds::from_corners(
        Point::new(bounds.left(), end.y),
        Point::new(end.x, end.y + line_height),
    ));
    quads
}

/// 从已排版文本（可能带末尾 `…` 截断）与选区范围还原需要复制的真实文本。
fn extract_selected_slice(full_text: &str, laid_out_text: &str, range: Range<usize>) -> String {
    let clamped_start = range.start.min(laid_out_text.len());
    let clamped_end = range.end.min(laid_out_text.len());
    if clamped_start >= clamped_end {
        return String::new();
    }
    if laid_out_text.len() == full_text.len() {
        if full_text.is_char_boundary(clamped_start) && full_text.is_char_boundary(clamped_end) {
            return full_text[clamped_start..clamped_end].to_string();
        }
    } else if clamped_end == laid_out_text.len()
        && let Some(prefix) = laid_out_text.strip_suffix('…')
        && full_text.starts_with(prefix)
        && clamped_start <= prefix.len()
        && full_text.is_char_boundary(clamped_start)
    {
        return full_text[clamped_start..].to_string();
    }
    if laid_out_text.is_char_boundary(clamped_start) && laid_out_text.is_char_boundary(clamped_end)
    {
        laid_out_text[clamped_start..clamped_end].to_string()
    } else {
        String::new()
    }
}

impl IntoElement for SelectableText {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for SelectableText {
    type RequestLayoutState = ();
    type PrepaintState = SelectableTextPrepaintState;

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let (layout_id, ()) = if let Some(style) = self.text_style.clone() {
            window.with_text_style(Some(style), |window| {
                self.styled_text
                    .request_layout(global_id, inspector_id, window, cx)
            })
        } else {
            self.styled_text
                .request_layout(global_id, inspector_id, window, cx)
        };
        (layout_id, ())
    }

    fn prepaint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.styled_text
            .prepaint(global_id, inspector_id, bounds, &mut (), window, cx);

        let (handle, copied_text, retained_order) = if let Some(handle) = self.handle.clone() {
            (
                handle,
                Rc::new(RefCell::new(String::new())),
                next_document_order(),
            )
        } else {
            window.with_element_state(
                global_id.expect("SelectableText must have a stable element id"),
                |retained: Option<RetainedSelectableState>, window| {
                    let mut state = retained.unwrap_or_else(|| {
                        let handle = TextSelectionHandle::new(self.text.clone(), cx);
                        let sub = handle.refresh_window_on_change(window, cx);
                        let copied_text = Rc::new(RefCell::new(String::new()));
                        let copied_for_cb = copied_text.clone();
                        handle.copy_with(move |_| copied_for_cb.borrow().clone(), cx);
                        RetainedSelectableState {
                            handle,
                            _sub: sub,
                            copied_text,
                            order: next_document_order(),
                            last_text: self.text.clone(),
                        }
                    });
                    if state.last_text != self.text {
                        state.handle.set_fallback_copy_text(self.text.clone(), cx);
                        state.last_text = self.text.clone();
                    }
                    (
                        (state.handle.clone(), state.copied_text.clone(), state.order),
                        state,
                    )
                },
            )
        };

        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
        let order = self.document_order.unwrap_or(retained_order);
        let registration = TextSelectionRegistration::new(hitbox.clone(), bounds)
            .with_document_order(order)
            .with_text_bounds(vec![bounds]);
        handle.register(registration, window, cx);

        SelectableTextPrepaintState {
            handle,
            hitbox,
            order,
            copied_text,
        }
    }

    fn paint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        if self.cursor_ibeam {
            window.set_cursor_style(CursorStyle::IBeam, &prepaint.hitbox);
        }

        let layout = self.styled_text.layout().clone();
        let laid_out_text = if layout.len() == self.text.len() {
            self.text.clone()
        } else {
            SharedString::from(layout.text())
        };

        let projection = prepaint.handle.update_runs(
            &[
                TextSelectionRun::new(laid_out_text.clone(), layout.clone(), bounds)
                    .with_document_order(prepaint.order),
            ],
            cx,
        );

        let mut slice = String::new();
        for range in projection.ranges().iter().flatten().cloned() {
            slice.push_str(&extract_selected_slice(&self.text, &laid_out_text, range));
        }
        if slice.is_empty() && projection.is_active() && projection.ranges().is_empty() {
            slice = self.text.to_string();
        }
        *prepaint.copied_text.borrow_mut() = slice;

        let color = self
            .selection_color
            .unwrap_or_else(|| crate::theme::accent_alpha(0.32));
        for range in projection.ranges().iter().flatten().cloned() {
            Self::paint_selection(&layout, range, color, window);
        }

        if let Some(style) = self.text_style.clone() {
            window.with_text_style(Some(style), |window| {
                self.styled_text.paint(
                    global_id,
                    inspector_id,
                    bounds,
                    &mut (),
                    &mut (),
                    window,
                    cx,
                );
            });
        } else {
            self.styled_text.paint(
                global_id,
                inspector_id,
                bounds,
                &mut (),
                &mut (),
                window,
                cx,
            );
        }
    }
}

/// 快捷构造：以调用位置作为默认 `ElementId` 创建可选择文本。
#[track_caller]
pub fn sel_text(text: impl Into<SharedString>) -> SelectableText {
    SelectableText::new(
        ElementId::CodeLocation(*std::panic::Location::caller()),
        text,
    )
}

/// 快捷构造：显式指定 `ElementId` 创建可选择文本（适用于循环/列表项）。
pub fn sel_text_id(id: impl Into<ElementId>, text: impl Into<SharedString>) -> SelectableText {
    SelectableText::new(id, text)
}

/// 快捷构造：带自定义 `StyledText`（如搜索高亮）的可选择文本。
#[track_caller]
pub fn sel_styled_text(text: impl Into<SharedString>, styled: StyledText) -> SelectableText {
    SelectableText::with_styled(
        ElementId::CodeLocation(*std::panic::Location::caller()),
        text,
        styled,
    )
}

/// 快捷构造：显式 `ElementId` + 自定义 `StyledText`。
pub fn sel_styled_text_id(
    id: impl Into<ElementId>,
    text: impl Into<SharedString>,
    styled: StyledText,
) -> SelectableText {
    SelectableText::with_styled(id, text, styled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{
        AppContext as _, Context, Entity, FocusHandle, InteractiveElement as _, Modifiers,
        MouseButton, ParentElement as _, Render, Styled as _, TestAppContext, div, point, px,
    };
    use gpui_base::TextSelection;
    use gpui_component::{
        Root,
        input::{Input, InputState},
    };

    #[test]
    fn extract_selected_slice_restores_full_text_when_ellipsis_reached() {
        let full = "/Users/wxj/Documents/jagent-terminal/crates/jagent-app/src/views/root.rs";
        let truncated = "/Users/wxj/Documents/jagent…";
        // 全选到末尾 `…` 时应还原完整原文
        assert_eq!(
            extract_selected_slice(full, truncated, 0..truncated.len()),
            full
        );
        // 从第 7 字节选到末尾 `…` 时应还原从第 7 字节起的完整原文
        assert_eq!(
            extract_selected_slice(full, truncated, 7..truncated.len()),
            &full[7..]
        );
        // 只选前半截未触及 `…` 时精确返回对应子串
        assert_eq!(extract_selected_slice(full, truncated, 1..6), "Users");
    }

    struct SelectCopyHarness {
        focus_handle: FocusHandle,
        input: Entity<InputState>,
    }

    impl Render for SelectCopyHarness {
        fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            if window.focused(_cx).is_none() {
                window.focus(&self.focus_handle, _cx);
            }
            div()
                .track_focus(&self.focus_handle)
                .size_full()
                .flex()
                .flex_col()
                .child(
                    gpui::canvas(
                        |_, _, _| (),
                        |_, _, window, _cx| {
                            window.on_action(
                                std::any::TypeId::of::<gpui_base::input::Copy>(),
                                |_, phase, window, cx| {
                                    if phase == gpui::DispatchPhase::Capture {
                                        let text =
                                            gpui_base::TextSelection::selected_text(window, cx);
                                        if !text.trim().is_empty() {
                                            cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                                                text.trim().to_string(),
                                            ));
                                            cx.stop_propagation();
                                        }
                                    }
                                },
                            );
                        },
                    )
                    .size_0()
                    .absolute(),
                )
                .child(
                    div()
                        .w(px(300.0))
                        .h(px(28.0))
                        .text_size(px(14.0))
                        .child(sel_text_id("line-1", "first selectable line")),
                )
                .child(
                    div()
                        .w(px(300.0))
                        .h(px(28.0))
                        .text_size(px(14.0))
                        .child(sel_text_id("line-2", "second selectable line")),
                )
                .child(div().h(px(32.0)).child(Input::new(&self.input)))
        }
    }

    #[gpui::test]
    fn drag_select_and_copy_works_even_when_input_was_focused(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::install(cx).unwrap();
            crate::actions::install(cx, &jagent_core::settings::Settings::default());
        });
        let (root, cx) = cx.add_window_view(|window, cx| {
            let input = cx.new(|cx| InputState::new(window, cx));
            let view = cx.new(|cx| SelectCopyHarness {
                focus_handle: cx.focus_handle(),
                input,
            });
            Root::new(view, window, cx)
        });
        // 先让输入框获得焦点（模拟设置搜索框或对话输入框聚焦态）
        cx.update(|window, cx| {
            let view = root
                .read(cx)
                .view()
                .clone()
                .downcast::<SelectCopyHarness>()
                .unwrap();
            let input = view.read(cx).input.clone();
            input.update(cx, |s, cx| s.focus(window, cx));
            let _ = window.draw(cx);
        });

        // 在第一行和第二行可选择文本上跨行拖选
        cx.simulate_mouse_down(
            point(px(2.0), px(10.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.simulate_mouse_move(
            point(px(260.0), px(42.0)),
            Some(MouseButton::Left),
            Modifiers::default(),
        );
        cx.simulate_mouse_up(
            point(px(260.0), px(42.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.run_until_parked();
        cx.update(|window, cx| {
            let _ = window.draw(cx);
            assert_eq!(
                TextSelection::selected_text(window, cx),
                "first selectable line\nsecond selectable line"
            );
        });

        // 触发 Copy 动作（对应 Cmd+C / Ctrl+C），验证不会被聚焦但无选区的 Input 吞掉
        #[cfg(target_os = "macos")]
        cx.simulate_keystrokes("cmd-c");
        #[cfg(not(target_os = "macos"))]
        cx.simulate_keystrokes("ctrl-c");
        cx.run_until_parked();

        let copied = cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()));
        assert_eq!(
            copied.as_deref(),
            Some("first selectable line\nsecond selectable line"),
            "Cmd/Ctrl+C 应将跨行选中的文本写入系统剪贴板"
        );
    }

    struct TerminalContentHarness {
        term_view: Entity<jagent_terminal::TerminalView>,
        other_input: Entity<InputState>,
    }

    impl Render for TerminalContentHarness {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let term_for_copy = self.term_view.clone();
            let term_for_paste = self.term_view.clone();
            let term_for_select_all = self.term_view.clone();
            let term_for_mouse = self.term_view.clone();
            div()
                .size_full()
                .flex()
                .flex_col()
                .child(
                    gpui::canvas(
                        |_, _, _| (),
                        |_, _, window, _cx| {
                            window.on_action(
                                std::any::TypeId::of::<gpui_base::input::Copy>(),
                                |_, phase, window, cx| {
                                    if phase == gpui::DispatchPhase::Capture {
                                        let text =
                                            gpui_base::TextSelection::selected_text(window, cx);
                                        if !text.trim().is_empty() {
                                            cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                                                text.trim().to_string(),
                                            ));
                                            cx.stop_propagation();
                                        }
                                    }
                                },
                            );
                        },
                    )
                    .size_0()
                    .absolute(),
                )
                .on_action(move |_: &gpui_base::input::Copy, _window, cx| {
                    if !term_for_copy.update(cx, |v, cx| v.copy_selection(cx)) {
                        cx.propagate();
                    }
                })
                .on_action(move |_: &gpui_base::input::Paste, _window, cx| {
                    term_for_paste.update(cx, |v, cx| v.paste_clipboard(cx));
                })
                .on_action(move |_: &gpui_base::input::SelectAll, _window, cx| {
                    term_for_select_all.update(cx, |v, cx| v.select_all(cx));
                })
                .child(
                    div()
                        .relative()
                        .w(px(600.0))
                        .h(px(300.0))
                        .child(
                            gpui::canvas(
                                |bounds, _, _| bounds,
                                move |bounds, _, window, _cx| {
                                    let term_for_down = term_for_mouse.clone();
                                    window.on_mouse_event(
                                        move |event: &gpui::MouseDownEvent, phase, window, cx| {
                                            if phase == gpui::DispatchPhase::Capture
                                                && event.button == MouseButton::Left
                                            {
                                                if bounds.contains(&event.position) {
                                                    gpui_base::GlobalState::suppress_text_selection(
                                                        cx,
                                                    );
                                                    gpui_base::TextSelection::clear(window, cx);
                                                } else {
                                                    term_for_down.update(cx, |v, cx| {
                                                        v.clear_selection(cx);
                                                    });
                                                }
                                            }
                                        },
                                    );
                                },
                            )
                            .absolute()
                            .inset_0()
                            .size_full(),
                        )
                        .child(self.term_view.clone()),
                )
                .child(
                    div()
                        .w(px(600.0))
                        .h(px(28.0))
                        .text_size(px(13.0))
                        .child(sel_text_id("status-line", "STATUS_BAR_SELECTABLE_TEXT")),
                )
                .child(div().h(px(30.0)).child(Input::new(&self.other_input)))
        }
    }

    #[gpui::test]
    fn terminal_scroll_selection_copy_and_tab_isolation_work_end_to_end(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::install(cx).unwrap();
            crate::actions::install(cx, &jagent_core::settings::Settings::default());
        });
        let (root, cx) = cx.add_window_view(|window, cx| {
            let model = jagent_terminal::TerminalModel::new_in_memory(80, 12, 500, cx);
            let mut payload = String::new();
            for i in 0..40 {
                payload.push_str(&format!("TERM_ROW_{i:02}_ALPHA_BETA\r\n"));
            }
            model.read(cx).feed_bytes(payload.as_bytes());
            let term_view = cx.new(|cx| jagent_terminal::TerminalView::new(model, cx));
            let other_input = cx.new(|cx| InputState::new(window, cx));
            let harness = cx.new(|_| TerminalContentHarness {
                term_view,
                other_input,
            });
            Root::new(harness, window, cx)
        });

        let term_view = cx.update(|window, cx| {
            let _ = window.draw(cx);
            let harness = root
                .read(cx)
                .view()
                .clone()
                .downcast::<TerminalContentHarness>()
                .unwrap();
            let tv = harness.read(cx).term_view.clone();
            let fh = tv.read(cx).focus_handle().clone();
            fh.focus(window, cx);
            let _ = window.draw(cx);
            tv
        });

        // 1. 验证滚动（Scrollback）：滚轮上滚 + Shift+Home 到顶 + Shift+End 归底 + 输入自动归底
        cx.update(|_, cx| {
            assert!(
                term_view.read(cx).history_size(cx) > 10,
                "应产生多行回滚历史"
            );
            assert_eq!(term_view.read(cx).display_offset(cx), 0);
        });
        cx.simulate_event(gpui::ScrollWheelEvent {
            position: point(px(100.0), px(100.0)),
            delta: gpui::ScrollDelta::Lines(point(0.0, 3.0)),
            modifiers: Modifiers::default(),
            touch_phase: gpui::TouchPhase::Moved,
        });
        cx.run_until_parked();
        cx.update(|window, cx| {
            let _ = window.draw(cx);
            assert_eq!(
                term_view.read(cx).display_offset(cx),
                3,
                "滚轮上滚 3 行应移动回滚视口"
            );
        });
        cx.simulate_keystrokes("shift-home");
        cx.run_until_parked();
        cx.update(|_, cx| {
            let hist = term_view.read(cx).history_size(cx);
            assert_eq!(
                term_view.read(cx).display_offset(cx),
                hist,
                "Shift+Home 应直达回滚历史顶部"
            );
        });
        // 在历史回滚态下敲 Enter，应自动归底（scroll_to_bottom_on_input）
        cx.simulate_keystrokes("enter");
        cx.run_until_parked();
        cx.update(|_, cx| {
            assert_eq!(
                term_view.read(cx).display_offset(cx),
                0,
                "向终端输入按键时应自动滚回底部"
            );
        });

        // 2. 先在底部状态栏拖选 SelectableText
        cx.simulate_mouse_down(
            point(px(1.0), px(312.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.simulate_mouse_move(
            point(px(280.0), px(312.0)),
            Some(MouseButton::Left),
            Modifiers::default(),
        );
        cx.simulate_mouse_up(
            point(px(280.0), px(312.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.run_until_parked();
        cx.update(|window, cx| {
            let _ = window.draw(cx);
            assert_eq!(
                TextSelection::selected_text(window, cx),
                "STATUS_BAR_SELECTABLE_TEXT"
            );
        });

        // 3. 在终端内拖拽选区：应自动清除状态栏 TextSelection，且不触发跨区误选
        cx.simulate_mouse_down(
            point(px(12.0), px(20.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.simulate_mouse_move(
            point(px(220.0), px(20.0)),
            Some(MouseButton::Left),
            Modifiers::default(),
        );
        cx.simulate_mouse_up(
            point(px(220.0), px(20.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.run_until_parked();
        let term_sel = cx.update(|window, cx| {
            let _ = window.draw(cx);
            assert!(
                TextSelection::selected_text(window, cx).is_empty(),
                "在终端内点击/拖选时必须清除并抑制窗口级 TextSelection"
            );
            let sel = term_view
                .read(cx)
                .selected_text(cx)
                .expect("终端内拖选应产生非空选区");
            assert!(
                sel.contains("TERM_ROW_"),
                "终端选区应命中终端行文本: {sel:?}"
            );
            sel
        });

        // 先往剪贴板塞一个哨兵值，再按 Cmd/Ctrl+C 验证 Copy 动作复制的是终端选区
        cx.update(|_, cx| {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string("SENTINEL".into()));
        });
        #[cfg(target_os = "macos")]
        cx.simulate_keystrokes("cmd-c");
        #[cfg(not(target_os = "macos"))]
        cx.simulate_keystrokes("ctrl-c");
        cx.run_until_parked();
        let copied = cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()));
        assert_eq!(
            copied.as_deref(),
            Some(term_sel.as_str()),
            "Cmd/Ctrl+C 应复制终端选区而非被空 TextSelection 或 Input 吞掉"
        );

        // 4. 点击终端外部（底部状态栏）时，终端选区应自动清除
        cx.simulate_mouse_down(
            point(px(10.0), px(312.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.simulate_mouse_up(
            point(px(10.0), px(312.0)),
            MouseButton::Left,
            Modifiers::default(),
        );
        cx.run_until_parked();
        cx.update(|_, cx| {
            assert!(
                !term_view.read(cx).has_selection(cx),
                "点击终端外部区域时应自动清除终端选区"
            );
        });

        // 5. 终端聚焦时按 Tab / Shift-Tab 不应被 Root 焦点循环抢走焦点
        cx.update(|window, cx| {
            let fh = term_view.read(cx).focus_handle().clone();
            fh.focus(window, cx);
            let _ = window.draw(cx);
        });
        cx.simulate_keystrokes("tab shift-tab");
        cx.run_until_parked();
        cx.update(|window, cx| {
            assert!(
                term_view.read(cx).focus_handle().is_focused(window),
                "终端聚焦时按 Tab / Shift-Tab 必须留在终端内，不得被 Root 切走焦点"
            );
        });
    }
}
