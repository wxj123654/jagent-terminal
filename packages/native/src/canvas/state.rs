//! Canvas 2D 绘制状态机：WHATWG "drawing state" + "current default path"
//! 的最小忠实子集。
//!
//! 状态本身与具体光栅后端无关；每个绘制调用先把当前 transform/clip 栈
//! 同步给 backend，再提交绘制 op。backend 内部如何记录/光栅化（vello 的
//! RenderContext 录制式 vs tiny-skia 的 Paint+Pixmap 直绘式）由 trait 隔离。

use image::ImageEncoder;
use serde_json::Value;
use vello_cpu::color::{AlphaColor, ColorSpaceTag, Srgb, parse_color};
use vello_cpu::kurbo::{
    Affine, Arc, BezPath, Point, Rect, RoundedRect, RoundedRectRadii, Shape, Vec2,
};
use vello_cpu::peniko::{
    Blob, ColorStop, ColorStops, Extend, Fill, Gradient, ImageAlphaType, ImageData, ImageFormat,
    InterpolationAlphaSpace,
};

use crate::canvas::backend::Backend;
use crate::canvas::text;

/// 填充/描边样式。solid / gradient（peniko 原生三种）/ pattern（位图平铺）。
/// JS 侧 `fillStyle`/`strokeStyle` 的三种可赋值形态一一对应。
#[derive(Clone, Debug, PartialEq)]
pub enum PaintSpec {
    Solid(AlphaColor<Srgb>),
    /// peniko Gradient：kind 携带 Linear/Radial(双圆)/Sweep 位置参数；
    /// stops 已按 offset 升序。canvas 语义：用户空间坐标、Pad 边界、
    /// unpremultiplied alpha 插值（peniko 默认 Premultiplied，构造时改写）。
    Gradient(Gradient),
    /// createPattern 快照：`image` 为 unpremultiplied RGBA8（ImageData 语义），
    /// backend 在 paint 时转 premul Pixmap。
    Pattern(PatternSpec),
}

/// canvas `createPattern` 的 repetition 取值。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Repetition {
    Repeat,
    RepeatX,
    RepeatY,
    NoRepeat,
}

impl Repetition {
    /// 规范：`''` 与非法值在 JS 侧已归一/拒绝；到这里只接受四值。
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "repeat" => Self::Repeat,
            "repeat-x" => Self::RepeatX,
            "repeat-y" => Self::RepeatY,
            "no-repeat" => Self::NoRepeat,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PatternSpec {
    pub image: ImageData,
    pub repetition: Repetition,
}

impl PaintSpec {
    pub fn transparent() -> Self {
        Self::Solid(AlphaColor::TRANSPARENT)
    }

    /// `createPattern` 快照：pixels 为 unpremultiplied RGBA8（与 getImageData
    /// 同一约定），跨 napi 边界即此形态。
    pub fn pattern(pixels: Vec<u8>, width: u32, height: u32, repetition: Repetition) -> Self {
        Self::Pattern(PatternSpec {
            image: ImageData {
                data: Blob::new(std::sync::Arc::new(pixels)),
                format: ImageFormat::Rgba8,
                alpha_type: ImageAlphaType::Alpha,
                width,
                height,
            },
            repetition,
        })
    }
}

impl Default for PaintSpec {
    fn default() -> Self {
        Self::Solid(AlphaColor::BLACK)
    }
}

/// canvas `globalCompositeOperation` 全集（WHATWG 列表）+ 内部 Clear
/// （clearRect 实现用，不由 JS 设置）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CompositeOp {
    #[default]
    SourceOver,
    SourceIn,
    SourceOut,
    SourceAtop,
    DestinationOver,
    DestinationIn,
    DestinationOut,
    DestinationAtop,
    Lighter,
    Copy,
    Xor,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
    /// 仅 clear_rect 内部使用；不在 canvas composite 名字表中。
    Clear,
}

