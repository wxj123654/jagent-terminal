//! Real GPUI event tests for nested & dual scrolling with Chrome Wheel Scroll Latching:
//! 1. `List` item wheel propagation inside an outer scroll container;
//! 2. `nested_scrollable` (`ScrollHandle` inside outer `ScrollHandle`):
//!    - Inner consumes wheel while mid-scroll and when reaching the bottom edge;
//!    - Same-gesture continuation / momentum after hitting the bottom edge stays latched
//!      to the inner container (never prematurely flings the outer container);
//!    - Starting a new gesture while already at the inner bottom edge chains smoothly to the outer container;
//!    - Starting a scroll gesture on the outer container and sweeping across the inner container mid-gesture
//!      keeps scrolling the outer container without being hijacked by the inner container;
//! 3. `isolated_scrollable` (`overscroll-behavior: contain`) — never leaks wheel events to outer/sibling
//!    containers even when starting a new gesture at the bottom edge.
//!
//! harness=false because AppKit must run this visual/event test on the main thread.
use gpui::{
    AppContext as _, Context, InteractiveElement, IntoElement, ListAlignment, ListState,
    ParentElement, Render, ScrollDelta, ScrollHandle, ScrollWheelEvent, StatefulInteractiveElement,
    Styled, TouchPhase, VisualTestAppContext, Window, div, list, point, px, size,
};
use gpui_component::ActiveTheme as _;
use jagent_app::{
    theme,
    views::nested_scroll::{
        isolated_scrollable, nested_scrollable, reset_wheel_latch, stop_if_list_can_scroll,
        work_panel_scrollable,
    },
};
use std::{cell::Cell, rc::Rc};

struct NestedListRoot {
    list: ListState,
    outer: ScrollHandle,
    child_saw_wheel: Rc<Cell<bool>>,
}
impl Render for NestedListRoot {
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
        .h(px(180.0))
        .flex_shrink_0();
        div()
            .id("nested-outer")
            .w(px(280.0))
            .h(px(220.0))
            .flex()
            .flex_col()
            .overflow_y_scroll()
            .track_scroll(&self.outer)
            .child(inner)
            .child(
                div()
                    .w(px(240.0))
                    .h(px(500.0))
                    .flex_shrink_0()
                    .bg(cx.theme().muted),
            )
    }
}

struct NestedHandleRoot {
    inner_nested: ScrollHandle,
    inner_isolated: ScrollHandle,
    outer: ScrollHandle,
}
impl Render for NestedHandleRoot {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Outer scroll container (height 240, total content > 600)
        div()
            .id("handle-outer")
            .w(px(320.0))
            .h(px(240.0))
            .overflow_y_scroll()
            .track_scroll(&self.outer)
            .child(
                // 1. Nested scrollable box at (0..100) y: height 100, content 200 -> max_offset = 100
                nested_scrollable("handle-inner-nested", &self.inner_nested)
                    .w(px(300.0))
                    .h(px(100.0))
                    .flex_shrink_0()
                    .bg(cx.theme().secondary)
                    .child(div().w(px(280.0)).h(px(200.0))),
            )
            .child(
                // 2. Isolated scrollable box at (100..200) y: height 100, content 200 -> max_offset = 100
                isolated_scrollable("handle-inner-isolated", &self.inner_isolated)
                    .w(px(300.0))
                    .h(px(100.0))
                    .flex_shrink_0()
                    .bg(cx.theme().muted)
                    .child(div().w(px(280.0)).h(px(200.0))),
            )
            .child(div().w(px(280.0)).h(px(500.0)).flex_shrink_0())
    }
}

