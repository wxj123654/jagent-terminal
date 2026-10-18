//! 终端超链接与文件路径探测（Zed 风格：OSC 8 显式超链接 + 按需逻辑行扫描 + 磁盘校验）。
//!
//! 识别双通道：
//! 1. **OSC 8 显式超链接**：直接读取 `alacritty_terminal::term::cell::Cell::hyperlink()`，
//!    支持 `http(s)://` 与 `file://` URI。
//! 2. **逻辑行隐式探测**：跨 `Flags::WRAPLINE` 软折行拼合当前逻辑行，提取鼠标所在位置的
//!    URL 或文件路径候选（支持 `:line:col`、`#Lline`、`(line,col)`、`File "...", line N`、
//!    `~/...`、`git diff` 的 `a/`/`b/` 前缀），并结合会话 `cwd` 做 `is_file()` 磁盘存在性校验，
//!    确保普通斜杠词（如 `yes/no`、`UTF-8`）零误报。

use std::ops::Range;
use std::path::{Component, Path, PathBuf};

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point as AlacPoint};
use alacritty_terminal::term::cell::{Flags, LineLength};

use crate::model::AlacTerm;
use crate::view::box_drawing;

/// 逻辑行向上/向下跨越 `WRAPLINE` 的最大安全行数，防止极端单行超长输出卡顿。
const MAX_WRAPPED_LINES: i32 = 16;

/// 终端内可点击链接的解析目标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalLinkTarget {
    /// 本地文件路径（已解析为干净的绝对路径并完成存在性校验）及可选的 1-based 行列号。
    File {
        path: PathBuf,
        line: Option<u32>,
        column: Option<u32>,
    },
    /// Web URL（`http://` 或 `https://`）。
    Url(String),
}

/// 当前鼠标悬停命中的终端链接（含网格起止坐标与打开目标）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoveredLink {
    /// 起始网格坐标（buffer 行号，历史区为负数）。
    pub start: AlacPoint,
    /// 结束网格坐标（包含该单元格；若末尾为宽字符，包含其 spacer 格）。
    pub end: AlacPoint,
    /// 链接目标。
    pub target: TerminalLinkTarget,
}

impl HoveredLink {
    /// 判断网格点是否落在该链接范围内。
    pub fn contains(&self, point: AlacPoint) -> bool {
        point >= self.start && point <= self.end
    }

    /// 计算在指定 buffer 行上应绘制下划线的列范围 `[start_col, end_col)`（左闭右开）。
    pub fn cols_for_line(&self, line: Line, num_cols: usize) -> Option<(usize, usize)> {
        if line < self.start.line || line > self.end.line || num_cols == 0 {
            return None;
        }
        let start_col = if line == self.start.line {
            self.start.column.0
        } else {
            0
        };
        let end_col = if line == self.end.line {
            (self.end.column.0 + 1).min(num_cols)
        } else {
            num_cols
        };
        (start_col < end_col).then_some((start_col, end_col))
    }
}

/// 逻辑行中单个字符与终端网格坐标的映射项。
#[derive(Clone, Debug)]
struct MappedChar {
    byte_range: Range<usize>,
    start_point: AlacPoint,
    end_point: AlacPoint,
    ch: char,
}

/// 在终端网格指定坐标 `point` 处探测可点击链接（OSC 8 优先，回退逻辑行隐式扫描）。
pub fn detect_link_at_point(
    term: &AlacTerm,
    mut point: AlacPoint,
    cwd: Option<&Path>,
) -> Option<HoveredLink> {
    let grid = term.grid();
    if point.line < grid.topmost_line()
        || point.line > grid.bottommost_line()
        || point.column.0 >= grid.columns()
    {
        return None;
    }

    // 若鼠标落在宽字符的右半格（WIDE_CHAR_SPACER），对齐到左半格主字符。
    if grid[point].flags.contains(Flags::WIDE_CHAR_SPACER) && point.column.0 > 0 {
        point.column.0 -= 1;
    }

    // 1. 优先检查 OSC 8 显式超链接。
    if let Some(link) = detect_osc8_link(term, point, cwd) {
        return Some(link);
    }

    // 2. 隐式逻辑行扫描：若鼠标在当前行有效内容右侧的纯空白区且未软折行，直接短路返回。
    let row = &grid[point.line];
    if !row[grid.last_column()].flags.contains(Flags::WRAPLINE) && point.column >= row.line_length()
    {
        return None;
    }

    detect_implicit_link(term, point, cwd)
}

