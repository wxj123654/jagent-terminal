//! `<canvas>` / Canvas 2D 最小实现（bitmap-first 路线，
//! docs/canvas-rust-raster-research.md §8）。
//!
//! 分层：
//! - [`state`] — WHATWG drawing state 状态机（Ctx2d），后端无关。
//! - [`backend`] — 光栅 trait；`VelloBackend` 用 vello_cpu 录制式
//!   RenderContext，`commit()` 时 SrcOver 叠加进持久 Pixmap。
//! - [`text`] — cosmic-text shaping → glyph run。
//! - 本文件 — surface 注册表（离屏 canvas / drawImage(canvas) 预留）、
//!   napi 命令、`<canvas>` custom element（Pixmap→BGRA→RenderImage→
//!   window.paint_image）。
//!
//! 像素约定：backing store 为 premultiplied RGBA8；GPUI atlas 是 BGRA，
//! 上传时做 R/B swizzle。getImageData 返回 unpremultiplied RGBA。

mod backend;
mod state;
mod text;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use gpui::{
    Bounds, Corners, Pixels, RenderImage, Window, canvas, div, point, prelude::*, px, size,
};
use gpuix_native::custom_elements::{CustomElement, CustomElementFactory, CustomRenderContext};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;
use vello_cpu::kurbo::Affine;

use backend::VelloBackend;
use state::{
    CompositeOp, Ctx2d, FontSpec, LineCap, LineJoin, PaintSpec, Repetition, TextAlign,
    TextBaseline, parse_fill_rule, parse_paint, parse_paint_value,
};

type SurfaceCtx = Ctx2d<VelloBackend>;

/// surface 注册表：napi 命令与挂载元素共享。id 单调递增不复用；
/// `canvasDestroy` 释放。离屏 canvas 与 `drawImage(canvas)` 在此预留——
/// Pixmap 已可脱离元素独立存在。
fn surfaces() -> &'static Mutex<HashMap<u64, SurfaceCtx>> {
    static SURFACES: OnceLock<Mutex<HashMap<u64, SurfaceCtx>>> = OnceLock::new();
    SURFACES.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_SURFACE_ID: AtomicU64 = AtomicU64::new(1);

fn canvas_error(message: impl std::fmt::Display) -> napi::Error<String> {
    napi::Error::new("ERR_CANVAS".to_string(), message.to_string())
}

fn with_surface<R>(id: f64, f: impl FnOnce(&mut SurfaceCtx) -> R) -> Result<R, String> {
    let Ok(mut registry) = surfaces().lock() else {
        return Err(canvas_error("surface registry lock poisoned"));
    };
    match registry.get_mut(&(id as u64)) {
        Some(ctx) => Ok(f(ctx)),
        None => Err(canvas_error(format!("unknown surface id {id}"))),
    }
}

fn checked_size(width: f64, height: f64) -> Result<(u16, u16), String> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err(canvas_error(format!(
            "canvas size must be positive, got {width}x{height}"
        )));
    }
    if width > f64::from(u16::MAX) || height > f64::from(u16::MAX) {
        return Err(canvas_error(format!(
            "canvas size {width}x{height} exceeds u16 limit"
        )));
    }
    Ok((width as u16, height as u16))
}

fn checked_rect(x: f64, y: f64, w: f64, h: f64) -> Result<(i32, i32, u32, u32), String> {
    if !w.is_finite() || !h.is_finite() || w < 0.0 || h < 0.0 {
        return Err(canvas_error("image data rect must be non-negative"));
    }
    Ok((x as i32, y as i32, w as u32, h as u32))
}

// ── napi：surface 生命周期 ──────────────────────────────────────────

/// 创建一块 backing store surface（离屏 canvas / `<canvas>` 共用）。
/// 返回 surface id。
#[napi]
pub fn canvas_create(width: f64, height: f64) -> Result<f64, String> {
    let (w, h) = checked_size(width, height)?;
    let id = NEXT_SURFACE_ID.fetch_add(1, Ordering::Relaxed);
    let Ok(mut registry) = surfaces().lock() else {
        return Err(canvas_error("surface registry lock poisoned"));
    };
    registry.insert(id, Ctx2d::new(VelloBackend::new(w, h)));
    Ok(id as f64)
}

#[napi]
pub fn canvas_destroy(id: f64) -> Result<(), String> {
    let Ok(mut registry) = surfaces().lock() else {
        return Err(canvas_error("surface registry lock poisoned"));
    };
    registry.remove(&(id as u64));
    Ok(())
}

/// 重设 backing 尺寸。规范语义：清空 bitmap 并重置全部 context 状态。
#[napi]
pub fn canvas_resize(id: f64, width: f64, height: f64) -> Result<(), String> {
    let (w, h) = checked_size(width, height)?;
    with_surface(id, |ctx| ctx.resize(w, h))
}

/// 当前像素修订号：挂载元素据此判断是否重传纹理。
#[napi]
pub fn canvas_revision(id: f64) -> Result<f64, String> {
    with_surface(id, |ctx| ctx.revision() as f64)
}

/// `ctx.reset()`：清空 bitmap 并重置全部状态（规范语义）。
#[napi]
pub fn canvas_reset(id: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.reset())
}

// ── napi：drawing state ─────────────────────────────────────────────

/// `fillStyle`/`strokeStyle`：CSS 颜色字符串，或 CanvasGradient 序列化出的
/// 渐变描述对象（{"kind":"linear"|"radial"|"conic", ...}）。非法值返回
/// 错误——浏览器语义是静默忽略，由 JS 侧自行决定。
#[napi]
pub fn canvas_set_fill_style(id: f64, value: Value) -> Result<(), String> {
    let paint = parse_paint_value(&value)
        .ok_or_else(|| canvas_error(format!("unparseable fillStyle {value}")))?;
    with_surface(id, |ctx| ctx.set_fill_style(paint))
}

#[napi]
pub fn canvas_set_stroke_style(id: f64, value: Value) -> Result<(), String> {
    let paint = parse_paint_value(&value)
        .ok_or_else(|| canvas_error(format!("unparseable strokeStyle {value}")))?;
    with_surface(id, |ctx| ctx.set_stroke_style(paint))
}

/// `CanvasGradient.addColorStop` 的 CSS 颜色校验（非法 → JS 抛 SyntaxError）。
#[napi]
pub fn canvas_check_color(css: String) -> bool {
    parse_paint(&css).is_some()
}

