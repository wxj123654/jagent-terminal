//! 快速搜索会话：`SearchThreads` action 打开，输入过滤会话标题，点击跳转到对应线程。
use crate::state::{AppState, StateChanged};
use gpui::{
    App, AppContext as _, Context, Entity, InteractiveElement, IntoElement, ParentElement, Render,
    StatefulInteractiveElement, Styled, Window, div, px,
};
use gpui_component::{
    ActiveTheme, WindowExt as _,
    input::{Input, InputEvent, InputState},
    v_flex,
};
use jagent_core::threads::ActiveTarget;

pub struct SearchThreadsView {
    state: Entity<AppState>,
    query: Entity<InputState>,
}
impl SearchThreadsView {
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let query = cx.new(|cx| InputState::new(window, cx));
        cx.subscribe_in(&query, window, |_, _, ev: &InputEvent, _, cx| {
            if matches!(ev, InputEvent::Change) {
                cx.notify();
            }
        })
        .detach();
        cx.subscribe(&state, |_, _, _: &StateChanged, cx| cx.notify())
            .detach();
        Self { state, query }
    }
}
impl SearchThreadsView {}
impl Render for SearchThreadsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let query = self.query.read(cx).value().to_string().to_lowercase();
        let rows: Vec<_> = {
            let s = self.state.read(cx);
            s.threads
                .threads
                .iter()
                .filter(|t| title_matches(&t.title(), &query))
                .map(|t| (t.id().to_owned(), t.title()))
                .collect()
        };
        let state = self.state.clone();
        v_flex()
            .key_context("SearchThreads")
            .w_full()
            .max_h(px(500.0))
            .gap_2()
            .p_3()
            .child(Input::new(&self.query))
            .children(rows.into_iter().map(move |(id, title)| {
                let st = state.clone();
                div()
                    .id(format!("thread-search-{id}"))
                    .px_3()
                    .py_2()
                    .rounded(px(5.0))
                    .cursor_pointer()
                    .hover(|d| d.bg(cx.theme().secondary))
                    .text_color(cx.theme().foreground)
                    .child(title)
                    .on_click(move |_, _, cx| {
                        st.update(cx, |s, cx| {
                            s.activate(ActiveTarget::Thread(id.clone()), cx);
                            cx.emit(StateChanged);
                            cx.notify();
                        });
                    })
            }))
    }
}
fn title_matches(title: &str, query: &str) -> bool {
    query.is_empty() || title.to_lowercase().contains(&query.to_lowercase())
}

pub fn open(state: Entity<AppState>, window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| SearchThreadsView::new(state, window, cx));
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.title("搜索会话").w(px(520.0)).child(view.clone())
    });
}

#[cfg(test)]
mod tests {
    use super::title_matches;
    #[test]
    fn search_is_case_insensitive_and_empty_query_keeps_all_titles() {
        assert!(title_matches("Alpha Session", ""));
        assert!(title_matches("Alpha Session", "alpha"));
        assert!(title_matches("Alpha Session", "SESSION"));
        assert!(!title_matches("Alpha Session", "beta"));
    }
}