impl CompositeOp {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "source-over" => Self::SourceOver,
            "source-in" => Self::SourceIn,
            "source-out" => Self::SourceOut,
            "source-atop" => Self::SourceAtop,
            "destination-over" => Self::DestinationOver,
            "destination-in" => Self::DestinationIn,
            "destination-out" => Self::DestinationOut,
            "destination-atop" => Self::DestinationAtop,
            "lighter" => Self::Lighter,
            "copy" => Self::Copy,
            "xor" => Self::Xor,
            "multiply" => Self::Multiply,
            "screen" => Self::Screen,
            "overlay" => Self::Overlay,
            "darken" => Self::Darken,
            "lighten" => Self::Lighten,
            "color-dodge" => Self::ColorDodge,
            "color-burn" => Self::ColorBurn,
            "hard-light" => Self::HardLight,
            "soft-light" => Self::SoftLight,
            "difference" => Self::Difference,
            "exclusion" => Self::Exclusion,
            "hue" => Self::Hue,
            "saturation" => Self::Saturation,
            "color" => Self::Color,
            "luminosity" => Self::Luminosity,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LineCap {
    #[default]
    Butt,
    Round,
    Square,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LineJoin {
    Round,
    Bevel,
    #[default]
    Miter,
}

#[derive(Clone, Debug)]
pub struct StrokeSpec {
    pub width: f64,
    pub cap: LineCap,
    pub join: LineJoin,
    pub miter_limit: f64,
    /// canvas 语义：奇数长度列表在赋值时翻倍为偶数。
    pub dashes: Vec<f64>,
    pub dash_offset: f64,
}

impl Default for StrokeSpec {
    fn default() -> Self {
        Self {
            width: 1.0,
            cap: LineCap::Butt,
            join: LineJoin::Miter,
            miter_limit: 10.0,
            dashes: Vec::new(),
            dash_offset: 0.0,
        }
    }
}

/// 结构化字体规格。canvas 的 `font` 属性是 CSS font shorthand 字符串，
/// 由 JS 侧解析成结构化字段传进来（先不做 Rust 侧 shorthand 解析）。
#[derive(Clone, Debug, PartialEq)]
pub struct FontSpec {
    pub family: String,
    /// CSS px。
    pub size: f32,
    pub weight: u16,
    pub italic: bool,
}

impl Default for FontSpec {
    fn default() -> Self {
        Self {
            family: "sans-serif".to_string(),
            size: 10.0,
            weight: 400,
            italic: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TextAlign {
    #[default]
    Start,
    End,
    Left,
    Right,
    Center,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TextBaseline {
    Top,
    Hanging,
    Middle,
    #[default]
    Alphabetic,
    Ideographic,
    Bottom,
}

/// clip() 时刻已把 CTM 并入路径，canonical 栈存设备空间路径；
/// backend 重推 clip 时用 identity transform。
#[derive(Clone)]
pub struct Clip {
    pub path: BezPath,
    pub rule: Fill,
}

#[derive(Clone)]
pub struct DrawState {
    pub transform: Affine,
    pub clips: Vec<Clip>,
    pub fill: PaintSpec,
    pub stroke_paint: PaintSpec,
    pub alpha: f32,
    pub composite: CompositeOp,
    pub stroke: StrokeSpec,
    pub font: FontSpec,
    pub text_align: TextAlign,
    pub text_baseline: TextBaseline,
    /// canvas `imageSmoothingEnabled`：影响 image paint（drawImage/pattern）
    /// 的采样质量。true → 双线性(Medium)，false → 最近邻(Low)。
    pub smoothing: bool,
}

impl Default for DrawState {
    fn default() -> Self {
        Self {
            transform: Affine::IDENTITY,
            clips: Vec::new(),
            fill: PaintSpec::default(),
            stroke_paint: PaintSpec::default(),
            alpha: 1.0,
            composite: CompositeOp::SourceOver,
            stroke: StrokeSpec::default(),
            font: FontSpec::default(),
            text_align: TextAlign::Start,
            text_baseline: TextBaseline::Alphabetic,
            smoothing: true,
        }
    }
}

/// 解析 CSS 颜色字符串为 sRGBA。失败返回 None（canvas 规范：非法值静默忽略，
/// 但 napi 层选择返回错误让 JS 决定——保持与浏览器一致的"忽略"也可在 JS 侧做）。
pub fn parse_paint(css: &str) -> Option<PaintSpec> {
    let dynamic = parse_color(css.trim()).ok()?;
    let srgb = dynamic
        .convert(ColorSpaceTag::Srgb)
        .to_alpha_color::<Srgb>();
    Some(PaintSpec::Solid(srgb))
}

pub fn parse_fill_rule(name: &str) -> Option<Fill> {
    match name {
        "nonzero" => Some(Fill::NonZero),
        "evenodd" => Some(Fill::EvenOdd),
        _ => None,
    }
}

/// `fillStyle`/`strokeStyle` 的 napi 入参形态：CSS 颜色字符串，或 JS 侧
/// CanvasGradient 序列化出的渐变描述对象：
///   {"kind":"linear","x0":..,"y0":..,"x1":..,"y1":..,"stops":[{"offset":0,"color":"css"}]}
///   {"kind":"radial","x0":..,"y0":..,"r0":..,"x1":..,"y1":..,"r1":..,"stops":[..]}
///   {"kind":"conic","angle":..,"x":..,"y":..,"stops":[..]}
/// pattern 不走这里——像素不能进 JSON，走 canvas_set_*_pattern 专用通道。
pub fn parse_paint_value(value: &Value) -> Option<PaintSpec> {
    match value {
        Value::String(css) => parse_paint(css),
        Value::Object(_) => parse_gradient(value),
        _ => None,
    }
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key)?.as_f64().filter(|v| v.is_finite())
}

/// stops: [{offset, color}]——offset 必须有限且在 [0,1]（JS addColorStop 已
/// 抛，此处防御性拒绝整个 paint）；按 offset 升序排序（vello 编码要求有序，
/// 规范也只保序）。颜色逐个按 CSS 解析，任一失败拒绝整个 paint。
fn parse_stops(v: &Value) -> Option<Vec<ColorStop>> {
    let arr = v.get("stops")?.as_array()?;
    let mut stops = Vec::with_capacity(arr.len());
    for s in arr {
        let offset = num(s, "offset")? as f32;
        if !(0.0..=1.0).contains(&offset) {
            return None;
        }
        let css = s.get("color")?.as_str()?;
        let color = parse_color(css.trim()).ok()?;
        let srgb = color.convert(ColorSpaceTag::Srgb).to_alpha_color::<Srgb>();
        stops.push(ColorStop::from((offset, srgb)));
    }
    stops.sort_by(|a, b| a.offset.total_cmp(&b.offset));
    Some(stops)
}

fn parse_gradient(v: &Value) -> Option<PaintSpec> {
    let kind = v.get("kind")?.as_str()?;
    let stops = parse_stops(v)?;
    // 规范：无 stop / 退化渐变「paint nothing」——vello 对这两类会退化为
    // 黑或首 stop 色，不符合规范，这里直接拦成 transparent。
    if stops.is_empty() {
        return Some(PaintSpec::transparent());
    }
    let mut gradient = match kind {
        "linear" => {
            let p0 = Point::new(num(v, "x0")?, num(v, "y0")?);
            let p1 = Point::new(num(v, "x1")?, num(v, "y1")?);
            if p0 == p1 {
                return Some(PaintSpec::transparent());
            }
            Gradient::new_linear(p0, p1)
        }
        "radial" => {
            let c0 = Point::new(num(v, "x0")?, num(v, "y0")?);
            let c1 = Point::new(num(v, "x1")?, num(v, "y1")?);
            let (r0, r1) = (num(v, "r0")? as f32, num(v, "r1")? as f32);
            if r0 < 0.0 || r1 < 0.0 {
                return None; // 规范在 createRadialGradient 已抛 IndexSizeError
            }
            if c0 == c1 && r0 == r1 {
                return Some(PaintSpec::transparent());
            }
            Gradient::new_two_point_radial(c0, r0, c1, r1)
        }
        "conic" => {
            let center = Point::new(num(v, "x")?, num(v, "y")?);
            let start = num(v, "angle")? as f32;
            // canvas conic 恒为整周：startAngle 起 360°。
            Gradient::new_sweep(center, start, start + std::f32::consts::TAU)
        }
        _ => return None,
    };
    gradient.stops = ColorStops(stops.into());
    // canvas 渐变在 unpremultiplied alpha 空间插值（peniko 注释明确对应）。
    gradient.interpolation_alpha_space = InterpolationAlphaSpace::Unpremultiplied;
    gradient.extend = Extend::Pad;
    Some(PaintSpec::Gradient(gradient))
}

/// `drawImage` 九参规范化的纯几何部分：
/// - 源矩形负 w/h 翻正、裁剪进图像边界（全出界 → None）；
/// - 目标矩形按源裁剪比例同步收缩；负 dw/dh = 镜像（经 paint transform 负缩放表达）；
/// - 返回 (dst 归一化矩形, paint_transform)。paint_transform 把源图像素空间
///   映射到用户空间：源图点 (sx,sy) 落在 (dx,dy)（镜像时取反向边）。
pub struct ResolvedDrawImage {
    pub dst: Rect,
    pub paint_transform: Affine,
}

pub fn resolve_draw_image(
    img_w: u32,
    img_h: u32,
    mut sx: f64,
    mut sy: f64,
    mut sw: f64,
    mut sh: f64,
    dx: f64,
    dy: f64,
    dw: f64,
    dh: f64,
) -> Option<ResolvedDrawImage> {
    if ![sx, sy, sw, sh, dx, dy, dw, dh]
        .iter()
        .all(|v| v.is_finite())
    {
        return None;
    }
    if sw < 0.0 {
        sx += sw;
        sw = -sw;
    }
    if sh < 0.0 {
        sy += sh;
        sh = -sh;
    }
    if sw == 0.0 || sh == 0.0 || dw == 0.0 || dh == 0.0 {
        return None;
    }
    // 源矩形裁剪到图像边界（规范：只画相交部分，dst 等比收缩）
    let cx = sx.max(0.0);
    let cy = sy.max(0.0);
    let cx1 = (sx + sw).min(f64::from(img_w));
    let cy1 = (sy + sh).min(f64::from(img_h));
    let (cw, ch) = (cx1 - cx, cy1 - cy);
    if cw <= 0.0 || ch <= 0.0 {
        return None;
    }
    let dx2 = dx + dw * (cx - sx) / sw;
    let dw2 = dw * cw / sw;
    let dy2 = dy + dh * (cy - sy) / sh;
    let dh2 = dh * ch / sh;
    let dst = Rect::new(
        dx2.min(dx2 + dw2),
        dy2.min(dy2 + dh2),
        dx2.max(dx2 + dw2),
        dy2.max(dy2 + dh2),
    );
    let paint_transform = Affine::translate((dx2, dy2))
        * Affine::scale_non_uniform(dw2 / cw, dh2 / ch)
        * Affine::translate((-cx, -cy));
    Some(ResolvedDrawImage {
        dst,
        paint_transform,
    })
}

/// Canvas 2D context：状态机 + 当前默认路径 + 持久 bitmap（在 backend 内）。
///
/// `rev` 每次可能改变像素的调用递增；挂载元素按 rev 判断是否需要重新
/// commit + 上传纹理。
pub struct Ctx2d<B: Backend> {
    backend: B,
    state: DrawState,
    saved: Vec<DrawState>,
    path: BezPath,
    rev: u64,
}

impl<B: Backend> Ctx2d<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            state: DrawState::default(),
            saved: Vec::new(),
            path: BezPath::new(),
            rev: 0,
        }
    }

    /// canvas 宽高重设：规范要求重置整个 context 状态并清空 bitmap。
    pub fn resize(&mut self, width: u16, height: u16) {
        self.backend.resize(width, height);
        self.state = DrawState::default();
        self.saved.clear();
        self.path = BezPath::new();
        self.rev += 1;
    }

    pub fn size(&self) -> (u16, u16) {
        self.backend.size()
    }

    pub fn revision(&self) -> u64 {
        self.rev
    }

    // ---- drawing state ----

    pub fn save(&mut self) {
        self.saved.push(self.state.clone());
    }

    pub fn restore(&mut self) {
        if let Some(state) = self.saved.pop() {
            self.state = state;
        }
    }

    /// 规范：resize/reset 重置全部状态。路径也清空。
    pub fn reset(&mut self) {
        self.backend.clear_bitmap();
        self.state = DrawState::default();
        self.saved.clear();
        self.path = BezPath::new();
        self.rev += 1;
    }

    pub fn set_fill_style(&mut self, paint: PaintSpec) {
        self.state.fill = paint;
    }

    pub fn set_stroke_style(&mut self, paint: PaintSpec) {
        self.state.stroke_paint = paint;
    }

    pub fn set_global_alpha(&mut self, alpha: f32) {
        if alpha.is_finite() {
            self.state.alpha = alpha.clamp(0.0, 1.0);
        }
    }

    pub fn set_composite(&mut self, composite: CompositeOp) {
        self.state.composite = composite;
    }

    pub fn set_line_width(&mut self, width: f64) {
        if width.is_finite() && width > 0.0 {
            self.state.stroke.width = width;
        }
    }

    pub fn set_line_cap(&mut self, cap: LineCap) {
        self.state.stroke.cap = cap;
    }

    pub fn set_line_join(&mut self, join: LineJoin) {
        self.state.stroke.join = join;
    }

    pub fn set_miter_limit(&mut self, limit: f64) {
        if limit.is_finite() && limit > 0.0 {
            self.state.stroke.miter_limit = limit;
        }
    }

    pub fn set_line_dash(&mut self, mut dashes: Vec<f64>, offset: f64) {
        // 规范：奇数长度翻倍；非有限值忽略整个赋值。
        if dashes.iter().any(|d| !d.is_finite() || *d < 0.0) || !offset.is_finite() {
            return;
        }
        if dashes.len() % 2 == 1 {
            let clone = dashes.clone();
            dashes.extend(clone);
        }
        self.state.stroke.dashes = dashes;
        self.state.stroke.dash_offset = offset;
    }

    pub fn set_font(&mut self, font: FontSpec) {
        self.state.font = font;
    }

    pub fn set_text_align(&mut self, align: TextAlign) {
        self.state.text_align = align;
    }

    pub fn set_text_baseline(&mut self, baseline: TextBaseline) {
        self.state.text_baseline = baseline;
    }

    pub fn set_image_smoothing(&mut self, smoothing: bool) {
        self.state.smoothing = smoothing;
    }

    // ---- transform ----

    pub fn set_transform(&mut self, m: Affine) {
        self.state.transform = m;
    }

    pub fn transform(&mut self, m: Affine) {
        self.state.transform = self.state.transform * m;
    }

    pub fn reset_transform(&mut self) {
        self.state.transform = Affine::IDENTITY;
    }

    // ---- current default path ----

    pub fn begin_path(&mut self) {
        self.path = BezPath::new();
    }

    pub fn move_to(&mut self, x: f64, y: f64) {
        self.path.move_to(Point::new(x, y));
    }

    pub fn line_to(&mut self, x: f64, y: f64) {
        self.path.line_to(Point::new(x, y));
    }

    pub fn quadratic_to(&mut self, cx: f64, cy: f64, x: f64, y: f64) {
        self.path.quad_to(Point::new(cx, cy), Point::new(x, y));
    }

    pub fn bezier_to(&mut self, c1x: f64, c1y: f64, c2x: f64, c2y: f64, x: f64, y: f64) {
        self.path
            .curve_to(Point::new(c1x, c1y), Point::new(c2x, c2y), Point::new(x, y));
    }

    pub fn close_path(&mut self) {
        self.path.close_path();
    }

    /// canvas `rect()`：向当前路径追加闭合矩形子路径（不覆盖现有路径）。
    pub fn rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        self.path.extend(rect_path(x, y, w, h));
    }

    /// canvas `roundRect()` 的单半径形式。
    pub fn round_rect(&mut self, x: f64, y: f64, w: f64, h: f64, radius: f64) {
        let rect = Rect::new(x, y, x + w, y + h);
        let rounded =
            RoundedRect::from_rect(rect, RoundedRectRadii::from_single_radius(radius.max(0.0)));
        self.path.extend(rounded.to_path(BEZIER_TOLERANCE));
    }

    /// canvas `arc(cx, cy, r, start, end, anticlockwise)`。椭圆 arc/ellipse 后续用
    /// kurbo::Ellipse + 旋转补。
    pub fn arc(
        &mut self,
        cx: f64,
        cy: f64,
        radius: f64,
        start: f64,
        end: f64,
        anticlockwise: bool,
    ) {
        if !radius.is_finite() || radius < 0.0 {
            return;
        }
        let tau = std::f64::consts::TAU;
        let mut sweep = end - start;
        if anticlockwise {
            if sweep <= -tau {
                sweep = -tau;
            } else if sweep > 0.0 {
                sweep = sweep.rem_euclid(tau) - tau;
            }
        } else {
            if sweep >= tau {
                sweep = tau;
            } else if sweep < 0.0 {
                sweep = sweep.rem_euclid(tau);
            }
        }
        let arc = Arc::new(
            Point::new(cx, cy),
            Vec2::new(radius, radius),
            start,
            sweep,
            0.0,
        );
        let mut segment = arc.to_path(BEZIER_TOLERANCE).into_iter();
        // 规范：路径非空时，arc 起点与当前点直线相连；空路径则 move_to 起点。
        if let Some(first) = segment.next() {
            let start_point = match first {
                vello_cpu::kurbo::PathEl::MoveTo(p) => p,
                _ => Point::new(cx + radius * start.cos(), cy + radius * start.sin()),
            };
            if self.path.is_empty() {
                self.path.move_to(start_point);
            } else {
                self.path.line_to(start_point);
            }
        }
        for el in segment {
            self.path.push(el);
        }
    }

    // ---- paint ops ----

    pub fn fill(&mut self, rule: Fill) {
        self.prepare_draw();
        self.backend.fill(
            &self.path,
            rule,
            &self.state.fill,
            self.state.alpha,
            self.state.composite,
        );
        self.rev += 1;
    }

    pub fn stroke(&mut self) {
        self.prepare_draw();
        self.backend.stroke(
            &self.path,
            &self.state.stroke,
            &self.state.stroke_paint,
            self.state.alpha,
            self.state.composite,
        );
        self.rev += 1;
    }

    /// clip() 只更新 canonical 栈；真正推入 backend 由下一个绘制 op 的
    /// prepare_draw → sync_clips 统一完成（commit 重放的关键）。
    pub fn clip(&mut self, rule: Fill) {
        let device_path = self.state.transform * &self.path;
        self.state.clips.push(Clip {
            path: device_path,
            rule,
        });
    }

    pub fn fill_rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        self.prepare_draw();
        self.backend.fill_rect(
            &Rect::new(x, y, x + w, y + h),
            &self.state.fill,
            self.state.alpha,
            self.state.composite,
        );
        self.rev += 1;
    }