/// `fillStyle`/`strokeStyle` = CanvasPattern：像素为 unpremultiplied RGBA8
/// （createPattern 时刻的快照，JS 经 getImageData 取得）。
#[napi]
pub fn canvas_set_fill_pattern(
    id: f64,
    pixels: Buffer,
    width: f64,
    height: f64,
    repetition: String,
) -> Result<(), String> {
    let paint = pattern_paint(&pixels, width, height, &repetition)?;
    with_surface(id, |ctx| ctx.set_fill_style(paint))
}

#[napi]
pub fn canvas_set_stroke_pattern(
    id: f64,
    pixels: Buffer,
    width: f64,
    height: f64,
    repetition: String,
) -> Result<(), String> {
    let paint = pattern_paint(&pixels, width, height, &repetition)?;
    with_surface(id, |ctx| ctx.set_stroke_style(paint))
}

fn pattern_paint(
    pixels: &[u8],
    width: f64,
    height: f64,
    repetition: &str,
) -> Result<PaintSpec, String> {
    let rep = Repetition::parse(repetition)
        .ok_or_else(|| canvas_error(format!("unknown pattern repetition '{repetition}'")))?;
    let (w, h) = checked_size(width, height)?;
    let need = w as usize * h as usize * 4;
    if pixels.len() < need {
        return Err(canvas_error(format!(
            "pattern pixels too small: {} < {need}",
            pixels.len()
        )));
    }
    Ok(PaintSpec::pattern(
        pixels[..need].to_vec(),
        u32::from(w),
        u32::from(h),
        rep,
    ))
}

/// `imageSmoothingEnabled`：drawImage/pattern 采样质量（双线性 vs 最近邻）。
#[napi]
pub fn canvas_set_image_smoothing(id: f64, enabled: bool) -> Result<(), String> {
    with_surface(id, |ctx| ctx.set_image_smoothing(enabled))
}

#[napi]
pub fn canvas_set_global_alpha(id: f64, alpha: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.set_global_alpha(alpha as f32))
}

#[napi]
pub fn canvas_set_composite_op(id: f64, op: String) -> Result<(), String> {
    let composite = CompositeOp::parse(&op)
        .ok_or_else(|| canvas_error(format!("unknown composite op '{op}'")))?;
    with_surface(id, |ctx| ctx.set_composite(composite))
}

#[napi]
pub fn canvas_set_line_width(id: f64, width: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.set_line_width(width))
}

#[napi]
pub fn canvas_set_line_cap(id: f64, cap: String) -> Result<(), String> {
    let cap = match cap.as_str() {
        "butt" => LineCap::Butt,
        "round" => LineCap::Round,
        "square" => LineCap::Square,
        _ => return Err(canvas_error(format!("unknown lineCap '{cap}'"))),
    };
    with_surface(id, |ctx| ctx.set_line_cap(cap))
}

#[napi]
pub fn canvas_set_line_join(id: f64, join: String) -> Result<(), String> {
    let join = match join.as_str() {
        "miter" => LineJoin::Miter,
        "round" => LineJoin::Round,
        "bevel" => LineJoin::Bevel,
        _ => return Err(canvas_error(format!("unknown lineJoin '{join}'"))),
    };
    with_surface(id, |ctx| ctx.set_line_join(join))
}

#[napi]
pub fn canvas_set_miter_limit(id: f64, limit: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.set_miter_limit(limit))
}

#[napi]
pub fn canvas_set_line_dash(id: f64, dashes: Vec<f64>, offset: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.set_line_dash(dashes, offset))
}

/// 结构化字体规格（canvas `font` shorthand 由 JS 解析后分字段传入）。
#[napi]
pub fn canvas_set_font(
    id: f64,
    family: String,
    size: f64,
    weight: f64,
    italic: bool,
) -> Result<(), String> {
    if !size.is_finite() || size <= 0.0 {
        return Err(canvas_error("font size must be positive"));
    }
    with_surface(id, |ctx| {
        ctx.set_font(FontSpec {
            family,
            size: size as f32,
            weight: weight as u16,
            italic,
        })
    })
}

#[napi]
pub fn canvas_set_text_align(id: f64, align: String) -> Result<(), String> {
    let align = match align.as_str() {
        "start" => TextAlign::Start,
        "end" => TextAlign::End,
        "left" => TextAlign::Left,
        "right" => TextAlign::Right,
        "center" => TextAlign::Center,
        _ => return Err(canvas_error(format!("unknown textAlign '{align}'"))),
    };
    with_surface(id, |ctx| ctx.set_text_align(align))
}

#[napi]
pub fn canvas_set_text_baseline(id: f64, baseline: String) -> Result<(), String> {
    let baseline = match baseline.as_str() {
        "top" => TextBaseline::Top,
        "hanging" => TextBaseline::Hanging,
        "middle" => TextBaseline::Middle,
        "alphabetic" => TextBaseline::Alphabetic,
        "ideographic" => TextBaseline::Ideographic,
        "bottom" => TextBaseline::Bottom,
        _ => return Err(canvas_error(format!("unknown textBaseline '{baseline}'"))),
    };
    with_surface(id, |ctx| ctx.set_text_baseline(baseline))
}

#[napi]
pub fn canvas_save(id: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.save())
}

#[napi]
pub fn canvas_restore(id: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.restore())
}

// ── napi：transform（a b c d e f 与 DOMMatrix 一致）─────────────────

fn affine_of(v: (f64, f64, f64, f64, f64, f64)) -> Affine {
    Affine::new([v.0, v.1, v.2, v.3, v.4, v.5])
}

#[napi]
pub fn canvas_set_transform(
    id: f64,
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
) -> Result<(), String> {
    with_surface(id, |ctx| ctx.set_transform(affine_of((a, b, c, d, e, f))))
}

#[napi]
pub fn canvas_transform(
    id: f64,
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
) -> Result<(), String> {
    with_surface(id, |ctx| ctx.transform(affine_of((a, b, c, d, e, f))))
}

#[napi]
pub fn canvas_reset_transform(id: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.reset_transform())
}

// ── napi：current default path ──────────────────────────────────────

#[napi]
pub fn canvas_begin_path(id: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.begin_path())
}

#[napi]
pub fn canvas_move_to(id: f64, x: f64, y: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.move_to(x, y))
}

