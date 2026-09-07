//! Terminal rendering module.
//!
//! This module provides [`TerminalRenderer`], which handles efficient rendering of
//! terminal content using GPUI's text and drawing systems.
//!
//! # Rendering Pipeline
//!
//! The renderer processes the terminal grid in several stages:
//!
//! ```text
//! Terminal Grid → Layout Phase → Paint Phase
//!                      │              │
//!                      ├─ Collect backgrounds
//!                      ├─ Batch text runs
//!                      │              │
//!                      │              ├─ Paint default background
//!                      │              ├─ Paint non-default backgrounds
//!                      │              ├─ Paint text characters
//!                      │              └─ Paint cursor
//! ```
//!
//! # Optimizations
//!
//! The renderer includes several optimizations to minimize draw calls:
//!
//! 1. **Background Merging**: Adjacent cells with the same background color are
//!    merged into single rectangles, reducing the number of quads to paint.
//!
//! 2. **Text Batching**: Adjacent cells with identical styling (color, bold, italic)
//!    are grouped into [`BatchedTextRun`]s for efficient text shaping.
//!
//! 3. **Default Background Skip**: Cells with the default background color don't
//!    generate separate background rectangles.
//!
//! 4. **Cell Measurement**: Font metrics are measured using the ASCII `M` glyph
//!    from the configured monospace family and cached by GPUI.
//!
//! # Cell Dimensions
//!
//! Cell size is calculated from actual font metrics using the ASCII `M` glyph:
//!
//! - **Width**: Measured from shaped `M` (avoids box-drawing fallback ambiguity)
//! - **Height**: `(ascent + descent) × line_height_multiplier`
//!
//! The `line_height_multiplier` (default 1.0) can be adjusted to add extra
//! vertical space if needed for specific fonts.
//!
//! # Example
//!
//! ```ignore
//! use gpui::px;
//! use jagent_terminal::{ColorPalette, TerminalRenderer};
//!
//! let renderer = TerminalRenderer::new(
//!     "JetBrains Mono".to_string(),
//!     px(14.0),
//!     1.0,  // line height multiplier
//!     ColorPalette::default(),
//! );
//! ```

use crate::view::box_drawing;
use crate::view::colors::ColorPalette;
use crate::model::SessionListener;
use crate::perf::PaintGuard;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point as AlacPoint};
use alacritty_terminal::term::Term;
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::term::TermMode;
use alacritty_terminal::vte::ansi::Color;
use gpui::{
    App, Bounds, Edges, Font, FontFeatures, FontStyle, FontWeight, Hsla, Pixels, Point,
    SharedString, Size, TextRun, UnderlineStyle, Window, px, quad, transparent_black,
};

/// A batched run of text with consistent styling.
///
/// This struct groups adjacent terminal cells with identical visual attributes
/// to reduce the number of text rendering calls.
#[derive(Debug, Clone)]
pub struct BatchedTextRun {
    /// The text content to render
    pub text: String,

    /// Starting column position
    pub start_col: usize,

    /// Row position
    pub row: usize,

    /// Foreground color
    pub fg_color: Hsla,

    /// Background color
    pub bg_color: Hsla,

    /// Bold flag
    pub bold: bool,

    /// Italic flag
    pub italic: bool,

    /// Underline flag
    pub underline: bool,
}

/// Background rectangle to paint.
///
/// Represents a rectangular region with a solid color background.
#[derive(Debug, Clone)]
pub struct BackgroundRect {
    /// Starting column position
    pub start_col: usize,

    /// Ending column position (exclusive)
    pub end_col: usize,

    /// Row position
    pub row: usize,

    /// Background color
    pub color: Hsla,
}

impl BackgroundRect {
    /// Check if this rectangle can be merged with another.
    ///
    /// Two rectangles can be merged if they:
    /// - Are on the same row
    /// - Have the same color
    /// - Are horizontally adjacent
    fn can_merge_with(&self, other: &Self) -> bool {
        self.row == other.row && self.color == other.color && self.end_col == other.start_col
    }
}

