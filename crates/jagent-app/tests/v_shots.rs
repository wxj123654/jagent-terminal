//! V2–V6 各面的离屏截图，供与 React 原型（`.archive/design/prototype-react`）做像素对比。
//! 数据尽量复刻原型 `seed.ts`：工作区名（jagent-terminal / dotfiles / web）、会话标题、
//! notices 文案与时间分档、chat 消息原文、git 提交 msg / author。已知偏差见每个面的注释。
//!
//! harness = false：同 `shell_shot`（macOS AppKit 必须在主线程，见 docs/p0-results.md E9）。
//! 运行：`cargo test -p jagent-app --test v_shots -- --nocapture`
//! 产物：`target/shots/v/*.png`

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use gpui::{
    App, AppContext as _, Entity, Modifiers, MouseButton, MouseDownEvent, MouseUpEvent,
    VisualTestAppContext, point, px, size,
};
use gpui_component::Root;
use jagent_app::app::setup;
use jagent_app::state::AppState;
use jagent_app::views::git_graph;
use jagent_app::views::root::RootView;
use jagent_core::threads::{
    ActiveTarget, ConversationKind, Effects, NoticeTone, RunStatus, SessionNotice, SessionView,
    Thread, ThreadStore,
};

/// 截图窗口尺寸（原型 winW/winH 的常用值）。窄屏面用 759：760 是断点，严格小于才进抽屉。
const W: f32 = 1100.0;
const H: f32 = 700.0;
const W_NARROW: f32 = 759.0;

/// 交互坐标（几何来自 root.rs / sidebar.rs / notif_center.rs 的布局常量）：
/// - 侧栏脚（p8 + gap2，钮 28×28）：齿轮中心 (22, H-22)、铃铛中心 (52, H-22)；
/// - 顶栏右端 panelRight 钮（mr2；macOS 无窗口控制钮占位）：(W-16, 22)；
/// - 窄屏顶栏汉堡钮（ml6 + 半宽 14）：(20, 22)。
const X_GEAR: f32 = 22.0;
const X_BELL: f32 = 52.0;

// ── seed 文本（照抄 prototype-react/src/seed.ts，一字不改）──────────────

/// t-sidebar 的 m1
const M1: &str = "把侧栏换成方案 C：头只留收起钮，新建/搜索下移为 nav 行";
/// t-sidebar 的 m2（含 markdown 代码块）
const M2: &str = r#"已完成。改动点：

- `Sidebar` 头 52px 只留 panelLeft 钮
- `WorkspaceList` 顶部新增 nav 行组（新建会话 / 搜索）
- 工作区分组行：箭头 toggle 与点名激活分离

```ts
<NavRow icon="plus" label="新建会话" />
<NavRow icon="search" label="搜索" />
```

右键与「…」共用同一面 ContextMenu。"#;

/// t-ime2 的 m1 / m2
const IME_M1: &str = "IME 候选窗跟随光标，GPUI 侧怎么拿光标坐标？";
const IME_M2: &str = r#"两条路：

1. alacritty model 的 `cursor.point` → cell 行列 → 乘 cell 尺寸得像素坐标
2. 经 `ime_position` custom prop 透传给元素

候选窗定位在 view 层做，不进 pool。"#;

/// 视觉测试用的「现在」（毫秒）。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn out_dir() -> PathBuf {
    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/shots/v");
    std::fs::create_dir_all(&out).expect("mkdir shots/v");
    out
}

// ── 画面装置：AppContext + 离屏窗口 + draw/click/shot ──────────────────

/// 一个画面的全部驱动手段。每个面各自新建（App 级全局互相隔离，数据不串）。
struct Rig {
    cx: VisualTestAppContext,
    window: gpui::AnyWindowHandle,
    out: PathBuf,
}

impl Rig {
    /// 刷新 + 绘制一帧（shell_shot 同款：run_until_parked 后手动 draw 清屏）。
    fn draw(&mut self) {
        self.cx.run_until_parked();
        self.cx
            .update_window(self.window, |_, w, app| {
                w.refresh();
                w.draw(app).clear(app);
            })
            .expect("draw");
    }

