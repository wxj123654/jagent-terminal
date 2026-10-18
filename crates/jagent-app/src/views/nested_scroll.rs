//! 统一双滚动区域与嵌套滚动策略（Chrome Wheel Scroll Latching + `gpui-component` Scrollbar）：
//!
//! 1. **Chrome 级滚轮手势锁存（Wheel Scroll Latching）与边缘穿透（Scroll Chaining）**：
//!    对齐 Chromium (`cc/trees/layer_tree_host_impl` & Blink `WheelScrollLatching`) 的双定律：
//!    - **手势起点定目标（Latch on Gesture Begin）**：在每次滚动手势序列开始时（`TouchPhase::Started`、
//!      距上一滚轮事件静默超时 `>= 140ms`、或滚动方向反转），才决定本次手势由内层容器消费还是向父容器穿透。
//!    - **定律 A：内层锁存防触底瞬穿（`LatchTarget::Inner`）**：若手势在内层容器启动时内层在该方向上
//!      有可滚动余量，则整次手势（含手指滑动中途触底后的剩余帧，以及紧随 `TouchPhase::Ended` 之后的
//!      macOS 触控板惯性 Momentum 帧）**全程锁存在该内层容器**并调用 `cx.stop_propagation()`，
//!      到达顶/底边界时平稳刹停，绝不在同一次手势中途突然穿透把外层画布/列表滚飞。
//!      当内层已处于边界后，用户再次发起新滑动手势时，手势起点判定内层无余量，顺滑穿透给外层。
//!    - **定律 B：外层锁存防中途截胡（`LatchTarget::Outer`）**：若手势在外层空白处启动（或手势起点时
//!      内层已在边界而穿透给外层），则整次手势**全程锁存在外层容器**；即便外层滚动过程中把内层可滚容器
//!      带到鼠标指针下方，内层容器也会立即还原自身偏移并放行事件，绝不半路截胡外层滚动。
//!
//! 2. **独立分栏滚轮完全隔离（`isolated_scrollable`，对应 CSS `overscroll-behavior: contain`）**：
//!    适用于并排独立面板或浮层列表（右侧 `WorkPanel`、设置窗口左导航轨与右主内容区、主画布 `FileSurface`）。
//!    在面板内启动的手势始终钳制偏移并停止冒泡；若外层滚动手势中途滑过该面板则不抢占外层手势。
//!
//! 3. **`gpui-component` 原生比例滚动条与边缘渐隐遮罩（`with_minimal_scroll_indicators`）**：
//!    集成 `gpui_component::scroll::{Scrollbar, ScrollbarMode}`，按真实 `viewport / content` 比例计算滑块长度，
//!    支持鼠标悬停加宽与拖拽滑块滚动，无溢出时自动隐藏；配合顶/底边缘渐隐遮罩消除视觉割裂。

