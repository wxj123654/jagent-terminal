//! fillText/strokeText/measureText 的 shaping 通道：cosmic-text 单行 layout
//! → 按 (font_id, font_size) 分组的 glyph run → backend `fill_glyphs`。
//!
//! cosmic-text 是项目既有文本栈（GPUI Linux 文本同款），peniko feature 让
//! `Font::as_peniko()` 直接产出 vello `glyph_run` 需要的 `FontData`，不引入
//! 第二套字体栈。FontSystem 首次创建会扫描系统字体（较慢），全局共享一个。

use std::sync::{Mutex, OnceLock};

use cosmic_text::{
    Attrs, Buffer, Family, FontSystem, Metrics, Shaping, Style, Weight, Wrap, fontdb,
};
use vello_cpu::peniko::FontData;

use crate::canvas::backend::GlyphSpec;
use crate::canvas::state::{FontSpec, TextAlign, TextBaseline};

/// 一次 shape 的结果：glyph 坐标已含行内布局偏移（line_y / x_offset /
/// y_offset），尚未加 canvas 的 (x, y) 原点与对齐。
pub struct ShapedText {
    pub runs: Vec<ShapedRun>,
    /// 最长行宽（fillText 单行场景即该行宽）。
    pub width: f32,
    /// 首行 baseline 以上高度（line_y - line_top）。
    pub ascent: f32,
    /// 首行 baseline 以下高度（line_height - ascent）。
    pub descent: f32,
    /// 首行 baseline 相对 buffer 顶部的 y。
    pub line_y: f32,
}

/// 同一 (font, size) 的连续 glyph 段——`glyph_run` 单次只能带一个字体。
pub struct ShapedRun {
    pub font: FontData,
    pub font_size: f32,
    /// 分组键：相邻 glyph font_id 相同则并入当前 run。
    font_id: fontdb::ID,
    pub glyphs: Vec<GlyphSpec>,
}

impl ShapedRun {
    /// 把用户空间原点 (ox, oy) 加到所有 glyph 坐标上。
    pub fn glyphs_at(&self, origin: (f64, f64)) -> Vec<GlyphSpec> {
        self.glyphs
            .iter()
            .map(|g| GlyphSpec {
                id: g.id,
                x: g.x + origin.0 as f32,
                y: g.y + origin.1 as f32,
            })
            .collect()
    }
}

/// canvas `TextMetrics` 的最小子集。
#[derive(Clone, Copy, Debug, Default)]
pub struct TextMetrics {
    pub width: f32,
    pub ascent: f32,
    pub descent: f32,
}

fn engine() -> &'static Mutex<FontSystem> {
    static ENGINE: OnceLock<Mutex<FontSystem>> = OnceLock::new();
    ENGINE.get_or_init(|| Mutex::new(FontSystem::new()))
}

fn family(name: &str) -> Family<'_> {
    match name.trim().to_ascii_lowercase().as_str() {
        "serif" => Family::Serif,
        "sans-serif" | "sans" => Family::SansSerif,
        "monospace" | "mono" => Family::Monospace,
        "cursive" => Family::Cursive,
        "fantasy" => Family::Fantasy,
        _ => Family::Name(name.trim()),
    }
}

