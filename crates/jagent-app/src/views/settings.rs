//! 设置页（V4 原型逐行对齐）：左 nav 218px（品牌头 + 搜索框 + 7 分区 + 命中
//! 徽章）、右内容（页头 + st-card 分区卡）。
//!
//! 像素真源：React 原型 `SettingsView.tsx` + `index.css` 第二段（`.settings` /
//! `.st-nav*` / `.st-search` / `.srow` / `.st-card` / `.kb-row` / `.le-*` /
//! `.conv-card`），gpuix `settings/ui/SettingsView.tsx` 为翻译参照。
//!
//! 功能契约（P6 起不变）：`settings.json` 是唯一事实源（schema/store 在
//! jagent-core），本视图把控件动作翻译为 `SettingsStore::patch/reset/*_preset/
//! *_acp_agent`，每次变更立即 `flush` 并广播 `StateChanged`。未知键往返保真
//! 由 core 保证（有回归测试）。
//!
//! V4 五个子功能：
//! - 打开设置页自动聚焦搜索框（`focus_search` 一次性标记，root 装配时触发）
//! - 字体系统选择器（`settings_controls::font_select`：弹层内搜索 + 字身
//!   预览 + 自由输入，候选清单 `settings_defs::FONT_CANDIDATES` 静态枚举）
//! - 搜索 label/desc 高亮（amber wash，`settings_defs::hl_range`）+ 分区命中
//!   计数徽章（`section_hits`）
//! - 焦点环（`settings_controls::focus_ring`：toggle/select/number/range +
//!   搜索框聚焦边）
//! - 「在编辑器中打开」settings.json（`Effects::open_path` 记账，app flush
//!   时 spawn 系统关联程序）

use std::collections::HashMap;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, FocusHandle, Focusable as _, HighlightStyle,
    InteractiveElement as _, IntoElement, ParentElement as _, Render,
    StatefulInteractiveElement as _, Styled as _, StyledText, WeakEntity, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_component::{
    h_flex,
    input::{Input, InputEvent, InputState, Textarea, TextareaState},
    v_flex,
};
use jagent_core::presets::TerminalPreset;
use jagent_core::settings::{
    AcpAgentInput, AcpAgentPatch, PresetInput, PresetPatch, Settings, serialize_settings,
};
use jagent_core::threads::Effects as _;
use serde_json::json;

use crate::actions::CTX_SETTINGS;
use crate::icons::{IconName, icon};
use crate::state::{AppState, StateChanged};
use crate::theme::{colors, hex, rgba_css};
use crate::views::settings_controls as controls;
use crate::views::settings_defs as defs;
use crate::views::settings_defs::{SETTING_DEFS, Section};

/// amber 高亮 wash（原型 `.srow .lbl mark`：rgba(229,192,123,.28)）
fn mark_style() -> HighlightStyle {
    HighlightStyle {
        background_color: Some(rgba_css(229, 192, 123, 0.28)),
        ..Default::default()
    }
}

/// 搜索命中高亮文本（无命中退化为整段）
fn hl_text(text: &str, q: &str) -> StyledText {
    match defs::hl_range(text, q) {
        Some(range) => StyledText::new(text).with_highlights([(range, mark_style())]),
        None => StyledText::new(text),
    }
}

pub struct SettingsView {
    state: Entity<AppState>,
    section: Section,
    query: String,
    search: Entity<InputState>,
    focus_search: bool,
    /// 字体选择器弹层内搜索词（与 font_search 输入单向同步；重开时双清）
    pub(crate) font_query: String,
    pub(crate) font_hi: usize,
    font_search: Entity<InputState>,
    /// 折叠卡展开态（预设 / ACP agent）
    expanded_preset: Option<String>,
    expanded_agent: Option<String>,
    /// 控件 focus handle（toggle / range / select 触发器）：tab 循环 + 焦点环
    handles: HashMap<&'static str, FocusHandle>,
    /// 侧栏宽度滑条拖拽态
    range_drag: controls::RangeDrag,
    /// 列表编辑器输入缓存（预设 / ACP / 数字输入），键稳定跨 render 复用
    edit_inputs: HashMap<String, Entity<InputState>>,
    edit_textareas: HashMap<String, Entity<TextareaState>>,
}

impl SettingsView {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.subscribe(&state, |_, _, _: &StateChanged, cx| cx.notify())
            .detach();
        let search = cx.new(|cx| {
            let mut input = InputState::new(window, cx);
            input.set_placeholder("搜索设置…", window, cx);
            input
        });
        let font_search = cx.new(|cx| {
            let mut input = InputState::new(window, cx);
            input.set_placeholder("搜索字体…", window, cx);
            input
        });
        cx.subscribe_in(&search, window, |this, input, ev: &InputEvent, _, cx| {
            if matches!(ev, InputEvent::Change) {
                this.query = input.read(cx).value().to_string();
                cx.notify();
            }
        })
        .detach();
        cx.subscribe_in(
            &font_search,
            window,
            |this, input, ev: &InputEvent, _, cx| {
                if matches!(ev, InputEvent::Change) {
                    this.font_query = input.read(cx).value().to_string();
                    this.font_hi = 0;
                    cx.notify();
                }
            },
        )
        .detach();
        Self {
            state,
            section: Section::Presets,
            query: String::new(),
            search,
            focus_search: true,
            font_query: String::new(),
            font_hi: 0,
            font_search,
            expanded_preset: None,
            expanded_agent: None,
            handles: HashMap::new(),
            range_drag: Default::default(),
            edit_inputs: HashMap::new(),
            edit_textareas: HashMap::new(),
        }
    }
}

impl SettingsView {
    pub fn focus_search(&mut self) {
        self.focus_search = true;
    }

    fn handle_for(&mut self, key: &'static str, cx: &Context<Self>) -> FocusHandle {
        self.handles
            .entry(key)
            .or_insert_with(|| cx.focus_handle())
            .clone()
    }
}

impl Render for SettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // 打开设置页自动聚焦搜索框（一次性）
        if self.focus_search {
            self.focus_search = false;
            let handle = self.search.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
        }
        let state = self.state.clone();
        let settings = state.read(cx).settings.get().clone();
        let q = self.query.trim().to_owned();
        let searching = !q.is_empty();
        let hits = defs::section_hits(&settings, &q);
        let weak = cx.entity().downgrade();

        // ── 左列 nav（.st-nav：218px / rgba(32,36,43,.55) 底 / subtle 右边）──
        let search_focused = self.search.read(cx).focus_handle(cx).is_focused(window);
        let nav = v_flex()
            .w(px(218.0))
            .h_full()
            .flex_shrink_0()
            .bg(rgba_css(32, 36, 43, 0.55))
            .border_r_1()
            .border_color(hex(colors::BORDER_SUBTLE))
            // 品牌头（.st-nav-brand：58px + 底边；mark 28×28 r8 surface + gear）
            .child(
                h_flex()
                    .h(px(58.0))
                    .flex_shrink_0()
                    .px(px(14.0))
                    .gap(px(9.0))
                    .border_b_1()
                    .border_color(hex(colors::BORDER_SUBTLE))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(28.0))
                            .rounded(px(8.0))
                            .bg(hex(colors::SURFACE))
                            .border_1()
                            .border_color(hex(colors::BORDER_SUBTLE))
                            .child(icon(IconName::Gear, 15.0, hex(colors::ACCENT))),
                    )
                    .child(
                        v_flex()
                            .gap(px(1.0))
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .text_color(hex(colors::TEXT_BRIGHT))
                                    .child("设置"),
                            )
                            .child(
                                div()
                                    .text_size(px(10.0))
                                    .text_color(hex(colors::MUTED))
                                    .child("偏好与工具"),
                            ),
                    ),
            )
            // 搜索框（.st-search：34px / margin 12 10 10 / r8 inputBg + kbd「/」）
            .child(
                h_flex()
                    .h(px(34.0))
                    .mt(px(12.0))
                    .ml(px(10.0))
                    .mr(px(10.0))
                    .mb(px(10.0))
                    .px(px(8.0))
                    .gap(px(6.0))
                    .flex_shrink_0()
                    .rounded(px(8.0))
                    .bg(hex(colors::INPUT_BG))
                    .border_1()
                    .border_color(if search_focused {
                        hex(colors::FOCUS_BORDER)
                    } else {
                        hex(colors::BORDER_SUBTLE)
                    })
                    .child(icon(IconName::Search, 13.0, hex(colors::MUTED)))
                    .child(
                        div().flex_1().min_w_0().child(
                            Input::new(&self.search)
                                .appearance(false)
                                .h_full()
                                .text_size(px(12.0))
                                .text_color(hex(colors::TEXT_BRIGHT)),
                        ),
                    )
                    // kbd「/」（.st-search kbd：18px 高 r4 mono 10 faint）
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .h(px(18.0))
                            .min_w(px(18.0))
                            .px(px(5.0))
                            .flex_shrink_0()
                            .rounded(px(4.0))
                            .border_1()
                            .border_color(hex(colors::BORDER_SUBTLE))
                            .font_family("monospace")
                            .text_size(px(10.0))
                            .text_color(hex(colors::FAINT))
                            .child("/"),
                    ),
            )
            // 7 分区（.st-nav-list：gap 3 / pad 0 8 10；item 34px + 图标 + 命中徽章）
            .child(
                v_flex()
                    .id("settings-nav-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .gap(px(3.0))
                    .pl(px(8.0))
                    .pr(px(8.0))
                    .pb(px(10.0))
                    .children(Section::ALL.map(|s| {
                        nav_item(
                            s,
                            self.section,
                            searching,
                            hits[Section::ALL.iter().position(|x| *x == s).unwrap()],
                            defs::section_has_content(s, &q, &settings),
                            self.search.clone(),
                            weak.clone(),
                        )
                    })),
            );

        // ── 右列内容（.st-content / .st-content-in：max 920 / pad 30 34 52）──
        let content_in: Vec<AnyElement> = if searching {
            search_results(&settings, &q, &state, self, window, cx)
        } else {
            let head = page_head(
                s_section_label(self.section),
                "更改会立即应用，并自动保存到本地设置。",
                true,
            );
            vec![
                head,
                st_card(section_body(
                    self.section,
                    &q,
                    &state,
                    &settings,
                    self,
                    window,
                    cx,
                ))
                .into_any_element(),
            ]
        };

        h_flex()
            .key_context(CTX_SETTINGS)
            .flex_1()
            .min_h_0()
            .bg(hex(colors::PANE))
            .child(nav)
            .child(
                v_flex()
                    .id("settings-content")
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .overflow_y_scroll()
                    .child(
                        v_flex()
                            .max_w(px(920.0))
                            .pt(px(30.0))
                            .pl(px(34.0))
                            .pr(px(34.0))
                            .pb(px(52.0))
                            .children(content_in),
                    ),
            )
    }
}