/// Terminal renderer with font settings and cell dimensions.
///
/// This struct manages the rendering of terminal content, including text,
/// backgrounds, and cursor. It maintains font metrics and provides the
/// [`paint`](Self::paint) method for drawing the terminal grid.
///
/// # Font Metrics
///
/// Cell dimensions are calculated from actual font measurements via
/// [`measure_cell`](Self::measure_cell). This ensures accurate character
/// positioning regardless of the font used.
///
/// # Usage
///
/// The renderer is typically used internally by [`TerminalView`](crate::TerminalView),
/// but can also be used directly for custom rendering:
///
/// ```ignore
/// // Measure cell dimensions (call once per font change)
/// renderer.measure_cell(window);
///
/// // Paint the terminal grid
/// renderer.paint(bounds, padding, &term, window, cx);
/// ```
///
/// # Performance
///
/// For optimal performance:
/// - Call `measure_cell` only when font settings change
/// - The `paint` method is designed to be called every frame
/// - Background and text batching minimize GPU draw calls
#[derive(Clone)]
pub struct TerminalRenderer {
    /// Font family name (e.g., "Fira Code", "Menlo")
    pub font_family: String,

    /// Font size in pixels
    pub font_size: Pixels,

    /// Width of a single character cell
    pub cell_width: Pixels,

    /// Height of a single character cell (line height)
    pub cell_height: Pixels,

    /// Multiplier for line height to accommodate tall glyphs
    pub line_height_multiplier: f32,

    /// Color palette for resolving terminal colors
    pub palette: ColorPalette,

    /// Whether the cursor block is drawn this frame (blink phase; set by
    /// the view before cloning the renderer into the canvas closure).
    pub cursor_visible: bool,
}

impl TerminalRenderer {
    /// Creates a new terminal renderer with the given font settings and color palette.
    ///
    /// # Arguments
    ///
    /// * `font_family` - The name of the font family to use
    /// * `font_size` - The font size in pixels
    /// * `line_height_multiplier` - Multiplier for line height (e.g., 1.2 for 20% extra)
    /// * `palette` - The color palette to use for terminal colors
    ///
    /// # Returns
    ///
    /// A new `TerminalRenderer` instance with default cell dimensions.
    ///
    /// # Examples
    ///
    /// ```
    /// use gpui::px;
    /// use jagent_terminal::TerminalRenderer;
    /// use jagent_terminal::ColorPalette;
    ///
    /// let renderer = TerminalRenderer::new("Fira Code".to_string(), px(14.0), 1.0, ColorPalette::default());
    /// ```
    pub fn new(
        font_family: String,
        font_size: Pixels,
        line_height_multiplier: f32,
        palette: ColorPalette,
    ) -> Self {
        // Default cell dimensions - will be measured on first paint
        // Using 0.6 as approximate em-width ratio for monospace fonts
        let cell_width = font_size * 0.6;
        let cell_height = font_size * 1.4; // Line height with some spacing

        Self {
            font_family,
            font_size,
            cell_width,
            cell_height,
            line_height_multiplier,
            palette,
            cursor_visible: true,
        }
    }

    /// Measure cell dimensions based on actual font metrics.
    ///
    /// This method measures the actual width and height of characters using the
    /// GPUI text system. ASCII `M` comes from the configured primary family;
    /// measuring box-drawing glyphs can accidentally select a fallback font.
    ///
    /// # Arguments
    ///
    /// * `window` - The GPUI window for text system access
    pub fn measure_cell(&mut self, window: &mut Window) {
        // ASCII M measures the primary monospace family directly. Box-drawing
        // glyphs may be served by a fallback with different advance metrics.
        let font = Font {
            family: self.font_family.clone().into(),
            features: FontFeatures::default(),
            fallbacks: None,
            weight: FontWeight::NORMAL,
            style: FontStyle::Normal,
        };

        let text_run = TextRun {
            len: "M".len(),
            font,
            color: gpui::black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };

        let shaped = window
            .text_system()
            .shape_line("M".into(), self.font_size, &[text_run], None);

        // Get the width from the shaped line
        if shaped.width > px(0.0) {
            self.cell_width = shaped.width;
        }

        // Calculate height from ascent + descent with optional multiplier
        let line_height = (shaped.ascent + shaped.descent).ceil();
        if line_height > px(0.0) {
            self.cell_height = line_height * self.line_height_multiplier;
        }
    }

