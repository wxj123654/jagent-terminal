//! 光栅后端抽象 + vello_cpu 实现。
//!
//! 设计约束（交接文档 §backend trait）：
//! - vello_cpu 是「录制式」API：RenderContext 记录 op 队列，commit 时
//!   `render_with(SrcOver)` 叠加到持久 Pixmap，之后必须 `reset()` 清空队列，
//!   canonical clip 栈由上层重推。
//! - tiny-skia 是「直绘式」API：Paint + Pixmap 立即写像素，无队列。
//!   trait 不暴露任何一方内部类型：坐标一律 backing-store 设备像素
//!   （f64 用户空间坐标经 kurbo::Affine/kurbo::BezPath 这些纯数学类型传递，
//!   它们不绑定任何 rasterizer 实现）。
//! - clip 路径以**设备空间**存储（clip() 时刻的 CTM 已并入），backend 重推
//!   clip 时必须用 identity transform。

use std::sync::Arc;

use vello_cpu::color::PremulRgba8;
use vello_cpu::kurbo::{Affine, BezPath, Cap, Join, Rect, Shape, Stroke};
use vello_cpu::peniko::{
    BlendMode, Compose, Extend, Fill, FontData, ImageBrush, ImageQuality, ImageSampler, Mix,
};
use vello_cpu::{CompositeMode, ImageSource, PaintType};
use vello_cpu::{Glyph, Pixmap, RasterizerSettings, RenderContext, Resources};

use crate::canvas::state::{
    Clip, CompositeOp, LineCap, LineJoin, PaintSpec, Repetition, StrokeSpec,
};

/// 交给后端的单个 glyph（设备无关：x/y 是用户空间坐标，transform 由 backend 应用）。
#[derive(Clone, Copy, Debug)]
pub struct GlyphSpec {
    pub id: u32,
    pub x: f32,
    pub y: f32,
}

/// Canvas 2D 光栅后端。上层 Ctx2d 每次绘制前依次调用
/// `set_transform` + `sync_clips`，然后一个绘制方法。
pub trait Backend {
    /// canvas 宽高重设：清空 bitmap 与所有录制状态。
    fn resize(&mut self, width: u16, height: u16);
    /// 丢弃 bitmap 内容为 transparent black，同时丢弃未提交 op。
    fn clear_bitmap(&mut self);
    fn set_transform(&mut self, transform: Affine);
    /// 让 backend 的 clip 栈与 canonical `clips` 一致。clips 是设备空间路径。
    /// vello 实现：多出则 pop，缺少则以 identity transform 逐个 push；
    /// commit 重放后 clip_depth 归零、由 canonical 栈重新推入。
    fn sync_clips(&mut self, clips: &[Clip]);
    /// `imageSmoothingEnabled`：draw_pixels/pattern 采样质量开关。
    /// 由 prepare_draw 连同 transform 一起下推（状态调用，非绘制 op）。
    fn set_smoothing(&mut self, smoothing: bool);
    /// `drawImage`：premultiplied RGBA8 位图按 dst 矩形（已归一化正面积）
    /// 与 paint_transform（源图像素空间→用户空间，含镜像负缩放）绘制。
    /// 受当前 transform/clip/alpha/composite 约束。
    fn draw_pixels(
        &mut self,
        pixels: &[u8],
        img_w: u32,
        img_h: u32,
        dst: &Rect,
        paint_transform: &Affine,
        alpha: f32,
        composite: CompositeOp,
    );
    fn fill(
        &mut self,
        path: &BezPath,
        rule: Fill,
        paint: &PaintSpec,
        alpha: f32,
        composite: CompositeOp,
    );
    fn fill_rect(&mut self, rect: &Rect, paint: &PaintSpec, alpha: f32, composite: CompositeOp);
    fn stroke(
        &mut self,
        path: &BezPath,
        stroke: &StrokeSpec,
        paint: &PaintSpec,
        alpha: f32,
        composite: CompositeOp,
    );
    fn fill_glyphs(
        &mut self,
        font: &FontData,
        size: f32,
        glyphs: &[GlyphSpec],
        paint: &PaintSpec,
        alpha: f32,
        composite: CompositeOp,
    );
    fn stroke_glyphs(
        &mut self,
        font: &FontData,
        size: f32,
        glyphs: &[GlyphSpec],
        stroke: &StrokeSpec,
        paint: &PaintSpec,
        alpha: f32,
        composite: CompositeOp,
    );
    /// 把已录制 op 光栅化到持久 bitmap。
    fn commit(&mut self);
    /// premultiplied RGBA8，row-major，len = w*h*4。
    fn pixels(&self) -> &[u8];
    fn pixels_mut(&mut self) -> &mut [u8];
    fn size(&self) -> (u16, u16);
}