fn s_section_label(s: Section) -> &'static str {
    s.label()
}

/// nav 分区行（.st-nav-item：34px；active = surfaceActive 底 + subtle 边 +
/// 浅阴影 + accent 图标；搜索无内容分区置灰；命中徽章 accentSoft）
fn nav_item(
    s: Section,
    current: Section,
    searching: bool,
    hit_count: usize,
    has_content: bool,
    search: Entity<InputState>,
    weak: WeakEntity<SettingsView>,
) -> impl IntoElement {
    let active = !searching && s == current;
    let dimmed = searching && !has_content;
    div()
        .id(gpui::SharedString::from(format!("nav-{}", s.id())))
        .flex()
        .items_center()
        .gap(px(9.0))
        .w_full()
        .h(px(34.0))
        .flex_shrink_0()
        .pl(px(9.0))
        .pr(px(9.0))
        .rounded(px(8.0))
        .border_1()
        .border_color(if active {
            hex(colors::BORDER_SUBTLE)
        } else {
            gpui::hsla(0.0, 0.0, 0.0, 0.0)
        })
        .when(active, |d| {
            d.bg(hex(colors::SURFACE_ACTIVE)).shadow(vec![
                gpui::BoxShadow::new(px(0.0), px(1.0), gpui::hsla(0.0, 0.0, 0.0, 0.18))
                    .blur_radius(px(2.0)),
            ])
        })
        .when(!active && !dimmed, |d| {
            d.hover(|h| h.bg(hex(colors::SURFACE)))
        })
        .when(dimmed, |d| d.opacity(0.4).cursor_default())
        .when(!dimmed, |d| d.cursor_pointer())
        .child(icon(
            s.icon(),
            14.0,
            if active {
                hex(colors::ACCENT)
            } else {
                hex(colors::MUTED)
            },
        ))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_size(px(12.0))
                .font_weight(gpui::FontWeight::MEDIUM)
                .text_color(if active {
                    hex(colors::TEXT_BRIGHT)
                } else {
                    hex(colors::TEXT)
                })
                .child(s.label()),
        )
        // 命中徽章（.hit：10px accent / accentSoft 底 / r8 / 1 6）
        .when(searching && hit_count > 0, |d| {
            d.child(
                div()
                    .flex_shrink_0()
                    .py(px(1.0))
                    .px(px(6.0))
                    .rounded(px(8.0))
                    .text_size(px(10.0))
                    .text_color(hex(colors::ACCENT))
                    .bg(rgba_css(97, 175, 239, 0.15))
                    .child(hit_count.to_string()),
            )
        })
        // 点击：清搜索 + 切分区（原型 onClick）
        .on_click(move |_, window, cx| {
            if dimmed {
                return;
            }
            let _ = weak.update(cx, |v, cx| {
                v.section = s;
                v.query.clear();
                search.update(cx, |input, cx| input.set_value("", window, cx));
                cx.notify();
            });
        })
}

/// 页头（.st-page-head：18px 标题 + sub + 右侧 live 胶囊）
fn page_head(title: &str, sub: &str, live: bool) -> AnyElement {
    h_flex()
        .items_start()
        .justify_between()
        .gap(px(20.0))
        .mb(px(18.0))
        .child(
            v_flex()
                .min_w_0()
                .child(
                    div()
                        .text_size(px(18.0))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .child(title.to_owned()),
                )
                .child(
                    div()
                        .mt(px(5.0))
                        .text_size(px(12.0))
                        .text_color(hex(colors::MUTED))
                        .child(sub.to_owned()),
                ),
        )
        .when(live, |d| {
            // .st-live：26px 胶囊 + done 绿点
            d.child(
                h_flex()
                    .items_center()
                    .gap(px(6.0))
                    .h(px(26.0))
                    .px(px(9.0))
                    .flex_shrink_0()
                    .rounded_full()
                    .bg(rgba_css(42, 48, 57, 0.72))
                    .border_1()
                    .border_color(hex(colors::BORDER_SUBTLE))
                    .child(
                        div()
                            .size(px(8.0))
                            .rounded_full()
                            .bg(hex(colors::STATUS_DONE)),
                    )
                    .child(
                        div()
                            .text_size(px(10.0))
                            .text_color(hex(colors::MUTED))
                            .child("即时生效"),
                    ),
            )
        })
        .into_any_element()
}

/// 分区卡（.st-card：r12 / card 底 / subtle 边 / overflow hidden / 浅阴影）
fn st_card(children: Vec<AnyElement>) -> impl IntoElement {
    v_flex()
        .overflow_hidden()
        .rounded(px(12.0))
        .bg(rgba_css(42, 48, 57, 0.72))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .shadow(vec![
            gpui::BoxShadow::new(px(0.0), px(1.0), gpui::hsla(0.0, 0.0, 0.0, 0.16))
                .blur_radius(px(2.0)),
        ])
        .children(children)
}

/// 搜索态右列（SearchAll）：页头（无 live）+ 各命中分区小节；
/// 全空 → 空态卡（.st-empty-card）。
fn search_results(
    settings: &Settings,
    q: &str,
    state: &Entity<AppState>,
    view: &mut SettingsView,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
) -> Vec<AnyElement> {
    let visible: Vec<Section> = Section::ALL
        .into_iter()
        .filter(|s| defs::section_has_content(*s, q, settings))
        .collect();
    if visible.is_empty() {
        return vec![empty_search_card(q, &view.search)];
    }
    let mut out = vec![page_head(
        "搜索结果",
        &format!("找到 {} 个相关分区", visible.len()),
        false,
    )];
    for (i, s) in visible.into_iter().enumerate() {
        out.push(
            v_flex()
                .when(i > 0, |d| d.mt(px(22.0)))
                // 分节小头（.st-search-section .st-h：11px uppercase muted）
                .child(
                    div()
                        .mb(px(8.0))
                        .text_size(px(11.0))
                        .text_color(hex(colors::MUTED))
                        .child(s.label().to_uppercase()),
                )
                .child(st_card(section_body(
                    s, q, state, settings, view, window, cx,
                )))
                .into_any_element(),
        );
    }
    out
}

