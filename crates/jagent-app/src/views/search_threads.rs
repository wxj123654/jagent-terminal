//! 快速搜索会话（对应原型 `Dialogs.tsx` 的 `SearchDialog` · Spotlight 命令面板风格）。
use gpui::{
    App, AppContext as _, Context, Entity, Focusable as _, FontWeight, InteractiveElement,
    IntoElement, ParentElement, Render, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_component::{
    WindowExt as _, h_flex,
    input::{Input, InputEvent, InputState},
    v_flex,
};
use jagent_core::threads::{ActiveTarget, RunStatus, Thread, search_threads, sort_threads};

use crate::icons::{IconName, icon};
use crate::state::{AppState, StateChanged};
use crate::theme::{accent_alpha, colors, hex, rgba_css};
use crate::ui_scale::fs;

pub struct SearchThreadsView {
    state: Entity<AppState>,
    query: Entity<InputState>,
    selected_index: usize,
    focus_input: bool,
}

impl SearchThreadsView {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let query = cx.new(|cx| {
            InputState::new(window, cx).placeholder("搜索会话标题、工作区目录、工具类型…")
        });
        cx.subscribe_in(
            &query,
            window,
            |this, _, ev: &InputEvent, window, cx| match ev {
                InputEvent::Change => {
                    this.selected_index = 0;
                    cx.notify();
                }
                InputEvent::PressEnter { .. } => {
                    this.activate_selected(window, cx);
                }
                _ => {}
            },
        )
        .detach();
        cx.subscribe(&state, |_, _, _: &StateChanged, cx| cx.notify())
            .detach();
        Self {
            state,
            query,
            selected_index: 0,
            focus_input: true,
        }
    }

    fn matched_thread_ids(&self, cx: &App) -> Vec<String> {
        let query = self.query.read(cx).value().to_string();
        let s = self.state.read(cx);
        let presets = &s.settings.get().presets.items;
        let sorted: Vec<Thread> = sort_threads(&s.threads.threads)
            .into_iter()
            .cloned()
            .collect();
        search_threads(&sorted, s.workspaces(), &query, |preset_id| {
            preset_id.and_then(|pid| {
                presets
                    .iter()
                    .find(|p| p.id == pid)
                    .map(|p| p.label.clone())
            })
        })
        .into_iter()
        .map(|hit| hit.thread.id().to_owned())
        .collect()
    }

    pub fn move_selection(&mut self, delta: isize, cx: &mut Context<Self>) {
        let ids = self.matched_thread_ids(cx);
        let len = ids.len();
        if len == 0 {
            return;
        }
        let cur = self.selected_index.min(len - 1) as isize;
        self.selected_index = (cur + delta).rem_euclid(len as isize) as usize;
        cx.notify();
    }

    pub fn activate_selected(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let ids = self.matched_thread_ids(cx);
        if ids.is_empty() {
            return;
        }
        let ix = self.selected_index.min(ids.len() - 1);
        let id = ids[ix].clone();
        self.state.update(cx, |s, cx| {
            s.activate(ActiveTarget::Thread(id), cx);
            cx.emit(StateChanged);
            cx.notify();
        });
        if window.root::<gpui_base::Root>().flatten().is_some() {
            window.close_dialog(cx);
        }
    }
}

