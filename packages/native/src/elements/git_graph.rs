//! `<git-graph-row>` — git 图行内文本的 canvas 自绘元素。
//!
//! 为什么存在：GPUIX 每帧重建整棵元素树，`<text>` 元素在 layout 段每帧
//! 重跑 taffy 测量闭包（~2.9 次/元素；ellipsis 还绕过元素级缓存）。一屏
//! 29 行 × 5 文本 ≈ 145 个 text 节点把滚动帧拖到 ~7ms，其中 text 占 65%
//! （docs/perf-analysis.md 模块 9）。本元素与 `<terminal>` 同构：一个
//! custom element 在 canvas 里直接 paint ShapedLine——零 text 节点、零
//! 测量闭包；shaping 走 TextSystem 的 LineLayoutCache（缓存命中），截断
//! 结果按 (文本,样式,可用宽) 键存在元素实例里跨帧复用（实例生命周期与
//! 行的挂载一致：滚出视口即销毁）。
//!
//! 职责边界：只画文本列与 ref 徽章。图形列（svg 管线）与行的 hover/
//! 点击/选中仍由 JS 侧宿主 div 承担——本元素无事件（supported_events 空）。
//! 画出的每个字符串都经 `log_painted_text` 进 paint log，测试用
//! `getPaintedText()` 断言（getAllText 只见 retained 树的 `<text>`）。
//!
//! 行内布局（与原 JSX 版逐像素对齐）：
//! `[badge pill]×N ─6─ [subject 弹性] ─8─ [author 110] ─8─ [date 80 右对齐] ─8─ [sha 72] ─12─`
//! 徽章 pill：icon 15 + pad 4 + label + pad 5，高 18，圆角 5，边框 1。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use gpuix_native::custom_elements::{
    log_painted_text, CustomElement, CustomElementFactory, CustomRenderContext,
};
use serde_json::Value;

use gpui::{
    canvas, div, prelude::*, px, quad, rgba, App, BorderStyle, Bounds, Edges, Font, FontWeight,
    Pixels, Point, SharedString, ShapedLine, TextAlign, TextRun, Window,
};

// ── 行规格（props 解析结果） ────────────────────────────────────────
// 颜色用 #RRGGBBAA 十六进制传递；JS 侧负责把主题 token 转成该格式。
// 全部几何显式传入，元素不读 StyleDesc——宿主 div 已持有布局样式。

#[derive(Clone, PartialEq, Debug)]
struct ColumnSpec {
    text: String,
    color: String,
    font_family: String,
    font_size: f32,
    weight: f32,
    /// 固定列宽（px）；None = 弹性列（subject，吃剩余宽度）
    width: Option<f32>,
    /// 与前一列内容的间距
    margin_left: f32,
    align_right: bool,
    ellipsis: bool,
}

#[derive(Clone, PartialEq, Debug)]
struct BadgeSpec {
    label: String,
    label_color: String,
    label_font_family: String,
}

#[derive(Clone, PartialEq, Debug)]
struct RowSpec {
    badges: Vec<BadgeSpec>,
    columns: Vec<ColumnSpec>,
    row_height: f32,
    badge_height: f32,
}

// 徽章几何常量（与原 JSX 版一致）
const BADGE_ICON: f32 = 15.0;
const BADGE_PAD_LEFT: f32 = 4.0;
const BADGE_PAD_RIGHT: f32 = 5.0;
const BADGE_RADIUS: f32 = 5.0;
const BADGE_ICON_RADIUS: f32 = 3.0;
const BADGE_GAP: f32 = 4.0;
const BADGE_MARGIN_RIGHT: f32 = 6.0;
const BADGE_BORDER: f32 = 1.0;
const BADGE_FONT_SIZE: f32 = 11.0;
const BADGE_BG: u32 = 0x8080801F; // rgba(128,128,128,0.12)
const BADGE_ICON_BG: u32 = 0x8A8F98B3;
const BADGE_BORDER_COLOR: u32 = 0x8080805C;
const ROW_PADDING_RIGHT: f32 = 12.0;
const LINE_HEIGHT_RATIO: f32 = 1.35;
/// 徽章 label 不截断：给一个远超 pill 内可用宽的哨兵宽度
const NO_TRUNCATE_W: f32 = 1e6;

// ── shaped 行缓存 ────────────────────────────────────────────────────
// 键 = 文本 + 全部样式位 + 可用宽（窗口 resize 会改弹性列宽）。元素实例
// 与行的挂载同生命周期：滚出视口即销毁，天然无跨行泄漏。

#[derive(Clone)]
struct CachedLine {
    shaped: ShapedLine,
    width: Pixels,
}

type Cache = Arc<Mutex<HashMap<String, CachedLine>>>;
const CACHE_CAP: usize = 48;

// ── 元素 ─────────────────────────────────────────────────────────────

pub struct GitGraphRowFactory;

