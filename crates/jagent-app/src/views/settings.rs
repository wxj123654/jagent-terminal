//! 设置页（P6）：7 个任务导向分区、搜索、即时写回、单项 reset、预设/ACP agent CRUD。
//!
//! `settings.json` 是唯一事实源，schema/store 在 `jagent-core`；本视图只把控件动作翻译为
//! `SettingsStore::patch/reset/*_preset/*_acp_agent`，每次变更立即 flush 并广播。
//! Keybindings 第一阶段只读；主题/调色板保持单主题，不提供编辑器。

use gpui::{
    App, AppContext as _, Context, Entity, Focusable, InteractiveElement, IntoElement,
    ParentElement, Render, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_component::{
    ActiveTheme, Disableable as _,
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputEvent, InputState, Textarea, TextareaState},
    v_flex,
};
use jagent_core::settings::{
    AcpAgentInput, AcpAgentPatch, PresetInput, PresetPatch, Settings, serialize_settings,
};
use serde_json::json;

use crate::actions::CTX_SETTINGS;
use crate::state::{AppState, StateChanged};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Section {
    Presets,
    Notifications,
    Terminal,
    Appearance,
    Keybindings,
    AcpAgents,
    Advanced,
}

impl Section {
    pub const ALL: [Self; 7] = [
        Self::Presets,
        Self::Notifications,
        Self::Terminal,
        Self::Appearance,
        Self::Keybindings,
        Self::AcpAgents,
        Self::Advanced,
    ];
    pub fn id(self) -> &'static str {
        match self {
            Self::Presets => "presets",
            Self::Notifications => "notifications",
            Self::Terminal => "terminal",
            Self::Appearance => "appearance",
            Self::Keybindings => "keybindings",
            Self::AcpAgents => "acpAgents",
            Self::Advanced => "advanced",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Presets => "预设",
            Self::Notifications => "通知",
            Self::Terminal => "终端",
            Self::Appearance => "外观",
            Self::Keybindings => "键位",
            Self::AcpAgents => "ACP Agents",
            Self::Advanced => "高级",
        }
    }
}

pub struct SettingsView {
    state: Entity<AppState>,
    section: Section,
    query: String,
    search: Entity<InputState>,
    font_family: Entity<InputState>,
    edit_inputs: std::collections::HashMap<String, Entity<InputState>>,
    edit_textareas: std::collections::HashMap<String, Entity<TextareaState>>,
    focus_search: bool,
}

impl SettingsView {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.subscribe(&state, |_, _, _: &StateChanged, cx| cx.notify())
            .detach();
        let search = cx.new(|cx| InputState::new(window, cx));
        let initial_font = state.read(cx).settings.get().terminal.font_family.clone();
        let font_family = cx.new(|cx| {
            let mut input = InputState::new(window, cx);
            input.set_value(initial_font, window, cx);
            input
        });
        cx.subscribe_in(&search, window, |this, input, ev: &InputEvent, _, cx| {
            if matches!(ev, InputEvent::Change) {
                this.query = input.read(cx).value().to_string();
                cx.notify();
            }
        })
        .detach();
        let settings = state.clone();
        cx.subscribe_in(
            &font_family,
            window,
            move |_, input, ev: &InputEvent, window, cx| {
                if matches!(ev, InputEvent::Change) {
                    settings.update(cx, |s, cx| {
                        s.settings.patch(
                            "terminal.fontFamily",
                            json!(input.read(cx).value().to_string()),
                        );
                        s.flush(cx);
                        let restored = s.settings.get().terminal.font_family.clone();
                        input.update(cx, |input, cx| input.set_value(restored, window, cx));
                        let snapshot = s.settings.get().clone();
                        crate::state::apply_terminal_settings(cx, &snapshot);
                        cx.emit(StateChanged);
                    });
                }
            },
        )
        .detach();
        Self {
            state,
            section: Section::Presets,
            query: String::new(),
            search,
            font_family,
            edit_inputs: std::collections::HashMap::new(),
            edit_textareas: std::collections::HashMap::new(),
            focus_search: true,
        }
    }
}

impl SettingsView {
    pub fn focus_search(&mut self) {
        self.focus_search = true;
    }
}

impl Render for SettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.focus_search {
            self.focus_search = false;
            let handle = self.search.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
        }
        let theme = cx.theme().clone();
        let state = self.state.clone();
        let section = self.section;
        let query = self.query.trim().to_lowercase();
        let sections: Vec<_> = Section::ALL
            .into_iter()
            .filter(|s| query.is_empty() || section_matches(*s, &query))
            .collect();
        let nav = v_flex()
            .w(px(218.0))
            .h_full()
            .flex_shrink_0()
            .gap_1()
            .p_2()
            .border_r_1()
            .border_color(theme.border)
            .child(
                div()
                    .px_2()
                    .py_2()
                    .font_weight(gpui::FontWeight::BOLD)
                    .child("设置"),
            )
            .child(div().px_1().pb_2().child(Input::new(&self.search)))
            .children(sections.into_iter().map(|s| {
                let selected = section == s;
                let stateful = cx.entity().downgrade();
                div()
                    .id(format!("settings-nav-{}", s.id()))
                    .px_2()
                    .py_2()
                    .rounded(px(5.0))
                    .cursor_pointer()
                    .text_sm()
                    .when(selected, |d| {
                        d.bg(theme.secondary).text_color(theme.foreground)
                    })
                    .when(!selected, |d| {
                        d.text_color(theme.muted_foreground)
                            .hover(|d| d.bg(theme.list_hover))
                    })
                    .child(s.label())
                    .on_click(move |_, _, cx| {
                        let _ = stateful.update(cx, |v, cx| {
                            v.section = s;
                            cx.notify();
                        });
                    })
            }));
        let content = section_content(
            &self.state,
            section,
            &query,
            &self.font_family,
            &mut self.edit_inputs,
            &mut self.edit_textareas,
            window,
            cx,
        );
        let query_box = h_flex()
            .h(px(38.0))
            .px_3()
            .items_center()
            .border_b_1()
            .border_color(theme.border)
            .child(
                div()
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .child(section.label()),
            )
            .child(div().flex_1())
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child("即时生效 · 单项恢复默认"),
            );
        let _ = state;
        v_flex()
            .key_context(CTX_SETTINGS)
            .size_full()
            .bg(theme.background)
            .child(query_box)
            .child(
                h_flex().flex_1().min_h_0().child(nav).child(
                    div()
                        .id("settings-content")
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .overflow_y_scroll()
                        .child(content),
                ),
            )
    }
}