    /// Layout cells into batched text runs and background rects for a single row.
    ///
    /// This method processes a row of terminal cells and groups adjacent cells
    /// with identical styling into batched runs. It also collects background
    /// rectangles that need to be painted.
    ///
    /// # Arguments
    ///
    /// * `row` - The row number
    /// * `cells` - Iterator over (column, Cell) pairs
    /// * `colors` - Terminal color configuration
    ///
    /// # Returns
    ///
    /// A tuple of `(backgrounds, text_runs)` where:
    /// - `backgrounds` is a vector of merged background rectangles
    /// - `text_runs` is a vector of batched text runs
    pub fn layout_row(
        &self,
        row: usize,
        cells: impl Iterator<Item = (usize, Cell)>,
        colors: &Colors,
    ) -> (Vec<BackgroundRect>, Vec<BatchedTextRun>) {
        let mut backgrounds = Vec::new();
        let mut text_runs = Vec::new();

        let mut current_run: Option<BatchedTextRun> = None;
        let mut current_bg: Option<BackgroundRect> = None;
        // 下一字形应落到的 grid 列。宽字符自身占两列，spacer 不进字符串。
        let mut next_run_col: Option<usize> = None;

        for (col, cell) in cells {
            // Extract cell styling
            let mut fg_color = self.palette.resolve(cell.fg, colors);
            let mut bg_color = self.palette.resolve(cell.bg, colors);
            // 反色（SGR 7）：交换 fg/bg。TUI 普遍用它画选中块/软光标
            // （pi 的输入光标就是反色 cell），不处理则块不可见。
            if cell.flags.contains(Flags::INVERSE) {
                std::mem::swap(&mut fg_color, &mut bg_color);
            }
            let bold = cell.flags.contains(Flags::BOLD);
            let italic = cell.flags.contains(Flags::ITALIC);
            let underline = cell.flags.contains(Flags::UNDERLINE);

            // 背景覆盖每个 grid cell，宽字符 spacer 也不能漏掉。
            if let Some(ref mut bg_rect) = current_bg {
                if bg_rect.color == bg_color && bg_rect.end_col == col {
                    bg_rect.end_col = col + 1;
                } else {
                    backgrounds.push(bg_rect.clone());
                    current_bg = Some(BackgroundRect {
                        start_col: col,
                        end_col: col + 1,
                        row,
                        color: bg_color,
                    });
                }
            } else {
                current_bg = Some(BackgroundRect {
                    start_col: col,
                    end_col: col + 1,
                    row,
                    color: bg_color,
                });
            }

            // Spacer 只占 grid/background，不重复 shape 宽字符。
            if cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                continue;
            }

            let ch = if cell.c == ' ' || cell.c == '\0' {
                ' '
            } else {
                cell.c
            };

            // 制表字符由 box_drawing 模块自绘；它必须切断普通文本 run。
            if box_drawing::is_box_drawing_char(ch) {
                if let Some(run) = current_run.take() {
                    text_runs.push(run);
                }
                next_run_col = None;
                continue;
            }

            // 宽字符占两个 grid cell；单独成 run，避免 GPUI 的 force_width
            // 把它后的 ASCII 错排到下一格而非下两格。
            if cell.flags.contains(Flags::WIDE_CHAR) {
                if let Some(run) = current_run.take() {
                    text_runs.push(run);
                }
                text_runs.push(BatchedTextRun {
                    text: ch.to_string(),
                    start_col: col,
                    row,
                    fg_color,
                    bg_color,
                    bold,
                    italic,
                    underline,
                });
                next_run_col = None;
                continue;
            }

            let can_extend = current_run.as_ref().is_some_and(|run| {
                next_run_col == Some(col)
                    && run.fg_color == fg_color
                    && run.bg_color == bg_color
                    && run.bold == bold
                    && run.italic == italic
                    && run.underline == underline
            });

            if can_extend {
                current_run.as_mut().unwrap().text.push(ch);
            } else {
                if let Some(run) = current_run.take() {
                    text_runs.push(run);
                }
                current_run = Some(BatchedTextRun {
                    text: ch.to_string(),
                    start_col: col,
                    row,
                    fg_color,
                    bg_color,
                    bold,
                    italic,
                    underline,
                });
            }
            next_run_col = Some(col + 1);
        }