/// 探测 OSC 8 显式超链接（`Cell::hyperlink()`）。
fn detect_osc8_link(term: &AlacTerm, point: AlacPoint, cwd: Option<&Path>) -> Option<HoveredLink> {
    let grid = term.grid();
    let hyperlink = grid[point].hyperlink()?;
    let target = parse_osc8_uri(hyperlink.uri(), cwd)?;

    let min_line = (point.line - MAX_WRAPPED_LINES).max(grid.topmost_line());
    let max_line = (point.line + MAX_WRAPPED_LINES).min(grid.bottommost_line());
    let last_col = grid.last_column();

    // 向左/向上扩展同一 hyperlink
    let mut start = point;
    loop {
        let prev = if start.column.0 > 0 {
            Some(AlacPoint::new(start.line, Column(start.column.0 - 1)))
        } else if start.line > min_line
            && grid[start.line - 1i32][last_col]
                .flags
                .contains(Flags::WRAPLINE)
        {
            Some(AlacPoint::new(start.line - 1i32, last_col))
        } else {
            None
        };
        match prev {
            Some(p) if grid[p].hyperlink().as_ref() == Some(&hyperlink) => start = p,
            _ => break,
        }
    }

    // 向右/向下扩展同一 hyperlink
    let mut end = point;
    loop {
        let next = if end.column < last_col {
            Some(AlacPoint::new(end.line, Column(end.column.0 + 1)))
        } else if end.line < max_line && grid[end.line][last_col].flags.contains(Flags::WRAPLINE) {
            Some(AlacPoint::new(end.line + 1i32, Column(0)))
        } else {
            None
        };
        match next {
            Some(p) if grid[p].hyperlink().as_ref() == Some(&hyperlink) => end = p,
            _ => break,
        }
    }

    Some(HoveredLink { start, end, target })
}

/// 解析 OSC 8 URI（支持 `http(s)://` 与 `file://`）。
fn parse_osc8_uri(uri: &str, cwd: Option<&Path>) -> Option<TerminalLinkTarget> {
    let trimmed = uri.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Some(TerminalLinkTarget::Url(trimmed.to_owned()));
    }
    if let Some(rest) = trimmed.strip_prefix("file://") {
        // file://hostname/path 或 file:///path
        let path_part = if rest.starts_with('/') {
            rest
        } else {
            let slash_idx = rest.find('/')?;
            &rest[slash_idx..]
        };
        // Windows 兼容：file:///C:/foo/bar -> C:/foo/bar
        let path_part = if path_part.len() >= 3
            && path_part.as_bytes()[0] == b'/'
            && path_part.as_bytes()[1].is_ascii_alphabetic()
            && path_part.as_bytes()[2] == b':'
        {
            &path_part[1..]
        } else {
            path_part
        };
        let decoded = percent_decode(path_part);
        let (clean_str, line, column) = split_path_and_line_col(&decoded);
        if let Some(path) =
            resolve_existing_file(clean_str, cwd).or_else(|| resolve_existing_file(&decoded, cwd))
        {
            return Some(TerminalLinkTarget::File { path, line, column });
        }
        // 即便文件尚未落盘，显式 file:// URI 若是绝对路径也可直接构造
        let fallback = normalize_path(Path::new(clean_str));
        if fallback.is_absolute() {
            return Some(TerminalLinkTarget::File {
                path: fallback,
                line,
                column,
            });
        }
    }
    None
}