    /// 帧间隔 100ms 连续绘制，给异步任务（PTY 提示符 / git 流 / 浮层 deferred）留时间。
    fn settle(&mut self, frames: usize) {
        for _ in 0..frames {
            std::thread::sleep(Duration::from_millis(100));
            self.draw();
        }
    }

    /// 经真实鼠标事件点击（不是直接调方法）。
    fn click(&mut self, x: f32, y: f32) {
        self.cx.simulate_event(
            self.window,
            MouseDownEvent {
                position: point(px(x), px(y)),
                modifiers: Modifiers::default(),
                button: MouseButton::Left,
                click_count: 1,
                first_mouse: false,
            },
        );
        self.cx.simulate_event(
            self.window,
            MouseUpEvent {
                position: point(px(x), px(y)),
                modifiers: Modifiers::default(),
                button: MouseButton::Left,
                click_count: 1,
            },
        );
    }

    fn shot(&mut self, name: &str) {
        let img = self.cx.capture_screenshot(self.window).expect("shot");
        let p = self.out.join(name);
        img.save(&p).expect("save");
        println!("saved {}", p.display());
    }
}

/// 装配一个画面：setup → 种数据 → 开离屏窗。返回 (装置, RootView, AppState)。
fn harness(
    w: f32,
    h: f32,
    dir: &Path,
    cwd: &str,
    seed: impl FnOnce(&Entity<AppState>, &mut App),
) -> (Rig, Entity<RootView>, Entity<AppState>) {
    let mut cx = VisualTestAppContext::new(gpui_platform::current_platform(false));
    let state = cx.update(|cx| setup(cx, dir.to_path_buf(), cwd.to_owned()));
    cx.update(|cx| seed(&state, cx));
    let view_cell = RefCell::new(None);
    let window = cx
        .open_offscreen_window(size(px(w), px(h)), |window, cx| {
            let view = cx.new(|cx| RootView::new(state.clone(), cx));
            *view_cell.borrow_mut() = Some(view.clone());
            cx.new(|cx| Root::new(view, window, cx))
        })
        .expect("window");
    let root = view_cell.into_inner().expect("root view");
    (
        Rig {
            cx,
            window: window.into(),
            out: out_dir(),
        },
        root,
        state,
    )
}

// ── seed 数据构造 ──────────────────────────────────────────────────────

/// 直接改 store 里的 thread（字段全公开）。用于注入公开 API 不覆盖的 seed 运行时态：
/// pendingReply / hasBell / exited / 会话内视图列表。
fn mutate_thread<E: Effects>(threads: &mut ThreadStore<E>, id: &str, f: impl FnOnce(&mut Thread)) {
    if let Some(t) = threads.threads.iter_mut().find(|t| t.id() == id) {
        f(t);
    }
}

/// 三工作区（seed ws-jt / ws-df / ws-web）：首启默认工作区改名 jagent-terminal 并覆写
/// path（仅展示；需要真目录起 PTY 的面传 tempdir 路径），另建 dotfiles / web。返回三个 id。
fn seed_workspaces(s: &mut AppState, jt_path: &str) -> (String, String, String) {
    let jt = s.threads.workspaces[0].id.clone();
    s.threads.rename_workspace(&jt, "jagent-terminal");
    if let Some(w) = s.threads.workspaces.iter_mut().find(|w| w.id == jt) {
        w.path = jt_path.to_owned();
    }
    let df = s.threads.add_workspace("dotfiles", "/Users/u/dotfiles");
    let web = s.threads.add_workspace("web", "/Users/u/web");
    (jt, df, web)
}

