//! 设计 token → gpui-component 主题。
//!
//! 来源：旧 `packages/ui/src/theme/tokens.ts`（值取自 React 原型定稿板，逐 hex 对账过）。
//! 暗色只此一套（亮色本期不做）。
//!
//! gpui-component 的主题是 JSON `ThemeConfig`（点号键，如 `"primary.background"`）。
//! 这里生成该 JSON 再交给 `ThemeRegistry::load_themes_from_str` + `Theme::apply_config`，
//! 避免手写 `ThemeColor` 的几十个字段：未写的键由 gpui-component 按暗色默认值回退。
//!
//! 项目特有、gpui-component 没有对应键的 token（状态灯四态 / tile / tabStrip / acpKind 等）
//! 放进 [`Tokens`]，作为 app 级 `Global` 提供，视图用 `cx.global::<Tokens>()` 取。

use gpui::{Global, Hsla, Rgba};
use serde_json::{Value, json};

/// 十六进制 `#rrggbb` / `#rrggbbaa` → [`Hsla`]。`rgba(r, g, b, a)` 用 [`rgba_css`]。
pub fn hex(s: &str) -> Hsla {
    let h = s.trim_start_matches('#');
    let byte =
        |i: usize| u8::from_str_radix(&h[i..i + 2], 16).expect("合法十六进制") as f32 / 255.0;
    let a = if h.len() == 8 { byte(6) } else { 1.0 };
    Rgba {
        r: byte(0),
        g: byte(2),
        b: byte(4),
        a,
    }
    .into()
}

/// `rgba(99, 102, 241, 0.15)` → [`Hsla`]。
pub fn rgba_css(r: u8, g: u8, b: u8, a: f32) -> Hsla {
    Rgba {
        r: r as f32 / 255.0,
        g: g as f32 / 255.0,
        b: b as f32 / 255.0,
        a,
    }
    .into()
}

/// 主色 `ACCENT` (`#6366f1`) 带透明度 → [`Hsla`]。
pub fn accent_alpha(a: f32) -> Hsla {
    rgba_css(99, 102, 241, a)
}

/// Obsidian Indigo（黑曜石靛蓝）现代暗色色板。
pub mod colors {
    /// 应用最底层背景（全高侧栏与悬浮画布岛底座）
    pub const APP: &str = "#0b0d12";
    /// 主工作台画布底色（悬浮圆角画布岛背景）
    pub const PANE: &str = "#12151e";
    /// 侧栏背景（融于深色底座）
    pub const SIDEBAR: &str = "#0d0f15";
    /// 工作台顶栏背景
    pub const TITLEBAR: &str = "#12151e";
    /// 终端画布底色（与工作台无缝融合）
    pub const TERMINAL: &str = "#12151e";
    /// 浮起卡片 / 按钮表面
    pub const SURFACE: &str = "#181c27";
    /// 悬停态表面
    pub const SURFACE_HOVER: &str = "#1e2330";
    /// 激活 / 选中态表面
    pub const SURFACE_ACTIVE: &str = "#23293a";
    /// 图标块 / 胶囊底座
    pub const TILE: &str = "#171b26";
    pub const TILE_HOVER: &str = "#212736";
    /// 浮层 / 菜单背景
    pub const OVERLAY: &str = "#151923";
    /// 输入框 / 代码块凹陷底
    pub const INPUT_BG: &str = "#0e1118";
    /// 关闭按钮 / 菜单项悬停
    pub const CLOSE_HOVER: &str = "#283044";
    /// 正文主文字
    pub const TEXT: &str = "#c3cad9";
    /// 强调 / 标题亮白文字
    pub const TEXT_BRIGHT: &str = "#f2f5fa";
    /// 次级说明文字
    pub const MUTED: &str = "#7e889b";
    /// 弱化路径 / 辅助文字
    pub const FAINT: &str = "#555e70";
    /// 电光靛蓝主色
    pub const ACCENT: &str = "#6366f1";
    pub const ACCENT_HOVER: &str = "#818cf8";
    pub const FOCUS_BORDER: &str = "#6366f1";
    /// 信息青色
    pub const CYAN: &str = "#38bdf8";
    /// 警告 / 运行中琥珀色
    pub const AMBER: &str = "#fbbf24";
    /// 终端类型语义色（翡翠绿）
    pub const TERMINAL_KIND: &str = "#34d399";
    /// ACP Agent 语义色（极光紫）
    pub const ACP_KIND: &str = "#c084fc";
    /// 错误 / 危险语义色（珊瑚红）
    pub const BELL: &str = "#f87171";
    /// 结构分隔线
    pub const BORDER: &str = "#1e2330";
    /// 悬浮画布岛 / 卡片 / 浮层微光描边
    pub const BORDER_SUBTLE: &str = "#283042";
    /// 已退出会话灰阶
    pub const EXITED: &str = "#434b5c";
    pub const G300: &str = "#525b6e";
    pub const STATUS_RUNNING: &str = "#fbbf24";
    pub const STATUS_NEED: &str = "#c084fc";
    pub const STATUS_DONE: &str = "#34d399";
    pub const STATUS_ERROR: &str = "#f87171";
    pub const TAB_STRIP: &str = "#0e1118";
}

