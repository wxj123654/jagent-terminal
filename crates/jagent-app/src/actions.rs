//! 全局 Action 与键位绑定。
//!
//! 旧实现（`keybindings.ts`）是一条 8 层的手写分发链：`keyConsumed` 标记、`inputFocus` 计数、
//! `overlayEsc` 栈……全部为了弥补 GPUIX 没有 `stopPropagation` 和焦点作用域。gpui 原生有
//! `Action` + `KeyContext` + `FocusHandle`：**绑定带上下文，谁聚焦谁先处理**，所以：
//!
//! | 旧层 | gpui 里 |
//! |---|---|
//! | L0 keyConsumed | 不需要：事件在聚焦元素上被 action 处理后即停止，不会冒泡 |
//! | L1 弹窗让位 | 弹窗根 `key_context("Dialog")`，全局动作绑定写 `context = "Workspace"`，弹窗里不命中 |
//! | L2 overlayEsc 栈 | 每个浮层各自处理 `Cancel`，栈顶（最内层聚焦者）先收到 |
//! | L3 设置面 Esc / `/` | `key_context("Settings")` 下绑定 |
//! | L4/L7 修饰键组合 | `Workspace` 上下文绑定；终端聚焦时 `Terminal` 上下文不含这些键，所以透传给 PTY |
//! | L6 Git 图裸键 | `key_context("GitGraph")` 下绑定；输入框聚焦时输入框先吃（不会到 GitGraph） |
//!
//! 硬约束（旧 `硬约束 2`）：**终端聚焦时不吃 vim / claude 的按键**——全局动作只绑**带修饰键**的组合，
//! 裸键只绑在各自的上下文（Settings / GitGraph）里，终端的 `Terminal` 上下文没有任何裸键绑定。

use gpui::{App, KeyBinding, actions};
use jagent_core::settings::Settings;

actions!(
    jagent,
    [
        /// Ctrl-Tab：下一个会话
        CycleNext,
        /// Ctrl-Shift-Tab：上一个会话
        CyclePrev,
        /// 打开 / 关闭设置
        ToggleSettings,
        /// 打开搜索会话弹窗
        SearchThreads,
        /// 新建会话
        NewSession,
        /// 收起 / 展开侧栏
        ToggleSidebar,
        /// 打开 Git 图（硬编码 Ctrl-Shift-G，不进 settings）
        OpenGitGraph,
        /// 设置面内：聚焦搜索框
        FocusSettingsSearch,
        /// 设置面内：Escape 关闭设置并回到之前的主面
        CloseSettings,
        /// Git 图：选中下一条 / 上一条 / 刷新 / 清除选中
        GitSelectNext,
        GitSelectPrev,
        GitRefresh,
        GitClearSelection,
    ]
);

/// 键位上下文名。视图用 `.key_context(CTX_X)` 声明自己，绑定用同名限定生效范围。
pub const CTX_WORKSPACE: &str = "Workspace";
pub const CTX_SETTINGS: &str = "Settings";
pub const CTX_GIT_GRAPH: &str = "GitGraph";

/// gpui 平台层实际会产生的命名键（取自 gpui_macos 的按键转换；Windows / Linux 同名）。
const NAMED_KEYS: &[&str] = &[
    "backspace",
    "delete",
    "down",
    "end",
    "enter",
    "escape",
    "home",
    "insert",
    "left",
    "pagedown",
    "pageup",
    "right",
    "space",
    "tab",
    "up",
];

/// 键位串是否**真的能命中某个键**。
///
/// 不能只靠 `Keystroke::parse`：它极其宽松——`"not a key combo"` 会被当成一个叫这个名字的键，
/// `"ctrl-"` 解析成 key=""，都"成功"，但永远不会被按到，用户重绑错了也没有任何提示。
/// 所以在 parse 之上再要求：恰好一个键位（不含空白分隔的序列），键名是单个字符、`f1..f35`
/// 或平台命名键；且不能只有修饰键。
pub fn is_usable_keystroke(s: &str) -> bool {
    if s.split_whitespace().count() != 1 {
        return false;
    }
    let Ok(k) = gpui::Keystroke::parse(s) else {
        return false;
    };
    let key = k.key.as_str();
    let is_fn = key
        .strip_prefix('f')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=35).contains(&n));
    let is_single_char = key.chars().count() == 1;
    // 「只有修饰键」会被 parse 当成以修饰键自身为键（key = "control" 等）——这不是用户想要的
    let is_modifier_name = matches!(key, "shift" | "control" | "alt" | "platform" | "function");
    !is_modifier_name && (is_single_char || is_fn || NAMED_KEYS.contains(&key))
}