    pub fn stroke_rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        self.prepare_draw();
        self.backend.stroke(
            &rect_path(x, y, w, h),
            &self.state.stroke,
            &self.state.stroke_paint,
            self.state.alpha,
            self.state.composite,
        );
        self.rev += 1;
    }

    /// clearRect = 以 Clear blend 填充矩形（受 transform + clip 影响，
    /// 与规范一致）。不经过 state.composite。
    pub fn clear_rect(&mut self, x: f64, y: f64, w: f64, h: f64) {
        self.prepare_draw();
        self.backend.fill_rect(
            &Rect::new(x, y, x + w, y + h),
            &PaintSpec::transparent(),
            1.0,
            CompositeOp::Clear,
        );
        self.rev += 1;
    }

    // ---- text ----

    pub fn fill_text(&mut self, string: &str, x: f64, y: f64) {
        if string.is_empty() {
            return;
        }
        let shaped = text::shape(string, &self.state.font);
        let origin = text::resolve_origin(
            x,
            y,
            &shaped,
            self.state.text_align,
            self.state.text_baseline,
        );
        self.prepare_draw();
        for run in &shaped.runs {
            if run.glyphs.is_empty() {
                continue;
            }
            self.backend.fill_glyphs(
                &run.font,
                run.font_size,
                &run.glyphs_at(origin),
                &self.state.fill,
                self.state.alpha,
                self.state.composite,
            );
        }
        self.rev += 1;
    }

    pub fn stroke_text(&mut self, string: &str, x: f64, y: f64) {
        if string.is_empty() {
            return;
        }
        let shaped = text::shape(string, &self.state.font);
        let origin = text::resolve_origin(
            x,
            y,
            &shaped,
            self.state.text_align,
            self.state.text_baseline,
        );
        self.prepare_draw();
        for run in &shaped.runs {
            if run.glyphs.is_empty() {
                continue;
            }
            self.backend.stroke_glyphs(
                &run.font,
                run.font_size,
                &run.glyphs_at(origin),
                &self.state.stroke,
                &self.state.stroke_paint,
                self.state.alpha,
                self.state.composite,
            );
        }
        self.rev += 1;
    }

    pub fn measure_text(&self, string: &str) -> text::TextMetrics {
        if string.is_empty() {
            return text::TextMetrics::default();
        }
        let runs = text::shape(string, &self.state.font);
        text::measure(&runs)
    }

    // ---- pixels ----

    /// 返回 unpremultiplied RGBA8（canvas ImageData 语义）。越界区域为 0。
    /// x/y 可为负；w/h 为 0 返回空。
    pub fn image_data(&mut self, x: i32, y: i32, w: u32, h: u32) -> Vec<u8> {
        self.backend.commit();
        let mut out = vec![0u8; w as usize * h as usize * 4];
        if w == 0 || h == 0 {
            return out;
        }
        let (pw, ph) = self.backend.size();
        let src = self.backend.pixels();
        for row in 0..h as i32 {
            let sy = y + row;
            if sy < 0 || sy >= ph as i32 {
                continue;
            }
            for col in 0..w as i32 {
                let sx = x + col;
                if sx < 0 || sx >= pw as i32 {
                    continue;
                }
                let si = (sy as usize * pw as usize + sx as usize) * 4;
                let di = (row as usize * w as usize + col as usize) * 4;
                let (r, g, b, a) = (src[si], src[si + 1], src[si + 2], src[si + 3]);
                if a != 0 {
                    let a32 = a as u32;
                    out[di] = ((r as u32 * 255 + a32 / 2) / a32).min(255) as u8;
                    out[di + 1] = ((g as u32 * 255 + a32 / 2) / a32).min(255) as u8;
                    out[di + 2] = ((b as u32 * 255 + a32 / 2) / a32).min(255) as u8;
                }
                out[di + 3] = a;
            }
        }
        out
    }

    /// 写入 unpremultiplied RGBA8。越界部分裁剪；data 长度不足抛错由调用方
    /// 校验（napi 层先查 len >= w*h*4）。
    pub fn put_image_data(&mut self, x: i32, y: i32, w: u32, h: u32, data: &[u8]) {
        self.backend.commit();
        let (pw, ph) = self.backend.size();
        let dst = self.backend.pixels_mut();
        let mut changed = false;
        for row in 0..h as i32 {
            let dy = y + row;
            if dy < 0 || dy >= ph as i32 {
                continue;
            }
            for col in 0..w as i32 {
                let dx = x + col;
                if dx < 0 || dx >= pw as i32 {
                    continue;
                }
                let si = (row as usize * w as usize + col as usize) * 4;
                let di = (dy as usize * pw as usize + dx as usize) * 4;
                let (r, g, b, a) = (data[si], data[si + 1], data[si + 2], data[si + 3]);
                dst[di] = premul(r, a);
                dst[di + 1] = premul(g, a);
                dst[di + 2] = premul(b, a);
                dst[di + 3] = a;
                changed = true;
            }
        }
        if changed {
            self.rev += 1;
        }
    }

    /// premultiplied RGBA8 原始字节（element 上传前做 B/R swizzle）。
    pub fn premul_bytes(&mut self) -> &[u8] {
        self.backend.commit();
        self.backend.pixels()
    }

    /// `drawImage`：把源位图（premultiplied RGBA8，img_w×img_h）的
    /// (sx,sy,sw,sh) 区域画到 (dx,dy,dw,dh)。调用方负责先把源 surface
    /// commit 并取出像素。返回 false = 规范规定的 no-op（源/目标矩形
    /// 退化或完全出界），此时不 bump rev。
    #[allow(clippy::too_many_arguments)]
    pub fn draw_image(
        &mut self,
        pixels: &[u8],
        img_w: u32,
        img_h: u32,
        sx: f64,
        sy: f64,
        sw: f64,
        sh: f64,
        dx: f64,
        dy: f64,
        dw: f64,
        dh: f64,
    ) -> bool {
        let Some(resolved) = resolve_draw_image(img_w, img_h, sx, sy, sw, sh, dx, dy, dw, dh)
        else {
            return false;
        };
        if pixels.len() < img_w as usize * img_h as usize * 4 {
            return false;
        }
        self.prepare_draw();
        self.backend.draw_pixels(
            pixels,
            img_w,
            img_h,
            &resolved.dst,
            &resolved.paint_transform,
            self.state.alpha,
            self.state.composite,
        );
        self.rev += 1;
        true
    }

    /// `toDataURL('image/png')`：全 bitmap 编码为 PNG（unpremultiplied
    /// RGBA8——PNG 是 straight alpha）。
    pub fn encode_png(&mut self) -> Result<Vec<u8>, image::ImageError> {
        let (w, h) = self.backend.size();
        let rgba = self.image_data(0, 0, u32::from(w), u32::from(h));
        let mut out = Vec::new();
        image::codecs::png::PngEncoder::new(&mut out).write_image(
            &rgba,
            u32::from(w),
            u32::from(h),
            image::ExtendedColorType::Rgba8,
        )?;
        Ok(out)
    }

    fn prepare_draw(&mut self) {
        self.backend.set_transform(self.state.transform);
        self.backend.set_smoothing(self.state.smoothing);
        self.backend.sync_clips(&self.state.clips);
    }
}

/// kurbo Shape::to_path 的曲率容差（文档常用 0.1）。
const BEZIER_TOLERANCE: f64 = 0.1;

fn rect_path(x: f64, y: f64, w: f64, h: f64) -> BezPath {
    let mut path = BezPath::new();
    path.move_to(Point::new(x, y));
    path.line_to(Point::new(x + w, y));
    path.line_to(Point::new(x + w, y + h));
    path.line_to(Point::new(x, y + h));
    path.close_path();
    path
}

fn premul(channel: u8, alpha: u8) -> u8 {
    ((channel as u32 * alpha as u32 + 127) / 255) as u8
}