fn section_matches(section: Section, query: &str) -> bool {
    let (name, keys) = match section {
        Section::Presets => (
            "预设 presets",
            "presets.items presets.plusDefault program args initCommand cwd",
        ),
        Section::Notifications => (
            "通知 notifications",
            "notifications.desktop notifications.sound bel osc",
        ),
        Section::Terminal => (
            "终端 terminal",
            "terminal.fontFamily terminal.fontSize terminal.cursorBlink terminal.scrollbackLines terminal.palette terminal.closeOnExit",
        ),
        Section::Appearance => (
            "外观 appearance",
            "appearance.theme appearance.sidebarWidth",
        ),
        Section::Keybindings => (
            "键位 keybindings",
            "cycleNext cyclePrev toggleSettings focusSearch searchThreads toggleSidebar newSession",
        ),
        Section::AcpAgents => ("ACP Agents", "acpAgents command args label"),
        Section::Advanced => (
            "高级 advanced",
            "gpuBackend perfHud frameOverlay settings.json",
        ),
    };
    let query = query.to_lowercase();
    name.to_lowercase().contains(&query) || keys.to_lowercase().contains(&query)
}

fn section_content(
    state: &Entity<AppState>,
    section: Section,
    query: &str,
    font_family: &Entity<InputState>,
    edit_inputs: &mut std::collections::HashMap<String, Entity<InputState>>,
    edit_textareas: &mut std::collections::HashMap<String, Entity<TextareaState>>,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
) -> gpui::AnyElement {
    let settings = state.read(cx).settings.get().clone();
    let mut rows = v_flex().gap_2().p_4();
    match section {
        Section::Presets => {
            if query.is_empty() {
                rows = rows.child(div().text_sm().text_color(cx.theme().muted_foreground)
                .child("内置预设不可删除；可恢复默认。自定义预设可复制、删除。编辑器与预设菜单都使用同一 settings.json。"));
            }
            rows = rows.child(div().text_xs().child(format!(
                    "“+”默认预设：{}",
                    settings
                        .presets
                        .plus_default
                        .as_deref()
                        .unwrap_or("跟随上次使用")
                )));
            let visible_presets: Vec<_> = settings
                .presets
                .items
                .iter()
                .filter(|p| {
                    query.is_empty()
                        || format!(
                            "{} {} {} {}",
                            p.label,
                            p.id,
                            p.program.as_deref().unwrap_or(""),
                            p.init_command.as_deref().unwrap_or("")
                        )
                        .to_lowercase()
                        .contains(query)
                })
                .cloned()
                .collect();
            if !query.is_empty() && visible_presets.is_empty() {
                rows = rows.child(hint("无匹配预设", cx));
            }
            for preset in visible_presets {
                let id = preset.id.clone();
                let id_default = id.clone();
                let default_store = state.clone();
                let id_dup = id.clone();
                let id_reset = id.clone();
                let store = state.clone();
                let store_dup = store.clone();
                let store_reset = store.clone();
                let label_input = editor_input(
                    edit_inputs,
                    format!("preset:{id}:label"),
                    preset.label.clone(),
                    window,
                    cx,
                    {
                        let state = state.clone();
                        let id = id.clone();
                        move |value, input, window, cx| {
                            state.update(cx, |s, cx| {
                                s.settings.update_preset(
                                    &id,
                                    PresetPatch {
                                        label: Some(value),
                                        ..Default::default()
                                    },
                                );
                                let pending_label = s
                                    .settings
                                    .get()
                                    .presets
                                    .items
                                    .iter()
                                    .find(|p| p.id == id)
                                    .map(|p| p.label.clone())
                                    .unwrap_or_default();
                                input.update(cx, |editor, cx| {
                                    editor.set_value(pending_label, window, cx)
                                });
                                s.flush(cx);
                                let final_value = s
                                    .settings
                                    .get()
                                    .presets
                                    .items
                                    .iter()
                                    .find(|p| p.id == id)
                                    .map(|p| p.label.clone())
                                    .unwrap_or_default();
                                input.update(cx, |editor, cx| {
                                    editor.set_value(final_value, window, cx)
                                });
                                cx.emit(StateChanged);
                            })
                        }
                    },
                );
                let label_reset = label_input.clone();
                let _label_edit = label_input.clone();
                let program_input = editor_input(
                    edit_inputs,
                    format!("preset:{id}:program"),
                    preset.program.clone().unwrap_or_default(),
                    window,
                    cx,
                    {
                        let state = state.clone();
                        let id = id.clone();
                        move |value, input, window, cx| {
                            state.update(cx, |s, cx| {
                                s.settings.update_preset(
                                    &id,
                                    PresetPatch {
                                        program: Some(Some(value)),
                                        ..Default::default()
                                    },
                                );
                                let pending_value = s
                                    .settings
                                    .get()
                                    .presets
                                    .items
                                    .iter()
                                    .find(|p| p.id == id)
                                    .and_then(|p| p.program.clone())
                                    .unwrap_or_default();
                                input.update(cx, |editor, cx| {
                                    editor.set_value(pending_value, window, cx)
                                });
                                s.flush(cx);
                                let final_value = s
                                    .settings
                                    .get()
                                    .presets
                                    .items
                                    .iter()
                                    .find(|p| p.id == id)
                                    .and_then(|p| p.program.clone())
                                    .unwrap_or_default();
                                input.update(cx, |editor, cx| {
                                    editor.set_value(final_value, window, cx)
                                });
                                cx.emit(StateChanged);
                            })
                        }
                    },
                );
                let _program_edit = program_input.clone();
                let args_text = encode_args(&preset.args.clone().unwrap_or_default());
                let args_input = editor_textarea(
                    edit_textareas,
                    format!("preset:{id}:args"),
                    args_text,
                    window,
                    cx,
                    {
                        let state = state.clone();
                        let id = id.clone();
                        move |value, input, window, cx| {
                            state.update(cx, |s, cx| {
                                s.settings.update_preset(
                                    &id,
                                    PresetPatch {
                                        args: Some(Some(decode_args(&value))),
                                        ..Default::default()
                                    },
                                );
                                let pending_value = s
                                    .settings
                                    .get()
                                    .presets
                                    .items
                                    .iter()
                                    .find(|p| p.id == id)
                                    .and_then(|p| p.args.clone())
                                    .map(|args| encode_args(&args))
                                    .unwrap_or_default();
                                input.update(cx, |editor, cx| {
                                    editor.set_value(pending_value, window, cx)
                                });
                                s.flush(cx);
                                let final_value = s
                                    .settings
                                    .get()
                                    .presets
                                    .items
                                    .iter()
                                    .find(|p| p.id == id)
                                    .and_then(|p| p.args.clone())
                                    .map(|args| encode_args(&args))
                                    .unwrap_or_default();
                                input.update(cx, |editor, cx| {
                                    editor.set_value(final_value, window, cx)
                                });
                                cx.emit(StateChanged);
                            })
                        }
                    },
                );
                let _args_edit = args_input.clone();
                let env_text = preset
                    .env
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join("\n");
                let env_input = editor_textarea(
                    edit_textareas,
                    format!("preset:{id}:env"),
                    env_text,
                    window,
                    cx,
                    {
                        let state = state.clone();
                        let id = id.clone();
                        move |value, input, window, cx| {
                            state.update(cx, |s, cx| {
                                let env = value
                                    .lines()
                                    .filter_map(|line| line.split_once('='))
                                    .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
                                    .collect();
                                s.settings.update_preset(
                                    &id,
                                    PresetPatch {
                                        env: Some(Some(env)),
                                        ..Default::default()
                                    },
                                );
                                let pending_value = s
                                    .settings
                                    .get()
                                    .presets
                                    .items
                                    .iter()
                                    .find(|p| p.id == id)
                                    .and_then(|p| p.env.clone())
                                    .unwrap_or_default()
                                    .into_iter()
                                    .map(|(k, v)| format!("{k}={v}"))
                                    .collect::<Vec<_>>()
                                    .join("\n");
                                input.update(cx, |editor, cx| {
                                    editor.set_value(pending_value, window, cx)
                                });
                                s.flush(cx);
                                let final_value = s
                                    .settings
                                    .get()
                                    .presets
                                    .items
                                    .iter()
                                    .find(|p| p.id == id)
                                    .and_then(|p| p.env.clone())
                                    .unwrap_or_default()
                                    .into_iter()
                                    .map(|(k, v)| format!("{k}={v}"))
                                    .collect::<Vec<_>>()
                                    .join("\n");
                                input.update(cx, |editor, cx| {
                                    editor.set_value(final_value, window, cx)
                                });
                                cx.emit(StateChanged);
                            })
                        }
                    },
                );
                let _env_edit = env_input.clone();
                let init_input = editor_input(
                    edit_inputs,
                    format!("preset:{id}:init"),
                    preset.init_command.clone().unwrap_or_default(),
                    window,
                    cx,
                    {
                        let state = state.clone();
                        let id = id.clone();
                        move |value, input, window, cx| {
                            state.update(cx, |s, cx| {
                                s.settings.update_preset(
                                    &id,
                                    PresetPatch {
                                        init_command: Some(Some(value)),
                                        ..Default::default()
                                    },
                                );
                                let pending_value = s
                                    .settings
                                    .get()
                                    .presets
                                    .items
                                    .iter()
                                    .find(|p| p.id == id)
                                    .and_then(|p| p.init_command.clone())
                                    .unwrap_or_default();
                                input.update(cx, |editor, cx| {
                                    editor.set_value(pending_value, window, cx)
                                });
                                s.flush(cx);
                                let final_value = s
                                    .settings
                                    .get()
                                    .presets
                                    .items
                                    .iter()
                                    .find(|p| p.id == id)
                                    .and_then(|p| p.init_command.clone())
                                    .unwrap_or_default();
                                input.update(cx, |editor, cx| {
                                    editor.set_value(final_value, window, cx)
                                });
                                cx.emit(StateChanged);
                            })
                        }
                    },
                );
                let _init_edit = init_input.clone();
                let cwd_input = editor_input(
                    edit_inputs,
                    format!("preset:{id}:cwd"),
                    preset.cwd.clone().unwrap_or_default(),
                    window,
                    cx,
                    {
                        let state = state.clone();
                        let id = id.clone();
                        move |value, input, window, cx| {
                            state.update(cx, |s, cx| {
                                s.settings.update_preset(
                                    &id,
                                    PresetPatch {
                                        cwd: Some(Some(value)),
                                        ..Default::default()
                                    },
                                );
                                let pending_value = s
                                    .settings
                                    .get()
                                    .presets
                                    .items
                                    .iter()
                                    .find(|p| p.id == id)
                                    .and_then(|p| p.cwd.clone())
                                    .unwrap_or_default();
                                input.update(cx, |editor, cx| {
                                    editor.set_value(pending_value, window, cx)
                                });
                                s.flush(cx);
                                let final_value = s
                                    .settings
                                    .get()
                                    .presets
                                    .items
                                    .iter()
                                    .find(|p| p.id == id)
                                    .and_then(|p| p.cwd.clone())
                                    .unwrap_or_default();
                                input.update(cx, |editor, cx| {
                                    editor.set_value(final_value, window, cx)
                                });
                                cx.emit(StateChanged);
                            })
                        }
                    },
                );
                let _cwd_edit = cwd_input.clone();
                let program_reset = program_input.clone();
                let args_reset = args_input.clone();
                let env_reset = env_input.clone();
                let init_reset = init_input.clone();
                let cwd_reset = cwd_input.clone();
                let mut line = v_flex()
                    .gap_2()
                    .p_2()
                    .rounded(px(6.0))
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(Input::new(&label_input))
                            .child(Input::new(&program_input)),
                    )
                    .child(
                        v_flex()
                            .gap_1()
                            .child(div().text_xs().child("Args · 每行一个参数"))
                            .child(Textarea::new(&args_input).h(px(88.0))),
                    )
                    .child(
                        v_flex()
                            .gap_1()
                            .child(div().text_xs().child("Env · 每行 KEY=VALUE"))
                            .child(Textarea::new(&env_input).h(px(88.0))),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(div().w(px(42.0)).text_xs().child("Init"))
                            .child(Input::new(&init_input)),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(div().w(px(42.0)).text_xs().child("CWD"))
                            .child(Input::new(&cwd_input)),
                    );
                line = line.child(
                    Button::new(format!("preset-default-{id}"))
                        .label(
                            if settings.presets.plus_default.as_deref() == Some(id.as_str()) {
                                "默认+ ✓"
                            } else {
                                "设为+"
                            },
                        )
                        .on_click(move |_, _, cx| {
                            default_store.update(cx, |s, cx| {
                                s.settings.patch("presets.plusDefault", json!(id_default));
                                s.flush(cx);
                                cx.emit(StateChanged);
                            });
                        }),
                );
                line = line.child(
                    Button::new(format!("preset-copy-{id}"))
                        .label("复制")
                        .on_click(move |_, _, cx| {
                            store_dup.update(cx, |s, cx| {
                                s.settings.duplicate_preset(&id_dup);
                                s.flush(cx);
                                cx.emit(StateChanged);
                            });
                        }),
                );
                if preset.builtin {
                    line = line.child(
                        Button::new(format!("preset-reset-{id}"))
                            .label("重置")
                            .on_click(move |_, window, cx| {
                                store_reset.update(cx, |s, cx| {
                                    s.settings.reset_preset(&id_reset);
                                    s.flush(cx);
                                    // flush may roll the whole settings snapshot back on IO error;
                                    // synchronize every cached editor from that final state.
                                    let preset = s
                                        .settings
                                        .get()
                                        .presets
                                        .items
                                        .iter()
                                        .find(|p| p.id == id_reset)
                                        .cloned();
                                    if let Some(p) = preset {
                                        label_reset.update(cx, |input, cx| {
                                            input.set_value(p.label, window, cx)
                                        });
                                        program_reset.update(cx, |input, cx| {
                                            input.set_value(
                                                p.program.unwrap_or_default(),
                                                window,
                                                cx,
                                            )
                                        });
                                        args_reset.update(cx, |input, cx| {
                                            input.set_value(
                                                p.args.unwrap_or_default().join("\n"),
                                                window,
                                                cx,
                                            )
                                        });
                                        env_reset.update(cx, |input, cx| {
                                            input.set_value(
                                                p.env
                                                    .unwrap_or_default()
                                                    .into_iter()
                                                    .map(|(k, v)| format!("{k}={v}"))
                                                    .collect::<Vec<_>>()
                                                    .join("\n"),
                                                window,
                                                cx,
                                            )
                                        });
                                        init_reset.update(cx, |input, cx| {
                                            input.set_value(
                                                p.init_command.unwrap_or_default(),
                                                window,
                                                cx,
                                            )
                                        });
                                        cwd_reset.update(cx, |input, cx| {
                                            input.set_value(p.cwd.unwrap_or_default(), window, cx)
                                        });
                                    }
                                    cx.emit(StateChanged);
                                });
                            }),
                    );
                } else {
                    line = line.child(
                        Button::new(format!("preset-delete-{id}"))
                            .label("删除")
                            .on_click(move |_, _, cx| {
                                store.update(cx, |s, cx| {
                                    s.settings.delete_preset(&id);
                                    s.flush(cx);
                                    cx.emit(StateChanged);
                                });
                            }),
                    );
                }
                rows = rows.child(line);
            }
            let st = state.clone();
            rows = rows.child(
                Button::new("preset-add")
                    .primary()
                    .label("+ 新增预设")
                    .on_click(move |_, _, cx| {
                        st.update(cx, |s, cx| {
                            s.settings.add_preset(PresetInput {
                                label: "自定义预设".into(),
                                ..Default::default()
                            });
                            s.flush(cx);
                            cx.emit(StateChanged);
                        });
                    }),
            );
        }
        Section::Notifications => {
            if matches_query(query, "桌面通知", "notifications.desktop", "仅未聚焦 BEL") {
                rows = rows.child(toggle_row(
                    state,
                    &settings,
                    "notifications.desktop",
                    "桌面通知",
                    "仅未聚焦且收到 BEL 时触发",
                    cx,
                ));
            }
            if matches_query(query, "通知声音", "notifications.sound", "依赖桌面通知") {
                rows = rows.child(toggle_row(
                    state,
                    &settings,
                    "notifications.sound",
                    "通知声音",
                    "依赖桌面通知开启",
                    cx,
                ));
            }
            if matches_query(query, "CLI BEL OSC 约定", "bel osc", "Pi Amp Claude Codex") {
                rows = rows.child(readonly_card("CLI 侧 BEL / OSC 约定", "Pi：zed-bell extension 写 BEL；Amp：AMP_FORCE_BEL=1；Claude：preferredNotifChannel=terminal_bell；Codex：OSC terminal_title。此卡只读，不代管 CLI 配置。", cx));
            }
        }
        Section::Terminal => {
            if matches_query(query, "终端字体", "terminal.fontFamily", "等宽字体") {
                rows = rows.child(setting_row(
                    state,
                    "terminal.fontFamily",
                    "终端字体",
                    "等宽字体；不可用时由 GPUI 回退",
                    font_family,
                    cx,
                ));
            }
            if matches_query(query, "字体大小", "terminal.fontSize", "10–22 px") {
                rows = rows.child(number_row(
                    state,
                    &settings,
                    "terminal.fontSize",
                    "字体大小",
                    "10–22 px",
                    cx,
                ));
            }
            if matches_query(query, "光标闪烁", "terminal.cursorBlink", "reduced-motion") {
                rows = rows.child(toggle_row(
                    state,
                    &settings,
                    "terminal.cursorBlink",
                    "光标闪烁",
                    "尊重系统 reduced-motion",
                    cx,
                ));
            }
            if matches_query(query, "回滚行数", "terminal.scrollbackLines", "1000–100000") {
                rows = rows.child(number_row(
                    state,
                    &settings,
                    "terminal.scrollbackLines",
                    "回滚行数",
                    "1000–100000",
                    cx,
                ));
            }
            if matches_query(query, "调色板", "terminal.palette", "one-dark") {
                rows = rows.child(readonly_value(
                    "调色板",
                    &settings.terminal.palette,
                    "第一期仅 one-dark",
                    cx,
                ));
            }
            if matches_query(
                query,
                "进程退出后关闭会话",
                "terminal.closeOnExit",
                "exited 灰行",
            ) {
                rows = rows.child(toggle_row(
                    state,
                    &settings,
                    "terminal.closeOnExit",
                    "进程退出后关闭会话",
                    "关闭后不保留 exited 灰行",
                    cx,
                ));
            }
        }
        Section::Appearance => {
            if matches_query(query, "主题", "appearance.theme", "One Dark Phase 2") {
                rows = rows.child(readonly_value(
                    "主题",
                    &settings.appearance.theme,
                    "第一期仅 One Dark；其他主题 Phase 2",
                    cx,
                ));
            }
            if matches_query(
                query,
                "侧栏宽度",
                "appearance.sidebarWidth",
                "200–400 拖动分隔条",
            ) {
                rows = rows.child(number_row(
                    state,
                    &settings,
                    "appearance.sidebarWidth",
                    "侧栏宽度",
                    "200–400 px；也可拖动分隔条",
                    cx,
                ));
            }
            if matches_query(query, "主题编辑器", "theme palette", "Phase 2") {
                rows = rows.child(readonly_card(
                    "主题编辑器",
                    "其他主题与 palette 编辑器计划在 Phase 2 提供。",
                    cx,
                ));
            }
        }
        Section::Keybindings => {
            for (name, key, path) in [
                (
                    "循环切换会话",
                    &settings.keybindings.cycle_next,
                    "cycleNext",
                ),
                (
                    "反向循环切换会话",
                    &settings.keybindings.cycle_prev,
                    "cyclePrev",
                ),
                (
                    "打开 / 关闭设置",
                    &settings.keybindings.toggle_settings,
                    "toggleSettings",
                ),
                (
                    "聚焦设置搜索",
                    &settings.keybindings.focus_search,
                    "focusSearch",
                ),
                (
                    "搜索会话",
                    &settings.keybindings.search_threads,
                    "searchThreads",
                ),
                (
                    "侧栏显隐",
                    &settings.keybindings.toggle_sidebar,
                    "toggleSidebar",
                ),
                ("新建会话", &settings.keybindings.new_session, "newSession"),
            ] {
                if matches_query(query, name, path, key) {
                    rows = rows.child(
                        h_flex()
                            .items_center()
                            .justify_between()
                            .py_2()
                            .border_b_1()
                            .border_color(cx.theme().border)
                            .child(div().text_sm().child(name))
                            .child(
                                div()
                                    .font_family("monospace")
                                    .text_sm()
                                    .text_color(cx.theme().accent)
                                    .child(key.clone()),
                            ),
                    );
                }
            }
            if matches_query(query, "键位编辑", "keybindings", "Phase 3") {
                rows = rows.child(readonly_card(
                    "键位编辑",
                    "第一期只读；编辑功能计划在 Phase 3 提供。",
                    cx,
                ));
            }
        }
        Section::AcpAgents => {
            rows = rows.child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child("ACP 命令由本机 shell 环境解析；凭证不存入 settings.json。"),
            );
            let visible_agents: Vec<_> = settings
                .acp_agents
                .iter()
                .filter(|a| {
                    query.is_empty()
                        || format!("{} {} {} {}", a.label, a.command, a.args.join(" "), a.id)
                            .to_lowercase()
                            .contains(query)
                })
                .cloned()
                .collect();
            if !query.is_empty() && visible_agents.is_empty() {
                rows = rows.child(hint("无匹配 ACP agent", cx));
            }
            for agent in &visible_agents {
                let id = agent.id.clone();
                let label_input = editor_input(
                    edit_inputs,
                    format!("acp:{id}:label"),
                    agent.label.clone(),
                    window,
                    cx,
                    {
                        let state = state.clone();
                        let id = id.clone();
                        move |value, input, window, cx| {
                            state.update(cx, |s, cx| {
                                s.settings.update_acp_agent(
                                    &id,
                                    AcpAgentPatch {
                                        label: Some(value),
                                        ..Default::default()
                                    },
                                );
                                s.flush(cx);
                                let final_value = s
                                    .settings
                                    .get()
                                    .acp_agents
                                    .iter()
                                    .find(|a| a.id == id)
                                    .map(|a| a.label.clone())
                                    .unwrap_or_default();
                                input.update(cx, |editor, cx| {
                                    editor.set_value(final_value, window, cx)
                                });
                                cx.emit(StateChanged);
                            })
                        }
                    },
                );
                let command_input = editor_input(
                    edit_inputs,
                    format!("acp:{id}:command"),
                    agent.command.clone(),
                    window,
                    cx,
                    {
                        let state = state.clone();
                        let id = id.clone();
                        move |value, input, window, cx| {
                            state.update(cx, |s, cx| {
                                s.settings.update_acp_agent(
                                    &id,
                                    AcpAgentPatch {
                                        command: Some(value),
                                        ..Default::default()
                                    },
                                );
                                s.flush(cx);
                                let final_value = s
                                    .settings
                                    .get()
                                    .acp_agents
                                    .iter()
                                    .find(|a| a.id == id)
                                    .map(|a| a.command.clone())
                                    .unwrap_or_default();
                                input.update(cx, |editor, cx| {
                                    editor.set_value(final_value, window, cx)
                                });
                                cx.emit(StateChanged);
                            })
                        }
                    },
                );
                let args_input = editor_textarea(
                    edit_textareas,
                    format!("acp:{id}:args"),
                    agent.args.join("\n"),
                    window,
                    cx,
                    {
                        let state = state.clone();
                        let id = id.clone();
                        move |value, input, window, cx| {
                            state.update(cx, |s, cx| {
                                s.settings.update_acp_agent(
                                    &id,
                                    AcpAgentPatch {
                                        args: Some(value.lines().map(str::to_owned).collect()),
                                        ..Default::default()
                                    },
                                );
                                s.flush(cx);
                                let final_value = s
                                    .settings
                                    .get()
                                    .acp_agents
                                    .iter()
                                    .find(|a| a.id == id)
                                    .map(|a| encode_args(&a.args))
                                    .unwrap_or_default();
                                input.update(cx, |editor, cx| {
                                    editor.set_value(final_value, window, cx)
                                });
                                cx.emit(StateChanged);
                            })
                        }
                    },
                );
                let st = state.clone();
                rows = rows.child(
                    v_flex()
                        .gap_2()
                        .p_2()
                        .border_b_1()
                        .border_color(cx.theme().border)
                        .child(
                            h_flex()
                                .gap_2()
                                .child(Input::new(&label_input))
                                .child(Input::new(&command_input)),
                        )
                        .child(
                            v_flex()
                                .gap_1()
                                .child(div().text_xs().child("Args · 每行一个参数"))
                                .child(Textarea::new(&args_input).h(px(72.0))),
                        )
                        .child(
                            Button::new(format!("acp-delete-{id}"))
                                .label("删除")
                                .on_click(move |_, _, cx| {
                                    st.update(cx, |s, cx| {
                                        s.settings.delete_acp_agent(&id);
                                        s.flush(cx);
                                        cx.emit(StateChanged);
                                    });
                                }),
                        ),
                );
            }
            let st = state.clone();
            rows = rows.child(
                Button::new("acp-add")
                    .primary()
                    .label("+ 新增 ACP agent")
                    .on_click(move |_, _, cx| {
                        st.update(cx, |s, cx| {
                            s.settings.add_acp_agent(AcpAgentInput {
                                label: "新 Agent".into(),
                                ..Default::default()
                            });
                            s.flush(cx);
                            cx.emit(StateChanged);
                        });
                    }),
            );
        }
        Section::Advanced => {
            rows = rows.child(gpu_backend_row(state, &settings, cx));
            rows = rows.child(toggle_row(
                state,
                &settings,
                "advanced.perfHud",
                "性能 HUD",
                "设置值已写入；HUD 绘制接入待做",
                cx,
            ));
            rows = rows.child(toggle_row(
                state,
                &settings,
                "advanced.frameOverlay",
                "帧覆盖层",
                "设置值已写入；覆盖层绘制接入待做",
                cx,
            ));
            rows = rows.child(readonly_card(
                "settings.json（实时快照）",
                &serialize_settings(&settings),
                cx,
            ));
            rows = rows.child(readonly_value(
                "配置文件",
                "~/.j-agent/settings.json",
                "打开外部编辑器操作尚未实现",
                cx,
            ));
            if let Some(err) = state.read(cx).settings.write_error() {
                rows = rows.child(readonly_card(
                    "写入失败（store 已回滚）",
                    &format!("{}：{}", err.path, err.message),
                    cx,
                ));
            }
        }
    }
    rows.into_any_element()
}