/// 空态卡（.st-empty-card：220px 虚线卡 + 大搜索图标 + 清除钮）
fn empty_search_card(q: &str, search: &Entity<InputState>) -> AnyElement {
    let search_reset = search.clone();
    v_flex()
        .min_h(px(220.0))
        .items_center()
        .justify_center()
        .gap(px(8.0))
        .rounded(px(12.0))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .child(icon(IconName::Search, 18.0, hex(colors::MUTED)))
        .child(
            div()
                .text_size(px(13.0))
                .text_color(hex(colors::MUTED))
                .child(format!("没有匹配「{q}」的设置。")),
        )
        .child(
            div()
                .id("settings-clear-search")
                .flex()
                .items_center()
                .h(px(26.0))
                .px(px(10.0))
                .mt(px(3.0))
                .rounded(px(6.0))
                .bg(hex(colors::SURFACE))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .cursor_pointer()
                .hover(|d| d.bg(hex(colors::SURFACE_HOVER)))
                .child(
                    div()
                        .text_size(px(12.0))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .child("清除搜索"),
                )
                .on_click(move |_, window, cx| {
                    search_reset.update(cx, |input, cx| input.set_value("", window, cx));
                }),
        )
        .into_any_element()
}

/// 分区内容调度（原型 SectionBody）：非 defs 分区特判。
/// 返回 st-card 的 children（行自带 px16 内边距与底边）。
fn section_body(
    section: Section,
    q: &str,
    state: &Entity<AppState>,
    settings: &Settings,
    view: &mut SettingsView,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
) -> Vec<AnyElement> {
    match section {
        Section::Presets => presets_section(state, settings, q, view, window, cx),
        Section::Keybindings => kb_section(settings, q),
        Section::AcpAgents => acp_section(state, settings, q, view, window, cx),
        Section::Notifications => {
            let mut rows =
                defs_section(state, settings, Section::Notifications, q, view, window, cx);
            // 约定卡随查询过滤（原型：无 q 或约定命中才渲染）
            if q.is_empty() || defs::convention_matches(q) {
                rows.push(cli_conventions_card());
            }
            rows
        }
        Section::Advanced => {
            let mut rows = defs_section(state, settings, Section::Advanced, q, view, window, cx);
            rows.push(diagnostics_card());
            rows.push(json_view_card(state, settings, cx));
            rows
        }
        Section::Terminal | Section::Appearance => {
            defs_section(state, settings, section, q, view, window, cx)
        }
    }
}

// ── defs 分区：SettingRow 列表（行级过滤 + 高亮 + 真值接线 + 写错红条）────

fn defs_section(
    state: &Entity<AppState>,
    settings: &Settings,
    section: Section,
    q: &str,
    view: &mut SettingsView,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
) -> Vec<AnyElement> {
    let defs_of: Vec<&'static defs::SettingDef> = SETTING_DEFS
        .iter()
        .filter(|d| d.section == section && (q.is_empty() || defs::match_def(d, q)))
        .collect();
    let n = defs_of.len();
    let write_error = state.read(cx).settings.write_error().cloned();
    defs_of
        .into_iter()
        .enumerate()
        .map(|(i, def)| {
            let is_last = i == n - 1;
            let row = setting_row(def, settings, q, state, view, window, cx, is_last);
            // 行内写错红条（gpuix WriteErrorBar：出错行下方）
            let err_here = write_error.as_ref().filter(|e| e.path == def.path).cloned();
            match err_here {
                Some(err) => v_flex()
                    .child(row)
                    .child(
                        div()
                            .px(px(16.0))
                            .pb(px(6.0))
                            .font_family("monospace")
                            .text_size(px(11.0))
                            .text_color(hex(colors::BELL))
                            .child(format!("写入失败：{}", err.message)),
                    )
                    .into_any_element(),
                None => row,
            }
        })
        .collect()
}

/// 设置行（.srow：min-h 58 / pad 13 16 / gap 16 / 底边 subtle；卡内末行无底边）
#[allow(clippy::too_many_arguments)]
fn setting_row(
    def: &'static defs::SettingDef,
    settings: &Settings,
    q: &str,
    state: &Entity<AppState>,
    view: &mut SettingsView,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
    is_last: bool,
) -> AnyElement {
    let value = settings
        .get_path(def.path)
        .unwrap_or(serde_json::Value::Null);
    let modified = state.read(cx).settings.is_modified(def.path);
    let control = control_for(def, &value, state, view, window, cx);
    h_flex()
        .items_start()
        .gap(px(16.0))
        .min_h(px(58.0))
        .pt(px(13.0))
        .pb(px(13.0))
        .pl(px(16.0))
        .pr(px(16.0))
        .when(!is_last, |d| {
            d.border_b_1().border_color(hex(colors::BORDER_SUBTLE))
        })
        // 左列：label 行（moddot + label + reset 槽）/ desc
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .child(
                    h_flex()
                        .items_center()
                        .gap(px(6.0))
                        // 修改蓝点（.moddot：6×6 accent）
                        .when(modified, |d| {
                            d.child(div().size(px(6.0)).rounded_full().bg(hex(colors::ACCENT)))
                        })
                        .child(
                            div()
                                .text_size(px(13.0))
                                .text_color(hex(colors::TEXT_BRIGHT))
                                .child(hl_text(def.label, q)),
                        )
                        // reset 槽（18×18；未修改时隐藏占位）
                        .child(reset_slot(def, modified, state, view)),
                )
                .child(
                    div()
                        .mt(px(3.0))
                        .max_w(px(560.0))
                        .text_size(px(12.0))
                        .line_height(px(17.0))
                        .text_color(hex(colors::MUTED))
                        .child(hl_text(def.desc, q)),
                ),
        )
        // 右列只放控件（.ctl：min-h 22 居中）
        .child(
            h_flex()
                .items_center()
                .min_h(px(22.0))
                .flex_shrink_0()
                .child(control),
        )
        .into_any_element()
}

/// reset 图标钮（.srow .reset：18×18 r4 muted；hover surface + text；
/// 未修改 invisible 占位——不推动 label）
fn reset_slot(
    def: &'static defs::SettingDef,
    modified: bool,
    state: &Entity<AppState>,
    view: &SettingsView,
) -> impl IntoElement {
    let path = def.path;
    let st = state.clone();
    let input_sync: Option<Entity<InputState>> = match def.control {
        defs::ControlKind::Number { .. } => view.edit_inputs.get(path).cloned(),
        _ => None,
    };
    div()
        .id(gpui::SharedString::from(format!("reset-{path}")))
        .size(px(18.0))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.0))
        .text_color(hex(colors::MUTED))
        .when(modified, |d| {
            d.cursor_pointer()
                .hover(|h| h.bg(hex(colors::SURFACE)).text_color(hex(colors::TEXT)))
                .child(icon(IconName::Reset, 12.0, hex(colors::MUTED)))
                .on_click(move |_, window, cx| {
                    st.update(cx, |s, cx| {
                        s.settings.reset(path);
                        s.flush(cx);
                        cx.emit(StateChanged);
                    });
                    // 数字输入框回显重置后的值
                    if let Some(input) = &input_sync {
                        let value = st.read(cx).settings.get().get_path(path);
                        let text = value
                            .and_then(|v| v.as_i64())
                            .map(|v| v.to_string())
                            .unwrap_or_default();
                        input.update(cx, |input, cx| input.set_value(text, window, cx));
                    }
                })
        })
        .when(!modified, |d| d.invisible())
}