impl CustomElementFactory for GitGraphRowFactory {
    fn element_type(&self) -> &str {
        "git-graph-row"
    }

    fn create(&self, _id: u64) -> Box<dyn CustomElement> {
        Box::new(GitGraphRowElement {
            row: None,
            cache: Cache::default(),
        })
    }
}

pub struct GitGraphRowElement {
    row: Option<RowSpec>,
    cache: Cache,
}

impl CustomElement for GitGraphRowElement {
    fn render(
        &mut self,
        _ctx: CustomRenderContext,
        _window: &mut Window,
        _cx: &mut gpui::Context<gpuix_native::GpuixView>,
    ) -> gpui::AnyElement {
        let Some(row) = self.row.clone() else {
            return gpui::Empty.into_any_element();
        };
        let cache = self.cache.clone();
        div()
            .size_full()
            .child(canvas(
                |_, _, _| (),
                move |bounds, _, window, cx| paint_row(&row, bounds, &cache, window, cx),
            ))
            .into_any_element()
    }

    fn set_prop(&mut self, key: &str, value: Value) {
        if key == "row" {
            self.row = if value.is_null() {
                None
            } else {
                parse_row(&value)
            };
            // 行内容变了：旧 shaped 行全部作废（键含文本，留着也命中
            // 不了，清掉可立即释放）
            self.cache.lock().unwrap().clear();
        }
    }

    fn supported_props(&self) -> &'static [&'static str] {
        &["row"]
    }

    fn supported_events(&self) -> &'static [&'static str] {
        &[]
    }

    fn destroy(&mut self) {
        self.cache.lock().unwrap().clear();
    }
}