impl Render for SearchThreadsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.focus_input {
            self.focus_input = false;
            let handle = self.query.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
        }
        let query = self
            .query
            .read(cx)
            .value()
            .to_string()
            .trim()
            .to_lowercase();
        let rows: Vec<_> = {
            let s = self.state.read(cx);
            let presets = &s.settings.get().presets.items;
            let sorted: Vec<Thread> = sort_threads(&s.threads.threads)
                .into_iter()
                .cloned()
                .collect();
            let hits = search_threads(&sorted, s.workspaces(), &query, |preset_id| {
                preset_id.and_then(|pid| {
                    presets
                        .iter()
                        .find(|p| p.id == pid)
                        .map(|p| p.label.clone())
                })
            });
            hits.into_iter()
                .map(|hit| {
                    let t = hit.thread;
                    let ws_name = hit
                        .workspace
                        .map(|w| w.name.clone())
                        .unwrap_or_else(|| "未归属".to_owned());
                    let is_exited = t
                        .as_terminal()
                        .is_some_and(|term| term.status == RunStatus::Exited);
                    let (ic, ic_col) = match t {
                        Thread::Terminal(_) => (
                            IconName::Terminal,
                            if is_exited {
                                hex(colors::FAINT)
                            } else {
                                hex(colors::TERMINAL_KIND)
                            },
                        ),
                        Thread::Chat(_) => (IconName::Chat, hex(colors::ACCENT_HOVER)),
                        Thread::Acp(_) => (IconName::Acp, hex(colors::ACP_KIND)),
                    };
                    let pending = match t {
                        Thread::Chat(c) => c.pending_reply,
                        Thread::Acp(a) => a.pending_reply,
                        Thread::Terminal(_) => false,
                    };
                    let has_bell = t.as_terminal().is_some_and(|term| term.has_bell);
                    (
                        t.id().to_owned(),
                        t.title(),
                        ws_name,
                        ic,
                        ic_col,
                        t.common().pin,
                        pending,
                        has_bell,
                        is_exited,
                    )
                })
                .collect()
        };
        let state = self.state.clone();
        let count = rows.len();
        let selected_ix = if count == 0 {
            0
        } else {
            self.selected_index.min(count - 1)
        };
        let weak_up = cx.entity().downgrade();
        let weak_down = cx.entity().downgrade();
        let key_interceptor = gpui::canvas(
            |_, _, _| (),
            move |_, _, window, _cx| {
                if count == 0 {
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

        let search_header = h_flex()
            .pb(px(10.0))
            .gap(px(8.0))
            .items_center()
            .border_b_1()
            .border_color(hex(colors::BORDER_SUBTLE))
            .child(icon(IconName::Search, 16.0, hex(colors::ACCENT_HOVER)))
            .child(
                div().flex_1().min_w_0().child(
                    Input::new(&self.query)
                        .appearance(false)
                        .text_size(fs(13.0))
                        .text_color(hex(colors::TEXT_BRIGHT)),
                ),
            )
            .child(
                div()
                    .px(px(6.0))
                    .py(px(1.0))
                    .rounded(px(4.0))
                    .bg(hex(colors::SURFACE))
                    .border_1()
                    .border_color(hex(colors::BORDER_SUBTLE))
                    .font_family("monospace")
                    .text_size(fs(10.5))
                    .text_color(hex(colors::MUTED))
                    .child(if query.is_empty() {
                        "最近活跃".to_owned()
                    } else {
                        format!("{count} 匹配")
                    }),
            );

        let section_title = div()
            .pt(px(4.0))
            .pb(px(4.0))
            .px(px(6.0))
            .text_size(fs(10.5))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(hex(colors::MUTED))
            .child(if query.is_empty() {
                format!("最近与置顶会话 ({count})")
            } else {
                format!("搜索结果 ({count})")
            });

        let footer = h_flex()
            .pt(px(8.0))
            .mt(px(4.0))
            .items_center()
            .justify_between()
            .border_t_1()
            .border_color(hex(colors::BORDER))
            .text_size(fs(11.0))
            .text_color(hex(colors::MUTED))
            .child("支持按会话名称、工作区、预设工具或目录检索")
            .child(
                div()
                    .font_family("monospace")
                    .text_size(fs(10.5))
                    .text_color(hex(colors::FAINT))
                    .child("↑↓ 选择 · ↵ 激活跳转 · Esc 关闭"),
            );

        v_flex()
            .key_context("SearchThreads")
            .w_full()
            .max_h(px(480.0))
            .gap(px(4.0))
            .child(key_interceptor)
            .child(search_header)
            .child(section_title)
            .child(
                v_flex()
                    .id("search-threads-list")
                    .max_h(px(340.0))
                    .overflow_y_scroll()
                    .gap(px(3.0))
                    .when(rows.is_empty(), |d| {
                        d.child(
                            div()
                                .p(px(16.0))
                                .text_center()
                                .text_size(fs(12.0))
                                .text_color(hex(colors::MUTED))
                                .child("没有匹配的会话。试试项目名或工具名。"),
                        )
                    })
                    .children(rows.into_iter().enumerate().map(
                        move |(
                            ix,
                            (id, title, ws_name, ic, ic_col, pinned, pending, has_bell, is_exited),
                        )| {
                            let st = state.clone();
                            let is_selected = ix == selected_ix;
                            h_flex()
                                .id(format!("thread-search-{id}"))
                                .py(px(7.0))
                                .px(px(10.0))
                                .gap(px(8.0))
                                .items_center()
                                .rounded(px(8.0))
                                .border_1()
                                .when_else(
                                    is_selected,
                                    |d| {
                                        d.bg(hex(colors::SURFACE_ACTIVE))
                                            .border_color(accent_alpha(0.45))
                                    },
                                    |d| {
                                        d.border_color(gpui::transparent_black())
                                            .hover(|h| h.bg(hex(colors::SURFACE)))
                                    },
                                )
                                .cursor_pointer()
                                .child(icon(ic, 15.0, ic_col))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .overflow_hidden()
                                        .whitespace_nowrap()
                                        .text_ellipsis()
                                        .text_size(fs(12.5))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(if is_exited {
                                            hex(colors::MUTED)
                                        } else {
                                            hex(colors::TEXT_BRIGHT)
                                        })
                                        .child(title),
                                )
                                .when(pinned, |d| {
                                    d.child(icon(IconName::Pin, 11.0, hex(colors::FAINT)))
                                })
                                .when(pending, |d| {
                                    d.child(
                                        div()
                                            .px(px(6.0))
                                            .rounded(px(4.0))
                                            .bg(rgba_css(251, 191, 36, 0.15))
                                            .text_size(fs(10.0))
                                            .text_color(hex(colors::STATUS_RUNNING))
                                            .child("思考中"),
                                    )
                                })
                                .when(has_bell, |d| {
                                    d.child(
                                        div()
                                            .px(px(6.0))
                                            .rounded(px(4.0))
                                            .bg(rgba_css(192, 132, 252, 0.15))
                                            .text_size(fs(10.0))
                                            .text_color(hex(colors::ACP_KIND))
                                            .child("🔔 BEL"),
                                    )
                                })
                                .when(is_exited, |d| {
                                    d.child(
                                        div()
                                            .font_family("monospace")
                                            .text_size(fs(10.0))
                                            .text_color(hex(colors::FAINT))
                                            .child("[已退出]"),
                                    )
                                })
                                .child(
                                    div()
                                        .px(px(7.0))
                                        .py(px(1.0))
                                        .rounded(px(4.0))
                                        .bg(hex(colors::INPUT_BG))
                                        .border_1()
                                        .border_color(hex(colors::BORDER))
                                        .text_size(fs(11.0))
                                        .text_color(hex(colors::MUTED))
                                        .child(ws_name),
                                )
                                .on_click(move |_, window, cx| {
                                    st.update(cx, |s, cx| {
                                        s.activate(ActiveTarget::Thread(id.clone()), cx);
                                        cx.emit(StateChanged);
                                        cx.notify();
                                    });
                                    window.close_dialog(cx);
                                })
                        },
                    )),
            )
            .child(footer)
    }
}