/// vello_cpu 后端：RenderContext（op 录制）+ Resources + 持久 Pixmap。
///
/// 生命周期：绘制方法只录制；`commit()` 用 `SrcOver` 把 scene 叠到 pixmap、
/// 随后 `reset()` 清空 dispatcher——已推 clip 随之消失，靠 `sync_clips`
/// 从 canonical 栈重推。这避免了「重放全部历史命令」的持久化方案。
pub struct VelloBackend {
    ctx: RenderContext,
    resources: Resources,
    pixmap: Pixmap,
    /// ctx 内已录制的 clip 深度。
    clip_depth: usize,
    /// 最近一次 set_transform 的用户 CTM；clip 重推时先切 identity 再恢复。
    transform: Affine,
    /// 是否有未 commit 的绘制 op（clip push 本身不算）。
    pending: bool,
    /// imageSmoothingEnabled 镜像（prepare_draw 下推）。
    smoothing: bool,
}

impl VelloBackend {
    pub fn new(width: u16, height: u16) -> Self {
        Self {
            ctx: RenderContext::new(width, height),
            resources: Resources::new(),
            pixmap: Pixmap::new(width, height),
            clip_depth: 0,
            transform: Affine::IDENTITY,
            pending: false,
            smoothing: true,
        }
    }

    /// 统一设置 paint + blend +（pattern 需要的）带状 clip。
    /// 返回 true 表示推了一层 clip，调用方绘制后必须 pop_clip_path。
    ///
    /// `repeat-x/y/no-repeat` 用 clip 表达：peniko Extend 只有
    /// Pad/Repeat/Reflect，没有 canvas 需要的「越界即透明」，所以在
    /// 图像条带外缘加一层用户空间 clip（clip_path_transform 只吃
    /// scene transform，pattern 空间即用户空间，语义对齐）。
    fn apply_paint(&mut self, paint: &PaintSpec, alpha: f32) -> bool {
        self.ctx.set_paint(self.resolve_paint(paint, alpha));
        if let PaintSpec::Pattern(p) = paint {
            if let Some(band) = pattern_band(p.repetition, p.image.width, p.image.height) {
                self.ctx.set_fill_rule(Fill::NonZero);
                self.ctx.push_clip_path(&band);
                return true;
            }
        }
        false
    }

    fn pop_pattern_clip(&mut self, banded: bool) {
        if banded {
            self.ctx.pop_clip_path();
        }
    }

    fn resolve_paint(&self, paint: &PaintSpec, alpha: f32) -> PaintType {
        match paint {
            PaintSpec::Solid(color) => {
                let (_, base_alpha) = color.split();
                PaintType::from(color.with_alpha((base_alpha * alpha).clamp(0.0, 1.0)))
            }
            // 注意：image paint 的 sampler.alpha 在 vello_cpu 0.2.0 是
            // unimplemented!()——alpha 只能乘进像素（multiply_alpha）。
            PaintSpec::Gradient(g) => g.clone().multiply_alpha(alpha).into(),
            PaintSpec::Pattern(p) => pattern_brush(p, alpha, self.smoothing),
        }
    }
}

impl Backend for VelloBackend {
    fn resize(&mut self, width: u16, height: u16) {
        self.ctx.reset_and_resize(width, height);
        self.pixmap = Pixmap::new(width, height);
        self.clip_depth = 0;
        self.pending = false;
    }