fn editor_input(
    inputs: &mut std::collections::HashMap<String, Entity<InputState>>,
    key: String,
    initial: String,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
    on_change: impl Fn(String, Entity<InputState>, &mut Window, &mut App) + 'static,
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
                on_change(
                    input.read(cx).value().to_string(),
                    input.clone(),
                    window,
                    cx,
                );
            }
        },
    )
    .detach();
    inputs.insert(key, input.clone());
    input
}

fn editor_textarea(
    inputs: &mut std::collections::HashMap<String, Entity<TextareaState>>,
    key: String,
    initial: String,
    window: &mut Window,
    cx: &mut Context<SettingsView>,
    on_change: impl Fn(String, Entity<TextareaState>, &mut Window, &mut App) + 'static,
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
                on_change(
                    input.read(cx).value().to_string(),
                    input.clone(),
                    window,
                    cx,
                );
            }
        },
    )
    .detach();
    inputs.insert(key, input.clone());
    input
}

#[cfg(test)]
fn preset_editor_values(preset: &jagent_core::presets::TerminalPreset) -> [String; 6] {
    [
        preset.label.clone(),
        preset.program.clone().unwrap_or_default(),
        encode_args(&preset.args.clone().unwrap_or_default()),
        preset
            .env
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("\n"),
        preset.init_command.clone().unwrap_or_default(),
        preset.cwd.clone().unwrap_or_default(),
    ]
}

