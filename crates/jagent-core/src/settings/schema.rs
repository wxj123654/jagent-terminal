//! 设置 schema：字段级容错解析 + 序列化。
//!
//! 不用 serde derive 做反序列化：旧 zod 的 `.catch(default)` 是**逐叶**回默认，
//! derive 只能整体失败。这里对 `serde_json::Value` 手写逐叶解析。
//! 未知键保存在 `extra`（顶层）里，往返不丢；`preserve_order` 保证写回键序稳定。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::presets::{TerminalPreset, builtin_presets};

/// 侧栏宽度默认值（旧 `SIZES.sidebarWidth`）。
pub const DEFAULT_SIDEBAR_WIDTH: i64 = 264;
/// 全局 UI 字号缩放默认值（百分比）。
pub const DEFAULT_UI_SCALE: i64 = 100;
/// 全局 UI 字号缩放最小百分比。
pub const MIN_UI_SCALE: i64 = 80;
/// 全局 UI 字号缩放最大百分比。
pub const MAX_UI_SCALE: i64 = 150;
/// 全局 UI 字号缩放步进档位（百分比）。
pub const UI_SCALE_STEPS: [i64; 6] = [80, 90, 100, 110, 125, 150];

/// 终端必须默认到平台自带的等宽字体；不可用字体会让 gpui 回退到比例 UI 字体。
pub fn default_terminal_font() -> &'static str {
    if cfg!(target_os = "macos") {
        "Menlo"
    } else if cfg!(target_os = "windows") {
        "Consolas"
    } else {
        "monospace"
    }
}

