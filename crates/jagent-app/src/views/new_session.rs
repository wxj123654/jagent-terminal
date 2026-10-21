//! 「新建会话」弹窗（对应原型 `Dialogs.tsx` 的 `ToolDialog` · Spotlight 命令面板风格）。
//!
//! 规则全在 `jagent_core::new_session::build`；这里把 `Model` 渲染为：
//! 1. 目标工作区胶囊切换条 + 右侧目录路径；
//! 2. 34px 放大镜过滤搜索框 + `⌘N` 徽标；
//! 3. 分组列表（AI 编程预设采用 2 列网格卡片，其余分组采用带语义图标盒的单列行）；
//! 4. 底部快捷键提示栏。

use gpui::{
    App, AppContext as _, Context, Entity, Focusable as _, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement, Render, StatefulInteractiveElement as _, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_component::{
    WindowExt as _, h_flex,
    input::{Input, InputEvent, InputState},
    notification::Notification,
    v_flex,
};
use jagent_core::new_session::{self, Group, Model, Pick, RowIcon, ToolRow};

use crate::icons::{IconName, icon};
use crate::state::AppState;
use crate::theme::{accent_alpha, colors, hex, rgba_css};
use crate::ui_scale::fs;

pub struct NewSessionView {
    state: Entity<AppState>,
    /// 打开弹窗时的归属（空串 = 临时入口）。决定工作区下拉是否带「临时会话」首项。
    initial_workspace: String,
    /// 当前选中的工作区（空串 = 未归属）。
    selected_workspace: String,
    filter: Entity<InputState>,
    selected_index: usize,
    focus_input: bool,
}

impl NewSessionView {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::new_for_workspace(state, None, window, cx)
    }

    pub fn new_for_workspace(
        state: Entity<AppState>,
        workspace_override: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let initial_workspace =
            workspace_override.unwrap_or_else(|| state.read(cx).active_workspace_id());
        let filter = cx.new(|cx| {
            InputState::new(window, cx).placeholder("过滤预设工具、ACP 代理或 Shell 命令…")
        });
        cx.subscribe_in(
            &filter,
            window,
            |this, _, ev: &InputEvent, window, cx| match ev {
                InputEvent::Change => {
                    this.selected_index = 0;
                    cx.notify();
                }
                InputEvent::PressEnter { .. } => {
                    this.launch_selected(window, cx);
                }
                _ => {}
            },
        )
        .detach();
        let initial_selected_index = {
            let s = state.read(cx);
            let settings = s.settings.get();
            let preferred_preset = settings
                .presets
                .plus_default
                .as_deref()
                .filter(|id| !id.is_empty())
                .or(s.threads.last_used_preset.as_deref());
            let model = new_session::build(
                &settings.presets.items,
                &settings.acp_agents,
                s.workspaces(),
                &initial_workspace,
                &initial_workspace,
                "",
            );
            preferred_preset
                .and_then(|pid| {
                    model
                        .groups
                        .iter()
                        .flat_map(|g| &g.rows)
                        .position(|r| matches!(&r.pick, Pick::SpawnPreset { preset_id, .. } if preset_id == pid))
                })
                .unwrap_or(0)
        };
        Self {
            state,
            selected_workspace: initial_workspace.clone(),
            initial_workspace,
            filter,
            selected_index: initial_selected_index,
            focus_input: true,
        }
    }

    fn model(&self, cx: &App) -> Model {
        let s = self.state.read(cx);
        let settings = s.settings.get();
        let filter = self.filter.read(cx).value().to_string();
        let mut model = new_session::build(
            &settings.presets.items,
            &settings.acp_agents,
            s.workspaces(),
            &self.initial_workspace,
            &self.selected_workspace,
            &filter,
        );
        // 当已配置真实 ACP Agent 时，隐藏原型遗留的 `New Chat`（echo stub）占位项
        if !settings.acp_agents.is_empty() {
            for g in &mut model.groups {
                g.rows.retain(|r| r.id != "new-chat");
            }
            model.groups.retain(|g| !g.rows.is_empty());
        }
        model
    }

    fn flattened_picks(&self, cx: &App) -> Vec<(String, Pick)> {
        let model = self.model(cx);
        model
            .groups
            .into_iter()
            .flat_map(|g| g.rows.into_iter().map(|r| (r.id, r.pick)))
            .collect()
    }

    pub fn selected_workspace(&self) -> &str {
        &self.selected_workspace
    }

    pub fn move_selection(&mut self, delta: isize, cx: &mut Context<Self>) {
        let picks = self.flattened_picks(cx);
        let len = picks.len();
        if len == 0 {
            return;
        }
        let cur = self.selected_index.min(len - 1) as isize;
        self.selected_index = (cur + delta).rem_euclid(len as isize) as usize;
        cx.notify();
    }

    pub fn launch_selected(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let picks = self.flattened_picks(cx);
        if picks.is_empty() {
            return;
        }
        let ix = self.selected_index.min(picks.len() - 1);
        let (_, pick) = &picks[ix];
        apply(&self.state, pick, window, cx);
        if window.root::<gpui_base::Root>().flatten().is_some() {
            window.close_dialog(cx);
        }
    }
}

