//! 空工作区启动台（对应原型 `panes.tsx` 的 `BentoLaunchpad` 架构）。
//!
//! V5 Bento Launchpad 四层架构（居中 max-w 680px）：
//! 1. **顶部居中对称工作区 Hero 信息头 (`.bento-hero`)**：38×38 渐变图标盒 +
//!    18px 工作区名 + 目录路径 + 活跃会话计数胶囊 + Git 分支图谱钮 + 变更统计钮；
//! 2. **第一层：双列主动作大卡 (`.bento-primary-grid`)**：「启动 AI Coding Agent `⌘N`」
//!    （featured 靛蓝渐变卡）与「新建交互式终端 `⌘T`」；
//! 3. **第二层：3 列紧凑预设矩阵 (`.bento-preset-grid`)**：展示全部预设胶囊 +
//!    「更多工具…」入口，支持预设删空后的引导恢复态；
//! 4. **第三层：工作区会话列表 / 0 会话空态导览**：有会话时展示一键恢复与清理列表；
//!    0 会话时展示空态引导卡与 4 列全局快捷键速查导览条。

use std::rc::Rc;

use gpui::{
    AnyElement, App, BoxShadow, ElementId, Entity, FontWeight, Hsla, InteractiveElement as _,
    IntoElement, ParentElement as _, ScrollHandle, StatefulInteractiveElement as _, Styled, Window,
    div, linear_color_stop, linear_gradient, prelude::FluentBuilder as _, px,
};
use gpui_component::{WindowExt as _, h_flex, v_flex};
use jagent_core::git::WorktreeFile;
use jagent_core::presets::{PresetCategory, TerminalPreset};
use jagent_core::threads::{ActiveTarget, RunStatus, Thread};

use crate::icons::{IconName, icon};
use crate::state::{AppState, StateChanged};
use crate::theme::{accent_alpha, colors, hex, rgba_css};
use crate::ui_scale::fs;
use crate::views::selectable::sel_text_id;
use crate::views::{git_graph, nested_scroll, new_session};

/// 启动台外层内距：宽屏 32，窄屏 18
fn pane_padding(narrow: bool) -> f32 {
    if narrow { 18.0 } else { 32.0 }
}

/// 旧测试兼容常量
#[allow(dead_code)]
fn card_padding(narrow: bool) -> f32 {
    if narrow { 24.0 } else { 34.0 }
}

/// 旧测试兼容常量
#[allow(dead_code)]
fn pill_columns(narrow: bool) -> u16 {
    if narrow { 1 } else { 2 }
}

/// 预设网格列数：窄屏 1 列，单预设 2 列，常规 3 列
fn bento_preset_columns(narrow: bool, preset_count: usize) -> u16 {
    if narrow {
        1
    } else if preset_count == 1 {
        2
    } else {
        3
    }
}

pub type LaunchpadActionFn = Rc<dyn Fn(&mut Window, &mut App)>;

/// 启动台附加宿主回调與 Git 状态上下文
pub struct LaunchpadContext {
    pub branch: Option<String>,
    pub worktree_files: Vec<WorktreeFile>,
    pub on_open_settings: LaunchpadActionFn,
    pub on_open_changes: LaunchpadActionFn,
    pub outer_scroll: ScrollHandle,
    pub sessions_scroll: ScrollHandle,
}

/// 无会话主面（兼容无额外上下文的简写入口）。
pub fn empty_pane(state: &Entity<AppState>, narrow: bool, cx: &mut App) -> AnyElement {
    empty_pane_with_context(
        state,
        narrow,
        LaunchpadContext {
            branch: Some("main".to_owned()),
            worktree_files: Vec::new(),
            on_open_settings: Rc::new(|_, _| {}),
            on_open_changes: Rc::new(|_, _| {}),
            outer_scroll: ScrollHandle::new(),
            sessions_scroll: ScrollHandle::new(),
        },
        cx,
    )
}

