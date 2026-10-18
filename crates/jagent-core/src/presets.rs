//! 终端预设：类型 + 五个内置预设（对应旧 `threads/presets.ts`）。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PresetCategory {
    /// AI 编程
    Agent,
    /// 终端工具
    Tool,
}

/// 终端预设。可选字段为 `None` 时不写入 JSON（旧 TS 里是 `undefined`，JSON 里不留 `""` / `[]`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalPreset {
    /// 内置固定为 claude/pi/codex/amp/shell；自定义任意唯一串
    pub id: String,
    pub label: String,
    /// 新建会话弹窗行第二行
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 内置或自定义预设（均可删除、可拖拽排序；id 不可改；复制内置 → builtin:false）
    pub builtin: bool,
    /// 留空 = 系统默认 shell
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// BTreeMap：序列化键序稳定
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    /// 作为普通键入打进 shell，不是 exec
    #[serde(
        default,
        rename = "initCommand",
        skip_serializing_if = "Option::is_none"
    )]
    pub init_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<PresetCategory>,
}

impl TerminalPreset {
    fn builtin(id: &str, label: &str, description: &str, category: PresetCategory) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            description: Some(description.into()),
            builtin: true,
            program: None,
            args: None,
            env: None,
            init_command: None,
            cwd: None,
            category: Some(category),
        }
    }

    /// 空串 / 空集合字段归一为 `None`；`args` 顺带过滤空串行。
    /// 编辑中间态的空行不进 JSON，归一在此单点完成。
    pub fn normalized(mut self) -> Self {
        fn non_empty(s: Option<String>) -> Option<String> {
            s.filter(|v| !v.is_empty())
        }
        self.args = self
            .args
            .map(|a| a.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>())
            .filter(|a| !a.is_empty());
        self.env = self.env.filter(|e| !e.is_empty());
        self.program = non_empty(self.program);
        self.init_command = non_empty(self.init_command);
        self.cwd = non_empty(self.cwd);
        self
    }

    /// 内置预设被改过（modified 蓝点 / reset 钮出现条件；自定义无出厂值恒 false）
    pub fn is_modified(&self) -> bool {
        self.builtin && builtin_preset(&self.id).is_none_or(|f| *self != f)
    }
}

/// 五个内置预设。
pub fn builtin_presets() -> Vec<TerminalPreset> {
    use PresetCategory::{Agent, Tool};
    let mut pi = TerminalPreset::builtin("pi", "Pi", "在项目中对话、读写代码、调用工具", Agent);
    pi.init_command = Some("pi".into());
    let mut claude = TerminalPreset::builtin(
        "claude",
        "Claude Code",
        "使用 Claude Code 的终端界面",
        Agent,
    );
    claude.init_command = Some("claude".into());
    let mut codex = TerminalPreset::builtin("codex", "Codex", "使用 Codex CLI 的终端界面", Agent);
    codex.init_command = Some("codex".into());
    let mut amp = TerminalPreset::builtin("amp", "Amp", "使用 Amp 的终端界面", Agent);
    amp.program = Some("amp".into());
    amp.env = Some(BTreeMap::from([("AMP_FORCE_BEL".into(), "1".into())]));
    let shell = TerminalPreset::builtin("shell", "Shell", "运行命令、脚本和开发服务", Tool);
    vec![pi, claude, codex, amp, shell]
}

pub fn builtin_preset(id: &str) -> Option<TerminalPreset> {
    builtin_presets().into_iter().find(|p| p.id == id)
}

/// 预设行命令摘要：`program args… → initCommand`；无 program 显示「系统默认 shell」。
pub fn preset_command_summary(p: &TerminalPreset) -> String {
    match (&p.program, &p.init_command) {
        (None, Some(init)) => format!("（shell）→ {init}"),
        (None, None) => "（系统默认 shell）".into(),
        (Some(prog), init) => {
            let mut cmd = prog.clone();
            for a in p.args.iter().flatten() {
                cmd.push(' ');
                cmd.push_str(a);
            }
            match init {
                Some(i) => format!("{cmd}  →  {i}"),
                None => cmd,
            }
        }
    }
}