/// 控件接线：按 def.control 类型组装（值/回调全走 store patch）
fn control_for(
    def: &'static defs::SettingDef,
    value: &serde_json::Value,
    state: &Entity<AppState>,
    view: &mut SettingsView,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
) -> AnyElement {
    let path = def.path;
    match def.control {
        defs::ControlKind::Toggle => {
            let checked = value.as_bool().unwrap_or(false);
            let handle = view.handle_for(path, cx);
            let focused = handle.is_focused(window);
            let st = state.clone();
            controls::toggle(
                gpui::SharedString::from(format!("setting-{path}")),
                &handle,
                focused,
                checked,
                move |_, cx| {
                    st.update(cx, |s, cx| {
                        let cur = s
                            .settings
                            .get()
                            .get_path(path)
                            .and_then(|v| v.as_bool())
                            .unwrap_or(checked);
                        s.settings.patch(path, json!(!cur));
                        s.flush(cx);
                        cx.emit(StateChanged);
                    });
                },
            )
            .into_any_element()
        }
        defs::ControlKind::Select { options } => {
            let current = value.as_str().unwrap_or_default().to_owned();
            let st = state.clone();
            let opts: Vec<(String, String)> = options
                .iter()
                .map(|(v, l)| ((*v).to_owned(), (*l).to_owned()))
                .collect();
            controls::select_field(
                &format!("setting-{path}"),
                &current,
                opts,
                move |v, _, cx| {
                    st.update(cx, |s, cx| {
                        s.settings.patch(path, json!(v));
                        s.flush(cx);
                        cx.emit(StateChanged);
                    });
                },
            )
            .into_any_element()
        }
        defs::ControlKind::Font => {
            let current = value.as_str().unwrap_or_default().to_owned();
            let items = defs::font_items(&current, &view.font_query);
            let weak = cx.entity().downgrade();
            let st = state.clone();
            let search = view.font_search.clone();
            let search_handle = search.read(cx).focus_handle(cx);
            controls::font_select(
                &current,
                items,
                view.font_hi,
                search,
                search_handle,
                weak,
                move |name, _, cx| {
                    st.update(cx, |s, cx| {
                        s.settings.patch(path, json!(name));
                        s.flush(cx);
                        cx.emit(StateChanged);
                    });
                },
            )
            .into_any_element()
        }
        defs::ControlKind::Number { min, max, step } => {
            let initial = value.as_i64().map(|v| v.to_string()).unwrap_or_default();
            let st = state.clone();
            let input = editor_input(
                &mut view.edit_inputs,
                path.to_owned(),
                initial,
                window,
                cx,
                // 输入即时解析：合法（且范围内）且与当前值不同才生效
                move |text, _, cx| {
                    if let Some(n) = text
                        .trim()
                        .parse::<i64>()
                        .ok()
                        .filter(|n| (min..=max).contains(n))
                    {
                        st.update(cx, |s, cx| {
                            if s.settings.get().get_path(path).and_then(|v| v.as_i64()) == Some(n) {
                                return;
                            }
                            s.settings.patch(path, json!(n));
                            s.flush(cx);
                            cx.emit(StateChanged);
                        });
                    }
                },
            );
            let st = state.clone();
            let focused = input.read(cx).focus_handle(cx).is_focused(window);
            let input_for_nudge = input.clone();
            controls::number_input(
                &format!("setting-{path}"),
                &input,
                focused,
                move |dir, window, cx| {
                    let next = st.update(cx, |s, cx| {
                        let cur = s
                            .settings
                            .get()
                            .get_path(path)
                            .and_then(|v| v.as_i64())
                            .unwrap_or(min);
                        let next = (cur + dir * step).clamp(min, max);
                        s.settings.patch(path, json!(next));
                        s.flush(cx);
                        cx.emit(StateChanged);
                        next
                    });
                    input_for_nudge.update(cx, |input, cx| {
                        input.set_value(next.to_string(), window, cx)
                    });
                },
            )
            .into_any_element()
        }
        defs::ControlKind::Range { min, max, step } => {
            let v = value.as_i64().unwrap_or(min);
            let handle = view.handle_for(path, cx);
            let focused = handle.is_focused(window);
            let st = state.clone();
            h_flex()
                .items_center()
                .gap(px(10.0))
                .child(controls::range_input(
                    gpui::SharedString::from(format!("setting-{path}")),
                    &handle,
                    focused,
                    v,
                    min,
                    max,
                    step,
                    &view.range_drag,
                    move |next, _, cx| {
                        st.update(cx, |s, cx| {
                            s.settings.patch(path, json!(next));
                            s.flush(cx);
                            cx.emit(StateChanged);
                        });
                    },
                ))
                .child(controls::range_value(v, "px"))
                .into_any_element()
        }
    }
}

// ── 通知分区：CLI 约定卡（.conv-card：inputBg 底 / m 14 / p 12 14）─────────

const CONVENTIONS: [(&str, &str); 4] = [
    ("Pi", ".pi/extensions/zed-bell.ts 在 agent_end 写 \\x07"),
    ("Amp", "env AMP_FORCE_BEL=1"),
    (
        "Claude",
        "settings.json → preferredNotifChannel: \"terminal_bell\"",
    ),
    ("Codex", "tui.terminal_title → OSC 标题"),
];

fn cli_conventions_card() -> AnyElement {
    v_flex()
        .m(px(14.0))
        .p(px(12.0))
        .px(px(14.0))
        .rounded(px(8.0))
        .bg(hex(colors::INPUT_BG))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .child(
            div()
                .mb(px(8.0))
                .text_size(px(12.0))
                .text_color(hex(colors::TEXT_BRIGHT))
                .child("CLI 侧 BEL / OSC 约定（j-agent 只信任这两个信号；到各自 CLI 侧配置，此处不代管）"),
        )
        .children(CONVENTIONS.map(|(n, d)| {
            h_flex()
                .gap(px(10.0))
                .mb(px(4.0))
                .child(
                    div()
                        .w(px(64.0))
                        .flex_shrink_0()
                        .text_size(px(12.0))
                        .text_color(hex(colors::TEXT))
                        .child(n),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .font_family("monospace")
                        .text_size(px(11.0))
                        .text_color(hex(colors::MUTED))
                        .child(d),
                )
        }))
        .into_any_element()
}

// ── 键位分区（.kb-row：pad 9 16 / gap 12 / 底边 subtle；本期只读）──────────

fn kb_section(settings: &Settings, q: &str) -> Vec<AnyElement> {
    let k = &settings.keybindings;
    let keys = [
        (
            "cycleNext",
            "下一个 thread（循环切换）",
            k.cycle_next.clone(),
        ),
        (
            "cyclePrev",
            "上一个 thread（循环切换）",
            k.cycle_prev.clone(),
        ),
        (
            "toggleSettings",
            "打开 / 关闭设置",
            k.toggle_settings.clone(),
        ),
        ("focusSearch", "聚焦设置搜索", k.focus_search.clone()),
        (
            "searchThreads",
            "搜索会话（⌘K/Ctrl-K）",
            k.search_threads.clone(),
        ),
        (
            "toggleSidebar",
            "收起 / 展开侧栏（⌘B/Ctrl-B）",
            k.toggle_sidebar.clone(),
        ),
        ("newSession", "新建会话（⌘N）", k.new_session.clone()),
    ];
    let kl = q.to_lowercase();
    let rows: Vec<_> = keys
        .iter()
        .filter(|(_, label, key)| {
            q.is_empty() || label.to_lowercase().contains(&kl) || key.to_lowercase().contains(&kl)
        })
        .collect();
    let fixed: Vec<_> = defs::FIXED_KEYS
        .iter()
        .filter(|(l, k)| {
            q.is_empty() || l.to_lowercase().contains(&kl) || k.to_lowercase().contains(&kl)
        })
        .collect();
    if rows.is_empty() && fixed.is_empty() {
        return vec![];
    }
    let total = rows.len() + fixed.len();
    let mut out = vec![];
    for (i, (_, label, key)) in rows.iter().enumerate() {
        // 冲突警示：其他动作已绑同一串
        let conflict = keys
            .iter()
            .find(|(_, l, k2)| l != label && k2 == key)
            .map(|(_, l, _)| (*l).to_owned());
        let last = i == total - 1 && fixed.is_empty() && conflict.is_none();
        out.push(kb_row(label, key, q, conflict, last));
    }
    for (i, (label, key)) in fixed.iter().enumerate() {
        let last = i == fixed.len() - 1 && rows.len() + i + 1 == total;
        out.push(
            h_flex()
                .items_center()
                .gap(px(12.0))
                .pt(px(9.0))
                .pb(px(9.0))
                .pl(px(16.0))
                .pr(px(16.0))
                .when(!last, |d| {
                    d.border_b_1().border_color(hex(colors::BORDER_SUBTLE))
                })
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_size(px(12.5))
                        .text_color(hex(colors::TEXT))
                        .child(hl_text(label, q)),
                )
                .child(
                    div()
                        .font_family("monospace")
                        .text_size(px(11.0))
                        .text_color(hex(colors::MUTED))
                        .child(*key),
                )
                .into_any_element(),
        );
    }
    out
}