#[napi]
pub fn canvas_line_to(id: f64, x: f64, y: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.line_to(x, y))
}

#[napi]
pub fn canvas_quadratic_to(id: f64, cx: f64, cy: f64, x: f64, y: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.quadratic_to(cx, cy, x, y))
}

#[napi]
pub fn canvas_bezier_to(
    id: f64,
    c1x: f64,
    c1y: f64,
    c2x: f64,
    c2y: f64,
    x: f64,
    y: f64,
) -> Result<(), String> {
    with_surface(id, |ctx| ctx.bezier_to(c1x, c1y, c2x, c2y, x, y))
}

#[napi]
pub fn canvas_arc(
    id: f64,
    cx: f64,
    cy: f64,
    radius: f64,
    start: f64,
    end: f64,
    anticlockwise: bool,
) -> Result<(), String> {
    with_surface(id, |ctx| ctx.arc(cx, cy, radius, start, end, anticlockwise))
}

#[napi]
pub fn canvas_rect(id: f64, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.rect(x, y, w, h))
}

#[napi]
pub fn canvas_round_rect(
    id: f64,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    radius: f64,
) -> Result<(), String> {
    with_surface(id, |ctx| ctx.round_rect(x, y, w, h, radius))
}

#[napi]
pub fn canvas_close_path(id: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.close_path())
}

// ── napi：paint ops ─────────────────────────────────────────────────

#[napi]
pub fn canvas_fill(id: f64, rule: String) -> Result<(), String> {
    let rule = parse_fill_rule(&rule)
        .ok_or_else(|| canvas_error(format!("unknown fill rule '{rule}'")))?;
    with_surface(id, |ctx| ctx.fill(rule))
}

#[napi]
pub fn canvas_stroke(id: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.stroke())
}

#[napi]
pub fn canvas_clip(id: f64, rule: String) -> Result<(), String> {
    let rule = parse_fill_rule(&rule)
        .ok_or_else(|| canvas_error(format!("unknown clip rule '{rule}'")))?;
    with_surface(id, |ctx| ctx.clip(rule))
}

#[napi]
pub fn canvas_fill_rect(id: f64, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.fill_rect(x, y, w, h))
}

#[napi]
pub fn canvas_stroke_rect(id: f64, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.stroke_rect(x, y, w, h))
}

#[napi]
pub fn canvas_clear_rect(id: f64, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.clear_rect(x, y, w, h))
}

#[napi]
pub fn canvas_fill_text(id: f64, text: String, x: f64, y: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.fill_text(&text, x, y))
}

#[napi]
pub fn canvas_stroke_text(id: f64, text: String, x: f64, y: f64) -> Result<(), String> {
    with_surface(id, |ctx| ctx.stroke_text(&text, x, y))
}

/// `measureText` 最小子集：width + font bounding box（首行 metrics）。
#[napi(object)]
pub struct CanvasTextMetrics {
    pub width: f64,
    pub font_bounding_box_ascent: f64,
    pub font_bounding_box_descent: f64,
}

#[napi]
pub fn canvas_measure_text(id: f64, text: String) -> Result<CanvasTextMetrics, String> {
    with_surface(id, |ctx| {
        let m = ctx.measure_text(&text);
        CanvasTextMetrics {
            width: f64::from(m.width),
            font_bounding_box_ascent: f64::from(m.ascent),
            font_bounding_box_descent: f64::from(m.descent),
        }
    })
}

// ── napi：pixels ────────────────────────────────────────────────────

/// `getImageData`：unpremultiplied RGBA8，越界区域为 transparent black。
#[napi]
pub fn canvas_get_image_data(id: f64, x: f64, y: f64, w: f64, h: f64) -> Result<Buffer, String> {
    let (x, y, w, h) = checked_rect(x, y, w, h)?;
    with_surface(id, |ctx| Buffer::from(ctx.image_data(x, y, w, h)))
}

/// `putImageData`：data 为 unpremultiplied RGBA8，长度必须 >= w*h*4。
#[napi]
pub fn canvas_put_image_data(
    id: f64,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    data: Buffer,
) -> Result<(), String> {
    let (x, y, w, h) = checked_rect(x, y, w, h)?;
    let need = w as usize * h as usize * 4;
    if data.len() < need {
        return Err(canvas_error(format!(
            "putImageData buffer too small: {} < {need}",
            data.len()
        )));
    }
    with_surface(id, |ctx| ctx.put_image_data(x, y, w, h, &data))
}

/// `drawImage(sourceCanvas, ...)`：source 是另一块 surface（离屏或已挂载）。
/// 先 commit 源并快照像素——自绘（dst == src）因此安全。返回 false 表示
/// 规范 no-op（退化/全出界），JS 侧据此不 bump rev。
#[napi]
#[allow(clippy::too_many_arguments)]
pub fn canvas_draw_image(
    dst: f64,
    src: f64,
    sx: f64,
    sy: f64,
    sw: f64,
    sh: f64,
    dx: f64,
    dy: f64,
    dw: f64,
    dh: f64,
) -> Result<bool, String> {
    let (img_w, img_h, pixels) = with_surface(src, |ctx| {
        let (w, h) = ctx.size();
        (w, h, ctx.premul_bytes().to_vec())
    })?;
    with_surface(dst, |ctx| {
        ctx.draw_image(
            &pixels,
            u32::from(img_w),
            u32::from(img_h),
            sx,
            sy,
            sw,
            sh,
            dx,
            dy,
            dw,
            dh,
        )
    })
}

/// `toDataURL('image/png')`：全 bitmap → PNG 字节（unpremul RGBA8）。
#[napi]
pub fn canvas_encode_png(id: f64) -> Result<Buffer, String> {
    with_surface(id, |ctx| {
        ctx.encode_png()
            .map(Buffer::from)
            .map_err(|e| canvas_error(format!("png encode failed: {e}")))
    })?
}

// ── `<canvas>` custom element ───────────────────────────────────────

pub struct CanvasElementFactory;

impl CustomElementFactory for CanvasElementFactory {
    fn element_type(&self) -> &str {
        "canvas"
    }

    fn create(&self, _id: u64) -> Box<dyn CustomElement> {
        Box::new(CanvasElement::default())
    }
}