use std::{
    cell::RefCell,
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

use gpui::{
    App, Bounds, DispatchPhase, Element, ElementId, GlobalElementId, InspectorElementId,
    InteractiveElement as _, IntoElement, IsZero as _, LayoutId, ParentElement as _, Pixels,
    Position, ScrollHandle, ScrollWheelEvent, SharedString, Stateful,
    StatefulInteractiveElement as _, Style, Styled as _, TouchPhase, Window, div,
    linear_color_stop, linear_gradient, point, prelude::FluentBuilder as _, px,
};
use gpui_component::scroll::{Scrollbar, ScrollbarHandle, ScrollbarMode};

use crate::theme::rgba_css;

/// 判定内层滚动区的最小有效余量（像素），避免 Taffy 亚像素误差导致在边界处卡死不穿透。
const SCROLL_EDGE_EPSILON: f32 = 0.5;

/// 滚轮手势序列静默超时阈值（对齐 Chromium Wheel Scroll Latching / GPUI 手势分隔阈值）：
/// 触控板滑动与惯性（Momentum）帧间隔通常为 8~16ms（60~120Hz）；
/// 一旦连续两个滚轮事件间隔超过 140ms，即视为上一手势/惯性已结束，下一事件开启全新手势。
pub const WHEEL_LATCH_TIMEOUT: Duration = Duration::from_millis(140);

/// Chrome Wheel Scroll Latching 的手势锁存目标。
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum LatchTarget {
    /// 新手势首帧，尚未被任何内层容器认领（等待 Bubble 阶段命中的内层容器根据自身边界状态决策；
    /// 若本帧无任何内层容器认领，则表明手势在外层空白处启动，在下一帧结算为 `Outer`）。
    #[default]
    Pending,
    /// 手势已锁存在指定 ID 的内层容器上：
    /// 整次手势（含中途触底后的剩余滑动与触控板惯性余波）均由该内层容器消费，绝不中途穿透给外层。
    Inner(ElementId),
    /// 手势已锁存在外层容器上（手势在外层空白处启动，或手势启动时内层已在边界而穿透给外层）：
    /// 整次手势期间，即便内层容器随外层滚动滑到鼠标指针下方，内层也必须放行并还原自身偏移，绝不半路截胡。
    Outer,
}

/// 纯函数：给定滚轮 `dy`（向下滚 `< 0`，向上滚 `> 0`）、本次滚动**前**的偏移量 `offset_before`
/// （范围 `[-max, 0]`）以及最大可滚范围 `max`（`>= 0`），判断内层容器是否还能沿该方向移动。
#[inline]
pub fn can_scroll_direction(dy: f32, offset_before: f32, max: f32) -> bool {
    let max = max.max(0.0);
    if max <= SCROLL_EDGE_EPSILON || dy == 0.0 {
        return false;
    }
    (dy < 0.0 && offset_before > -max + SCROLL_EDGE_EPSILON)
        || (dy > 0.0 && offset_before < -SCROLL_EDGE_EPSILON)
}

/// Chrome Wheel Scroll Latching 状态机（纯逻辑，支持注入 `Instant` 进行确定性单元测试）。
#[derive(Clone, Debug, Default)]
pub struct WheelLatchMachine {
    pub target: LatchTarget,
    last_event_at: Option<Instant>,
    last_dy: f32,
    /// 收到 `TouchPhase::Started` 且 `dy == 0`（如 macOS `NSEventPhaseMayBegin`）后，
    /// 等待紧随其后的第一个非零 `dy` 帧作为真正的手势起点。
    awaiting_first_delta: bool,
    /// 防止同一 `ScrollWheelEvent` 在 Capture 阶段被多个传感器重复推进状态。
    event_in_flight: bool,
    /// 当前事件在 Capture 阶段为各内层容器拍下的真实 `(offset_before, max_offset)` 快照。
    before_snapshots: HashMap<ElementId, (f32, f32)>,
}

impl WheelLatchMachine {
    pub fn new() -> Self {
        Self::default()
    }

    /// 重置锁存状态（用于新建手势或测试隔离）。
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// 在 `DispatchPhase::Capture` 阶段调用：推进手势边界状态机（每个 `ScrollWheelEvent` 仅推进一次）。
    pub fn begin_wheel_event(&mut self, touch_phase: TouchPhase, dy: f32, now: Instant) {
        if self.event_in_flight {
            return;
        }
        self.event_in_flight = true;
        self.before_snapshots.clear();

        // 若上一帧事件结束时仍处于 Pending（且已发生过非零滚动），说明上一帧没有命中任何内层容器，
        // 而是落在了外层空白区域 -> 将上一帧的手势锁存目标正式结算为 Outer。
        if self.target == LatchTarget::Pending
            && self.last_event_at.is_some()
            && !self.awaiting_first_delta
        {
            self.target = LatchTarget::Outer;
        }

        // 1. 显式触控板新手势起点（macOS MayBegin / Began）
        if touch_phase == TouchPhase::Started {
            self.target = LatchTarget::Pending;
            self.last_event_at = Some(now);
            if dy.abs() <= f32::EPSILON {
                self.awaiting_first_delta = true;
                self.last_dy = 0.0;
            } else {
                self.awaiting_first_delta = false;
                self.last_dy = dy;
            }
            return;
        }

        // 2. 手指抬起（Ended / Cancelled）：
        // 注意：在 GPUI macOS 中，手指离开触控板触发 TouchPhase::Ended (dy=0) 后，
        // 紧接着 8~16ms 内到来的惯性（Momentum）事件是以 TouchPhase::Moved 发送的！
        // 因此绝不能在 Ended 时清空 target，必须保留当前锁存目标以拦截触底后的惯性余波。
        if matches!(touch_phase, TouchPhase::Ended | TouchPhase::Cancelled)
            && dy.abs() <= f32::EPSILON
        {
            self.last_event_at = Some(now);
            return;
        }

        if dy.abs() <= f32::EPSILON {
            return;
        }

        // 3. 判定是否开启全新滚动手势：
        // - 刚收到过 dy=0 的 TouchPhase::Started（awaiting_first_delta）
        // - 距离上一滚轮事件已超过静默阈值 WHEEL_LATCH_TIMEOUT (140ms)
        // - 滚动方向发生反转（用户反向拨轮/反向滑动，立即解除边界锁并响应新方向）
        let timed_out = self
            .last_event_at
            .is_none_or(|t| now.saturating_duration_since(t) >= WHEEL_LATCH_TIMEOUT);
        let reversed = self.last_dy != 0.0 && dy.signum() != self.last_dy.signum();

        if self.awaiting_first_delta || timed_out || reversed {
            self.target = LatchTarget::Pending;
            self.awaiting_first_delta = false;
        }

        self.last_event_at = Some(now);
        self.last_dy = dy;
    }

    /// 记录内层容器在 Capture 阶段（未被内置 `paint_scroll_listener` 修改前）的真实偏移量快照。
    pub fn record_before_snapshot(&mut self, id: ElementId, before: f32, max: f32) {
        self.before_snapshots.insert(id, (before, max));
    }

    /// 取出 Capture 阶段记录的真实 `(before, max)` 快照。
    pub fn take_before_snapshot(&mut self, id: &ElementId) -> Option<(f32, f32)> {
        self.before_snapshots.remove(id)
    }

    /// 在 `DispatchPhase::Bubble` 开头复位单事件重入标记。
    pub fn end_capture_pass(&mut self) {
        self.event_in_flight = false;
    }

    /// 针对 `nested_scrollable`（对应 `overscroll-behavior: auto` + Chrome Scroll Latching）决策：
    /// 返回 `true` 表示本次事件由内层容器消费并 `stop_propagation()`；
    /// 返回 `false` 表示穿透/放行给外层容器（内层必须将偏移还原为 `before`）。
    pub fn decide_inner_scroll(&mut self, inner_id: &ElementId, can_scroll_now: bool) -> bool {
        match &self.target {
            LatchTarget::Pending => {
                if can_scroll_now {
                    self.target = LatchTarget::Inner(inner_id.clone());
                    true
                } else {
                    self.target = LatchTarget::Outer;
                    false
                }
            }
            LatchTarget::Inner(latched_id) => latched_id == inner_id,
            LatchTarget::Outer => false,
        }
    }

    /// 针对 `isolated_scrollable`（对应 `overscroll-behavior: contain`）决策：
    /// 只要当前手势不是在外层启动并已锁存在 `Outer`，就始终由本容器消费并隔离滚轮。
    pub fn decide_isolated_scroll(&mut self, inner_id: &ElementId) -> bool {
        match &self.target {
            LatchTarget::Outer => false,
            LatchTarget::Pending => {
                self.target = LatchTarget::Inner(inner_id.clone());
                true
            }
            LatchTarget::Inner(latched_id) => latched_id == inner_id,
        }
    }
}

thread_local! {
    static GLOBAL_WHEEL_LATCH: RefCell<WheelLatchMachine> = RefCell::new(WheelLatchMachine::new());
}

/// 重置全局滚轮手势锁存状态（供测试模拟两次独立手势时无需 sleep 等待超时）。
pub fn reset_wheel_latch() {
    GLOBAL_WHEEL_LATCH.with(|m| m.borrow_mut().reset());
}

/// 将 `ScrollHandle` 的纵向偏移立即钳制在 `[-max, 0.0]`，并返回 `(滚动前偏移, 钳制后偏移, max)`。
///
/// 当无 Capture 阶段快照时作为后备还原手段：GPUI `Div::paint` 先注册用户的 `on_scroll_wheel`、
/// 后注册内置 `paint_scroll_listener`；在 `DispatchPhase::Bubble` 逆序执行时，内置 listener
/// 先把 `dy` 加到了 `handle.offset().y` 上（且未 clamp）。
pub fn clamp_and_recover_before_offset(handle: &ScrollHandle, dy: f32) -> (f32, f32, f32) {
    let max = f32::from(handle.max_offset().y).max(0.0);
    let current = handle.offset();
    let raw_after = f32::from(current.y);
    let before = (raw_after - dy).clamp(-max, 0.0);
    let clamped_after = raw_after.clamp(-max, 0.0);
    if (raw_after - clamped_after).abs() > 0.001 {
        handle.set_offset(point(current.x, px(clamped_after)));
    }
    (before, clamped_after, max)
}

/// 零尺寸绝对定位传感器：
/// 在 `DispatchPhase::Capture` 阶段（早于所有 `Bubble` 监听器）拍下 `ScrollHandle` 的真实 `before_offset`，
/// 并推进全窗口的 Chrome Wheel Scroll Latching 状态机（含检测在外层空白区域发起的滚动手势）。
struct WheelLatchSensor {
    id: ElementId,
    handle: ScrollHandle,
}

impl WheelLatchSensor {
    fn new(id: ElementId, handle: ScrollHandle) -> Self {
        Self { id, handle }
    }
}

impl IntoElement for WheelLatchSensor {
    type Element = Self;
    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for WheelLatchSensor {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let style = Style {
            position: Position::Absolute,
            ..Default::default()
        };
        (window.request_layout(style, None, cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut Window,
        _: &mut App,
    ) {
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        _: &mut App,
    ) {
        let id = self.id.clone();
        let handle = self.handle.clone();
        let line_height = window.line_height();
        window.on_mouse_event(move |event: &ScrollWheelEvent, phase, _window, _cx| {
            match phase {
                DispatchPhase::Capture => {
                    let delta = event.delta.pixel_delta(line_height);
                    // 若开启了轴向限制且横向分量占优，纵向实际增量为 0
                    let dy = if !delta.x.is_zero() && delta.x.abs() > delta.y.abs() {
                        0.0
                    } else {
                        f32::from(delta.y)
                    };
                    let max = f32::from(handle.max_offset().y).max(0.0);
                    let before = f32::from(handle.offset().y).clamp(-max, 0.0);
                    GLOBAL_WHEEL_LATCH.with(|m| {
                        let mut m = m.borrow_mut();
                        m.begin_wheel_event(event.touch_phase, dy, Instant::now());
                        m.record_before_snapshot(id.clone(), before, max);
                    });
                }
                DispatchPhase::Bubble => {
                    GLOBAL_WHEEL_LATCH.with(|m| m.borrow_mut().end_capture_pass());
                }
            }
        });
    }
}

/// 带 Chrome Wheel Scroll Latching 的内层优先滚轮处理：
/// - 若当前手势锁存在本内层容器（含滚动中途刚触达边界及随后的惯性阶段），将偏移钳制在 `[-max, 0.0]`
///   并调用 `cx.stop_propagation()`；
/// - 若手势起点已在边界而穿透给外层，或当前手势原本就锁存在外层（外层滚动途中滑过本容器），
///   立即将本内层容器被内置 listener 预加的偏移还原回 `before`，并放行事件给外层容器。
pub fn handle_nested_wheel_with_id(
    id: &ElementId,
    handle: &ScrollHandle,
    event: &ScrollWheelEvent,
    window: &Window,
    cx: &mut App,
) -> bool {
    let delta = event.delta.pixel_delta(window.line_height());
    let dy = if !delta.x.is_zero() && delta.x.abs() > delta.y.abs() {
        0.0
    } else {
        f32::from(delta.y)
    };
    if dy == 0.0 {
        return false;
    }

    let snapshot = GLOBAL_WHEEL_LATCH.with(|m| {
        let mut m = m.borrow_mut();
        // 若未挂载 WheelLatchSensor（如直接调用 stop_if_inner_can_scroll），在此兜底推进状态机
        if !m.event_in_flight && !m.before_snapshots.contains_key(id) {
            m.begin_wheel_event(event.touch_phase, dy, Instant::now());
            m.end_capture_pass();
        }
        m.take_before_snapshot(id)
    });

    let (before, max) = match snapshot {
        Some((b, m)) => (b, m),
        None => {
            let (b, _after, m) = clamp_and_recover_before_offset(handle, dy);
            (b, m)
        }
    };

    let can_scroll_now = can_scroll_direction(dy, before, max);
    let consume =
        GLOBAL_WHEEL_LATCH.with(|m| m.borrow_mut().decide_inner_scroll(id, can_scroll_now));

    let current = handle.offset();
    if consume {
        let target_y = (before + dy).clamp(-max, 0.0);
        if (f32::from(current.y) - target_y).abs() > 0.001 {
            handle.set_offset(point(current.x, px(target_y)));
        }
        cx.stop_propagation();
        true
    } else {
        // 放行给外层时，必须撤销 GPUI 内置 paint_scroll_listener 刚才在 Bubble 阶段对本内层的修改！
        if (f32::from(current.y) - before).abs() > 0.001 {
            handle.set_offset(point(current.x, px(before)));
        }
        false
    }
}

/// 兼容旧签名：对给定 `ScrollHandle` 应用内层滚动优先 + 边缘穿透策略。
pub fn stop_if_inner_can_scroll(
    handle: &ScrollHandle,
    event: &ScrollWheelEvent,
    window: &Window,
    cx: &mut App,
) -> bool {
    let id = ElementId::Name("anon-nested-scroll".into());
    handle_nested_wheel_with_id(&id, handle, event, window, cx)
}

/// 独立分栏滚轮隔离策略（`overscroll-behavior: contain`）：
/// 当手势在本面板内启动时，始终钳制 `ScrollHandle` 偏移量并停止滚轮冒泡；
/// 当外层手势正在滚动并滑过本面板时，还原自身偏移并放行给外层。
pub fn handle_isolated_wheel_with_id(
    id: &ElementId,
    handle: &ScrollHandle,
    event: &ScrollWheelEvent,
    window: &Window,
    cx: &mut App,
) {
    let delta = event.delta.pixel_delta(window.line_height());
    let dy = if !delta.x.is_zero() && delta.x.abs() > delta.y.abs() {
        0.0
    } else {
        f32::from(delta.y)
    };
    let snapshot = GLOBAL_WHEEL_LATCH.with(|m| m.borrow_mut().take_before_snapshot(id));
    let (before, max) = match snapshot {
        Some((b, m)) => (b, m),
        None => {
            let (b, _after, m) = clamp_and_recover_before_offset(handle, dy);
            (b, m)
        }
    };

    let consume = GLOBAL_WHEEL_LATCH.with(|m| m.borrow_mut().decide_isolated_scroll(id));
    let current = handle.offset();
    if consume {
        let target_y = (before + dy).clamp(-max, 0.0);
        if (f32::from(current.y) - target_y).abs() > 0.001 {
            handle.set_offset(point(current.x, px(target_y)));
        }
        cx.stop_propagation();
    } else if (f32::from(current.y) - before).abs() > 0.001 {
        handle.set_offset(point(current.x, px(before)));
    }
}

/// 兼容旧签名：钳制 `ScrollHandle` 偏移量并始终停止滚轮冒泡。
pub fn stop_and_clamp_isolated_scroll(
    handle: &ScrollHandle,
    event: &ScrollWheelEvent,
    window: &Window,
    cx: &mut App,
) {
    let dy = f32::from(event.delta.pixel_delta(window.line_height()).y);
    let _ = clamp_and_recover_before_offset(handle, dy);
    cx.stop_propagation();
}

/// 当鼠标在复合面板的固定头部（如 Git CDV 左栏顶部 4 行元数据或右栏文件数标题条）滚动时，
/// 主动将滚轮增量转发给对应的内层 `ScrollHandle` 并纳入同一套 Chrome Wheel Scroll Latching 状态机，
/// 避免鼠标停在面板上半部固定区滚动时意外穿透滚走外层列表。
pub fn forward_wheel_to_nested_handle(
    id: impl Into<ElementId>,
    handle: &ScrollHandle,
    event: &ScrollWheelEvent,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let id = id.into();
    let delta = event.delta.pixel_delta(window.line_height());
    let dy = if !delta.x.is_zero() && delta.x.abs() > delta.y.abs() {
        0.0
    } else {
        f32::from(delta.y)
    };
    if dy == 0.0 {
        return false;
    }
    let max = f32::from(handle.max_offset().y).max(0.0);
    let current = handle.offset();
    let before = f32::from(current.y).clamp(-max, 0.0);
    let can_scroll_now = can_scroll_direction(dy, before, max);
    let consume =
        GLOBAL_WHEEL_LATCH.with(|m| m.borrow_mut().decide_inner_scroll(&id, can_scroll_now));
    if consume {
        let target_y = (before + dy).clamp(-max, 0.0);
        if (f32::from(current.y) - target_y).abs() > 0.001 {
            handle.set_offset(point(current.x, px(target_y)));
            window.refresh();
        }
        cx.stop_propagation();
        true
    } else {
        false
    }
}

/// 针对虚拟列表 `ListState` 子项的内层优先滚轮策略（含 Chrome Wheel Scroll Latching）：
/// 当 `ListState` 在手势起点仍有滚动余量时锁存并主动滚动列表、阻止向更外层容器冒泡；
/// 手势途中触底保持锁存不瞬穿，已在边界后新起手势则放行给外层。
pub fn stop_if_list_can_scroll(
    list: &gpui::ListState,
    event: &ScrollWheelEvent,
    window: &Window,
    cx: &mut App,
) -> bool {
    let dy_px = event.delta.pixel_delta(window.line_height()).y;
    let dy = f32::from(dy_px);
    if dy == 0.0 {
        return false;
    }
    let offset = f32::from(list.scroll_px_offset_for_scrollbar().y);
    let max = f32::from(list.max_offset_for_scrollbar().y).max(0.0);
    let can_scroll_now = can_scroll_direction(dy, offset, max);
    let list_id = ElementId::Name("nested-virtual-list".into());
    let consume = GLOBAL_WHEEL_LATCH.with(|m| {
        let mut m = m.borrow_mut();
        m.begin_wheel_event(event.touch_phase, dy, Instant::now());
        m.end_capture_pass();
        m.decide_inner_scroll(&list_id, can_scroll_now)
    });
    if consume {
        if can_scroll_now {
            // GPUI dispatches the row's bubble handler before List's own bubble handler.
            list.scroll_by(-dy_px);
        }
        cx.stop_propagation();
    }
    consume
}

/// 构造带「Chrome Wheel Scroll Latching（内层锁存防触底瞬穿 + 外层锁存防截胡 + 触底新起手势边缘穿透）」
/// 的 `Stateful<Div>` 滚动容器，调用方可在返回值上继续链式设置样式与子元素。
pub fn nested_scrollable(id: impl Into<ElementId>, handle: &ScrollHandle) -> Stateful<gpui::Div> {
    let id = id.into();
    let id_for_event = id.clone();
    let handle_for_event = handle.clone();
    div()
        .id(id.clone())
        .overflow_y_scroll()
        .restrict_scroll_to_axis()
        .track_scroll(handle)
        .child(WheelLatchSensor::new(id, handle.clone()))
        .on_scroll_wheel(move |event, window, cx| {
            handle_nested_wheel_with_id(&id_for_event, &handle_for_event, event, window, cx);
        })
}

/// 构造带「滚轮完全隔离（`overscroll-behavior: contain`）」的独立分栏 `Stateful<Div>` 滚动容器。
pub fn isolated_scrollable(id: impl Into<ElementId>, handle: &ScrollHandle) -> Stateful<gpui::Div> {
    let id = id.into();
    let id_for_event = id.clone();
    let handle_for_event = handle.clone();
    div()
        .id(id.clone())
        .overflow_y_scroll()
        .restrict_scroll_to_axis()
        .track_scroll(handle)
        .child(WheelLatchSensor::new(id, handle.clone()))
        .on_scroll_wheel(move |event, window, cx| {
            handle_isolated_wheel_with_id(&id_for_event, &handle_for_event, event, window, cx);
        })
}

/// 构造基于 `gpui-component` 原生 [`Scrollbar`] 的极简纵向覆盖层：
/// - 滑块长度按真实 `viewport / content` 比例动态计算（在 `prepaint` 阶段读取最新布局尺寸，首帧即准，无滞后）；
/// - 支持鼠标悬停加宽与按住滑块拖拽滚动；
/// - 当内容未溢出（`content <= viewport`）时自动隐藏，零视觉负担。
pub fn minimal_vertical_scrollbar<H: ScrollbarHandle + Clone>(
    id: impl Into<ElementId>,
    handle: &H,
) -> gpui::Div {
    div().absolute().inset_0().child(
        Scrollbar::vertical(handle)
            .id(id.into())
            .viewport_from_layout()
            .mode(ScrollbarMode::Always)
            .styles(|styles| {
                styles
                    .track(|t| t.bg(gpui::transparent_black()).width(px(7.0)))
                    .track_hover(|t| t.bg(rgba_css(255, 255, 255, 0.03)).width(px(7.0)))
                    .track_active(|t| t.bg(rgba_css(255, 255, 255, 0.05)).width(px(7.0)))
                    .thumb(|t| {
                        t.bg(rgba_css(126, 136, 155, 0.45))
                            .width(px(3.0))
                            .inset(px(2.0))
                            .radius(px(99.0))
                            .min_length(px(20.0))
                    })
                    .thumb_hover(|t| {
                        t.bg(rgba_css(160, 170, 192, 0.72))
                            .width(px(4.5))
                            .inset(px(1.25))
                            .radius(px(99.0))
                            .min_length(px(20.0))
                    })
                    .thumb_active(|t| {
                        t.bg(rgba_css(185, 195, 215, 0.88))
                            .width(px(4.5))
                            .inset(px(1.25))
                            .radius(px(99.0))
                            .min_length(px(20.0))
                    })
            }),
    )
}

static NEXT_SCROLLBAR_ID: AtomicU64 = AtomicU64::new(1);

/// 为任意受 `ScrollHandle` 追踪的滚动区叠加「`gpui-component` 原生比例胶囊滚动条 + 上下边缘溢出渐隐遮罩」。
pub fn with_minimal_scroll_indicators(
    handle: &ScrollHandle,
    scrollable: impl IntoElement,
) -> gpui::Div {
    let max_y = f32::from(handle.max_offset().y).max(0.0);
    let cur_y = (-f32::from(handle.offset().y)).clamp(0.0, max_y);
    let has_overflow = max_y > 1.5;
    let has_top = has_overflow && cur_y > 1.5;
    let has_bottom = has_overflow && cur_y < max_y - 1.5;
    let bar_seq = NEXT_SCROLLBAR_ID.fetch_add(1, Ordering::Relaxed);

    div()
        .relative()
        .flex()
        .flex_col()
        .min_h_0()
        .min_w_0()
        .overflow_hidden()
        .child(scrollable)
        // 顶部溢出渐隐提示（上方仍有隐藏内容时浮现）
        .when(has_top, |d| {
            d.child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(px(10.0))
                    .bg(linear_gradient(
                        180.0,
                        linear_color_stop(rgba_css(11, 13, 18, 0.58), 0.0),
                        linear_color_stop(rgba_css(11, 13, 18, 0.0), 1.0),
                    )),
            )
        })
        // 底部溢出渐隐提示（下方仍有隐藏内容时浮现）
        .when(has_bottom, |d| {
            d.child(
                div()
                    .absolute()
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .h(px(12.0))
                    .bg(linear_gradient(
                        0.0,
                        linear_color_stop(rgba_css(11, 13, 18, 0.65), 0.0),
                        linear_color_stop(rgba_css(11, 13, 18, 0.0), 1.0),
                    )),
            )
        })
        // gpui-component 原生比例胶囊滑块（prepaint 阶段实时读取 viewport/content 比例，支持鼠标拖拽）
        .child(minimal_vertical_scrollbar(
            ElementId::Name(format!("minimal-scrollbar-{bar_seq}").into()),
            handle,
        ))
}

/// 构造 `flex_1 + min_h_0` 的内层嵌套滚动容器（带 Chrome Wheel Scroll Latching 边缘穿透 + 原生比例滚动条）。
pub fn work_panel_scrollable(
    id: impl Into<SharedString>,
    handle: &ScrollHandle,
    content: impl IntoElement,
) -> impl IntoElement {
    let shared: SharedString = id.into();
    let inner = nested_scrollable(ElementId::Name(shared), handle)
        .flex_1()
        .min_h_0()
        .child(content);
    with_minimal_scroll_indicators(handle, inner).flex_1()
}

/// 构造 `flex_1 + min_h_0` 的独立分栏滚动容器（滚轮完全隔离 + 原生比例滚动条）。
pub fn isolated_panel_scrollable(
    id: impl Into<SharedString>,
    handle: &ScrollHandle,
    content: impl IntoElement,
) -> impl IntoElement {
    let shared: SharedString = id.into();
    let inner = isolated_scrollable(ElementId::Name(shared), handle)
        .flex_1()
        .min_h_0()
        .child(content);
    with_minimal_scroll_indicators(handle, inner).flex_1()
}

/// 构造限高（`max_h`）的内层嵌套滚动容器（带 Chrome Wheel Scroll Latching + 原生比例滚动条与边缘渐隐遮罩）。
pub fn nested_max_h_scrollable(
    id: impl Into<SharedString>,
    handle: &ScrollHandle,
    max_height: gpui::Pixels,
    content: impl IntoElement,
) -> gpui::Div {
    let shared: SharedString = id.into();
    let inner = nested_scrollable(ElementId::Name(shared), handle)
        .max_h(max_height)
        .child(content);
    with_minimal_scroll_indicators(handle, inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scroll_policy_direction_rules() {
        // 中间位置：上下均可滚
        assert!(can_scroll_direction(-1.0, -20.0, 100.0));
        assert!(can_scroll_direction(1.0, -20.0, 100.0));

        // 触底（offset_before = -100）：继续向下滚（dy < 0）不可滚，向上滚（dy > 0）由内层消费
        assert!(!can_scroll_direction(-1.0, -100.0, 100.0));
        assert!(can_scroll_direction(1.0, -100.0, 100.0));

        // 触顶（offset_before = 0）：继续向上滚（dy > 0）不可滚，向下滚（dy < 0）由内层消费
        assert!(!can_scroll_direction(1.0, 0.0, 100.0));
        assert!(can_scroll_direction(-1.0, 0.0, 100.0));

        // 零滚轮或无溢出内容（max = 0）：始终放行给外层
        assert!(!can_scroll_direction(0.0, -20.0, 100.0));
        assert!(!can_scroll_direction(-10.0, 0.0, 0.0));
        assert!(!can_scroll_direction(10.0, 0.0, 0.0));
    }

    #[test]
    fn boundary_last_step_still_consumed_by_inner() {
        let max: f32 = 100.0;
        let dy: f32 = -20.0;
        let raw_after: f32 = -90.0 + dy; // -110.0
        let before = (raw_after - dy).clamp(-max, 0.0);
        assert_eq!(before, -90.0);
        assert!(can_scroll_direction(dy, before, max));

        let raw_after_at_edge: f32 = -100.0 + dy; // -120.0
        let before_at_edge = (raw_after_at_edge - dy).clamp(-max, 0.0);
        assert_eq!(before_at_edge, -100.0);
        assert!(!can_scroll_direction(dy, before_at_edge, max));
    }

    #[test]
    fn chrome_wheel_latch_keeps_same_gesture_inside_inner_after_hitting_bottom_and_chains_on_new_gesture()
     {
        let mut m = WheelLatchMachine::new();
        let inner_id = ElementId::Name("cdv-files".into());
        let t0 = Instant::now();

        // 1. 手势开始（t0）：内层在 -60，距离底部 -100 还有 40px 余量（can_scroll_now = true）
        m.begin_wheel_event(TouchPhase::Started, -60.0, t0);
        m.end_capture_pass();
        assert!(
            m.decide_inner_scroll(&inner_id, true),
            "手势起点内层有余量 -> 锁存到 Inner(cdv-files)"
        );
        assert_eq!(m.target, LatchTarget::Inner(inner_id.clone()));

        // 2. 同一手势第 2 帧（t0 + 12ms）：内层已到达底部（can_scroll_now = false），
        //    但因属于同一次滑动手势，必须继续由内层消费（防触底瞬穿滚飞外层！）
        let t1 = t0 + Duration::from_millis(12);
        m.begin_wheel_event(TouchPhase::Moved, -40.0, t1);
        m.end_capture_pass();
        assert!(
            m.decide_inner_scroll(&inner_id, false),
            "同手势中途触底必须继续锁存在内层，不得瞬间穿透给外层"
        );

        // 3. 手指抬起（TouchPhase::Ended, dy = 0）后紧跟 macOS 触控板惯性帧（TouchPhase::Moved, t0 + 28ms）：
        //    惯性帧仍然保持锁存在内层，吞掉惯性余波！
        let t2 = t0 + Duration::from_millis(20);
        m.begin_wheel_event(TouchPhase::Ended, 0.0, t2);
        m.end_capture_pass();
        let t3 = t0 + Duration::from_millis(28);
        m.begin_wheel_event(TouchPhase::Moved, -30.0, t3);
        m.end_capture_pass();
        assert!(
            m.decide_inner_scroll(&inner_id, false),
            "手指抬起后的触控板惯性（Momentum）仍属同一手势，触底时不得穿透"
        );

        // 4. 用户再次发起新触控板滑动（TouchPhase::Started）或停顿超过 WHEEL_LATCH_TIMEOUT (140ms)：
        //    此时手势起点内层已在底部（can_scroll_now = false）-> 顺滑穿透并锁存到 Outer！
        let t4 = t3 + WHEEL_LATCH_TIMEOUT + Duration::from_millis(10);
        m.begin_wheel_event(TouchPhase::Moved, -40.0, t4);
        m.end_capture_pass();
        assert!(
            !m.decide_inner_scroll(&inner_id, false),
            "触底后发起的新手势起点内层无余量 -> 穿透给外层容器"
        );
        assert_eq!(m.target, LatchTarget::Outer);
    }

    #[test]
    fn chrome_wheel_latch_prevents_inner_from_stealing_an_active_outer_scroll() {
        let mut m = WheelLatchMachine::new();
        let inner_id = ElementId::Name("cdv-files".into());
        let t0 = Instant::now();

        // 1. 第 1 帧（t0）：用户在外层列表空白处开始向下滚动（未命中任何内层容器，所以没人调 decide_inner_scroll）
        m.begin_wheel_event(TouchPhase::Started, -30.0, t0);
        m.end_capture_pass();
        assert_eq!(m.target, LatchTarget::Pending);

        // 2. 第 2 帧（t0 + 16ms）：外层列表滚动使得内层容器 cdv-files 滑到了鼠标指针下方！
        //    此时就算 cdv-files 内部有可滚余量（can_scroll_now = true），因为手势已在外层启动，
        //    必须结算并保持为 LatchTarget::Outer，绝不允许 cdv-files 半路截胡！
        let t1 = t0 + Duration::from_millis(16);
        m.begin_wheel_event(TouchPhase::Moved, -30.0, t1);
        m.end_capture_pass();
        assert_eq!(m.target, LatchTarget::Outer);
        assert!(
            !m.decide_inner_scroll(&inner_id, true),
            "外层正在进行的滚动手势滑过内层容器时，内层绝不能半路截胡"
        );
    }

    #[test]
    fn direction_reversal_immediately_unlocks_boundary_latch() {
        let mut m = WheelLatchMachine::new();
        let inner_id = ElementId::Name("cdv-body".into());
        let t0 = Instant::now();

        // 向下滚到底并锁存在内层
        m.begin_wheel_event(TouchPhase::Moved, -50.0, t0);
        m.end_capture_pass();
        assert!(m.decide_inner_scroll(&inner_id, true));

        // 10ms 后立即反向往上滚（dy = +30.0）：方向反转开启新判定，向上可滚 -> 消费
        let t1 = t0 + Duration::from_millis(10);
        m.begin_wheel_event(TouchPhase::Moved, 30.0, t1);
        m.end_capture_pass();
        assert!(m.decide_inner_scroll(&inner_id, true));
    }
}