fn main() {
    let mut visual = VisualTestAppContext::new(gpui_platform::current_platform(false));
    visual.update(|cx| {
        gpui_component::init(cx);
        theme::install(cx).expect("install test theme");
    });

    // ── Test 1: List inside Outer ScrollHandle ──
    reset_wheel_latch();
    let list_state =
        ListState::new(40, ListAlignment::Top, px(20.0)).with_uniform_item_height(px(28.0));
    let outer = ScrollHandle::new();
    let saw = Rc::new(Cell::new(false));
    let window = visual
        .open_offscreen_window(size(px(400.0), px(400.0)), |_, cx| {
            cx.new(|_| NestedListRoot {
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

    let dispatch = |visual: &mut VisualTestAppContext, phase: TouchPhase, delta_y: f32| {
        let vp = list_state.viewport_bounds();
        visual.simulate_event(
            window.into(),
            ScrollWheelEvent {
                position: point(vp.origin.x + px(40.0), vp.origin.y + px(20.0)),
                delta: ScrollDelta::Pixels(point(px(0.0), px(delta_y))),
                modifiers: Default::default(),
                touch_phase: phase,
            },
        );
        visual
            .update_window(window.into(), |_, window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            })
            .unwrap();
    };
    dispatch(&mut visual, TouchPhase::Started, -20.0);
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
    // Start a new gesture while the inner list is already at the bottom edge -> chains to outer!
    dispatch(&mut visual, TouchPhase::Started, -20.0);
    assert!(
        outer.offset().y < outer_before,
        "after inner list reaches bottom, a new gesture hands off to outer container"
    );

    // ── Test 2: ScrollHandle nested_scrollable & isolated_scrollable (Chrome Wheel Latching) ──
    reset_wheel_latch();
    let inner_nested = ScrollHandle::new();
    let inner_isolated = ScrollHandle::new();
    let outer2 = ScrollHandle::new();
    let window2 = visual
        .open_offscreen_window(size(px(400.0), px(400.0)), |_, cx| {
            cx.new(|_| NestedHandleRoot {
                inner_nested: inner_nested.clone(),
                inner_isolated: inner_isolated.clone(),
                outer: outer2.clone(),
            })
        })
        .expect("offscreen window 2");
    visual.run_until_parked();
    visual
        .update_window(window2.into(), |_, window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        })
        .expect("initial draw 2");

    let wheel_at = |visual: &mut VisualTestAppContext, y: f32, phase: TouchPhase, delta_y: f32| {
        visual.simulate_event(
            window2.into(),
            ScrollWheelEvent {
                position: point(px(50.0), px(y)),
                delta: ScrollDelta::Pixels(point(px(0.0), px(delta_y))),
                modifiers: Default::default(),
                touch_phase: phase,
            },
        );
        visual
            .update_window(window2.into(), |_, window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            })
            .unwrap();
    };

    // 2a. Start gesture inside nested box (at y=40) down by 60px (max is 100px):
    //     Latches to inner_nested; inner moves to -60, outer stays 0.
    wheel_at(&mut visual, 40.0, TouchPhase::Started, -60.0);
    assert_eq!(inner_nested.offset().y, px(-60.0));
    assert_eq!(
        outer2.offset().y,
        px(0.0),
        "inner nested container consumes wheel while mid-scroll"
    );

    // 2b. Continue same gesture down by 60px (only 40px remaining to hit -100px bottom):
    //     Inner clamps to -100px AND consumes this boundary-reaching event (outer stays 0!)
    wheel_at(&mut visual, 40.0, TouchPhase::Moved, -60.0);
    assert_eq!(inner_nested.offset().y, px(-100.0));
    assert_eq!(
        outer2.offset().y,
        px(0.0),
        "boundary-reaching step must be consumed by inner container without premature outer jump"
    );

    // 2c. Chrome Law A (Same-Gesture / Momentum Latch):
    //     Continuing the SAME gesture (Moved / Ended + Momentum Moved) after hitting bottom
    //     MUST stay latched to inner_nested and NOT fling outer2!
    wheel_at(&mut visual, 40.0, TouchPhase::Moved, -40.0);
    wheel_at(&mut visual, 40.0, TouchPhase::Ended, 0.0);
    wheel_at(&mut visual, 40.0, TouchPhase::Moved, -35.0);
    assert_eq!(inner_nested.offset().y, px(-100.0));
    assert_eq!(
        outer2.offset().y,
        px(0.0),
        "same gesture / trackpad momentum hitting inner bottom edge must NOT leak to outer container"
    );

    // 2d. New gesture started while inner_nested is already at -100px bottom:
    //     Now it chains smoothly to outer2!
    wheel_at(&mut visual, 40.0, TouchPhase::Started, -40.0);
    assert_eq!(inner_nested.offset().y, px(-100.0));
    assert_eq!(
        outer2.offset().y,
        px(-40.0),
        "new gesture at inner bottom edge hands off to outer scroll container"
    );

    // 2e. Chrome Law B (Outer Latch Prevents Mid-Scroll Hijack):
    //     Reset both inner_nested and outer2 to 0 (so inner_nested has full 100px scroll room).
    //     Start a scroll gesture on the OUTER area (y=220), then move the cursor over inner_nested (y=40)
    //     during the same gesture. Outer must keep scrolling and inner_nested must NOT steal it!
    inner_nested.set_offset(point(px(0.0), px(0.0)));
    outer2.set_offset(point(px(0.0), px(0.0)));
    visual
        .update_window(window2.into(), |_, window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        })
        .unwrap();

    wheel_at(&mut visual, 220.0, TouchPhase::Started, -30.0);
    assert_eq!(outer2.offset().y, px(-30.0));
    assert_eq!(inner_nested.offset().y, px(0.0));

    // Next frame of the SAME gesture lands inside inner_nested (y=40):
    wheel_at(&mut visual, 40.0, TouchPhase::Moved, -30.0);
    assert_eq!(
        inner_nested.offset().y,
        px(0.0),
        "inner container must not hijack an active outer scroll gesture or be moved by built-in listener"
    );
    assert_eq!(
        outer2.offset().y,
        px(-60.0),
        "outer scroll gesture continues smoothly across inner container"
    );

    // 2f. Reset outer2 back to 0 to test isolated_scrollable (at y=150):
    //     Even when starting a new gesture at the bottom edge, isolated_scrollable NEVER leaks!
    outer2.set_offset(point(px(0.0), px(0.0)));
    visual
        .update_window(window2.into(), |_, window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        })
        .unwrap();

    wheel_at(&mut visual, 150.0, TouchPhase::Started, -120.0);
    assert_eq!(inner_isolated.offset().y, px(-100.0));
    assert_eq!(outer2.offset().y, px(0.0));
    wheel_at(&mut visual, 150.0, TouchPhase::Started, -50.0);
    assert_eq!(inner_isolated.offset().y, px(-100.0));
    assert_eq!(
        outer2.offset().y,
        px(0.0),
        "isolated_scrollable never leaks wheel events even on a new gesture at bottom edge"
    );

    // ── Test 3: GitGraph CDV architecture (`work_panel_scrollable` inside `gpui::list`) ──
    struct GitCdvInListRoot {
        outer_list: ListState,
        cdv_files: ScrollHandle,
    }
    impl Render for GitCdvInListRoot {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let cdv_files = self.cdv_files.clone();
            let sec_bg = cx.theme().secondary;
            let muted_bg = cx.theme().muted;
            div().w(px(320.0)).h(px(260.0)).child(
                list(self.outer_list.clone(), move |ix, _, _| {
                    if ix == 1 {
                        // Inline CDV slot (height 120, inner content 220 -> max_offset = 100)
                        div()
                            .w_full()
                            .h(px(120.0))
                            .flex()
                            .flex_col()
                            .bg(sec_bg)
                            .child(work_panel_scrollable(
                                "test-git-cdv-files",
                                &cdv_files,
                                div().w(px(280.0)).h(px(220.0)),
                            ))
                            .into_any_element()
                    } else {
                        div().w_full().h(px(30.0)).bg(muted_bg).into_any_element()
                    }
                })
                .w_full()
                .h_full(),
            )
        }
    }

    reset_wheel_latch();
    let outer_list = ListState::new(30, ListAlignment::Top, px(300.0));
    let cdv_files = ScrollHandle::new();
    let window3 = visual
        .open_offscreen_window(size(px(400.0), px(400.0)), |_, cx| {
            cx.new(|_| GitCdvInListRoot {
                outer_list: outer_list.clone(),
                cdv_files: cdv_files.clone(),
            })
        })
        .expect("offscreen window 3");
    visual.run_until_parked();
    visual
        .update_window(window3.into(), |_, window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        })
        .expect("initial draw 3");

    let wheel_cdv = |visual: &mut VisualTestAppContext, y: f32, phase: TouchPhase, delta_y: f32| {
        visual.simulate_event(
            window3.into(),
            ScrollWheelEvent {
                position: point(px(60.0), px(y)),
                delta: ScrollDelta::Pixels(point(px(0.0), px(delta_y))),
                modifiers: Default::default(),
                touch_phase: phase,
            },
        );
        visual
            .update_window(window3.into(), |_, window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            })
            .unwrap();
    };

    // 3a. Scroll inside CDV (at y=60, inside item 1 which spans y=30..150):
    //     Inner cdv_files scrolls to -60, then -100, and same-gesture momentum (-50) stays latched!
    wheel_cdv(&mut visual, 60.0, TouchPhase::Started, -60.0);
    assert_eq!(cdv_files.offset().y, px(-60.0));
    assert_eq!(outer_list.scroll_px_offset_for_scrollbar().y, px(0.0));

    wheel_cdv(&mut visual, 60.0, TouchPhase::Moved, -60.0);
    wheel_cdv(&mut visual, 60.0, TouchPhase::Ended, 0.0);
    wheel_cdv(&mut visual, 60.0, TouchPhase::Moved, -50.0);
    assert_eq!(cdv_files.offset().y, px(-100.0));
    assert_eq!(
        outer_list.scroll_px_offset_for_scrollbar().y,
        px(0.0),
        "CDV inside gpui::list must absorb same-gesture boundary & momentum events without scrolling the outer commit list"
    );

    // 3b. Start a new gesture while CDV is at bottom -> chains to outer gpui::list!
    wheel_cdv(&mut visual, 60.0, TouchPhase::Started, -40.0);
    assert_eq!(cdv_files.offset().y, px(-100.0));
    assert_eq!(
        outer_list.scroll_px_offset_for_scrollbar().y,
        px(-40.0),
        "new gesture at CDV bottom edge chains to outer gpui::list"
    );

    // 3c. Reset both to top; start gesture on commit row 0 (y=15), then sweep over CDV (y=60):
    //     Outer gpui::list keeps scrolling and CDV must NOT hijack!
    outer_list.scroll_to(gpui::ListOffset {
        item_ix: 0,
        offset_in_item: px(0.0),
    });
    cdv_files.set_offset(point(px(0.0), px(0.0)));
    visual
        .update_window(window3.into(), |_, window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        })
        .unwrap();

    wheel_cdv(&mut visual, 15.0, TouchPhase::Started, -20.0);
    assert_eq!(outer_list.scroll_px_offset_for_scrollbar().y, px(-20.0));
    assert_eq!(cdv_files.offset().y, px(0.0));

    wheel_cdv(&mut visual, 60.0, TouchPhase::Moved, -30.0);
    assert_eq!(
        cdv_files.offset().y,
        px(0.0),
        "CDV must not hijack an active outer gpui::list scroll when sweeping under cursor"
    );
    assert_eq!(
        outer_list.scroll_px_offset_for_scrollbar().y,
        px(-50.0),
        "outer gpui::list continues scrolling smoothly across CDV"
    );

    println!(
        "NESTED_SCROLL OK: Chrome wheel scroll latching + edge handoff + isolated containment"
    );
}
