//! 「新建会话」弹窗的数据模型（对应旧 `dialogs/ToolDialog.tsx` 里的规则部分）。
//!
//! 纯数据：输入 = settings 里的预设 / ACP agent + 当前选中的工作区 + 筛选串；
//! 输出 = 分组后的行（每行带"选中后要做什么"的 [`Pick`]）。视图只负责画和把点击翻译成 `Pick`。
//!
//! 规则（旧实现与其测试的共同约定）：
//! - 分组：AI 编程 = 非 `shell` 预设；终端工具 = `shell`；对话 = New Chat + ACP agent；
//! - **New Chat 需要归属工作区**（没有工作区上下文时不出现）；**ACP 行不受归属约束**（未归属也列）；
//! - 筛选：label / program / initCommand / args 子串，不区分大小写；空串 = 全部命中；
//! - 临时入口（`initial_workspace == ""`）：工作区下拉首项为「（未归属 · 临时会话）」，且**不回退首个工作区**，
//!   否则临时入口会误归属（旧缺陷 D06）。

use crate::presets::TerminalPreset;
use crate::settings::AcpAgent;
use crate::threads::Workspace;

/// 选中一行后要做的事。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pick {
    SpawnPreset {
        preset_id: String,
        workspace_id: Option<String>,
    },
    NewChat {
        workspace_id: String,
    },
    NewAcp {
        agent_id: String,
        label: String,
        workspace_id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowIcon {
    Agent,
    Terminal,
    Chat,
    Acp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRow {
    pub id: String,
    pub icon: RowIcon,
    pub name: String,
    pub description: Option<String>,
    /// 右侧命令徽章（mono）
    pub command: String,
    /// 「默认」徽章：pi 是推荐预设
    pub recommended: bool,
    pub pick: Pick,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub label: &'static str,
    pub rows: Vec<ToolRow>,
}

/// 工作区下拉的一项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceOption {
    /// 空串 = 未归属临时会话
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Model {
    pub workspace_options: Vec<WorkspaceOption>,
    /// 当前选中工作区的目录；无 → 视图显示「（无项目目录）」
    pub cwd: Option<String>,
    pub groups: Vec<Group>,
    /// 筛选后一行都没有 → 视图显示空态提示
    pub empty: bool,
}

/// 命令摘要：`program args…`，否则 `initCommand`，否则空。
fn command_of(p: &TerminalPreset) -> String {
    let mut parts: Vec<&str> = p.program.iter().map(String::as_str).collect();
    parts.extend(p.args.iter().flatten().map(String::as_str));
    let joined = parts.join(" ");
    if joined.is_empty() {
        p.init_command.clone().unwrap_or_default()
    } else {
        joined
    }
}

/// ACP agent 的命令摘要（命令 + 参数一行）。
pub fn acp_command_summary(a: &AcpAgent) -> String {
    std::iter::once(a.command.as_str())
        .chain(a.args.iter().map(String::as_str))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn build(
    presets: &[TerminalPreset],
    acp_agents: &[AcpAgent],
    workspaces: &[Workspace],
    initial_workspace: &str,
    selected_workspace: &str,
    filter: &str,
) -> Model {
    let q = filter.trim().to_lowercase();
    let hit = |xs: &[Option<&str>]| {
        q.is_empty() || xs.iter().flatten().any(|x| x.to_lowercase().contains(&q))
    };

    let include_temp = initial_workspace.is_empty();
    let mut workspace_options: Vec<WorkspaceOption> = vec![];
    if include_temp {
        workspace_options.push(WorkspaceOption {
            value: String::new(),
            label: "（未归属 · 临时会话）".into(),
        });
    }
    workspace_options.extend(workspaces.iter().map(|w| WorkspaceOption {
        value: w.id.clone(),
        label: w.name.clone(),
    }));

    let workspace = workspaces.iter().find(|w| w.id == selected_workspace);
    let ws_id = workspace.map(|w| w.id.clone());

    let preset_hit = |p: &&TerminalPreset| {
        let mut xs: Vec<Option<&str>> = vec![
            Some(&p.label),
            p.program.as_deref(),
            p.init_command.as_deref(),
        ];
        xs.extend(p.args.iter().flatten().map(|a| Some(a.as_str())));
        hit(&xs)
    };
    let shown: Vec<&TerminalPreset> = presets.iter().filter(preset_hit).collect();
    let agents: Vec<&AcpAgent> = acp_agents
        .iter()
        .filter(|a| {
            let mut xs: Vec<Option<&str>> = vec![Some(&a.label), Some(&a.command)];
            xs.extend(a.args.iter().map(|x| Some(x.as_str())));
            hit(&xs)
        })
        .collect();

    let preset_row = |p: &TerminalPreset, icon| ToolRow {
        id: format!("preset-{}", p.id),
        icon,
        name: p.label.clone(),
        description: p.description.clone(),
        command: command_of(p),
        recommended: p.id == "pi",
        pick: Pick::SpawnPreset {
            preset_id: p.id.clone(),
            workspace_id: ws_id.clone(),
        },
    };

    let mut groups = vec![];
    let agent_rows: Vec<ToolRow> = shown
        .iter()
        .filter(|p| p.id != "shell")
        .map(|p| preset_row(p, RowIcon::Agent))
        .collect();
    if !agent_rows.is_empty() {
        groups.push(Group {
            label: "AI 编程",
            rows: agent_rows,
        });
    }
    let term_rows: Vec<ToolRow> = shown
        .iter()
        .filter(|p| p.id == "shell")
        .map(|p| preset_row(p, RowIcon::Terminal))
        .collect();
    if !term_rows.is_empty() {
        groups.push(Group {
            label: "终端工具",
            rows: term_rows,
        });
    }

    // 「对话」组：New Chat 需要归属（旧 `workspace != null`）；ACP 不受约束。
    // 注意旧实现里 New Chat 行**不受筛选影响**（始终在场）——保持。
    let mut chat_rows = vec![];
    if let Some(w) = workspace {
        chat_rows.push(ToolRow {
            id: "new-chat".into(),
            icon: RowIcon::Chat,
            name: "New Chat".into(),
            description: Some("应用内对话面（非终端）".into()),
            command: String::new(),
            recommended: false,
            pick: Pick::NewChat {
                workspace_id: w.id.clone(),
            },
        });
    }
    chat_rows.extend(agents.iter().map(|a| ToolRow {
        id: format!("new-acp-{}", a.id),
        icon: RowIcon::Acp,
        name: a.label.clone(),
        description: Some("ACP agent".into()),
        command: acp_command_summary(a),
        recommended: false,
        pick: Pick::NewAcp {
            agent_id: a.id.clone(),
            label: a.label.clone(),
            workspace_id: ws_id.clone(),
        },
    }));
    if !chat_rows.is_empty() {
        groups.push(Group {
            label: "对话",
            rows: chat_rows,
        });
    }

    // 空态只看"预设与 ACP 都被筛光"，与旧实现一致（New Chat 不计入）
    let empty = shown.is_empty() && agents.is_empty();
    Model {
        workspace_options,
        cwd: workspace.map(|w| w.path.clone()),
        groups,
        empty,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presets::builtin_presets;
    use crate::settings::Settings;
    use crate::threads::default_workspace;

    fn ws(id: &str, name: &str, path: &str) -> Workspace {
        Workspace {
            name: name.into(),
            ..default_workspace(id.into(), path, 0)
        }
    }
    fn defaults() -> (Vec<TerminalPreset>, Vec<AcpAgent>) {
        let s = Settings::default();
        (s.presets.items, s.acp_agents)
    }
    fn labels(m: &Model) -> Vec<&'static str> {
        m.groups.iter().map(|g| g.label).collect()
    }
    fn names(m: &Model, label: &str) -> Vec<String> {
        m.groups
            .iter()
            .find(|g| g.label == label)
            .map(|g| g.rows.iter().map(|r| r.name.clone()).collect())
            .unwrap_or_default()
    }

    #[test]
    fn groups_agent_presets_the_shell_and_chat_with_acp() {
        let (p, a) = defaults();
        let m = build(&p, &a, &[ws("w1", "alpha", "/a")], "w1", "w1", "");
        assert_eq!(labels(&m), ["AI 编程", "终端工具", "对话"]);
        assert_eq!(names(&m, "AI 编程"), ["Pi", "Claude Code", "Codex", "Amp"]);
        assert_eq!(names(&m, "终端工具"), ["Shell"]);
        assert_eq!(
            names(&m, "对话"),
            ["New Chat", "Pi (ACP)", "Codex (ACP)", "Claude (ACP)"]
        );
        assert!(!m.empty);
    }

    #[test]
    fn only_pi_is_recommended() {
        let (p, a) = defaults();
        let m = build(&p, &a, &[ws("w1", "alpha", "/a")], "w1", "w1", "");
        let rec: Vec<_> = m
            .groups
            .iter()
            .flat_map(|g| &g.rows)
            .filter(|r| r.recommended)
            .map(|r| r.name.as_str())
            .collect();
        assert_eq!(rec, ["Pi"]);
    }

    #[test]
    fn command_badge_prefers_program_with_args_then_init_command() {
        let (p, a) = defaults();
        let m = build(&p, &a, &[ws("w1", "alpha", "/a")], "w1", "w1", "");
        let cmd = |name: &str| {
            m.groups
                .iter()
                .flat_map(|g| &g.rows)
                .find(|r| r.name == name)
                .unwrap()
                .command
                .clone()
        };
        assert_eq!(cmd("Amp"), "amp", "有 program → program");
        assert_eq!(cmd("Claude Code"), "claude", "无 program → initCommand");
        assert_eq!(cmd("Shell"), "", "都没有 → 空");
        assert_eq!(cmd("Pi (ACP)"), "pi-acp");
        assert_eq!(cmd("Codex (ACP)"), "codex --acp");
    }

    #[test]
    fn picking_a_preset_carries_the_selected_workspace() {
        let (p, a) = defaults();
        let m = build(
            &p,
            &a,
            &[ws("w1", "alpha", "/a"), ws("w2", "beta", "/b")],
            "w1",
            "w2",
            "",
        );
        let shell = m
            .groups
            .iter()
            .flat_map(|g| &g.rows)
            .find(|r| r.name == "Shell")
            .unwrap();
        assert_eq!(
            shell.pick,
            Pick::SpawnPreset {
                preset_id: "shell".into(),
                workspace_id: Some("w2".into())
            }
        );
        assert_eq!(m.cwd.as_deref(), Some("/b"), "cwd 随所选工作区");
    }

    #[test]
    fn a_temporary_entry_lists_the_unattached_option_first_and_does_not_fall_back_to_the_first_workspace()
     {
        let (p, a) = defaults();
        let m = build(
            &p,
            &a,
            &[ws("w1", "alpha", "/a"), ws("w2", "beta", "/b")],
            "",
            "",
            "",
        );
        assert_eq!(
            m.workspace_options[0],
            WorkspaceOption {
                value: String::new(),
                label: "（未归属 · 临时会话）".into()
            }
        );
        assert_eq!(m.workspace_options.len(), 3);
        assert_eq!(m.cwd, None, "无项目目录");
        let shell = m
            .groups
            .iter()
            .flat_map(|g| &g.rows)
            .find(|r| r.name == "Shell")
            .unwrap();
        assert_eq!(
            shell.pick,
            Pick::SpawnPreset {
                preset_id: "shell".into(),
                workspace_id: None
            },
            "不回退 workspaces[0]（旧缺陷 D06）"
        );
    }

    #[test]
    fn new_chat_needs_a_workspace_but_acp_does_not() {
        let (p, a) = defaults();
        let m = build(&p, &a, &[ws("w1", "alpha", "/a")], "", "", "");
        assert_eq!(
            names(&m, "对话"),
            ["Pi (ACP)", "Codex (ACP)", "Claude (ACP)"],
            "未归属：无 New Chat，ACP 仍列"
        );
        let acp = m.groups.iter().find(|g| g.label == "对话").unwrap().rows[0].clone();
        assert_eq!(
            acp.pick,
            Pick::NewAcp {
                agent_id: "acp-pi".into(),
                label: "Pi (ACP)".into(),
                workspace_id: None
            }
        );
    }

    #[test]
    fn the_workspace_option_list_has_no_temp_entry_when_opened_from_a_workspace() {
        let (p, a) = defaults();
        let m = build(&p, &a, &[ws("w1", "alpha", "/a")], "w1", "w1", "");
        assert_eq!(
            m.workspace_options,
            [WorkspaceOption {
                value: "w1".into(),
                label: "alpha".into()
            }]
        );
    }

    #[test]
    fn filter_matches_label_program_init_command_and_args_case_insensitively() {
        let (mut p, a) = defaults();
        p.push(TerminalPreset {
            id: "x".into(),
            label: "Custom".into(),
            description: None,
            builtin: false,
            program: Some("pwsh".into()),
            args: Some(vec!["-NoLogo".into()]),
            env: None,
            init_command: None,
            cwd: None,
            category: None,
        });
        let w = [ws("w1", "alpha", "/a")];
        let ids = |q: &str| -> Vec<String> {
            build(&p, &a, &w, "w1", "w1", q)
                .groups
                .iter()
                .flat_map(|g| g.rows.iter().map(|r| r.name.clone()))
                .filter(|n| n != "New Chat")
                .collect()
        };
        assert_eq!(
            ids("CLAUDE"),
            ["Claude Code", "Claude (ACP)"],
            "label，且 ACP 也被筛"
        );
        assert_eq!(ids("pwsh"), ["Custom"], "program");
        assert_eq!(ids("nologo"), ["Custom"], "args");
        assert_eq!(
            ids("codex"),
            ["Codex", "Codex (ACP)"],
            "initCommand / label"
        );
        assert!(ids("zzz-no-such").is_empty());
    }

    #[test]
    fn a_blank_filter_matches_everything_and_whitespace_is_trimmed() {
        let (p, a) = defaults();
        let w = [ws("w1", "alpha", "/a")];
        let all = build(&p, &a, &w, "w1", "w1", "")
            .groups
            .iter()
            .map(|g| g.rows.len())
            .sum::<usize>();
        assert_eq!(
            build(&p, &a, &w, "w1", "w1", "   ")
                .groups
                .iter()
                .map(|g| g.rows.len())
                .sum::<usize>(),
            all
        );
    }

    #[test]
    fn filtered_to_nothing_is_empty_but_new_chat_alone_does_not_count() {
        let (p, a) = defaults();
        let m = build(
            &p,
            &a,
            &[ws("w1", "alpha", "/a")],
            "w1",
            "w1",
            "zzz-no-such",
        );
        assert!(m.empty, "预设与 ACP 都被筛光 → 空态");
        assert_eq!(labels(&m), ["对话"], "New Chat 不受筛选影响，仍在场");
        assert_eq!(names(&m, "对话"), ["New Chat"]);
    }

    #[test]
    fn groups_with_no_rows_are_omitted() {
        let (p, a) = defaults();
        // 筛 "shell"：只剩 Shell 预设（终端工具组）；ACP agent 的 label/command 都不含 shell；New Chat 不受筛选 → 对话组仍在
        let m = build(&p, &a, &[ws("w1", "alpha", "/a")], "w1", "w1", "shell");
        assert_eq!(labels(&m), ["终端工具", "对话"]);
        assert_eq!(
            names(&m, "对话"),
            ["New Chat"],
            "ACP 行被筛掉，只剩 New Chat"
        );
        assert!(
            !labels(&m).contains(&"AI 编程"),
            "AI 编程组没有命中行 → 整组不出现"
        );
    }

    #[test]
    fn builtin_presets_are_all_reachable_without_a_filter() {
        let (_, a) = defaults();
        let m = build(&builtin_presets(), &a, &[], "", "", "");
        let n = m
            .groups
            .iter()
            .filter(|g| g.label != "对话")
            .map(|g| g.rows.len())
            .sum::<usize>();
        assert_eq!(n, 5);
    }
}
