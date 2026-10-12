//! SettingsStore：内存即时更新 + 合并写 + 失败回滚。
//!
//! 与旧 TS 的差异（语义保持，机制不同）：旧版 `patch` 内部排 Promise 写链，并用 `gen` 计数合并；
//! 纯逻辑层没有异步运行时，所以改成显式两步：
//!   1. `patch`/CRUD：内存即时更新，只**标记待写**（连续多次只留最后一个全量快照 = 合并写）；
//!   2. `flush`：落盘一次；失败则内存回滚到最后一次确认落盘的快照，并置 `write_error`。
//!
//! gpui 侧在后台任务（或下一帧）里调 `flush`。这样"合并写 / 失败回滚"都能确定性地测试。

use serde_json::Value;

use super::file::FileAdapter;
use super::schema::{AcpAgent, Settings, parse_settings, reparse, serialize_settings};
use crate::presets::{TerminalPreset, builtin_preset};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteError {
    pub path: String,
    pub message: String,
}

/// 新预设输入（id 由 store 生成保证唯一；builtin 恒 false）。
#[derive(Debug, Clone, Default)]
pub struct PresetInput {
    pub label: String,
    pub program: Option<String>,
    pub args: Option<Vec<String>>,
    pub init_command: Option<String>,
    pub cwd: Option<String>,
}