/// seed 会话集（seed.ts threads 的标题 / 消息 / 状态；全部归属 jagent-terminal，t-nvim 除外）。
/// 返回主角 t-sidebar 的 id。偏差：消息 at / created_at 用真实时钟（无法注入），
/// activate 清 unread（core 规则）所以 t-sidebar 不带未读点。
fn seed_threads(s: &mut AppState, jt: &str, df: &str, cx: &mut App) -> String {
    // t-sidebar：两条消息原文照抄（begin_send 落 user → finish_send 落 assistant，全走公开 API）
    let t_sidebar = s.create_chat(Some(jt), cx).expect("chat");
    let _ = s.threads.begin_send(&t_sidebar, M1, ConversationKind::Chat);
    s.threads
        .finish_send(&t_sidebar, ConversationKind::Chat, Ok(M2.to_owned()));
    s.threads.rename(&t_sidebar, "侧栏重构");
    s.threads.set_thread_pinned(&t_sidebar, true);

    // t-ime2：回复中（seed pendingReply: true → tab 上的 running 点）
    let t_ime2 = s.create_chat(Some(jt), cx).expect("chat");
    let _ = s.threads.begin_send(&t_ime2, IME_M1, ConversationKind::Chat);
    s.threads
        .finish_send(&t_ime2, ConversationKind::Chat, Ok(IME_M2.to_owned()));
    s.threads.rename(&t_ime2, "终端接入 IME");
    mutate_thread(&mut s.threads, &t_ime2, |t| {
        if let Thread::Chat(c) = t {
            c.pending_reply = true;
        }
    });
    s.threads.set_thread_unread(&t_ime2, true);

    // 终端行：真 PTY + 手改标题（冻结 OSC）
    let t6 = s.spawn_from_preset("shell", Some(jt), cx).expect("spawn");
    s.threads.rename(&t6, "会话 6");
    let t_tb = s.spawn_from_preset("shell", Some(jt), cx).expect("spawn");
    s.threads.rename(&t_tb, "titlebar 红绿灯让位");

    // t-ime：带 git / file / shell:1 视图（seed t-ime.views，activeViewId=git）
    let t_ime = s.spawn_from_preset("shell", Some(jt), cx).expect("spawn");
    s.threads.rename(&t_ime, "IME 候选窗定位");
    mutate_thread(&mut s.threads, &t_ime, |t| {
        if let Thread::Terminal(x) = t {
            x.common.views.push(SessionView::Git {
                id: "git".into(),
                label: "Git 图".into(),
            });
        }
    });
    s.threads
        .open_session_file(&t_ime, "packages/app/src/plane/Sidebar.tsx");
    let _ = s.add_session_shell(&t_ime, cx); // shell:1（真 PTY）
    s.threads.activate_session_view(&t_ime, "git");

    // 旧会话 8：exited 灰行（spawn 后直接置状态；PTY 随测试进程结束销毁）
    let t_old8 = s.spawn_from_preset("shell", Some(jt), cx).expect("spawn");
    s.threads.rename(&t_old8, "旧会话 8");
    mutate_thread(&mut s.threads, &t_old8, |t| {
        if let Thread::Terminal(x) = t {
            x.status = RunStatus::Exited;
            x.exit_code = Some(0);
        }
    });

    // dotfiles 工作区的 t-nvim（hasBell 红点行）
    let t_nvim = s.spawn_from_preset("shell", Some(df), cx).expect("spawn");
    s.threads.rename(&t_nvim, "同步 nvim 配置");
    mutate_thread(&mut s.threads, &t_nvim, |t| {
        if let Thread::Terminal(x) = t {
            x.has_bell = true;
        }
    });

    // 激活主角（chat 主面）
    s.activate(ActiveTarget::Thread(t_sidebar.clone()), cx);
    t_sidebar
}