        if let Some(run) = current_run {
            text_runs.push(run);
        }
        if let Some(bg) = current_bg {
            backgrounds.push(bg);
        }

        (self.merge_backgrounds(backgrounds), text_runs)
    }

    /// Merge adjacent background rects with same color.
    ///
    /// This optimization reduces the number of rectangles to paint by
    /// combining horizontally adjacent rectangles that share the same color.
    ///
    /// # Arguments
    ///
    /// * `rects` - Vector of background rectangles to merge
    ///
    /// # Returns
    ///
    /// A new vector with merged rectangles
    fn merge_backgrounds(&self, mut rects: Vec<BackgroundRect>) -> Vec<BackgroundRect> {
        if rects.is_empty() {
            return rects;
        }

        let mut merged = Vec::new();
        let mut current = rects.remove(0);

        for rect in rects {
            if current.can_merge_with(&rect) {
                current.end_col = rect.end_col;
            } else {
                merged.push(current);
                current = rect;
            }
        }

        merged.push(current);
        merged
    }

    /// Calculate the on-screen bounds of the terminal cursor cell, used for
    /// IME candidate-window positioning. Returns `None` when the cursor is
    /// scrolled out of the visible viewport.
    pub fn cursor_bounds(
        &self,
        bounds: Bounds<Pixels>,
        padding: Edges<Pixels>,
        term: &Term<SessionListener>,
    ) -> Option<Bounds<Pixels>> {
        let grid = term.grid();
        let display_offset = grid.display_offset() as i32;
        let p = grid.cursor.point;
        let row = p.line.0 + display_offset;
        if row < 0 || row as usize >= grid.screen_lines() {
            return None;
        }
        let origin = Point {
            x: bounds.origin.x + padding.left,
            y: bounds.origin.y + padding.top,
        };
        Some(Bounds {
            origin: Point {
                x: origin.x + self.cell_width * (p.column.0 as f32),
                y: origin.y + self.cell_height * (row as f32),
            },
            size: Size {
                width: self.cell_width,
                height: self.cell_height,
            },
        })
    }

    /// Paint the marked (IME pre-edit) text at the cursor position with an
    /// underline, covering the terminal text behind it. Mirrors Zed's
    /// terminal: composition feedback lives in the terminal view layer.
    fn paint_marked_text(
        &self,
        marked_text: &str,
        origin: Point<Pixels>,
        cursor_point: AlacPoint,
        display_offset: i32,
        default_bg: Hsla,
        foreground: Hsla,
        window: &mut Window,
        cx: &mut App,
    ) {
        let cursor_row = cursor_point.line.0 + display_offset;
        if cursor_row < 0 {
            return;
        }
        let x = origin.x + self.cell_width * (cursor_point.column.0 as f32);
        let y = origin.y + self.cell_height * (cursor_row as f32);

        let font = Font {
            family: self.font_family.clone().into(),
            features: FontFeatures::default(),
            fallbacks: None,
            weight: FontWeight::NORMAL,
            style: FontStyle::Normal,
        };
        let run = TextRun {
            len: marked_text.len(),
            font,
            color: foreground,
            underline: Some(UnderlineStyle {
                thickness: px(1.0),
                color: Some(foreground),
                wavy: false,
            }),
            background_color: None,
            strikethrough: None,
        };
        let shaped = window.text_system().shape_line(
            marked_text.to_string().into(),
            self.font_size,
            &[run],
            None,
        );
        // 背景盖住组合文本后面的终端内容，宽度至少一格光标宽
        let width = shaped.width.max(self.cell_width);
        window.paint_quad(quad(
            Bounds {
                origin: Point { x, y },
                size: Size {
                    width,
                    height: self.cell_height,
                },
            },
            px(0.0),
            default_bg,
            Edges::<Pixels>::default(),
            transparent_black(),
            Default::default(),
        ));
        let base_height = self.cell_height / self.line_height_multiplier;
        let vertical_offset = (self.cell_height - base_height) / 2.0;
        let _ = shaped.paint(
            Point {
                x,
                y: y + vertical_offset,
            },
            self.cell_height,
            gpui::TextAlign::Left,
            None,
            window,
            cx,
        );
    }

    /// Paint terminal content to the window.
    ///
    /// This is the main rendering method that draws the terminal grid,
    /// including backgrounds, text, and cursor.
    ///
    /// # Arguments
    ///
    /// * `bounds` - The bounding box to render within
    /// * `padding` - Padding around the terminal content
    /// * `term` - The terminal state
    /// * `marked_text` - Active IME composition text, if any; painted at the
    ///   cursor and suppresses the hardware cursor while composing
    /// * `window` - The GPUI window
    /// * `cx` - The application context
    pub fn paint(
        &self,
        bounds: Bounds<Pixels>,
        padding: Edges<Pixels>,
        term: &Term<SessionListener>,
        marked_text: Option<&str>,
        window: &mut Window,
        _cx: &mut App,
    ) {
        // 性能 HUD 打点：作用域结束（含提前返回）自动记录本次 paint 耗时
        // （docs/perf-analysis.md P1 的测量面；零锁原子，纳秒级开销）。
        let _paint_guard = PaintGuard::now();
        // Get terminal dimensions
        let grid = term.grid();
        let num_lines = grid.screen_lines();
        let num_cols = grid.columns();
        let colors = term.colors();
        // 回滚视口：display_offset > 0 时可见区从负行号开始（见
        // grid::display_iter 的约定），行索引需偏移才能渲染历史内容。
        let display_offset = grid.display_offset() as i32;

        // Calculate default background color
        let default_bg = self.palette.resolve(
            Color::Named(alacritty_terminal::vte::ansi::NamedColor::Background),
            colors,
        );
        let default_fg = self.palette.resolve(
            Color::Named(alacritty_terminal::vte::ansi::NamedColor::Foreground),
            colors,
        );

        // Paint default background (covers full bounds including padding)
        window.paint_quad(quad(
            bounds,
            px(0.0),
            default_bg,
            Edges::<Pixels>::default(),
            transparent_black(),
            Default::default(),
        ));

        // Calculate origin offset (content starts after padding)
        let origin = Point {
            x: bounds.origin.x + padding.left,
            y: bounds.origin.y + padding.top,
        };

        // Iterate over visible lines
        for line_idx in 0..num_lines {
            // 回滚偏移：line_idx 是屏幕行号，buffer 行号 = 屏幕行号 - offset
            let line = Line(line_idx as i32 - display_offset);

            // Collect cells for this line
            let cells: Vec<(usize, Cell)> = (0..num_cols)
                .map(|col_idx| {
                    let col = Column(col_idx);
                    let point = AlacPoint::new(line, col);
                    let cell = grid[point].clone();
                    (col_idx, cell)
                })
                .collect();

            // 一次布局同时产出背景段和批量文字段。
            let (backgrounds, text_runs) =
                self.layout_row(line_idx, cells.iter().cloned(), colors);

            // Paint backgrounds
            for bg_rect in backgrounds {
                // Skip if it's the default background color
                if bg_rect.color == default_bg {
                    continue;
                }

                let x = origin.x + self.cell_width * (bg_rect.start_col as f32);
                let y = origin.y + self.cell_height * (bg_rect.row as f32);
                let width = self.cell_width * ((bg_rect.end_col - bg_rect.start_col) as f32);
                let height = self.cell_height;

                let rect_bounds = Bounds {
                    origin: Point { x, y },
                    size: Size { width, height },
                };

                window.paint_quad(quad(
                    rect_bounds,
                    px(0.0),
                    bg_rect.color,
                    Edges::<Pixels>::default(),
                    transparent_black(),
                    Default::default(),
                ));
            }

            // Calculate vertical offset to center text in cell
            // The multiplier adds extra height; we want to distribute it evenly top/bottom
            let base_height = self.cell_height / self.line_height_multiplier;
            let vertical_offset = (self.cell_height - base_height) / 2.0;

            let y_base = origin.y + self.cell_height * (line_idx as f32);
            let cy = y_base + self.cell_height / 2.0;

            // Use cells vec for multiple passes (already collected above)
            let cells_vec = &cells;

            // First pass: find and draw horizontal spans of box-drawing characters
            // This draws continuous lines across multiple cells to avoid gaps
            let mut processed_horizontal: std::collections::HashSet<usize> = std::collections::HashSet::new();

            let mut i = 0;
            while i < cells_vec.len() {
                let (col_idx, ref cell) = cells_vec[i];
                let ch = cell.c;

                // Check if this starts a horizontal span
                if let Some(weight) = box_drawing::get_horizontal_weight(ch) {
                    let fg_color = self.palette.resolve(cell.fg, colors);
                    let start_col = col_idx;
                    let mut end_col = col_idx;

                    // Look ahead for consecutive cells with same horizontal weight
                    let mut j = i + 1;
                    while j < cells_vec.len() {
                        let (next_col, ref next_cell) = cells_vec[j];
                        // Must be adjacent
                        if next_col != end_col + 1 {
                            break;
                        }
                        // Must have same horizontal weight and same color
                        let next_fg = self.palette.resolve(next_cell.fg, colors);
                        if box_drawing::get_horizontal_weight(next_cell.c) == Some(weight)
                            && next_fg == fg_color
                        {
                            end_col = next_col;
                            j += 1;
                        } else {
                            break;
                        }
                    }

                    // Draw the horizontal span
                    let start_x = origin.x + self.cell_width * (start_col as f32);
                    let end_x = origin.x + self.cell_width * ((end_col + 1) as f32);

                    box_drawing::draw_horizontal_span(
                        start_x,
                        end_x,
                        cy,
                        weight,
                        self.cell_width,
                        fg_color,
                        window,
                    );

                    // Mark these columns as having horizontal drawn
                    for col in start_col..=end_col {
                        processed_horizontal.insert(col);
                    }

                    // Skip past this span
                    i = j;
                    continue;
                }
                i += 1;
            }

            // Second pass: draw vertical components and non-horizontal box chars
            for (col_idx, cell) in cells_vec.iter() {
                let ch = cell.c;

                if ch == ' ' || ch == '\0' {
                    continue;
                }

                let x = origin.x + self.cell_width * (*col_idx as f32);
                let fg_color = self.palette.resolve(cell.fg, colors);

                if box_drawing::is_box_drawing_char(ch) {
                    let cell_bounds = Bounds {
                        origin: Point { x, y: y_base },
                        size: Size {
                            width: self.cell_width,
                            height: self.cell_height,
                        },
                    };

                    if processed_horizontal.contains(col_idx) {
                        // Horizontal already drawn, just draw vertical components
                        box_drawing::draw_vertical_components(
                            ch,
                            cell_bounds,
                            fg_color,
                            self.cell_width,
                            window,
                        );
                    } else {
                        // Not part of a horizontal span, draw the whole character
                        box_drawing::draw_box_character(
                            ch,
                            cell_bounds,
                            fg_color,
                            self.cell_width,
                            window,
                        );
                    }
                    continue;
                }
            }

            // Third pass: 相邻同样式字符合并后一次 shape + paint。旧实现每字符
            // 一次 shape_line，一屏数百次；触控板滚动驱动连续 repaint 时会卡顿。
            for run in text_runs {
                // 无下划线的纯空格无需 shape（背景已在第一 pass 绘制）。
                if !run.underline && run.text.chars().all(|ch| ch == ' ') {
                    continue;
                }

                let x = origin.x + self.cell_width * (run.start_col as f32);
                let y = y_base + vertical_offset;
                let font = Font {
                    family: self.font_family.clone().into(),
                    features: FontFeatures::default(),
                    fallbacks: None,
                    weight: if run.bold {
                        FontWeight::BOLD
                    } else {
                        FontWeight::NORMAL
                    },
                    style: if run.italic {
                        FontStyle::Italic
                    } else {
                        FontStyle::Normal
                    },
                };
                let text_run = TextRun {
                    len: run.text.len(),
                    font,
                    color: run.fg_color,
                    background_color: None,
                    underline: if run.underline {
                        Some(UnderlineStyle {
                            thickness: px(1.0),
                            color: Some(run.fg_color),
                            wavy: false,
                        })
                    } else {
                        None
                    },
                    strikethrough: None,
                };
                let text: SharedString = run.text.into();
                let shaped_line = window.text_system().shape_line(
                    text,
                    self.font_size,
                    &[text_run],
                    Some(self.cell_width),
                );
                let _ = shaped_line.paint(
                    Point { x, y },
                    self.cell_height,
                    gpui::TextAlign::Left,
                    None,
                    window,
                    _cx,
                );
            }
        }

        // 光标位置提前取出：IME 组合文本与硬件光标都要用。
        let cursor_point = grid.cursor.point;

        // IME 组合文本：画在光标处并盖住身后内容；组合期间不画硬件光标
        // （与 Zed 终端一致，避免双重光标）。
        if let Some(marked) = marked_text
            && !marked.is_empty()
        {
            self.paint_marked_text(
                marked,
                origin,
                cursor_point,
                display_offset,
                default_bg,
                default_fg,
                window,
                _cx,
            );
            return;
        }

        // Cursor: TUI 隐光标（DECSET 25 关，SHOW_CURSOR 位）时不画；
        // 闪烁 off 相位也返回。否则会在 TUI 界面上留下一个实心黑块。
        if !self.cursor_visible || !term.mode().contains(TermMode::SHOW_CURSOR) {
            return;
        }
        // 光标行号也要叠加回滚偏移；滚出可见区就不画。
        let cursor_row = cursor_point.line.0 + display_offset;
        if cursor_row < 0 || cursor_row as usize >= num_lines {
            return;
        }
        let cursor_x = origin.x + self.cell_width * (cursor_point.column.0 as f32);
        let cursor_y = origin.y + self.cell_height * (cursor_row as f32);

        let cursor_color = self.palette.resolve(
            Color::Named(alacritty_terminal::vte::ansi::NamedColor::Cursor),
            colors,
        );

        let cursor_bounds = Bounds {
            origin: Point {
                x: cursor_x,
                y: cursor_y,
            },
            size: Size {
                width: self.cell_width,
                height: self.cell_height,
            },
        };

        window.paint_quad(quad(
            cursor_bounds,
            px(0.0),
            cursor_color,
            Edges::<Pixels>::default(),
            transparent_black(),
            Default::default(),
        ));

        // 块光标反色：quad 盖住了光标处字形，用默认背景色重画一次该字符，
        // 等效传统终端的块光标反色效果（空格/制图字符无需重画）。
        let cell = grid[cursor_point].clone();
        let ch = cell.c;
        if ch != ' ' && ch != '\0' && !box_drawing::is_box_drawing_char(ch) {
            let font = Font {
                family: self.font_family.clone().into(),
                features: FontFeatures::default(),
                fallbacks: None,
                weight: if cell.flags.contains(Flags::BOLD) {
                    FontWeight::BOLD
                } else {
                    FontWeight::NORMAL
                },
                style: if cell.flags.contains(Flags::ITALIC) {
                    FontStyle::Italic
                } else {
                    FontStyle::Normal
                },
            };
            let char_str = ch.to_string();
            let text_run = TextRun {
                len: char_str.len(),
                font,
                color: default_bg,
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            let text: SharedString = char_str.into();
            let shaped_line =
                window
                    .text_system()
                    .shape_line(text, self.font_size, &[text_run], None);
            // 与第三 pass 相同的垂直居中偏移
            let base_height = self.cell_height / self.line_height_multiplier;
            let vertical_offset = (self.cell_height - base_height) / 2.0;
            let _ = shaped_line.paint(
                Point {
                    x: cursor_x,
                    y: cursor_y + vertical_offset,
                },
                self.cell_height,
                gpui::TextAlign::Left,
                None,
                window,
                _cx,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_renderer_creation() {
        let renderer = TerminalRenderer::new(
            "Fira Code".to_string(),
            px(14.0),
            1.0,
            ColorPalette::default(),
        );
        assert_eq!(renderer.font_family, "Fira Code");
        assert_eq!(renderer.font_size, px(14.0));
        assert_eq!(renderer.line_height_multiplier, 1.0);
    }

    #[test]
    fn test_layout_row_splits_text_around_custom_drawn_box_characters() {
        let renderer = TerminalRenderer::new(
            "Menlo".to_string(),
            px(14.0),
            1.0,
            ColorPalette::default(),
        );
        let cells = "ab│cd"
            .chars()
            .enumerate()
            .map(|(col, c)| (col, Cell { c, ..Cell::default() }));
        let (_, runs) = renderer.layout_row(0, cells, &Colors::default());
        let texts: Vec<&str> = runs.iter().map(|run| run.text.as_str()).collect();
        assert_eq!(texts, vec!["ab", "cd"]);
    }

    #[test]
    fn test_layout_row_inverts_fg_bg_for_sgr7_cells() {
        // pi 等 TUI 用反色 cell 画软光标/选中块：SGR 7 必须交换 fg/bg，
        // 否则光标块在深色主题下不可见。
        let renderer = TerminalRenderer::new(
            "Menlo".to_string(),
            px(14.0),
            1.0,
            ColorPalette::default(),
        );
        let plain = Cell { c: 'a', ..Cell::default() };
        let mut inverted = Cell { c: ' ', ..Cell::default() };
        inverted.flags.insert(Flags::INVERSE);

        // 空格不进文字 run，但背景段必须存在且颜色被交换（= 前景色）
        let (backgrounds, runs) = renderer.layout_row(
            0,
            vec![(0, plain), (1, inverted)].into_iter(),
            &Colors::default(),
        );
        assert_eq!(backgrounds.len(), 2, "反色 cell 背景与默认背景不同，应独立成段");
        assert_ne!(backgrounds[0].color, backgrounds[1].color);
        let _ = runs;
    }

    #[test]
    fn test_layout_row_batches_plain_text_and_skips_wide_spacer() {
        let renderer = TerminalRenderer::new(
            "Menlo".to_string(),
            px(14.0),
            1.0,
            ColorPalette::default(),
        );
        let mut wide = Cell { c: '中', ..Cell::default() };
        wide.flags.insert(Flags::WIDE_CHAR);
        let mut spacer = Cell::default();
        spacer.flags.insert(Flags::WIDE_CHAR_SPACER);
        let mut cells = vec![(0, wide), (1, spacer), (2, Cell { c: 'x', ..Cell::default() })];
        cells.extend((3..80).map(|col| (col, Cell { c: 'a', ..Cell::default() })));

        let (_, runs) = renderer.layout_row(0, cells.into_iter(), &Colors::default());
        assert_eq!(runs.len(), 2, "宽字符单独 shape，后续 ASCII 合为一个 run");
        assert_eq!(runs[0].text, "中");
        assert_eq!(runs[1].text, format!("x{}", "a".repeat(77)));
    }

    #[test]
    fn test_background_rect_merge() {
        let black = Hsla::black();

        let rect1 = BackgroundRect {
            start_col: 0,
            end_col: 5,
            row: 0,
            color: black,
        };

        let rect2 = BackgroundRect {
            start_col: 5,
            end_col: 10,
            row: 0,
            color: black,
        };

        assert!(rect1.can_merge_with(&rect2));

        let rect3 = BackgroundRect {
            start_col: 5,
            end_col: 10,
            row: 1,
            color: black,
        };

        assert!(!rect1.can_merge_with(&rect3));
    }

    #[test]
    fn test_merge_backgrounds() {
        let renderer = TerminalRenderer::new(
            "monospace".to_string(),
            px(14.0),
            1.0,
            ColorPalette::default(),
        );
        let black = Hsla::black();

        let rects = vec![
            BackgroundRect {
                start_col: 0,
                end_col: 5,
                row: 0,
                color: black,
            },
            BackgroundRect {
                start_col: 5,
                end_col: 10,
                row: 0,
                color: black,
            },
        ];

        let merged = renderer.merge_backgrounds(rects);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].start_col, 0);
        assert_eq!(merged[0].end_col, 10);
    }
}