/// git graph lane 色板：8 色轮转，适配 Obsidian Indigo 高对比暗底。
pub const GRAPH_LANE_COLORS: [&str; 8] = [
    "#6366f1", "#34d399", "#c084fc", "#fbbf24", "#38bdf8", "#f87171", "#fb923c", "#f472b6",
];

/// 布局尺寸（现代化全高侧栏 + 悬浮画布岛 + 单行融合顶栏）。单位 px。
pub mod sizes {
    pub const SIDEBAR_WIDTH: f32 = 264.0;
    /// 侧栏会话行高
    pub const ROW_HEIGHT: f32 = 30.0;
    pub const ROW_MARGIN_X: f32 = 8.0;
    pub const ROW_RADIUS: f32 = 7.0;
    pub const PANEL_WIDTH: f32 = 280.0;
    pub const PANEL_WIDTH_MIN: f32 = 244.0;
    pub const PANEL_WIDTH_MAX: f32 = 720.0;
    /// 工作面板覆盖阈值（<1100px 转为浮层）
    pub const PANEL_OVERLAY_WIDTH: f32 = 1100.0;
    /// 单行融合工作台顶栏高度
    pub const TOOLBAR_HEIGHT: f32 = 40.0;
    pub const TAB_BAR_HEIGHT: f32 = 34.0;
    /// 侧栏顶部栏（红绿灯 + 折叠钮）高度
    pub const SIDEBAR_HEAD_HEIGHT: f32 = 40.0;
    /// 悬浮圆角画布岛外边距与圆角
    pub const ISLAND_MARGIN: f32 = 6.0;
    pub const ISLAND_RADIUS: f32 = 10.0;
    /// 窄窗口断点：侧栏抽屉化的阈值
    pub const NARROW_BREAKPOINT: f32 = 760.0;
}

/// gpui-component 没有对应键的项目特有 token，作为 app 级 `Global` 提供。
#[derive(Clone, Debug)]
pub struct Tokens {
    pub tile: Hsla,
    pub tile_hover: Hsla,
    pub tab_strip: Hsla,
    pub terminal_kind: Hsla,
    pub acp_kind: Hsla,
    pub exited: Hsla,
    pub status_running: Hsla,
    pub status_need: Hsla,
    pub status_done: Hsla,
    pub status_error: Hsla,
    pub graph_lanes: [Hsla; 8],
}

impl Global for Tokens {}

impl Tokens {
    pub fn dark() -> Self {
        use colors::*;
        Self {
            tile: hex(TILE),
            tile_hover: hex(TILE_HOVER),
            tab_strip: hex(TAB_STRIP),
            terminal_kind: hex(TERMINAL_KIND),
            acp_kind: hex(ACP_KIND),
            exited: hex(EXITED),
            status_running: hex(STATUS_RUNNING),
            status_need: hex(STATUS_NEED),
            status_done: hex(STATUS_DONE),
            status_error: hex(STATUS_ERROR),
            graph_lanes: GRAPH_LANE_COLORS.map(hex),
        }
    }
}

