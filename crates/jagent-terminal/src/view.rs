//! Terminal view — vendored & adapted from gpui-terminal (MIT OR Apache-2.0,
//! see LICENSE-MIT / LICENSE-APACHE in this crate).
//!
//! Adaptation for j-agent: the view renders an `Entity<TerminalModel>` from
//! the pool instead of owning a PTY. Consequences:
//!
//! - no reader thread / stdin writer here: the alacritty `EventLoop` feeds
//!   the model; input goes through `model.write_to_pty`
//! - repaints are driven by subscribing to `Event::Wakeup` on the model
//!   (gpui event bus) instead of polling a channel
//! - resize is detected in the paint pass and applied through
//!   `model.resize` (term + PTY, no callback needed)
//!
//! Vendored submodules: `render` (grid → gpui paint calls), `input`
//! (keystroke → bytes), `colors` (palette), `box_drawing` (glyph tables).

// Vendored from gpui-terminal: kept whole (including not-yet-used helpers)
// to minimize future upstream diffs.
#[allow(dead_code)]
mod box_drawing;
mod colors;
mod input;
mod render;

pub use colors::ColorPalette;
pub use input::keystroke_to_bytes;
pub use render::TerminalRenderer;

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point as AlacPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::TermMode;
use gpui::{
    App, Bounds, ClipboardItem, Context, DispatchPhase, Edges, Entity, FocusHandle, InputHandler,
    InteractiveElement, IntoElement, KeyDownEvent, MouseButton, MouseDownEvent, MouseExitEvent,
    MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point, Render, ScrollDelta,
    ScrollWheelEvent, Size, Styled, Subscription, UTF16Selection, Window, canvas, div, px, quad,
    transparent_black,
};

use crate::model::{Event, TerminalModel};

/// IME 组合态（pre-edit）：当前未确认的拼音/假名串。
/// macOS `setMarkedText:` / Windows `GCS_COMPSTR` 写入；确认时清空并把
/// 最终文本写入 PTY。结构体镜像 Zed terminal_view 的 ImeState。
struct ImeState {
    marked_text: String,
}

/// View-side appearance snapshot. Kept in the renderer; reconciled against
/// `model.style()` every frame (cheap field compares) so that style changes
/// applied to the model take effect without recreating anything.
pub struct TerminalView {
    model: Entity<TerminalModel>,
    renderer: TerminalRenderer,
    focus_handle: FocusHandle,
    /// Keeps the Wakeup subscription alive for as long as the view lives.
    _subscription: Subscription,
    /// Last grid size pushed to the model (resize detection happens in the
    /// paint pass; this is informational for `dimensions()`).
    last_dims: (usize, usize),
    /// Cursor blink phase; flipped by the blink task below.
    blink_on: bool,
    /// 触控板像素滚动换算后的不足一行余量；跨事件累计，避免每个小 delta
    /// 都 round 成一个方向键而洪泛 PTY。
    scroll_remainder_lines: f32,
    /// 当前 IME 组合态；None = 无组合（键盘直通）。
    ime_state: Option<ImeState>,
    /// 左键拖拽选区进行中（本 view 发起的 selection drag）。
    selecting: bool,
    /// 滚动条拖拽：按下点相对 thumb 顶部的偏移；None = 未在拖。
    scrollbar_drag: Option<Pixels>,
    /// 本帧内容区几何（paint 阶段写入）：鼠标事件 → grid 坐标换算用。
    content_metrics: Rc<Cell<Option<ContentMetrics>>>,
    /// 本帧滚动条几何（paint 阶段写入）：命中测试与拖拽映射用。
    scrollbar_layout: Rc<Cell<Option<ScrollbarLayout>>>,
    /// 滚动条淡入淡出状态（paint 阶段推进动画，事件阶段读写）。
    scrollbar_fx: Rc<Cell<ScrollbarFx>>,
    /// 本帧视图 bounds（paint 阶段写入）：鼠标移入/移出检测用。
    view_bounds: Rc<Cell<Bounds<Pixels>>>,
    /// 鼠标当前是否在视图内（MouseExitEvent/移动事件维护）。
    mouse_inside: bool,
}

/// 终端内容区几何快照（paint 阶段写入，事件阶段读取）。
#[derive(Clone, Copy)]
struct ContentMetrics {
    /// 内容区左上角（padding 之后）的窗口坐标。
    origin: Point<Pixels>,
    cell_width: Pixels,
    cell_height: Pixels,
    cols: usize,
    rows: usize,
}

/// 滚动条淡入淡出（Zed `ui::components::scrollbar` 同款语义）：
/// 移入视图/滚动 → 渐入；悬停 thumb 或拖拽 → 保持；停止滚动 1s 或
/// 移出视图 → 渐出。Animating 存起止 alpha，paint 阶段按帧推进。
#[derive(Clone, Copy, PartialEq)]
enum ScrollbarVisibility {
    Hidden,
    Visible,
    Animating {
        start: Instant,
        duration: Duration,
        from: f32,
        to: f32,
    },
}