    fn clear_bitmap(&mut self) {
        self.ctx.reset();
        self.pixmap.data_mut().fill(PremulRgba8::from_u32(0));
        self.clip_depth = 0;
        self.pending = false;
    }

    fn set_transform(&mut self, transform: Affine) {
        self.transform = transform;
        self.ctx.set_transform(transform);
    }

    fn sync_clips(&mut self, clips: &[Clip]) {
        while self.clip_depth > clips.len() {
            self.ctx.pop_clip_path();
            self.clip_depth -= 1;
        }
        if self.clip_depth < clips.len() {
            // canonical clip 是设备空间：重推时必须绕开用户 CTM。
            self.ctx.set_transform(Affine::IDENTITY);
            for clip in &clips[self.clip_depth..] {
                self.ctx.set_fill_rule(clip.rule);
                self.ctx.push_clip_path(&clip.path);
                self.clip_depth += 1;
            }
            self.ctx.set_transform(self.transform);
        }
    }

    fn set_smoothing(&mut self, smoothing: bool) {
        self.smoothing = smoothing;
    }

    fn draw_pixels(
        &mut self,
        pixels: &[u8],
        img_w: u32,
        img_h: u32,
        dst: &Rect,
        paint_transform: &Affine,
        alpha: f32,
        composite: CompositeOp,
    ) {
        let mut pixmap = Pixmap::from_parts(
            pixels
                .chunks_exact(4)
                .map(|p| PremulRgba8 {
                    r: p[0],
                    g: p[1],
                    b: p[2],
                    a: p[3],
                })
                .collect(),
            img_w as u16,
            img_h as u16,
        );
        if alpha < 1.0 {
            pixmap.multiply_alpha((alpha * 255.0 + 0.5) as u8);
        }
        self.ctx.set_paint(ImageBrush {
            image: ImageSource::Pixmap(Arc::new(pixmap)),
            sampler: image_sampler(self.smoothing),
        });
        self.ctx.set_blend_mode(blend_mode(composite));
        self.ctx.set_fill_rule(Fill::NonZero);
        // paint_transform 定位图像；绘制后必须复位——它会泄漏到后续
        // gradient/image paint（solid 不受影响，但不能依赖这个巧合）。
        self.ctx.set_paint_transform(*paint_transform);
        self.ctx.fill_rect(dst);
        self.ctx.reset_paint_transform();
        self.pending = true;
    }

    fn fill(
        &mut self,
        path: &BezPath,
        rule: Fill,
        paint: &PaintSpec,
        alpha: f32,
        composite: CompositeOp,
    ) {
        self.ctx.set_blend_mode(blend_mode(composite));
        let banded = self.apply_paint(paint, alpha);
        self.ctx.set_fill_rule(rule);
        self.ctx.fill_path(path);
        self.pop_pattern_clip(banded);
        self.pending = true;
    }

    fn fill_rect(&mut self, rect: &Rect, paint: &PaintSpec, alpha: f32, composite: CompositeOp) {
        self.ctx.set_blend_mode(blend_mode(composite));
        let banded = self.apply_paint(paint, alpha);
        self.ctx.set_fill_rule(Fill::NonZero);
        self.ctx.fill_rect(rect);
        self.pop_pattern_clip(banded);
        self.pending = true;
    }

    fn stroke(
        &mut self,
        path: &BezPath,
        stroke: &StrokeSpec,
        paint: &PaintSpec,
        alpha: f32,
        composite: CompositeOp,
    ) {
        self.ctx.set_blend_mode(blend_mode(composite));
        self.ctx.set_stroke(kurbo_stroke(stroke));
        let banded = self.apply_paint(paint, alpha);
        self.ctx.stroke_path(path);
        self.pop_pattern_clip(banded);
        self.pending = true;
    }

    fn fill_glyphs(
        &mut self,
        font: &FontData,
        size: f32,
        glyphs: &[GlyphSpec],
        paint: &PaintSpec,
        alpha: f32,
        composite: CompositeOp,
    ) {
        self.ctx.set_blend_mode(blend_mode(composite));
        let banded = self.apply_paint(paint, alpha);
        let ctx = &mut self.ctx;
        let resources = &mut self.resources;
        ctx.glyph_run(resources, font)
            .font_size(size)
            .fill_glyphs(glyphs.iter().map(|g| Glyph {
                id: g.id,
                x: g.x,
                y: g.y,
            }));
        self.pop_pattern_clip(banded);
        self.pending = true;
    }