/// 生成全部键位绑定。用户可重绑的 7 个动作来自 `settings.keybindings`；其余是固定语义。
///
/// 键位串语法与 gpui `Keystroke::parse` 一致（`ctrl-shift-tab` / `cmd-k` / `/`），无需转换。
/// 校验不过的串（用户手改坏了）**跳过该条**并返回在 `rejected` 里，由调用方展示——
/// 不能 panic（`KeyBinding::new` 遇到坏串会 panic），也不能让整个键位表失效。
pub fn bindings(settings: &Settings) -> (Vec<KeyBinding>, Vec<Rejected>) {
    let k = &settings.keybindings;
    let mut out = vec![];
    let mut rejected = vec![];
    // 校验后再 new：`KeyBinding::new` 对坏串 panic，所以必须先 parse。
    macro_rules! add {
        ($name:literal, $ks:expr, $action:expr, $ctx:expr) => {
            if is_usable_keystroke($ks) {
                out.push(KeyBinding::new($ks, $action, Some($ctx)));
            } else {
                rejected.push(Rejected {
                    action: $name,
                    keystroke: $ks.to_owned(),
                });
            }
        };
    }

    // 用户可重绑。Workspace 上下文：弹窗 / 终端内不命中，终端靠修饰键透传
    add!("cycleNext", &k.cycle_next, CycleNext, CTX_WORKSPACE);
    add!("cyclePrev", &k.cycle_prev, CyclePrev, CTX_WORKSPACE);
    add!(
        "toggleSettings",
        &k.toggle_settings,
        ToggleSettings,
        CTX_WORKSPACE
    );
    add!(
        "searchThreads",
        &k.search_threads,
        SearchThreads,
        CTX_WORKSPACE
    );
    add!("newSession", &k.new_session, NewSession, CTX_WORKSPACE);
    add!(
        "toggleSidebar",
        &k.toggle_sidebar,
        ToggleSidebar,
        CTX_WORKSPACE
    );
    // 设置面内：聚焦搜索框（默认 `/`，裸键，所以限定在 Settings 上下文）
    add!(
        "focusSearch",
        &k.focus_search,
        FocusSettingsSearch,
        CTX_SETTINGS
    );
    out.push(KeyBinding::new("escape", CloseSettings, Some(CTX_SETTINGS)));

    // 固定语义
    out.push(KeyBinding::new(
        "ctrl-shift-g",
        OpenGitGraph,
        Some(CTX_WORKSPACE),
    ));
    // Git 图裸键：只在 GitGraph 上下文里生效；输入框聚焦时输入框先吃，终端的 Terminal 上下文没有这些键
    out.push(KeyBinding::new("down", GitSelectNext, Some(CTX_GIT_GRAPH)));
    out.push(KeyBinding::new("up", GitSelectPrev, Some(CTX_GIT_GRAPH)));
    out.push(KeyBinding::new("r", GitRefresh, Some(CTX_GIT_GRAPH)));
    out.push(KeyBinding::new(
        "escape",
        GitClearSelection,
        Some(CTX_GIT_GRAPH),
    ));
    (out, rejected)
}

/// 被拒绝的键位（解析失败）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejected {
    pub action: &'static str,
    pub keystroke: String,
}