/// shape 单行文本。系统字体缺失时 cosmic-text 回退 fontdb 匹配，不会 panic。
pub fn shape(text: &str, spec: &FontSpec) -> ShapedText {
    let mut shaped = ShapedText {
        runs: Vec::new(),
        width: 0.0,
        ascent: 0.0,
        descent: 0.0,
        line_y: 0.0,
    };
    let Ok(mut font_system) = engine().lock() else {
        return shaped;
    };
    let size = spec.size.max(0.0);
    // 单行 fillText：行高取 1.2em，Wrap::None 不换行。
    let metrics = Metrics::new(size, size * 1.2);
    let mut buffer = Buffer::new(&mut font_system, metrics);
    // (font_id, weight, size, x, y) —— font 资源要等 borrow_with 结束后
    // 才能拿（borrow_with 独占 &mut font_system）。
    let mut flat: Vec<(fontdb::ID, fontdb::Weight, f32, f32, f32, u32)> = Vec::new();
    {
        let mut buffer = buffer.borrow_with(&mut font_system);
        buffer.set_size(None, None);
        buffer.set_wrap(Wrap::None);
        buffer.set_text(
            text,
            &Attrs::new()
                .family(family(&spec.family))
                .weight(Weight(spec.weight))
                .style(if spec.italic {
                    Style::Italic
                } else {
                    Style::Normal
                }),
            Shaping::Advanced,
            None,
        );
        buffer.shape_until_scroll(false);

        for (line_i, run) in buffer.layout_runs().enumerate() {
            if line_i == 0 {
                let ascent = run.line_y - run.line_top;
                shaped.ascent = ascent;
                shaped.descent = run.line_height - ascent;
                shaped.line_y = run.line_y;
            }
            shaped.width = shaped.width.max(run.line_w);
            for glyph in run.glyphs {
                // Buffer::draw 同款定位：pen_x = x + x_offset*size，
                // baseline 系 y = line_y + y - y_offset*size。
                let gx = glyph.x + glyph.x_offset * glyph.font_size;
                let gy = run.line_y + glyph.y - glyph.y_offset * glyph.font_size;
                flat.push((
                    glyph.font_id,
                    glyph.font_weight,
                    glyph.font_size,
                    gx,
                    gy,
                    u32::from(glyph.glyph_id),
                ));
            }
        }
    }

    for (font_id, weight, font_size, gx, gy, glyph_id) in flat {
        let needs_new_run = match shaped.runs.last() {
            Some(last) => last.font_id != font_id || last.font_size != font_size,
            None => true,
        };
        if needs_new_run {
            let Some(font) = font_system.get_font(font_id, weight).map(|f| f.as_peniko()) else {
                // 无字体资源：跳过该 glyph。
                continue;
            };
            shaped.runs.push(ShapedRun {
                font,
                font_size,
                font_id,
                glyphs: Vec::new(),
            });
        }
        if let Some(last) = shaped.runs.last_mut() {
            last.glyphs.push(GlyphSpec {
                id: glyph_id,
                x: gx,
                y: gy,
            });
        }
    }
    shaped
}

/// canvas (x, y) + textAlign/textBaseline → glyph 原点偏移。
/// glyph 坐标系：x 相对行首，y 已含 line_y（baseline 相对 buffer 顶部）。
pub fn resolve_origin(
    x: f64,
    y: f64,
    shaped: &ShapedText,
    align: TextAlign,
    baseline: TextBaseline,
) -> (f64, f64) {
    // 规范：start/end 依赖 direction；v1 按 LTR 处理。
    let ox = match align {
        TextAlign::Start | TextAlign::Left => x,
        TextAlign::Center => x - f64::from(shaped.width) / 2.0,
        TextAlign::End | TextAlign::Right => x - f64::from(shaped.width),
    };
    let shift = match baseline {
        TextBaseline::Alphabetic => 0.0,
        TextBaseline::Top => f64::from(shaped.ascent),
        TextBaseline::Hanging => f64::from(shaped.ascent) * 0.8,
        TextBaseline::Middle => f64::from(shaped.ascent - shaped.descent) / 2.0,
        // ideographic baseline ≈ embox 底部，用 descent 近似。
        TextBaseline::Ideographic | TextBaseline::Bottom => -f64::from(shaped.descent),
    };
    (ox, y + shift - f64::from(shaped.line_y))
}

pub fn measure(shaped: &ShapedText) -> TextMetrics {
    TextMetrics {
        width: shaped.width,
        ascent: shaped.ascent,
        descent: shaped.descent,
    }
}