/// 跨 `WRAPLINE` 构建当前逻辑行并探测鼠标点处的 URL 或文件路径。
fn detect_implicit_link(
    term: &AlacTerm,
    point: AlacPoint,
    cwd: Option<&Path>,
) -> Option<HoveredLink> {
    let grid = term.grid();
    let num_cols = grid.columns();
    if num_cols == 0 {
        return None;
    }
    let last_col = grid.last_column();
    let min_line = (point.line - MAX_WRAPPED_LINES).max(grid.topmost_line());
    let max_line = (point.line + MAX_WRAPPED_LINES).min(grid.bottommost_line());

    let mut start_line = point.line;
    while start_line > min_line
        && grid[start_line - 1i32][last_col]
            .flags
            .contains(Flags::WRAPLINE)
    {
        start_line -= 1i32;
    }

    let mut end_line = point.line;
    while end_line < max_line && grid[end_line][last_col].flags.contains(Flags::WRAPLINE) {
        end_line += 1i32;
    }

    let mut text = String::new();
    let mut mapped: Vec<MappedChar> = Vec::new();
    let mut hovered_idx: Option<usize> = None;

    for line_i32 in start_line.0..=end_line.0 {
        let line = Line(line_i32);
        let row = &grid[line];
        let row_cols = if line < end_line || row[last_col].flags.contains(Flags::WRAPLINE) {
            num_cols
        } else {
            row.line_length().0
        };

        for col_idx in 0..row_cols {
            let cell_point = AlacPoint::new(line, Column(col_idx));
            let cell = &row[Column(col_idx)];
            if cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                continue;
            }
            let ch = if cell.c == '\0' { ' ' } else { cell.c };
            let end_point = if cell.flags.contains(Flags::WIDE_CHAR) && col_idx + 1 < num_cols {
                AlacPoint::new(line, Column(col_idx + 1))
            } else {
                cell_point
            };

            let byte_start = text.len();
            text.push(ch);
            let byte_end = text.len();

            if point >= cell_point && point <= end_point {
                hovered_idx = Some(mapped.len());
            }

            mapped.push(MappedChar {
                byte_range: byte_start..byte_end,
                start_point: cell_point,
                end_point,
                ch,
            });
        }
    }

    let hovered_idx = hovered_idx?;
    let hovered_byte = mapped[hovered_idx].byte_range.start;

    // 1. 常规非空白/非边框 Token 切分（覆盖 99% 的 URL 与路径）。
    if !is_hard_delimiter(mapped[hovered_idx].ch) {
        let mut left = hovered_idx;
        while left > 0 && !is_hard_delimiter(mapped[left - 1].ch) {
            left -= 1;
        }
        let mut right = hovered_idx + 1;
        while right < mapped.len() && !is_hard_delimiter(mapped[right].ch) {
            right += 1;
        }

        let span_bytes = mapped[left].byte_range.start..mapped[right - 1].byte_range.end;
        if let Some(link) = try_match_span(&text, span_bytes, hovered_byte, &mapped, cwd) {
            return Some(link);
        }
    }

    // 2. 引号内路径回退（支持带空格的引号包裹路径，如 `"dir with spaces/main.rs:12"`）。
    if let Some(quoted_bytes) = find_enclosing_quotes(&text, hovered_byte)
        && let Some(link) = try_match_span(&text, quoted_bytes, hovered_byte, &mapped, cwd)
    {
        return Some(link);
    }

    None
}

/// 终端硬分隔符：空白符、引号、尖括号、制表框线及常见全角标点。
fn is_hard_delimiter(ch: char) -> bool {
    ch.is_whitespace()
        || ch.is_control()
        || matches!(
            ch,
            '"' | '\''
                | '`'
                | '<'
                | '>'
                | '，'
                | '。'
                | '；'
                | '！'
                | '？'
                | '、'
                | '（'
                | '）'
                | '【'
                | '】'
                | '「'
                | '」'
                | '『'
                | '』'
                | '《'
                | '》'
                | '·'
                | '•'
        )
        || box_drawing::is_box_drawing_char(ch)
}