#[allow(dead_code)]
fn title_matches(title: &str, query: &str) -> bool {
    query.is_empty() || title.to_lowercase().contains(&query.to_lowercase())
}

pub fn open(state: Entity<AppState>, window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| SearchThreadsView::new(state, window, cx));
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.title("搜索会话").w(px(560.0)).child(view.clone())
    });
}

#[cfg(test)]
mod tests {
    use gpui::TestAppContext;
    use jagent_core::threads::ActiveTarget;

    use super::{SearchThreadsView, title_matches};
    use crate::state::init;

    #[test]
    fn search_is_case_insensitive_and_empty_query_keeps_all_titles() {
        assert!(title_matches("Alpha Session", ""));
        assert!(title_matches("Alpha Session", "alpha"));
        assert!(title_matches("Alpha Session", "SESSION"));
        assert!(!title_matches("Alpha Session", "beta"));
    }

    #[gpui::test]
    fn search_view_matches_workspace_tool_and_supports_keyboard_selection(cx: &mut TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        let (state, w1, c1, a1) = cx.update(|cx| {
            gpui_component::init(cx);
            let _ = crate::theme::install(cx);
            let state = init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let w1 = state.read(cx).workspaces()[0].id.clone();
            let (c1, a1) = state.update(cx, |s, cx| {
                s.threads.rename_workspace(&w1, "AlphaRepo");
                let c1 = s.create_chat(Some(&w1), cx).unwrap();
                let a1 = s.create_acp("acp-pi", "Pi (ACP)", Some(&w1), cx).unwrap();
                s.threads.set_thread_pinned(&c1, true);
                (c1, a1)
            });
            (state, w1, c1, a1)
        });
        let _ = w1;

        let (view, vcx) =
            cx.add_window_view(|window, cx| SearchThreadsView::new(state.clone(), window, cx));

        // 1. 置顶会话优先排在第一位
        vcx.read(|app| {
            let ids = view.read(app).matched_thread_ids(app);
            assert_eq!(ids, vec![c1.clone(), a1.clone()], "置顶会话排最前");
        });

        // 2. 按工作区名称或工具类型 "acp" 搜索均能命中
        vcx.update(|window, app| {
            view.update(app, |v, cx| {
                v.query.update(cx, |inp, cx| {
                    inp.set_value("AlphaRepo", window, cx);
                });
            });
        });
        vcx.read(|app| {
            assert_eq!(view.read(app).matched_thread_ids(app).len(), 2);
        });

        vcx.update(|window, app| {
            view.update(app, |v, cx| {
                v.query.update(cx, |inp, cx| {
                    inp.set_value("acp", window, cx);
                });
            });
        });
        vcx.read(|app| {
            assert_eq!(view.read(app).matched_thread_ids(app), vec![a1.clone()]);
        });

        // 3. 清空搜索后用 move_selection(1) 选中第 2 项并 activate_selected
        vcx.update(|window, app| {
            view.update(app, |v, cx| {
                v.query.update(cx, |inp, cx| {
                    inp.set_value("", window, cx);
                });
                v.move_selection(1, cx);
                assert_eq!(v.selected_index, 1);
                v.activate_selected(window, cx);
            });
        });
        vcx.read(|app| {
            assert_eq!(
                state.read(app).threads.active(),
                &ActiveTarget::Thread(a1),
                "回车/激活选中项应跳转到对应会话"
            );
        });
    }
}