/// 预设字段补丁（id / builtin 不可改——类型面即规则）。外层 `Option` = 是否修改，
/// 内层 `Option` = 修改后的值（`Some(None)` 或空串都会被归一为"清除"）。
#[derive(Debug, Clone, Default)]
pub struct PresetPatch {
    pub label: Option<String>,
    pub description: Option<Option<String>>,
    pub program: Option<Option<String>>,
    pub args: Option<Option<Vec<String>>>,
    pub env: Option<Option<std::collections::BTreeMap<String, String>>>,
    pub init_command: Option<Option<String>>,
    pub cwd: Option<Option<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct AcpAgentInput {
    pub label: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct AcpAgentPatch {
    pub label: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
}

pub struct SettingsStore<F: FileAdapter> {
    file: F,
    settings: Settings,
    /// 最后确认落盘成功的快照（写失败回滚锚点）。
    persisted: Settings,
    /// 待写：内存快照与触发它的 path（失败时 `write_error.path` 用）。
    pending: Option<String>,
    write_error: Option<WriteError>,
    /// 单调 id 种子：`custom-<n>` / `acp-<n>`，代替旧版的 `Date.now().toString(36)`，便于确定性测试。
    id_seq: u64,
    /// 订阅者收到的通知次数（`subscribe` 的轻量替身，见 `revision`）。
    revision: u64,
}

impl<F: FileAdapter> SettingsStore<F> {
    /// 装配期：读盘 + 解析 + 首帧值。文件不存在 → 默认且不写盘；坏 JSON → 整体默认。
    pub fn init(file: F) -> std::io::Result<Self> {
        let settings = match file.read()? {
            None => Settings::default(),
            Some(raw) => parse_settings(&raw),
        };
        Ok(Self {
            file,
            persisted: settings.clone(),
            settings,
            pending: None,
            write_error: None,
            id_seq: 0,
            revision: 0,
        })
    }

    pub fn get(&self) -> &Settings {
        &self.settings
    }

    pub fn file_path(&self) -> Option<&std::path::Path> {
        self.file.path()
    }

    pub fn write_error(&self) -> Option<&WriteError> {
        self.write_error.as_ref()
    }

    /// Test seam: inject a single adapter write failure when supported.
    pub fn fail_next_write_for_test(&self, message: &str) -> bool {
        self.file.fail_next_write(message)
    }

    /// 每次对外可见的状态变化（含失败回滚、writeError 变化）自增；视图 `observe` 用它判断是否需要重绘。
    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn has_pending_write(&self) -> bool {
        self.pending.is_some()
    }

    fn bump(&mut self) {
        self.revision += 1;
    }

    /// 统一提交面：容错解析 → 内存即时 → 标记待写（patch 与 CRUD 共用）。
    fn commit(&mut self, next: Settings, path: &str) {
        self.settings = reparse(&next);
        self.write_error = None;
        self.pending = Some(path.to_owned());
        self.bump();
    }

    /// 内存即时 + 标记待写。越界值经容错解析回默认。路径不存在则忽略。
    pub fn patch(&mut self, path: &str, value: Value) {
        if let Some(next) = self.settings.with_path(path, value) {
            self.commit(next, path);
        }
    }

    /// = patch(path, 默认值)
    pub fn reset(&mut self, path: &str) {
        if let Some(d) = Settings::default().get_path(path) {
            self.patch(path, d);
        }
    }

    /// 与默认值不同 → 蓝点。
    pub fn is_modified(&self, path: &str) -> bool {
        self.settings.get_path(path) != Settings::default().get_path(path)
    }

    /// 落盘一次（合并写：不论之前 patch 了多少次，只写当前全量快照一次）。
    /// 失败 → 内存回滚到 `persisted`，置 `write_error`。成功 → 清除 `write_error`。
    pub fn flush(&mut self) {
        let Some(path) = self.pending.take() else {
            return;
        };
        match self.file.write(&serialize_settings(&self.settings)) {
            Ok(()) => {
                self.persisted = self.settings.clone();
                // 仅在确有错误时清除并通知（避免每次成功写的无效通知）
                if self.write_error.take().is_some() {
                    self.bump();
                }
            }
            Err(e) => {
                self.settings = self.persisted.clone();
                self.write_error = Some(WriteError {
                    path,
                    message: e.to_string(),
                });
                self.bump();
            }
        }
    }

    fn next_id(&mut self, prefix: &str, taken: impl Fn(&str) -> bool) -> String {
        loop {
            self.id_seq += 1;
            let id = format!("{prefix}-{}", self.id_seq);
            if !taken(&id) {
                return id;
            }
        }
    }

    // ── 预设 CRUD（规则单点；走同一写链 / 回滚面）─────────────────────

    /// 新增自定义预设（builtin:false），返回生成的唯一 id。
    pub fn add_preset(&mut self, input: PresetInput) -> String {
        let cur = self.settings.clone();
        let id = self.next_id("custom", |id| cur.presets.items.iter().any(|p| p.id == id));
        let preset = TerminalPreset {
            id: id.clone(),
            label: input.label,
            description: None,
            builtin: false,
            program: input.program,
            args: input.args,
            env: None,
            init_command: input.init_command,
            cwd: input.cwd,
            category: None,
        }
        .normalized();
        let mut items = cur.presets.items.clone();
        items.push(preset);
        self.with_items(cur, items, None);
        id
    }

    /// 按 id 改字段（未知 id no-op；空字段归一为 None）。
    pub fn update_preset(&mut self, id: &str, patch: PresetPatch) {
        let cur = self.settings.clone();
        let Some(idx) = cur.presets.items.iter().position(|p| p.id == id) else {
            return;
        };
        let mut items = cur.presets.items.clone();
        let p = &mut items[idx];
        if let Some(v) = patch.label {
            p.label = v;
        }
        if let Some(v) = patch.description {
            p.description = v;
        }
        if let Some(v) = patch.program {
            p.program = v;
        }
        if let Some(v) = patch.args {
            p.args = v;
        }
        if let Some(v) = patch.env {
            p.env = v;
        }
        if let Some(v) = patch.init_command {
            p.init_command = v;
        }
        if let Some(v) = patch.cwd {
            p.cwd = v;
        }
        items[idx] = items[idx].clone().normalized();
        self.with_items(cur, items, None);
    }

    /// 删除自定义预设（内置 no-op）；plusDefault 指向它 → 回退 null。
    pub fn delete_preset(&mut self, id: &str) {
        let cur = self.settings.clone();
        let Some(p) = cur.presets.items.iter().find(|p| p.id == id) else {
            return;
        };
        if p.builtin {
            return;
        }
        let items = cur
            .presets
            .items
            .iter()
            .filter(|p| p.id != id)
            .cloned()
            .collect();
        let plus = (cur.presets.plus_default.as_deref() == Some(id)).then_some(None);
        self.with_items(cur, items, plus);
    }

    /// 复制为自定义副本（builtin:false + label 副本后缀），返回新 id；源不存在返回空串。
    pub fn duplicate_preset(&mut self, id: &str) -> String {
        let cur = self.settings.clone();
        let Some(src) = cur.presets.items.iter().find(|p| p.id == id) else {
            return String::new();
        };
        // 递增后缀保证唯一：base → base2 → base3 …（原型语义）
        let base = format!("{id}-copy");
        let mut nid = base.clone();
        let mut n = 2;
        while cur.presets.items.iter().any(|p| p.id == nid) {
            nid = format!("{base}{n}");
            n += 1;
        }
        let mut copy = src.clone();
        copy.id = nid.clone();
        copy.label = format!("{} 副本", src.label);
        copy.builtin = false;
        let mut items = cur.presets.items.clone();
        items.push(copy.normalized());
        self.with_items(cur, items, None);
        nid
    }

    /// 内置预设重置回出厂值（自定义 / 未知 id no-op）。
    pub fn reset_preset(&mut self, id: &str) {
        let cur = self.settings.clone();
        let Some(idx) = cur.presets.items.iter().position(|p| p.id == id) else {
            return;
        };
        if !cur.presets.items[idx].builtin {
            return;
        }
        let Some(factory) = builtin_preset(id) else {
            return;
        };
        let mut items = cur.presets.items.clone();
        items[idx] = factory;
        self.with_items(cur, items, None);
    }

    /// `plus`：`None` = 不动 plusDefault；`Some(v)` = 设为 v。
    fn with_items(
        &mut self,
        cur: Settings,
        items: Vec<TerminalPreset>,
        plus: Option<Option<String>>,
    ) {
        let mut next = cur;
        next.presets.items = items;
        if let Some(v) = plus {
            next.presets.plus_default = v;
        }
        self.commit(next, "presets.items");
    }

    // ── ACP agent CRUD（同写链 / 回滚面；无 builtin / modified 概念）──

    /// 新增 agent（默认 2 项也只是可删改的示例），返回生成的唯一 id。
    pub fn add_acp_agent(&mut self, input: AcpAgentInput) -> String {
        let cur = self.settings.clone();
        let id = self.next_id("acp-x", |id| cur.acp_agents.iter().any(|a| a.id == id));
        let agent = normalize_acp(AcpAgent {
            id: id.clone(),
            label: input.label,
            command: input.command.unwrap_or_default(),
            args: input.args.unwrap_or_default(),
        });
        let mut next = cur;
        next.acp_agents.push(agent);
        self.commit(next, "acpAgents");
        id
    }

    /// 按 id 改字段（未知 id no-op；args 空串行过滤）。
    pub fn update_acp_agent(&mut self, id: &str, patch: AcpAgentPatch) {
        let cur = self.settings.clone();
        let Some(idx) = cur.acp_agents.iter().position(|a| a.id == id) else {
            return;
        };
        let mut next = cur;
        let a = &mut next.acp_agents[idx];
        if let Some(v) = patch.label {
            a.label = v;
        }
        if let Some(v) = patch.command {
            a.command = v;
        }
        if let Some(v) = patch.args {
            a.args = v;
        }
        next.acp_agents[idx] = normalize_acp(next.acp_agents[idx].clone());
        self.commit(next, "acpAgents");
    }

    pub fn delete_acp_agent(&mut self, id: &str) {
        let mut next = self.settings.clone();
        next.acp_agents.retain(|a| a.id != id);
        self.commit(next, "acpAgents");
    }
}

/// args 空串行过滤（编辑中间态空行不进 JSON）；command 空串保留
/// （保存后 spawn 会在首条消息时报错行——可见可修，不阻断编辑）。
fn normalize_acp(mut a: AcpAgent) -> AcpAgent {
    a.args.retain(|s| !s.is_empty());
    a
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::settings::file::MemoryAdapter;
    use crate::settings::schema::default_terminal_font;

    fn make(initial: Option<&str>) -> (SettingsStore<MemoryAdapter>, MemoryAdapter) {
        let file = MemoryAdapter::new(initial);
        (SettingsStore::init(file.clone()).unwrap(), file)
    }

    fn disk(file: &MemoryAdapter) -> Value {
        serde_json::from_str(&file.snapshot().expect("已落盘")).unwrap()
    }

    // ── patch / isModified / reset ─────────────────────────────────

    #[test]
    fn patch_applies_immediately_and_flush_persists_then_reset() {
        let (mut s, file) = make(None);
        assert!(!s.is_modified("terminal.fontSize"));

        s.patch("terminal.fontSize", json!(15));
        assert_eq!(s.get().terminal.font_size, 15);
        assert!(s.is_modified("terminal.fontSize"));
        assert_eq!(file.writes(), 0, "flush 之前不写盘");

        s.flush();
        assert_eq!(file.writes(), 1);
        assert_eq!(disk(&file)["terminal"]["fontSize"], 15);

        s.reset("terminal.fontSize");
        assert_eq!(s.get().terminal.font_size, 13);
        assert!(!s.is_modified("terminal.fontSize"));
    }

    #[test]
    fn out_of_range_patch_falls_back_to_default_immediately() {
        let (mut s, _) = make(None);
        s.patch("terminal.fontSize", json!(99));
        assert_eq!(s.get().terminal.font_size, 13);
        s.patch("appearance.sidebarWidth", json!(10));
        assert_eq!(s.get().appearance.sidebar_width, 264);
    }

    #[test]
    fn structural_paths_patch_as_a_whole() {
        let (mut s, _) = make(None);
        s.patch("presets.plusDefault", json!("claude"));
        assert_eq!(s.get().presets.plus_default.as_deref(), Some("claude"));
        s.patch("acpAgents", json!([]));
        assert!(s.get().acp_agents.is_empty());
    }

    #[test]
    fn unknown_path_is_ignored() {
        let (mut s, _) = make(None);
        let rev = s.revision();
        s.patch("terminal.nope", json!(1));
        assert_eq!(s.revision(), rev);
        assert!(!s.has_pending_write());
    }

    // ── 读盘容错 ───────────────────────────────────────────────────

    #[test]
    fn first_run_has_defaults_and_does_not_write() {
        let (s, file) = make(None);
        assert_eq!(*s.get(), Settings::default());
        assert_eq!(file.snapshot(), None);
    }

    #[test]
    fn legacy_font_is_migrated_on_init() {
        let (s, _) = make(Some(r#"{"terminal":{"fontFamily":"JetBrains Mono"}}"#));
        assert_eq!(s.get().terminal.font_family, default_terminal_font());
    }

    #[test]
    fn unknown_keys_survive_a_patch_and_write() {
        let raw = r#"{"__future":{"nested":[1,2]},"terminal":{"fontSize":14}}"#;
        let (mut s, file) = make(Some(raw));
        assert_eq!(file.writes(), 0);
        s.patch("terminal.cursorBlink", json!(false));
        s.flush();
        let d = disk(&file);
        assert_eq!(d["__future"], json!({ "nested": [1, 2] }), "未知键没丢");
        assert_eq!(d["terminal"]["fontSize"], 14, "已有值也没丢");
        assert_eq!(d["terminal"]["cursorBlink"], false);
    }

    // ── 写失败：回滚 + writeError + 下次成功清除 ───────────────────

    #[test]
    fn failed_write_rolls_back_then_next_success_clears_error() {
        let (mut s, file) = make(None);
        s.patch("terminal.fontSize", json!(15));
        s.flush(); // 成功落盘
        let persisted = s.get().clone();

        file.set_fail_write(Some("EACCES: disk on fire"));
        s.patch("terminal.fontSize", json!(18));
        assert_eq!(s.get().terminal.font_size, 18, "内存先见 18");
        s.flush();
        assert_eq!(*s.get(), persisted, "回滚到 15");
        let err = s.write_error().unwrap();
        assert_eq!(err.path, "terminal.fontSize");
        assert!(err.message.contains("EACCES"));

        file.set_fail_write(None);
        s.patch("terminal.cursorBlink", json!(false));
        s.flush();
        assert!(s.write_error().is_none());
        assert!(!s.get().terminal.cursor_blink);
        let d = disk(&file);
        assert_eq!(d["terminal"]["cursorBlink"], false);
        assert_eq!(d["terminal"]["fontSize"], 15, "回滚后的值被重新落盘");
    }

    #[test]
    fn consecutive_patches_coalesce_into_a_single_write() {
        let (mut s, file) = make(None);
        s.patch("terminal.fontSize", json!(16));
        s.patch("appearance.sidebarWidth", json!(300));
        s.patch("notifications.desktop", json!(false));
        s.flush();
        assert_eq!(file.writes(), 1, "三个 patch 合并成一次写");
        let d = disk(&file);
        assert_eq!(d["terminal"]["fontSize"], 16);
        assert_eq!(d["appearance"]["sidebarWidth"], 300);
        assert_eq!(d["notifications"]["desktop"], false);
        s.flush();
        assert_eq!(file.writes(), 1, "没有待写时 flush 是 no-op");
    }

    #[test]
    fn a_failed_write_never_lands_the_ahead_snapshot() {
        let (mut s, file) = make(None);
        file.set_fail_write(Some("boom"));
        s.patch("terminal.fontSize", json!(20));
        s.flush();
        assert_eq!(s.get().terminal.font_size, 13, "已回滚");
        s.flush();
        let on_disk = file.snapshot();
        assert!(on_disk.is_none_or(
            |d| serde_json::from_str::<Value>(&d).unwrap()["terminal"]["fontSize"] != 20
        ));
    }

    // ── 订阅（revision 计数）──────────────────────────────────────

    #[test]
    fn revision_bumps_on_patch_rollback_and_error_clear_but_not_on_plain_success() {
        let (mut s, file) = make(None);
        let r0 = s.revision();
        s.patch("terminal.fontSize", json!(15));
        assert_eq!(s.revision(), r0 + 1);
        s.flush(); // 成功且没有 writeError 可清：不额外通知
        assert_eq!(s.revision(), r0 + 1);

        file.set_fail_write(Some("x"));
        s.patch("terminal.fontSize", json!(18));
        s.flush(); // patch + 失败回滚（writeError 出现）
        assert_eq!(s.revision(), r0 + 3);

        file.set_fail_write(None);
        s.patch("terminal.cursorBlink", json!(false)); // patch（commit 同时清 writeError）
        s.flush();
        assert_eq!(
            s.revision(),
            r0 + 4,
            "成功路径无 writeError 可清，不额外通知"
        );
    }

    // ── 预设 CRUD ─────────────────────────────────────────────────

    #[test]
    fn add_preset_creates_a_custom_preset_with_unique_id_and_persists() {
        let (mut s, file) = make(None);
        let id = s.add_preset(PresetInput {
            label: "自定义 1".into(),
            program: Some("pwsh".into()),
            args: Some(vec!["-NoLogo".into()]),
            ..Default::default()
        });
        let added = s.get().presets.items.iter().find(|p| p.id == id).unwrap();
        assert!(!added.builtin);
        assert_eq!(added.program.as_deref(), Some("pwsh"));
        assert_eq!(added.args, Some(vec!["-NoLogo".into()]));
        s.flush();
        let d = disk(&file);
        assert_eq!(d["presets"]["items"].as_array().unwrap().len(), 6);
        let on_disk = d["presets"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == id.as_str())
            .unwrap();
        assert_eq!(on_disk["label"], "自定义 1");
    }

    #[test]
    fn update_preset_normalizes_empty_values_and_filters_blank_arg_lines() {
        let (mut s, file) = make(None);
        let id = s.add_preset(PresetInput {
            label: "X".into(),
            program: Some("pwsh".into()),
            args: Some(vec!["-l".into()]),
            init_command: Some("vim".into()),
            cwd: Some("D:/".into()),
        });
        s.update_preset(
            &id,
            PresetPatch {
                label: Some("Y".into()),
                program: Some(Some(String::new())),
                args: Some(Some(vec![])),
                env: Some(Some(Default::default())),
                init_command: Some(Some(String::new())),
                ..Default::default()
            },
        );
        let p = s
            .get()
            .presets
            .items
            .iter()
            .find(|p| p.id == id)
            .unwrap()
            .clone();
        assert_eq!(p.label, "Y");
        assert_eq!(
            (p.program, p.args, p.env, p.init_command),
            (None, None, None, None)
        );
        s.flush();
        let d = disk(&file);
        let on_disk = d["presets"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == id.as_str())
            .unwrap();
        assert!(
            on_disk.get("program").is_none()
                && on_disk.get("args").is_none()
                && on_disk.get("env").is_none()
        );

        s.update_preset(
            &id,
            PresetPatch {
                args: Some(Some(vec![
                    "NoLogo".into(),
                    String::new(),
                    "NoPrompt".into(),
                ])),
                ..Default::default()
            },
        );
        let args = s
            .get()
            .presets
            .items
            .iter()
            .find(|p| p.id == id)
            .unwrap()
            .args
            .clone();
        assert_eq!(args, Some(vec!["NoLogo".into(), "NoPrompt".into()]));
        s.update_preset(
            &id,
            PresetPatch {
                args: Some(Some(vec![String::new()])),
                ..Default::default()
            },
        );
        assert_eq!(
            s.get()
                .presets
                .items
                .iter()
                .find(|p| p.id == id)
                .unwrap()
                .args,
            None
        );
    }

    #[test]
    fn update_preset_edits_builtin_fields_and_unknown_id_is_a_no_op() {
        let (mut s, _) = make(None);
        s.update_preset(
            "claude",
            PresetPatch {
                init_command: Some(Some("claude --dangerously".into())),
                ..Default::default()
            },
        );
        assert_eq!(
            s.get()
                .presets
                .items
                .iter()
                .find(|p| p.id == "claude")
                .unwrap()
                .init_command
                .as_deref(),
            Some("claude --dangerously")
        );
        let (rev, before) = (s.revision(), s.get().presets.items.clone());
        s.update_preset(
            "nope",
            PresetPatch {
                label: Some("?".into()),
                ..Default::default()
            },
        );
        assert_eq!(s.revision(), rev, "未知 id：不提交");
        assert_eq!(s.get().presets.items, before);
    }

    #[test]
    fn delete_preset_custom_only_and_clears_plus_default() {
        let (mut s, _) = make(None);
        let id = s.add_preset(PresetInput {
            label: "X".into(),
            ..Default::default()
        });
        assert_eq!(s.get().presets.items.len(), 6);
        s.delete_preset("claude"); // 内置不可删
        assert_eq!(s.get().presets.items.len(), 6);

        s.patch("presets.plusDefault", json!(id));
        assert_eq!(s.get().presets.plus_default.as_deref(), Some(id.as_str()));
        s.delete_preset(&id);
        assert_eq!(s.get().presets.items.len(), 5);
        assert_eq!(
            s.get().presets.plus_default,
            None,
            "plusDefault 指向被删预设 → 回退 null"
        );
    }

    #[test]
    fn duplicate_preset_numbers_copies_and_copies_of_copies() {
        let (mut s, _) = make(None);
        let n1 = s.duplicate_preset("claude");
        assert_eq!(n1, "claude-copy");
        let c1 = s
            .get()
            .presets
            .items
            .iter()
            .find(|p| p.id == n1)
            .unwrap()
            .clone();
        assert!(!c1.builtin);
        assert_eq!(c1.label, "Claude Code 副本");
        assert_eq!(c1.init_command.as_deref(), Some("claude"), "字段随源");
        assert_eq!(s.duplicate_preset("claude"), "claude-copy2");
        assert_eq!(s.duplicate_preset(&n1), format!("{n1}-copy"));
        assert_eq!(s.duplicate_preset("nope"), "", "源不存在 → 空串");
    }

    #[test]
    fn duplicate_custom_preset_is_also_a_non_builtin_copy() {
        let (mut s, _) = make(None);
        let id = s.add_preset(PresetInput {
            label: "X".into(),
            program: Some("zsh".into()),
            ..Default::default()
        });
        let nid = s.duplicate_preset(&id);
        let copy = s.get().presets.items.iter().find(|p| p.id == nid).unwrap();
        assert!(!copy.builtin);
        assert_eq!(copy.program.as_deref(), Some("zsh"));
        assert_eq!(copy.label, "X 副本");
    }

    #[test]
    fn reset_preset_restores_builtin_and_ignores_custom() {
        let (mut s, _) = make(None);
        s.update_preset(
            "claude",
            PresetPatch {
                label: Some("我的 Claude".into()),
                init_command: Some(Some("claude --x".into())),
                ..Default::default()
            },
        );
        s.reset_preset("claude");
        let r = s
            .get()
            .presets
            .items
            .iter()
            .find(|p| p.id == "claude")
            .unwrap();
        assert_eq!(r.label, "Claude Code");
        assert_eq!(r.init_command.as_deref(), Some("claude"));

        let id = s.add_preset(PresetInput {
            label: "X".into(),
            ..Default::default()
        });
        let (rev, items) = (s.revision(), s.get().presets.items.clone());
        s.reset_preset(&id); // 自定义无出厂值
        assert_eq!((s.revision(), s.get().presets.items.clone()), (rev, items));
    }

    #[test]
    fn crud_write_failure_rolls_back_through_the_same_chain() {
        let (mut s, file) = make(None);
        let id = s.add_preset(PresetInput {
            label: "X".into(),
            ..Default::default()
        });
        s.flush();
        let persisted = s.get().clone();

        file.set_fail_write(Some("EACCES"));
        s.update_preset(
            &id,
            PresetPatch {
                label: Some("Y".into()),
                ..Default::default()
            },
        );
        assert_eq!(
            s.get()
                .presets
                .items
                .iter()
                .find(|p| p.id == id)
                .unwrap()
                .label,
            "Y"
        );
        s.flush();
        assert_eq!(*s.get(), persisted, "回滚");
        assert_eq!(
            s.get()
                .presets
                .items
                .iter()
                .find(|p| p.id == id)
                .unwrap()
                .label,
            "X"
        );
        assert_eq!(s.write_error().unwrap().path, "presets.items");
    }

    // ── 运行时态纪律 ──────────────────────────────────────────────

    #[test]
    fn last_used_preset_is_never_part_of_settings() {
        let (mut s, file) = make(None);
        s.patch("terminal.fontSize", json!(15));
        s.add_preset(PresetInput {
            label: "X".into(),
            ..Default::default()
        });
        s.flush();
        assert!(!file.snapshot().unwrap().contains("lastUsedPreset"));
    }

    // ── ACP agents ────────────────────────────────────────────────

    #[test]
    fn add_acp_agent_persists_and_default_examples_are_deletable() {
        let (mut s, file) = make(None);
        assert_eq!(s.get().acp_agents.len(), 2);
        let id = s.add_acp_agent(AcpAgentInput {
            label: "Gemini".into(),
            command: Some("gemini".into()),
            args: Some(vec!["--acp".into()]),
        });
        let added = s.get().acp_agents.iter().find(|a| a.id == id).unwrap();
        assert_eq!(
            (
                added.label.as_str(),
                added.command.as_str(),
                added.args.clone()
            ),
            ("Gemini", "gemini", vec!["--acp".to_string()])
        );
        s.flush();
        assert_eq!(disk(&file)["acpAgents"].as_array().unwrap().len(), 3);

        let first = s.get().acp_agents[0].id.clone();
        s.delete_acp_agent(&first);
        s.flush();
        assert_eq!(s.get().acp_agents.len(), 2);
    }

    #[test]
    fn add_acp_agent_defaults_and_update_filters_blank_args_and_unknown_id_is_a_no_op() {
        let (mut s, _) = make(None);
        let id = s.add_acp_agent(AcpAgentInput {
            label: "X".into(),
            ..Default::default()
        });
        let a = s.get().acp_agents.iter().find(|a| a.id == id).unwrap();
        assert_eq!((a.command.as_str(), a.args.clone()), ("", vec![]));
        s.update_acp_agent(
            &id,
            AcpAgentPatch {
                command: Some("codex".into()),
                args: Some(vec!["--acp".into(), String::new()]),
                ..Default::default()
            },
        );
        assert_eq!(
            s.get().acp_agents.iter().find(|a| a.id == id).unwrap().args,
            vec!["--acp".to_string()]
        );
        let rev = s.revision();
        s.update_acp_agent(
            "nope",
            AcpAgentPatch {
                label: Some("Y".into()),
                ..Default::default()
            },
        );
        assert_eq!(s.revision(), rev);
    }

    #[test]
    fn acp_write_failure_rolls_back_with_acp_agents_path() {
        let (mut s, file) = make(None);
        let persisted = s.get().clone();
        file.set_fail_write(Some("EACCES"));
        let first = persisted.acp_agents[0].id.clone();
        s.delete_acp_agent(&first);
        s.flush();
        assert_eq!(*s.get(), persisted);
        assert_eq!(s.write_error().unwrap().path, "acpAgents");
    }

    // ── schema 一致性 ─────────────────────────────────────────────

    #[test]
    fn every_documented_path_exists_in_defaults() {
        let d = Settings::default();
        for p in [
            "presets.plusDefault",
            "presets.items",
            "notifications.desktop",
            "notifications.sound",
            "terminal.fontFamily",
            "terminal.fontSize",
            "terminal.cursorBlink",
            "terminal.scrollbackLines",
            "terminal.palette",
            "terminal.closeOnExit",
            "appearance.theme",
            "appearance.sidebarWidth",
            "acpAgents",
            "keybindings.cycleNext",
            "keybindings.searchThreads",
            "advanced.gpuBackend",
            "advanced.perfHud",
            "advanced.frameOverlay",
        ] {
            assert!(d.get_path(p).is_some(), "path 不存在: {p}");
        }
    }
}