/// 在给定字节区间 `span` 内尝试识别覆盖 `hovered_byte` 的 URL 或本地文件路径。
fn try_match_span(
    full_text: &str,
    span: Range<usize>,
    hovered_byte: usize,
    mapped: &[MappedChar],
    cwd: Option<&Path>,
) -> Option<HoveredLink> {
    let raw = &full_text[span.clone()];

    // A. 先检查是否包含 http:// 或 https:// URL
    if let Some(url_rel) = raw.find("https://").or_else(|| raw.find("http://")) {
        let url_start = span.start + url_rel;
        let trimmed_url = trim_url_suffix(&full_text[url_start..span.end]);
        let url_end = url_start + trimmed_url.len();
        if hovered_byte >= url_start && hovered_byte < url_end && trimmed_url.len() > 8 {
            let (start, end) = byte_range_to_points(url_start..url_end, mapped)?;
            return Some(HoveredLink {
                start,
                end,
                target: TerminalLinkTarget::Url(trimmed_url.to_owned()),
            });
        }
    }

    // B. 修剪候选路径外围括号与尾随句末标点
    let trimmed_range = trim_path_span(full_text, span);
    if hovered_byte < trimmed_range.start || hovered_byte >= trimmed_range.end {
        return None;
    }
    let candidate = &full_text[trimmed_range.clone()];
    if candidate.is_empty() || candidate.len() > 1024 || candidate.contains("://") {
        return None;
    }

    // C. 分离路径主体与可选的 :line:col / (line,col) / #Lline 后缀
    let (path_part, mut line, column) = split_path_and_line_col(candidate);

    // Python Traceback 风格补充：File "path/to/file.py", line 42
    if line.is_none() {
        line = extract_trailing_python_line(&full_text[trimmed_range.end..]);
    }

    if !looks_like_path_candidate(path_part, line.is_some()) {
        return None;
    }

    // D. 校验文件是否存在（若剥离 :line 后不存在，回退尝试完整 candidate）
    if let Some(resolved) = resolve_existing_file(path_part, cwd) {
        let (start, end) = byte_range_to_points(trimmed_range, mapped)?;
        return Some(HoveredLink {
            start,
            end,
            target: TerminalLinkTarget::File {
                path: resolved,
                line,
                column,
            },
        });
    }

    if line.is_some()
        && looks_like_path_candidate(candidate, false)
        && let Some(resolved) = resolve_existing_file(candidate, cwd)
    {
        let (start, end) = byte_range_to_points(trimmed_range, mapped)?;
        return Some(HoveredLink {
            start,
            end,
            target: TerminalLinkTarget::File {
                path: resolved,
                line: None,
                column: None,
            },
        });
    }

    None
}

/// 修剪 URL 尾部的句末标点与未配对右括号。
fn trim_url_suffix(mut s: &str) -> &str {
    loop {
        if let Some(stripped) = s.strip_suffix(['.', ',', ';', ':', '!', '?']) {
            s = stripped;
            continue;
        }
        if s.ends_with(')')
            && s.chars().filter(|&c| c == '(').count() < s.chars().filter(|&c| c == ')').count()
        {
            s = &s[..s.len() - 1];
            continue;
        }
        if s.ends_with(']')
            && s.chars().filter(|&c| c == '[').count() < s.chars().filter(|&c| c == ']').count()
        {
            s = &s[..s.len() - 1];
            continue;
        }
        if s.ends_with('}')
            && s.chars().filter(|&c| c == '{').count() < s.chars().filter(|&c| c == '}').count()
        {
            s = &s[..s.len() - 1];
            continue;
        }
        break;
    }
    s
}

/// 修剪候选路径外围的配对括号与尾随标点，返回修剪后的字节区间。
fn trim_path_span(full_text: &str, mut span: Range<usize>) -> Range<usize> {
    while span.start < span.end {
        let s = &full_text[span.clone()];
        // 剥离成对外围括号：(src/main.rs:10) 或 [src/main.rs]
        if (s.starts_with('(') && s.ends_with(')'))
            || (s.starts_with('[') && s.ends_with(']'))
            || (s.starts_with('{') && s.ends_with('}'))
        {
            span.start += 1;
            span.end -= 1;
            continue;
        }
        // 剥离孤立的前导左括号：如 `(src/main.rs:10,`
        if s.starts_with(['(', '[', '{']) {
            span.start += 1;
            continue;
        }
        // 剥离尾随标点：如 `src/main.rs:10:5:`、`src/main.rs,`、`src/main.rs;`
        if s.ends_with([',', ';', ':']) {
            span.end -= 1;
            continue;
        }
        // 剥离尾随句号（保留 `.` 与 `..`）
        if s.ends_with('.') && s != "." && s != ".." {
            span.end -= 1;
            continue;
        }
        // 剥离未配对的尾随右括号（保留 `foo.ts(10,5)` 的配对括号）
        if s.ends_with(')') && !s.contains('(') {
            span.end -= 1;
            continue;
        }
        if s.ends_with([']', '}']) {
            span.end -= 1;
            continue;
        }
        break;
    }
    span
}