fn kb_row(label: &str, key: &str, q: &str, conflict: Option<String>, last: bool) -> AnyElement {
    let row = h_flex()
        .items_center()
        .gap(px(12.0))
        .pt(px(9.0))
        .pb(px(9.0))
        .pl(px(16.0))
        .pr(px(16.0))
        .when(!last, |d| {
            d.border_b_1().border_color(hex(colors::BORDER_SUBTLE))
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .text_size(px(12.5))
                .text_color(hex(colors::TEXT))
                .child(hl_text(label, q)),
        )
        // 键位捕获格（.kb-cap：110×30 mono 11；本期只读）
        .child(
            div()
                .min_w(px(110.0))
                .h(px(30.0))
                .flex()
                .items_center()
                .justify_center()
                .px(px(10.0))
                .rounded(px(8.0))
                .bg(hex(colors::INPUT_BG))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .font_family("monospace")
                .text_size(px(11.0))
                .text_color(hex(colors::TEXT_BRIGHT))
                .child(key.to_owned()),
        );
    match conflict {
        Some(other) => v_flex()
            .child(row)
            .child(
                div()
                    .mt(px(2.0))
                    .mb(px(6.0))
                    .ml(px(16.0))
                    .font_family("monospace")
                    .text_size(px(11.0))
                    .text_color(hex(colors::BELL))
                    .child(format!("⚠ 与「{other}」冲突（同绑 {key}）")),
            )
            .into_any_element(),
        None => row.into_any_element(),
    }
}

// ── 预设分区（PresetCard 折叠列表 + field-row 编辑）────────────────────────

fn presets_section(
    state: &Entity<AppState>,
    settings: &Settings,
    q: &str,
    view: &mut SettingsView,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
) -> Vec<AnyElement> {
    let mut out = vec![];
    // 「+」默认预设（首行 srow：无底边）
    if defs::plus_default_matches(q) {
        let current = settings.presets.plus_default.clone().unwrap_or_default();
        let options: Vec<(String, String)> =
            std::iter::once(("".to_owned(), "跟随上次使用".to_owned()))
                .chain(
                    settings
                        .presets
                        .items
                        .iter()
                        .map(|p| (p.id.clone(), p.label.clone())),
                )
                .collect();
        let st = state.clone();
        out.push(
            h_flex()
                .items_start()
                .gap(px(16.0))
                .pb(px(4.0))
                .pl(px(16.0))
                .pr(px(16.0))
                .min_h(px(58.0))
                .pt(px(13.0))
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .text_size(px(13.0))
                                .text_color(hex(colors::TEXT_BRIGHT))
                                .child("「+」按钮默认预设"),
                        )
                        .child(
                            div()
                                .mt(px(3.0))
                                .text_size(px(12.0))
                                .text_color(hex(colors::MUTED))
                                .child("点侧栏「新建会话」时直接启动该预设；选「跟随上次使用」则记住上次选择"),
                        ),
                )
                .child(
                    h_flex().items_center().min_h(px(22.0)).flex_shrink_0().child(
                        // 选项动态：跟随上次使用 + 内置/自定义预设
                        select_for_plus_default(&current, &options, &st),
                    ),
                )
                .into_any_element(),
        );
        out.push(
            div()
                .text_size(px(11.0))
                .font_weight(gpui::FontWeight::MEDIUM)
                .text_color(hex(colors::MUTED))
                .mt(px(14.0))
                .mb(px(6.0))
                .px(px(2.0))
                .child("预设列表")
                .into_any_element(),
        );
    }
    let visible: Vec<&TerminalPreset> = settings
        .presets
        .items
        .iter()
        .filter(|p| defs::preset_visible(p, q))
        .collect();
    if !q.is_empty() && visible.is_empty() {
        out.push(le_empty("无匹配预设"));
    } else {
        for p in &visible {
            out.push(preset_card(p, state, view, window, cx));
        }
    }
    // 新增预设（.le-add：32px 虚线行）
    let st = state.clone();
    out.push(le_add("preset-add", "新增预设", move |_, _, cx| {
        st.update(cx, |s, cx| {
            s.settings.add_preset(PresetInput {
                label: "自定义预设".into(),
                ..Default::default()
            });
            s.flush(cx);
            cx.emit(StateChanged);
        });
    }));
    out
}

/// plus_default 下拉（选项动态：跟随上次使用 + 各预设）
fn select_for_plus_default(
    current: &str,
    options: &[(String, String)],
    state: &Entity<AppState>,
) -> AnyElement {
    let state = state.clone();
    controls::select_field(
        "presets-plus-default",
        current,
        options.to_vec(),
        move |v, _, cx| {
            state.update(cx, |s, cx| {
                s.settings.patch(
                    "presets.plusDefault",
                    if v.is_empty() {
                        serde_json::Value::Null
                    } else {
                        json!(v)
                    },
                );
                s.flush(cx);
                cx.emit(StateChanged);
            });
        },
    )
    .into_any_element()
}

/// 列表编辑器空态（.le-empty）
fn le_empty(text: &str) -> AnyElement {
    div()
        .py(px(14.0))
        .text_center()
        .text_size(px(12.0))
        .text_color(hex(colors::MUTED))
        .child(text.to_owned())
        .into_any_element()
}

/// 新增行（.le-add：32px 虚线边框行——gpui 无 dashed，实线近似）
fn le_add(
    id: &'static str,
    label: &'static str,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    div()
        .id(gpui::SharedString::from(id))
        .flex()
        .items_center()
        .justify_center()
        .gap(px(6.0))
        .h(px(32.0))
        .mt(px(4.0))
        .mb(px(12.0))
        .mx(px(12.0))
        .rounded(px(8.0))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .text_size(px(12.0))
        .text_color(hex(colors::MUTED))
        .cursor_pointer()
        .hover(|d| d.bg(hex(colors::SURFACE)).text_color(hex(colors::TEXT)))
        .child(icon(IconName::Plus, 12.0, hex(colors::MUTED)))
        .child(label)
        .on_click(move |e, window, cx| on_click(e, window, cx))
        .into_any_element()
}

/// 预设命令摘要（旧 model.ts presetCmdSummary）
fn preset_cmd_summary(p: &TerminalPreset) -> String {
    let init = p.init_command.as_deref().filter(|s| !s.is_empty());
    match p.program.as_deref().filter(|s| !s.is_empty()) {
        None => match init {
            Some(c) => format!("（shell）→ {c}"),
            None => "（系统默认 shell）".to_owned(),
        },
        Some(prog) => {
            let mut cmd = prog.to_owned();
            if let Some(args) = &p.args {
                for a in args {
                    cmd.push(' ');
                    cmd.push_str(a);
                }
            }
            match init {
                Some(c) => format!("{cmd}  →  {c}"),
                None => cmd,
            }
        }
    }
}