fn parse_row(v: &Value) -> Option<RowSpec> {
    let obj = v.as_object()?;
    let f32_of = |v: &Value| v.as_f64().map(|n| n as f32);
    let row_height = f32_of(obj.get("rowHeight")?)?;
    let badge_height = obj
        .get("badgeHeight")
        .and_then(f32_of)
        .unwrap_or(18.0);
    let badges = obj
        .get("badges")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|b| {
                    let bo = b.as_object()?;
                    Some(BadgeSpec {
                        label: bo.get("label")?.as_str()?.to_string(),
                        label_color: bo.get("labelColor")?.as_str()?.to_string(),
                        label_font_family: bo.get("labelFontFamily")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let columns = obj
        .get("columns")?
        .as_array()?
        .iter()
        .filter_map(|c| {
            let co = c.as_object()?;
            Some(ColumnSpec {
                text: co.get("text")?.as_str()?.replace('\n', " "),
                color: co.get("color")?.as_str()?.to_string(),
                font_family: co.get("fontFamily")?.as_str()?.to_string(),
                font_size: f32_of(co.get("fontSize")?)?,
                weight: co.get("weight").and_then(f32_of).unwrap_or(400.0),
                width: co.get("width").and_then(f32_of),
                margin_left: co.get("marginLeft").and_then(f32_of).unwrap_or(0.0),
                align_right: co
                    .get("alignRight")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                ellipsis: co
                    .get("ellipsis")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect();
    Some(RowSpec {
        badges,
        columns,
        row_height,
        badge_height,
    })
}

// ── 绘制 ─────────────────────────────────────────────────────────────

fn font_of(family: &str, weight: f32) -> Font {
    let mut font = gpui::font(SharedString::from(family.to_string()));
    font.weight = FontWeight(weight);
    font
}

fn text_run(len: usize, font: Font, color: gpui::Rgba) -> TextRun {
    TextRun {
        len,
        font,
        color: color.into(),
        background_color: None,
        underline: Default::default(),
        strikethrough: Default::default(),
    }
}

/// 取（或构造并缓存）一条 shaped 行：先按原文 shape（LineLayoutCache 命中
/// 时只花一次哈希查询），超宽则 truncate_line 换串后重 shape 并缓存。
#[allow(clippy::too_many_arguments)]
fn shaped_line(
    cache: &Cache,
    text: &str,
    family: &str,
    size: f32,
    weight: f32,
    color: &str,
    avail: Pixels,
    ellipsis: bool,
    window: &mut Window,
) -> CachedLine {
    let key = format!(
        "{text}\u{1}{color}\u{1}{family}\u{1}{size}\u{1}{weight}\u{1}{avail:.0}\u{1}{ellipsis}"
    );
    if let Some(hit) = cache.lock().unwrap().get(&key) {
        return hit.clone();
    }

    let font = font_of(family, weight);
    let rgba = rgba(parse_hex(color));
    let text = SharedString::from(text.to_string());
    let run = text_run(text.len(), font.clone(), rgba);
    let full = window
        .text_system()
        .shape_line(text.clone(), px(size), std::slice::from_ref(&run), None);

    let shaped = if ellipsis && full.width() > avail {
        let mut wrapper = window.text_system().line_wrapper(font.clone(), px(size));
        let (truncated, _) = wrapper.truncate_line(
            text,
            avail,
            "\u{2026}",
            &[run],
            gpui::TruncateFrom::End,
        );
        let run = text_run(truncated.len(), font, rgba);
        window
            .text_system()
            .shape_line(truncated, px(size), &[run], None)
    } else {
        full
    };

    let cached = CachedLine {
        width: shaped.width(),
        shaped,
    };
    let mut guard = cache.lock().unwrap();
    if guard.len() >= CACHE_CAP {
        // 行元素最多 ~6 个字符串：整清即可，无需精细淘汰
        guard.clear();
    }
    guard.insert(key, cached.clone());
    cached
}

fn parse_hex(s: &str) -> u32 {
    let hex = s.trim_start_matches('#');
    u32::from_str_radix(hex, 16).unwrap_or(0xFF0000FF)
}

fn paint_row(
    row: &RowSpec,
    bounds: Bounds<Pixels>,
    cache: &Cache,
    window: &mut Window,
    cx: &mut App,
) {
    let top = bounds.origin.y;
    let row_h = px(row.row_height);

    // ── 徽章 ──
    let mut x = bounds.origin.x;
    for badge in &row.badges {
        let label = shaped_line(
            cache,
            &badge.label,
            &badge.label_font_family,
            BADGE_FONT_SIZE,
            400.0,
            &badge.label_color,
            px(NO_TRUNCATE_W),
            false,
            window,
        );
        let pill_w = px(BADGE_ICON + BADGE_PAD_LEFT + label.width.as_f32() + BADGE_PAD_RIGHT);
        let pill_h = px(row.badge_height);
        let pill_y = top + (row_h - pill_h) * 0.5;

        window.paint_quad(quad(
            Bounds::new(Point::new(x, pill_y), gpui::size(pill_w, pill_h)),
            px(BADGE_RADIUS),
            rgba(BADGE_BG),
            Edges::all(px(BADGE_BORDER)),
            rgba(BADGE_BORDER_COLOR),
            BorderStyle::default(),
        ));
        // icon 占位块（同原 JSX 的 15×15 muted 块）
        window.paint_quad(quad(
            Bounds::new(Point::new(x, pill_y), gpui::size(px(BADGE_ICON), pill_h)),
            px(BADGE_ICON_RADIUS),
            rgba(BADGE_ICON_BG),
            Edges::all(px(0.0)),
            gpui::transparent_black(),
            BorderStyle::default(),
        ));
        let label_lh = px(BADGE_FONT_SIZE * LINE_HEIGHT_RATIO);
        log_painted_text(SharedString::from(badge.label.clone()));
        label
            .shaped
            .paint(
                Point::new(x + px(BADGE_ICON + BADGE_PAD_LEFT), top + (row_h - label_lh) * 0.5),
                label_lh,
                TextAlign::Left,
                None,
                window,
                cx,
            )
            .ok();
        x += pill_w + px(BADGE_GAP);
    }
    if !row.badges.is_empty() {
        x += px(BADGE_MARGIN_RIGHT - BADGE_GAP);
    }

    // ── 列布局 ──
    // 固定列从右往左排；弹性列（首个 width=None）吃徽章后到最左固定列
    // 之间的剩余宽度。原 JSX 顺序 [subject 弹性, author, date, sha]。
    let right_edge = bounds.origin.x + bounds.size.width - px(ROW_PADDING_RIGHT);

    // 每列的 (x, width)；固定列右起累计，弹性列随后填充。
    let mut slots: Vec<(Pixels, Pixels)> = vec![(px(0.0), px(0.0)); row.columns.len()];
    let mut cursor = right_edge;
    let mut flex_ix: Option<usize> = None;
    for (ix, col) in row.columns.iter().enumerate().rev() {
        match col.width {
            Some(w) => {
                cursor -= px(w + col.margin_left);
                slots[ix] = (cursor, px(w));
            }
            None => flex_ix = Some(ix),
        }
    }
    if let Some(ix) = flex_ix {
        let w = (cursor - x).max(px(0.0));
        slots[ix] = (x, w);
    }

    for (col, &(col_x, col_w)) in row.columns.iter().zip(slots.iter()) {
        if col.text.is_empty() {
            continue;
        }
        let line = shaped_line(
            cache,
            &col.text,
            &col.font_family,
            col.font_size,
            col.weight,
            &col.color,
            col_w,
            col.ellipsis,
            window,
        );
        let line_h = px(col.font_size * LINE_HEIGHT_RATIO);
        let origin_x = if col.align_right {
            col_x + col_w - line.width
        } else {
            col_x
        };
        log_painted_text(SharedString::from(col.text.clone()));
        line.shaped
            .paint(
                Point::new(origin_x, top + (row_h - line_h) * 0.5),
                line_h,
                TextAlign::Left,
                None,
                window,
                cx,
            )
            .ok();
    }
}
