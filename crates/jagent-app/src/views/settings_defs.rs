//! 设置页静态定义与纯逻辑（V4 原型对齐）。
//!
//! 像素/文案真源：React 原型 `SettingsView.tsx` + `seed.ts`（SECTIONS /
//! SETTING_DEFS / KEY_ACTIONS / FIXED_KEYS / CONVENTIONS / FONT_CANDIDATES）；
//! 搜索命中面与 `gpuix SettingsView.tsx::hitsBySection` / `sectionHasContent` 一致。
//! 本文件零 gpui 元素构建，只出数据与谓词，`#[cfg(test)]` 全覆盖。

use jagent_core::presets::TerminalPreset;
use jagent_core::settings::{AcpAgent, Settings};

/// 设置分区（顺序 = 原型 SECTIONS；id 与 settings.json 分区无关，仅视图态）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
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
    /// 原型 SECTIONS 的双语 label（nav 与搜索分节小头共用）。
    pub fn label(self) -> &'static str {
        match self {
            Self::Presets => "Presets · 预设",
            Self::Notifications => "Notifications · 通知",
            Self::Terminal => "Terminal · 终端",
            Self::Appearance => "Appearance · 外观",
            Self::Keybindings => "Keybindings · 键位",
            Self::AcpAgents => "ACP Agents · 外部 agent",
            Self::Advanced => "Advanced · 高级",
        }
    }
    /// 原型 SECTION_ICONS（nav 行 14px 图标）。
    pub fn icon(self) -> crate::icons::IconName {
        use crate::icons::IconName;
        match self {
            Self::Presets => IconName::Agent,
            Self::Notifications => IconName::Bell,
            Self::Terminal => IconName::Terminal,
            Self::Appearance => IconName::Edit,
            Self::Keybindings => IconName::Tag,
            Self::AcpAgents => IconName::Acp,
            Self::Advanced => IconName::Gear,
        }
    }
}

/// 右侧控件形态（原型 SettingDef.type）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlKind {
    Toggle,
    Font,
    Number {
        min: i64,
        max: i64,
        step: i64,
    },
    Select {
        options: &'static [(&'static str, &'static str)],
    },
    Range {
        min: i64,
        max: i64,
        step: i64,
    },
}

/// 一条可搜索、可 reset 的设置定义（原型 SETTING_DEFS 逐项对齐；
/// appearance.theme 的 Phase 2 选项因 core 只认 one-dark 暂未列出，见会话日志）。
#[derive(Clone, Copy, Debug)]
pub struct SettingDef {
    pub path: &'static str,
    pub section: Section,
    pub label: &'static str,
    pub desc: &'static str,
    pub control: ControlKind,
}

/// 终端调色板（第一期单值；原型同）
const PALETTE_OPTIONS: &[(&str, &str)] = &[("one-dark", "One Dark")];
/// 主题（Phase 2 项 core 不认，只保留默认）
const THEME_OPTIONS: &[(&str, &str)] = &[("one-dark", "Mono Dark（默认）")];
/// GPU 后端（值与 core `GpuBackend` 一一对应）
const GPU_OPTIONS: &[(&str, &str)] = &[
    ("auto", "Auto（推荐）"),
    ("dx12", "DirectX 12"),
    ("vulkan", "Vulkan"),
    ("metal", "Metal"),
];