/// 完整 Bento Launchpad 主面渲染。
pub fn empty_pane_with_context(
    state: &Entity<AppState>,
    narrow: bool,
    ctx: LaunchpadContext,
    cx: &mut App,
) -> AnyElement {
    let (presets, acp_subtitle, ws_id, ws_name, ws_path, ws_threads) = {
        let s = state.read(cx);
        let settings = s.settings.get();
        let presets = settings.presets.items.clone();
        let acp_labels: Vec<&str> = settings
            .acp_agents
            .iter()
            .take(3)
            .map(|a| a.label.as_str())
            .collect();
        let acp_subtitle = if acp_labels.is_empty() {
            "Pi / Claude Code / Codex ACP 代理".to_owned()
        } else {
            acp_labels.join(" · ")
        };
        let active_ws = s.active_workspace_id();
        let ws = (!active_ws.is_empty())
            .then(|| s.threads.workspace(&active_ws))
            .flatten()
            .or_else(|| s.workspaces().first());
        let (ws_id, ws_name, ws_path) = match ws {
            Some(w) => (w.id.clone(), w.name.clone(), w.path.clone()),
            None => (
                String::new(),
                "j-agent".to_owned(),
                "未归属 · 无项目目录".to_owned(),
            ),
        };
        let ws_threads: Vec<Thread> = s
            .threads
            .threads
            .iter()
            .filter(|t| !ws_id.is_empty() && t.workspace_id() == Some(ws_id.as_str()))
            .cloned()
            .collect();
        (presets, acp_subtitle, ws_id, ws_name, ws_path, ws_threads)
    };

    let running_count = ws_threads
        .iter()
        .filter(|t| {
            t.as_terminal()
                .is_none_or(|term| term.status == RunStatus::Running)
        })
        .count();
    let exited_count = ws_threads
        .iter()
        .filter(|t| {
            t.as_terminal()
                .is_some_and(|term| term.status == RunStatus::Exited)
        })
        .count();
    let bell_or_unread = ws_threads
        .iter()
        .filter(|t| t.common().unread || t.as_terminal().is_some_and(|term| term.has_bell))
        .count();

    let add_lines: u32 = ctx.worktree_files.iter().filter_map(|f| f.added).sum();
    let del_lines: u32 = ctx.worktree_files.iter().filter_map(|f| f.deleted).sum();
    let change_count = ctx.worktree_files.len();
    let branch_label = ctx.branch.unwrap_or_else(|| "main".to_owned());

    // ── 1. 顶部居中对称工作区 Hero 信息头 (.bento-hero) ──
    let state_git = state.clone();
    let on_changes = ctx.on_open_changes.clone();
    let session_summary = if !ws_threads.is_empty() {
        if exited_count > 0 {
            format!(
                "● {} 个会话（{} 活跃 · {} 已退出）",
                ws_threads.len(),
                running_count,
                exited_count
            )
        } else {
            format!("● {} 个会话（{} 活跃）", ws_threads.len(), running_count)
        }
    } else {
        "○ 暂无活跃会话".to_owned()
    };

    let hero = v_flex()
        .w_full()
        .items_center()
        .gap(px(8.0))
        .pb(px(14.0))
        .border_b_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .child(
            div()
                .size(fs(38.0))
                .rounded(px(10.0))
                .flex()
                .items_center()
                .justify_center()
                .flex_shrink_0()
                .bg(hero_icon_bg())
                .border_1()
                .border_color(rgba_css(99, 102, 241, 0.38))
                .child(icon(IconName::Folder, 18.0, hex(colors::ACCENT_HOVER))),
        )
        .child(
            div()
                .text_size(fs(18.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(hex(colors::TEXT_BRIGHT))
                .child(sel_text_id("bento-ws-name", ws_name.clone())),
        )
        .child(
            h_flex()
                .flex_wrap()
                .items_center()
                .justify_center()
                .gap(px(8.0))
                .font_family("monospace")
                .text_size(fs(11.5))
                .text_color(hex(colors::MUTED))
                .child(div().child(sel_text_id("bento-ws-path", ws_path)))
                .child(
                    div()
                        .px(px(8.0))
                        .py(px(1.0))
                        .rounded(px(5.0))
                        .bg(hex(colors::SURFACE))
                        .border_1()
                        .border_color(hex(colors::BORDER_SUBTLE))
                        .text_color(if !ws_threads.is_empty() {
                            hex(colors::TEXT_BRIGHT)
                        } else {
                            hex(colors::MUTED)
                        })
                        .child(session_summary),
                )
                .when(bell_or_unread > 0, |d| {
                    d.child(
                        div()
                            .px(px(8.0))
                            .py(px(1.0))
                            .rounded(px(5.0))
                            .bg(rgba_css(192, 132, 252, 0.15))
                            .border_1()
                            .border_color(rgba_css(192, 132, 252, 0.35))
                            .text_color(hex(colors::ACP_KIND))
                            .child(format!("🔔 {bell_or_unread} 待处理")),
                    )
                })
                .child(
                    h_flex()
                        .id("bento-git-btn")
                        .h(px(22.0))
                        .px(px(8.0))
                        .gap(px(5.0))
                        .items_center()
                        .rounded(px(6.0))
                        .bg(hex(colors::TILE))
                        .border_1()
                        .border_color(hex(colors::BORDER_SUBTLE))
                        .cursor_pointer()
                        .hover(|h| h.bg(hex(colors::SURFACE_HOVER)))
                        .child(icon(IconName::GitBranch, 12.0, hex(colors::ACCENT_HOVER)))
                        .child(
                            div()
                                .text_size(fs(11.0))
                                .text_color(hex(colors::TEXT))
                                .child(format!("{branch_label} · Git 图谱")),
                        )
                        .on_click(move |_, window, cx| {
                            git_graph::open(state_git.clone(), window, cx);
                        }),
                )
                .when(change_count > 0, |d| {
                    d.child(
                        h_flex()
                            .id("bento-changes-btn")
                            .h(px(22.0))
                            .px(px(8.0))
                            .gap(px(5.0))
                            .items_center()
                            .rounded(px(6.0))
                            .bg(hex(colors::TILE))
                            .border_1()
                            .border_color(hex(colors::BORDER_SUBTLE))
                            .cursor_pointer()
                            .hover(|h| h.bg(hex(colors::SURFACE_HOVER)))
                            .child(
                                div()
                                    .text_size(fs(11.0))
                                    .text_color(hex(colors::TEXT))
                                    .child(format!("{change_count} 变更")),
                            )
                            .child(
                                div()
                                    .text_size(fs(11.0))
                                    .text_color(hex(colors::STATUS_DONE))
                                    .child(format!("+{add_lines}")),
                            )
                            .child(
                                div()
                                    .text_size(fs(11.0))
                                    .text_color(hex(colors::STATUS_ERROR))
                                    .child(format!("−{del_lines}")),
                            )
                            .on_click(move |_, window, cx| {
                                on_changes(window, cx);
                            }),
                    )
                }),
        );

    // ── 2. 第一层：双列横向紧凑主动作卡 (.bento-primary-grid) ──
    let state_agent = state.clone();
    let state_term = state.clone();
    let primary_grid = div()
        .grid()
        .grid_cols(if narrow { 1 } else { 2 })
        .gap(px(10.0))
        .child(
            h_flex()
                .id("bento-start-agent")
                .py(px(12.0))
                .px(px(14.0))
                .gap(px(12.0))
                .items_center()
                .rounded(px(9.0))
                .border_1()
                .border_color(rgba_css(99, 102, 241, 0.45))
                .bg(bento_featured_bg())
                .cursor_pointer()
                .hover(|h| {
                    h.bg(hex(colors::SURFACE_HOVER))
                        .border_color(hex(colors::ACCENT))
                })
                .child(
                    div()
                        .size(fs(34.0))
                        .rounded(px(8.0))
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(rgba_css(192, 132, 252, 0.16))
                        .child(icon(IconName::Acp, 17.0, hex(colors::ACP_KIND))),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(1.0))
                        .child(
                            div()
                                .text_size(fs(13.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(hex(colors::TEXT_BRIGHT))
                                .child("启动 AI Coding Agent"),
                        )
                        .child(
                            div()
                                .text_size(fs(11.5))
                                .text_color(hex(colors::MUTED))
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .child(acp_subtitle),
                        ),
                )
                .child(kbd_badge("⌘N"))
                .on_click(move |_, window, cx| {
                    new_session::open(state_agent.clone(), window, cx);
                }),
        )
        .child(
            h_flex()
                .id("bento-start-term")
                .py(px(12.0))
                .px(px(14.0))
                .gap(px(12.0))
                .items_center()
                .rounded(px(9.0))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .bg(home_card_bg())
                .cursor_pointer()
                .hover(|h| {
                    h.bg(hex(colors::SURFACE_HOVER))
                        .border_color(hex(colors::ACCENT))
                })
                .child(
                    div()
                        .size(fs(34.0))
                        .rounded(px(8.0))
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .bg(rgba_css(52, 211, 153, 0.15))
                        .child(icon(IconName::Terminal, 17.0, hex(colors::TERMINAL_KIND))),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(1.0))
                        .child(
                            div()
                                .text_size(fs(13.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(hex(colors::TEXT_BRIGHT))
                                .child("新建交互式终端"),
                        )
                        .child(
                            div()
                                .text_size(fs(11.5))
                                .text_color(hex(colors::MUTED))
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .child("打开原生 GPU 加速 PTY 会话"),
                        ),
                )
                .child(kbd_badge("⌘T"))
                .on_click(move |_, window, cx| {
                    let ws_opt = workspace_target(&state_term, cx);
                    let r = state_term.update(cx, |s, cx| {
                        s.spawn_from_preset("shell", ws_opt.as_deref(), cx)
                            .map(|_| ())
                    });
                    if let Err(e) = r {
                        window.push_notification(
                            gpui_component::notification::Notification::error(e.to_string()),
                            cx,
                        );
                    }
                }),
        );

    // ── 3. 第二层：终端与 Agent 预设矩阵 ──
    let on_manage_presets = ctx.on_open_settings.clone();
    let preset_header = h_flex()
        .items_center()
        .justify_between()
        .child(
            div()
                .text_size(fs(11.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(hex(colors::MUTED))
                .child(format!("终端与 AGENT 预设 ({})", presets.len())),
        )
        .child(
            div()
                .id("bento-manage-presets")
                .text_size(fs(11.5))
                .text_color(hex(colors::ACCENT_HOVER))
                .cursor_pointer()
                .child("管理预设 →")
                .on_click(move |_, w, cx| on_manage_presets(w, cx)),
        );

    let preset_body: AnyElement = if presets.is_empty() {
        let on_add_preset = ctx.on_open_settings.clone();
        let st_restore = state.clone();
        h_flex()
            .py(px(12.0))
            .px(px(16.0))
            .gap(px(12.0))
            .items_center()
            .justify_between()
            .rounded(px(9.0))
            .border_1()
            .border_color(hex(colors::BORDER_SUBTLE))
            .bg(rgba_css(24, 28, 39, 0.4))
            .child(
                div()
                    .text_size(fs(12.0))
                    .text_color(hex(colors::MUTED))
                    .child(
                        "预设工具已全部移除。仍可使用上方两张主入口卡启动会话，或恢复默认预设。",
                    ),
            )
            .child(
                h_flex()
                    .gap(px(6.0))
                    .flex_shrink_0()
                    .child(
                        h_flex()
                            .id("bento-restore-presets")
                            .h(px(26.0))
                            .px(px(10.0))
                            .gap(px(5.0))
                            .items_center()
                            .rounded(px(6.0))
                            .bg(hex(colors::TILE))
                            .border_1()
                            .border_color(hex(colors::BORDER_SUBTLE))
                            .cursor_pointer()
                            .hover(|h| h.bg(hex(colors::SURFACE)))
                            .child(icon(IconName::Reset, 11.5, hex(colors::MUTED)))
                            .child(
                                div()
                                    .text_size(fs(11.5))
                                    .text_color(hex(colors::TEXT))
                                    .child("恢复默认预设"),
                            )
                            .on_click(move |_, _, cx| {
                                st_restore.update(cx, |s, cx| {
                                    s.settings.reset("presets");
                                    s.flush(cx);
                                    cx.emit(StateChanged);
                                });
                            }),
                    )
                    .child(
                        h_flex()
                            .id("bento-add-preset")
                            .h(px(26.0))
                            .px(px(10.0))
                            .gap(px(5.0))
                            .items_center()
                            .rounded(px(6.0))
                            .bg(hex(colors::SURFACE))
                            .border_1()
                            .border_color(hex(colors::BORDER_SUBTLE))
                            .cursor_pointer()
                            .hover(|h| h.bg(hex(colors::SURFACE_HOVER)))
                            .child(icon(IconName::Plus, 11.5, hex(colors::ACCENT_HOVER)))
                            .child(
                                div()
                                    .text_size(fs(11.5))
                                    .text_color(hex(colors::TEXT_BRIGHT))
                                    .child("添加预设"),
                            )
                            .on_click(move |_, w, cx| on_add_preset(w, cx)),
                    ),
            )
            .into_any_element()
    } else {
        home_pills(state, &presets, narrow).into_any_element()
    };

    // ── 4. 第三层：工作区会话列表 / 0 会话空态与快捷键速查条 ──
    let st_clear_all = state.clone();
    let ws_for_clear = ws_id.clone();
    let sessions_header = h_flex()
        .items_center()
        .justify_between()
        .child(
            div()
                .text_size(fs(11.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(hex(colors::MUTED))
                .child(format!("工作区会话 ({})", ws_threads.len())),
        )
        .when(!ws_threads.is_empty(), |d| {
            let ids_to_close: Vec<String> = ws_threads.iter().map(|t| t.id().to_owned()).collect();
            d.child(
                div()
                    .id("bento-clear-ws-sessions")
                    .text_size(fs(11.5))
                    .text_color(hex(colors::BELL))
                    .cursor_pointer()
                    .child("清空本工作区会话")
                    .on_click(move |_, _, cx| {
                        let _ = &ws_for_clear;
                        st_clear_all.update(cx, |s, cx| {
                            for tid in &ids_to_close {
                                s.close_thread(tid, cx);
                            }
                            s.flush(cx);
                            cx.emit(StateChanged);
                        });
                    }),
            )
        });

    let sessions_body: AnyElement = if ws_threads.is_empty() {
        let st_quick = state.clone();
        v_flex()
            .gap(px(10.0))
            .child(
                h_flex()
                    .py(px(16.0))
                    .px(px(18.0))
                    .gap(px(12.0))
                    .items_center()
                    .justify_between()
                    .rounded(px(9.0))
                    .border_1()
                    .border_color(hex(colors::BORDER_SUBTLE))
                    .bg(rgba_css(24, 28, 39, 0.35))
                    .child(
                        h_flex()
                            .gap(px(10.0))
                            .items_center()
                            .child(icon(IconName::Terminal, 16.0, hex(colors::FAINT)))
                            .child(
                                div()
                                    .text_size(fs(12.5))
                                    .text_color(hex(colors::MUTED))
                                    .child("当前工作区暂无活跃会话。点击上方卡片即可创建新会话。"),
                            ),
                    )
                    .child(
                        h_flex()
                            .id("bento-quick-shell")
                            .h(px(26.0))
                            .px(px(10.0))
                            .gap(px(5.0))
                            .items_center()
                            .flex_shrink_0()
                            .rounded(px(6.0))
                            .bg(hex(colors::TILE))
                            .border_1()
                            .border_color(hex(colors::BORDER_SUBTLE))
                            .cursor_pointer()
                            .hover(|h| h.bg(hex(colors::SURFACE)))
                            .child(icon(IconName::Plus, 11.5, hex(colors::ACCENT_HOVER)))
                            .child(
                                div()
                                    .text_size(fs(11.5))
                                    .text_color(hex(colors::TEXT))
                                    .child("快速启动终端"),
                            )
                            .on_click(move |_, window, cx| {
                                let ws_opt = workspace_target(&st_quick, cx);
                                let r = st_quick.update(cx, |s, cx| {
                                    s.spawn_from_preset("shell", ws_opt.as_deref(), cx)
                                        .map(|_| ())
                                });
                                if let Err(e) = r {
                                    window.push_notification(
                                        gpui_component::notification::Notification::error(
                                            e.to_string(),
                                        ),
                                        cx,
                                    );
                                }
                            }),
                    ),
            )
            // 0 会话空态下的 4 列全局快捷键速查导览条
            .child(
                div()
                    .grid()
                    .grid_cols(if narrow { 2 } else { 4 })
                    .gap(px(8.0))
                    .children(
                        [
                            ("⌘N / Ctrl-Shift-N", "打开工具命令面板"),
                            ("⌘K / Ctrl-K", "全局搜索与跳转会话"),
                            ("⌘, / Ctrl-,", "打开独立设置窗口"),
                            ("Ctrl-Shift-G", "查看 Git 提交图谱"),
                        ]
                        .into_iter()
                        .map(|(k, lbl)| {
                            v_flex()
                                .py(px(8.0))
                                .px(px(10.0))
                                .gap(px(3.0))
                                .rounded(px(7.0))
                                .bg(rgba_css(24, 28, 39, 0.35))
                                .border_1()
                                .border_color(hex(colors::BORDER))
                                .child(
                                    div()
                                        .font_family("monospace")
                                        .text_size(fs(10.5))
                                        .text_color(hex(colors::ACCENT_HOVER))
                                        .child(k),
                                )
                                .child(
                                    div()
                                        .text_size(fs(11.0))
                                        .text_color(hex(colors::MUTED))
                                        .child(lbl),
                                )
                        }),
                    ),
            )
            .into_any_element()
    } else {
        let mut rows_col = v_flex().gap(px(4.0)).pr(px(4.0));
        for t in ws_threads {
            let tid = t.id().to_owned();
            let tid_close = tid.clone();
            let st_act = state.clone();
            let st_cls = state.clone();
            let is_exited = t
                .as_terminal()
                .is_some_and(|term| term.status == RunStatus::Exited);
            let (ic, ic_col, kind_tag) = match &t {
                Thread::Terminal(_) => (
                    IconName::Terminal,
                    if is_exited {
                        hex(colors::FAINT)
                    } else {
                        hex(colors::TERMINAL_KIND)
                    },
                    "TERMINAL",
                ),
                Thread::Chat(_) => (IconName::Chat, hex(colors::ACCENT_HOVER), "CHAT"),
                Thread::Acp(_) => (IconName::Acp, hex(colors::ACP_KIND), "ACP"),
            };
            let pending = match &t {
                Thread::Chat(c) => c.pending_reply,
                Thread::Acp(a) => a.pending_reply,
                Thread::Terminal(_) => false,
            };
            let has_bell = t.as_terminal().is_some_and(|term| term.has_bell);
            let unread = t.common().unread;
            let pinned = t.common().pin;
            let view_count = t.common().views.len();
            let meta_right = if view_count > 0 {
                format!("{} 视图", view_count + 1)
            } else {
                kind_tag.to_owned()
            };

            rows_col = rows_col.child(
                h_flex()
                    .id(ElementId::Name(format!("bento-thread-{tid}").into()))
                    .h(px(32.0))
                    .px(px(10.0))
                    .gap(px(8.0))
                    .items_center()
                    .flex_shrink_0()
                    .rounded(px(7.0))
                    .bg(rgba_css(24, 28, 39, 0.55))
                    .border_1()
                    .border_color(hex(colors::BORDER))
                    .cursor_pointer()
                    .hover(|h| h.bg(hex(colors::SURFACE)))
                    .when(is_exited, |d| d.opacity(0.65))
                    .on_click(move |_, _, cx| {
                        st_act.update(cx, |s, cx| {
                            s.activate(ActiveTarget::Thread(tid.clone()), cx);
                        });
                    })
                    .child(icon(ic, 13.0, ic_col))
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_size(fs(12.5))
                            .font_weight(if unread {
                                FontWeight::SEMIBOLD
                            } else {
                                FontWeight::MEDIUM
                            })
                            .text_color(if is_exited {
                                hex(colors::MUTED)
                            } else {
                                hex(colors::TEXT_BRIGHT)
                            })
                            .child(t.title()),
                    )
                    .when(pinned, |d| {
                        d.child(icon(IconName::Pin, 11.0, hex(colors::FAINT)))
                    })
                    .when(pending, |d| {
                        d.child(
                            div()
                                .px(px(6.0))
                                .rounded(px(4.0))
                                .bg(rgba_css(251, 191, 36, 0.14))
                                .border_1()
                                .border_color(rgba_css(251, 191, 36, 0.30))
                                .text_size(fs(10.0))
                                .text_color(hex(colors::STATUS_RUNNING))
                                .child("思考中…"),
                        )
                    })
                    .when(has_bell, |d| {
                        d.child(
                            div()
                                .px(px(6.0))
                                .rounded(px(4.0))
                                .bg(rgba_css(192, 132, 252, 0.14))
                                .border_1()
                                .border_color(rgba_css(192, 132, 252, 0.30))
                                .text_size(fs(10.0))
                                .text_color(hex(colors::ACP_KIND))
                                .child("🔔 等待注意"),
                        )
                    })
                    .when(!is_exited && unread && !pending, |d| {
                        d.child(
                            div()
                                .px(px(5.0))
                                .rounded(px(4.0))
                                .bg(accent_soft())
                                .text_size(fs(10.0))
                                .text_color(hex(colors::ACCENT_HOVER))
                                .child("未读"),
                        )
                    })
                    .when(is_exited, |d| {
                        d.child(
                            div()
                                .font_family("monospace")
                                .text_size(fs(10.5))
                                .text_color(hex(colors::FAINT))
                                .child("[已退出]"),
                        )
                    })
                    .child(div().flex_1())
                    .child(
                        div()
                            .font_family("monospace")
                            .text_size(fs(10.5))
                            .text_color(hex(colors::FAINT))
                            .child(meta_right),
                    )
                    .child(
                        div()
                            .id(ElementId::Name(format!("bento-close-{tid_close}").into()))
                            .size(fs(22.0))
                            .rounded(px(5.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .hover(|h| h.bg(hex(colors::CLOSE_HOVER)))
                            .child(icon(IconName::Close, 11.5, hex(colors::MUTED)))
                            .on_click(move |_, _, cx| {
                                cx.stop_propagation();
                                st_cls.update(cx, |s, cx| {
                                    s.close_thread(&tid_close, cx);
                                    s.flush(cx);
                                    cx.emit(StateChanged);
                                });
                            }),
                    ),
            );
        }
        nested_scroll::nested_max_h_scrollable(
            "bento-sessions-list",
            &ctx.sessions_scroll,
            px(204.0),
            rows_col,
        )
        .into_any_element()
    };

    nested_scroll::isolated_scrollable("bento-launchpad", &ctx.outer_scroll)
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .min_h_0()
        .items_center()
        .justify_center()
        .bg(hex(colors::PANE))
        .py(px(24.0))
        .px(px(pane_padding(narrow)))
        .child(
            v_flex()
                .w_full()
                .max_w(px(680.0))
                .gap(px(14.0))
                .child(hero)
                .child(primary_grid)
                .child(preset_header)
                .child(preset_body)
                .child(sessions_header)
                .child(sessions_body),
        )
        .into_any_element()
}

fn kbd_badge(label: &'static str) -> gpui::Div {
    div()
        .py(px(2.0))
        .px(px(6.0))
        .rounded(px(5.0))
        .flex_shrink_0()
        .bg(rgba_css(255, 255, 255, 0.05))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .font_family("monospace")
        .text_size(fs(10.5))
        .text_color(hex(colors::MUTED))
        .child(label)
}

/// 预设胶囊矩阵（.bento-preset-grid）：3 列 gap 8（窄屏 1 列，单预设 2 列），末尾附带「更多工具…」。
fn home_pills(state: &Entity<AppState>, presets: &[TerminalPreset], narrow: bool) -> gpui::Div {
    let state_more = state.clone();
    div()
        .grid()
        .grid_cols(bento_preset_columns(narrow, presets.len()))
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
        .child(
            div()
                .id("preset-more-tools")
                .flex()
                .flex_row()
                .items_center()
                .gap(px(7.0))
                .w_full()
                .h(px(40.0))
                .pl(px(11.0))
                .pr(px(11.0))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .rounded(px(8.0))
                .bg(rgba_css(24, 28, 39, 0.60))
                .cursor_pointer()
                .hover(|h| {
                    h.bg(hex(colors::SURFACE_HOVER))
                        .border_color(accent_alpha(0.45))
                })
                .child(
                    div()
                        .size(fs(24.0))
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(6.0))
                        .bg(hex(colors::SURFACE))
                        .child(icon(IconName::Plus, 14.0, hex(colors::ACCENT_HOVER))),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(fs(12.0))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .child("更多工具…"),
                )
                .child(icon(IconName::ArrowRight, 12.0, hex(colors::FAINT)))
                .on_click(move |_, window, cx| {
                    new_session::open(state_more.clone(), window, cx);
                }),
        )
}

/// 归属工作区：激活工作区优先；起始页（无激活）时落第一个工作区。
fn workspace_target(state: &Entity<AppState>, cx: &App) -> Option<String> {
    let s = state.read(cx);
    let active = s.active_workspace_id();
    if !active.is_empty() {
        return Some(active);
    }
    s.workspaces().first().map(|w| w.id.clone())
}

/// 单个预设 pill（.pill）：h 40 / pad 0 11 / r8 / rgba(24,28,39,.6) 底 +
/// pill-icon 24² r6 surface 块 + label + arrowRight 12 尾标。
fn pill(p: &TerminalPreset) -> gpui::Stateful<gpui::Div> {
    div()
        .id(format!("preset-{}", p.id))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(7.0))
        .w_full()
        .h(px(40.0))
        .pl(px(11.0))
        .pr(px(11.0))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .rounded(px(8.0))
        .bg(rgba_css(24, 28, 39, 0.60))
        .cursor_pointer()
        .hover(|h| {
            h.bg(hex(colors::SURFACE_HOVER))
                .border_color(accent_alpha(0.45))
        })
        .child(
            div()
                .size(fs(24.0))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.0))
                .bg(hex(colors::SURFACE))
                .child(icon(preset_icon(p), 14.0, hex(colors::ACCENT_HOVER))),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(fs(12.0))
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

fn hero_icon_bg() -> gpui::Background {
    linear_gradient(
        135.0,
        linear_color_stop(rgba_css(99, 102, 241, 0.22), 0.0),
        linear_color_stop(rgba_css(192, 132, 252, 0.12), 1.0),
    )
}

fn bento_featured_bg() -> gpui::Background {
    linear_gradient(
        160.0,
        linear_color_stop(rgba_css(99, 102, 241, 0.18), 0.0),
        linear_color_stop(rgba_css(24, 28, 39, 0.78), 1.0),
    )
}

/// home-card 渐变：Obsidian Indigo 深邃微光玻璃渐变。
fn home_card_bg() -> gpui::Background {
    linear_gradient(
        145.0,
        linear_color_stop(rgba_css(24, 28, 39, 0.85), 0.0),
        linear_color_stop(rgba_css(16, 19, 28, 0.94), 1.0),
    )
}

/// home-card 投影：`0 18px 50px rgba(0,0,0,.22)`。
#[allow(dead_code)]
fn home_card_shadow() -> Vec<BoxShadow> {
    vec![BoxShadow::new(px(0.0), px(18.0), black(0.22)).blur_radius(px(50.0))]
}

/// accentSoft = rgba(99,102,241,.15)。
fn accent_soft() -> Hsla {
    accent_alpha(0.15)
}

#[allow(dead_code)]
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

    /// 卡渐变：145deg 两端值
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
        assert!(home_card_bg().as_solid().is_none());
        assert!(bento_featured_bg().as_solid().is_none());
    }

    /// 窄态翻转与 Bento 预设矩阵列数
    #[test]
    fn narrow_breakpoint_flips_paddings_and_pill_columns() {
        assert_eq!(pane_padding(false), 32.0);
        assert_eq!(pane_padding(true), 18.0);
        assert_eq!(card_padding(false), 34.0);
        assert_eq!(card_padding(true), 24.0);
        assert_eq!(pill_columns(false), 2);
        assert_eq!(pill_columns(true), 1);
        assert_eq!(bento_preset_columns(false, 5), 3);
        assert_eq!(bento_preset_columns(false, 1), 2);
        assert_eq!(bento_preset_columns(true, 5), 1);
    }
}