/// 预设卡（.le-card：折叠头 44px + field-row 编辑体）
fn preset_card(
    p: &TerminalPreset,
    state: &Entity<AppState>,
    view: &mut SettingsView,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
) -> AnyElement {
    let id = p.id.clone();
    let expanded = view.expanded_preset.as_deref() == Some(id.as_str());
    let group = gpui::SharedString::from(format!("preset-card-{id}"));
    let mut card = v_flex()
        .mx(px(12.0))
        .mt(px(10.0))
        .rounded(px(8.0))
        .bg(hex(colors::INPUT_BG))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .group(group.clone())
        // 折叠头（.le-head：44px + hover surface）
        .child(
            h_flex()
                .id(gpui::SharedString::from(format!("preset-head-{id}")))
                .h(px(44.0))
                .px(px(10.0))
                .gap(px(8.0))
                .rounded(px(8.0))
                .cursor_pointer()
                .hover(|d| d.bg(hex(colors::SURFACE)))
                .child(icon(
                    if expanded {
                        IconName::ChevronDown
                    } else {
                        IconName::ChevronRight
                    },
                    12.0,
                    hex(colors::FAINT),
                ))
                .child(
                    div()
                        .flex_shrink_0()
                        .text_size(px(12.5))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .child(p.label.clone()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .font_family("monospace")
                        .text_size(px(11.0))
                        .text_color(hex(colors::FAINT))
                        .child(preset_cmd_summary(p)),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .px(px(5.0))
                        .rounded(px(3.0))
                        .border_1()
                        .border_color(hex(colors::BORDER_SUBTLE))
                        .text_size(px(10.0))
                        .text_color(hex(colors::MUTED))
                        .child(if p.builtin { "内置" } else { "自定义" }),
                )
                // 操作（.acts：hover 显现——复制 / 重置(内置) / 删除(自定义)）
                .child(
                    h_flex()
                        .gap(px(2.0))
                        .flex_shrink_0()
                        .opacity(0.0)
                        .group_hover(group.clone(), |s| s.opacity(1.0))
                        .child({
                            let st = state.clone();
                            let id2 = id.clone();
                            mini_btn(
                                gpui::SharedString::from(format!("preset-copy-{id}")),
                                IconName::Copy,
                                move |_, _, cx| {
                                    st.update(cx, |s, cx| {
                                        s.settings.duplicate_preset(&id2);
                                        s.flush(cx);
                                        cx.emit(StateChanged);
                                    });
                                },
                            )
                        })
                        .when(p.builtin, |d| {
                            let st = state.clone();
                            let id2 = id.clone();
                            d.child(mini_btn(
                                gpui::SharedString::from(format!("preset-reset-{id}")),
                                IconName::Reset,
                                move |_, _, cx| {
                                    st.update(cx, |s, cx| {
                                        s.settings.reset_preset(&id2);
                                        s.flush(cx);
                                        cx.emit(StateChanged);
                                    });
                                },
                            ))
                        })
                        .when(!p.builtin, |d| {
                            let st = state.clone();
                            let id2 = id.clone();
                            d.child(mini_btn(
                                gpui::SharedString::from(format!("preset-delete-{id}")),
                                IconName::Trash,
                                move |_, _, cx| {
                                    st.update(cx, |s, cx| {
                                        s.settings.delete_preset(&id2);
                                        s.flush(cx);
                                        cx.emit(StateChanged);
                                    });
                                },
                            ))
                        }),
                )
                .on_click({
                    let weak = cx.entity().downgrade();
                    let id = id.clone();
                    move |_, _, cx| {
                        let _ = weak.update(cx, |v, cx| {
                            v.expanded_preset = if v.expanded_preset.as_deref() == Some(id.as_str())
                            {
                                None
                            } else {
                                Some(id.clone())
                            };
                            cx.notify();
                        });
                    }
                }),
        );
    if expanded {
        card = card.child(preset_body(p, state, view, window, cx));
    }
    card.into_any_element()
}

/// 小图标钮（.mini-btn：22px 高 r5 muted；危险项 hover 红）
fn mini_btn(
    id: gpui::SharedString,
    ic: IconName,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let danger = matches!(ic, IconName::Trash);
    div()
        .id(id)
        .flex()
        .items_center()
        .h(px(22.0))
        .px(px(8.0))
        .rounded(px(5.0))
        .cursor_pointer()
        .text_size(px(11.0))
        .text_color(hex(colors::MUTED))
        .hover(|d| {
            if danger {
                d.bg(hex(colors::SURFACE)).text_color(hex(colors::BELL))
            } else {
                d.bg(hex(colors::SURFACE)).text_color(hex(colors::TEXT))
            }
        })
        .child(icon(ic, 12.0, hex(colors::MUTED)))
        .on_click(move |e, window, cx| on_click(e, window, cx))
}

/// 预设编辑体（.le-body：p 4 12 12 + field-row）
fn preset_body(
    p: &TerminalPreset,
    state: &Entity<AppState>,
    view: &mut SettingsView,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
) -> AnyElement {
    let id = p.id.clone();
    // 六个字段的编辑缓存 + patch 回调（与 P6 相同的「patch → 回读 set_value」同步）
    let label_input = editor_input(
        &mut view.edit_inputs,
        format!("preset:{id}:label"),
        p.label.clone(),
        window,
        cx,
        preset_field_patch(state.clone(), id.clone(), "label"),
    );
    let program_input = editor_input(
        &mut view.edit_inputs,
        format!("preset:{id}:program"),
        p.program.clone().unwrap_or_default(),
        window,
        cx,
        preset_field_patch(state.clone(), id.clone(), "program"),
    );
    let args_input = editor_textarea(
        &mut view.edit_textareas,
        format!("preset:{id}:args"),
        p.args.clone().unwrap_or_default().join("\n"),
        window,
        cx,
        preset_field_patch(state.clone(), id.clone(), "args"),
    );
    let env_text = p
        .env
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("\n");
    let env_input = editor_textarea(
        &mut view.edit_textareas,
        format!("preset:{id}:env"),
        env_text,
        window,
        cx,
        preset_field_patch(state.clone(), id.clone(), "env"),
    );
    let init_input = editor_input(
        &mut view.edit_inputs,
        format!("preset:{id}:init"),
        p.init_command.clone().unwrap_or_default(),
        window,
        cx,
        preset_field_patch(state.clone(), id.clone(), "init"),
    );
    let cwd_input = editor_input(
        &mut view.edit_inputs,
        format!("preset:{id}:cwd"),
        p.cwd.clone().unwrap_or_default(),
        window,
        cx,
        preset_field_patch(state.clone(), id.clone(), "cwd"),
    );
    v_flex()
        .pt(px(4.0))
        .px(px(12.0))
        .pb(px(12.0))
        .border_t_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .child(field_row("Label", field_input(&label_input)))
        .child(field_row("Program", field_input(&program_input)))
        .child(field_row("Args", Textarea::new(&args_input).h(px(66.0))))
        .child(field_row("Env", Textarea::new(&env_input).h(px(66.0))))
        .child(field_row("Init command", field_input(&init_input)))
        .child(field_row("Cwd", field_input(&cwd_input)))
        .into_any_element()
}

/// 字段行（.field-row：96px 左标签 + 右控件）
fn field_row(label: &str, control: impl IntoElement) -> impl IntoElement {
    h_flex()
        .items_start()
        .gap(px(10.0))
        .mt(px(8.0))
        .child(
            div()
                .w(px(96.0))
                .flex_shrink_0()
                .pt(px(5.0))
                .text_size(px(11.5))
                .text_color(hex(colors::MUTED))
                .child(label.to_owned()),
        )
        .child(div().flex_1().min_w_0().child(control))
}

/// 字段输入（.field-row input：12px / inputBg / r6 / focus accent 边）
fn field_input(input: &Entity<InputState>) -> impl IntoElement {
    Input::new(input).h(px(28.0)).text_size(px(12.0))
}

/// 预设字段 patch 闭包工厂（args/env 走行拆；其余字符串直写）
fn preset_field_patch(
    state: Entity<AppState>,
    id: String,
    field: &'static str,
) -> impl Fn(String, &mut Window, &mut App) + 'static {
    move |value, _window, cx| {
        state.update(cx, |s, cx| {
            let patch = match field {
                "label" => PresetPatch {
                    label: Some(value.clone()),
                    ..Default::default()
                },
                "program" => PresetPatch {
                    program: Some(Some(value.clone()).filter(|v| !v.is_empty())),
                    ..Default::default()
                },
                "args" => PresetPatch {
                    args: Some(Some(decode_args(&value))),
                    ..Default::default()
                },
                "env" => {
                    let env = value
                        .lines()
                        .filter_map(|line| line.split_once('='))
                        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
                        .collect();
                    PresetPatch {
                        env: Some(Some(env)),
                        ..Default::default()
                    }
                }
                "init" => PresetPatch {
                    init_command: Some(Some(value.clone()).filter(|v| !v.is_empty())),
                    ..Default::default()
                },
                "cwd" => PresetPatch {
                    cwd: Some(Some(value.clone()).filter(|v| !v.is_empty())),
                    ..Default::default()
                },
                _ => PresetPatch::default(),
            };
            s.settings.update_preset(&id, patch);
            s.flush(cx);
            cx.emit(StateChanged);
        });
    }
}

// ── ACP agents 分区 ────────────────────────────────────────────────────────

fn acp_section(
    state: &Entity<AppState>,
    settings: &Settings,
    q: &str,
    view: &mut SettingsView,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
) -> Vec<AnyElement> {
    let mut out = vec![
        div()
            .text_size(px(12.0))
            .text_color(hex(colors::MUTED))
            .mb(px(8.0))
            .child("外部 agent 进程，经 ACP 协议接入（JSON-RPC over stdio）。")
            .into_any_element(),
    ];
    let visible: Vec<_> = settings
        .acp_agents
        .iter()
        .filter(|a| defs::acp_agent_visible(a, q))
        .collect();
    if !q.is_empty() && visible.is_empty() {
        out.push(le_empty("无匹配 agent"));
    } else {
        for a in &visible {
            out.push(acp_card(a, state, view, window, cx));
        }
    }
    let st = state.clone();
    out.push(le_add("acp-add", "新增 ACP agent", move |_, _, cx| {
        st.update(cx, |s, cx| {
            s.settings.add_acp_agent(AcpAgentInput {
                label: "New Agent".into(),
                ..Default::default()
            });
            s.flush(cx);
            cx.emit(StateChanged);
        });
    }));
    out
}