/// 已上屏帧缓存：rev 未变时复用同一 Arc<RenderImage>，避免每帧上传
/// ~4MB 纹理；替换旧图时 drop_image 释放 atlas tile（不换则泄漏）。
#[derive(Default)]
struct PaintedFrame {
    rev: u64,
    image: Option<Arc<RenderImage>>,
    /// 上传帧的 backing 尺寸（image_bounds 用）。
    size: (u16, u16),
}

#[derive(Default)]
struct CanvasElement {
    surface: Option<u64>,
    frame: Rc<RefCell<PaintedFrame>>,
}

impl CustomElement for CanvasElement {
    fn render(
        &mut self,
        ctx: CustomRenderContext,
        _window: &mut Window,
        _cx: &mut gpui::Context<gpuix_native::GpuixView>,
    ) -> gpui::AnyElement {
        let surface = self.surface;
        let frame = self.frame.clone();
        // `<canvas>` 是 replaced leaf：盒模型尺寸由自己应用（gpuix-native 的
        // apply_interactive_styles 是 crate 私有；这里只取 replaced element
        // 需要的子集——尺寸/min-max/flex 伸缩）。gpui 的 canvas 元素自身实现
        // Styled，默认 size_full 填满父级，显式 width/height 覆盖。
        let mut el = canvas(
            |_, _, _| (),
            move |bounds, _, window, _cx| paint_canvas(surface, bounds, &frame, window),
        )
        .size_full();
        if let Some(style) = ctx.style {
            el = apply_box_style(el, style);
        }
        el.into_any_element()
    }

    fn set_prop(&mut self, key: &str, value: Value) {
        if key == "surface" {
            self.surface = value.as_f64().map(|v| v as u64);
            // 换 surface：帧缓存对应的是旧 surface 的 rev，直接清。
            *self.frame.borrow_mut() = PaintedFrame::default();
        }
    }

    fn supported_props(&self) -> &'static [&'static str] {
        // `rev` 无实际含义：JS wrapper 改变它来触发 React 重渲染，
        // 进而让 paint 阶段看到新像素。
        &["surface", "rev"]
    }

    fn supported_events(&self) -> &'static [&'static str] {
        &[]
    }

    fn destroy(&mut self) {
        self.frame.borrow_mut().image = None;
    }
}

/// 应用 StyleDesc 的盒模型子集（映射与 renderer.rs apply_width/apply_height
/// 一致；那边是 pub(crate)，自定义元素只能自己动手）。
fn apply_box_style<E: gpui::Styled>(mut el: E, style: &gpuix_native::style::StyleDesc) -> E {
    use gpuix_native::style::DimensionValue as D;
    macro_rules! dim {
        ($field:ident, $setter:ident, $full:ident) => {
            if let Some(d) = &style.$field {
                el = match d {
                    D::Pixels(v) => el.$setter(px(*v as f32)),
                    D::Percentage(v) if *v >= 0.999 => el.$full(),
                    D::Percentage(v) => el.$setter(gpui::relative(*v as f32)),
                    D::Auto => el,
                };
            }
        };
        // min/max：无 "≈full" 特例
        (@mm $field:ident, $setter:ident) => {
            if let Some(d) = &style.$field {
                el = match d {
                    D::Pixels(v) => el.$setter(px(*v as f32)),
                    D::Percentage(v) => el.$setter(gpui::relative(*v as f32)),
                    D::Auto => el,
                };
            }
        };
    }
    dim!(width, w, w_full);
    dim!(height, h, h_full);
    dim!(@mm min_width, min_w);
    dim!(@mm min_height, min_h);
    dim!(@mm max_width, max_w);
    dim!(@mm max_height, max_h);
    if let Some(g) = style.flex_grow {
        el = el.flex_grow(g as f32);
    }
    if let Some(s) = style.flex_shrink {
        el = el.flex_shrink(s as f32);
    }
    el
}

fn paint_canvas(
    surface: Option<u64>,
    bounds: Bounds<Pixels>,
    frame: &Rc<RefCell<PaintedFrame>>,
    window: &mut Window,
) {
    let Some(id) = surface else { return };
    let Some((image, w, h)) = current_frame(id, frame, window) else {
        return;
    };
    let image_bounds = Bounds::new(
        point(px(0.0), px(0.0)),
        size(px(f32::from(w)), px(f32::from(h))),
    );
    if let Err(error) =
        window.paint_image(bounds, image_bounds, Corners::all(px(0.0)), image, 0, false)
    {
        eprintln!("[canvas] paint_image failed: {error:#}");
    }
}