fn platform_key(mac: &str, other: &str) -> String {
    if cfg!(target_os = "macos") {
        mac
    } else {
        other
    }
    .to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpAgent {
    pub id: String,
    pub label: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

fn default_acp_agents() -> Vec<AcpAgent> {
    vec![
        AcpAgent {
            id: "acp-pi".into(),
            label: "Pi (ACP)".into(),
            command: "pi-acp".into(),
            args: vec![],
        },
        AcpAgent {
            id: "acp-codex".into(),
            label: "Codex (ACP)".into(),
            command: "codex".into(),
            args: vec!["--acp".into()],
        },
        AcpAgent {
            id: "acp-claude".into(),
            label: "Claude (ACP)".into(),
            command: "claude-code-acp".into(),
            args: vec![],
        },
    ]
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Presets {
    /// "+" 按钮默认预设；None = 跟随 lastUsedPreset
    #[serde(rename = "plusDefault")]
    pub plus_default: Option<String>,
    pub items: Vec<TerminalPreset>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Notifications {
    pub desktop: bool,
    pub sound: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Terminal {
    #[serde(rename = "fontFamily")]
    pub font_family: String,
    #[serde(rename = "fontSize")]
    pub font_size: i64,
    #[serde(rename = "cursorBlink")]
    pub cursor_blink: bool,
    #[serde(rename = "scrollbackLines")]
    pub scrollback_lines: i64,
    pub palette: String,
    #[serde(rename = "closeOnExit")]
    pub close_on_exit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Appearance {
    pub theme: String,
    #[serde(rename = "sidebarWidth")]
    pub sidebar_width: i64,
    #[serde(rename = "wordWrap")]
    pub word_wrap: bool,
    #[serde(rename = "uiScale")]
    pub ui_scale: i64,
}

/// 键位串语法：modifier 以 `-` 连接（`ctrl-tab` / `cmd-k` / `/`）。语义约束在编辑面校验。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Keybindings {
    #[serde(rename = "cycleNext")]
    pub cycle_next: String,
    #[serde(rename = "cyclePrev")]
    pub cycle_prev: String,
    #[serde(rename = "toggleSettings")]
    pub toggle_settings: String,
    #[serde(rename = "focusSearch")]
    pub focus_search: String,
    /// 打开搜索会话弹窗；默认平台化（mac ⌘K 不写 PTY，零冲突）
    #[serde(rename = "searchThreads")]
    pub search_threads: String,
    /// 收起/展开侧栏
    #[serde(rename = "toggleSidebar")]
    pub toggle_sidebar: String,
    /// 新建会话；非 mac 用 ctrl-shift-n（裸 ctrl-n 是 readline next-history，吃掉会破坏 shell）
    #[serde(rename = "newSession")]
    pub new_session: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GpuBackend {
    Auto,
    Metal,
    Dx12,
    Vulkan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Advanced {
    #[serde(rename = "gpuBackend")]
    pub gpu_backend: GpuBackend,
    #[serde(rename = "perfHud")]
    pub perf_hud: bool,
    #[serde(rename = "frameOverlay")]
    pub frame_overlay: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub presets: Presets,
    pub notifications: Notifications,
    pub terminal: Terminal,
    pub appearance: Appearance,
    pub acp_agents: Vec<AcpAgent>,
    pub keybindings: Keybindings,
    pub advanced: Advanced,
    /// 顶层未知键（旧 looseObject）：读进来的写盘后仍在。
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            presets: Presets {
                plus_default: None,
                items: builtin_presets(),
            },
            notifications: Notifications {
                desktop: true,
                sound: false,
            },
            terminal: Terminal {
                font_family: default_terminal_font().into(),
                font_size: 13,
                cursor_blink: true,
                scrollback_lines: 10_000,
                palette: "one-dark".into(),
                close_on_exit: false,
            },
            appearance: Appearance {
                theme: "one-dark".into(),
                sidebar_width: DEFAULT_SIDEBAR_WIDTH,
                word_wrap: false,
                ui_scale: DEFAULT_UI_SCALE,
            },
            acp_agents: default_acp_agents(),
            keybindings: Keybindings {
                cycle_next: "ctrl-tab".into(),
                cycle_prev: "ctrl-shift-tab".into(),
                toggle_settings: "ctrl-,".into(),
                focus_search: "/".into(),
                search_threads: platform_key("cmd-k", "ctrl-k"),
                toggle_sidebar: platform_key("cmd-b", "ctrl-b"),
                new_session: platform_key("cmd-n", "ctrl-shift-n"),
            },
            advanced: Advanced {
                gpu_backend: GpuBackend::Auto,
                perf_hud: false,
                frame_overlay: false,
            },
            extra: Map::new(),
        }
    }
}

// ── 逐叶容错读取（对应 zod `.catch(default)`）──────────────────────

fn leaf_bool(sec: Option<&Map<String, Value>>, key: &str, default: bool) -> bool {
    sec.and_then(|m| m.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

fn leaf_string(sec: Option<&Map<String, Value>>, key: &str, default: &str) -> String {
    sec.and_then(|m| m.get(key))
        .and_then(Value::as_str)
        .map_or_else(|| default.to_owned(), str::to_owned)
}

/// 整数且在 [min, max]；浮点 / 越界 / 缺失 / 类型错都回默认（zod `.int().min().max().catch`）。
fn leaf_int(sec: Option<&Map<String, Value>>, key: &str, min: i64, max: i64, default: i64) -> i64 {
    sec.and_then(|m| m.get(key))
        .and_then(Value::as_i64)
        .filter(|n| (min..=max).contains(n))
        .unwrap_or(default)
}

/// 整节：缺失 → 空对象（叶子各自回默认）；存在但不是对象 → `Err`（由顶层整体回默认）。
fn section<'a>(
    root: &'a Map<String, Value>,
    key: &str,
) -> Result<Option<&'a Map<String, Value>>, ()> {
    match root.get(key) {
        None => Ok(None),
        Some(Value::Object(m)) => Ok(Some(m)),
        Some(_) => Err(()),
    }
}

fn parse_presets_items(sec: Option<&Map<String, Value>>) -> Vec<TerminalPreset> {
    // 数组必须每一项都合法才采用，否则整个数组回内置（与 zod `z.array(...).catch(BUILTIN)` 一致）。
    sec.and_then(|m| m.get("items"))
        .and_then(|v| serde_json::from_value::<Vec<TerminalPreset>>(v.clone()).ok())
        .unwrap_or_else(builtin_presets)
}

fn parse_acp_agents(v: Option<&Value>) -> Vec<AcpAgent> {
    // 元素里 args 坏 → 该元素 args 回 []（zod 叶子 catch）；其余字段缺失 → 整个数组回默认。
    let Some(Value::Array(items)) = v else {
        return default_acp_agents();
    };
    let mut out = Vec::with_capacity(items.len());
    for it in items {
        let Some(o) = it.as_object() else {
            return default_acp_agents();
        };
        let (Some(id), Some(label), Some(command)) = (
            o.get("id").and_then(Value::as_str),
            o.get("label").and_then(Value::as_str),
            o.get("command").and_then(Value::as_str),
        ) else {
            return default_acp_agents();
        };
        let args = match o.get("args") {
            Some(Value::Array(a)) if a.iter().all(Value::is_string) => a
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            _ => vec![],
        };
        out.push(AcpAgent {
            id: id.into(),
            label: label.into(),
            command: command.into(),
            args,
        });
    }
    out
}

/// 旧版把未随应用分发的 JetBrains Mono 写成默认值，已落盘用户并没有主动选择它，
/// 却会永久覆盖新默认；在解析边界迁移成平台字体。
fn migrate_legacy(root: &mut Map<String, Value>) {
    if let Some(Value::Object(t)) = root.get_mut("terminal")
        && t.get("fontFamily").and_then(Value::as_str) == Some("JetBrains Mono")
    {
        t.insert("fontFamily".into(), json!(default_terminal_font()));
    }
    if let Some(Value::Array(agents)) = root.get_mut("acpAgents") {
        for agent in agents.iter_mut() {
            if let Some(obj) = agent.as_object_mut()
                && obj.get("command").and_then(Value::as_str) == Some("pi")
                && obj
                    .get("args")
                    .and_then(Value::as_array)
                    .is_some_and(|a| a.len() == 1 && a[0].as_str() == Some("--acp-stdio"))
            {
                obj.insert("command".into(), json!("pi-acp"));
                obj.insert("args".into(), json!([]));
            }
        }
    }
}

/// 解析 settings.json 原文。永不失败：
/// - 坏 JSON / 顶层不是对象 / 某一节类型错 → 整体回默认；
/// - 其余坏值逐叶回默认。
pub fn parse_settings(raw: &str) -> Settings {
    let Ok(Value::Object(mut root)) = serde_json::from_str::<Value>(raw) else {
        return Settings::default();
    };
    migrate_legacy(&mut root);
    parse_root(&root).unwrap_or_default()
}

/// 把已构造的 `Settings` 经同一套容错再过一遍（patch 后的"越界值回默认"靠它）。
pub(crate) fn reparse(s: &Settings) -> Settings {
    match serde_json::to_value(SettingsOut(s)) {
        Ok(Value::Object(root)) => parse_root(&root).unwrap_or_default(),
        _ => Settings::default(),
    }
}

fn parse_root(root: &Map<String, Value>) -> Result<Settings, ()> {
    let d = Settings::default();

    let presets = section(root, "presets")?;
    let notifications = section(root, "notifications")?;
    let terminal = section(root, "terminal")?;
    let appearance = section(root, "appearance")?;
    let keybindings = section(root, "keybindings")?;
    let advanced = section(root, "advanced")?;

    let plus_default = match presets.and_then(|m| m.get("plusDefault")) {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None, // 缺失 / null / 类型错 → null
    };

    let gpu_backend = match advanced
        .and_then(|m| m.get("gpuBackend"))
        .and_then(Value::as_str)
    {
        Some("metal") => GpuBackend::Metal,
        Some("dx12") => GpuBackend::Dx12,
        Some("vulkan") => GpuBackend::Vulkan,
        _ => GpuBackend::Auto,
    };

    const KNOWN: [&str; 7] = [
        "presets",
        "notifications",
        "terminal",
        "appearance",
        "acpAgents",
        "keybindings",
        "advanced",
    ];
    let extra = root
        .iter()
        .filter(|(k, _)| !KNOWN.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    Ok(Settings {
        presets: Presets {
            plus_default,
            items: parse_presets_items(presets),
        },
        notifications: Notifications {
            desktop: leaf_bool(notifications, "desktop", d.notifications.desktop),
            sound: leaf_bool(notifications, "sound", d.notifications.sound),
        },
        terminal: Terminal {
            font_family: leaf_string(terminal, "fontFamily", &d.terminal.font_family),
            font_size: leaf_int(terminal, "fontSize", 10, 22, d.terminal.font_size),
            cursor_blink: leaf_bool(terminal, "cursorBlink", d.terminal.cursor_blink),
            scrollback_lines: leaf_int(
                terminal,
                "scrollbackLines",
                1000,
                100_000,
                d.terminal.scrollback_lines,
            ),
            palette: leaf_string(terminal, "palette", &d.terminal.palette),
            close_on_exit: leaf_bool(terminal, "closeOnExit", d.terminal.close_on_exit),
        },
        appearance: Appearance {
            theme: leaf_string(appearance, "theme", &d.appearance.theme),
            sidebar_width: leaf_int(
                appearance,
                "sidebarWidth",
                200,
                400,
                d.appearance.sidebar_width,
            ),
            word_wrap: leaf_bool(appearance, "wordWrap", d.appearance.word_wrap),
            ui_scale: leaf_int(
                appearance,
                "uiScale",
                MIN_UI_SCALE,
                MAX_UI_SCALE,
                d.appearance.ui_scale,
            ),
        },
        acp_agents: parse_acp_agents(root.get("acpAgents")),
        keybindings: Keybindings {
            cycle_next: leaf_string(keybindings, "cycleNext", &d.keybindings.cycle_next),
            cycle_prev: leaf_string(keybindings, "cyclePrev", &d.keybindings.cycle_prev),
            toggle_settings: leaf_string(
                keybindings,
                "toggleSettings",
                &d.keybindings.toggle_settings,
            ),
            focus_search: leaf_string(keybindings, "focusSearch", &d.keybindings.focus_search),
            search_threads: leaf_string(
                keybindings,
                "searchThreads",
                &d.keybindings.search_threads,
            ),
            toggle_sidebar: leaf_string(
                keybindings,
                "toggleSidebar",
                &d.keybindings.toggle_sidebar,
            ),
            new_session: leaf_string(keybindings, "newSession", &d.keybindings.new_session),
        },
        advanced: Advanced {
            gpu_backend,
            perf_hud: leaf_bool(advanced, "perfHud", d.advanced.perf_hud),
            frame_overlay: leaf_bool(advanced, "frameOverlay", d.advanced.frame_overlay),
        },
        extra,
    })
}

/// 序列化视图：已知节在前（固定顺序），未知键在后原样保留。
struct SettingsOut<'a>(&'a Settings);

impl Serialize for SettingsOut<'_> {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let s = self.0;
        let mut m = ser.serialize_map(None)?;
        m.serialize_entry("presets", &s.presets)?;
        m.serialize_entry("notifications", &s.notifications)?;
        m.serialize_entry("terminal", &s.terminal)?;
        m.serialize_entry("appearance", &s.appearance)?;
        m.serialize_entry("acpAgents", &s.acp_agents)?;
        m.serialize_entry("keybindings", &s.keybindings)?;
        m.serialize_entry("advanced", &s.advanced)?;
        for (k, v) in &s.extra {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

/// 写盘形态（缩进 2 空格 + 末尾换行；与 Advanced 的 JSON 实时视图同源）。
pub fn serialize_settings(s: &Settings) -> String {
    let mut out = serde_json::to_string_pretty(&SettingsOut(s)).expect("settings serialize");
    out.push('\n');
    out
}

// ── dot-path 取值（`terminal.fontSize`；不存在返回 None）─────────────

impl Settings {
    /// 用于 `isModified` / `reset`：把当前设置转成 JSON 后按 dot-path 取值。
    pub fn get_path(&self, path: &str) -> Option<Value> {
        let v = serde_json::to_value(SettingsOut(self)).ok()?;
        path.split('.').try_fold(&v, |acc, k| acc.get(k)).cloned()
    }

    /// 按 dot-path 写入后经容错解析（越界值立即回默认，UI 立即看到回滚）。
    /// 路径不存在时返回 `None`（调用方忽略）。
    pub fn with_path(&self, path: &str, value: Value) -> Option<Settings> {
        let mut root = serde_json::to_value(SettingsOut(self)).ok()?;
        let mut cur = &mut root;
        let keys: Vec<_> = path.split('.').collect();
        let (last, parents) = keys.split_last()?;
        for k in parents {
            cur = cur.get_mut(*k)?;
        }
        cur.as_object_mut()?.get_mut(*last)?; // 只允许改已存在的叶子
        cur.as_object_mut()?.insert((*last).to_owned(), value);
        parse_root(root.as_object()?).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(v: Value) -> Settings {
        parse_settings(&v.to_string())
    }

    #[test]
    fn defaults_match_settings_ui_table() {
        let d = Settings::default();
        assert_eq!(d.presets.plus_default, None);
        assert_eq!(d.presets.items.len(), 5);
        assert_eq!(
            d.notifications,
            Notifications {
                desktop: true,
                sound: false
            }
        );
        assert_eq!(
            d.terminal,
            Terminal {
                font_family: default_terminal_font().into(),
                font_size: 13,
                cursor_blink: true,
                scrollback_lines: 10_000,
                palette: "one-dark".into(),
                close_on_exit: false,
            }
        );
        assert_eq!(
            d.appearance,
            Appearance {
                theme: "one-dark".into(),
                sidebar_width: 264,
                word_wrap: false,
                ui_scale: 100,
            }
        );
        assert_eq!(d.acp_agents.len(), 3);
        assert_eq!(
            d.advanced,
            Advanced {
                gpu_backend: GpuBackend::Auto,
                perf_hud: false,
                frame_overlay: false
            }
        );
    }

    #[test]
    fn empty_object_and_missing_sections_give_defaults() {
        assert_eq!(parse(json!({})), Settings::default());
    }

    #[test]
    fn bad_json_gives_defaults() {
        assert_eq!(parse_settings("{ this is not json"), Settings::default());
        assert_eq!(parse_settings("[1,2]"), Settings::default(), "顶层不是对象");
    }

    #[test]
    fn out_of_range_leaf_falls_back_but_good_leaf_survives() {
        let s = parse(json!({
            "terminal": { "fontSize": 99, "fontFamily": "Consolas" },
            "appearance": { "sidebarWidth": 50 },
        }));
        assert_eq!(s.terminal.font_size, 13, "越界回默认");
        assert_eq!(s.terminal.font_family, "Consolas", "好值保留");
        assert_eq!(s.appearance.sidebar_width, 264);
        assert!(s.notifications.desktop, "整节缺失 → 叶子默认");
    }

    #[test]
    fn float_for_int_field_falls_back() {
        let s = parse(json!({ "terminal": { "fontSize": 13.5 } }));
        assert_eq!(s.terminal.font_size, 13);
    }

    #[test]
    fn section_with_wrong_type_resets_everything() {
        let s = parse(json!({ "terminal": 123, "notifications": { "desktop": false } }));
        assert_eq!(
            s,
            Settings::default(),
            "整节类型错 → 整体回默认，notifications 的好值也丢"
        );
    }

    #[test]
    fn unknown_keys_round_trip() {
        let s = parse(json!({ "__future": { "nested": [1, 2] }, "terminal": { "fontSize": 14 } }));
        assert_eq!(s.terminal.font_size, 14);
        let out: Value = serde_json::from_str(&serialize_settings(&s)).unwrap();
        assert_eq!(out["__future"], json!({ "nested": [1, 2] }));
        assert_eq!(out["terminal"]["fontSize"], 14);
    }

    #[test]
    fn broken_presets_array_falls_back_to_builtin() {
        let s = parse(json!({ "presets": { "items": [{ "id": "x" }] } })); // 缺 label / builtin
        let ids: Vec<_> = s.presets.items.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["pi", "claude", "codex", "amp", "shell"]);
    }

    #[test]
    fn legacy_jetbrains_mono_is_migrated_to_platform_font() {
        let s = parse(json!({ "terminal": { "fontFamily": "JetBrains Mono" } }));
        assert_eq!(s.terminal.font_family, default_terminal_font());
    }

    #[test]
    fn legacy_pi_acp_stdio_is_migrated_to_pi_acp() {
        let s = parse(json!({
            "acpAgents": [
                { "id": "acp-x-1", "label": "Pi ACP Bridge", "command": "pi", "args": ["--acp-stdio"] }
            ]
        }));
        assert_eq!(s.acp_agents.len(), 1);
        assert_eq!(s.acp_agents[0].command, "pi-acp");
        assert!(s.acp_agents[0].args.is_empty());
    }

    #[test]
    fn gpu_backend_enum_and_unknown_value() {
        assert_eq!(
            parse(json!({ "advanced": { "gpuBackend": "metal" } }))
                .advanced
                .gpu_backend,
            GpuBackend::Metal
        );
        assert_eq!(
            parse(json!({ "advanced": { "gpuBackend": "opengl" } }))
                .advanced
                .gpu_backend,
            GpuBackend::Auto
        );
    }

    #[test]
    fn acp_agents_args_leaf_falls_back_but_missing_required_resets_array() {
        let s = parse(
            json!({ "acpAgents": [{ "id": "a", "label": "A", "command": "c", "args": "oops" }] }),
        );
        assert_eq!(
            s.acp_agents,
            vec![AcpAgent {
                id: "a".into(),
                label: "A".into(),
                command: "c".into(),
                args: vec![]
            }]
        );
        let s = parse(json!({ "acpAgents": [{ "id": "a" }] }));
        assert_eq!(s.acp_agents, default_acp_agents());
        assert_eq!(
            parse(json!({ "acpAgents": [] })).acp_agents,
            vec![],
            "显式空数组保留"
        );
    }

    #[test]
    fn serialize_parse_round_trip_is_stable() {
        let mut s = Settings::default();
        s.terminal.font_size = 17;
        s.extra.insert("k".into(), json!(1));
        let again = parse_settings(&serialize_settings(&s));
        assert_eq!(again, s);
        assert!(serialize_settings(&s).ends_with("}\n"));
    }

    #[test]
    fn serialized_form_has_no_runtime_state() {
        assert!(!serialize_settings(&Settings::default()).contains("lastUsedPreset"));
    }

    #[test]
    fn get_path_and_with_path() {
        let s = Settings::default();
        assert_eq!(s.get_path("terminal.fontSize"), Some(json!(13)));
        assert_eq!(s.get_path("nope.x"), None);
        let t = s.with_path("terminal.fontSize", json!(15)).unwrap();
        assert_eq!(t.terminal.font_size, 15);
        let t = s.with_path("terminal.fontSize", json!(99)).unwrap();
        assert_eq!(t.terminal.font_size, 13, "越界立即回默认");
        assert!(
            s.with_path("terminal.nope", json!(1)).is_none(),
            "不存在的叶子不可写"
        );
        let t = s.with_path("presets.plusDefault", json!("claude")).unwrap();
        assert_eq!(t.presets.plus_default.as_deref(), Some("claude"));
        let t = s.with_path("acpAgents", json!([])).unwrap();
        assert!(t.acp_agents.is_empty(), "数组整体可 patch");
    }

    #[test]
    fn ui_scale_parses_clamps_out_of_range_and_round_trips() {
        // 缺字段的老配置默认 100
        let legacy = parse(json!({ "appearance": { "theme": "one-dark", "sidebarWidth": 280 } }));
        assert_eq!(legacy.appearance.ui_scale, 100);
        assert_eq!(legacy.appearance.sidebar_width, 280);

        // 边界与合法值
        assert_eq!(
            parse(json!({ "appearance": { "uiScale": 80 } })).appearance.ui_scale,
            80
        );
        assert_eq!(
            parse(json!({ "appearance": { "uiScale": 125 } })).appearance.ui_scale,
            125
        );
        assert_eq!(
            parse(json!({ "appearance": { "uiScale": 150 } })).appearance.ui_scale,
            150
        );

        // 越界 / 浮点 / 类型错误 → 回默认 100，其余好值保留
        let under = parse(json!({ "appearance": { "uiScale": 79, "wordWrap": true } }));
        assert_eq!(under.appearance.ui_scale, 100);
        assert!(under.appearance.word_wrap);
        assert_eq!(
            parse(json!({ "appearance": { "uiScale": 151 } })).appearance.ui_scale,
            100
        );
        assert_eq!(
            parse(json!({ "appearance": { "uiScale": 110.5 } })).appearance.ui_scale,
            100
        );
        assert_eq!(
            parse(json!({ "appearance": { "uiScale": "110%" } })).appearance.ui_scale,
            100
        );

        // dot-path 读写与序列化往返
        let s = Settings::default();
        assert_eq!(s.get_path("appearance.uiScale"), Some(json!(100)));
        let patched = s.with_path("appearance.uiScale", json!(125)).unwrap();
        assert_eq!(patched.appearance.ui_scale, 125);
        let reparsed = parse_settings(&serialize_settings(&patched));
        assert_eq!(reparsed.appearance.ui_scale, 125);
        assert_eq!(reparsed, patched);
        let fallback = patched.with_path("appearance.uiScale", json!(200)).unwrap();
        assert_eq!(fallback.appearance.ui_scale, 100, "越界 patch 立即回默认");
    }
}