pub const SETTING_DEFS: &[SettingDef] = &[
    SettingDef {
        path: "notifications.desktop",
        section: Section::Notifications,
        label: "桌面通知",
        desc: "BEL 且未聚焦时弹出系统通知；聚焦该 thread 即清除",
        control: ControlKind::Toggle,
    },
    SettingDef {
        path: "notifications.sound",
        section: Section::Notifications,
        label: "通知声音",
        desc: "通知附带提示音（依赖桌面通知开启）",
        control: ControlKind::Toggle,
    },
    SettingDef {
        path: "terminal.fontFamily",
        section: Section::Terminal,
        label: "字体",
        desc: "终端专用 mono 字体，不继承 UI 字体",
        control: ControlKind::Font,
    },
    SettingDef {
        path: "terminal.fontSize",
        section: Section::Terminal,
        label: "字号",
        desc: "行高与 cell 尺寸由 TerminalView 自管",
        control: ControlKind::Number {
            min: 10,
            max: 22,
            step: 1,
        },
    },
    SettingDef {
        path: "terminal.cursorBlink",
        section: Section::Terminal,
        label: "光标闪烁",
        desc: "系统 reduced-motion 开启时自动关闭",
        control: ControlKind::Toggle,
    },
    SettingDef {
        path: "terminal.scrollbackLines",
        section: Section::Terminal,
        label: "回滚行数",
        desc: "scrollback 缓冲区大小",
        control: ControlKind::Number {
            min: 1000,
            max: 100_000,
            step: 500,
        },
    },
    SettingDef {
        path: "terminal.palette",
        section: Section::Terminal,
        label: "调色板",
        desc: "终端背景与 16 色独立于父容器",
        control: ControlKind::Select {
            options: PALETTE_OPTIONS,
        },
    },
    SettingDef {
        path: "terminal.closeOnExit",
        section: Section::Terminal,
        label: "退出后直接关闭",
        desc: "进程 exit 后：开=直接销毁该行；关=保留 exited 灰行查看残留（默认保留）",
        control: ControlKind::Toggle,
    },
    SettingDef {
        path: "appearance.theme",
        section: Section::Appearance,
        label: "主题",
        desc: "V2 单色暗色（值名 one-dark 为落盘兼容）",
        control: ControlKind::Select {
            options: THEME_OPTIONS,
        },
    },
    SettingDef {
        path: "appearance.sidebarWidth",
        section: Section::Appearance,
        label: "侧栏宽度",
        desc: "thread 列表宽度，拖拽时实时写回",
        control: ControlKind::Range {
            min: 200,
            max: 400,
            step: 2,
        },
    },
    SettingDef {
        path: "appearance.wordWrap",
        section: Section::Appearance,
        label: "代码与 Diff 自动换行",
        desc: "在主画布编辑器与 Diff 视图中对超长行启用软换行（关闭时支持横向滚动）",
        control: ControlKind::Toggle,
    },
    SettingDef {
        path: "appearance.uiScale",
        section: Section::Appearance,
        label: "界面缩放",
        desc: "全局 UI 字号缩放比例（80 / 90 / 100 / 110 / 125 / 150%，终端独立）",
        control: ControlKind::Number {
            min: 80,
            max: 150,
            step: 10,
        },
    },
    SettingDef {
        path: "advanced.gpuBackend",
        section: Section::Advanced,
        label: "GPU 后端",
        desc: "GPUIX（pinned GPUI fork）渲染后端",
        control: ControlKind::Select {
            options: GPU_OPTIONS,
        },
    },
    SettingDef {
        path: "advanced.perfHud",
        section: Section::Advanced,
        label: "性能指标 HUD",
        desc: "在标题栏右上角显示整 app 帧率、整帧耗时（p90/max）、终端 paint 与 CPU/内存（500ms 刷新）",
        control: ControlKind::Toggle,
    },
    SettingDef {
        path: "advanced.frameOverlay",
        section: Section::Advanced,
        label: "屏幕帧覆盖层",
        desc: "GPUIX 内建调试 overlay：把整帧耗时直方图直接画在画面上（与 HUD 数字同源）",
        control: ControlKind::Toggle,
    },
];

/// def × query 子串匹配（label / desc / path；不区分大小写）。
pub fn match_def(d: &SettingDef, query: &str) -> bool {
    let q = query.to_lowercase();
    d.label.to_lowercase().contains(&q)
        || d.desc.to_lowercase().contains(&q)
        || d.path.to_lowercase().contains(&q)
}

/// 键位分区可配置动作（原型 KEY_ACTIONS；path = settings.keybindings 的叶子名）。
pub const KEY_ACTIONS: &[(&str, &str)] = &[
    ("cycleNext", "下一个 thread（循环切换）"),
    ("cyclePrev", "上一个 thread（循环切换）"),
    ("toggleSettings", "打开 / 关闭设置"),
    ("focusSearch", "聚焦设置搜索"),
    ("searchThreads", "搜索会话（⌘K/Ctrl-K）"),
    ("toggleSidebar", "收起 / 展开侧栏（⌘B/Ctrl-B）"),
    ("newSession", "新建会话（⌘N）"),
];