/// 造 seed 的 git 历史：9 个提交（msg / author=you / 相对时间分档照 GIT_COMMITS），
/// 含 `merge: feat/sidebar-c → main`（--no-ff 双 parent）+ tag v0.1 + 分支
/// feat/sidebar-c / fix/ime-candidate / dev；末尾留工作区变更（4 M + 1 A + 1 D，
/// 文件名照 seed worktree）供工作面板 / AddPopover 用。偏差：sha 必然不同；
/// 无 remote（origin/main 徽章缺失）。
fn mk_git_repo(dir: &Path) -> PathBuf {
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str], ago_secs: i64| {
        // 提交日期按 now 偏移，让 git 图的相对时间分档（12 分钟前 / N 小时前 / 昨天 / N 天前）成立
        let date = (chrono::Local::now() - chrono::Duration::seconds(ago_secs))
            .format("%Y-%m-%dT%H:%M:%S")
            .to_string();
        let ok = Command::new("git")
            .args(args)
            .current_dir(&repo)
            .env("GIT_AUTHOR_NAME", "you")
            .env("GIT_AUTHOR_EMAIL", "you@you")
            .env("GIT_COMMITTER_NAME", "you")
            .env("GIT_COMMITTER_EMAIL", "you@you")
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    };
    let write = |rel: &str, content: &str| {
        let p = repo.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, content).unwrap();
    };

    git(&["init", "-q", "-b", "main"], 0);
    // 初始文件（后续 M / D 状态的载体）
    for rel in [
        "packages/app/src/plane/Sidebar.tsx",
        "packages/app/src/plane/WorkspaceList.tsx",
        "packages/app/src/tokens.ts",
        "packages/ui/src/display/Icon.tsx",
        "packages/app/src/plane/ToolMenu.tsx",
    ] {
        write(rel, "export const SEED = 1\n");
    }
    git(&["add", "-A"], 0);
    git(
        &["commit", "-q", "-m", "init: GPUIX × Zed terminal 骨架"],
        74 * 3600,
    );
    git(
        &["commit", "-q", "--allow-empty", "-m", "TerminalPool：切走 retain，后台 PTY 照跑"],
        50 * 3600,
    );
    git(
        &["commit", "-q", "--allow-empty", "-m", "会话事件走全局通道：title / bell / exit"],
        26 * 3600,
    );
    git(
        &["commit", "-q", "--allow-empty", "-m", "终端外观走元素 props：字号/色板/光标闪烁实时生效"],
        25 * 3600,
    );
    git(&["tag", "v0.1"], 0);
    git(
        &["commit", "-q", "--allow-empty", "-m", "键位参数化：四动作从 settings.keybindings 读"],
        5 * 3600,
    );
    // feat/sidebar-c：d3b55e8 → 回 main merge（seed c7a9f22）
    git(&["branch", "feat/sidebar-c"], 0);
    git(&["checkout", "-q", "feat/sidebar-c"], 0);
    git(
        &["commit", "-q", "--allow-empty", "-m", "通知中心：铃铛 + 未读红点 + 全部已读"],
        3 * 3600,
    );
    git(&["checkout", "-q", "main"], 0);
    git(&["branch", "fix/ime-candidate"], 0);
    git(&["branch", "dev"], 0);
    git(
        &["merge", "--no-ff", "-q", "-m", "merge: feat/sidebar-c → main", "feat/sidebar-c"],
        2 * 3600,
    );
    git(
        &["commit", "-q", "--allow-empty", "-m", "工作面板：变更 tab + 内联 unified diff"],
        3600,
    );
    git(
        &["commit", "-q", "--allow-empty", "-m", "侧栏方案 C：nav 行下移，头部只留收起钮"],
        12 * 60,
    );
    // 工作区变更（seed worktree.files 的文件名；行数与 seed 的 42/18 等不同）
    write(
        "packages/app/src/plane/Sidebar.tsx",
        "export function Sidebar() {\n  return <div testId=\"sidebar\" />\n}\n",
    );
    write(
        "packages/app/src/plane/WorkspaceList.tsx",
        "export function WorkspaceList() {\n  const rows = []\n  return <div>{rows}</div>\n}\n",
    );
    write("packages/app/src/tokens.ts", "export const SIDEBAR_WIDTH = 264\n");
    write("packages/ui/src/display/Icon.tsx", "export const Icon = () => null\n");
    std::fs::remove_file(repo.join("packages/app/src/plane/ToolMenu.tsx")).unwrap();
    write(
        "design/j-agent-prototype.html",
        "<!-- j-agent prototype -->\n",
    );
    repo
}

// ── 八个面 ─────────────────────────────────────────────────────────────

/// 空态（empty_presets）：init 后不建任何会话。presets 用内置 5 项——与 seed 的
/// 5 项同款（Pi / Claude Code / Codex / Amp / Shell，label/description 一致）。
fn v_empty() {
    let dir = tempfile::tempdir().unwrap();
    let (mut rig, _, _) = harness(W, H, dir.path(), &dir.path().to_string_lossy(), |state, cx| {
        state.update(cx, |s, _| {
            seed_workspaces(s, "/Users/u/jagent-terminal");
        });
    });
    rig.settle(2);
    rig.shot("v_empty.png");
}