/// 清掉旧绑定并装上新的（设置里改键位后即时生效）。返回被拒绝的项。
pub fn install(cx: &mut App, settings: &Settings) -> Vec<Rejected> {
    let (b, rejected) = bindings(settings);
    cx.clear_key_bindings();
    cx.bind_keys(b);
    rejected
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keystrokes(b: &KeyBinding) -> String {
        b.keystrokes()
            .iter()
            .map(|k| k.inner().unparse())
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn default_settings_produce_every_binding_and_reject_nothing() {
        let (b, rejected) = bindings(&Settings::default());
        assert!(rejected.is_empty(), "{rejected:?}");
        // 7 个可重绑 + ctrl-shift-g + 4 个 Git 图动作 + Settings Escape
        assert_eq!(b.len(), 7 + 1 + 4 + 1);
    }

    #[test]
    fn the_default_cycle_and_settings_chords_are_what_the_old_ts_used() {
        let (b, _) = bindings(&Settings::default());
        let all: Vec<_> = b.iter().map(keystrokes).collect();
        for want in ["ctrl-tab", "ctrl-shift-tab", "ctrl-,", "ctrl-shift-g", "/"] {
            assert!(all.iter().any(|k| k == want), "缺 {want}：{all:?}");
        }
    }

    #[test]
    fn a_bare_key_is_never_bound_in_the_workspace_context() {
        // 硬约束：终端聚焦时不吃 vim / claude 的裸键。Workspace 上下文里的每个绑定都必须带修饰键。
        let (b, _) = bindings(&Settings::default());
        for kb in &b {
            let is_workspace = kb
                .predicate()
                .is_some_and(|p| p.to_string().contains(CTX_WORKSPACE));
            if is_workspace {
                for ks in kb.keystrokes() {
                    let m = ks.modifiers();
                    assert!(
                        m.control || m.platform || m.alt || m.function,
                        "Workspace 里的裸键 {:?} 会吃掉终端按键",
                        ks.inner().unparse()
                    );
                }
            }
        }
    }

    #[test]
    fn keystroke_validation_accepts_real_keys_and_rejects_ones_that_can_never_fire() {
        for ok in [
            "ctrl-tab",
            "ctrl-shift-tab",
            "cmd-k",
            "ctrl-,",
            "/",
            "escape",
            "ctrl-1",
            "f5",
            "ctrl-f12",
            "ctrl-alt-b",
            "secondary-n",
            "ctrl-pageup",
            "-",
            "ctrl--",
        ] {
            assert!(is_usable_keystroke(ok), "{ok:?} 应可用");
        }
        for bad in [
            "",
            "ctrl-",
            "ctrl-shift-",
            "not a key combo",
            "ctrl-notakey",
            "foo",
            "f0",
            "f99",
            "ctrl-k ctrl-c",
            "shift",
            "ctrl",
        ] {
            assert!(!is_usable_keystroke(bad), "{bad:?} 不应可用");
        }
    }

    #[test]
    fn a_broken_keystroke_is_rejected_without_panicking_and_the_rest_survive() {
        let mut s = Settings::default();
        s.keybindings.cycle_next = "ctrl-".into();
        s.keybindings.new_session = "not a key combo".into();
        let (b, rejected) = bindings(&s);
        let names: Vec<_> = rejected.iter().map(|r| r.action).collect();
        assert_eq!(names, ["cycleNext", "newSession"]);
        assert_eq!(rejected[1].keystroke, "not a key combo");
        assert_eq!(b.len(), 13 - 2, "只丢坏的两条，其余照常");
    }

    #[test]
    fn user_rebinding_is_reflected_in_the_generated_bindings() {
        let mut s = Settings::default();
        s.keybindings.toggle_sidebar = "ctrl-alt-b".into();
        let (b, rejected) = bindings(&s);
        assert!(rejected.is_empty());
        assert!(b.iter().any(|k| keystrokes(k) == "ctrl-alt-b"));
        assert!(
            !b.iter()
                .any(|k| keystrokes(k) == "cmd-b" || keystrokes(k) == "ctrl-b"),
            "旧默认被替换而不是叠加"
        );
    }

    #[gpui::test]
    fn install_replaces_previous_bindings(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            assert!(install(cx, &Settings::default()).is_empty());
            let mut s = Settings::default();
            s.keybindings.cycle_next = "ctrl-alt-n".into();
            assert!(install(cx, &s).is_empty());
            let keymap = cx.key_bindings();
            let keymap = keymap.borrow();
            let all: Vec<String> = keymap.bindings().map(keystrokes).collect();
            assert!(all.iter().any(|k| k == "ctrl-alt-n"));
            assert!(
                !all.iter().any(|k| k == "ctrl-tab"),
                "clear_key_bindings 后旧的不残留：{all:?}"
            );
        });
    }
}
