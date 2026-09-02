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

use alacritty_terminal::grid::Dimensions;
use gpui::{
    canvas, div, App, Context, Entity, FocusHandle, InteractiveElement,
    IntoElement, KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    ParentElement, Render, ScrollWheelEvent, Styled, Subscription, Window,
};

use crate::model::{Event, TerminalModel};
use colors::ColorPalette as Palette;

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
            Palette::default(),
        );

        // Repaint when the model wakes up (new content, title, bell, exit...).
        let subscription = cx.subscribe(&model, |_this, _model, event: &Event, cx| {
            if matches!(event, Event::Wakeup) {
                cx.notify();
            }
        });

        Self {
            model,
            renderer,
            focus_handle: cx.focus_handle(),
            _subscription: subscription,
            last_dims: (80, 24),
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
        changed
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let bytes = self
            .model
            .read(cx)
            .mode()
            .pipe(|mode| input::keystroke_to_bytes(&event.keystroke, mode));
        if let Some(bytes) = bytes {
            self.model.read(cx).write_to_pty(&bytes);
        }
    }

    fn on_mouse_down(&mut self, _event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_handle.focus(window, cx);
        cx.notify();
    }

    fn on_mouse_up(&mut self, _event: &MouseUpEvent, _window: &mut Window, _cx: &mut Context<Self>) {}

    fn on_mouse_move(&mut self, _event: &MouseMoveEvent, _window: &mut Window, _cx: &mut Context<Self>) {}

    fn on_scroll(&mut self, _event: &ScrollWheelEvent, _window: &mut Window, _cx: &mut Context<Self>) {
        // TODO(Phase 2): scrollback via model.with_term_mut(scroll_display)
    }
}

/// Tiny combinator to keep the mode read inline.
trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}

impl Render for TerminalView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_style(cx);

        let model = self.model.clone();
        let renderer = self.renderer.clone();
        let padding = model.read(cx).style().padding;
        let background = renderer.palette.background();

        div()
            .size_full()
            .bg(background)
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(Self::on_key_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
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

                        let term = term_lock.lock();
                        measured.paint(bounds, padding, &term, window, cx);
                    },
                )
                .size_full(),
            )
    }
}
