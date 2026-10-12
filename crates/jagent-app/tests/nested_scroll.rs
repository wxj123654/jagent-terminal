//! Real GPUI event test for child `list` wheel propagation inside an outer scroll container.
//! The list is the actual virtualized element; an item-level handler stops propagation when
//! list content can move, while the outer container receives wheel events after the list edge.
//! harness=false because AppKit must run this visual/event test on the main thread.
use gpui::{
    AppContext as _, Context, InteractiveElement, IntoElement, ListAlignment, ListState,
    ParentElement, Render, ScrollDelta, ScrollHandle, ScrollWheelEvent, StatefulInteractiveElement,
    Styled, TouchPhase, VisualTestAppContext, Window, div, list, point, px, size,
};
use gpui_component::ActiveTheme as _;
use jagent_app::{theme, views::nested_scroll::stop_if_list_can_scroll};
use std::{cell::Cell, rc::Rc};

struct NestedRoot {
    list: ListState,
    outer: ScrollHandle,
    child_saw_wheel: Rc<Cell<bool>>,
}
impl Render for NestedRoot {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let inner_state = self.list.clone().with_uniform_item_height(px(28.0));
        let saw = self.child_saw_wheel.clone();
        let inner = list(inner_state.clone(), move |_, _, cx| {
            let inner_state = inner_state.clone();
            let saw = saw.clone();
            div()
                .w_full()
                .h(px(28.0))
                .bg(cx.theme().secondary)
                .on_scroll_wheel(move |event, window, cx| {
                    saw.set(true);
                    let _ = stop_if_list_can_scroll(&inner_state, event, window, cx);
                })
                .into_any_element()
        })
        .h(px(180.0));
        div()
            .id("nested-outer")
            .w(px(280.0))
            .h(px(220.0))
            .overflow_y_scroll()
            .track_scroll(&self.outer)
            .child(inner)
            .child(div().w(px(240.0)).h(px(500.0)).bg(cx.theme().muted))
    }
}

fn main() {
    let mut visual = VisualTestAppContext::new(gpui_platform::current_platform(false));
    visual.update(|cx| {
        gpui_component::init(cx);
        theme::install(cx).expect("install test theme");
    });
    let list_state =
        ListState::new(40, ListAlignment::Top, px(20.0)).with_uniform_item_height(px(28.0));
    let outer = ScrollHandle::new();
    let saw = Rc::new(Cell::new(false));
    let window = visual
        .open_offscreen_window(size(px(400.0), px(400.0)), |_, cx| {
            cx.new(|_| NestedRoot {
                list: list_state.clone(),
                outer: outer.clone(),
                child_saw_wheel: saw.clone(),
            })
        })
        .expect("offscreen window");
    visual.run_until_parked();
    visual
        .update_window(window.into(), |_, window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        })
        .expect("initial draw");

    let dispatch = |visual: &mut VisualTestAppContext, delta_y: f32| {
        let row = list_state
            .bounds_for_item(list_state.logical_scroll_top().item_ix)
            .unwrap_or_else(|| list_state.viewport_bounds());
        visual.simulate_event(
            window.into(),
            ScrollWheelEvent {
                position: point(row.origin.x + px(40.0), row.origin.y + px(10.0)),
                delta: ScrollDelta::Pixels(point(px(0.0), px(delta_y))),
                modifiers: Default::default(),
                touch_phase: TouchPhase::Moved,
            },
        );
        visual
            .update_window(window.into(), |_, window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            })
            .unwrap();
    };
    dispatch(&mut visual, -20.0);
    assert!(saw.get(), "wheel reached actual List child");
    assert!(
        list_state.logical_scroll_top().item_ix > 0
            || list_state.logical_scroll_top().offset_in_item > px(0.0)
    );
    assert_eq!(
        outer.offset().y,
        px(0.0),
        "inner list consumes wheel before outer scroll"
    );
    list_state.scroll_to(gpui::ListOffset {
        item_ix: 40,
        offset_in_item: px(0.0),
    });
    visual
        .update_window(window.into(), |_, window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        })
        .unwrap();
    assert_eq!(list_state.is_scrolled_to_end(), Some(true));
    let outer_before = outer.offset().y;
    dispatch(&mut visual, -20.0);
    assert!(
        outer.offset().y <= outer_before,
        "at list edge the list does not claim more scroll than its range"
    );
    assert!(
        !list_state.logical_scroll_top().item_ix.eq(&0),
        "edge handoff does not reset inner List position"
    );
    println!("NESTED_SCROLL OK: list item wheel/edge handoff");
}
