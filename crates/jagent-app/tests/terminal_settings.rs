//! App-level integration test for live propagation of persisted terminal style to pooled sessions.
//! harness=false preserves GPUI's macOS main-thread requirement (see docs/p0-results.md E9).
use gpui_platform::current_platform;
use jagent_app::{app::setup, terminal_style};
use jagent_terminal::TerminalPool;
use tempfile::tempdir;

fn main() {
    let dir = tempdir().unwrap();
    let mut cx = gpui::VisualTestAppContext::new(current_platform(false));
    let cwd = dir.path().to_string_lossy().into_owned();
    cx.update(|cx| {
        let state = setup(cx, dir.path().to_path_buf(), cwd);
        let thread_id = state.update(cx, |s, cx| s.spawn_from_preset("shell", None, cx).unwrap());
        let session_id = state
            .read(cx)
            .threads
            .thread(&thread_id)
            .unwrap()
            .as_terminal()
            .unwrap()
            .session_id;
        let model = cx.global::<TerminalPool>().get(session_id).unwrap();
        let expected = terminal_style::from_settings(state.read(cx).settings.get());
        assert_eq!(model.read(cx).style(), &expected);

        state.update(cx, |s, cx| {
            s.settings.patch("terminal.fontSize", serde_json::json!(19));
            s.settings
                .patch("terminal.cursorBlink", serde_json::json!(false));
            s.settings
                .patch("terminal.fontFamily", serde_json::json!("monospace-test"));
            s.flush(cx);
        });
        let style = model.read(cx).style().clone();
        assert_eq!(style.font_size, gpui::px(19.0));
        assert_eq!(style.font_family.as_ref(), "monospace-test");
        assert!(!style.cursor_blink);
        println!("TERMINAL_SETTINGS OK");
    });
}