fn encode_args(args: &[String]) -> String {
    args.join("\n")
}
fn decode_args(text: &str) -> Vec<String> {
    text.lines().map(str::to_owned).collect()
}

fn matches_query(query: &str, label: &str, path: &str, description: &str) -> bool {
    query.is_empty()
        || format!("{label} {path} {description}")
            .to_lowercase()
            .contains(&query.to_lowercase())
}

fn hint(text: &str, cx: &App) -> gpui::AnyElement {
    div()
        .p_3()
        .text_sm()
        .text_color(cx.theme().muted_foreground)
        .child(text.to_owned())
        .into_any_element()
}

fn setting_row(
    state: &Entity<AppState>,
    path: &'static str,
    label: &'static str,
    description: &'static str,
    input: &Entity<InputState>,
    cx: &mut Context<SettingsView>,
) -> impl IntoElement {
    let modified = state.read(cx).settings.is_modified(path);
    let st_reset = state.clone();
    let reset_input = input.clone();
    h_flex()
        .gap_3()
        .items_center()
        .py_2()
        .border_b_1()
        .border_color(cx.theme().border)
        .child(
            v_flex()
                .flex_1()
                .child(
                    h_flex()
                        .gap_2()
                        .child(div().text_sm().child(label))
                        .when(modified, |d| {
                            d.child(div().text_color(cx.theme().accent).child("●"))
                        }),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(description),
                ),
        )
        .child(
            Button::new(format!("reset-{path}"))
                .label("↶")
                .disabled(!modified)
                .on_click(move |_, window, cx| {
                    st_reset.update(cx, |s, cx| {
                        s.settings.reset(path);
                        let value = s
                            .settings
                            .get()
                            .get_path(path)
                            .and_then(|v| v.as_str().map(str::to_owned))
                            .unwrap_or_default();
                        reset_input.update(cx, |input, cx| input.set_value(value, window, cx));
                        let snapshot = s.settings.get().clone();
                        s.flush(cx);
                        crate::state::apply_terminal_settings(cx, &snapshot);
                        cx.emit(StateChanged);
                    });
                }),
        )
        .child(Input::new(input))
}

