//! 整个外壳的屏幕外截图：标题栏 + 侧栏（两个工作区、几类会话）+ 主面终端。
//!
//! 验证：① `app::setup` 的装配顺序可用；② 状态 → 视图的链路真的画出了东西；
//! ③ 点击侧栏会话行会切换主面（经真实的鼠标事件，而不是直接调方法）。
//!
//! harness = false：macOS AppKit 必须在主线程（见 docs/p0-results.md E9）。在用户终端 / CI 运行，Bash 沙箱内会 SIGTRAP。

use std::time::Duration;

use gpui::{AppContext as _, Modifiers, MouseButton, VisualTestAppContext, point, px, size};
use gpui_component::Root;
use jagent_app::app::setup;
use jagent_app::views::root::RootView;
use jagent_core::threads::ActiveTarget;

fn main() {
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/shots");
    std::fs::create_dir_all(&out).expect("mkdir shots");
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().into_owned();

    let mut cx = VisualTestAppContext::new(gpui_platform::current_platform(false));
    let state = cx.update(|cx| setup(cx, dir.path().to_path_buf(), cwd.clone()));

    // 两个终端会话 + 一个 chat；再加第二个工作区
    let (t1, t2) = cx.update(|cx| {
        state.update(cx, |s, cx| {
            let ws2 = s.threads.add_workspace("dotfiles", "/Users/u/dotfiles");
            let ws1 = s.workspaces()[0].id.clone();
            let t1 = s.spawn_from_preset("shell", Some(&ws1), cx).unwrap();
            let t2 = s.spawn_from_preset("shell", Some(&ws1), cx).unwrap();
            s.threads.create_chat(Some(&ws2)).unwrap();
            s.threads.activate(ActiveTarget::Thread(t1.clone()));
            s.flush(cx);
            (t1, t2)
        })
    });

    let window = cx
        .open_offscreen_window(size(px(1100.0), px(700.0)), |window, cx| {
            let view = cx.new(|cx| RootView::new(state.clone(), cx));
            cx.new(|cx| Root::new(view, window, cx))
        })
        .expect("window");

    let draw = |cx: &mut VisualTestAppContext| {
        cx.run_until_parked();
        cx.update_window(window.into(), |_, w, app| {
            w.refresh();
            w.draw(app).clear(app);
        })
        .expect("draw");
    };
    // 给两个 shell 一点时间打印提示符
    for _ in 0..15 {
        std::thread::sleep(Duration::from_millis(100));
        draw(&mut cx);
    }
    let shot = |cx: &mut VisualTestAppContext, name: &str| {
        let img = cx.capture_screenshot(window.into()).expect("shot");
        let p = out.join(name);
        img.save(&p).expect("save");
        println!("saved {}", p.display());
    };
    shot(&mut cx, "app_shell.png");

    // ③ 点击侧栏会话行。排序规则（core）：同优先级按创建时间新→旧，所以第 1 行是较新的 t2，第 2 行是 t1。
    //    测试开头激活的是 t1（截图里第 2 行高亮）——要验证"点击切换"就必须点**第 1 行**。
    //    （上一版点了第 2 行 = 点中了已激活的 t1，所以"没变化"，是测试自己的坐标假设错了，不是点击失效。）
    assert_eq!(
        cx.read(|app| state.read(app).threads.active().clone()),
        ActiveTarget::Thread(t1.clone())
    );
    // 行位置（新全高侧栏几何）：侧栏头 40 + 并排双胶囊 nav 组 44（pt4+32+pb8）
    // + 区头 32（mt4+28）+ 滚动区 pt2 + ws-row 34 + ws-body mt1；行高 30。
    // 第 1 行中线 = 40 + 44 + 32 + 2 + 34 + 1 + 15 = 168。
    let row_y = 40.0 + 44.0 + 32.0 + 2.0 + 34.0 + 1.0 + 15.0;
    cx.simulate_event(
        window.into(),
        gpui::MouseDownEvent {
            position: point(px(100.0), px(row_y)),
            modifiers: Modifiers::default(),
            button: MouseButton::Left,
            click_count: 1,
            first_mouse: false,
        },
    );
    cx.simulate_event(
        window.into(),
        gpui::MouseUpEvent {
            position: point(px(100.0), px(row_y)),
            modifiers: Modifiers::default(),
            button: MouseButton::Left,
            click_count: 1,
        },
    );
    draw(&mut cx);
    let active = cx.read(|app| state.read(app).threads.active().clone());
    println!("after click on row 1: active = {active:?} (t1={t1}, t2={t2})");
    shot(&mut cx, "app_shell_after_click.png");
    assert!(
        matches!(active, ActiveTarget::Thread(_)),
        "点击后应仍停留在某个会话"
    );
    assert_eq!(
        active,
        ActiveTarget::Thread(t2.clone()),
        "点击第 1 行（较新的 t2）应切换到 t2"
    );
    println!("SHELL OK");
}