fn acp_card(
    a: &jagent_core::settings::AcpAgent,
    state: &Entity<AppState>,
    view: &mut SettingsView,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
) -> AnyElement {
    let id = a.id.clone();
    let expanded = view.expanded_agent.as_deref() == Some(id.as_str());
    let group = gpui::SharedString::from(format!("acp-card-{id}"));
    let mut card = v_flex()
        .mx(px(12.0))
        .mt(px(10.0))
        .rounded(px(8.0))
        .bg(hex(colors::INPUT_BG))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .group(group.clone())
        .child(
            h_flex()
                .id(gpui::SharedString::from(format!("acp-head-{id}")))
                .h(px(44.0))
                .px(px(10.0))
                .gap(px(8.0))
                .rounded(px(8.0))
                .cursor_pointer()
                .hover(|d| d.bg(hex(colors::SURFACE)))
                .child(icon(
                    if expanded {
                        IconName::ChevronDown
                    } else {
                        IconName::ChevronRight
                    },
                    12.0,
                    hex(colors::FAINT),
                ))
                .child(
                    div()
                        .flex_shrink_0()
                        .text_size(px(12.5))
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .child(a.label.clone()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .font_family("monospace")
                        .text_size(px(11.0))
                        .text_color(hex(colors::FAINT))
                        .child(format!("{} {}", a.command, a.args.join(" "))),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .px(px(5.0))
                        .rounded(px(3.0))
                        .border_1()
                        .border_color(hex(colors::BORDER_SUBTLE))
                        .text_size(px(10.0))
                        .text_color(hex(colors::MUTED))
                        .child("ACP"),
                )
                .child(
                    h_flex()
                        .gap(px(2.0))
                        .flex_shrink_0()
                        .opacity(0.0)
                        .group_hover(group.clone(), |s| s.opacity(1.0))
                        .child({
                            let st = state.clone();
                            let id2 = id.clone();
                            mini_btn(
                                gpui::SharedString::from(format!("acp-delete-{id}")),
                                IconName::Trash,
                                move |_, _, cx| {
                                    st.update(cx, |s, cx| {
                                        s.settings.delete_acp_agent(&id2);
                                        s.flush(cx);
                                        cx.emit(StateChanged);
                                    });
                                },
                            )
                        }),
                )
                .on_click({
                    let weak = cx.entity().downgrade();
                    let id = id.clone();
                    move |_, _, cx| {
                        let _ = weak.update(cx, |v, cx| {
                            v.expanded_agent = if v.expanded_agent.as_deref() == Some(id.as_str()) {
                                None
                            } else {
                                Some(id.clone())
                            };
                            cx.notify();
                        });
                    }
                }),
        );
    if expanded {
        let label_input = editor_input(
            &mut view.edit_inputs,
            format!("acp:{id}:label"),
            a.label.clone(),
            window,
            cx,
            acp_field_patch(state.clone(), id.clone(), "label"),
        );
        let command_input = editor_input(
            &mut view.edit_inputs,
            format!("acp:{id}:command"),
            a.command.clone(),
            window,
            cx,
            acp_field_patch(state.clone(), id.clone(), "command"),
        );
        let args_input = editor_textarea(
            &mut view.edit_textareas,
            format!("acp:{id}:args"),
            a.args.join("\n"),
            window,
            cx,
            acp_field_patch(state.clone(), id.clone(), "args"),
        );
        card = card.child(
            v_flex()
                .pt(px(4.0))
                .px(px(12.0))
                .pb(px(12.0))
                .border_t_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .child(field_row("Label", field_input(&label_input)))
                .child(field_row("Command", field_input(&command_input)))
                .child(field_row("Args", Textarea::new(&args_input).h(px(66.0)))),
        );
    }
    card.into_any_element()
}

fn acp_field_patch(
    state: Entity<AppState>,
    id: String,
    field: &'static str,
) -> impl Fn(String, &mut Window, &mut App) + 'static {
    move |value, _window, cx| {
        state.update(cx, |s, cx| {
            let patch = match field {
                "label" => AcpAgentPatch {
                    label: Some(value.clone()),
                    ..Default::default()
                },
                "command" => AcpAgentPatch {
                    command: Some(value.clone()),
                    ..Default::default()
                },
                "args" => AcpAgentPatch {
                    args: Some(value.lines().map(str::to_owned).collect()),
                    ..Default::default()
                },
                _ => AcpAgentPatch::default(),
            };
            s.settings.update_acp_agent(&id, patch);
            s.flush(cx);
            cx.emit(StateChanged);
        });
    }
}

// ── Advanced 分区：诊断卡 + settings.json 实时视图 + 在编辑器打开 ──────────

fn diagnostics_card() -> AnyElement {
    let rows: [(&str, String); 3] = [
        ("版本", format!("j-agent {}", env!("CARGO_PKG_VERSION"))),
        ("平台", std::env::consts::OS.to_owned()),
        (
            "数据目录",
            crate::state::data_dir().to_string_lossy().into_owned(),
        ),
    ];
    info_card("诊断", &rows)
}

/// settings.json 实时视图 + 「在编辑器中打开」（Effects::open_path 记账，
/// flush 兑现系统关联程序）
fn json_view_card(state: &Entity<AppState>, settings: &Settings, cx: &App) -> AnyElement {
    let path = state
        .read(cx)
        .settings
        .file_path()
        .map(|p| p.to_string_lossy().into_owned());
    let st = state.clone();
    v_flex()
        .m(px(14.0))
        .p(px(12.0))
        .px(px(14.0))
        .rounded(px(8.0))
        .bg(hex(colors::INPUT_BG))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .gap(px(8.0))
                .mb(px(8.0))
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .child("settings.json · 实时视图（JSON 是事实源，UI 是表单视图）"),
                )
                .when_some(path, |d, path| {
                    d.child(
                        div()
                            .id("open-settings-json")
                            .text_size(px(11.5))
                            .text_color(hex(colors::ACCENT))
                            .cursor_pointer()
                            .child("在编辑器中打开 ↗")
                            .on_click(move |_, _, cx| {
                                st.update(cx, |s, cx| {
                                    s.threads.effects_mut().open_path(&path);
                                    s.flush(cx);
                                });
                            }),
                    )
                }),
        )
        .child(
            div()
                .id("settings-json-view")
                .max_h(px(280.0))
                .overflow_y_scroll()
                .font_family("monospace")
                .text_size(px(11.0))
                .text_color(hex(colors::MUTED))
                .children(
                    serialize_settings(settings)
                        .lines()
                        .map(|line| div().child(line.to_owned()).into_any_element()),
                ),
        )
        .into_any_element()
}

fn info_card(title: &str, rows: &[(&str, String)]) -> AnyElement {
    v_flex()
        .m(px(14.0))
        .p(px(12.0))
        .px(px(14.0))
        .rounded(px(8.0))
        .bg(hex(colors::INPUT_BG))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .child(
            div()
                .mb(px(8.0))
                .text_size(px(12.0))
                .text_color(hex(colors::TEXT_BRIGHT))
                .child(title.to_owned()),
        )
        .children(rows.iter().map(|(k, v)| {
            h_flex()
                .gap(px(10.0))
                .mb(px(4.0))
                .child(
                    div()
                        .w(px(88.0))
                        .flex_shrink_0()
                        .text_size(px(12.0))
                        .text_color(hex(colors::TEXT))
                        .child(k.to_string()),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .font_family("monospace")
                        .text_size(px(11.0))
                        .text_color(hex(colors::MUTED))
                        .child(v.clone()),
                )
        }))
        .into_any_element()
}

// ── 列表编辑器输入缓存（P6 机制沿用：键稳定跨 render 复用，避免丢焦点）────

fn editor_input(
    inputs: &mut HashMap<String, Entity<InputState>>,
    key: String,
    initial: String,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
    on_change: impl Fn(String, &mut Window, &mut App) + 'static,
) -> Entity<InputState> {
    if let Some(input) = inputs.get(&key) {
        return input.clone();
    }
    let input = cx.new(|cx| {
        let mut input = InputState::new(window, cx);
        input.set_value(initial, window, cx);
        input
    });
    cx.subscribe_in(
        &input,
        window,
        move |_, input, ev: &InputEvent, window, cx| {
            if matches!(ev, InputEvent::Change) {
                on_change(input.read(cx).value().to_string(), window, cx);
            }
        },
    )
    .detach();
    inputs.insert(key, input.clone());
    input
}

