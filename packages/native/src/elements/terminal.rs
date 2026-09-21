//! `<terminal>` custom element — the GPUIX binding layer (architecture.md §2.4).
//!
//! Lives in this crate (not jagent-terminal) because it implements the GPUIX
//! `CustomElement` trait from gpuix-native; jagent-terminal stays napi/gpuix
//! free and independently testable (architecture.md §8.1).
//!
//! Retain semantics: `destroy()` drops only the view entity; the session
//! stays in the pool until `destroyTerminalSession` (R1/R2 seam rules).

use gpuix_native::GpuixView;
use gpuix_native::custom_elements::{CustomElement, CustomElementFactory, CustomRenderContext};
use jagent_terminal::{TerminalPool, TerminalView};
use serde_json::Value;

use gpui::{AnyElement, AppContext, Context, Entity, IntoElement, ParentElement, Styled, Window};
use gpui::{SharedString, div, px, rgb};

/// Factory registered process-wide at module load (lib.rs `#[module_exports]`).
pub struct TerminalElementFactory;

impl CustomElementFactory for TerminalElementFactory {
    fn element_type(&self) -> &str {
        "terminal"
    }

    fn create(&self, _id: u64) -> Box<dyn CustomElement> {
        Box::new(TerminalElement {
            session_id: None,
            view: None,
            font_family: None,
            font_size: None,
            // Props acknowledged but not yet forwarded (Phase 2 settings):
            palette: None,
            cursor_blink: None,
            focused: false,
        })
    }
}

pub struct TerminalElement {
    session_id: Option<u64>,
    /// Lazily created per (element id, sessionId) binding; dropped on unbind.
    view: Option<Entity<TerminalView>>,
    // Style props (appearance: set_props → forwarded to model.set_style).
    font_family: Option<String>,
    font_size: Option<f64>,
    palette: Option<String>,
    cursor_blink: Option<bool>,
    focused: bool,
}

impl TerminalElement {
    /// Apply changed style props to the bound model. Called every render;
    /// the diff against the model's current style skips the update entirely
    /// on the steady-state frame (set_style is also idempotent — double
    /// defense against notify→repaint loops).
    fn apply_style(&self, model: &Entity<TerminalModel>, cx: &mut Context<GpuixView>) {
        let mut style = model.read(cx).style().clone();
        if let Some(f) = &self.font_family {
            style.font_family = SharedString::from(f.clone());
        }
        if let Some(s) = self.font_size {
            style.font_size = px(s as f32);
        }
        if let Some(p) = &self.palette {
            style.palette = SharedString::from(p.clone());
        }
        if let Some(b) = self.cursor_blink {
            style.cursor_blink = b;
        }
        if *model.read(cx).style() != style {
            model.update(cx, |m, cx| m.set_style(style, cx));
        }
    }

    fn placeholder(&self) -> AnyElement {
        div()
            .flex()
            .size_full()
            .bg(rgb(0x1a1a1a))
            .child("no session")
            .into_any_element()
    }
}

use jagent_terminal::TerminalModel;

impl CustomElement for TerminalElement {
    fn render(
        &mut self,
        _ctx: CustomRenderContext,
        window: &mut Window,
        cx: &mut Context<GpuixView>,
    ) -> AnyElement {
        let Some(session_id) = self.session_id else {
            return self.placeholder();
        };
        let Some(model) = cx.global::<TerminalPool>().get(session_id) else {
            // Session destroyed while the element still renders (close in
            // flight): show the placeholder until React unmounts us.
            self.view = None;
            return self.placeholder();
        };

        // (Re)bind the view entity if missing or rebound to another session.
        let needs_view = match &self.view {
            Some(view) => view.read(cx).model() != model,
            None => true,
        };
        if needs_view {
            self.view = None;
            self.view = Some(cx.new(|cx| TerminalView::new(model, cx)));
        }
        let view = self.view.clone().expect("view just set");

        self.apply_style(&view.read(cx).model(), cx);

        // focused = 「无焦点持有者时兜底聚焦」，不是每帧抢焦点。
        // 每帧 focus() 会把焦点从用户刚点击的输入框抢回来（PTY 输出 →
        // Wakeup → 重渲染，打字时每秒几十次）；gpuix sync_focus_handles
        // 同款纪律：autoFocus 只在创建时聚焦一次。这里放宽为「真空才
        // 聚焦」以保住两条语义：挂载/激活时聚焦终端；弹窗输入框卸载后
        // （gpui release_dropped_focus_handles 把 window.focus 清为
        // None）焦点自动落回终端。
        if self.focused && window.focused(cx).is_none() {
            let handle = view.read(cx).focus_handle().clone();
            handle.focus(window, cx);
        }

        view.into_any_element()
    }

    fn set_prop(&mut self, key: &str, value: Value) {
        let null = value.is_null();
        match key {
            "sessionId" => {
                let new = if null {
                    None
                } else {
                    value.as_f64().map(|f| f as u64)
                };
                if new != self.session_id {
                    self.session_id = new;
                    self.view = None; // rebind next frame
                }
            }
            "fontFamily" => self.font_family = value.as_str().map(str::to_string),
            "fontSize" => self.font_size = if null { None } else { value.as_f64() },
            "palette" => self.palette = value.as_str().map(str::to_string),
            "cursorBlink" => self.cursor_blink = value.as_bool(),
            "focused" => self.focused = value.as_bool().unwrap_or(false),
            _ => {}
        }
    }

    fn supported_props(&self) -> &'static [&'static str] {
        &[
            "sessionId",
            "fontFamily",
            "fontSize",
            "cursorBlink",
            "palette",
            "focused",
        ]
    }

    fn supported_events(&self) -> &'static [&'static str] {
        // TODO(Phase 2): emit focus/blur via ctx.event_callback once the
        // GPUIX focus-event ordering is validated (Phase 1 R-V2).
        &["focus", "blur"]
    }

    fn destroy(&mut self) {
        // Retain semantics (R1): only unbind the view; the session stays in
        // the pool — background PTYs keep running and BEL still fires.
        self.view = None;
    }
}