    fn stroke_glyphs(
        &mut self,
        font: &FontData,
        size: f32,
        glyphs: &[GlyphSpec],
        stroke: &StrokeSpec,
        paint: &PaintSpec,
        alpha: f32,
        composite: CompositeOp,
    ) {
        self.ctx.set_blend_mode(blend_mode(composite));
        self.ctx.set_stroke(kurbo_stroke(stroke));
        let banded = self.apply_paint(paint, alpha);
        let ctx = &mut self.ctx;
        let resources = &mut self.resources;
        ctx.glyph_run(resources, font)
            .font_size(size)
            .stroke_glyphs(glyphs.iter().map(|g| Glyph {
                id: g.id,
                x: g.x,
                y: g.y,
            }));
        self.pop_pattern_clip(banded);
        self.pending = true;
    }

    fn commit(&mut self) {
        if !self.pending {
            return;
        }
        self.ctx.flush();
        self.ctx.render_with(
            &mut self.pixmap,
            &mut self.resources,
            RasterizerSettings {
                composite_mode: CompositeMode::SrcOver,
                ..RasterizerSettings::default()
            },
        );
        self.ctx.reset();
        self.clip_depth = 0;
        self.pending = false;
    }

    fn pixels(&self) -> &[u8] {
        self.pixmap.data_as_u8_slice()
    }

    fn pixels_mut(&mut self) -> &mut [u8] {
        self.pixmap.data_as_u8_slice_mut()
    }

    fn size(&self) -> (u16, u16) {
        (self.pixmap.width(), self.pixmap.height())
    }
}

/// image 采样器：x/y 都 Pad（drawImage 已把 dst 矩形精确对齐源区域，
/// 出界采样仅出现在 AA 边缘，Pad=clamp-to-edge 最贴近规范）。
fn image_sampler(smoothing: bool) -> ImageSampler {
    ImageSampler {
        x_extend: Extend::Pad,
        y_extend: Extend::Pad,
        quality: if smoothing {
            ImageQuality::Medium
        } else {
            ImageQuality::Low
        },
        // 非 1.0 会在 encode 时 panic（vello_cpu 0.2.0 unimplemented!），
        // alpha 一律走 Pixmap::multiply_alpha。
        alpha: 1.0,
    }
}

/// 非 'repeat' pattern 的用户空间条带：条带外 canvas 语义是透明，
/// peniko 无对应 extend，用 clip 表达。
fn pattern_band(repetition: Repetition, w: u32, h: u32) -> Option<BezPath> {
    let rect = match repetition {
        Repetition::Repeat => return None,
        Repetition::RepeatX => Rect::new(-1e9, 0.0, 1e9, f64::from(h)),
        Repetition::RepeatY => Rect::new(0.0, -1e9, f64::from(w), 1e9),
        Repetition::NoRepeat => Rect::new(0.0, 0.0, f64::from(w), f64::from(h)),
    };
    Some(rect.to_path(0.0))
}