/// 拆分路径主体与末尾可选的行列号后缀：
/// - `path/to/file.rs:120:15` / `path/to/file.rs:120`
/// - `path/to/file.ts(120,15)` / `path/to/file.ts(120)`
/// - `path/to/file.rs#L120C15` / `path/to/file.rs#L120`
pub fn split_path_and_line_col(input: &str) -> (&str, Option<u32>, Option<u32>) {
    // 1. 检查 TypeScript / MSBuild 风格：path(line,col) 或 path(line)
    if let Some(without_close) = input.strip_suffix(')')
        && let Some(open_idx) = without_close.rfind('(')
        && open_idx > 0
    {
        let inside = &without_close[open_idx + 1..];
        let path_part = &without_close[..open_idx];
        if let Some((l_str, c_str)) = inside.split_once(',') {
            if let (Ok(l), Ok(c)) = (l_str.trim().parse::<u32>(), c_str.trim().parse::<u32>())
                && l > 0
            {
                return (path_part, Some(l), (c > 0).then_some(c));
            }
        } else if let Ok(l) = inside.trim().parse::<u32>()
            && l > 0
        {
            return (path_part, Some(l), None);
        }
    }

    // 2. 检查 GitHub / Markdown 锚点风格：path#L120C15 或 path#L120
    if let Some(hash_idx) = input.rfind("#L")
        && hash_idx > 0
    {
        let tail = &input[hash_idx + 2..];
        let path_part = &input[..hash_idx];
        if let Some((l_str, c_str)) = tail.split_once('C') {
            if let (Ok(l), Ok(c)) = (l_str.parse::<u32>(), c_str.parse::<u32>())
                && l > 0
            {
                return (path_part, Some(l), (c > 0).then_some(c));
            }
        } else if let Ok(l) = tail.parse::<u32>()
            && l > 0
        {
            return (path_part, Some(l), None);
        }
    }

    // 3. 检查标准冒号风格：path:line:col 或 path:line
    if let Some((before_last, last_seg)) = input.rsplit_once(':')
        && !before_last.is_empty()
        && !is_windows_drive_prefix(before_last)
        && let Ok(last_num) = last_seg.parse::<u32>()
        && last_num > 0
    {
        // 再向前看一段是否也是 `:line`
        if let Some((before_second, second_seg)) = before_last.rsplit_once(':')
            && !before_second.is_empty()
            && !is_windows_drive_prefix(before_second)
            && let Ok(line_num) = second_seg.parse::<u32>()
            && line_num > 0
        {
            return (before_second, Some(line_num), Some(last_num));
        }
        return (before_last, Some(last_num), None);
    }

    (input, None, None)
}

/// 判断是否仅为 Windows 盘符前缀（如 `"C"`），避免把 `C:123` 误拆。
fn is_windows_drive_prefix(s: &str) -> bool {
    s.len() == 1 && s.as_bytes()[0].is_ascii_alphabetic()
}

/// 提取紧随路径之后的 Python Traceback 行号（如 `", line 42` 或 `, line 42`）。
fn extract_trailing_python_line(after: &str) -> Option<u32> {
    let s = after.trim_start_matches(['"', '\'']);
    let s = s.strip_prefix(',')?.trim_start();
    let s = s.strip_prefix("line ")?.trim_start();
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u32>().ok().filter(|&n| n > 0)
}

/// 查找包含 `hovered_byte` 的最小单/双引号包裹区间（不含引号本身）。
fn find_enclosing_quotes(text: &str, hovered_byte: usize) -> Option<Range<usize>> {
    for quote in ['"', '\''] {
        let before = &text[..hovered_byte];
        let after = &text[hovered_byte..];
        if let (Some(l_off), Some(r_rel)) = (before.rfind(quote), after.find(quote)) {
            let start = l_off + 1;
            let end = hovered_byte + r_rel;
            if start < end && (end - start) <= 512 {
                return Some(start..end);
            }
        }
    }
    None
}

/// 快速启发式预筛：排除纯数字、`.`/`..` 及毫无路径特征的普通英文单词，避免无谓的 `fs::metadata`。
fn looks_like_path_candidate(s: &str, has_line_suffix: bool) -> bool {
    if s.is_empty() || s == "." || s == ".." || s == "~" {
        return false;
    }
    // 排除纯数字（例如时间戳 `14:23:09` 拆完剩 `14`）
    if s.chars().all(|c| c.is_ascii_digit() || c == ':') {
        return false;
    }
    // 含路径分隔符
    if s.contains('/') || s.contains('\\') {
        return true;
    }
    // 含明确的行号后缀（如 `Makefile:10`、`main.rs:20`）
    if has_line_suffix {
        return true;
    }
    // 含扩展名点号（如 `Cargo.toml`、`README.md`、`.gitignore`）且点号后有字母
    if let Some((_, ext)) = s.rsplit_once('.')
        && !ext.is_empty()
        && ext.chars().any(|c| c.is_ascii_alphabetic())
    {
        return true;
    }
    // 常见无扩展名工程文件
    matches!(
        s,
        "Makefile" | "Dockerfile" | "LICENSE" | "Justfile" | "Procfile" | "Brewfile"
    )
}