/// 平台语义只读键（不参与配置；原型 FIXED_KEYS）。
pub const FIXED_KEYS: &[(&str, &str)] = &[
    ("返回 / 清空搜索", "Esc（平台语义）"),
    ("新建 / 预设菜单", "+ 单击 / Shift +"),
];

/// 通知分区约定卡条目（原型 CONVENTIONS）。
pub const CONVENTIONS: &[(&str, &str)] = &[
    ("Pi", ".pi/extensions/zed-bell.ts 在 agent_end 写 \\x07"),
    ("Amp", "env AMP_FORCE_BEL=1"),
    (
        "Claude",
        "settings.json → preferredNotifChannel: \"terminal_bell\"",
    ),
    ("Codex", "tui.terminal_title → OSC 标题"),
];

/// 约定卡命中（原型：标题字串或任一条目 name+desc 子串）。
pub fn convention_matches(q: &str) -> bool {
    let kl = q.to_lowercase();
    "cli bel osc 约定".contains(&kl)
        || CONVENTIONS
            .iter()
            .any(|(n, d)| format!("{n}{d}").to_lowercase().contains(&kl))
}

/// 预设分区首行（「+」按钮默认预设）的搜索命中：不在 SETTING_DEFS 里，
/// 单独按 label/desc/键名子串判（原型 PresetsSection 首行无过滤——该行恒显，
/// 这里跟 gpuix 一致把首行也纳入过滤面）。
pub fn plus_default_matches(q: &str) -> bool {
    q.is_empty()
        || "「+」按钮默认预设 presets.plusDefault 跟随上次使用 点侧栏新建会话时直接启动该预设"
            .to_lowercase()
            .contains(&q.to_lowercase())
}

fn preset_matches(p: &TerminalPreset, q: &str) -> bool {
    format!(
        "{} {} {} {}",
        p.label,
        p.id,
        p.program.as_deref().unwrap_or(""),
        p.init_command.as_deref().unwrap_or("")
    )
    .to_lowercase()
    .contains(&q.to_lowercase())
}

fn acp_agent_matches(a: &AcpAgent, q: &str) -> bool {
    format!("{} {} {}", a.label, a.command, a.args.join(" "))
        .to_lowercase()
        .contains(&q.to_lowercase())
}

fn keybinding_hits(q: &str, settings: &Settings) -> usize {
    let kl = q.to_lowercase();
    let key_of = |action: &str| -> String {
        let k = &settings.keybindings;
        match action {
            "cycleNext" => k.cycle_next.clone(),
            "cyclePrev" => k.cycle_prev.clone(),
            "toggleSettings" => k.toggle_settings.clone(),
            "focusSearch" => k.focus_search.clone(),
            "searchThreads" => k.search_threads.clone(),
            "toggleSidebar" => k.toggle_sidebar.clone(),
            "newSession" => k.new_session.clone(),
            other => other.to_owned(),
        }
    };
    let rows = KEY_ACTIONS
        .iter()
        .map(|(a, label)| ((*label).to_owned(), key_of(a)))
        .chain(
            FIXED_KEYS
                .iter()
                .map(|(l, k)| ((*l).to_owned(), (*k).to_owned())),
        );
    rows.filter(|(label, key)| {
        label.to_lowercase().contains(&kl) || key.to_lowercase().contains(&kl)
    })
    .count()
}

/// 各分区命中数（nav 徽章 / 搜索分节显隐共用；q 为空返回全零）。
/// 返回与 [`Section::ALL`] 同序的计数。
pub fn section_hits(settings: &Settings, q: &str) -> [usize; 7] {
    let mut hits = [0usize; 7];
    if q.is_empty() {
        return hits;
    }
    let idx = |s: Section| Section::ALL.iter().position(|x| *x == s).unwrap();
    for d in SETTING_DEFS {
        if match_def(d, q) {
            hits[idx(d.section)] += 1;
        }
    }
    hits[idx(Section::Keybindings)] += keybinding_hits(q, settings);
    let preset = settings
        .presets
        .items
        .iter()
        .filter(|p| preset_matches(p, q))
        .count();
    hits[idx(Section::Presets)] += preset;
    let acp = settings
        .acp_agents
        .iter()
        .filter(|a| acp_agent_matches(a, q))
        .count();
    hits[idx(Section::AcpAgents)] += acp;
    hits
}