fn number_row(
    state: &Entity<AppState>,
    settings: &Settings,
    path: &'static str,
    label: &'static str,
    description: &'static str,
    cx: &mut Context<SettingsView>,
) -> impl IntoElement {
    let value = settings
        .get_path(path)
        .and_then(|v| v.as_i64())
        .unwrap_or_default();
    let modified = state.read(cx).settings.is_modified(path);
    let st_dec = state.clone();
    let st_inc = state.clone();
    let st_reset = state.clone();
    h_flex()
        .gap_2()
        .items_center()
        .py_2()
        .border_b_1()
        .border_color(cx.theme().border)
        .child(
            v_flex()
                .flex_1()
                .child(
                    h_flex()
                        .gap_2()
                        .child(div().text_sm().child(label))
                        .when(modified, |d| d.child("●")),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(description),
                ),
        )
        .child(
            Button::new(format!("dec-{path}"))
                .label("−")
                .on_click(move |_, _, cx| {
                    st_dec.update(cx, |s, cx| {
                        let current = s
                            .settings
                            .get()
                            .get_path(path)
                            .and_then(|v| v.as_i64())
                            .unwrap_or(value);
                        s.settings.patch(path, json!(current - 1));
                        s.flush(cx);
                        let snapshot = s.settings.get().clone();
                        if path.starts_with("terminal.") {
                            crate::state::apply_terminal_settings(cx, &snapshot);
                        }
                        cx.emit(StateChanged);
                    });
                }),
        )
        .child(div().font_family("monospace").child(value.to_string()))
        .child(
            Button::new(format!("inc-{path}"))
                .label("+")
                .on_click(move |_, _, cx| {
                    st_inc.update(cx, |s, cx| {
                        let current = s
                            .settings
                            .get()
                            .get_path(path)
                            .and_then(|v| v.as_i64())
                            .unwrap_or(value);
                        s.settings.patch(path, json!(current + 1));
                        s.flush(cx);
                        let snapshot = s.settings.get().clone();
                        if path.starts_with("terminal.") {
                            crate::state::apply_terminal_settings(cx, &snapshot);
                        }
                        cx.emit(StateChanged);
                    });
                }),
        )
        .child(
            Button::new(format!("reset-{path}"))
                .label("↶")
                .disabled(!modified)
                .on_click(move |_, _, cx| {
                    st_reset.update(cx, |s, cx| {
                        s.settings.reset(path);
                        let snapshot = s.settings.get().clone();
                        s.flush(cx);
                        if path.starts_with("terminal.") {
                            crate::state::apply_terminal_settings(cx, &snapshot);
                        }
                        cx.emit(StateChanged);
                    });
                }),
        )
}

