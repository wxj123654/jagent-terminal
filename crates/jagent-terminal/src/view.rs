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
mod link;
mod render;

pub use colors::ColorPalette;
pub use input::keystroke_to_bytes;
pub use link::{HoveredLink, TerminalLinkTarget, detect_link_at_point};
pub use render::TerminalRenderer;

/// 终端视图的 GPUI KeyContext 标识（用于隔离 Root Tab 焦点循环等全局裸键）。
pub const TERMINAL_KEY_CONTEXT: &str = "Terminal";

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point as AlacPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::TermMode;
use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, DispatchPhase, Edges, Entity, FocusHandle,
    HitboxBehavior, InputHandler, InteractiveElement, IntoElement, KeyDownEvent, Modifiers,
    ModifiersChangedEvent, MouseButton, MouseDownEvent, MouseExitEvent, MouseMoveEvent,
    MouseUpEvent, ParentElement, Pixels, Point, Render, ScrollDelta, ScrollWheelEvent, Size,
    Styled, Subscription, UTF16Selection, Window, canvas, div, px, quad, transparent_black,
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
    /// MOUSE_MODE 下左键按下上报中：记录上次上报的 1-based (col, row)，用于拖拽去重与抬起配对。
    mouse_reporting: Option<(usize, usize)>,
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
    /// 当前按住 Cmd/Ctrl 悬停命中的可点击文件路径或 URL。
    hovered_link: Option<HoveredLink>,
    /// Cmd/Ctrl + 左键按下时锁定的待打开链接（左键抬起仍在链接内时触发 OpenLink）。
    pending_link_open: Option<HoveredLink>,
    /// 上次执行链接探测的网格坐标（同格移动去重，避免重复扫描逻辑行与磁盘）。
    last_hover_cell: Option<AlacPoint>,
    /// 最近一次鼠标窗口坐标（供 ModifiersChangedEvent 原地刷新下划线显隐）。
    last_mouse_pos: Option<Point<Pixels>>,
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
/// 常态 thumb 不透明度：柔和半透明胶囊，不喧宾夺主。
const SCROLLBAR_OPACITY: f32 = 0.42;
/// 悬停 thumb 不透明度：鼠标移入滚动条命中区时加亮并加宽。
const SCROLLBAR_HOVER_OPACITY: f32 = 0.72;
/// 拖拽 thumb 不透明度：按住拖动时最高对比度反馈。
const SCROLLBAR_ACTIVE_OPACITY: f32 = 0.88;
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
        let subscription = cx.subscribe(&model, |this, _model, event: &Event, cx| {
            if matches!(event, Event::Wakeup) {
                this.last_hover_cell = None;
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
            mouse_reporting: None,
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
            hovered_link: None,
            pending_link_open: None,
            last_hover_cell: None,
            last_mouse_pos: None,
        }
    }

    /// 当前按住 Cmd/Ctrl 悬停命中的链接（供视觉巡检与单元测试断言）。
    pub fn hovered_link(&self) -> Option<&HoveredLink> {
        self.hovered_link.as_ref()
    }

    pub fn model(&self) -> Entity<TerminalModel> {
        self.model.clone()
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus_handle
    }

    pub fn dimensions(&self) -> (usize, usize) {
        self.head_dimensions().unwrap_or(self.last_dims)
    }

    /// 最近一帧渲染记录的终端视图窗口矩形。
    pub fn bounds(&self) -> Bounds<Pixels> {
        self.view_bounds.get()
    }

    fn head_dimensions(&self) -> Option<(usize, usize)> {
        self.content_metrics.get().map(|m| (m.cols, m.rows))
    }

    /// 当前回滚偏移行数（0 表示在最底部最新行，> 0 表示向上回滚了 N 行）。
    pub fn display_offset(&self, cx: &App) -> usize {
        self.model
            .read(cx)
            .with_term(|term| term.grid().display_offset())
    }

    /// 当前历史回滚缓冲区总行数。
    pub fn history_size(&self, cx: &App) -> usize {
        self.model
            .read(cx)
            .with_term(|term| term.grid().history_size())
    }

    /// 执行终端视口滚动（`Scroll::Delta` / `PageUp` / `PageDown` / `Top` / `Bottom`）。
    pub fn scroll_display(&mut self, scroll: Scroll, cx: &mut Context<Self>) {
        self.model
            .read(cx)
            .with_term_mut(|term| term.scroll_display(scroll));
        self.last_hover_cell = None;
        self.mouse_inside = true;
        self.show_scrollbar(cx);
        cx.notify();
    }

    /// 按行数滚动终端视口（正数向上看历史，负数向下回底部）。
    pub fn scroll_lines(&mut self, lines: i32, cx: &mut Context<Self>) {
        if lines != 0 {
            self.scroll_display(Scroll::Delta(lines), cx);
        }
    }

    /// 向上翻一页历史。
    pub fn scroll_page_up(&mut self, cx: &mut Context<Self>) {
        self.scroll_display(Scroll::PageUp, cx);
    }

    /// 向下翻一页历史。
    pub fn scroll_page_down(&mut self, cx: &mut Context<Self>) {
        self.scroll_display(Scroll::PageDown, cx);
    }

    /// 滚动到历史缓冲区最顶部。
    pub fn scroll_to_top(&mut self, cx: &mut Context<Self>) {
        self.scroll_display(Scroll::Top, cx);
    }

    /// 滚动回终端最底部（最新输出行）。
    pub fn scroll_to_bottom(&mut self, cx: &mut Context<Self>) {
        self.model
            .read(cx)
            .with_term_mut(|term| term.scroll_display(Scroll::Bottom));
        cx.notify();
    }

    /// 读取当前终端选区文本（若无选区或选区为空白串则返回 `None`）。
    pub fn selected_text(&self, cx: &App) -> Option<String> {
        self.model
            .read(cx)
            .with_term(|term| term.selection_to_string())
            .filter(|s| !s.is_empty())
    }

    /// 当前终端是否存在非空选区。
    pub fn has_selection(&self, cx: &App) -> bool {
        self.selected_text(cx).is_some()
    }

    /// 清除当前终端选区；若原本有选区则返回 `true`。
    pub fn clear_selection(&mut self, cx: &mut Context<Self>) -> bool {
        let cleared = self
            .model
            .read(cx)
            .with_term_mut(|term| term.selection.take().is_some());
        if cleared {
            cx.notify();
        }
        cleared
    }

    /// 全选终端缓冲区（包含回滚历史与当前屏幕全部行）。
    pub fn select_all(&mut self, cx: &mut Context<Self>) {
        self.model.read(cx).with_term_mut(|term| {
            let top = term.grid().topmost_line();
            let bottom = term.grid().bottommost_line();
            let last_col = term.grid().last_column();
            let mut sel = Selection::new(
                SelectionType::Simple,
                AlacPoint::new(top, Column(0)),
                Side::Left,
            );
            sel.update(AlacPoint::new(bottom, last_col), Side::Right);
            term.selection = Some(sel);
        });
        cx.notify();
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
    /// 殊途同归）。顺带重置闪烁相位与回滚偏移：打字时光标应立即可见并归底。
    fn commit_text(&mut self, text: &str, cx: &mut Context<Self>) {
        if !text.is_empty() {
            let model = self.model.read(cx);
            model.with_term_mut(|term| {
                if term.grid().display_offset() > 0 {
                    term.scroll_display(Scroll::Bottom);
                }
            });
            model.write_to_pty(text.as_bytes());
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
        // 键盘视口回滚快捷键：Shift+PageUp / Shift+PageDown / Shift+Home / Shift+End / Cmd+Home / Cmd+End
        if !ks.modifiers.control && !ks.modifiers.alt {
            if ks.modifiers.shift && !ks.modifiers.platform {
                match ks.key.as_str() {
                    "pageup" => {
                        self.scroll_page_up(cx);
                        cx.stop_propagation();
                        return;
                    }
                    "pagedown" => {
                        self.scroll_page_down(cx);
                        cx.stop_propagation();
                        return;
                    }
                    "home" => {
                        self.scroll_to_top(cx);
                        cx.stop_propagation();
                        return;
                    }
                    "end" => {
                        self.scroll_to_bottom(cx);
                        cx.stop_propagation();
                        return;
                    }
                    _ => {}
                }
            }
            if ks.modifiers.platform && !ks.modifiers.shift {
                match ks.key.as_str() {
                    "home" => {
                        self.scroll_to_top(cx);
                        cx.stop_propagation();
                        return;
                    }
                    "end" => {
                        self.scroll_to_bottom(cx);
                        cx.stop_propagation();
                        return;
                    }
                    "a" => {
                        self.select_all(cx);
                        cx.stop_propagation();
                        return;
                    }
                    _ => {}
                }
            }
        }
        // Cmd+C / Ctrl+Shift+C / Ctrl+Insert = 复制当前终端选区到剪贴板。
        if (ks.key == "c" && ks.modifiers.platform && !ks.modifiers.alt && !ks.modifiers.control)
            || (ks.key == "c"
                && ks.modifiers.control
                && ks.modifiers.shift
                && !ks.modifiers.alt
                && !ks.modifiers.platform)
            || (ks.key == "insert"
                && ks.modifiers.control
                && !ks.modifiers.shift
                && !ks.modifiers.alt)
        {
            self.copy_selection(cx);
            cx.stop_propagation();
            return;
        }
        // Cmd+V / Ctrl+V / Ctrl+Shift+V / Shift+Insert = 粘贴（Zed keymap 同款）。
        // 不能走 keystroke_to_bytes：Ctrl+V 会被编码成 0x16 (SYN) 写进 PTY，
        // readline 把它当 quoted-insert 吃掉，表现就是「粘贴没反应」。
        if (ks.key == "v" && ks.modifiers.platform && !ks.modifiers.alt && !ks.modifiers.control)
            || (ks.key == "v"
                && ks.modifiers.control
                && !ks.modifiers.alt
                && !ks.modifiers.platform)
            || (ks.key == "insert" && ks.modifiers.shift && !ks.modifiers.control)
        {
            self.paste_clipboard(cx);
            cx.stop_propagation();
            return;
        }
        let bytes = self
            .model
            .read(cx)
            .mode()
            .pipe(|mode| input::keystroke_to_bytes(&event.keystroke, mode));
        if let Some(bytes) = bytes {
            let model = self.model.read(cx);
            // 终端惯例（scroll_to_bottom_on_input）：在历史回滚处敲命令自动回到底部。
            model.with_term_mut(|term| {
                if term.grid().display_offset() > 0 {
                    term.scroll_display(Scroll::Bottom);
                }
            });
            model.write_to_pty(&bytes);
            self.blink_on = true;
            cx.stop_propagation();
            cx.notify();
        }
    }

    /// 剪贴板文本写入 PTY（Zed `terminal.paste` 同款语义）：
    /// - 应用开启 bracketed paste（BRACKETED_PASTE）时包 \x1b[200~ … \x1b[201~，
    ///   并剥掉文本内的 \x1b 防止提前闭合转义序列；
    /// - 否则把 \r\n / \n 归一成 \r（回车），多行文本逐行执行。
    ///
    /// 剪贴板无文本（图片等）时退化为转发原始 0x16，让能读 OS 剪贴板的
    /// TUI agent 走自己的粘贴路径。
    pub fn paste_clipboard(&mut self, cx: &mut Context<Self>) {
        let model = self.model.read(cx);
        model.with_term_mut(|term| {
            if term.grid().display_offset() > 0 {
                term.scroll_display(Scroll::Bottom);
            }
        });
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
        self.blink_on = true;
        cx.notify();
    }

    /// 左键按下：优先命中滚动条（拖拽/翻页），否则开始/调整选区。
    /// 选区语义与 Zed/alacritty 一致：单击 Simple、Alt+单击 Block（矩形块）、
    /// 双击 Semantic（词）、三击 Lines（整行）、Shift+单击扩展现有选区。
    /// 应用接管鼠标（MOUSE_MODE，如 vim/tmux/pi）时按住 Shift/Alt 走本地选区，
    /// 否则编码 SGR/X10 鼠标事件上报给 PTY。
    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.focus_handle.focus(window, cx);
        cx.stop_propagation();

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

        self.mouse_inside = true;
        self.last_mouse_pos = Some(event.position);
        self.pending_link_open = None;

        // Zed 风格：Cmd+Click（macOS）/ Ctrl+Click（Windows/Linux）命中文件路径或 URL 时，
        // 锁定待打开链接，不启动选区拖拽，也不向 MOUSE_MODE 上报点击。
        if event.click_count == 1 && is_link_modifier(&event.modifiers) {
            self.last_hover_cell = None;
            self.update_hovered_link(event.position, &event.modifiers, cx);
            if let Some(link) = self.hovered_link.clone() {
                self.pending_link_open = Some(link);
                cx.notify();
                return;
            }
        }

        let model = self.model.read(cx);
        let mode = model.mode();
        if mode.intersects(TermMode::MOUSE_MODE) && !event.modifiers.shift && !event.modifiers.alt {
            // 应用接管鼠标：清除本地选区并向 PTY 上报鼠标左键按下。
            model.with_term_mut(|term| term.selection = None);
            let (col, row) = grid_cell_1based(event.position, metrics);
            self.mouse_reporting = Some((col, row));
            let bytes = encode_mouse_report(0, col, row, false, event.modifiers, mode);
            model.write_to_pty(&bytes);
            cx.notify();
            return;
        }

        self.selecting = true;
        model.with_term_mut(|term| {
            let (point, side) =
                grid_point_and_side(event.position, metrics, term.grid().display_offset());
            let selection_type = if event.modifiers.alt {
                SelectionType::Block
            } else {
                match event.click_count {
                    1 => SelectionType::Simple,
                    2 => SelectionType::Semantic,
                    _ => SelectionType::Lines,
                }
            };
            if selection_type == SelectionType::Simple && event.modifiers.shift {
                // Shift+单击：把现有选区扩展到点击处；若此前无选区则新建。
                if let Some(selection) = term.selection.as_mut() {
                    selection.update(point, side);
                } else {
                    term.selection = Some(Selection::new(selection_type, point, side));
                }
            } else {
                term.selection = Some(Selection::new(selection_type, point, side));
            }
        });
        cx.notify();
    }

    /// 左键抬起：结束滚动条拖拽或鼠标上报；选区非空则复制到剪贴板
    /// （终端惯例 copy-on-release），选区为空（单纯点击）则清除空选区对象。
    fn on_mouse_up(&mut self, event: &MouseUpEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if let Some(pending) = self.pending_link_open.take() {
            if is_link_modifier(&event.modifiers)
                && let Some(metrics) = self.content_metrics.get()
            {
                let display_offset = self.display_offset(cx);
                let (point, _) = grid_point_and_side(event.position, metrics, display_offset);
                if pending.contains(point) {
                    self.model
                        .update(cx, |m, cx| m.open_link(pending.target, cx));
                }
            }
            return;
        }
        if let Some((last_col, last_row)) = self.mouse_reporting.take() {
            let (col, row) = self
                .content_metrics
                .get()
                .map(|m| grid_cell_1based(event.position, m))
                .unwrap_or((last_col, last_row));
            let model = self.model.read(cx);
            let mode = model.mode();
            if mode.intersects(TermMode::MOUSE_MODE) {
                let bytes = encode_mouse_report(0, col, row, true, event.modifiers, mode);
                model.write_to_pty(&bytes);
            }
        }
        let was_dragging = self.scrollbar_drag.take().is_some();
        if self.selecting {
            self.selecting = false;
            if !self.copy_selection(cx) {
                // 单击未拖出有效字符时，清理空 Selection
                let cleared = self.model.read(cx).with_term_mut(|term| {
                    if term.selection.as_ref().is_some_and(|s| s.is_empty()) {
                        term.selection = None;
                        true
                    } else {
                        false
                    }
                });
                if cleared {
                    cx.notify();
                }
            }
        }
        // 拖拽结束：松手点不在滚动条上且不在历史回滚中 → 渐出（Zed 同款）。
        if was_dragging {
            let hovered = self
                .scrollbar_layout
                .get()
                .is_some_and(|l| l.hit.contains(&event.position));
            let mut fx = self.scrollbar_fx.get();
            fx.hovered = hovered;
            fx.dragging = false;
            self.scrollbar_fx.set(fx);
            if !hovered && self.display_offset(cx) == 0 {
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
            self.mouse_reporting = None;
            self.pending_link_open = None;
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
        self.last_mouse_pos = inside.then_some(event.position);
        let hovered = self
            .scrollbar_layout
            .get()
            .is_some_and(|l| l.hit.contains(&event.position));
        let prev_hovered = {
            let mut fx = self.scrollbar_fx.get();
            let prev = fx.hovered;
            fx.hovered = hovered;
            self.scrollbar_fx.set(fx);
            prev
        };
        if prev_hovered != hovered {
            cx.notify();
        }
        if inside {
            // 移入/视图内移动：渐入并重置自动隐藏计时
            // （Zed 同款 last_show 语义）。
            self.show_scrollbar(cx);
        } else if self.mouse_inside && self.scrollbar_drag.is_none() && self.display_offset(cx) == 0
        {
            // 移出视图且处于底部：立即渐出。
            self.hide_scrollbar(cx);
        }
        self.mouse_inside = inside;
        self.update_hovered_link(event.position, &event.modifiers, cx);

        if event.pressed_button != Some(MouseButton::Left) {
            return;
        }
        if self.scrollbar_drag.is_some() {
            self.update_scrollbar_drag(event.position, cx);
            return;
        }
        if let Some((last_col, last_row)) = self.mouse_reporting {
            if let Some(metrics) = self.content_metrics.get() {
                let (col, row) = grid_cell_1based(event.position, metrics);
                if (col, row) != (last_col, last_row) {
                    self.mouse_reporting = Some((col, row));
                    let model = self.model.read(cx);
                    let mode = model.mode();
                    if mode.intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION) {
                        let bytes = encode_mouse_report(32, col, row, false, event.modifiers, mode);
                        model.write_to_pty(&bytes);
                    }
                }
            }
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

    /// 鼠标离开窗口（平台级 MouseExited）：等价移出视图，若在底部则渐出滚动条。
    fn handle_mouse_exit(&mut self, _event: &MouseExitEvent, cx: &mut Context<Self>) {
        self.mouse_inside = false;
        self.last_mouse_pos = None;
        self.last_hover_cell = None;
        self.pending_link_open = None;
        let _ = self.hovered_link.take();
        let mut fx = self.scrollbar_fx.get();
        fx.hovered = false;
        self.scrollbar_fx.set(fx);
        if self.scrollbar_drag.is_none() && self.display_offset(cx) == 0 {
            self.hide_scrollbar(cx);
        } else {
            cx.notify();
        }
    }

    /// 修饰键变化（按下/松开 Cmd 或 Ctrl）：鼠标静止在路径上时原地切换下划线与手型光标。
    pub fn on_modifiers_changed(&mut self, event: &ModifiersChangedEvent, cx: &mut Context<Self>) {
        if let Some(pos) = self.last_mouse_pos {
            self.update_hovered_link(pos, &event.modifiers, cx);
        } else if self.hovered_link.take().is_some() {
            self.last_hover_cell = None;
            cx.notify();
        }
    }

    /// 根据当前鼠标坐标与修饰键状态更新 `hovered_link`（含同格去重与同链接跨格复用）。
    fn update_hovered_link(
        &mut self,
        position: Point<Pixels>,
        modifiers: &Modifiers,
        cx: &mut Context<Self>,
    ) {
        let on_scrollbar = self
            .scrollbar_layout
            .get()
            .is_some_and(|l| l.hit.contains(&position));
        if !self.mouse_inside
            || on_scrollbar
            || self.selecting
            || self.scrollbar_drag.is_some()
            || !is_link_modifier(modifiers)
        {
            self.last_hover_cell = None;
            if self.hovered_link.take().is_some() {
                cx.notify();
            }
            return;
        }

        let Some(metrics) = self.content_metrics.get() else {
            return;
        };
        let display_offset = self.display_offset(cx);
        let (point, _) = grid_point_and_side(position, metrics, display_offset);

        // 同一网格 cell 内微移不重扫
        if self.last_hover_cell == Some(point) {
            return;
        }
        self.last_hover_cell = Some(point);

        // 仍在当前已命中的链接区间内移动时，直接复用
        if self
            .hovered_link
            .as_ref()
            .is_some_and(|link| link.contains(point))
        {
            return;
        }

        let next_link = {
            let model = self.model.read(cx);
            let cwd = model.cwd().map(std::path::Path::to_path_buf);
            model.with_term(|term| link::detect_link_at_point(term, point, cwd.as_deref()))
        };
        if self.hovered_link != next_link {
            self.hovered_link = next_link;
            cx.notify();
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
        if let ScrollbarVisibility::Animating { to: t, .. } = fx.visibility
            && (t - scrollbar_opacity(to)).abs() < f32::EPSILON
        {
            return;
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
    /// 滚动/视图内移动都会调用，generation 防止过期 timer 提前隐藏；
    /// 处于历史回滚态 display_offset > 0 时保持可见，回到底部后才自动淡出）。
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
                    && v.display_offset(cx) == 0
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

    /// 当前选区文本写入剪贴板；若有非空选区并已写入则返回 `true`。
    pub fn copy_selection(&mut self, cx: &mut Context<Self>) -> bool {
        let text = self
            .model
            .read(cx)
            .with_term(|term| term.selection_to_string());
        if let Some(text) = text
            && !text.is_empty()
        {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
            return true;
        }
        false
    }

    /// 滚轮 → 三级路由：
    /// - 应用接管鼠标（MOUSE_MODE）且未按住 Shift：编码 SGR/X10 滚轮序列（button 64/65）发送给 PTY；
    /// - 备用屏（alt screen，TUI 常驻）且未按住 Shift：无 scrollback，转 Up/Down 方向键发送给 PTY；
    /// - 主屏（normal screen）或按住 Shift 强制回滚：scroll_display 移动回滚视口并显示滚动条。
    fn on_scroll(
        &mut self,
        event: &ScrollWheelEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.stop_propagation();
        let cell_h = self
            .content_metrics
            .get()
            .map(|m| m.cell_height)
            .unwrap_or(self.renderer.cell_height)
            .max(px(1.0));
        // GPUI 约定 delta.y > 0 = 向内容顶部滚动（向上）
        let lines_f32 = match event.delta {
            ScrollDelta::Lines(l) => l.y,
            ScrollDelta::Pixels(p) => p.y / cell_h,
        };
        let lines = consume_scroll_lines(&mut self.scroll_remainder_lines, lines_f32);
        if lines == 0 {
            return;
        }
        {
            let model = self.model.read(cx);
            let mode = model.mode();
            if mode.intersects(TermMode::MOUSE_MODE) && !event.modifiers.shift {
                let (col, row) = self
                    .content_metrics
                    .get()
                    .map(|m| grid_cell_1based(event.position, m))
                    .unwrap_or((1, 1));
                let btn = if lines > 0 { 64 } else { 65 };
                let seq = encode_mouse_report(btn, col, row, false, event.modifiers, mode);
                for _ in 0..lines.unsigned_abs() {
                    model.write_to_pty(&seq);
                }
                return;
            }
            if mode.contains(TermMode::ALT_SCREEN) && !event.modifiers.shift {
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

/// Zed 风格链接激活修饰键：macOS 下为 `Cmd`（`platform`），Windows/Linux 下为 `Ctrl`（`control` 或 `platform`）。
fn is_link_modifier(modifiers: &Modifiers) -> bool {
    if cfg!(target_os = "macos") {
        modifiers.platform && !modifiers.control && !modifiers.alt
    } else {
        (modifiers.control || modifiers.platform) && !modifiers.alt
    }
}

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

/// 窗口坐标 → 1-based (col, row)，供 SGR / X10 鼠标协议上报。
fn grid_cell_1based(pos: Point<Pixels>, metrics: ContentMetrics) -> (usize, usize) {
    let rel_x: f32 = (pos.x - metrics.origin.x).max(px(0.0)).into();
    let rel_y: f32 = (pos.y - metrics.origin.y).max(px(0.0)).into();
    let cw: f32 = metrics.cell_width.max(px(1.0)).into();
    let ch: f32 = metrics.cell_height.max(px(1.0)).into();
    let col = ((rel_x / cw) as usize + 1).clamp(1, metrics.cols.max(1));
    let row = ((rel_y / ch) as usize + 1).clamp(1, metrics.rows.max(1));
    (col, row)
}

/// 编码终端鼠标事件序列（优先 SGR 1006 扩展格式，回退 X10 / Normal 1000 格式）。
fn encode_mouse_report(
    button_code: u8,
    col_1based: usize,
    row_1based: usize,
    release: bool,
    modifiers: Modifiers,
    mode: TermMode,
) -> Vec<u8> {
    let mut cb = button_code;
    if modifiers.shift {
        cb += 4;
    }
    if modifiers.alt {
        cb += 8;
    }
    if modifiers.control {
        cb += 16;
    }
    if mode.contains(TermMode::SGR_MOUSE) {
        let suffix = if release { 'm' } else { 'M' };
        format!("\x1b[<{cb};{col_1based};{row_1based}{suffix}").into_bytes()
    } else {
        let code = if release { (cb & !0b11) | 3 } else { cb };
        let cx = (col_1based.min(223) as u8).saturating_add(32);
        let cy = (row_1based.min(223) as u8).saturating_add(32);
        vec![0x1b, b'[', b'M', code.saturating_add(32), cx, cy]
    }
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
        self.renderer.hovered_link = self.hovered_link.clone();

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
            .id("terminal-view")
            .key_context(TERMINAL_KEY_CONTEXT)
            .size_full()
            .bg(background)
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_modifiers_changed(cx.listener(|v, e: &ModifiersChangedEvent, _, cx| {
                v.on_modifiers_changed(e, cx);
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_scroll_wheel(cx.listener(Self::on_scroll))
            .child(
                canvas(
                    move |bounds, window, _cx| {
                        let hitbox = window.insert_hitbox(bounds, HitboxBehavior::Normal);
                        (bounds, hitbox)
                    },
                    move |bounds, (_, hitbox), window, cx| {
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
                            } else if history > 0
                                && display_offset > 0
                                && fx.visibility == ScrollbarVisibility::Hidden
                            {
                                // 处于历史回滚态时始终保持滚动条可见，指示当前不在底部。
                                fx.visibility = ScrollbarVisibility::Visible;
                                scrollbar_fx.set(fx);
                                opacity = 1.0;
                            }
                            window.set_cursor_style(
                                if fx.hovered || fx.dragging || measured.hovered_link.is_some() {
                                    CursorStyle::PointingHand
                                } else {
                                    CursorStyle::IBeam
                                },
                                &hitbox,
                            );
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
                                let thumb_width = if fx.hovered || fx.dragging {
                                    px(5.0)
                                } else {
                                    px(3.5)
                                };
                                let thumb = Bounds {
                                    origin: Point {
                                        x: track_right - thumb_width - px(2.0),
                                        y: thumb_top,
                                    },
                                    size: Size {
                                        width: thumb_width,
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
                                if fx.hovered || fx.dragging {
                                    window.paint_quad(quad(
                                        Bounds {
                                            origin: Point {
                                                x: track_right - px(8.0),
                                                y: track_top,
                                            },
                                            size: Size {
                                                width: px(7.0),
                                                height: track_height,
                                            },
                                        },
                                        px(99.0),
                                        measured.palette.foreground().alpha(0.05 * opacity),
                                        Edges::<Pixels>::default(),
                                        transparent_black(),
                                        Default::default(),
                                    ));
                                }
                                window.paint_quad(quad(
                                    thumb,
                                    px(99.0),
                                    measured.palette.foreground().alpha(state_alpha * opacity),
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
///
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
    use super::*;

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

    #[test]
    fn grid_cell_1based_and_sgr_mouse_report_encoding() {
        let metrics = ContentMetrics {
            origin: Point {
                x: px(10.0),
                y: px(20.0),
            },
            cell_width: px(8.0),
            cell_height: px(16.0),
            cols: 80,
            rows: 24,
        };
        assert_eq!(
            grid_cell_1based(
                Point {
                    x: px(10.0),
                    y: px(20.0),
                },
                metrics
            ),
            (1, 1)
        );
        assert_eq!(
            grid_cell_1based(
                Point {
                    x: px(10.0 + 8.0 * 4.5),
                    y: px(20.0 + 16.0 * 2.2),
                },
                metrics
            ),
            (5, 3)
        );

        let sgr_mode = TermMode::MOUSE_REPORT_CLICK | TermMode::SGR_MOUSE;
        // 左键按下 (1-based col=5, row=3)
        assert_eq!(
            encode_mouse_report(0, 5, 3, false, Modifiers::none(), sgr_mode),
            b"\x1b[<0;5;3M".to_vec()
        );
        // 左键抬起
        assert_eq!(
            encode_mouse_report(0, 5, 3, true, Modifiers::none(), sgr_mode),
            b"\x1b[<0;5;3m".to_vec()
        );
        // 滚轮向上 (button=64) / 向下 (button=65)
        assert_eq!(
            encode_mouse_report(64, 12, 8, false, Modifiers::none(), sgr_mode),
            b"\x1b[<64;12;8M".to_vec()
        );
        assert_eq!(
            encode_mouse_report(65, 12, 8, false, Modifiers::none(), sgr_mode),
            b"\x1b[<65;12;8M".to_vec()
        );
    }

    #[test]
    fn grid_point_and_side_accounts_for_scrollback_display_offset() {
        let metrics = ContentMetrics {
            origin: Point {
                x: px(8.0),
                y: px(8.0),
            },
            cell_width: px(10.0),
            cell_height: px(20.0),
            cols: 80,
            rows: 24,
        };
        // 屏幕第 2 行（0-based line=2）、第 3 列右半格，回滚 display_offset=10 → buffer Line(-8)
        let (pt, side) = grid_point_and_side(
            Point {
                x: px(8.0 + 37.0),
                y: px(8.0 + 45.0),
            },
            metrics,
            10,
        );
        assert_eq!(pt.line, Line(-8));
        assert_eq!(pt.column, Column(3));
        assert_eq!(side, Side::Right);
    }
}
