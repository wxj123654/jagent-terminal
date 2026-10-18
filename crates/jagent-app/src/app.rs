//! 应用装配：把主题、键位、状态、事件桥、根视图接成一个窗口。`main` 与测试共用同一份装配。

use gpui::{
    App, AppContext as _, Entity, Menu, MenuItem, SystemMenuType, TitlebarOptions, WindowOptions,
    px, size,
};
use gpui_component::Root;

use crate::actions::{
    MinimizeWindow, NewSession, OpenGitGraph, Quit, SearchThreads, ToggleFullScreen,
    ToggleSettings, ToggleSidebar, ZoomWindow,
};
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
        eprintln!(
            "[keybindings] 忽略无效键位 {} = {:?}",
            r.action, r.keystroke
        );
    }
    cx.on_action(|_: &Quit, cx| cx.quit());
    state
}

/// 主窗口配置：
/// - `appears_transparent: true` 开启 `NSFullSizeContentViewWindowMask` 自绘顶栏；
/// - `traffic_light_position: None` 让 AppKit 原生管理红绿灯与 `NSTitlebarContainerView`，
///   避免 `gpui-pre-macos` 在进入全屏/缩放时用旧窗口高度覆盖 `titlebar_container.frame.origin.y`
///   导致全屏顶部原生层和窗口左上角红绿灯飞出屏幕；
/// - `app_owns_titlebar_drag: true` 由应用内顶栏空白区接管拖拽与双击缩放。
pub fn main_window_options() -> WindowOptions {
    WindowOptions {
        window_min_size: Some(size(px(480.0), px(320.0))),
        titlebar: Some(TitlebarOptions {
            title: None,
            appears_transparent: true,
            traffic_light_position: None,
        }),
        app_owns_titlebar_drag: true,
        ..Default::default()
    }
}

/// 构造应用级原生菜单栏（macOS 全屏顶部下拉菜单栏与 `NSApp.windowsMenu` 依赖此配置）。
pub fn app_menus() -> Vec<Menu> {
    vec![
        Menu::new("j-agent").items([
            MenuItem::action("设置…", ToggleSettings),
            MenuItem::separator(),
            MenuItem::os_submenu("服务", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action("退出 j-agent", Quit),
        ]),
        Menu::new("File").items([
            MenuItem::action("新建会话…", NewSession),
            MenuItem::action("搜索会话…", SearchThreads),
            MenuItem::separator(),
            MenuItem::action("切换侧边栏", ToggleSidebar),
            MenuItem::action("打开 Git 图谱", OpenGitGraph),
        ]),
        // 名称须为 "Window"：gpui-pre-macos 识别后自动调用 `NSApp.setWindowsMenu_`，
        // 使 macOS 原生全屏 Space 菜单栏与窗口管理正常挂载。
        Menu::new("Window").items([
            MenuItem::action("最小化", MinimizeWindow),
            MenuItem::action("缩放", ZoomWindow),
            MenuItem::separator(),
            MenuItem::action("进入全屏", ToggleFullScreen),
        ]),
    ]
}

/// 开主窗口。
pub fn open_main_window(
    cx: &mut App,
    state: Entity<AppState>,
) -> gpui::Result<gpui::WindowHandle<Root>> {
    cx.open_window(main_window_options(), move |window, cx| {
        let view = cx.new(|cx| RootView::new(state, cx));
        cx.new(|cx| Root::new(view, window, cx))
    })
}

/// 启动：装配 + 原生菜单 + 事件桥 + 开窗 + 若无会话则起一个默认 shell。
pub fn run() {
    gpui_platform::application().run(|cx: &mut App| {
        let cwd = std::env::current_dir()
            .map_or_else(|_| ".".into(), |p| p.to_string_lossy().into_owned());
        let state = setup(cx, data_dir(), cwd);
        cx.set_menus(app_menus());
        bridge_terminal_events(&state, cx);
        let _ = state.update(cx, |s, cx| {
            let ws = s.workspaces().first().map(|w| w.id.clone());
            s.spawn_from_preset("shell", ws.as_deref(), cx)
        });
        open_main_window(cx, state).expect("开主窗口");
        cx.activate(true);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_window_options_keep_native_traffic_lights_unmoved_for_macos_fullscreen() {
        let opts = main_window_options();
        assert!(opts.app_owns_titlebar_drag);
        let tb = opts.titlebar.expect("主窗口必须配置自定义透明标题栏");
        assert!(tb.appears_transparent);
        assert!(
            tb.traffic_light_position.is_none(),
            "traffic_light_position 必须为 None，防止 gpui-pre-macos 在全屏/缩放切换时把 NSTitlebarContainerView 移出屏幕"
        );
    }

    #[test]
    fn app_menus_include_window_menu_for_macos_fullscreen_space() {
        let menus = app_menus();
        let names: Vec<&str> = menus.iter().map(|m| m.name.as_ref()).collect();
        assert_eq!(names, vec!["j-agent", "File", "Window"]);
    }
}