impl Render for NewSessionView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.focus_input {
            self.focus_input = false;
            let handle = self.filter.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
        }
        let model = self.model(cx);
        let this = cx.entity();
        let cwd_label = model.cwd.clone().unwrap_or_else(|| "临时目录".to_owned());
        let flat_ids: Vec<String> = model
            .groups
            .iter()
            .flat_map(|g| g.rows.iter().map(|r| r.id.clone()))
            .collect();
        let total_rows = flat_ids.len();
        let selected_row_id = if total_rows == 0 {
            None
        } else {
            flat_ids
                .get(self.selected_index.min(total_rows - 1))
                .cloned()
        };
        let weak_up = this.downgrade();
        let weak_down = this.downgrade();
        let key_interceptor = gpui::canvas(
            |_, _, _| (),
            move |_, _, window, _cx| {
                if total_rows == 0 {
                    return;
                }
                let weak_up = weak_up.clone();
                window.on_action(
                    std::any::TypeId::of::<gpui_base::input::MoveUp>(),
                    move |_, phase, _window, cx| {
                        if phase == gpui::DispatchPhase::Capture {
                            let _ = weak_up.update(cx, |v, cx| v.move_selection(-1, cx));
                            cx.stop_propagation();
                        }
                    },
                );
                let weak_down = weak_down.clone();
                window.on_action(
                    std::any::TypeId::of::<gpui_base::input::MoveDown>(),
                    move |_, phase, _window, cx| {
                        if phase == gpui::DispatchPhase::Capture {
                            let _ = weak_down.update(cx, |v, cx| v.move_selection(1, cx));
                            cx.stop_propagation();
                        }
                    },
                );
            },
        )
        .size_0()
        .absolute();

        // 1. 目标工作区胶囊切换条
        let workspace_bar = h_flex()
            .py(px(6.0))
            .px(px(8.0))
            .gap(px(8.0))
            .items_center()
            .justify_between()
            .rounded(px(8.0))
            .bg(hex(colors::INPUT_BG))
            .border_1()
            .border_color(hex(colors::BORDER_SUBTLE))
            .child(
                h_flex()
                    .gap(px(4.0))
                    .flex_wrap()
                    .items_center()
                    .child(
                        div()
                            .mr(px(4.0))
                            .text_size(fs(11.0))
                            .text_color(hex(colors::MUTED))
                            .child("目标工作区:"),
                    )
                    .children(model.workspace_options.iter().map(|opt| {
                        let value = opt.value.clone();
                        let active = opt.value == self.selected_workspace;
                        let this = this.clone();
                        chip(&opt.label, active, move |_, _, cx| {
                            this.update(cx, |v, cx| {
                                v.selected_workspace = value.clone();
                                cx.notify();
                            });
                        })
                    })),
            )
            .child(
                div()
                    .max_w(px(180.0))
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .font_family("monospace")
                    .text_size(fs(10.5))
                    .text_color(hex(colors::FAINT))
                    .child(cwd_label),
            );

        // 2. 搜索过滤框 (.tool-filter)
        let filter_bar = h_flex()
            .h(px(34.0))
            .px(px(10.0))
            .gap(px(8.0))
            .items_center()
            .rounded(px(8.0))
            .bg(hex(colors::INPUT_BG))
            .border_1()
            .border_color(hex(colors::BORDER_SUBTLE))
            .child(icon(IconName::Search, 14.0, hex(colors::MUTED)))
            .child(
                div().flex_1().min_w_0().child(
                    Input::new(&self.filter)
                        .appearance(false)
                        .h_full()
                        .text_size(fs(12.5))
                        .text_color(hex(colors::TEXT_BRIGHT)),
                ),
            )
            .child(
                div()
                    .font_family("monospace")
                    .text_size(fs(10.0))
                    .text_color(hex(colors::FAINT))
                    .child("⌘N"),
            );

        // 3. 工具分组列表
        let body: Vec<_> = if model.empty {
            vec![
                div()
                    .p(px(16.0))
                    .text_center()
                    .text_size(fs(12.0))
                    .text_color(hex(colors::MUTED))
                    .child("没有匹配工具。自定义命令可在设置的预设/ACP 分区添加。")
                    .into_any_element(),
            ]
        } else {
            model
                .groups
                .iter()
                .enumerate()
                .map(|(idx, g)| group_view(idx == 0, g, selected_row_id.as_deref(), &self.state))
                .collect()
        };

        // 4. 底部快捷键提示栏
        let footer = h_flex()
            .pt(px(8.0))
            .mt(px(4.0))
            .items_center()
            .justify_between()
            .border_t_1()
            .border_color(hex(colors::BORDER))
            .text_size(fs(11.0))
            .text_color(hex(colors::MUTED))
            .child("点击任一工具立即在目标工作区下启动会话")
            .child(
                div()
                    .font_family("monospace")
                    .text_size(fs(10.5))
                    .text_color(hex(colors::FAINT))
                    .child("↑↓ 选择 · ↵ 启动 · Esc 关闭"),
            );

        v_flex()
            .gap(px(8.0))
            .child(key_interceptor)
            .child(workspace_bar)
            .child(filter_bar)
            .child(
                v_flex()
                    .id("new-session-tool-list")
                    .max_h(px(360.0))
                    .overflow_y_scroll()
                    .gap(px(8.0))
                    .children(body),
            )
            .child(footer)
    }
}