/// 会话面：t-sidebar 两条消息（seed m1/m2 原文），侧栏其余行照 seed threads。
fn v_chat() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().into_owned();
    let (mut rig, _, _) = harness(W, H, dir.path(), &cwd, |state, cx| {
        state.update(cx, |s, cx| {
            let (jt, df, _web) = seed_workspaces(s, &cwd);
            seed_threads(s, &jt, &df, cx);
        });
    });
    rig.settle(5); // ConversationView + markdown；侧栏 shell 提示符
    rig.shot("v_chat.png");
}

/// 设置页：点侧栏脚齿轮（settings_open 的真实交互路径），section 停在默认
/// Presets（SettingsView 初始 section，同原型 settingsSection: 'presets'）。
fn v_settings() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().into_owned();
    let (mut rig, _, _) = harness(W, H, dir.path(), &cwd, |state, cx| {
        state.update(cx, |s, cx| {
            let (jt, df, _web) = seed_workspaces(s, &cwd);
            seed_threads(s, &jt, &df, cx);
        });
    });
    rig.settle(2);
    rig.click(X_GEAR, H - 22.0);
    rig.settle(3); // 设置页 + deferred 元素
    rig.shot("v_settings.png");
}

/// 通知中心浮层：3 条 notice 照 seed n1/n2/n3（tone/title/sub/时间 5/10/15 分钟前）。
/// 时间戳无法经公开 API 注入（push_notice 私有且 at=now），直接落 pub 字段复刻；
/// 点铃铛打开浮层（非受控 Popover 的真实路径）。
fn v_notif() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().into_owned();
    let (mut rig, _, _) = harness(W, H, dir.path(), &cwd, |state, cx| {
        state.update(cx, |s, cx| {
            let (jt, df, _web) = seed_workspaces(s, &cwd);
            let t_sidebar = seed_threads(s, &jt, &df, cx);
            // n1/n2/n3 原文照抄；thread_id 指向真实行（点击跳转可用），n3 模拟未归属会话
            let now = now_ms();
            let mk = |id: &str, tone, text: &str, sub: &str, ago: i64, tid: String| SessionNotice {
                id: id.into(),
                tone,
                text: text.into(),
                sub: sub.into(),
                at: now - ago,
                thread_id: tid,
                read: false,
                view_id: None,
            };
            let t_nvim = s
                .threads
                .threads
                .iter()
                .find_map(|t| match t {
                    Thread::Terminal(x)
                        if x.custom_title.as_deref() == Some("同步 nvim 配置") =>
                    {
                        Some(x.id.clone())
                    }
                    _ => None,
                })
                .expect("t-nvim");
            s.threads.notices.push(mk(
                "n1",
                NoticeTone::Warn,
                "「同步 nvim 配置」等待注意",
                "dotfiles · BEL",
                300_000,
                t_nvim,
            ));
            s.threads.notices.push(mk(
                "n2",
                NoticeTone::Ok,
                "「侧栏重构」已完成回复",
                "jagent-terminal",
                600_000,
                t_sidebar,
            ));
            s.threads.notices.push(mk(
                "n3",
                NoticeTone::Err,
                "PTY 写入失败：会话 5",
                "未归属 · EPIPE",
                900_000,
                "t102".into(),
            ));
        });
    });
    rig.settle(3);
    rig.click(X_BELL, H - 22.0);
    rig.draw(); // Popover deferred：至少两帧
    rig.draw();
    rig.shot("v_notif.png");
}

/// Git 图：真 repo（mk_git_repo）+ git_graph::open 同款调用；log 流式加载需要等待。
fn v_git() {
    let dir = tempfile::tempdir().unwrap();
    let repo = mk_git_repo(dir.path());
    let repo_str = repo.to_string_lossy().into_owned();
    let (mut rig, _, state) = harness(W, H, dir.path(), &repo_str, |state, cx| {
        state.update(cx, |s, cx| {
            let (jt, _, _) = seed_workspaces(s, &repo_str);
            let t = s.spawn_from_preset("shell", Some(&jt), cx).expect("spawn");
            s.threads.rename(&t, "IME 候选窗定位");
        });
    });
    rig.settle(3);
    rig.cx
        .update_window(rig.window, |_, window, app| {
            git_graph::open(state.clone(), window, app);
        })
        .expect("open git graph");
    rig.settle(15); // dialog deferred + git log / branches 流式加载
    rig.shot("v_git.png");
}