/// 生成 gpui-component 的 `ThemeConfig` JSON（单主题的 themes 数组，供 `load_themes_from_str`）。
///
/// 语义映射（旧 token → gpui-component 键）：
/// - app → background；text → foreground；textBright → 强调前景（popover/primary 前景）
/// - pane → list/tab 内容面；sidebar → sidebar.*；titlebar → title_bar.*
/// - surface/surfaceHover/surfaceActive → secondary / accent / list.hover / list.active
/// - accent → primary；accentHover → primary.hover；bell → danger
/// - borderSubtle → input.border / popover 描边；border → border
/// - inputBg → 输入框底（`input.background` 键不存在，借 `secondary` 之外的 `muted.background`）
pub fn theme_config_json(name: &str) -> Value {
    use colors::*;
    // 用键值表而不是一个巨大的 `json!`：宏对大对象有递归深度限制，表也更好 diff。
    let pairs: &[(&str, &str)] = &[
        ("background", APP),
        ("foreground", TEXT),
        ("border", BORDER),
        ("input.border", BORDER_SUBTLE),
        ("ring", ACCENT),
        ("caret", ACCENT),
        ("selection.background", "#6366f140"),
        //
        ("primary.background", ACCENT),
        ("primary.foreground", TEXT_BRIGHT),
        ("primary.hover.background", ACCENT_HOVER),
        ("primary.active.background", ACCENT),
        //
        ("secondary.background", SURFACE),
        ("secondary.foreground", TEXT),
        ("secondary.hover.background", SURFACE_HOVER),
        ("secondary.active.background", SURFACE_ACTIVE),
        //
        ("accent.background", SURFACE_HOVER),
        ("accent.foreground", TEXT_BRIGHT),
        //
        ("muted.background", INPUT_BG),
        ("muted.foreground", MUTED),
        //
        ("popover.background", OVERLAY),
        ("popover.foreground", TEXT),
        //
        ("danger.background", BELL),
        ("success.background", STATUS_DONE),
        ("warning.background", AMBER),
        ("info.background", CYAN),
        //
        ("sidebar.background", SIDEBAR),
        ("sidebar.foreground", TEXT),
        ("sidebar.border", BORDER),
        ("sidebar.accent.background", SURFACE_ACTIVE),
        ("sidebar.accent.foreground", TEXT_BRIGHT),
        //
        ("list.background", PANE),
        ("list.hover.background", SURFACE),
        ("list.active.background", SURFACE_ACTIVE),
        ("list.active.border", ACCENT),
        //
        ("tab_bar.background", TAB_STRIP),
        ("tab.background", TAB_STRIP),
        ("tab.active.background", PANE),
        ("tab.foreground", MUTED),
        ("tab.active.foreground", TEXT_BRIGHT),
        //
        ("title_bar.background", TITLEBAR),
        ("title_bar.border", BORDER),
    ];
    let colors: serde_json::Map<String, Value> = pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), json!(v)))
        .collect();
    let highlight_pairs: &[(&str, &str)] = &[
        ("editor.foreground", TEXT),
        ("editor.background", PANE),
        ("editor.gutter.background", PANE),
        ("editor.active_line.background", "#181c27a6"),
        ("editor.line_number", FAINT),
        ("editor.active_line_number", TEXT_BRIGHT),
        ("editor.invisible", "#28304280"),
        ("conflict", "#fb923c"),
        ("created", STATUS_DONE),
        ("created.background", "#34d39922"),
        ("deleted", STATUS_ERROR),
        ("deleted.background", "#f8717122"),
        ("modified", STATUS_RUNNING),
        ("modified.background", "#fbbf2422"),
        ("error", STATUS_ERROR),
        ("error.background", "#f8717122"),
        ("error.border", STATUS_ERROR),
        ("warning", AMBER),
        ("warning.background", "#fbbf2422"),
        ("warning.border", AMBER),
        ("info", CYAN),
        ("info.background", "#38bdf822"),
        ("info.border", CYAN),
        ("hint", ACP_KIND),
        ("hint.background", "#c084fc22"),
        ("hint.border", ACP_KIND),
        ("success", STATUS_DONE),
        ("success.background", "#34d39922"),
        ("hidden", FAINT),
        ("predictive", FAINT),
    ];
    let syntax_colors: &[(&str, &str)] = &[
        ("attribute", "#93c5fd"),
        ("boolean", "#fb923c"),
        ("constant", "#fbbf24"),
        ("constructor", "#38bdf8"),
        ("embedded", TEXT),
        ("enum", "#38bdf8"),
        ("function", "#818cf8"),
        ("hint", MUTED),
        ("keyword", "#c084fc"),
        ("label", "#818cf8"),
        ("number", "#fb923c"),
        ("operator", "#7dd3fc"),
        ("preproc", "#c084fc"),
        ("primary", TEXT),
        ("property", "#93c5fd"),
        ("punctuation", MUTED),
        ("punctuation.bracket", "#8b95a8"),
        ("punctuation.delimiter", MUTED),
        ("punctuation.list_marker", "#818cf8"),
        ("punctuation.special", "#c084fc"),
        ("string", "#34d399"),
        ("string.escape", "#6ee7b7"),
        ("string.regex", "#fbbf24"),
        ("string.special", "#6ee7b7"),
        ("string.special.symbol", "#6ee7b7"),
        ("tag", "#f87171"),
        ("text.literal", "#34d399"),
        ("type", "#38bdf8"),
        ("variable", "#e2e8f0"),
        ("variable.special", "#f87171"),
        ("variant", "#38bdf8"),
    ];
    let mut syntax: serde_json::Map<String, Value> = syntax_colors
        .iter()
        .map(|(k, c)| ((*k).to_owned(), json!({ "color": c })))
        .collect();
    syntax.insert(
        "comment".to_owned(),
        json!({ "color": "#5c667a", "font_style": "italic" }),
    );
    syntax.insert(
        "comment.doc".to_owned(),
        json!({ "color": "#6e7a91", "font_style": "italic" }),
    );
    syntax.insert("emphasis".to_owned(), json!({ "font_style": "italic" }));
    syntax.insert("emphasis.strong".to_owned(), json!({ "font_weight": 700 }));
    syntax.insert(
        "link_text".to_owned(),
        json!({ "color": "#38bdf8", "font_style": "normal" }),
    );
    syntax.insert(
        "link_uri".to_owned(),
        json!({ "color": "#818cf8", "font_style": "italic" }),
    );
    syntax.insert(
        "predictive".to_owned(),
        json!({ "color": FAINT, "font_style": "italic" }),
    );
    syntax.insert(
        "title".to_owned(),
        json!({ "color": TEXT_BRIGHT, "font_weight": 700 }),
    );

    let mut highlight: serde_json::Map<String, Value> = highlight_pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), json!(v)))
        .collect();
    highlight.insert("syntax".to_owned(), Value::Object(syntax));
    json!({
        "name": name,
        // 圆角对齐原型 `--radius:8px; --radius-lg:12px`（库默认 6 / 8）：Input /
        // Button / Dialog 等库控件与自绘控件（views/field.rs）同一档圆角。
        "themes": [{
            "name": name, "mode": "dark", "is_default": true,
            "radius": 8, "radius.lg": 12,
            "colors": colors,
            "highlight": highlight,
        }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_parses_rgb_and_rgba() {
        let c = hex("#61afef");
        let r: Rgba = c.into();
        assert!(
            (r.r - 0x61 as f32 / 255.0).abs() < 1e-3 && (r.b - 0xef as f32 / 255.0).abs() < 1e-3
        );
        assert!((r.a - 1.0).abs() < 1e-6);
        let a: Rgba = hex("#61afef40").into();
        assert!((a.a - 0x40 as f32 / 255.0).abs() < 1e-3);
    }

    #[test]
    fn rgba_css_matches_the_prototype_translucent_tokens() {
        // 旧 tokens：accentSoft = rgba(97,175,239,0.15)；card = rgba(42,48,57,0.72)
        let soft: Rgba = rgba_css(97, 175, 239, 0.15).into();
        assert!((soft.a - 0.15).abs() < 1e-6);
        assert!((soft.r - 97.0 / 255.0).abs() < 1e-3);
    }

    #[test]
    fn every_palette_value_is_a_valid_hex_colour() {
        use colors::*;
        for v in [
            APP,
            PANE,
            SIDEBAR,
            TITLEBAR,
            TERMINAL,
            SURFACE,
            SURFACE_HOVER,
            SURFACE_ACTIVE,
            TILE,
            TILE_HOVER,
            OVERLAY,
            INPUT_BG,
            CLOSE_HOVER,
            TEXT,
            TEXT_BRIGHT,
            MUTED,
            FAINT,
            ACCENT,
            ACCENT_HOVER,
            FOCUS_BORDER,
            CYAN,
            AMBER,
            TERMINAL_KIND,
            ACP_KIND,
            BELL,
            BORDER,
            BORDER_SUBTLE,
            EXITED,
            G300,
            STATUS_RUNNING,
            STATUS_NEED,
            STATUS_DONE,
            STATUS_ERROR,
            TAB_STRIP,
        ] {
            assert!(v.starts_with('#') && (v.len() == 7 || v.len() == 9), "{v}");
            let _ = hex(v); // 不 panic
        }
    }

    #[test]
    fn the_palette_matches_obsidian_indigo_key_values() {
        assert_eq!(colors::APP, "#0b0d12");
        assert_eq!(colors::PANE, "#12151e");
        assert_eq!(colors::ACCENT, "#6366f1");
        assert_eq!(colors::BELL, "#f87171");
        assert_eq!(colors::BORDER_SUBTLE, "#283042");
        assert_eq!(
            GRAPH_LANE_COLORS[0],
            colors::ACCENT,
            "lane 0 与 accent 同色"
        );
        assert_eq!(
            GRAPH_LANE_COLORS.len(),
            8,
            "与 GitGraphData 的默认色板长度一致"
        );
    }

    #[test]
    fn theme_json_is_a_single_dark_default_theme_with_the_core_keys() {
        let v = theme_config_json("j-agent");
        let t = &v["themes"][0];
        assert_eq!(
            (t["mode"].as_str(), t["is_default"].as_bool()),
            (Some("dark"), Some(true))
        );
        let c = t["colors"].as_object().unwrap();
        for k in [
            "background",
            "foreground",
            "border",
            "primary.background",
            "sidebar.background",
            "title_bar.background",
            "list.active.background",
            "tab_bar.background",
            "danger.background",
        ] {
            assert!(c.contains_key(k), "缺 {k}");
        }
        assert_eq!(c["background"], colors::APP);
        assert_eq!(c["primary.background"], colors::ACCENT);
        assert_eq!(c["danger.background"], colors::BELL);
    }

    #[test]
    fn dark_tokens_expose_eight_graph_lane_colours() {
        let t = Tokens::dark();
        assert_eq!(t.graph_lanes.len(), 8);
        assert_eq!(t.graph_lanes[3], hex("#fbbf24"));
        assert_eq!(t.status_error, t.graph_lanes[5], "状态红与 lane 红同值");
    }
}

/// 把 j-agent 暗色主题装进 gpui-component：注册 → 应用 → 同步 [`Tokens`]。
/// 必须在 `gpui_component::init(cx)` 之后调用。
pub fn install(cx: &mut gpui::App) -> Result<(), String> {
    use gpui_component::{Theme, ThemeConfig, ThemeMode, ThemeRegistry, ThemeSet};
    let json = theme_config_json("j-agent").to_string();
    // 先校验再注册：解析失败要在这里炸出明确原因，而不是静默回退默认主题。
    let set: ThemeSet =
        serde_json::from_str(&json).map_err(|e| format!("主题 JSON 不合法：{e}"))?;
    let cfg: ThemeConfig = set.themes.into_iter().next().ok_or("主题集为空")?;
    ThemeRegistry::global_mut(cx)
        .load_themes_from_str(&json)
        .map_err(|e| e.to_string())?;
    Theme::global_mut(cx).apply_config(&std::rc::Rc::new(cfg));
    Theme::change(ThemeMode::Dark, None, cx);
    cx.set_global(Tokens::dark());
    Ok(())
}

#[cfg(test)]
mod install_tests {
    use gpui::TestAppContext;
    use gpui_component::{ActiveTheme, Theme};

    use super::*;

    #[gpui::test]
    fn install_applies_our_colours_to_the_gpui_component_theme(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            install(cx).expect("主题应能安装");
            let t = cx.theme();
            assert_eq!(t.background, hex(colors::APP), "background ← app");
            assert_eq!(t.foreground, hex(colors::TEXT), "foreground ← text");
            assert_eq!(t.primary, hex(colors::ACCENT), "primary ← accent");
            assert_eq!(t.danger, hex(colors::BELL), "danger ← bell");
            assert_eq!(t.radius, gpui::px(8.0), "radius ← 原型 --radius");
            assert_eq!(t.radius_lg, gpui::px(12.0), "radius.lg ← 原型 --radius-lg");
            assert!(Theme::global(cx).mode.is_dark());
            assert_eq!(
                t.highlight_theme.style.editor_background,
                Some(hex(colors::PANE)),
                "editor.background 应对齐画布 PANE 底色"
            );
            assert_eq!(
                t.highlight_theme.style.editor_gutter_background,
                Some(hex(colors::PANE)),
                "editor.gutter.background 应与画布无缝融合，不出现 #181d29 突兀灰蓝柱"
            );
            assert_eq!(cx.global::<Tokens>().graph_lanes[0], hex(colors::ACCENT));
        });
    }
}