/// 结合 `cwd` 将候选路径解析为真实存在的本地文件路径（`is_file()` 为真才返回）。
pub fn resolve_existing_file(raw_path: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    let expanded = expand_tilde(raw_path)?;
    let path = Path::new(&expanded);

    if path.is_absolute() {
        let norm = normalize_path(path);
        return is_existing_file(&norm).then_some(norm);
    }

    let base_owned;
    let base: &Path = match cwd {
        Some(c) => c,
        None => {
            base_owned = std::env::current_dir().ok()?;
            &base_owned
        }
    };

    // 1. 直接相对 cwd 拼接
    let joined = normalize_path(&base.join(path));
    if is_existing_file(&joined) {
        return Some(joined);
    }

    // 2. Git diff `a/...` 或 `b/...` 前缀自动剥离回退
    if let Some(stripped) = raw_path
        .strip_prefix("a/")
        .or_else(|| raw_path.strip_prefix("b/"))
        .or_else(|| raw_path.strip_prefix("a\\"))
        .or_else(|| raw_path.strip_prefix("b\\"))
        && !stripped.is_empty()
    {
        let diff_joined = normalize_path(&base.join(stripped));
        if is_existing_file(&diff_joined) {
            return Some(diff_joined);
        }
    }

    None
}

fn is_existing_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file())
}

/// 展开 `~/...` 为用户主目录路径。
fn expand_tilde(raw: &str) -> Option<String> {
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
        let mut buf = PathBuf::from(home);
        buf.push(rest);
        Some(buf.to_string_lossy().into_owned())
    } else {
        Some(raw.to_owned())
    }
}

/// 纯语法消解 `.` 与 `..` 组件（不调 `fs::canonicalize`，避免解开符号链接或 Windows `\\?\` 前缀污染展示）。
pub fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(
                    out.components().next_back(),
                    Some(Component::RootDir | Component::Prefix(_)) | None
                ) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 将逻辑行字节范围映射回起止网格坐标 `AlacPoint`。
fn byte_range_to_points(
    range: Range<usize>,
    mapped: &[MappedChar],
) -> Option<(AlacPoint, AlacPoint)> {
    let first = mapped.iter().find(|m| m.byte_range.end > range.start)?;
    let last = mapped
        .iter()
        .rev()
        .find(|m| m.byte_range.start < range.end)?;
    (first.start_point <= last.end_point).then_some((first.start_point, last.end_point))
}