fn toggle_row(
    state: &Entity<AppState>,
    settings: &Settings,
    path: &'static str,
    label: &'static str,
    description: &'static str,
    cx: &mut Context<SettingsView>,
) -> impl IntoElement {
    let value = settings
        .get_path(path)
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let modified = state.read(cx).settings.is_modified(path);
    let st = state.clone();
    let st_reset = state.clone();
    h_flex()
        .gap_3()
        .items_center()
        .py_2()
        .border_b_1()
        .border_color(cx.theme().border)
        .child(
            v_flex()
                .flex_1()
                .child(
                    h_flex()
                        .gap_2()
                        .child(div().text_sm().child(label))
                        .when(modified, |d| {
                            d.child(div().text_color(cx.theme().accent).child("●"))
                        }),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(description),
                ),
        )
        .child(
            Button::new(format!("toggle-{path}"))
                .label(if value { "开启" } else { "关闭" })
                .on_click(move |_, _, cx| {
                    st.update(cx, |s, cx| {
                        let current = s
                            .settings
                            .get()
                            .get_path(path)
                            .and_then(|v| v.as_bool())
                            .unwrap_or(value);
                        s.settings.patch(path, json!(!current));
                        s.flush(cx);
                        let snapshot = s.settings.get().clone();
                        if path.starts_with("terminal.") {
                            crate::state::apply_terminal_settings(cx, &snapshot);
                        }
                        cx.emit(StateChanged);
                    });
                }),
        )
        .child(
            Button::new(format!("reset-{path}"))
                .label("↶")
                .disabled(!modified)
                .on_click(move |_, _, cx| {
                    st_reset.update(cx, |s, cx| {
                        s.settings.reset(path);
                        s.flush(cx);
                        cx.emit(StateChanged);
                    });
                }),
        )
}