/// 滚动条动效快照（Rc<Cell>：paint 闭包推进动画，事件阶段读写）。
#[derive(Clone, Copy)]
struct ScrollbarFx {
    visibility: ScrollbarVisibility,
    /// 鼠标是否悬停在滚动条命中区（thumb 加亮 + 抑制自动隐藏）。
    hovered: bool,
    /// 是否正在拖拽 thumb（镜像 scrollbar_drag，paint 阶段读不到
    /// view 实体——App::read 会 double-lease panic——走 Cell 传递）。
    dragging: bool,
    /// 自动隐藏计时器代次：每次 show 递增，过期 timer 不再隐藏。
    generation: u64,
}

/// 滚动条渐入时长（Zed 是瞬现；按需求做成渐入）。
const SCROLLBAR_FADE_IN: Duration = Duration::from_millis(150);
/// 滚动条渐出时长（Zed 同款 400ms）。
const SCROLLBAR_FADE_OUT: Duration = Duration::from_millis(400);
/// 停止滚动后自动隐藏的延迟（Zed 同款 1s）。
const SCROLLBAR_HIDE_DELAY: Duration = Duration::from_secs(1);
/// 常态 thumb 不透明度。Zed One Dark 实测：常态 thumb（浅灰 30%）
/// blend 到不透明 editor 背景上，是三态中【最亮】的。
const SCROLLBAR_OPACITY: f32 = 0.6;
/// 悬停 thumb 不透明度：Zed hover 换成不透明的深灰主题色
/// （#363c46，≈轨道色），是三态中【最暗】的——悬停反而变暗。
const SCROLLBAR_HOVER_OPACITY: f32 = 0.35;
/// 拖拽 thumb 不透明度：Zed active（fallback step5 14%）blend 后
/// 介于常态和悬停之间、偏悬停（rgb 69 vs 悬停 54 vs 常态 88）。
const SCROLLBAR_ACTIVE_OPACITY: f32 = 0.45;
/// thumb 最小高度（Zed `MINIMUM_THUMB_SIZE` = 25px）：内容极长时
/// 等比缩出来的 thumb 会小到看不见/抓不到，兜底一个可点击尺寸。
const SCROLLBAR_MIN_THUMB: f32 = 25.0;

/// 滚动条几何快照（paint 阶段写入，事件阶段读取）。
#[derive(Clone, Copy)]
struct ScrollbarLayout {
    /// 命中区域（比可见轨道宽，方便抓取）。
    hit: Bounds<Pixels>,
    /// 滑块矩形。
    thumb: Bounds<Pixels>,
    /// 轨道顶部的窗口 y 坐标。
    track_top: Pixels,
    /// 轨道高度。
    track_height: Pixels,
    /// 最大回滚行数（display_offset 上限）。
    max_offset: usize,
}

impl TerminalView {
    /// Bind a view to a pooled session. The session must already exist (pool
    /// `create`); the view adds no lifecycle of its own — dropping the view
    /// does NOT destroy the session (retain semantics live in the pool).
    pub fn new(model: Entity<TerminalModel>, cx: &mut Context<Self>) -> Self {
        let style = model.read(cx).style().clone();
        let renderer = TerminalRenderer::new(
            style.font_family.to_string(),
            style.font_size,
            style.line_height_multiplier,
            colors::by_name(&style.palette),
        );

        // Repaint when the model wakes up (new content, title, bell, exit...).
        let subscription = cx.subscribe(&model, |_this, _model, event: &Event, cx| {
            if matches!(event, Event::Wakeup) {
                cx.notify();
            }
        });

        // Cursor blink: one task per view; it self-terminates when the view
        // entity drops (retain semantics — unmounting the element stops the
        // timer). While `cursor_blink` is off it idles without notifying.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(530))
                    .await;
                if this
                    .update(cx, |v, cx| {
                        if v.model.read(cx).style().cursor_blink {
                            v.blink_on = !v.blink_on;
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break; // view dropped — stop blinking
                }
            }
        })
        .detach();