/// 搜索命中：label / id / program / initCommand 子串（不区分大小写）。
pub fn preset_matches(p: &TerminalPreset, q: &str) -> bool {
    let q = q.to_lowercase();
    let has = |s: &str| s.to_lowercase().contains(&q);
    has(&p.label)
        || has(&p.id)
        || p.program.as_deref().is_some_and(has)
        || p.init_command.as_deref().is_some_and(has)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn five_builtin_presets_in_order() {
        let ids: Vec<_> = builtin_presets().into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["pi", "claude", "codex", "amp", "shell"]);
        assert!(builtin_presets().iter().all(|p| p.builtin));
    }

    #[test]
    fn amp_forces_bel_and_shell_is_a_tool() {
        let amp = builtin_preset("amp").unwrap();
        assert_eq!(amp.program.as_deref(), Some("amp"));
        assert_eq!(amp.env.as_ref().unwrap()["AMP_FORCE_BEL"], "1");
        assert_eq!(
            builtin_preset("shell").unwrap().category,
            Some(PresetCategory::Tool)
        );
    }

    #[test]
    fn command_summary_matches_prototype() {
        let shell = builtin_preset("shell").unwrap();
        assert_eq!(preset_command_summary(&shell), "（系统默认 shell）");
        let claude = builtin_preset("claude").unwrap();
        assert_eq!(preset_command_summary(&claude), "（shell）→ claude");
        let mut p = claude.clone();
        p.program = Some("pwsh".into());
        p.args = Some(vec!["-NoLogo".into(), "-l".into()]);
        assert_eq!(preset_command_summary(&p), "pwsh -NoLogo -l  →  claude");
        p.init_command = None;
        assert_eq!(preset_command_summary(&p), "pwsh -NoLogo -l");
    }

    #[test]
    fn matches_label_id_program_and_init_command_case_insensitively() {
        let amp = builtin_preset("amp").unwrap();
        assert!(preset_matches(&amp, "AMP"));
        assert!(preset_matches(
            &builtin_preset("claude").unwrap(),
            "claude code"
        ));
        assert!(preset_matches(&builtin_preset("codex").unwrap(), "COD")); // id/label/initCommand
        assert!(!preset_matches(&amp, "zzz"));
    }

    #[test]
    fn modified_is_false_for_factory_and_custom_true_for_edited_builtin() {
        let mut p = builtin_preset("claude").unwrap();
        assert!(!p.is_modified());
        p.label = "我的 Claude".into();
        assert!(p.is_modified());
        let mut custom = p.clone();
        custom.builtin = false;
        assert!(!custom.is_modified(), "自定义预设无出厂值，恒 false");
    }

    #[test]
    fn normalize_drops_empty_strings_collections_and_blank_arg_lines() {
        let mut p = builtin_preset("shell").unwrap();
        p.builtin = false;
        p.program = Some(String::new());
        p.args = Some(vec!["NoLogo".into(), String::new(), "NoPrompt".into()]);
        p.env = Some(BTreeMap::new());
        p.init_command = Some(String::new());
        p.cwd = Some(String::new());
        let n = p.clone().normalized();
        assert_eq!(n.program, None);
        assert_eq!(n.args, Some(vec!["NoLogo".into(), "NoPrompt".into()]));
        assert_eq!(n.env, None);
        assert_eq!(n.init_command, None);
        assert_eq!(n.cwd, None);

        p.args = Some(vec![String::new()]);
        assert_eq!(p.normalized().args, None, "全是空行 → None");
    }

    #[test]
    fn serialization_omits_none_fields_and_uses_camel_case_init_command() {
        let v = serde_json::to_value(builtin_preset("claude").unwrap()).unwrap();
        let o = v.as_object().unwrap();
        assert_eq!(o["initCommand"], "claude");
        assert!(!o.contains_key("program") && !o.contains_key("args") && !o.contains_key("env"));
        assert_eq!(o["category"], "agent");
    }
}