fn gpu_backend_row(state: &Entity<AppState>, settings: &Settings, cx: &App) -> impl IntoElement {
    let current = match settings.advanced.gpu_backend {
        jagent_core::settings::GpuBackend::Auto => "auto",
        jagent_core::settings::GpuBackend::Metal => "metal",
        jagent_core::settings::GpuBackend::Dx12 => "dx12",
        jagent_core::settings::GpuBackend::Vulkan => "vulkan",
    };
    let options = [
        ("auto", "自动"),
        ("metal", "Metal"),
        ("dx12", "DirectX 12"),
        ("vulkan", "Vulkan"),
    ];
    let modified = state.read(cx).settings.is_modified("advanced.gpuBackend");
    let store = state.clone();
    let mut row = h_flex()
        .gap_2()
        .items_center()
        .py_2()
        .border_b_1()
        .border_color(cx.theme().border)
        .child(
            v_flex()
                .flex_1()
                .child(
                    h_flex()
                        .gap_2()
                        .child(div().text_sm().child("GPU 后端"))
                        .when(modified, |d| {
                            d.child(div().text_color(cx.theme().accent).child("●"))
                        }),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("当前发行构建后端固定；这里只保存偏好，不会切换运行中 GPU"),
                ),
        );
    for (value, label) in options {
        let store = store.clone();
        row = row.child(
            Button::new(format!("gpu-{value}"))
                .label(if current == value {
                    format!("✓ {label}")
                } else {
                    label.into()
                })
                .on_click(move |_, _, cx| {
                    store.update(cx, |s, cx| {
                        s.settings.patch("advanced.gpuBackend", json!(value));
                        s.flush(cx);
                        cx.emit(StateChanged);
                    });
                }),
        );
    }
    let reset_store = state.clone();
    row.child(
        Button::new("reset-advanced.gpuBackend")
            .label("↶")
            .disabled(!modified)
            .on_click(move |_, _, cx| {
                reset_store.update(cx, |s, cx| {
                    s.settings.reset("advanced.gpuBackend");
                    s.flush(cx);
                    cx.emit(StateChanged);
                });
            }),
    )
}