fn editor_textarea(
    inputs: &mut HashMap<String, Entity<TextareaState>>,
    key: String,
    initial: String,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
    on_change: impl Fn(String, &mut Window, &mut App) + 'static,
) -> Entity<TextareaState> {
    if let Some(input) = inputs.get(&key) {
        return input.clone();
    }
    let input = cx.new(|cx| {
        let mut input = TextareaState::new(window, cx);
        input.set_value(initial, window, cx);
        input
    });
    cx.subscribe_in(
        &input,
        window,
        move |_, input, ev: &InputEvent, window, cx| {
            if matches!(ev, InputEvent::Change) {
                on_change(input.read(cx).value().to_string(), window, cx);
            }
        },
    )
    .detach();
    inputs.insert(key, input.clone());
    input
}

#[cfg(test)]
fn encode_args(args: &[String]) -> String {
    args.join("\n")
}
fn decode_args(text: &str) -> Vec<String> {
    text.lines().map(str::to_owned).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_editor_round_trips_whitespace_inside_individual_arguments() {
        let args = vec![
            "--path".to_owned(),
            "/tmp/my project".to_owned(),
            "".to_owned(),
            "--mode=fast".to_owned(),
        ];
        assert_eq!(decode_args(&encode_args(&args)), args);
    }

    #[test]
    fn preset_cmd_summary_matches_the_old_ts_semantics() {
        let mut p = jagent_core::presets::builtin_preset("shell").unwrap();
        assert_eq!(preset_cmd_summary(&p), "（系统默认 shell）");
        p.init_command = Some("claude".into());
        assert_eq!(preset_cmd_summary(&p), "（shell）→ claude");
        p.program = Some("amp".into());
        p.args = Some(vec!["--fast".into()]);
        assert_eq!(preset_cmd_summary(&p), "amp --fast  →  claude");
        p.init_command = None;
        assert_eq!(preset_cmd_summary(&p), "amp --fast");
    }

    #[gpui::test]
    fn terminal_style_patches_reach_existing_models_and_reset_to_factory_style(
        cx: &mut gpui::TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_string_lossy().into_owned();
        cx.update(|cx| {
            let state = crate::state::init(cx, dir.path().to_path_buf(), cwd).unwrap();
            let id = state.update(cx, |s, cx| s.spawn_from_preset("shell", None, cx).unwrap());
            let session = state
                .read(cx)
                .threads
                .thread(&id)
                .unwrap()
                .as_terminal()
                .unwrap()
                .session_id;
            let model = cx
                .global::<jagent_terminal::TerminalPool>()
                .get(session)
                .unwrap();
            let original = model.read(cx).style().clone();
            let factory = crate::state::terminal_style(&jagent_core::settings::Settings::default());
            assert_eq!(
                original.font_size,
                gpui::px(13.0),
                "new sessions initialize from saved settings"
            );

            state.update(cx, |s, cx| {
                s.settings.patch("terminal.fontSize", json!(18));
                s.settings.patch("terminal.cursorBlink", json!(false));
                s.settings
                    .patch("terminal.fontFamily", json!("monospace-test"));
                let settings = s.settings.get().clone();
                s.flush(cx);
                crate::state::apply_terminal_settings(cx, &settings);
            });
            let changed = model.read(cx).style().clone();
            assert_eq!(changed.font_size, gpui::px(18.0));
            assert_eq!(changed.font_family.as_ref(), "monospace-test");
            assert!(!changed.cursor_blink);

            state.update(cx, |s, cx| {
                s.settings.reset("terminal.fontSize");
                s.settings.reset("terminal.cursorBlink");
                s.settings.reset("terminal.fontFamily");
                let settings = s.settings.get().clone();
                s.flush(cx);
                crate::state::apply_terminal_settings(cx, &settings);
            });
            let reset = model.read(cx).style().clone();
            assert_eq!(reset.font_size, factory.font_size);
            assert_eq!(reset.font_family, factory.font_family);
            assert_eq!(reset.cursor_blink, factory.cursor_blink);
        });
    }

    #[gpui::test]
    fn legacy_settings_json_loads_and_round_trips_unknown_fields_after_ui_style_patches(
        cx: &mut gpui::TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let legacy = r#"{"notifications":{"desktop":false,"sound":true},"terminal":{"fontSize":16,"scrollbackLines":4321},"legacyPlugin":{"keep":true}}"#;
        std::fs::write(dir.path().join("settings.json"), legacy).unwrap();
        let state = cx.update(|cx| {
            crate::state::init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        cx.update(|cx| {
            let loaded = state.read(cx).settings.get();
            assert!(!loaded.notifications.desktop);
            assert!(loaded.notifications.sound);
            assert_eq!(loaded.terminal.font_size, 16);
            assert_eq!(loaded.terminal.scrollback_lines, 4321);
            state.update(cx, |s, cx| {
                s.settings.patch("terminal.cursorBlink", json!(false));
                s.settings.patch("advanced.perfHud", json!(true));
                s.flush(cx);
            });
        });
        let second = crate::state::AppState::load(dir.path().to_path_buf(), "/w".into()).unwrap();
        assert!(!second.settings.get().terminal.cursor_blink);
        assert!(second.settings.get().advanced.perf_hud);
        let raw = std::fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert!(
            raw.contains("legacyPlugin") && raw.contains("keep"),
            "未知旧键往返保真：{raw}"
        );
    }

    #[test]
    fn preset_reset_after_failed_persist_restores_every_editor_value_from_store_snapshot() {
        let mut store = jagent_core::settings::SettingsStore::init(
            jagent_core::settings::MemoryAdapter::new(None),
        )
        .unwrap();
        let builtin = jagent_core::presets::builtin_preset("shell").unwrap();
        store.update_preset(
            "shell",
            PresetPatch {
                label: Some("unsaved label".into()),
                program: Some(Some("/tmp/changed shell".into())),
                args: Some(Some(vec!["--path".into(), "/tmp/changed project".into()])),
                env: Some(Some(std::collections::BTreeMap::from([(
                    "A".into(),
                    "B".into(),
                )]))),
                init_command: Some(Some("echo changed".into())),
                cwd: Some(Some("/tmp/changed".into())),
                ..Default::default()
            },
        );
        assert!(store.fail_next_write_for_test("EACCES injected"));
        store.flush();
        assert!(store.write_error().is_some());
        let restored = store
            .get()
            .presets
            .items
            .iter()
            .find(|p| p.id == "shell")
            .unwrap();
        assert_eq!(restored, &builtin);
    }

    #[gpui::test]
    fn settings_toggle_writes_settings_json_immediately_and_reset_restores_default(
        cx: &mut gpui::TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let state = cx.update(|cx| {
            crate::state::init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        cx.update(|cx| {
            state.update(cx, |s, cx| {
                s.settings.patch("notifications.desktop", json!(false));
                s.flush(cx);
            })
        });
        let raw = std::fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert!(raw.contains("\"desktop\": false"));
        cx.update(|cx| {
            state.update(cx, |s, cx| {
                s.settings.reset("notifications.desktop");
                s.flush(cx);
            })
        });
        assert!(cx.update(|cx| state.read(cx).settings.get().notifications.desktop));
    }

    #[gpui::test]
    fn open_settings_json_records_an_open_path_effect_for_the_host(cx: &mut gpui::TestAppContext) {
        // 「在编辑器中打开」：core 只经 Effects 记账（本测试不 spawn 真程序——
        // GuiEffects 的 to_open 在 flush 里被取走；这里断言 Effects 通道本身）
        use jagent_core::threads::Effects as _;
        let dir = tempfile::tempdir().unwrap();
        cx.update(|cx| {
            let state = crate::state::init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let path = state
                .read(cx)
                .settings
                .file_path()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let before = state.read(cx).threads.effects().log.borrow().to_open.len();
            state.update(cx, |s, _| {
                s.threads.effects_mut().open_path(&path);
            });
            let after = state.read(cx).threads.effects().log.borrow().to_open.len();
            assert_eq!(after, before + 1, "open_path 记账进 EffectLog");
            let queued = state
                .read(cx)
                .threads
                .effects()
                .log
                .borrow()
                .to_open
                .clone();
            assert_eq!(queued.last().map(String::as_str), Some(path.as_str()));
        });
    }
}