/// 打开「新建会话」弹窗。
pub fn open(state: Entity<AppState>, window: &mut Window, cx: &mut App) {
    open_for_workspace(state, None, window, cx);
}

/// 打开指定目标工作区的「新建会话」弹窗。
pub fn open_for_workspace(
    state: Entity<AppState>,
    workspace_id: Option<String>,
    window: &mut Window,
    cx: &mut App,
) {
    let view = cx.new(|cx| NewSessionView::new_for_workspace(state, workspace_id, window, cx));
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.title("新建会话").w(px(520.0)).child(view.clone())
    });
}

/// 侧栏 `+` / 新建会话按钮动作：
/// - 若 `force_dialog == false` 且用户在设置中显式配置了 `presets.plusDefault`（非空且存在于预设列表），
///   则直接在目标工作区下启动该默认预设；
/// - 否则打开「新建会话」命令面板（目标工作区锁定为 `workspace_id`，且默认高亮上次使用的预设）。
pub fn trigger_plus_or_open(
    state: Entity<AppState>,
    workspace_id: Option<String>,
    force_dialog: bool,
    window: &mut Window,
    cx: &mut App,
) {
    if !force_dialog {
        let plus_preset = {
            let s = state.read(cx);
            let settings = s.settings.get();
            settings
                .presets
                .plus_default
                .as_deref()
                .filter(|id| !id.is_empty() && settings.presets.items.iter().any(|p| p.id == *id))
                .map(str::to_owned)
        };
        if let Some(preset_id) = plus_preset {
            let target_ws = workspace_id.or_else(|| {
                let s = state.read(cx);
                let active = s.active_workspace_id();
                if !active.is_empty() {
                    Some(active)
                } else {
                    s.workspaces().first().map(|w| w.id.clone())
                }
            });
            let r = state.update(cx, |s, cx| {
                s.spawn_from_preset(&preset_id, target_ws.as_deref(), cx)
                    .map(|_| ())
            });
            if let Err(e) = r
                && window.root::<gpui_base::Root>().flatten().is_some()
            {
                window.push_notification(Notification::error(format!("启动默认预设失败：{e}")), cx);
            }
            return;
        }
    }
    open_for_workspace(state, workspace_id, window, cx);
}