/// 分区在当前查询下是否有内容（nav 置灰与右列分节显隐共用）。
/// presets / acp 恒有内容（列表分区空命中走卡内「无匹配」）。
pub fn section_has_content(section: Section, q: &str, settings: &Settings) -> bool {
    if q.is_empty() {
        return true;
    }
    match section {
        Section::Presets | Section::AcpAgents => true,
        Section::Keybindings => keybinding_hits(q, settings) > 0,
        Section::Notifications => {
            SETTING_DEFS
                .iter()
                .any(|d| d.section == section && match_def(d, q))
                || convention_matches(q)
        }
        _ => SETTING_DEFS
            .iter()
            .any(|d| d.section == section && match_def(d, q)),
    }
}

/// 预设在查询下的可见性（Presets 分区行过滤；同 `preset_matches`）。
pub fn preset_visible(p: &TerminalPreset, q: &str) -> bool {
    q.is_empty() || preset_matches(p, q)
}

/// ACP agent 在查询下的可见性。
pub fn acp_agent_visible(a: &AcpAgent, q: &str) -> bool {
    q.is_empty() || acp_agent_matches(a, q)
}

/// 搜索高亮命中区间：返回 text 的 byte range（首处、不区分大小写）；
/// q 为空或未命中返回 None。区间两端保证在 char 边界上（to_lowercase 可能
/// 改变字节长度，先在 lowercase 串上找再收敛到原串边界），供
/// `StyledText::with_highlights` 直接使用（原型 `hl()` 的 <mark> 段）。
pub fn hl_range(text: &str, q: &str) -> Option<std::ops::Range<usize>> {
    let q = q.trim();
    if q.is_empty() {
        return None;
    }
    let lower = text.to_lowercase();
    let start = lower.find(&q.to_lowercase())?;
    let start = lower
        .char_indices()
        .map(|(i, _)| i)
        .take_while(|i| *i <= start)
        .last()
        .unwrap_or(start);
    let end = (start + q.len()).min(text.len());
    let end = text
        .char_indices()
        .map(|(i, _)| i)
        .take_while(|i| *i <= end)
        .last()
        .unwrap_or(end);
    Some(start..end)
}

/// 字体候选（原型 `FONT_CANDIDATES`：常见等宽 + CJK；不读系统字体表，
/// 靠字身预览回退与 freeform 自由输入兜底——原型 document.fonts.check 不可用时同样全量展示）。
pub const FONT_CANDIDATES: &[&str] = &[
    "Cascadia Code",
    "Cascadia Mono",
    "Consolas",
    "Courier New",
    "Fira Code",
    "Fira Mono",
    "JetBrains Mono",
    "JetBrains Mono NL",
    "Source Code Pro",
    "IBM Plex Mono",
    "Iosevka",
    "Hack",
    "Inconsolata",
    "Ubuntu Mono",
    "DejaVu Sans Mono",
    "Liberation Mono",
    "Lucida Console",
    "Menlo",
    "SF Mono",
    "Monaco",
    "Victor Mono",
    "Cousine",
    "Roboto Mono",
    "Noto Sans Mono",
    "Intel One Mono",
    "Geist Mono",
    "Maple Mono",
    "Sarasa Mono SC",
    "Microsoft YaHei UI",
    "Microsoft YaHei",
    "SimSun",
    "NSimSun",
    "SimHei",
    "KaiTi",
    "DengXian",
    "Segoe UI",
    "Segoe UI Variable",
    "Arial",
    "Helvetica",
    "Times New Roman",
    "Georgia",
    "Verdana",
    "Tahoma",
    "Trebuchet MS",
    "Calibri",
    "Cambria",
    "Inter",
    "PingFang SC",
    "Hiragino Sans GB",
    "Noto Sans CJK SC",
    "Noto Serif CJK SC",
    "WenQuanYi Micro Hei",
];