        Self {
            model,
            renderer,
            focus_handle: cx.focus_handle(),
            _subscription: subscription,
            last_dims: (80, 24),
            blink_on: true,
            scroll_remainder_lines: 0.0,
            ime_state: None,
            selecting: false,
            scrollbar_drag: None,
            content_metrics: Rc::new(Cell::new(None)),
            scrollbar_layout: Rc::new(Cell::new(None)),
            scrollbar_fx: Rc::new(Cell::new(ScrollbarFx {
                visibility: ScrollbarVisibility::Hidden,
                hovered: false,
                dragging: false,
                generation: 0,
            })),
            view_bounds: Rc::new(Cell::new(Bounds::default())),
            mouse_inside: false,
        }
    }

    pub fn model(&self) -> Entity<TerminalModel> {
        self.model.clone()
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus_handle
    }

    pub fn dimensions(&self) -> (usize, usize) {
        self.last_dims
    }

    /// 设置 IME 组合文本（pre-edit）。空串等于清除。
    fn set_marked_text(&mut self, text: String, cx: &mut Context<Self>) {
        if text.is_empty() {
            return self.clear_marked_text(cx);
        }
        self.ime_state = Some(ImeState { marked_text: text });
        cx.notify();
    }

    /// 当前组合文本的 UTF-16 区间（平台查询 marked_text_range 用）。
    fn marked_text_range(&self) -> Option<std::ops::Range<usize>> {
        self.ime_state
            .as_ref()
            .map(|s| 0..s.marked_text.encode_utf16().count())
    }

    /// 清除 IME 组合态。
    fn clear_marked_text(&mut self, cx: &mut Context<Self>) {
        if self.ime_state.is_some() {
            self.ime_state = None;
            cx.notify();
        }
    }

    /// 把确认后的文本写入 PTY（IME 确认、macOS insertText、Windows WM_CHAR
    /// 殊途同归）。顺带重置闪烁相位：打字时光标应立即可见。
    fn commit_text(&mut self, text: &str, cx: &mut Context<Self>) {
        if !text.is_empty() {
            self.model.read(cx).write_to_pty(text.as_bytes());
        }
        self.blink_on = true;
        cx.notify();
    }

    /// Reconcile the renderer with the model's current style; returns true
    /// when the renderer changed (font metrics must be re-measured).
    fn sync_style(&mut self, cx: &App) -> bool {
        let style = self.model.read(cx).style();
        let renderer = &mut self.renderer;
        let mut changed = false;
        if renderer.font_family != style.font_family.as_ref() {
            renderer.font_family = style.font_family.to_string();
            changed = true;
        }
        if renderer.font_size != style.font_size {
            renderer.font_size = style.font_size;
            changed = true;
        }
        if renderer.line_height_multiplier != style.line_height_multiplier {
            renderer.line_height_multiplier = style.line_height_multiplier;
            changed = true;
        }
        let palette = colors::by_name(&style.palette);
        if renderer.palette.background() != palette.background()
            || renderer.palette.foreground() != palette.foreground()
        {
            renderer.palette = palette;
            changed = true;
        }
        changed
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let ks = &event.keystroke;
        // Ctrl+V / Ctrl+Shift+V / Shift+Insert = 粘贴（Zed windows keymap 同款）。
        // 不能走 keystroke_to_bytes：Ctrl+V 会被编码成 0x16 (SYN) 写进 PTY，
        // readline 把它当 quoted-insert 吃掉，表现就是「粘贴没反应」。
        if (ks.key == "v" && ks.modifiers.control && !ks.modifiers.alt && !ks.modifiers.platform)
            || (ks.key == "insert" && ks.modifiers.shift && !ks.modifiers.control)
        {
            self.paste_clipboard(cx);
            return;
        }
        let bytes = self
            .model
            .read(cx)
            .mode()
            .pipe(|mode| input::keystroke_to_bytes(&event.keystroke, mode));
        if let Some(bytes) = bytes {
            self.model.read(cx).write_to_pty(&bytes);
        }
    }

    /// 剪贴板文本写入 PTY（Zed `terminal.paste` 同款语义）：
    /// - 应用开启 bracketed paste（BRACKETED_PASTE）时包 \x1b[200~ … \x1b[201~，
    ///   并剥掉文本内的 \x1b 防止提前闭合转义序列；
    /// - 否则把 \r\n / \n 归一成 \r（回车），多行文本逐行执行。
    /// 剪贴板无文本（图片等）时退化为转发原始 0x16，让能读 OS 剪贴板的
    /// TUI agent 走自己的粘贴路径。
    fn paste_clipboard(&mut self, cx: &mut Context<Self>) {
        let model = self.model.read(cx);
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
            model.write_to_pty(&[0x16]);
            return;
        };
        if text.is_empty() {
            return;
        }
        let bytes = if model.mode().contains(TermMode::BRACKETED_PASTE) {
            format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', "")).into_bytes()
        } else {
            text.replace("\r\n", "\r").replace('\n', "\r").into_bytes()
        };
        model.write_to_pty(&bytes);
    }

    /// 左键按下：优先命中滚动条（拖拽/翻页），否则开始/调整选区。
    /// 选区语义与 Zed/alacritty 一致：单击 Simple、双击 Semantic（词）、
    /// 三击 Lines（整行）、Shift+单击扩展现有选区。应用接管鼠标
    /// （MOUSE_MODE，如 vim）时按住 Shift 才走本地选区，否则留给应用。
    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.focus_handle.focus(window, cx);

        // 滚动条命中：拖拽 thumb 或点击轨道翻页。
        if let Some(layout) = self.scrollbar_layout.get()
            && layout.hit.contains(&event.position)
        {
            if layout.thumb.contains(&event.position) {
                self.scrollbar_drag = Some(event.position.y - layout.thumb.origin.y);
                let mut fx = self.scrollbar_fx.get();
                fx.dragging = true;
                self.scrollbar_fx.set(fx);
            } else {
                let page = self
                    .content_metrics
                    .get()
                    .map(|m| m.rows as i32)
                    .unwrap_or(1)
                    .max(1);
                let delta = if event.position.y < layout.thumb.origin.y {
                    page
                } else {
                    -page
                };
                self.model
                    .read(cx)
                    .with_term_mut(|term| term.scroll_display(Scroll::Delta(delta)));
            }
            // 点击滚动条也视为一次交互：保持显示并重置自动隐藏。
            self.mouse_inside = true;
            self.show_scrollbar(cx);
            cx.notify();
            return;
        }

        let Some(metrics) = self.content_metrics.get() else {
            cx.notify();
            return;
        };

        let model = self.model.read(cx);
        let mode = model.mode();
        if mode.intersects(TermMode::MOUSE_MODE) && !event.modifiers.shift {
            // 应用接管鼠标：不选区（鼠标上报待补），仅聚焦。
            cx.notify();
            return;
        }

        self.selecting = true;
        model.with_term_mut(|term| {
            let (point, side) =
                grid_point_and_side(event.position, metrics, term.grid().display_offset());
            let selection_type = match event.click_count {
                1 => SelectionType::Simple,
                2 => SelectionType::Semantic,
                _ => SelectionType::Lines,
            };
            if selection_type == SelectionType::Simple && event.modifiers.shift {
                // Shift+单击：把现有选区扩展到点击处。
                if let Some(selection) = term.selection.as_mut() {
                    selection.update(point, side);
                }
            } else {
                term.selection = Some(Selection::new(selection_type, point, side));
            }
        });
        cx.notify();
    }

    /// 左键抬起：结束滚动条拖拽；选区非空则复制到剪贴板
    /// （终端惯例 copy-on-release；当前没有显式 copy 快捷键路径）。
    fn on_mouse_up(&mut self, event: &MouseUpEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let was_dragging = self.scrollbar_drag.take().is_some();
        if self.selecting {
            self.selecting = false;
            self.copy_selection(cx);
        }
        // 拖拽结束：松手点不在滚动条上 → 渐出（Zed 同款）。
        if was_dragging {
            let hovered = self
                .scrollbar_layout
                .get()
                .is_some_and(|l| l.hit.contains(&event.position));
            let mut fx = self.scrollbar_fx.get();
            fx.hovered = hovered;
            fx.dragging = false;
            self.scrollbar_fx.set(fx);
            if !hovered {
                self.hide_scrollbar(cx);
            } else {
                cx.notify(); // 拖拽态 → 悬停态，重绘换色
            }
        }
    }

    /// 窗口级 mouse_move（paint 阶段注册）：拖拽越出元素 bounds 时仍能
    /// 收到事件——选区拖到边界外自动滚动，滚动条拖拽同理。按钮已松开
    /// （在窗外松开等场景）时兜底收尾选区。
    ///
    /// 滚动条可见性（Zed 语义）：移入视图 → 渐入；悬停 thumb → 保持；
    /// 移出视图 → 渐出；拖拽中移出视图不隐藏。
    fn handle_mouse_move(&mut self, event: &MouseMoveEvent, cx: &mut Context<Self>) {
        // 按钮已松开（窗外松开等）→ 兜底收尾拖拽/选区。
        if event.pressed_button != Some(MouseButton::Left) {
            if self.selecting {
                self.selecting = false;
                self.copy_selection(cx);
            }
            if self.scrollbar_drag.take().is_some() {
                let mut fx = self.scrollbar_fx.get();
                fx.dragging = false;
                self.scrollbar_fx.set(fx);
            }
        }

        let inside = self.view_bounds.get().contains(&event.position);
        let hovered = self
            .scrollbar_layout
            .get()
            .is_some_and(|l| l.hit.contains(&event.position));
        {
            let mut fx = self.scrollbar_fx.get();
            fx.hovered = hovered;
            self.scrollbar_fx.set(fx);
        }
        if inside {
            // 移入/视图内移动：渐入并重置自动隐藏计时
            // （Zed 同款 last_show 语义）。
            self.show_scrollbar(cx);
        } else if self.mouse_inside && self.scrollbar_drag.is_none() {
            // 移出视图：立即渐出。
            self.hide_scrollbar(cx);
        }
        self.mouse_inside = inside;

        if event.pressed_button != Some(MouseButton::Left) {
            return;
        }
        if self.scrollbar_drag.is_some() {
            self.update_scrollbar_drag(event.position, cx);
            return;
        }
        if !self.selecting {
            return;
        }
        let Some(metrics) = self.content_metrics.get() else {
            return;
        };

        let changed = self.model.read(cx).with_term_mut(|term| {
            let mut changed = false;
            // 拖出内容区上下边界 → 自动滚动（alacritty 惯例：每事件约 5 行）。
            let content_bottom = metrics.origin.y + metrics.cell_height * metrics.rows as f32;
            let scroll_lines = if event.position.y > content_bottom {
                -((event.position.y - content_bottom) / metrics.cell_height) as i32 - 1
            } else if event.position.y < metrics.origin.y {
                -((event.position.y - metrics.origin.y) / metrics.cell_height) as i32 + 1
            } else {
                0
            };
            if scroll_lines != 0 {
                term.scroll_display(Scroll::Delta(scroll_lines.clamp(-5, 5)));
                changed = true;
            }
            let (point, side) =
                grid_point_and_side(event.position, metrics, term.grid().display_offset());
            // 同一 cell 内的移动不改变选区——跳过重绘。鼠标移动事件频率
            // 可达数百 Hz，慢速拖拽时大部分事件落在同一格，去重能省掉
            // 大量全量 repaint。
            let before = term.selection.clone();
            if let Some(selection) = term.selection.as_mut() {
                selection.update(point, side);
            }
            changed || term.selection != before
        });
        if changed {
            cx.notify();
        }
    }

    /// 鼠标离开窗口（平台级 MouseExited）：等价移出视图，渐出滚动条。
    fn handle_mouse_exit(&mut self, _event: &MouseExitEvent, cx: &mut Context<Self>) {
        self.mouse_inside = false;
        let mut fx = self.scrollbar_fx.get();
        fx.hovered = false;
        self.scrollbar_fx.set(fx);
        if self.scrollbar_drag.is_none() {
            self.hide_scrollbar(cx);
        }
    }

    /// 滚动条拖拽：thumb 位置 ↔ display_offset 线性映射。
    fn update_scrollbar_drag(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let (Some(grab_offset), Some(layout)) = (self.scrollbar_drag, self.scrollbar_layout.get())
        else {
            return;
        };
        let track_space: f32 = (layout.track_height - layout.thumb.size.height).into();
        if track_space <= 0.0 || layout.max_offset == 0 {
            return;
        }
        // thumb 位置公式是 frac = 1 - offset/max（顶部=最新、底部=最旧），
        // 反解 display_offset 时要取 1 - frac。
        let frac =
            ((position.y - layout.track_top - grab_offset) / px(track_space)).clamp(0.0, 1.0);
        let offset = ((1.0 - frac) * layout.max_offset as f32).round() as usize;
        let changed = self.model.read(cx).with_term_mut(|term| {
            let current = term.grid().display_offset();
            if offset != current {
                term.scroll_display(Scroll::Delta(offset as i32 - current as i32));
                true
            } else {
                false
            }
        });
        if changed {
            cx.notify();
        }
    }

    /// 从当前不透明度渐变到目标态（Visible=1 / Hidden=0）。
    /// 已在朝同一目标动画时不重启，避免连续 mousemove 把渐入卡死在起点。
    fn fade_scrollbar(&mut self, to: ScrollbarVisibility, duration: Duration) {
        let mut fx = self.scrollbar_fx.get();
        // Animating.to 存的是目标不透明度（f32），与目标态换算后比较。
        if let ScrollbarVisibility::Animating { to: t, .. } = fx.visibility {
            if (t - scrollbar_opacity(to)).abs() < f32::EPSILON {
                return;
            }
        }
        let from = scrollbar_opacity(fx.visibility);
        if (from - scrollbar_opacity(to)).abs() < f32::EPSILON {
            fx.visibility = to;
        } else {
            fx.visibility = ScrollbarVisibility::Animating {
                start: Instant::now(),
                duration,
                from,
                to: scrollbar_opacity(to),
            };
        }
        self.scrollbar_fx.set(fx);
    }

    /// 显示滚动条并重置自动隐藏计时（Zed `show_scrollbars` 同款：
    /// 滚动/视图内移动都会调用，generation 防止过期 timer 提前隐藏）。
    fn show_scrollbar(&mut self, cx: &mut Context<Self>) {
        let mut fx = self.scrollbar_fx.get();
        fx.generation += 1;
        self.scrollbar_fx.set(fx);
        if fx.visibility != ScrollbarVisibility::Visible {
            self.fade_scrollbar(ScrollbarVisibility::Visible, SCROLLBAR_FADE_IN);
        }
        let generation = fx.generation;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SCROLLBAR_HIDE_DELAY).await;
            this.update(cx, |v, cx| {
                let fx = v.scrollbar_fx.get();
                if fx.generation == generation
                    && !fx.hovered
                    && v.scrollbar_drag.is_none()
                    && v.mouse_inside
                {
                    v.fade_scrollbar(ScrollbarVisibility::Hidden, SCROLLBAR_FADE_OUT);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// 鼠标离开视图/松手后不在滚动条上 → 渐出（Zed：leave 立即渐出）。
    fn hide_scrollbar(&mut self, cx: &mut Context<Self>) {
        self.fade_scrollbar(ScrollbarVisibility::Hidden, SCROLLBAR_FADE_OUT);
        cx.notify();
    }

    /// 当前选区文本写入剪贴板。
    fn copy_selection(&mut self, cx: &mut Context<Self>) {
        let text = self
            .model
            .read(cx)
            .with_term(|term| term.selection_to_string());
        if let Some(text) = text
            && !text.is_empty()
        {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    /// 滚轮 → 两级路由：
    /// - 主屏（normal screen）：scroll_display 移动回滚视口；
    /// - 备用屏（alt screen，TUI 常驻）：无 scrollback，按终端惯例转
    ///   Up/Down 方向键（多数 TUI 靠方向键滚动自己的视口）；
    /// - 应用接管鼠标（MOUSE_MODE）：忽略——SGR wheel 上报需要 cell
    ///   坐标换算，待需要时再补。
    fn on_scroll(
        &mut self,
        event: &ScrollWheelEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // GPUI 约定 delta.y > 0 = 向内容顶部滚动（向上）
        let lines_f32 = match event.delta {
            ScrollDelta::Lines(l) => l.y,
            ScrollDelta::Pixels(p) => p.y / self.renderer.cell_height,
        };
        let lines = consume_scroll_lines(&mut self.scroll_remainder_lines, lines_f32);
        if lines == 0 {
            return;
        }
        {
            let model = self.model.read(cx);
            let mode = model.mode();
            if mode.intersects(TermMode::MOUSE_MODE) {
                return;
            }
            if mode.contains(TermMode::ALT_SCREEN) {
                let dir = if lines > 0 { "up" } else { "down" };
                if let Some(bytes) = input::arrow_key_bytes(dir, mode) {
                    for _ in 0..lines.unsigned_abs() {
                        model.write_to_pty(&bytes);
                    }
                }
            } else {
                model.with_term_mut(|term| term.scroll_display(Scroll::Delta(lines)));
                // 真实滚动 → 渐入滚动条并重置自动隐藏（Zed 同款）。
                self.mouse_inside = true;
                self.show_scrollbar(cx);
            }
        }
        cx.notify();
    }
}

/// Tiny combinator to keep the mode read inline.
trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}

/// 滚动条可见性 → 不透明度：Animating 按经过时间线性插值，
/// 动画完成由 paint 阶段收敛到终态（request_animation_frame 驱动）。
fn scrollbar_opacity(visibility: ScrollbarVisibility) -> f32 {
    match visibility {
        ScrollbarVisibility::Hidden => 0.0,
        ScrollbarVisibility::Visible => 1.0,
        ScrollbarVisibility::Animating {
            start,
            duration,
            from,
            to,
        } => {
            let t = (start.elapsed().as_secs_f32() / duration.as_secs_f32()).min(1.0);
            from + (to - from) * t
        }
    }
}

/// 窗口坐标 → grid 坐标 + 半格侧（左/右）。移植自 Zed
/// `mappings/mouse.rs::grid_point_and_side`：pos 为窗口坐标，先减去
/// 内容区 origin；display_offset 把屏幕行换算回 buffer 行（历史为负）。
fn grid_point_and_side(
    pos: Point<Pixels>,
    metrics: ContentMetrics,
    display_offset: usize,
) -> (AlacPoint, Side) {
    let rel = pos - metrics.origin;

    let mut column = (rel.x / metrics.cell_width) as usize;
    let cell_x = rel.x.max(px(0.0)) % metrics.cell_width;
    let mut side = if cell_x > metrics.cell_width * 0.5 {
        Side::Right
    } else {
        Side::Left
    };

    let last_column = metrics.cols.saturating_sub(1);
    if column > last_column {
        column = last_column;
        side = Side::Right;
    }

    let mut line = (rel.y / metrics.cell_height) as i32;
    let bottommost_line = metrics.rows.saturating_sub(1) as i32;
    if line > bottommost_line {
        line = bottommost_line;
        side = Side::Right;
    } else if line < 0 {
        side = Side::Left;
    }

    (
        AlacPoint::new(
            Line(line.saturating_sub(display_offset as i32)),
            Column(column),
        ),
        side,
    )
}

/// 消费滚动行数：亚像素/不足一行的触控板 delta 跨事件累计；单事件最多
/// 派发 3 行，丢弃异常大尖峰，防止 TUI 方向键/重绘洪泛。
fn consume_scroll_lines(remainder: &mut f32, delta_lines: f32) -> i32 {
    let total = *remainder + delta_lines;
    let whole = total.trunc() as i32;
    *remainder = total - whole as f32;
    whole.clamp(-3, 3)
}

impl Render for TerminalView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_style(cx);
        // Blink phase → renderer before cloning it into the canvas closure.
        // (Off-phase hides the cursor block entirely; steady when blink is
        // disabled — `blink_on` stays true in that branch of the task.)
        self.renderer.cursor_visible = self.blink_on;

        let model = self.model.clone();
        let renderer = self.renderer.clone();
        let padding = model.read(cx).style().padding;
        let background = renderer.palette.background();
        // IME 接线：canvas 的 paint 回调正处 paint 阶段，在这里注册
        // InputHandler（window.handle_input 要求 paint 阶段调用）。
        let this = cx.entity();
        let focus_handle = self.focus_handle.clone();
        let content_metrics = self.content_metrics.clone();
        let scrollbar_layout = self.scrollbar_layout.clone();
        let scrollbar_fx = self.scrollbar_fx.clone();
        let view_bounds = self.view_bounds.clone();

        div()
            .size_full()
            .bg(background)
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_scroll_wheel(cx.listener(Self::on_scroll))
            .child(
                canvas(
                    move |bounds, _window, _cx| bounds,
                    move |bounds, _, window, cx| {
                        // Measure cell dimensions from the font every paint;
                        // cheap (cached font metrics inside gpui).
                        let mut measured = renderer.clone();
                        measured.measure_cell(window);

                        let available_width: f32 =
                            (bounds.size.width - padding.left - padding.right).into();
                        let available_height: f32 =
                            (bounds.size.height - padding.top - padding.bottom).into();
                        let cell_width: f32 = measured.cell_width.into();
                        let cell_height: f32 = measured.cell_height.into();
                        let cols = ((available_width / cell_width) as usize).max(1);
                        let rows = ((available_height / cell_height) as usize).max(1);

                        let term_lock = model.read(cx).term_lock();

                        // Resize term + PTY when the grid no longer fits.
                        let needs_resize = {
                            let term = term_lock.lock();
                            term.columns() != cols || term.screen_lines() != rows
                        };
                        if needs_resize {
                            let cell_w: f32 = measured.cell_width.into();
                            let cell_h: f32 = measured.cell_height.into();
                            model
                                .read(cx)
                                .resize(cols, rows, cell_w as u16, cell_h as u16);
                        }

                        // IME：注册 InputHandler（聚焦时生效）。cursor_bounds
                        // 用本帧测得的 cell 尺寸计算，供候选窗定位。
                        {
                            let term = term_lock.lock();
                            let cursor_bounds = measured.cursor_bounds(bounds, padding, &term);
                            window.handle_input(
                                &focus_handle,
                                TerminalInputHandler {
                                    view: this.clone(),
                                    cursor_bounds,
                                },
                                cx,
                            );
                        }

                        let marked_text = this
                            .read(cx)
                            .ime_state
                            .as_ref()
                            .map(|s| s.marked_text.clone());

                        // 鼠标事件 → grid 坐标换算所需的几何快照（事件
                        // 阶段读不到 paint 局部变量，走 Rc<Cell> 传递）。
                        content_metrics.set(Some(ContentMetrics {
                            origin: Point {
                                x: bounds.origin.x + padding.left,
                                y: bounds.origin.y + padding.top,
                            },
                            cell_width: measured.cell_width,
                            cell_height: measured.cell_height,
                            cols,
                            rows,
                        }));

                        // 拖拽选区/滚动条时鼠标可能越出元素 bounds，div 的
                        // on_mouse_move/on_mouse_up 收不到；窗口级监听在
                        // paint 阶段注册、下一帧有效（Zed terminal_element
                        // 同款做法）。MouseExited 同理：离开窗口渐出滚动条。
                        {
                            let view = this.clone();
                            window.on_mouse_event(move |e: &MouseMoveEvent, phase, _window, cx| {
                                if phase == DispatchPhase::Bubble {
                                    view.update(cx, |v, cx| v.handle_mouse_move(e, cx));
                                }
                            });
                            let view = this.clone();
                            window.on_mouse_event(move |e: &MouseUpEvent, phase, _window, cx| {
                                if phase == DispatchPhase::Bubble && e.button == MouseButton::Left {
                                    view.update(cx, |v, cx| v.on_mouse_up(e, _window, cx));
                                }
                            });
                            let view = this.clone();
                            window.on_mouse_event(move |e: &MouseExitEvent, phase, _window, cx| {
                                if phase == DispatchPhase::Bubble {
                                    view.update(cx, |v, cx| v.handle_mouse_exit(e, cx));
                                }
                            });
                        }

                        // 视图 bounds 快照：移入/移出检测用。
                        view_bounds.set(bounds);

                        let term = term_lock.lock();
                        measured.paint(bounds, padding, &term, marked_text.as_deref(), window, cx);

                        // 滚动条：仅在有回滚历史时出现（alt screen 无历史
                        // 不画）。轨道贴内容区右缘，命中区放宽到 12px。
                        {
                            let grid = term.grid();
                            let history = grid.history_size();
                            let screen_lines = grid.screen_lines();
                            let display_offset = grid.display_offset();
                            let total = history + screen_lines;
                            // 淡入淡出：Animating 期间每帧推进不透明度并
                            // 请求下一帧；完全透明时连命中区都不留（不可见
                            // 的滚动条不应抢走右缘的选区点击）。
                            let mut fx = scrollbar_fx.get();
                            let mut opacity = scrollbar_opacity(fx.visibility);
                            if let ScrollbarVisibility::Animating { to, .. } = fx.visibility {
                                if opacity >= 1.0 || opacity <= 0.0 {
                                    fx.visibility = if to > 0.5 {
                                        ScrollbarVisibility::Visible
                                    } else {
                                        ScrollbarVisibility::Hidden
                                    };
                                    scrollbar_fx.set(fx);
                                } else {
                                    window.request_animation_frame();
                                }
                            }
                            // thumb 三态（Zed ThumbState）：拖拽 > 悬停 > 常态。
                            let state_alpha = if fx.dragging {
                                SCROLLBAR_ACTIVE_OPACITY
                            } else if fx.hovered {
                                SCROLLBAR_HOVER_OPACITY
                            } else {
                                SCROLLBAR_OPACITY
                            };
                            if history == 0 && fx.visibility != ScrollbarVisibility::Hidden {
                                // 历史清空（clear/alt screen 切换）→ 直接复位，
                                // 下次有历史时重新走渐入。
                                fx.visibility = ScrollbarVisibility::Hidden;
                                scrollbar_fx.set(fx);
                                opacity = 0.0;
                            }
                            if history > 0 && opacity > 0.0 {
                                let track_top = bounds.origin.y + padding.top;
                                let track_height =
                                    bounds.size.height - padding.top - padding.bottom;
                                let visible_frac = screen_lines as f32 / total.max(1) as f32;
                                let thumb_height = (track_height * visible_frac)
                                    .max(px(SCROLLBAR_MIN_THUMB))
                                    .min(track_height);
                                let track_space = track_height - thumb_height;
                                let frac = if history > 0 {
                                    1.0 - display_offset as f32 / history as f32
                                } else {
                                    1.0
                                };
                                let thumb_top = track_top + track_space * frac;
                                let track_right =
                                    bounds.origin.x + bounds.size.width - padding.right;
                                let thumb = Bounds {
                                    origin: Point {
                                        x: track_right - px(6.0),
                                        y: thumb_top,
                                    },
                                    size: Size {
                                        width: px(4.0),
                                        height: thumb_height,
                                    },
                                };
                                let hit = Bounds {
                                    origin: Point {
                                        x: track_right - px(12.0),
                                        y: track_top,
                                    },
                                    size: Size {
                                        width: px(12.0),
                                        height: track_height,
                                    },
                                };
                                scrollbar_layout.set(Some(ScrollbarLayout {
                                    hit,
                                    thumb,
                                    track_top,
                                    track_height,
                                    max_offset: history,
                                }));
                                window.paint_quad(quad(
                                    thumb,
                                    px(2.0),
                                    measured
                                        .palette
                                        .foreground()
                                        .alpha(state_alpha * opacity),
                                    Edges::<Pixels>::default(),
                                    transparent_black(),
                                    Default::default(),
                                ));
                            } else {
                                scrollbar_layout.set(None);
                            }
                        }
                    },
                )
                .size_full(),
            )
    }
}

/// 终端 IME / 文本输入桥。注册后平台的文本输入不再走 key_down，而是：
/// - macOS：`insertText:`（确认文本）与 `setMarkedText:`（组合中）
/// - Windows：`WM_CHAR` 与 `WM_IME_COMPOSITION`（GCS_COMPSTR/GCS_RESULTSTR）
/// 两平台都落到这里，再写入 PTY。可打印字符必须走这条路径而不是
/// key_down 直写，否则 IME（中文拼音等）无法工作。
/// 接口语义与 Zed terminal_view 的 TerminalInputHandler 一致。
struct TerminalInputHandler {
    view: Entity<TerminalView>,
    /// 本帧光标 cell 的窗口坐标（paint 时快照）；IME 候选窗定位用。
    cursor_bounds: Option<Bounds<Pixels>>,
}

impl InputHandler for TerminalInputHandler {
    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<UTF16Selection> {
        // 始终返回有效选区（空），否则平台认为无文本焦点，IME 不启动。
        // 备用屏 TUI（vim 等）也用终端光标定位候选窗。
        Some(UTF16Selection {
            range: 0..0,
            reversed: false,
        })
    }

    fn marked_text_range(
        &mut self,
        _window: &mut Window,
        cx: &mut App,
    ) -> Option<std::ops::Range<usize>> {
        self.view.read(cx).marked_text_range()
    }

    fn text_for_range(
        &mut self,
        _range: std::ops::Range<usize>,
        _adjusted_range: &mut Option<std::ops::Range<usize>>,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<String> {
        None
    }

    fn replace_text_in_range(
        &mut self,
        _replacement_range: Option<std::ops::Range<usize>>,
        text: &str,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.view.update(cx, |view, view_cx| {
            view.clear_marked_text(view_cx);
            view.commit_text(text, view_cx);
        });
        // 位置可能已变，刷新 IME 候选窗坐标
        window.invalidate_character_coordinates();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _range_utf16: Option<std::ops::Range<usize>>,
        new_text: &str,
        _new_marked_range: Option<std::ops::Range<usize>>,
        _window: &mut Window,
        cx: &mut App,
    ) {
        self.view.update(cx, |view, view_cx| {
            view.set_marked_text(new_text.to_string(), view_cx);
        });
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut App) {
        self.view.update(cx, |view, view_cx| {
            view.clear_marked_text(view_cx);
        });
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: std::ops::Range<usize>,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<Bounds<Pixels>> {
        // 候选窗跟随：x 随组合文本长度推进（与 Zed 相同的近似）。
        let mut bounds = self.cursor_bounds?;
        bounds.origin.x += self.cell_width_hint() * range_utf16.start as f32;
        Some(bounds)
    }

    fn character_index_for_point(
        &mut self,
        _point: gpui::Point<Pixels>,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Option<usize> {
        None
    }

    fn apple_press_and_hold_enabled(&mut self) -> bool {
        // 终端不需要长按重音菜单；关闭后长按重复直接 insertText。
        false
    }
}

impl TerminalInputHandler {
    /// 光标 cell 宽度近似（cursor_bounds 已含一格宽度，这里只需要 x 偏移量
    /// 的步进）。从 bounds 宽度取，避免再锁 model。
    fn cell_width_hint(&self) -> Pixels {
        self.cursor_bounds
            .map(|b| b.size.width)
            .unwrap_or(Pixels::ZERO)
    }
}

#[cfg(test)]
mod tests {
    use super::consume_scroll_lines;

    #[test]
    fn scroll_lines_accumulate_fractional_trackpad_events() {
        let mut remainder = 0.0;
        assert_eq!(consume_scroll_lines(&mut remainder, 0.34), 0);
        assert_eq!(consume_scroll_lines(&mut remainder, 0.34), 0);
        assert_eq!(consume_scroll_lines(&mut remainder, 0.34), 1);
        assert!(remainder.abs() < 0.03);
    }

    #[test]
    fn scroll_lines_cap_single_event_bursts() {
        let mut remainder = 0.0;
        assert_eq!(consume_scroll_lines(&mut remainder, 50.0), 3);
        assert_eq!(consume_scroll_lines(&mut remainder, -50.0), -3);
    }
}
