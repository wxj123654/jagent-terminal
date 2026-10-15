//! 主面空态（对应旧 `surfaces/EmptyPresets.tsx` / 原型 HomePane）。
//!
//! V6 原型对齐（`index.css` 第二段生效值）：居中 680 渐变卡——
//! home-mark 42² 图标块（accent 描边 + accentSoft 底）+ mono kicker +
//! h1 24/600 + sub + ctx 行（folder + mono path，inputBg 凹陷盒）+
//! section-head（左 600 右 muted）+ .pills 双列网格（grid 2 / gap 8，窄态
//! 1 列；pill 42 高 = pill-icon 24² surface 块 + label + arrowRight 尾标）。
//! 预设接 settings.presets.items（内置 5 + 自定义，设置增删实时反映）。
//! 点击 → `AppState::spawn_from_preset`（规则与错误弹通知都在那边）。
//!
//! 原型特性 GPUI 无对应（有意偏离，同 gpuix）：letter-spacing（kicker）、
//! pill hover translateY(-1px)。hover 只换底色/描边。

use gpui::{
    AnyElement, App, BoxShadow, Entity, FontWeight, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled, div, linear_color_stop,
    linear_gradient, px,
};
use gpui_component::{WindowExt as _, h_flex, v_flex};
use jagent_core::presets::{PresetCategory, TerminalPreset};

use crate::icons::{IconName, icon};
use crate::state::AppState;
use crate::theme::{colors, hex, rgba_css};

/// .home 面板内距：32（窄态 18，原型 @media(max-width:760px)）
fn pane_padding(narrow: bool) -> f32 {
    if narrow { 18.0 } else { 32.0 }
}

/// .home-card 内距：34（窄态 24）
fn card_padding(narrow: bool) -> f32 {
    if narrow { 24.0 } else { 34.0 }
}

/// .pills 列数：2（窄态 1）
fn pill_columns(narrow: bool) -> u16 {
    if narrow { 1 } else { 2 }
}