/// 工作面板右栏：repo 变更文件（seed worktree 的 6 项），点顶栏 panelRight 钮
/// （open_panel_changes 的交互入口）；1100 宽 = 停靠右栏（正好 1100 不转浮层）。
fn v_panel() {
    let dir = tempfile::tempdir().unwrap();
    let repo = mk_git_repo(dir.path());
    let repo_str = repo.to_string_lossy().into_owned();
    let (mut rig, _, _) = harness(W, H, dir.path(), &repo_str, |state, cx| {
        state.update(cx, |s, cx| {
            let (jt, _, _) = seed_workspaces(s, &repo_str);
            let t = s.spawn_from_preset("shell", Some(&jt), cx).expect("spawn");
            s.threads.rename(&t, "IME 候选窗定位");
        });
    });
    rig.settle(5); // 终端提示符 + 分支钮 / worktree 数据
    rig.click(W - 16.0, 22.0);
    rig.settle(10); // 面板自己的 status + numstat 异步查询
    rig.shot("v_panel.png");
}

/// AddPopover：激活终端会话（tab 条出现），受控态直接置位（set_add_popover_open，
/// 等价点「+」钮——钮的 x 随 tab 文本宽度变化，鼠标点击不可复现）；文件区显示变更列表。
fn v_addpop() {
    let dir = tempfile::tempdir().unwrap();
    let repo = mk_git_repo(dir.path());
    let repo_str = repo.to_string_lossy().into_owned();
    let (mut rig, root, _) = harness(W, H, dir.path(), &repo_str, |state, cx| {
        state.update(cx, |s, cx| {
            let (jt, _, _) = seed_workspaces(s, &repo_str);
            let t = s.spawn_from_preset("shell", Some(&jt), cx).expect("spawn");
            s.threads.rename(&t, "IME 候选窗定位");
        });
    });
    rig.settle(4); // refresh_branch 回填 worktree_files（浮层文件区的数据源）
    rig.cx.update(|cx| {
        root.update(cx, |v, cx| v.set_add_popover_open(true, cx));
    });
    rig.draw(); // Popover deferred：至少两帧
    rig.draw();
    rig.shot("v_addpop.png");
}

/// 窄屏抽屉：759 宽（< 760 断点）。首帧后抽屉自动收起，点顶栏汉堡打开；
/// 200ms 滑入动画走完再截。
fn v_narrow() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().into_owned();
    let (mut rig, _, _) = harness(W_NARROW, H, dir.path(), &cwd, |state, cx| {
        state.update(cx, |s, cx| {
            let (jt, df, _web) = seed_workspaces(s, &cwd);
            seed_threads(s, &jt, &df, cx);
        });
    });
    rig.draw(); // 窄屏判定生效：抽屉收起、汉堡钮出现
    rig.click(20.0, 22.0);
    std::thread::sleep(Duration::from_millis(350)); // 200ms 滑入缓动走完
    rig.draw();
    rig.draw();
    rig.shot("v_narrow.png");
}

fn main() {
    v_empty();
    v_chat();
    v_settings();
    v_notif();
    v_git();
    v_panel();
    v_addpop();
    v_narrow();

    // 验收：8 张都在且 >10KB（非空白量级）
    let out = out_dir();
    for name in [
        "v_empty.png",
        "v_chat.png",
        "v_settings.png",
        "v_notif.png",
        "v_git.png",
        "v_panel.png",
        "v_addpop.png",
        "v_narrow.png",
    ] {
        let p = out.join(name);
        let len = p.metadata().expect("截图应已生成").len();
        println!("{name}: {len} bytes");
        assert!(len > 10_000, "{name} 只有 {len} 字节，疑似空白");
    }
    println!("V SHOTS OK");
}