fn group_view(
    is_first: bool,
    g: &Group,
    selected_row_id: Option<&str>,
    state: &Entity<AppState>,
) -> gpui::AnyElement {
    let header = div()
        .px(px(4.0))
        .pt(px(4.0))
        .text_size(fs(10.5))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(hex(colors::MUTED))
        .child(format!("{} ({})", g.label, g.rows.len()));

    if is_first && g.rows.len() > 1 {
        v_flex()
            .gap(px(6.0))
            .child(header)
            .child(
                div().grid().grid_cols(2).gap(px(6.0)).children(
                    g.rows
                        .iter()
                        .map(|row| row_view(row, true, selected_row_id == Some(&row.id), state)),
                ),
            )
            .into_any_element()
    } else {
        v_flex()
            .gap(px(4.0))
            .child(header)
            .children(
                g.rows
                    .iter()
                    .map(|row| row_view(row, false, selected_row_id == Some(&row.id), state)),
            )
            .into_any_element()
    }
}

fn row_view(
    row: &ToolRow,
    compact_card: bool,
    is_selected: bool,
    state: &Entity<AppState>,
) -> gpui::AnyElement {
    let state = state.clone();
    let pick = row.pick.clone();
    let (ic_name, ic_fg, ic_bg) = match row.icon {
        RowIcon::Agent => (
            IconName::Agent,
            hex(colors::ACCENT_HOVER),
            accent_alpha(0.16),
        ),
        RowIcon::Terminal => (
            IconName::Terminal,
            hex(colors::TERMINAL_KIND),
            rgba_css(52, 211, 153, 0.15),
        ),
        RowIcon::Chat => (
            IconName::Chat,
            hex(colors::ACCENT_HOVER),
            accent_alpha(0.16),
        ),
        RowIcon::Acp => (
            IconName::Acp,
            hex(colors::ACP_KIND),
            rgba_css(192, 132, 252, 0.16),
        ),
    };

    div()
        .id(row.id.clone())
        .flex()
        .flex_row()
        .items_center()
        .gap(px(9.0))
        .py(px(7.0))
        .px(px(9.0))
        .rounded(px(8.0))
        .border_1()
        .when_else(
            is_selected,
            |d| {
                d.bg(hex(colors::SURFACE_ACTIVE))
                    .border_color(accent_alpha(0.55))
            },
            |d| {
                if compact_card {
                    d.bg(rgba_css(24, 28, 39, 0.55))
                        .border_color(hex(colors::BORDER_SUBTLE))
                } else {
                    d.border_color(gpui::transparent_black())
                }
            },
        )
        .cursor_pointer()
        .hover(|s| s.bg(hex(colors::SURFACE)))
        .child(
            div()
                .size(fs(28.0))
                .rounded(px(7.0))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .bg(ic_bg)
                .child(icon(ic_name, 14.0, ic_fg)),
        )
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .gap(px(1.0))
                .child(
                    h_flex()
                        .gap(px(6.0))
                        .items_center()
                        .child(
                            div()
                                .text_size(fs(12.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(hex(colors::TEXT_BRIGHT))
                                .child(row.name.clone()),
                        )
                        .when(row.recommended, |d| {
                            d.child(
                                div()
                                    .px(px(5.0))
                                    .rounded(px(4.0))
                                    .bg(accent_alpha(0.16))
                                    .text_size(fs(10.0))
                                    .text_color(hex(colors::ACCENT_HOVER))
                                    .child("默认"),
                            )
                        }),
                )
                .when_some(row.description.clone(), |el, d| {
                    el.child(
                        div()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_size(fs(11.0))
                            .text_color(hex(colors::MUTED))
                            .child(d),
                    )
                }),
        )
        .when(!compact_card && !row.command.is_empty(), |d| {
            d.child(
                div()
                    .font_family("monospace")
                    .text_size(fs(11.0))
                    .text_color(hex(colors::FAINT))
                    .child(row.command.clone()),
            )
        })
        .on_click(move |_, window, cx| {
            apply(&state, &pick, window, cx);
            if window.root::<gpui_base::Root>().flatten().is_some() {
                window.close_dialog(cx);
            }
        })
        .into_any_element()
}

/// 把一次选择落到 store 上。失败以 Toast 提示（不再只写 stderr）。
fn apply(state: &Entity<AppState>, pick: &Pick, window: &mut Window, cx: &mut App) {
    let result = match pick {
        Pick::SpawnPreset {
            preset_id,
            workspace_id,
        } => state.update(cx, |s, cx| {
            s.spawn_from_preset(preset_id, workspace_id.as_deref(), cx)
                .map(|_| ())
                .map_err(|e| e.to_string())
        }),
        Pick::NewChat { workspace_id } => state.update(cx, |s, cx| {
            let first_acp = s.settings.get().acp_agents.first().cloned();
            if let Some(ag) = first_acp {
                s.create_acp(&ag.id, &ag.label, Some(workspace_id), cx)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            } else {
                s.create_chat(Some(workspace_id), cx)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }
        }),
        Pick::NewAcp {
            agent_id,
            label,
            workspace_id,
        } => state.update(cx, |s, cx| {
            s.create_acp(agent_id, label, workspace_id.as_deref(), cx)
                .map(|_| ())
                .map_err(|e| e.to_string())
        }),
    };
    if let Err(e) = result
        && window.root::<gpui_base::Root>().flatten().is_some()
    {
        window.push_notification(Notification::error(format!("新建会话失败：{e}")), cx);
    }
}

fn chip(
    label: &str,
    active: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> gpui::AnyElement {
    h_flex()
        .id(label.to_owned())
        .h(px(22.0))
        .px(px(8.0))
        .gap(px(4.0))
        .items_center()
        .rounded(px(5.0))
        .text_size(fs(11.5))
        .cursor_pointer()
        .border_1()
        .when_else(
            active,
            |el| {
                el.bg(accent_alpha(0.16))
                    .border_color(accent_alpha(0.45))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(hex(colors::TEXT_BRIGHT))
            },
            |el| {
                el.border_color(gpui::transparent_black())
                    .text_color(hex(colors::MUTED))
                    .hover(|s| s.bg(hex(colors::SURFACE)))
            },
        )
        .child(icon(IconName::Folder, 11.0, hex(colors::ACCENT_HOVER)))
        .child(label.to_owned())
        .on_click(on_click)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use gpui::TestAppContext;
    use serde_json::json;

    use super::*;
    use crate::state::init;

    #[gpui::test]
    fn new_session_view_honors_workspace_override_and_keyboard_launch(cx: &mut TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        let (state, w2) = cx.update(|cx| {
            gpui_component::init(cx);
            let _ = crate::theme::install(cx);
            let state = init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let w2 = state.update(cx, |s, cx| {
                let id = s.threads.add_workspace("SecondWS", "/tmp/second");
                s.flush(cx);
                id
            });
            (state, w2)
        });

        let (view, vcx) = cx.add_window_view(|window, cx| {
            NewSessionView::new_for_workspace(state.clone(), Some(w2.clone()), window, cx)
        });

        vcx.read(|app| {
            assert_eq!(
                view.read(app).selected_workspace(),
                w2.as_str(),
                "指定工作区打开弹窗时应锁定该工作区"
            );
        });

        // 过滤到 "Pi (ACP)" 并调用 launch_selected 启动
        vcx.update(|window, app| {
            view.update(app, |v, cx| {
                v.filter.update(cx, |inp, cx| {
                    inp.set_value("pi-acp", window, cx);
                });
                v.launch_selected(window, cx);
            });
        });

        vcx.read(|app| {
            let s = state.read(app);
            assert_eq!(s.threads.threads.len(), 1);
            assert_eq!(
                s.threads.threads[0].workspace_id(),
                Some(w2.as_str()),
                "回车启动的会话应归属到弹窗当前选中的工作区"
            );
        });
    }

    #[gpui::test]
    fn trigger_plus_spawns_plus_default_preset_directly_when_configured(cx: &mut TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        let (state, w2) = cx.update(|cx| {
            gpui_component::init(cx);
            let _ = crate::theme::install(cx);
            let state = init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let w2 = state.update(cx, |s, cx| {
                s.settings.patch("presets.plusDefault", json!("shell"));
                let id = s
                    .threads
                    .add_workspace("SecondWS", &dir.path().to_string_lossy());
                s.flush(cx);
                id
            });
            (state, w2)
        });

        let (_, vcx) =
            cx.add_window_view(|window, cx| NewSessionView::new(state.clone(), window, cx));

        vcx.update(|window, app| {
            trigger_plus_or_open(state.clone(), Some(w2.clone()), false, window, app);
        });

        let tid = vcx.read(|app| {
            let s = state.read(app);
            assert_eq!(
                s.threads.threads.len(),
                1,
                "配置了 presets.plusDefault 时点击 + 直接在目标工作区启动预设"
            );
            assert_eq!(s.threads.threads[0].workspace_id(), Some(w2.as_str()));
            s.threads.threads[0].id().to_owned()
        });
        vcx.update(|_, app| {
            state.update(app, |s, cx| s.close_thread(&tid, cx));
        });
    }
}