/// 轻量级 URL 百分号解码（`%20` → `' '` 等）。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2]))
        {
            out.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{SessionListener, TermDimensions};
    use alacritty_terminal::term::{Config as TermConfig, Term};
    use std::fs;

    fn make_test_term(cols: usize, rows: usize, text: &str) -> AlacTerm {
        let (tx, _rx) = futures::channel::mpsc::unbounded();
        let dims = TermDimensions::new(cols, rows);
        let mut term = Term::new(TermConfig::default(), &dims, SessionListener::new(tx));
        let mut processor: alacritty_terminal::vte::ansi::Processor = Default::default();
        processor.advance(&mut term, text.as_bytes());
        term
    }

    #[test]
    fn split_path_and_line_col_handles_colon_parens_and_anchors() {
        assert_eq!(
            split_path_and_line_col("crates/jagent-app/src/main.rs:42:10"),
            ("crates/jagent-app/src/main.rs", Some(42), Some(10))
        );
        assert_eq!(
            split_path_and_line_col("src/lib.rs:108"),
            ("src/lib.rs", Some(108), None)
        );
        assert_eq!(
            split_path_and_line_col("src/components/panes.tsx(496,17)"),
            ("src/components/panes.tsx", Some(496), Some(17))
        );
        assert_eq!(
            split_path_and_line_col("src/components/panes.tsx(496)"),
            ("src/components/panes.tsx", Some(496), None)
        );
        assert_eq!(
            split_path_and_line_col("README.md#L25C4"),
            ("README.md", Some(25), Some(4))
        );
    }

    #[test]
    fn detect_link_finds_existing_relative_file_with_line_and_col() {
        let dir = tempfile::tempdir().unwrap();
        let src_dir = dir.path().join("src");
        fs::create_dir_all(&src_dir).unwrap();
        let file_path = src_dir.join("main.rs");
        fs::write(&file_path, "fn main() {}\n").unwrap();

        let term = make_test_term(80, 24, "  --> src/main.rs:12:5:\r\n");
        // "src/main.rs:12:5" 位于列 6..=21（末尾冒号在 22 被修剪）
        let link =
            detect_link_at_point(&term, AlacPoint::new(Line(0), Column(10)), Some(dir.path()))
                .expect("should detect relative file path");

        assert_eq!(link.start, AlacPoint::new(Line(0), Column(6)));
        assert_eq!(link.end, AlacPoint::new(Line(0), Column(21)));
        assert_eq!(
            link.target,
            TerminalLinkTarget::File {
                path: normalize_path(&file_path),
                line: Some(12),
                column: Some(5),
            }
        );
    }

    #[test]
    fn detect_link_ignores_nonexistent_slash_words() {
        let dir = tempfile::tempdir().unwrap();
        let term = make_test_term(80, 24, "Proceed? [yes/no] http/1.1 12:34:56\r\n");

        for col in 0..35 {
            assert!(
                detect_link_at_point(
                    &term,
                    AlacPoint::new(Line(0), Column(col)),
                    Some(dir.path())
                )
                .is_none(),
                "col {col} should not be a false positive"
            );
        }
    }

    #[test]
    fn detect_link_supports_git_diff_a_b_prefixes_and_wrapped_lines() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("crates/jagent-app/src/views");
        fs::create_dir_all(&nested).unwrap();
        let target_file = nested.join("root.rs");
        fs::write(&target_file, "// root\n").unwrap();

        // 窄终端（24 列）：长路径自动软折行跨越多行
        let term = make_test_term(24, 10, "--- a/crates/jagent-app/src/views/root.rs:88\r\n");
        // 在第二行（Line(1)）点击也能识别完整跨行链接
        let link =
            detect_link_at_point(&term, AlacPoint::new(Line(1), Column(4)), Some(dir.path()))
                .expect("should detect wrapped git diff path");

        assert_eq!(link.start, AlacPoint::new(Line(0), Column(4)));
        assert_eq!(link.end, AlacPoint::new(Line(1), Column(19)));
        assert_eq!(
            link.target,
            TerminalLinkTarget::File {
                path: normalize_path(&target_file),
                line: Some(88),
                column: None,
            }
        );
        // 验证跨行下划线列范围计算
        assert_eq!(link.cols_for_line(Line(0), 24), Some((4, 24)));
        assert_eq!(link.cols_for_line(Line(1), 24), Some((0, 20)));
    }

    #[test]
    fn detect_link_supports_osc8_hyperlinks_and_https_urls() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("Cargo.toml");
        fs::write(&file_path, "[package]\n").unwrap();

        let osc8 = format!(
            "\x1b]8;;file://{}:15\x1b\\Cargo.toml\x1b]8;;\x1b\\ and (https://zed.dev/docs).",
            file_path.display()
        );
        let term = make_test_term(80, 24, &osc8);

        let file_link =
            detect_link_at_point(&term, AlacPoint::new(Line(0), Column(2)), Some(dir.path()))
                .expect("should detect OSC 8 file link");
        assert_eq!(file_link.start, AlacPoint::new(Line(0), Column(0)));
        assert_eq!(file_link.end, AlacPoint::new(Line(0), Column(9)));
        assert_eq!(
            file_link.target,
            TerminalLinkTarget::File {
                path: normalize_path(&file_path),
                line: Some(15),
                column: None,
            }
        );

        // "(https://zed.dev/docs)." 中 URL 从列 16 开始，末尾 ")." 被自动修剪
        let url_link =
            detect_link_at_point(&term, AlacPoint::new(Line(0), Column(22)), Some(dir.path()))
                .expect("should detect https URL");
        assert_eq!(
            url_link.target,
            TerminalLinkTarget::Url("https://zed.dev/docs".to_owned())
        );
    }
}