/// 无会话主面。`narrow` = 视口 < 760（原型 @media 窄态翻转内距与 pill 列数）。
pub fn empty_pane(state: &Entity<AppState>, narrow: bool, cx: &mut App) -> AnyElement {
    let (presets, ws) = {
        let s = state.read(cx);
        (
            s.settings.get().presets.items.clone(),
            s.active_workspace_id(),
        )
    };
    // .ctx 行：激活工作区 path ?? 首个工作区 path ?? 原型文案（原型 HomePane
    // 显示 first?.path；Rust 空态在选中工作区组时优先显示该工作区）
    let ctx_path: String = {
        let s = state.read(cx);
        let active = (!ws.is_empty())
            .then_some(ws.as_str())
            .and_then(|id| s.threads.workspace(id).map(|w| w.path.clone()));
        active
            .or_else(|| s.workspaces().first().map(|w| w.path.clone()))
            .unwrap_or_else(|| "未归属 · 无项目目录".into())
    };

    v_flex()
        .flex_1()
        .min_w_0()
        .items_center()
        .justify_center()
        .bg(hex(colors::PANE))
        .p(px(pane_padding(narrow)))
        .child(
            v_flex()
                .w_full()
                .max_w(px(680.0))
                .p(px(card_padding(narrow)))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .rounded(px(12.0))
                .bg(home_card_bg())
                .shadow(home_card_shadow())
                .child(home_mark())
                .child(
                    div()
                        .font_family("monospace")
                        .text_size(px(10.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(hex(colors::MUTED))
                        .child("J-AGENT WORKSPACE"),
                )
                .child(
                    div()
                        .mt(px(7.0))
                        .text_size(px(24.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .line_height(px(28.8))
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .child("想做点什么？"),
                )
                .child(
                    div()
                        .mt(px(6.0))
                        .text_size(px(13.0))
                        .text_color(hex(colors::MUTED))
                        .child("从左侧选择工作区，或直接开始一个新任务"),
                )
                .child(home_context(&ctx_path))
                .child(home_section_head(presets.len()))
                .child(home_pills(state, &presets, narrow)),
        )
        .into_any_element()
}

/// home-mark：42² 图标块（r10 + rgba(97,175,239,.3) 描边 + accentSoft 底）。
fn home_mark() -> gpui::Div {
    div()
        .size(px(42.0))
        .mb(px(18.0))
        .flex()
        .items_center()
        .justify_center()
        .border_1()
        .border_color(rgba_css(97, 175, 239, 0.3))
        .rounded(px(10.0))
        .bg(accent_soft())
        .child(icon(IconName::Agent, 20.0, hex(colors::ACCENT)))
}

/// ctx 行（.home .ctx）：mt 18 / 8·10 内距 / inputBg 凹陷盒 + folder 14 + mono 12 path。
fn home_context(path: &str) -> gpui::Div {
    h_flex()
        .mt(px(18.0))
        .min_w_0()
        .gap(px(6.0))
        .py(px(8.0))
        .px(px(10.0))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .rounded(px(8.0))
        .bg(hex(colors::INPUT_BG))
        .child(icon(IconName::Folder, 14.0, hex(colors::FAINT)))
        .child(
            div()
                .min_w_0()
                .flex_shrink_1()
                .font_family("monospace")
                .text_size(px(12.0))
                .text_color(hex(colors::FAINT))
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(path.to_owned()),
        )
}

/// section-head（.home-section-head）：mt 24 / mb 9；左「快速开始」600，右「N 个工具」muted。
fn home_section_head(count: usize) -> gpui::Div {
    h_flex()
        .mt(px(24.0))
        .mb(px(9.0))
        .justify_between()
        .items_center()
        .child(
            div()
                .text_size(px(11.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(hex(colors::TEXT))
                .child("快速开始"),
        )
        .child(
            div()
                .text_size(px(11.0))
                .text_color(hex(colors::MUTED))
                .child(format!("{count} 个工具")),
        )
}

/// pills（.pills）：grid 2 列 gap 8（窄态 1 列；原型 repeat(2,minmax(0,1fr))）。
fn home_pills(state: &Entity<AppState>, presets: &[TerminalPreset], narrow: bool) -> gpui::Div {
    div()
        .grid()
        .grid_cols(pill_columns(narrow))
        .gap(px(8.0))
        .children(presets.iter().map(|p| {
            let st = state.clone();
            let id = p.id.clone();
            pill(p).on_click(move |_, window, cx| {
                let ws_opt = workspace_target(&st, cx);
                let r = st.update(cx, |s, cx| {
                    s.spawn_from_preset(&id, ws_opt.as_deref(), cx).map(|_| ())
                });
                if let Err(e) = r {
                    window.push_notification(
                        gpui_component::notification::Notification::error(e.to_string()),
                        cx,
                    );
                }
            })
        }))
}

/// 归属工作区：激活工作区优先；起始页（无激活）时落第一个工作区
/// （原型 HomePane spawn 到 `workspaces[0]?.id`）。
fn workspace_target(state: &Entity<AppState>, cx: &App) -> Option<String> {
    let s = state.read(cx);
    let active = s.active_workspace_id();
    if !active.is_empty() {
        return Some(active);
    }
    s.workspaces().first().map(|w| w.id.clone())
}

/// 单个预设 pill（.pill）：h 42 / pad 0 11 / r8 / rgba(23,26,31,.55) 半透底 +
/// pill-icon 24² r6 surface 块 + label（550 → 近似 600）+ arrowRight 12 尾标。
/// hover → surfaceHover 底 + #4b5665 边（translateY 不支持，跳过）。
fn pill(p: &TerminalPreset) -> gpui::Stateful<gpui::Div> {
    div()
        .id(format!("preset-{}", p.id))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(7.0))
        .w_full()
        .h(px(42.0))
        .pl(px(11.0))
        .pr(px(11.0))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .rounded(px(8.0))
        .bg(rgba_css(23, 26, 31, 0.55))
        .hover(|h| {
            h.bg(hex(colors::SURFACE_HOVER))
                .border_color(hex("#4b5665"))
        })
        .child(
            div()
                .size(px(24.0))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.0))
                .bg(hex(colors::SURFACE))
                .child(icon(preset_icon(p), 14.0, hex(colors::ACCENT))),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(12.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(hex(colors::TEXT_BRIGHT))
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(p.label.clone()),
        )
        .child(icon(IconName::ArrowRight, 12.0, hex(colors::FAINT)))
}

/// 预设 → pill 图标（原型 presetIcon：agent 类机器人头，终端类竖条）。
fn preset_icon(p: &TerminalPreset) -> IconName {
    match p.category {
        Some(PresetCategory::Agent) => IconName::Agent,
        _ => IconName::Terminal,
    }
}

/// home-card 渐变：`linear-gradient(145deg, rgba(42,48,57,.65), rgba(32,36,43,.84))`。
fn home_card_bg() -> gpui::Background {
    linear_gradient(
        145.0,
        linear_color_stop(rgba_css(42, 48, 57, 0.65), 0.0),
        linear_color_stop(rgba_css(32, 36, 43, 0.84), 1.0),
    )
}

/// home-card 投影：`0 18px 50px rgba(0,0,0,.22)`。
fn home_card_shadow() -> Vec<BoxShadow> {
    vec![BoxShadow::new(px(0.0), px(18.0), black(0.22)).blur_radius(px(50.0))]
}

/// accentSoft = rgba(97,175,239,.15)（旧 tokens）。
fn accent_soft() -> Hsla {
    rgba_css(97, 175, 239, 0.15)
}

fn black(a: f32) -> Hsla {
    gpui::hsla(0.0, 0.0, 0.0, a)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(id: &str, category: Option<PresetCategory>) -> TerminalPreset {
        TerminalPreset {
            id: id.into(),
            label: id.into(),
            description: None,
            builtin: true,
            program: None,
            args: None,
            env: None,
            init_command: None,
            cwd: None,
            category,
        }
    }

    /// 图标映射：agent 类 → Agent，其余（tool / 未分类）→ Terminal
    #[test]
    fn preset_icon_maps_agent_category_to_the_bot_head() {
        assert_eq!(
            preset_icon(&preset("pi", Some(PresetCategory::Agent))),
            IconName::Agent
        );
        assert_eq!(
            preset_icon(&preset("shell", Some(PresetCategory::Tool))),
            IconName::Terminal
        );
        assert_eq!(preset_icon(&preset("x", None)), IconName::Terminal);
    }

    /// 卡投影 = 原型字面量 0 18 50 rgba(0,0,0,.22)
    #[test]
    fn home_card_shadow_matches_the_css_literal() {
        let s = home_card_shadow();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].offset.y, px(18.0));
        assert_eq!(s[0].blur_radius, px(50.0));
        let c: gpui::Rgba = s[0].color.into();
        assert!((c.a - 0.22).abs() < 1e-6);
    }

    /// 卡渐变：145deg 两端值（Background 内部私有，改测两端色值换算）
    #[test]
    fn home_card_gradient_stops_carry_the_prototype_colours() {
        let from = rgba_css(42, 48, 57, 0.65);
        let to = rgba_css(32, 36, 43, 0.84);
        let f: gpui::Rgba = from.into();
        let t: gpui::Rgba = to.into();
        assert_eq!((f.r * 255.0) as u8, 42);
        assert_eq!((f.g * 255.0) as u8, 48);
        assert_eq!((f.b * 255.0) as u8, 57);
        assert!((f.a - 0.65).abs() < 1e-6);
        assert_eq!((t.r * 255.0) as u8, 32);
        assert_eq!((t.g * 255.0) as u8, 36);
        assert_eq!((t.b * 255.0) as u8, 43);
        assert!((t.a - 0.84).abs() < 1e-6);
        // 渐变本体不退化为纯色
        assert!(home_card_bg().as_solid().is_none());
    }

    /// 窄态翻转：面板内距 32→18、卡内距 34→24、pill 列 2→1
    #[test]
    fn narrow_breakpoint_flips_paddings_and_pill_columns() {
        assert_eq!(pane_padding(false), 32.0);
        assert_eq!(pane_padding(true), 18.0);
        assert_eq!(card_padding(false), 34.0);
        assert_eq!(card_padding(true), 24.0);
        assert_eq!(pill_columns(false), 2);
        assert_eq!(pill_columns(true), 1);
    }
}
