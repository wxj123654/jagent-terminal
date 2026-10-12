//! 应用装配：把主题、键位、状态、事件桥、根视图接成一个窗口。`main` 与测试共用同一份装配。

use gpui::{App, AppContext as _, Entity, WindowOptions, px, size};
use gpui_component::{Root, TitleBar};

use crate::state::{AppState, bridge_terminal_events, data_dir, init as init_state};
use crate::views::root::RootView;
use crate::{actions, theme};

/// 全部进程级初始化（不含开窗）。必须在 `Application::run` 的回调里调用。
///
/// 顺序有讲究：`gpui_component::init` 必须最先；主题依赖它；键位依赖 settings（先建 state）。
pub fn setup(cx: &mut App, dir: std::path::PathBuf, default_cwd: String) -> Entity<AppState> {
    gpui_component::init(cx);
    theme::install(cx).expect("主题应能安装");
    let state = init_state(cx, dir, default_cwd).expect("初始化应用状态");
    let settings = state.read(cx).settings.get().clone(); // 先克隆：install 需要 &mut cx，不能同时借着 state
    let rejected = actions::install(cx, &settings);
    for r in rejected {
        // 坏键位不阻塞启动；P3 起在设置页的键位表里红字展示
        eprintln!("[keybindings] 忽略无效键位 {} = {:?}", r.action, r.keystroke);
    }
    state
}

/// 开主窗口。`TitleBar::window_options()` 让标题栏自己处理拖拽 / 双击缩放（macOS 红绿灯位置也在其中）。
pub fn open_main_window(cx: &mut App, state: Entity<AppState>) -> gpui::Result<gpui::WindowHandle<Root>> {
    let options = WindowOptions {
        window_min_size: Some(size(px(480.0), px(320.0))),
        ..TitleBar::window_options()
    };
    cx.open_window(options, move |window, cx| {
        let view = cx.new(|cx| RootView::new(state, cx));
        cx.new(|cx| Root::new(view, window, cx))
    })
}

/// 启动：装配 + 事件桥 + 开窗 + 若无会话则起一个默认 shell。
pub fn run() {
    gpui_platform::application().run(|cx: &mut App| {
        let cwd = std::env::current_dir().map_or_else(|_| ".".into(), |p| p.to_string_lossy().into_owned());
        let state = setup(cx, data_dir(), cwd);
        bridge_terminal_events(&state, cx);
        let _ = state.update(cx, |s, cx| {
            let ws = s.workspaces().first().map(|w| w.id.clone());
            s.spawn_from_preset("shell", ws.as_deref(), cx)
        });
        open_main_window(cx, state).expect("开主窗口");
        cx.activate(true);
    });
}