/// 字体下拉的一行（`free` = 清单外自由输入项，原型 `使用 "query"`）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FontItem {
    pub name: String,
    pub free: bool,
}

/// 字体清单 + 搜索排序（原型 `fontItems`）：当前值不在清单时并到最前；
/// startsWith 优先于 includes（各自保持原序）；query 无精确匹配时尾部追加自由输入行。
pub fn font_items(current: &str, query: &str) -> Vec<FontItem> {
    let base: Vec<&str> = if FONT_CANDIDATES.contains(&current) {
        FONT_CANDIDATES.to_vec()
    } else {
        std::iter::once(current)
            .chain(FONT_CANDIDATES.iter().copied())
            .collect()
    };
    let q = query.trim().to_lowercase();
    let mut items: Vec<FontItem> = if q.is_empty() {
        base.iter()
            .map(|name| FontItem {
                name: (*name).to_owned(),
                free: false,
            })
            .collect()
    } else {
        let mut scored: Vec<(usize, usize, &str)> = Vec::new(); // (rank, 原序, name)
        for (i, name) in base.iter().enumerate() {
            let l = name.to_lowercase();
            let rank = if l.starts_with(&q) {
                0
            } else if l.contains(&q) {
                1
            } else {
                continue;
            };
            scored.push((rank, i, name));
        }
        scored.sort_by_key(|(rank, i, _)| (*rank, *i));
        scored
            .into_iter()
            .map(|(_, _, name)| FontItem {
                name: name.to_owned(),
                free: false,
            })
            .collect()
    };
    let q_raw = query.trim();
    if !q_raw.is_empty() && !base.iter().any(|n| n.eq_ignore_ascii_case(q_raw)) {
        items.push(FontItem {
            name: q_raw.to_owned(),
            free: true,
        });
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections_cover_the_seven_contract_sections() {
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
    fn setting_defs_paths_are_unique_and_sectioned() {
        let mut paths: Vec<_> = SETTING_DEFS.iter().map(|d| d.path).collect();
        let n = paths.len();
        paths.sort_unstable();
        paths.dedup();
        assert_eq!(paths.len(), n, "path 不重复");
        for d in SETTING_DEFS {
            assert!(
                SETTING_DEFS
                    .iter()
                    .any(|x| x.section == d.section && x.path == d.path),
            );
            assert!(!d.label.is_empty() && !d.desc.is_empty() && !d.path.is_empty());
        }
        // 每个非列表分区都至少有一行 def
        for s in [
            Section::Notifications,
            Section::Terminal,
            Section::Appearance,
            Section::Advanced,
        ] {
            assert!(SETTING_DEFS.iter().any(|d| d.section == s), "{s:?} 缺 defs");
        }
    }

    #[test]
    fn match_def_hits_label_desc_and_path_case_insensitively() {
        let font = SETTING_DEFS
            .iter()
            .find(|d| d.path == "terminal.fontFamily")
            .unwrap();
        assert!(match_def(font, "字体"));
        assert!(match_def(font, "MONO"));
        assert!(match_def(font, "fontFamily"));
        assert!(!match_def(font, "scrollback"));
    }

    #[test]
    fn section_hits_counts_defs_keybindings_presets_and_acp() {
        let s = Settings::default();
        // 「字体」命中 terminal.fontFamily 的 label
        let hits = section_hits(&s, "字体");
        assert_eq!(
            hits[Section::ALL
                .iter()
                .position(|x| *x == Section::Terminal)
                .unwrap()],
            1
        );
        // 键位：label 命中（「设置」→ toggleSettings + focusSearch 两行的 label 都含「设置」）
        let hits = section_hits(&s, "设置");
        assert_eq!(
            hits[Section::ALL
                .iter()
                .position(|x| *x == Section::Keybindings)
                .unwrap()],
            2,
            "「打开 / 关闭设置」+「聚焦设置搜索」"
        );
        // 键位值命中（默认 ctrl-tab）
        let hits = section_hits(&s, "ctrl-tab");
        assert_eq!(
            hits[Section::ALL
                .iter()
                .position(|x| *x == Section::Keybindings)
                .unwrap()],
            1
        );
        // 预设名命中（默认内置 shell / pi / claude / codex / amp）
        let hits = section_hits(&s, "shell");
        assert!(
            hits[Section::ALL
                .iter()
                .position(|x| *x == Section::Presets)
                .unwrap()]
                >= 1
        );
        // ACP 命中（默认 codex / claude-code-acp）
        let hits = section_hits(&s, "codex");
        assert!(
            hits[Section::ALL
                .iter()
                .position(|x| *x == Section::AcpAgents)
                .unwrap()]
                >= 1
        );
        // 全无命中
        assert_eq!(section_hits(&s, "不存在的查询词zzz"), [0; 7]);
    }

    #[test]
    fn section_has_content_rules_match_the_prototype() {
        let s = Settings::default();
        assert!(
            section_has_content(Section::Presets, "zzznothing", &s),
            "列表分区恒有内容"
        );
        assert!(section_has_content(Section::AcpAgents, "zzznothing", &s));
        assert!(!section_has_content(Section::Terminal, "zzznothing", &s));
        assert!(section_has_content(Section::Terminal, "字号", &s));
        // notifications 的约定卡命中
        assert!(section_has_content(
            Section::Notifications,
            "AMP_FORCE_BEL",
            &s
        ));
        assert!(section_has_content(Section::Notifications, "bel", &s));
        // keybindings 只看行命中
        assert!(section_has_content(Section::Keybindings, "esc", &s));
        assert!(!section_has_content(Section::Keybindings, "zzznothing", &s));
    }

    #[test]
    fn convention_matches_title_and_entries() {
        assert!(convention_matches("osc"));
        assert!(convention_matches("zed-bell"));
        assert!(!convention_matches("zzznothing"));
    }

    #[test]
    fn hl_range_returns_first_case_insensitive_hit() {
        assert_eq!(hl_range("桌面通知", "桌面"), Some(0.."桌面".len()));
        assert_eq!(
            hl_range("AbcDef", "cde"),
            Some(2..5),
            "Ab|cDe|f：命中段保持原文大小写"
        );
        assert_eq!(hl_range("字号", ""), None);
        assert_eq!(hl_range("字号", "  "), None, "空白 query 视为未搜索");
        assert_eq!(hl_range("回滚行数", "palette"), None);
        // 区间两端必须是 char 边界（中文多字节）
        let r = hl_range("回滚行数大小", "滚行").unwrap();
        assert!("回滚行数大小"[r.clone()].contains("滚行"));
    }

    #[test]
    fn font_items_ranks_prefix_before_contains_and_appends_freeform() {
        // JetBrains Mono（前缀）在 Fira… 命中（包含）之前不需要——名字顺序不同；
        // 直接验证排序语义：jet 前缀项先于 mono 包含项
        let items = font_items("Menlo", "jet");
        assert_eq!(items[0].name, "JetBrains Mono");
        assert!(items.iter().all(|i| i.name.to_lowercase().contains("jet")));
        assert!(
            items.iter().position(|i| i.name == "Monaco").is_none(),
            "不含 jet 的不出现"
        );

        // 自由输入：query 无精确匹配时追加
        let items = font_items("Menlo", "MyCustom");
        let last = items.last().unwrap();
        assert!(last.free);
        assert_eq!(last.name, "MyCustom");

        // query 与清单项精确相等时不追加 free 行
        let items = font_items("Menlo", "menlo");
        assert!(items.iter().all(|i| !i.free));
        assert_eq!(items[0].name, "Menlo");

        // 当前值不在清单 → 并到最前（仍可搜索/选中）
        let items = font_items("Zed Mono", "");
        assert_eq!(items[0].name, "Zed Mono");
        assert!(!items[0].free);
        assert_eq!(items.len(), FONT_CANDIDATES.len() + 1);

        // 空 query：全量清单
        let items = font_items("Menlo", "");
        assert_eq!(items.len(), FONT_CANDIDATES.len());
        assert!(!items.iter().any(|i| i.free));
    }
}