fn readonly_value(label: &str, value: &str, description: &str, cx: &App) -> impl IntoElement {
    h_flex()
        .items_center()
        .justify_between()
        .py_2()
        .border_b_1()
        .border_color(cx.theme().border)
        .child(
            v_flex()
                .child(div().text_sm().child(label.to_owned()))
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(description.to_owned()),
                ),
        )
        .child(
            div()
                .font_family("monospace")
                .text_xs()
                .text_color(cx.theme().foreground)
                .child(value.to_owned()),
        )
}

fn readonly_card(title: &str, body: &str, cx: &App) -> impl IntoElement {
    v_flex()
        .gap_2()
        .p_3()
        .rounded(px(8.0))
        .bg(cx.theme().sidebar)
        .border_1()
        .border_color(cx.theme().border)
        .child(div().text_sm().child(title.to_owned()))
        .child(
            div()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child(body.to_owned()),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_sections_cover_the_seven_contract_sections() {
        assert_eq!(Section::ALL.len(), 7);
        assert_eq!(
            Section::ALL.map(Section::id),
            [
                "presets",
                "notifications",
                "terminal",
                "appearance",
                "keybindings",
                "acpAgents",
                "advanced"
            ]
        );
    }

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
    fn settings_search_matches_labels_paths_and_descriptions() {
        assert!(section_matches(Section::Terminal, "fontSize"));
        assert!(section_matches(Section::Notifications, "BEL"));
        assert!(section_matches(Section::AcpAgents, "command"));
        assert!(!section_matches(Section::Appearance, "scrollback"));
        assert!(matches_query(
            "",
            "桌面通知",
            "notifications.desktop",
            "BEL"
        ));
        assert!(matches_query(
            "desktop",
            "桌面通知",
            "notifications.desktop",
            "BEL"
        ));
        assert!(!matches_query(
            "scrollback",
            "桌面通知",
            "notifications.desktop",
            "BEL"
        ));
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
        assert_eq!(
            preset_editor_values(restored),
            preset_editor_values(&builtin)
        );
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
}