/// rev 变了才 commit + RGBA→BGRA + 新建 RenderImage；旧 tile drop_image。
/// 持锁内做 commit/swizzle（纳秒级 memcpy，4MB 帧约 1ms）。
fn current_frame(
    id: u64,
    frame: &Rc<RefCell<PaintedFrame>>,
    window: &mut Window,
) -> Option<(Arc<RenderImage>, u16, u16)> {
    let Ok(mut registry) = surfaces().lock() else {
        return None;
    };
    let ctx = registry.get_mut(&id)?;
    let mut painted = frame.borrow_mut();
    if painted.image.is_none() || painted.rev != ctx.revision() {
        let (w, h) = ctx.size();
        let rgba = ctx.premul_bytes();
        let mut bgra = Vec::with_capacity(rgba.len());
        for pixel in rgba.chunks_exact(4) {
            bgra.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }
        let buffer = image::RgbaImage::from_raw(u32::from(w), u32::from(h), bgra)?;
        let image = Arc::new(RenderImage::new(vec![image::Frame::new(buffer)]));
        if let Some(old) = painted.image.replace(image.clone()) {
            if let Err(error) = window.drop_image(old) {
                eprintln!("[canvas] drop_image failed: {error:#}");
            }
        }
        painted.rev = ctx.revision();
        painted.size = (w, h);
    }
    let result = painted
        .image
        .clone()
        .map(|i| (i, painted.size.0, painted.size.1));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use vello_cpu::peniko::Fill;

    fn ctx(w: u16, h: u16) -> SurfaceCtx {
        Ctx2d::new(VelloBackend::new(w, h))
    }

    fn pixel(ctx: &mut SurfaceCtx, x: i32, y: i32) -> [u8; 4] {
        let data = ctx.image_data(x, y, 1, 1);
        [data[0], data[1], data[2], data[3]]
    }

    fn solid(css: &str) -> state::PaintSpec {
        parse_paint(css).expect("test color must parse")
    }

    #[test]
    fn fill_rect_writes_expected_pixels() {
        let mut c = ctx(32, 32);
        c.set_fill_style(solid("#ff0000"));
        c.fill_rect(4.0, 4.0, 8.0, 8.0);
        assert_eq!(pixel(&mut c, 8, 8), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut c, 0, 0), [0, 0, 0, 0]);
        assert_eq!(pixel(&mut c, 12, 8), [0, 0, 0, 0]);
    }

    #[test]
    fn clear_rect_clears_to_transparent() {
        let mut c = ctx(32, 32);
        c.set_fill_style(solid("red"));
        c.fill_rect(0.0, 0.0, 32.0, 32.0);
        c.clear_rect(4.0, 4.0, 8.0, 8.0);
        assert_eq!(pixel(&mut c, 8, 8), [0, 0, 0, 0]);
        assert_eq!(pixel(&mut c, 2, 2), [255, 0, 0, 255]);
    }

    #[test]
    fn committed_scene_composites_over_existing_bitmap() {
        // commit 之后再次绘制必须叠加而不是清空——验证 SrcOver 提交路径。
        let mut c = ctx(32, 32);
        c.set_fill_style(solid("#ff0000"));
        c.fill_rect(0.0, 0.0, 10.0, 10.0);
        assert_eq!(pixel(&mut c, 5, 5), [255, 0, 0, 255]); // 触发 commit
        c.set_fill_style(solid("#00ff00"));
        c.fill_rect(20.0, 20.0, 10.0, 10.0);
        assert_eq!(pixel(&mut c, 5, 5), [255, 0, 0, 255]); // 旧内容仍在
        assert_eq!(pixel(&mut c, 25, 25), [0, 255, 0, 255]);
    }

    #[test]
    fn global_alpha_roundtrips_through_unpremultiply() {
        let mut c = ctx(16, 16);
        c.set_fill_style(solid("#ff0000"));
        c.set_global_alpha(0.5);
        c.fill_rect(0.0, 0.0, 16.0, 16.0);
        let p = pixel(&mut c, 8, 8);
        assert!((p[3] as i32 - 128).abs() <= 1, "alpha {}", p[3]);
        assert!(p[0] > 240, "r {}", p[0]);
        assert!(p[1] <= 1 && p[2] <= 1);
    }

    #[test]
    fn source_over_blends() {
        let mut c = ctx(16, 16);
        c.set_fill_style(solid("#ff0000"));
        c.fill_rect(0.0, 0.0, 16.0, 16.0);
        c.set_fill_style(solid("#0000ff"));
        c.set_global_alpha(0.5);
        c.fill_rect(0.0, 0.0, 16.0, 16.0);
        let p = pixel(&mut c, 8, 8);
        assert_eq!(p[3], 255);
        assert!((p[0] as i32 - 127).abs() <= 3, "r {}", p[0]);
        assert!((p[2] as i32 - 128).abs() <= 3, "b {}", p[2]);
    }

    #[test]
    fn copy_composite_replaces_destination() {
        let mut c = ctx(16, 16);
        c.set_fill_style(solid("#ff0000"));
        c.fill_rect(0.0, 0.0, 16.0, 16.0);
        c.set_composite(CompositeOp::Copy);
        c.set_fill_style(solid("#0000ff"));
        c.set_global_alpha(0.5);
        c.fill_rect(4.0, 4.0, 8.0, 8.0);
        let p = pixel(&mut c, 8, 8);
        assert_eq!(p[0], 0);
        assert!((p[2] as i32 - 255).abs() <= 1, "b {}", p[2]);
        assert!((p[3] as i32 - 128).abs() <= 2, "a {}", p[3]);
        assert_eq!(pixel(&mut c, 0, 0), [255, 0, 0, 255]);
    }

    #[test]
    fn transform_scales_fill_rect() {
        let mut c = ctx(64, 64);
        c.set_transform(Affine::scale(2.0));
        c.set_fill_style(solid("#ff0000"));
        c.fill_rect(2.0, 2.0, 8.0, 8.0); // 设备空间 4..20
        assert_eq!(pixel(&mut c, 10, 10), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut c, 30, 30), [0, 0, 0, 0]);
    }

    #[test]
    fn clip_limits_fill() {
        let mut c = ctx(32, 32);
        c.begin_path();
        c.rect(0.0, 0.0, 10.0, 10.0);
        c.clip(Fill::NonZero);
        c.set_fill_style(solid("#ff0000"));
        c.fill_rect(0.0, 0.0, 32.0, 32.0);
        assert_eq!(pixel(&mut c, 5, 5), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut c, 20, 20), [0, 0, 0, 0]);
    }

    #[test]
    fn clip_persists_across_commits() {
        // canonical clip 栈重放回归测试：commit 后 ctx.reset() 清掉录制 clip，
        // 下一次绘制必须仍然被裁。
        let mut c = ctx(32, 32);
        c.begin_path();
        c.rect(0.0, 0.0, 10.0, 10.0);
        c.clip(Fill::NonZero);
        c.set_fill_style(solid("#ff0000"));
        c.fill_rect(0.0, 0.0, 32.0, 32.0);
        assert_eq!(pixel(&mut c, 20, 20), [0, 0, 0, 0]); // 触发 commit
        c.set_fill_style(solid("#00ff00"));
        c.fill_rect(0.0, 0.0, 32.0, 32.0);
        assert_eq!(pixel(&mut c, 20, 20), [0, 0, 0, 0], "clip 在 commit 后丢失");
        assert_eq!(pixel(&mut c, 5, 5), [0, 255, 0, 255]);
    }

    #[test]
    fn save_restore_restores_clip_and_style() {
        let mut c = ctx(32, 32);
        c.save();
        c.begin_path();
        c.rect(0.0, 0.0, 10.0, 10.0);
        c.clip(Fill::NonZero);
        c.set_fill_style(solid("#ff0000"));
        c.fill_rect(0.0, 0.0, 32.0, 32.0);
        c.restore();
        c.set_fill_style(solid("#00ff00"));
        c.fill_rect(20.0, 20.0, 10.0, 10.0);
        assert_eq!(pixel(&mut c, 5, 5), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut c, 25, 25), [0, 255, 0, 255]);
    }

    #[test]
    fn path_fill_triangle() {
        let mut c = ctx(32, 32);
        c.begin_path();
        c.move_to(16.0, 4.0);
        c.line_to(28.0, 28.0);
        c.line_to(4.0, 28.0);
        c.close_path();
        c.set_fill_style(solid("#ff0000"));
        c.fill(Fill::NonZero);
        assert_eq!(pixel(&mut c, 16, 24), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut c, 4, 4), [0, 0, 0, 0]);
    }

    #[test]
    fn stroke_rect_paints_edges() {
        let mut c = ctx(32, 32);
        c.set_stroke_style(solid("#ff0000"));
        c.set_line_width(2.0);
        c.stroke_rect(4.0, 4.0, 16.0, 16.0);
        assert_eq!(pixel(&mut c, 4, 12), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut c, 12, 12), [0, 0, 0, 0]);
    }

    #[test]
    fn arc_fills_circle() {
        let mut c = ctx(64, 64);
        c.begin_path();
        c.arc(32.0, 32.0, 16.0, 0.0, std::f64::consts::TAU, false);
        c.set_fill_style(solid("#ff0000"));
        c.fill(Fill::NonZero);
        assert_eq!(pixel(&mut c, 32, 32), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut c, 4, 4), [0, 0, 0, 0]);
    }

    #[test]
    fn image_data_out_of_bounds_is_transparent() {
        let mut c = ctx(16, 16);
        c.set_fill_style(solid("#ff0000"));
        c.fill_rect(0.0, 0.0, 16.0, 16.0);
        let data = c.image_data(-8, -8, 16, 16);
        assert_eq!(&data[0..4], &[0, 0, 0, 0]); // 负区
        let inside = (15 * 16 + 15) * 4; // (7,7) 落在 (15,15) 处? 见下
        let _ = inside;
        // (x=-8+15, y=-8+15) = (7,7) 在 canvas 内
        let di = (15 * 16 + 15) * 4;
        assert_eq!(&data[di..di + 4], &[255, 0, 0, 255]);
    }

    #[test]
    fn put_image_data_roundtrips() {
        let mut c = ctx(16, 16);
        let mut data = vec![0u8; 4 * 4 * 4];
        data[0..4].copy_from_slice(&[255, 0, 0, 128]);
        c.put_image_data(4, 4, 4, 4, &data);
        let p = pixel(&mut c, 4, 4);
        assert!(p[0] > 240 && p[3] == 128, "{p:?}");
        // putImageData 绕过 composite/clip（规范：直接写像素）。
        let back = c.image_data(4, 4, 1, 1);
        assert_eq!(back[3], 128);
    }

    #[test]
    fn resize_clears_bitmap_and_state() {
        let mut c = ctx(16, 16);
        c.set_fill_style(solid("#ff0000"));
        c.fill_rect(0.0, 0.0, 16.0, 16.0);
        c.resize(32, 32);
        assert_eq!(c.size(), (32, 32));
        assert_eq!(pixel(&mut c, 8, 8), [0, 0, 0, 0]);
        // 状态重置：fillStyle 回默认黑。
        c.fill_rect(0.0, 0.0, 4.0, 4.0);
        assert_eq!(pixel(&mut c, 2, 2), [0, 0, 0, 255]);
    }

    #[test]
    fn measure_text_returns_positive_width() {
        let mut c = ctx(64, 64);
        c.set_font(FontSpec {
            family: "sans-serif".into(),
            size: 20.0,
            weight: 400,
            italic: false,
        });
        let m = c.measure_text("hello");
        assert!(m.width > 10.0, "width {}", m.width);
        assert!(m.ascent > 5.0);
    }

    #[test]
    fn fill_text_marks_pixels() {
        let mut c = ctx(128, 64);
        c.set_fill_style(solid("#ff0000"));
        c.set_font(FontSpec {
            family: "sans-serif".into(),
            size: 32.0,
            weight: 400,
            italic: false,
        });
        c.fill_text("Hi", 8.0, 40.0);
        // 文本覆盖区内应存在非零像素；整面全黑或全空都算失败。
        let data = c.image_data(0, 0, 128, 64);
        let nonzero = data.chunks_exact(4).filter(|p| p[3] > 0).count();
        assert!(nonzero > 50, "nonzero {nonzero}");
    }

    // ── C7：gradient / pattern / drawImage / toDataURL ──────────────

    fn gradient(value: serde_json::Value) -> state::PaintSpec {
        state::parse_paint_value(&value).expect("gradient spec must parse")
    }

    #[test]
    fn linear_gradient_interpolates() {
        let mut c = ctx(64, 16);
        c.set_fill_style(gradient(serde_json::json!({
            "kind": "linear", "x0": 0.0, "y0": 0.0, "x1": 64.0, "y1": 0.0,
            "stops": [
                {"offset": 0.0, "color": "#000000"},
                {"offset": 1.0, "color": "#ffffff"},
            ],
        })));
        c.fill_rect(0.0, 0.0, 64.0, 16.0);
        let left = pixel(&mut c, 1, 8);
        let mid = pixel(&mut c, 32, 8);
        let right = pixel(&mut c, 62, 8);
        assert!(left[0] < 16, "left {left:?}");
        assert!(mid[0] > 100 && mid[0] < 160, "mid {mid:?}");
        assert!(right[0] > 239, "right {right:?}");
        assert_eq!(left[3], 255);
    }

    #[test]
    fn gradient_stops_are_sorted_and_honor_alpha() {
        // 乱序 stops + globalAlpha 乘进 stop alpha。
        let mut c = ctx(16, 16);
        c.set_global_alpha(0.5);
        c.set_fill_style(gradient(serde_json::json!({
            "kind": "linear", "x0": 0.0, "y0": 0.0, "x1": 16.0, "y1": 0.0,
            "stops": [
                {"offset": 1.0, "color": "rgba(255,0,0,1)"},
                {"offset": 0.0, "color": "rgba(255,0,0,1)"},
            ],
        })));
        c.fill_rect(0.0, 0.0, 16.0, 16.0);
        let p = pixel(&mut c, 8, 8);
        assert!((p[3] as i32 - 128).abs() <= 2, "alpha {}", p[3]);
        assert!(p[0] > 200);
    }

    #[test]
    fn degenerate_gradient_paints_nothing() {
        let mut c = ctx(16, 16);
        // 规范：线性起止点相同 → paint nothing（vello 原生会退回首 stop 色，
        // 这里拦成 transparent）。
        c.set_fill_style(gradient(serde_json::json!({
            "kind": "linear", "x0": 8.0, "y0": 8.0, "x1": 8.0, "y1": 8.0,
            "stops": [{"offset": 0.0, "color": "#ff0000"}],
        })));
        c.fill_rect(0.0, 0.0, 16.0, 16.0);
        assert_eq!(pixel(&mut c, 8, 8), [0, 0, 0, 0]);
        // 零 stop 同样 paint nothing。
        c.set_fill_style(gradient(serde_json::json!({
            "kind": "linear", "x0": 0.0, "y0": 0.0, "x1": 16.0, "y1": 0.0,
            "stops": [],
        })));
        c.fill_rect(0.0, 0.0, 16.0, 16.0);
        assert_eq!(pixel(&mut c, 8, 8), [0, 0, 0, 0]);
    }

    #[test]
    fn radial_gradient_two_circle() {
        let mut c = ctx(64, 64);
        c.set_fill_style(gradient(serde_json::json!({
            "kind": "radial",
            "x0": 32.0, "y0": 32.0, "r0": 0.0,
            "x1": 32.0, "y1": 32.0, "r1": 24.0,
            "stops": [
                {"offset": 0.0, "color": "#ff0000"},
                {"offset": 1.0, "color": "#0000ff"},
            ],
        })));
        c.fill_rect(0.0, 0.0, 64.0, 64.0);
        let center = pixel(&mut c, 32, 32);
        let edge = pixel(&mut c, 55, 32); // r≈23 → 近末端，偏蓝
        let outside = pixel(&mut c, 63, 63); // r>24 → Pad 边界色
        assert!(center[0] > 200 && center[2] < 60, "center {center:?}");
        assert!(edge[2] > 150 && edge[0] < 120, "edge {edge:?}");
        assert!(outside[2] > 200 && outside[0] < 60, "outside {outside:?}");
    }

    #[test]
    fn conic_gradient_sweeps_full_circle() {
        let mut c = ctx(64, 64);
        c.set_fill_style(gradient(serde_json::json!({
            "kind": "conic", "angle": 0.0, "x": 32.0, "y": 32.0,
            "stops": [
                {"offset": 0.0, "color": "#ff0000"},
                {"offset": 0.5, "color": "#00ff00"},
                {"offset": 1.0, "color": "#ff0000"},
            ],
        })));
        c.fill_rect(0.0, 0.0, 64.0, 64.0);
        let east = pixel(&mut c, 56, 32); // angle 0 → 红
        let west = pixel(&mut c, 8, 32); // angle π → offset 0.5 → 绿
        let south = pixel(&mut c, 32, 56); // π/2 → offset 0.25 → 红绿中点
        assert!(east[0] > 180 && east[1] < 90, "east {east:?}");
        assert!(west[1] > 180 && west[0] < 120, "west {west:?}");
        assert!(
            (south[0] as i32 - south[1] as i32).abs() < 40,
            "south {south:?}"
        );
    }

    /// 4×4 premul 源位图：左上红 右上绿 左下蓝 右下白（2×2 块各 2px）。
    fn checker_pixels() -> (Vec<u8>, u32, u32) {
        let mut out = vec![0u8; 4 * 4 * 4];
        for y in 0..4 {
            for x in 0..4 {
                let c = match (x < 2, y < 2) {
                    (true, true) => [255, 0, 0, 255],
                    (false, true) => [0, 255, 0, 255],
                    (true, false) => [0, 0, 255, 255],
                    (false, false) => [255, 255, 255, 255],
                };
                out[(y * 4 + x) * 4..(y * 4 + x) * 4 + 4].copy_from_slice(&c);
            }
        }
        (out, 4, 4)
    }

    #[test]
    fn draw_image_blits_at_offset() {
        let (px, w, h) = checker_pixels();
        let mut c = ctx(32, 32);
        assert!(c.draw_image(&px, w, h, 0.0, 0.0, 4.0, 4.0, 8.0, 8.0, 4.0, 4.0));
        assert_eq!(pixel(&mut c, 9, 9), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut c, 11, 9), [0, 255, 0, 255]);
        assert_eq!(pixel(&mut c, 4, 4), [0, 0, 0, 0]);
    }

    #[test]
    fn draw_image_scales_to_dest() {
        let (px, w, h) = checker_pixels();
        let mut c = ctx(32, 32);
        // 4×4 → 16×16：每源像素扩成 4×4 块（smoothing 关→最近邻，块状精确）。
        c.set_image_smoothing(false);
        assert!(c.draw_image(&px, w, h, 0.0, 0.0, 4.0, 4.0, 0.0, 0.0, 16.0, 16.0));
        assert_eq!(pixel(&mut c, 2, 2), [255, 0, 0, 255]); // 源 (0,0)
        assert_eq!(pixel(&mut c, 10, 2), [0, 255, 0, 255]); // 源 (2,0)
        assert_eq!(pixel(&mut c, 2, 10), [0, 0, 255, 255]); // 源 (0,2)
        assert_eq!(pixel(&mut c, 14, 14), [255, 255, 255, 255]); // 源 (3,3)
    }

    #[test]
    fn draw_image_source_rect_and_clip() {
        let (px, w, h) = checker_pixels();
        let mut c = ctx(32, 32);
        c.set_image_smoothing(false);
        // 只取右上绿色 2×2 → 铺到 8×8。
        assert!(c.draw_image(&px, w, h, 2.0, 0.0, 2.0, 2.0, 4.0, 4.0, 8.0, 8.0));
        assert_eq!(pixel(&mut c, 6, 6), [0, 255, 0, 255]);
        assert_eq!(pixel(&mut c, 4, 4), [0, 255, 0, 255]); // dst 左上角（含边界）
        assert_eq!(pixel(&mut c, 3, 3), [0, 0, 0, 0]); // dst 边界外
        assert_eq!(pixel(&mut c, 12, 12), [0, 0, 0, 0]); // dst 右下外
    }

    #[test]
    fn draw_image_src_clipped_to_bounds() {
        let (px, w, h) = checker_pixels();
        let mut c = ctx(32, 32);
        c.set_image_smoothing(false);
        // 源矩形左半出界：sx=-2, sw=4 → 可见 (0..2)×4，dst 相应收缩到右半 [8,16]。
        assert!(c.draw_image(&px, w, h, -2.0, 0.0, 4.0, 4.0, 0.0, 0.0, 16.0, 16.0));
        // 可见的是源 (0..2)×(0..4) = 左半：红上蓝下，落在 dst [8,16]
        assert_eq!(pixel(&mut c, 10, 2), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut c, 10, 14), [0, 0, 255, 255]);
        assert_eq!(pixel(&mut c, 4, 2), [0, 0, 0, 0]); // 出界部分 dst 不画
    }

    #[test]
    fn draw_image_negative_dest_mirrors() {
        let (px, w, h) = checker_pixels();
        let mut c = ctx(32, 32);
        c.set_image_smoothing(false);
        // 负 dw：镜像——源左半红画到右半
        assert!(c.draw_image(&px, w, h, 0.0, 0.0, 4.0, 4.0, 16.0, 0.0, -16.0, 16.0));
        assert_eq!(pixel(&mut c, 14, 2), [255, 0, 0, 255]); // 源 (0,0) 在右端
        assert_eq!(pixel(&mut c, 2, 2), [0, 255, 0, 255]); // 源 (3,0) 在左端
        assert_eq!(pixel(&mut c, 2, 14), [255, 255, 255, 255]); // 源 (3,3) 白
    }

    #[test]
    fn draw_image_alpha_and_composite() {
        let (px, w, h) = checker_pixels();
        let mut c = ctx(16, 16);
        c.set_fill_style(solid("#000000"));
        c.fill_rect(0.0, 0.0, 16.0, 16.0);
        c.set_global_alpha(0.5);
        assert!(c.draw_image(&px, w, h, 0.0, 0.0, 4.0, 4.0, 0.0, 0.0, 16.0, 16.0));
        let p = pixel(&mut c, 1, 1); // 红 50% over 黑
        assert!((p[0] as i32 - 128).abs() <= 3, "r {}", p[0]);
        assert_eq!(p[3], 255);
    }

    #[test]
    fn draw_image_respects_transform_and_clip() {
        let (px, w, h) = checker_pixels();
        let mut c = ctx(32, 32);
        c.set_image_smoothing(false);
        c.set_transform(Affine::translate((8.0, 0.0)));
        assert!(c.draw_image(&px, w, h, 0.0, 0.0, 4.0, 4.0, 0.0, 0.0, 8.0, 8.0));
        assert_eq!(pixel(&mut c, 9, 1), [255, 0, 0, 255]); // dst x=1 → 设备 9
        assert_eq!(pixel(&mut c, 1, 1), [0, 0, 0, 0]);
    }

    #[test]
    fn draw_image_noop_cases() {
        let (px, w, h) = checker_pixels();
        let mut c = ctx(16, 16);
        // 零尺寸源/目标、完全出界、非有限 → 全 no-op，rev 不涨
        let rev = c.revision();
        assert!(!c.draw_image(&px, w, h, 0.0, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 4.0));
        assert!(!c.draw_image(&px, w, h, 0.0, 0.0, 4.0, 4.0, 0.0, 0.0, 0.0, 4.0));
        assert!(!c.draw_image(&px, w, h, 8.0, 8.0, 4.0, 4.0, 0.0, 0.0, 4.0, 4.0));
        assert!(!c.draw_image(&px, w, h, 0.0, f64::NAN, 4.0, 4.0, 0.0, 0.0, 4.0, 4.0));
        assert_eq!(c.revision(), rev);
    }

    fn pattern(pixels: Vec<u8>, w: u32, h: u32, rep: &str) -> state::PaintSpec {
        state::PaintSpec::pattern(pixels, w, h, state::Repetition::parse(rep).unwrap())
    }

    #[test]
    fn pattern_repeat_tiles() {
        // 2×2 源：红绿/蓝白，repeat 平铺到 8×8。
        let px = vec![
            255, 0, 0, 255, 0, 255, 0, 255, // 行0
            0, 0, 255, 255, 255, 255, 255, 255, // 行1
        ];
        let mut c = ctx(16, 16);
        c.set_fill_style(pattern(px, 2, 2, "repeat"));
        c.fill_rect(0.0, 0.0, 8.0, 8.0);
        assert_eq!(pixel(&mut c, 0, 0), [255, 0, 0, 255]);
        assert_eq!(pixel(&mut c, 3, 0), [0, 255, 0, 255]); // (3,0) → tile (1,0) 绿
        assert_eq!(pixel(&mut c, 6, 5), [0, 0, 255, 255]); // (6,5) → tile (0,1) 蓝
        assert_eq!(pixel(&mut c, 7, 7), [255, 255, 255, 255]); // tile (3,3)→(1,1)
    }

    #[test]
    fn pattern_repeat_x_clips_vertically() {
        let px = vec![
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let mut c = ctx(16, 16);
        c.set_fill_style(pattern(px, 2, 2, "repeat-x"));
        c.fill_rect(0.0, 0.0, 8.0, 8.0);
        assert_eq!(pixel(&mut c, 5, 0), [0, 255, 0, 255]); // 条带内平铺
        assert_eq!(pixel(&mut c, 5, 5), [0, 0, 0, 0]); // 条带外透明（非 Pad 拖影）
    }

    #[test]
    fn pattern_no_repeat_paints_once() {
        let px = vec![
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let mut c = ctx(16, 16);
        c.set_fill_style(pattern(px, 2, 2, "no-repeat"));
        c.fill_rect(0.0, 0.0, 16.0, 16.0);
        assert_eq!(pixel(&mut c, 1, 1), [255, 255, 255, 255]);
        assert_eq!(pixel(&mut c, 3, 1), [0, 0, 0, 0]); // 右侧不延伸
        assert_eq!(pixel(&mut c, 1, 3), [0, 0, 0, 0]); // 下方不延伸
    }

    #[test]
    fn encode_png_roundtrips_pixels() {
        let mut c = ctx(8, 4);
        c.set_fill_style(solid("#3366cc"));
        c.fill_rect(0.0, 0.0, 8.0, 4.0);
        let png = c.encode_png().expect("png encode");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let img = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(img.dimensions(), (8, 4));
        assert_eq!(img.get_pixel(4, 2).0, [0x33, 0x66, 0xcc, 0xff]);
    }
}
