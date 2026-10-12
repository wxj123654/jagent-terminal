//! Nested scrolling policy: let an inner scroll owner consume events while it can move; at an edge,
//! leave the wheel event unhandled so the parent scroll container can continue the gesture.
use gpui::{App, ScrollHandle, ScrollWheelEvent, Window};

/// Apply the policy to a scroll handle-backed inner viewport.
pub fn stop_if_inner_can_scroll(
    handle: &ScrollHandle,
    event: &ScrollWheelEvent,
    window: &Window,
    cx: &mut App,
) -> bool {
    let dy = f32::from(event.delta.pixel_delta(window.line_height()).y);
    if dy == 0.0 {
        return false;
    }
    let offset = f32::from(handle.offset().y);
    let max = f32::from(handle.max_offset().y).max(0.0);
    let can_scroll = (dy < 0.0 && offset > -max) || (dy > 0.0 && offset < 0.0);
    if can_scroll {
        cx.stop_propagation();
    }
    can_scroll
}

/// Inner-first wheel policy for callers that attach the handler to a list item.
/// Returns true when the item must stop propagation because the owning List still has scroll range.
pub fn stop_if_list_can_scroll(
    list: &gpui::ListState,
    event: &ScrollWheelEvent,
    window: &Window,
    cx: &mut App,
) -> bool {
    let dy = event.delta.pixel_delta(window.line_height()).y;
    let offset = list.scroll_px_offset_for_scrollbar().y;
    let max = list.max_offset_for_scrollbar().y;
    let can_scroll =
        (dy < gpui::px(0.0) && offset > -max) || (dy > gpui::px(0.0) && offset < gpui::px(0.0));
    if can_scroll {
        // GPUI dispatches the row's bubble handler before List's own bubble handler.
        list.scroll_by(-dy);
        cx.stop_propagation();
    }
    can_scroll
}

/// Isolate a handle-backed work panel viewport from the surrounding pane.
pub fn work_panel_scrollable(
    id: impl Into<gpui::SharedString>,
    handle: &ScrollHandle,
    content: impl gpui::IntoElement,
) -> impl gpui::IntoElement {
    use gpui::{
        InteractiveElement as _, ParentElement as _, StatefulInteractiveElement as _, Styled as _,
        div,
    };
    let handle_for_event = handle.clone();
    div()
        .id(id.into())
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .track_scroll(handle)
        .on_scroll_wheel(move |event, window, cx| {
            stop_if_inner_can_scroll(&handle_for_event, event, window, cx);
        })
        .child(content)
}

#[cfg(test)]
mod tests {
    #[test]
    fn scroll_policy_direction_rules() {
        fn can(dy: f32, offset: f32, max: f32) -> bool {
            (dy < 0.0 && offset > -max) || (dy > 0.0 && offset < 0.0)
        }
        assert!(can(-1.0, -20.0, 100.0));
        assert!(!can(-1.0, -100.0, 100.0));
        assert!(can(1.0, -20.0, 100.0));
        assert!(!can(1.0, 0.0, 100.0));
        assert!(!can(0.0, -20.0, 100.0));
    }
}