/// pattern ImageData（unpremul RGBA8）→ 采样用 ImageSource。
/// alpha<1 时乘进像素（sampler.alpha 不可用，见上）。
fn pattern_brush(p: &crate::canvas::state::PatternSpec, alpha: f32, smoothing: bool) -> PaintType {
    let data = p.image.data.data();
    let mut pixmap = Pixmap::from_parts(
        data.chunks_exact(4)
            .map(|c| {
                let (r, g, b, a) = (c[0], c[1], c[2], c[3]);
                if a == 255 {
                    PremulRgba8 { r, g, b, a }
                } else {
                    let m = |v: u8| ((u32::from(v) * u32::from(a) + 127) / 255) as u8;
                    PremulRgba8 {
                        r: m(r),
                        g: m(g),
                        b: m(b),
                        a,
                    }
                }
            })
            .collect(),
        p.image.width.min(u16::MAX.into()) as u16,
        p.image.height.min(u16::MAX.into()) as u16,
    );
    if alpha < 1.0 {
        pixmap.multiply_alpha((alpha * 255.0 + 0.5) as u8);
    }
    let (x_extend, y_extend) = match p.repetition {
        Repetition::Repeat => (Extend::Repeat, Extend::Repeat),
        // 非整轴平铺方向用 Pad 填充——配合 pattern_band 的 clip 不影响结果。
        Repetition::RepeatX => (Extend::Repeat, Extend::Pad),
        Repetition::RepeatY => (Extend::Pad, Extend::Repeat),
        Repetition::NoRepeat => (Extend::Pad, Extend::Pad),
    };
    ImageBrush {
        image: ImageSource::Pixmap(Arc::new(pixmap)),
        sampler: ImageSampler {
            x_extend,
            y_extend,
            ..image_sampler(smoothing)
        },
    }
    .into()
}

fn blend_mode(op: CompositeOp) -> BlendMode {
    let (mix, compose) = match op {
        CompositeOp::SourceOver => (Mix::Normal, Compose::SrcOver),
        CompositeOp::SourceIn => (Mix::Normal, Compose::SrcIn),
        CompositeOp::SourceOut => (Mix::Normal, Compose::SrcOut),
        CompositeOp::SourceAtop => (Mix::Normal, Compose::SrcAtop),
        CompositeOp::DestinationOver => (Mix::Normal, Compose::DestOver),
        CompositeOp::DestinationIn => (Mix::Normal, Compose::DestIn),
        CompositeOp::DestinationOut => (Mix::Normal, Compose::DestOut),
        CompositeOp::DestinationAtop => (Mix::Normal, Compose::DestAtop),
        CompositeOp::Lighter => (Mix::Normal, Compose::Plus),
        CompositeOp::Copy => (Mix::Normal, Compose::Copy),
        CompositeOp::Xor => (Mix::Normal, Compose::Xor),
        CompositeOp::Multiply => (Mix::Multiply, Compose::SrcOver),
        CompositeOp::Screen => (Mix::Screen, Compose::SrcOver),
        CompositeOp::Overlay => (Mix::Overlay, Compose::SrcOver),
        CompositeOp::Darken => (Mix::Darken, Compose::SrcOver),
        CompositeOp::Lighten => (Mix::Lighten, Compose::SrcOver),
        CompositeOp::ColorDodge => (Mix::ColorDodge, Compose::SrcOver),
        CompositeOp::ColorBurn => (Mix::ColorBurn, Compose::SrcOver),
        CompositeOp::HardLight => (Mix::HardLight, Compose::SrcOver),
        CompositeOp::SoftLight => (Mix::SoftLight, Compose::SrcOver),
        CompositeOp::Difference => (Mix::Difference, Compose::SrcOver),
        CompositeOp::Exclusion => (Mix::Exclusion, Compose::SrcOver),
        CompositeOp::Hue => (Mix::Hue, Compose::SrcOver),
        CompositeOp::Saturation => (Mix::Saturation, Compose::SrcOver),
        CompositeOp::Color => (Mix::Color, Compose::SrcOver),
        CompositeOp::Luminosity => (Mix::Luminosity, Compose::SrcOver),
        // clearRect 语义：覆盖区域一律变 transparent black。
        CompositeOp::Clear => (Mix::Normal, Compose::Clear),
    };
    BlendMode::new(mix, compose)
}

fn kurbo_stroke(spec: &StrokeSpec) -> Stroke {
    let cap = match spec.cap {
        LineCap::Butt => Cap::Butt,
        LineCap::Round => Cap::Round,
        LineCap::Square => Cap::Square,
    };
    let join = match spec.join {
        LineJoin::Miter => Join::Miter,
        LineJoin::Round => Join::Round,
        LineJoin::Bevel => Join::Bevel,
    };
    Stroke::new(spec.width)
        .with_caps(cap)
        .with_join(join)
        .with_miter_limit(spec.miter_limit)
        .with_dashes(spec.dash_offset, spec.dashes.iter().copied())
}
