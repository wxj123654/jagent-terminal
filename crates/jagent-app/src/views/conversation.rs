//! 对话面（chat / acp 共享）：conv-head + 消息列表（变高 `list`，follow-tail）+ composer。
//!
//! V6 原型对齐（`index.css` 第二段生效值；gpuix `surfaces/ConversationView.tsx`）：
//! - conv-head 44px：avatar 26² surface 块（accent 图标）+ 标题 600 + 右置状态
//!   （done 点 + 「正在回复 / 已连接」）；
//! - 消息区：列表自身 pt 28（窄 22）/ pb 18；每行根撑满居中 → 内列
//!   min(760,100%) 横距 28（窄 18）。行距用 pb（gpui ListState 测行高时行根
//!   margin 不计入自身尺寸，padding 才算——gpuix 走查 D2 坑）；
//! - user 右对齐气泡（max 620 / accentSoft 底 / rgba(97,175,239,.28) 边 /
//!   12·12·3·12 圆角 / 0 1 2 投影）；assistant = mono role 标签（ASSISTANT /
//!   ERROR）+ markdown 正文（14 / 1.65，error 正文换 bell 色）；
//! - thinking：accent 圆点（4px accentSoft 环）+「正在思考…」；
//! - composer：居中 704 列（底 = pane 向上渐隐）；shell（inputBg r12 + 投影，
//!   焦点换 focusBorder 边 + accentSoft 环）内 textarea + 34² accent 箭头钮
//!   （pendingReply → 灰面）；hint 右对齐 faint 10px。
//!
//! 规则在 core（`begin_send` / `finish_send` / `conversation`）；回声后端与延时在 `state::send_chat`。
//! GPUI list 用原生 FollowMode::Tail，并通过 splice / remeasure_items 增量更新，保留上滚阅读锚点。

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, BoxShadow, Context, Entity, Focusable as _, HighlightStyle,
    Hsla, InteractiveElement as _, IntoElement, ListAlignment, ListState, ParentElement as _,
    Render, StatefulInteractiveElement as _, Styled, Window, div, linear_color_stop,
    linear_gradient, list, prelude::FluentBuilder as _, px, rems,
};
use gpui_base::Popover;
use gpui_component::h_flex;
use gpui_component::{
    input::{Input, InputEvent, InputState, Position, Rope, RopeExt as _, Textarea, TextareaState},
    text::{TextView, TextViewState, TextViewStyle},
    v_flex,
};
use jagent_core::acp::{AcpCommand, AcpConfigSelector, AcpSessionSummary};
use jagent_core::settings::AcpAgent;
use jagent_core::threads::{ChatMessage, ConversationKind, Thread, ToolCallTrace};

use crate::icons::{IconName, icon};
use crate::state::{
    AppState, StateChanged, ensure_acp_connected, fetch_acp_session_list, resume_acp_session,
    send_acp_with_prompt, send_chat, set_acp_config_option,
};
use crate::theme::{accent_alpha, colors, hex, rgba_css};
use crate::ui_scale::fs;
use crate::views::popup::{MenuEntry, MenuItem, PopupTrigger, menu_popover, overlay_shell};
use crate::views::selectable::sel_text_id;

/// 上下文文件读取单文件最大字节数（避免把超大二进制/日志打爆 prompt）
const MAX_CONTEXT_FILE_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderedRow {
    id: String,
    text: String,
    tool_calls: Vec<ToolCallTrace>,
}

/// 输入框内 `/` 或 `@` 自动补全触发类型。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerTriggerKind {
    /// 行首 `/` 斜杠命令触发
    SlashCommand,
    /// 行首或空白后的 `@` 工作区文件引用触发
    ContextFile,
}

/// 输入框内当前光标处的自动补全触发器。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerTrigger {
    pub kind: ComposerTriggerKind,
    /// 触发词（含前导 `/` 或 `@`）在输入文本中的字节范围
    pub replace_range: std::ops::Range<usize>,
    /// 剥离前导 `/` 或 `@` 后的过滤查询词
    pub query: String,
}

/// 自动补全菜单中的单条候选项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerSuggestion {
    SlashCommand(AcpCommand),
    ContextFile(String),
}

/// 检测输入框文本与光标字节偏移处是否处于 `/` 斜杠命令或 `@` 文件引用触发状态。
pub fn detect_composer_trigger(text: &str, cursor_offset: usize) -> Option<ComposerTrigger> {
    if text.is_empty() {
        return None;
    }
    let mut cursor = cursor_offset.min(text.len());
    while cursor > 0 && !text.is_char_boundary(cursor) {
        cursor -= 1;
    }
    let before = &text[..cursor];
    let word_start = before
        .rfind(char::is_whitespace)
        .map(|i| {
            let ch = before[i..].chars().next().unwrap_or(' ');
            i + ch.len_utf8()
        })
        .unwrap_or(0);
    let word_before_cursor = &before[word_start..];
    let after = &text[cursor..];
    let word_end = cursor + after.find(char::is_whitespace).unwrap_or(after.len());

    // 1. `@` 文件引用触发：当前词以 `@` 开头（前导为行首或任意空白字符）
    if let Some(query) = word_before_cursor.strip_prefix('@') {
        return Some(ComposerTrigger {
            kind: ComposerTriggerKind::ContextFile,
            replace_range: word_start..word_end,
            query: query.to_owned(),
        });
    }

    // 2. `/` 斜杠命令触发：整段输入首个非空白 token 以 `/` 开头，且光标仍在该首 token 内
    let first_non_ws = text.len() - text.trim_start().len();
    if word_start == first_non_ws
        && cursor > first_non_ws
        && let Some(query) = word_before_cursor.strip_prefix('/')
    {
        return Some(ComposerTrigger {
            kind: ComposerTriggerKind::SlashCommand,
            replace_range: first_non_ws..word_end,
            query: query.to_owned(),
        });
    }

    None
}

/// 根据当前触发器计算匹配的补全候选项列表（前缀匹配优先，子串匹配次之）。
pub fn match_composer_suggestions(
    trigger: &ComposerTrigger,
    commands: &[AcpCommand],
    workspace_files: &[String],
) -> Vec<ComposerSuggestion> {
    let q = trigger.query.trim().to_lowercase();
    match trigger.kind {
        ComposerTriggerKind::SlashCommand => {
            let mut prefix_hits = Vec::new();
            let mut contains_hits = Vec::new();
            for cmd in commands {
                let name_lower = cmd.name.to_lowercase();
                let desc_lower = cmd.description.to_lowercase();
                if q.is_empty() || name_lower.starts_with(&q) {
                    prefix_hits.push(ComposerSuggestion::SlashCommand(cmd.clone()));
                } else if name_lower.contains(&q) || desc_lower.contains(&q) {
                    contains_hits.push(ComposerSuggestion::SlashCommand(cmd.clone()));
                }
            }
            prefix_hits.extend(contains_hits);
            prefix_hits.truncate(24);
            prefix_hits
        }
        ComposerTriggerKind::ContextFile => {
            let mut basename_prefix = Vec::new();
            let mut path_contains = Vec::new();
            for path in workspace_files {
                let lower = path.to_lowercase();
                let base = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
                if q.is_empty() || base.starts_with(&q) || lower.starts_with(&q) {
                    basename_prefix.push(ComposerSuggestion::ContextFile(path.clone()));
                } else if lower.contains(&q) {
                    path_contains.push(ComposerSuggestion::ContextFile(path.clone()));
                }
            }
            basename_prefix.extend(path_contains);
            basename_prefix.truncate(24);
            basename_prefix
        }
    }
}

/// 将触发范围替换为目标文本，并返回新文本、新光标字节偏移与对应的 `Position`。
pub fn apply_trigger_replacement(
    text: &str,
    replace_range: std::ops::Range<usize>,
    replacement: &str,
) -> (String, usize, Position) {
    let start = replace_range.start.min(text.len());
    let mut end = replace_range.end.min(text.len());
    // 若替换为空（如 @file 转为顶部 chip）且后面紧跟一个空格，则顺带消掉多余空格
    if replacement.is_empty()
        && text[end..].starts_with(' ')
        && (start == 0 || text[..start].ends_with(' '))
    {
        end += 1;
    } else if replacement.ends_with(' ') && text[end..].starts_with(' ') {
        // 若替换内容末尾带空格而原文本后面已有空格，避免产生双空格
        end += 1;
    }
    let mut out =
        String::with_capacity(text.len() - (end.saturating_sub(start)) + replacement.len());
    out.push_str(&text[..start]);
    out.push_str(replacement);
    let new_cursor = out.len();
    out.push_str(&text[end..]);
    let pos = Rope::from(out.as_str()).offset_to_position(new_cursor);
    (out, new_cursor, pos)
}

/// 扫描用户手写文本中的 `@<path>` 提及：若匹配工作区已知文件（精确路径或唯一文件名），自动加入上下文文件列表。
pub fn extract_inline_context_mentions(
    text: &str,
    workspace_files: &[String],
    attached: &mut Vec<String>,
) {
    for raw_token in text.split_whitespace() {
        let Some(mention) = raw_token
            .strip_prefix('@')
            .map(|s| s.trim_end_matches(|c: char| matches!(c, ',' | '.' | ':' | ';' | ')' | ']')))
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if let Some(exact) = workspace_files.iter().find(|f| f.as_str() == mention) {
            if !attached.contains(exact) {
                attached.push(exact.clone());
            }
            continue;
        }
        let mut by_name = workspace_files
            .iter()
            .filter(|f| f.rsplit(['/', '\\']).next() == Some(mention));
        if let Some(first) = by_name.next()
            && by_name.next().is_none()
            && !attached.contains(first)
        {
            attached.push(first.clone());
        }
    }
}

pub struct ConversationView {
    state: Entity<AppState>,
    thread_id: String,
    input: Entity<TextareaState>,
    list: ListState,
    /// 每条非 user 消息的持久化 TextViewState（避免 gpui::list 双次测高导致 use_keyed_state 丢失选区）
    md_states: HashMap<String, Entity<TextViewState>>,
    /// 上一帧消息快照；只增量替换/重测变更条目，保留 GPUI list 的 scroll anchor。
    rendered_messages: Vec<RenderedRow>,
    rendered_pending: bool,
    rendered_ui_scale_bits: u32,
    scrolled_away_from_tail: Rc<std::cell::Cell<bool>>,
    /// 已手动收起工具调用详情的消息 id 集合（默认展开）
    collapsed_traces: HashSet<String>,
    /// 当前附加到下一条消息的工作区相对文件路径列表
    context_files: Vec<String>,
    /// 工作区候选文件列表（后台扫描填充）
    workspace_files: Vec<String>,
    /// 上次扫描的文件列表所属工作区根目录
    workspace_cwd: String,
    /// 「+ 添加上下文」浮层展开态
    context_popover_open: bool,
    /// 「+ 添加上下文」浮层内文件搜索框
    context_filter: Entity<InputState>,
    /// ACP 模型选择浮层展开态
    model_popover_open: bool,
    /// ACP 模型选择浮层内搜索框
    model_filter: Entity<InputState>,
    /// ACP 历史会话恢复（`/resume`）浮层展开态
    resume_popover_open: bool,
    /// ACP 历史会话恢复浮层内搜索框
    resume_filter: Entity<InputState>,
    /// `/` 或 `@` 自动补全列表当前高亮索引
    trigger_selected_index: usize,
    /// 用户按 Esc 显式关闭的触发器快照（直到文本或触发词变化前不再弹出）
    dismissed_trigger: Option<ComposerTrigger>,
}

impl ConversationView {
    pub fn new(
        state: Entity<AppState>,
        thread_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let kind = state
            .read(cx)
            .threads
            .conversation(&thread_id)
            .map(|c| c.kind)
            .unwrap_or(ConversationKind::Chat);
        let ph = match kind {
            ConversationKind::Acp => {
                "向 Coding Agent 发送指令（@ 引用文件，/ 执行快捷指令，Enter 发送）…"
            }
            ConversationKind::Chat => "输入消息，或使用 @ 引用工作区文件、/ 执行快捷指令…",
        };
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 6)
                .submit_on_enter(true)
                .placeholder(ph)
        });
        let context_filter =
            cx.new(|cx| InputState::new(window, cx).placeholder("搜索工作区文件…"));
        cx.subscribe_in(&context_filter, window, |_, _, ev: &InputEvent, _, cx| {
            if matches!(ev, InputEvent::Change) {
                cx.notify();
            }
        })
        .detach();
        let model_filter =
            cx.new(|cx| InputState::new(window, cx).placeholder("搜索模型或 Provider…"));
        cx.subscribe_in(&model_filter, window, |_, _, ev: &InputEvent, _, cx| {
            if matches!(ev, InputEvent::Change) {
                cx.notify();
            }
        })
        .detach();
        let resume_filter =
            cx.new(|cx| InputState::new(window, cx).placeholder("搜索历史会话标题或 ID…"));
        cx.subscribe_in(&resume_filter, window, |_, _, ev: &InputEvent, _, cx| {
            if matches!(ev, InputEvent::Change) {
                cx.notify();
            }
        })
        .detach();
        cx.subscribe_in(
            &input,
            window,
            |this, _, ev: &InputEvent, window, cx| match ev {
                InputEvent::Change => {
                    this.trigger_selected_index = 0;
                    this.dismissed_trigger = None;
                    this.ensure_workspace_files(cx);
                    cx.notify();
                }
                InputEvent::PressEnter { shift: false, .. } => {
                    if !this.active_trigger_suggestions(cx).1.is_empty() {
                        this.accept_active_suggestion(window, cx);
                    } else {
                        this.send(window, cx);
                    }
                }
                _ => {}
            },
        )
        .detach();
        cx.subscribe(&state, |this, _, _: &StateChanged, cx| {
            this.ensure_workspace_files(cx);
            cx.notify();
        })
        .detach();
        let mut this = Self {
            state,
            thread_id,
            input,
            list: {
                let list = ListState::new(0, ListAlignment::Top, px(480.0));
                list.set_follow_mode(gpui::FollowMode::Tail);
                list
            },
            md_states: HashMap::new(),
            rendered_messages: vec![],
            rendered_pending: false,
            rendered_ui_scale_bits: crate::ui_scale::ui_scale().to_bits(),
            scrolled_away_from_tail: Rc::new(std::cell::Cell::new(false)),
            collapsed_traces: HashSet::new(),
            context_files: Vec::new(),
            workspace_files: Vec::new(),
            workspace_cwd: String::new(),
            context_popover_open: false,
            context_filter,
            model_popover_open: false,
            model_filter,
            resume_popover_open: false,
            resume_filter,
            trigger_selected_index: 0,
            dismissed_trigger: None,
        };
        this.ensure_workspace_files(cx);
        #[cfg(not(test))]
        if kind == ConversationKind::Acp {
            ensure_acp_connected(&this.state, &this.thread_id, cx);
        }
        this
    }

    /// 计算当前对话归属的工作区目录。
    fn current_cwd(&self, cx: &App) -> String {
        let s = self.state.read(cx);
        s.threads
            .thread(&self.thread_id)
            .and_then(|t| t.workspace_id())
            .and_then(|wid| s.threads.workspace(wid))
            .map(|w| w.path.clone())
            .unwrap_or_else(|| s.git_cwd())
    }

    /// 异步加载当前工作区的文件列表，供「+ 添加上下文」选择器使用。
    fn ensure_workspace_files(&mut self, cx: &mut Context<Self>) {
        let cwd = self.current_cwd(cx);
        if cwd.is_empty() || cwd == self.workspace_cwd {
            return;
        }
        self.workspace_cwd = cwd.clone();
        let weak = cx.entity().downgrade();
        cx.spawn(async move |_, cx| {
            let files: Vec<String> = cx
                .background_spawn(async move {
                    let (_, entries) =
                        jagent_core::git::cli::list_workspace_files(std::path::Path::new(&cwd));
                    entries
                })
                .await;
            let _ = weak.update(cx, |this, cx| {
                this.workspace_files = files;
                cx.notify();
            });
        })
        .detach();
    }

    /// 附加或移除一个工作区上下文文件。
    pub fn toggle_context_file(&mut self, path: &str, cx: &mut Context<Self>) {
        if let Some(pos) = self.context_files.iter().position(|p| p == path) {
            self.context_files.remove(pos);
        } else {
            self.context_files.push(path.to_owned());
        }
        cx.notify();
    }

    /// 计算当前输入框是否处于 `/` 或 `@` 自动补全触发态及其匹配的候选项。
    fn active_trigger_suggestions(
        &self,
        cx: &App,
    ) -> (Option<ComposerTrigger>, Vec<ComposerSuggestion>) {
        let inp = self.input.read(cx);
        let text = inp.value().to_string();
        let cursor = inp.cursor();
        let Some(trigger) = detect_composer_trigger(&text, cursor) else {
            return (None, Vec::new());
        };
        if self.dismissed_trigger.as_ref() == Some(&trigger) {
            return (None, Vec::new());
        }
        let commands = self
            .state
            .read(cx)
            .threads
            .acp_available_commands(&self.thread_id);
        let suggestions = match_composer_suggestions(&trigger, &commands, &self.workspace_files);
        (Some(trigger), suggestions)
    }

    /// 上下移动自动补全列表的高亮项。
    pub fn move_trigger_selection(&mut self, delta: isize, cx: &mut Context<Self>) {
        let (_, suggestions) = self.active_trigger_suggestions(cx);
        let len = suggestions.len();
        if len == 0 {
            return;
        }
        let cur = self.trigger_selected_index.min(len - 1) as isize;
        let next = (cur + delta).rem_euclid(len as isize) as usize;
        self.trigger_selected_index = next;
        cx.notify();
    }

    /// 按 Esc 显式收起当前触发的补全菜单。
    pub fn dismiss_active_trigger(&mut self, cx: &mut Context<Self>) {
        let (trigger, _) = self.active_trigger_suggestions(cx);
        if trigger.is_some() {
            self.dismissed_trigger = trigger;
            cx.notify();
        }
    }

    /// 确认补全指定索引的候选项（Enter / Tab / 鼠标点击共用）。
    pub fn accept_suggestion_at(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (Some(trigger), suggestions) = self.active_trigger_suggestions(cx) else {
            return;
        };
        let Some(picked) = suggestions.get(index).cloned() else {
            return;
        };
        let current_text = self.input.read(cx).value().to_string();
        match picked {
            ComposerSuggestion::ContextFile(path) => {
                if !self.context_files.contains(&path) {
                    self.context_files.push(path);
                }
                let (new_text, _, pos) =
                    apply_trigger_replacement(&current_text, trigger.replace_range, "");
                self.input.update(cx, |s, cx| {
                    s.set_value(new_text, window, cx);
                    s.set_cursor_position(pos, window, cx);
                });
            }
            ComposerSuggestion::SlashCommand(cmd) => {
                if cmd.name == "resume" {
                    let (new_text, _, pos) =
                        apply_trigger_replacement(&current_text, trigger.replace_range, "");
                    self.input.update(cx, |s, cx| {
                        s.set_value(new_text, window, cx);
                        s.set_cursor_position(pos, window, cx);
                    });
                    self.open_resume_picker(None, window, cx);
                } else {
                    let replacement = format!("/{} ", cmd.name);
                    let (new_text, _, pos) = apply_trigger_replacement(
                        &current_text,
                        trigger.replace_range,
                        &replacement,
                    );
                    self.input.update(cx, |s, cx| {
                        s.set_value(new_text, window, cx);
                        s.set_cursor_position(pos, window, cx);
                    });
                }
            }
        }
        self.trigger_selected_index = 0;
        self.dismissed_trigger = None;
        cx.notify();
    }

    /// 打开 ACP 历史会话恢复浮层并触发后台 `session/list` 拉取。
    pub fn open_resume_picker(
        &mut self,
        initial_query: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(q) = initial_query {
            let q_str = q.trim().to_owned();
            self.resume_filter
                .update(cx, |s, cx| s.set_value(q_str, window, cx));
        }
        self.resume_popover_open = true;
        fetch_acp_session_list(&self.state, &self.thread_id, cx);
        cx.notify();
    }

    /// 确认补全当前高亮的候选项。
    pub fn accept_active_suggestion(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (_, suggestions) = self.active_trigger_suggestions(cx);
        if suggestions.is_empty() {
            return;
        }
        let ix = self.trigger_selected_index.min(suggestions.len() - 1);
        self.accept_suggestion_at(ix, window, cx);
    }

    /// 发送。等待中或空白时不动输入框，保留用户已写的内容。
    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let pending = self
            .state
            .read(cx)
            .threads
            .conversation(&self.thread_id)
            .is_some_and(|c| c.pending);
        let raw_text = self.input.read(cx).value().to_string();
        let trimmed = raw_text.trim();
        if pending || trimmed.is_empty() {
            return;
        }
        // 拦截本地客户端命令 `/resume [query]`：直接弹出历史会话恢复选择器
        if trimmed == "/resume" || trimmed.starts_with("/resume ") {
            let query = trimmed.strip_prefix("/resume").map(str::trim);
            self.input
                .update(cx, |s, cx| s.set_value(String::new(), window, cx));
            self.open_resume_picker(query, window, cx);
            return;
        }
        let mut attached = std::mem::take(&mut self.context_files);
        extract_inline_context_mentions(&raw_text, &self.workspace_files, &mut attached);
        let cwd = self.current_cwd(cx);
        let (display_text, prompt_text) =
            compose_message_with_context(raw_text.trim(), &attached, std::path::Path::new(&cwd));

        // 按线程类型分派：若为本地 Chat 但已配置 ACP Agent，则自动升级为默认 ACP Agent 发送真实对话
        #[allow(unused_mut)]
        let mut kind = self
            .state
            .read(cx)
            .threads
            .conversation(&self.thread_id)
            .map(|c| c.kind);
        #[cfg(not(test))]
        if kind == Some(ConversationKind::Chat) {
            let first_acp = self.state.read(cx).settings.get().acp_agents.first().cloned();
            if let Some(ag) = first_acp {
                self.state.update(cx, |s, cx| {
                    s.switch_acp_agent(&self.thread_id, &ag.id, &ag.label, cx);
                });
                kind = Some(ConversationKind::Acp);
            }
        }
        match kind {
            Some(ConversationKind::Acp) => send_acp_with_prompt(
                &self.state,
                &self.thread_id,
                &display_text,
                &prompt_text,
                cx,
            ),
            _ => send_chat(&self.state, &self.thread_id, &display_text, cx),
        }
        self.input
            .update(cx, |s, cx| s.set_value(String::new(), window, cx));
    }
}

/// 组装带上下文文件的展示文本与发给 Agent 的完整 prompt（读取磁盘文件内容拼入代码块）。
pub fn compose_message_with_context(
    user_text: &str,
    context_files: &[String],
    cwd: &std::path::Path,
) -> (String, String) {
    if context_files.is_empty() {
        return (user_text.to_owned(), user_text.to_owned());
    }
    let tags: Vec<String> = context_files
        .iter()
        .map(|p| {
            let short = p.rsplit(['/', '\\']).next().unwrap_or(p);
            format!("@{short}")
        })
        .collect();
    let display = format!("{}\n{}", tags.join(" "), user_text);

    let mut sections = Vec::new();
    for rel in context_files {
        let full = if std::path::Path::new(rel).is_absolute() {
            std::path::PathBuf::from(rel)
        } else {
            cwd.join(rel)
        };
        match std::fs::read(&full) {
            Ok(bytes) => {
                let slice = &bytes[..bytes.len().min(MAX_CONTEXT_FILE_BYTES)];
                let content = String::from_utf8_lossy(slice);
                let truncated = if bytes.len() > MAX_CONTEXT_FILE_BYTES {
                    "\n... (truncated)"
                } else {
                    ""
                };
                sections.push(format!("### File: `{rel}`\n```\n{content}{truncated}\n```"));
            }
            Err(_) => {
                sections.push(format!("### File: `{rel}` (path reference)"));
            }
        }
    }
    let prompt = format!("{}\n\n{}", sections.join("\n\n"), user_text);
    (display, prompt)
}

impl Render for ConversationView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (
            messages,
            pending,
            kind,
            agent_label,
            acp_agents,
            config_selectors,
            current_model_label,
            acp_connecting,
            acp_sessions,
            acp_loading_sessions,
            current_acp_sid,
        ) = {
            let s = self.state.read(cx);
            let agents = s.settings.get().acp_agents.clone();
            let selectors = s.threads.acp_config_selectors(&self.thread_id).to_vec();
            let model_lbl = s.threads.acp_current_model_label(&self.thread_id);
            let connecting = s.is_acp_connecting(&self.thread_id);
            let sessions = s.acp_session_list(&self.thread_id).to_vec();
            let loading_sessions = s.is_acp_loading_sessions(&self.thread_id);
            let cur_sid = s.threads.acp_session_id(&self.thread_id).map(str::to_owned);
            match s.threads.conversation(&self.thread_id) {
                Some(c) => {
                    let label = match s.threads.thread(&self.thread_id) {
                        Some(Thread::Acp(a)) => agents
                            .iter()
                            .find(|ag| ag.id == a.agent_id)
                            .map(|ag| ag.label.clone())
                            .unwrap_or_else(|| a.agent_id.clone()),
                        _ => "本地对话".to_owned(),
                    };
                    (
                        c.messages.to_vec(),
                        c.pending,
                        c.kind,
                        label,
                        agents,
                        selectors,
                        model_lbl,
                        connecting,
                        sessions,
                        loading_sessions,
                        cur_sid,
                    )
                }
                None => (
                    vec![],
                    false,
                    ConversationKind::Chat,
                    "本地对话".to_owned(),
                    agents,
                    selectors,
                    model_lbl,
                    connecting,
                    sessions,
                    loading_sessions,
                    cur_sid,
                ),
            }
        };
        let narrow = crate::views::root::is_narrow(f32::from(window.viewport_size().width));
        // composer-shell 的 :focus-within 等价：textarea 自报焦点
        let shell_focused = self.input.read(cx).focus_handle(cx).is_focused(window);
        let collapsed_traces = Rc::new(self.collapsed_traces.clone());
        let weak_for_list = cx.entity().downgrade();
        let list_for_re = self.list.clone();
        let state_for_list = self.state.clone();
        let tid_for_list = self.thread_id.clone();

        let show_pending_row = pending || (acp_connecting && messages.is_empty());
        let snapshot: Vec<RenderedRow> = messages
            .iter()
            .map(|m| RenderedRow {
                id: m.id.clone(),
                text: m.text.clone(),
                tool_calls: m.tool_calls.clone(),
            })
            .collect();
        if snapshot != self.rendered_messages || show_pending_row != self.rendered_pending {
            let plan = plan_list_update_rows(
                &self.rendered_messages,
                self.rendered_pending,
                &snapshot,
                show_pending_row,
            );
            if plan.replace_old.start != plan.replace_old.end || plan.insert_count > 0 {
                self.list.splice(plan.replace_old, plan.insert_count);
            }
            for range in plan.remeasure {
                self.list.remeasure_items(range);
            }
            if !self.scrolled_away_from_tail.get() {
                self.list.set_follow_mode(gpui::FollowMode::Tail);
            }
            self.rendered_messages = snapshot;
            self.rendered_pending = show_pending_row;
        }
        let current_scale_bits = crate::ui_scale::ui_scale().to_bits();
        if current_scale_bits != self.rendered_ui_scale_bits {
            let total_rows = self.rendered_messages.len() + usize::from(self.rendered_pending);
            if total_rows > 0 {
                self.list.remeasure_items(0..total_rows);
            }
            self.rendered_ui_scale_bits = current_scale_bits;
        }

        for m in &messages {
            if !m.is_user() {
                if let Some(st) = self.md_states.get(&m.id) {
                    let text = m.text.clone();
                    st.update(cx, |s, cx| s.set_text(&text, cx));
                } else {
                    let text = m.text.clone();
                    let msg_id = m.id.clone();
                    let list_for_md = self.list.clone();
                    let st = cx.new(|cx| TextViewState::markdown(&text, cx).selectable(true));
                    cx.observe(&st, move |this, _, cx| {
                        if let Some(ix) = this.rendered_messages.iter().position(|r| r.id == msg_id)
                        {
                            list_for_md.remeasure_items(ix..ix + 1);
                        }
                        cx.notify();
                    })
                    .detach();
                    self.md_states.insert(m.id.clone(), st);
                }
            }
        }
        let md_states = Rc::new(self.md_states.clone());

        let rows = Rc::new(messages);
        let list_for_scroll = self.list.clone();
        let scrolled_away_from_tail = self.scrolled_away_from_tail.clone();
        let role_agent_label = match &current_model_label {
            Some(m_lbl) if !m_lbl.is_empty() => format!("{agent_label} · {m_lbl}"),
            _ => agent_label.clone(),
        };
        let connecting_for_list = acp_connecting;
        let list_el = list(self.list.clone(), move |ix, _, _cx| {
            let row = match rows.get(ix) {
                Some(m) => message_row(
                    ix,
                    m,
                    md_states.get(&m.id),
                    narrow,
                    !collapsed_traces.contains(&m.id),
                    &role_agent_label,
                    weak_for_list.clone(),
                    list_for_re.clone(),
                    state_for_list.clone(),
                    &tid_for_list,
                ),
                None => thinking_row(narrow, connecting_for_list),
            };
            let list = list_for_scroll.clone();
            let scrolled_away_from_tail = scrolled_away_from_tail.clone();
            div()
                .id(("conv-row", ix))
                .on_scroll_wheel(move |event: &gpui::ScrollWheelEvent, window, _cx| {
                    let dy = f32::from(event.delta.pixel_delta(window.line_height()).y);
                    if dy > 0.0 {
                        list.pause_following_tail();
                        scrolled_away_from_tail.set(true);
                    } else if dy < 0.0 && list.is_scrolled_to_end() == Some(true) {
                        list.set_follow_mode(gpui::FollowMode::Tail);
                        scrolled_away_from_tail.set(false);
                    }
                })
                .child(row)
                .into_any_element()
        })
        .flex_1()
        // .conv-msgs 纵向内距在列表自身（横向在每行 ConvIn）
        .pt(px(if narrow { 18.0 } else { 22.0 }))
        .pb(px(12.0));

        let this = cx.entity();
        let filter_query = self.context_filter.read(cx).value().to_string();
        let model_query = self.model_filter.read(cx).value().to_string();
        let resume_query = self.resume_filter.read(cx).value().to_string();
        let (active_trigger, trigger_suggestions) = self.active_trigger_suggestions(cx);
        let selected_suggestion_ix = if trigger_suggestions.is_empty() {
            0
        } else {
            self.trigger_selected_index
                .min(trigger_suggestions.len() - 1)
        };
        // 已彻底移除内部重复的 44px .conv-head，连接状态已并入外层 40px 融合顶栏
        v_flex()
            .size_full()
            .min_w_0()
            .bg(hex(colors::PANE))
            .child(list_el)
            .child(composer(
                &self.input,
                &self.context_filter,
                &filter_query,
                &self.context_files,
                &self.workspace_files,
                self.context_popover_open,
                &self.model_filter,
                &model_query,
                self.model_popover_open,
                &self.resume_filter,
                &resume_query,
                self.resume_popover_open,
                &acp_sessions,
                acp_loading_sessions,
                current_acp_sid.as_deref(),
                &config_selectors,
                acp_connecting,
                active_trigger.as_ref(),
                &trigger_suggestions,
                selected_suggestion_ix,
                pending,
                narrow,
                shell_focused,
                kind,
                &agent_label,
                &acp_agents,
                &self.state,
                &self.thread_id,
                this.downgrade(),
            ))
    }
}

// ── conv-head（保留辅助函数供单元测试验证）────────────────────────────────────────

#[allow(dead_code)]
fn conv_head(kind: ConversationKind, title: &str, pending: bool) -> gpui::Div {
    h_flex()
        .h(px(34.0))
        .flex_shrink_0()
        .gap(px(8.0))
        .px(px(20.0))
        .border_b_1()
        .border_color(hex(colors::BORDER))
        // .conv-avatar：22² r6 surface 块 + accent 图标
        .child(
            div()
                .size(fs(22.0))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .rounded(px(6.0))
                .bg(hex(colors::SURFACE))
                .child(icon(avatar_icon(kind), 12.5, hex(colors::ACCENT))),
        )
        .child(
            div()
                .min_w_0()
                .flex_shrink_1()
                .text_size(fs(12.5))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(hex(colors::TEXT_BRIGHT))
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(title.to_owned()),
        )
        .child(div().flex_1())
        // .conv-status：状态点 + 状态文案
        .child(
            h_flex()
                .flex_shrink_0()
                .gap(px(6.0))
                .items_center()
                .child(div().size(px(7.0)).rounded(px(9999.0)).bg(if pending {
                    hex(colors::STATUS_RUNNING)
                } else {
                    hex(colors::STATUS_DONE)
                }))
                .child(
                    div()
                        .text_size(fs(11.0))
                        .text_color(hex(colors::MUTED))
                        .child(status_text(pending)),
                ),
        )
}

// ── 消息行（原型 .conv-msgs-in / .msg）─────────────────────────────────────

/// 消息行下距（原型 .msg margin-bottom 22）
const MSG_ROW_GAP: f32 = 22.0;
/// thinking 行下距（原型 .thinking margin-bottom 16）
const THINKING_ROW_GAP: f32 = 16.0;
/// ConvIn 内列横距：原型 .conv-msgs-in padding 0 28（窄态 18）
fn conv_in_x_padding(narrow: bool) -> f32 {
    if narrow { 18.0 } else { 28.0 }
}

/// 居中列槽：行根撑满居中 → 内列 min(760,100%) 横距 28（窄 18）。
/// 行距用 `pad_bottom`（padding），margin 在 gpui ListState 测行高时不计入。
fn conv_in(narrow: bool, pad_bottom: f32, child: impl IntoElement) -> gpui::Div {
    div()
        .w_full()
        .flex_shrink_0()
        .flex()
        .justify_center()
        .pb(px(pad_bottom))
        .child(
            div()
                .w_full()
                .max_w(px(760.0))
                .px(px(conv_in_x_padding(narrow)))
                .flex()
                .flex_col()
                .child(child),
        )
}

/// 单条消息行：user 右对齐气泡 / assistant 左对齐（含真实可折叠工具调用链卡片 + role 标签 + markdown）。
#[allow(clippy::too_many_arguments)]
fn message_row(
    ix: usize,
    m: &ChatMessage,
    md_state: Option<&Entity<TextViewState>>,
    narrow: bool,
    trace_open: bool,
    model_label: &str,
    weak: gpui::WeakEntity<ConversationView>,
    list_state: ListState,
    state: Entity<AppState>,
    thread_id: &str,
) -> AnyElement {
    if m.is_user() {
        let bubble = user_bubble_for(&m.id, &m.text);
        return conv_in(
            narrow,
            MSG_ROW_GAP,
            div().w_full().flex().justify_end().child(bubble),
        )
        .into_any_element();
    }
    let mut col = div().w_full().flex().flex_col();
    let role_header = h_flex()
        .mb(px(8.0))
        .gap(px(6.0))
        .items_center()
        .child(icon(
            if m.is_error() {
                IconName::Alert
            } else {
                IconName::Acp
            },
            12.0,
            if m.is_error() {
                hex(colors::BELL)
            } else {
                hex(colors::TERMINAL_KIND)
            },
        ))
        .child(
            div()
                .font_family("monospace")
                .text_size(fs(10.5))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(if m.is_error() {
                    hex(colors::BELL)
                } else {
                    hex(colors::TERMINAL_KIND)
                })
                .child(role_label(m.is_error())),
        )
        .when(!m.is_error() && !model_label.is_empty(), |d| {
            d.child(
                div()
                    .font_family("monospace")
                    .text_size(fs(10.5))
                    .text_color(hex(colors::FAINT))
                    .child(format!("· {model_label}")),
            )
        });
    // 从上往下的信息流顺序：1. Assistant 角色与模型头 → 2. 工具调用执行链卡片 → 3. Markdown 正文回复
    col = col.child(role_header);
    if !m.tool_calls.is_empty() && !m.is_error() {
        col = col.child(tool_trace_card(
            ix,
            &m.id,
            &m.tool_calls,
            trace_open,
            weak,
            list_state,
            state,
            thread_id,
        ));
    }
    if !m.text.trim().is_empty() || m.tool_calls.is_empty() {
        col = col.child(markdown_body_with_state(m, md_state));
    }
    conv_in(narrow, MSG_ROW_GAP, col).into_any_element()
}

/// Agent 工具调用执行链卡片（真实绑定 `ChatMessage::tool_calls`，点击文件打开 `FileSurface`）。
#[allow(clippy::too_many_arguments)]
fn tool_trace_card(
    ix: usize,
    msg_id: &str,
    tool_calls: &[ToolCallTrace],
    trace_open: bool,
    weak: gpui::WeakEntity<ConversationView>,
    list_state: ListState,
    state: Entity<AppState>,
    thread_id: &str,
) -> gpui::Div {
    let mut unique_kinds: Vec<String> = Vec::new();
    for tc in tool_calls {
        let k = tc
            .kind
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("tool");
        let label = uppercase_first(k);
        if !unique_kinds.contains(&label) {
            unique_kinds.push(label);
        }
    }
    let kinds_summary = unique_kinds.join(" · ");
    let all_done = tool_calls.iter().all(|tc| {
        matches!(
            tc.status.as_deref(),
            None | Some("completed" | "done" | "ok" | "success")
        )
    });
    let toggle_msg_id = msg_id.to_owned();
    let mut card = v_flex()
        .mb(px(14.0))
        .rounded(px(9.0))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .bg(hex(colors::INPUT_BG))
        .overflow_hidden()
        .child(
            h_flex()
                .id(gpui::SharedString::from(format!(
                    "conv-trace-toggle-{msg_id}"
                )))
                .debug_selector({
                    let id = msg_id.to_owned();
                    move || format!("conv-trace-toggle-{id}")
                })
                .h(px(32.0))
                .px(px(12.0))
                .items_center()
                .justify_between()
                .bg(rgba_css(24, 28, 39, 0.75))
                .cursor_pointer()
                .child(
                    h_flex()
                        .gap(px(7.0))
                        .items_center()
                        .child(icon(
                            IconName::Check,
                            12.5,
                            if all_done {
                                hex(colors::STATUS_DONE)
                            } else {
                                hex(colors::STATUS_RUNNING)
                            },
                        ))
                        .child(
                            div()
                                .text_size(fs(11.5))
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .text_color(hex(colors::TEXT_BRIGHT))
                                .child(format!("Agent 已执行 {} 个工具调用", tool_calls.len())),
                        )
                        .when(!kinds_summary.is_empty(), |d| {
                            d.child(
                                div()
                                    .font_family("monospace")
                                    .text_size(fs(10.5))
                                    .text_color(hex(colors::FAINT))
                                    .child(kinds_summary),
                            )
                        }),
                )
                .child(
                    h_flex()
                        .gap(px(4.0))
                        .items_center()
                        .text_size(fs(11.5))
                        .text_color(hex(colors::MUTED))
                        .child(if trace_open {
                            "收起详情"
                        } else {
                            "展开详情"
                        })
                        .child(icon(
                            if trace_open {
                                IconName::ChevronUp
                            } else {
                                IconName::ChevronDown
                            },
                            12.0,
                            hex(colors::MUTED),
                        )),
                )
                .on_click(move |_, _, cx| {
                    let _ = weak.update(cx, |v, cx| {
                        if !v.collapsed_traces.remove(&toggle_msg_id) {
                            v.collapsed_traces.insert(toggle_msg_id.clone());
                        }
                        list_state.remeasure_items(ix..ix + 1);
                        cx.notify();
                    });
                }),
        );

    if trace_open {
        for (t_ix, tc) in tool_calls.iter().enumerate() {
            let kind_badge = tc
                .kind
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("TOOL")
                .to_ascii_uppercase();
            let main_label = tc
                .path
                .as_deref()
                .or(tc.title.as_deref())
                .filter(|s| !s.is_empty())
                .unwrap_or(&tc.id)
                .to_owned();
            let status_str = tc
                .status
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("completed")
                .to_owned();
            let status_color = match status_str.as_str() {
                "completed" | "done" | "ok" | "success" => hex(colors::STATUS_DONE),
                "failed" | "error" => hex(colors::STATUS_ERROR),
                _ => hex(colors::STATUS_RUNNING),
            };
            let file_path = tc.path.clone();
            let st_open = state.clone();
            let tid_open = thread_id.to_owned();
            let mut row = h_flex()
                .id(gpui::SharedString::from(format!(
                    "trace-row-{msg_id}-{t_ix}"
                )))
                .h(px(29.0))
                .px(px(12.0))
                .gap(px(8.0))
                .items_center()
                .border_t_1()
                .border_color(hex(colors::BORDER))
                .font_family("monospace")
                .text_size(fs(11.0))
                .child(
                    div()
                        .px(px(5.0))
                        .rounded(px(4.0))
                        .bg(accent_alpha(0.16))
                        .border_1()
                        .border_color(accent_alpha(0.30))
                        .text_size(fs(9.5))
                        .text_color(hex(colors::ACCENT_HOVER))
                        .child(kind_badge),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .child(sel_text_id(
                            gpui::SharedString::from(format!("trace-path-{msg_id}-{t_ix}")),
                            main_label,
                        )),
                )
                .child(
                    h_flex()
                        .gap(px(8.0))
                        .items_center()
                        .flex_shrink_0()
                        .child(
                            div()
                                .text_size(fs(10.0))
                                .text_color(status_color)
                                .child(status_str),
                        )
                        .when(file_path.is_some(), |d| {
                            d.child(
                                div()
                                    .text_size(fs(10.5))
                                    .text_color(hex(colors::ACCENT_HOVER))
                                    .child("打开文件 →"),
                            )
                        }),
                );
            if let Some(path) = file_path {
                row = row
                    .cursor_pointer()
                    .hover(|h| h.bg(hex(colors::SURFACE)))
                    .on_click(move |_, _, cx| {
                        st_open.update(cx, |s, cx| {
                            s.threads.open_session_file(&tid_open, &path);
                            s.flush(cx);
                            cx.emit(StateChanged);
                        });
                    });
            }
            card = card.child(row);
        }
    }
    card
}

fn uppercase_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}

/// user 气泡（原型 .msg.user .bubble）：max 620 / accentSoft 底 /
/// rgba(97,175,239,.28) 边 / 12·12·3·12 圆角 / 0 1 2 投影；换行拆多段可选择 text。
#[allow(dead_code)]
fn user_bubble(text: &str) -> gpui::Div {
    user_bubble_for("user", text)
}

fn user_bubble_for(msg_id: &str, text: &str) -> gpui::Div {
    div()
        .max_w(px(620.0))
        .flex()
        .flex_col()
        .rounded_tl(px(12.0))
        .rounded_tr(px(12.0))
        .rounded_br(px(3.0))
        .rounded_bl(px(12.0))
        .border_1()
        .border_color(accent_alpha(0.32))
        .bg(accent_alpha(0.15))
        .py(px(10.0))
        .px(px(14.0))
        .shadow(bubble_shadow())
        .children(text.split('\n').enumerate().map(|(line_ix, line)| {
            div()
                .text_size(fs(14.0))
                .line_height(px(21.0))
                .text_color(hex(colors::TEXT_BRIGHT))
                .child(if line.is_empty() {
                    " ".into_any_element()
                } else {
                    sel_text_id(
                        gpui::ElementId::Name(format!("user-msg-{msg_id}-{line_ix}").into()),
                        line.to_owned(),
                    )
                    .into_any_element()
                })
        }))
}

/// assistant 正文（.msg .body）：max 700 / 14 / 1.65；error 换 bell。
#[allow(dead_code)]
fn markdown_body(m: &ChatMessage) -> TextView {
    markdown_body_with_state(m, None)
}

fn markdown_body_with_state(m: &ChatMessage, state: Option<&Entity<TextViewState>>) -> TextView {
    let md_style = TextViewStyle::default()
        // 原型 p/ul margin 6+6 相邻合并 = 12px（gpui rem 基准 16）
        .paragraph_gap(rems(0.75))
        // pre：INPUT_BG 深凹底 + borderSubtle 边 + r8 + 13·14 内距
        .code_block(
            gpui::StyleRefinement::default()
                .bg(hex(colors::INPUT_BG))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .rounded(px(8.0))
                .py(px(13.0))
                .px(px(14.0)),
        )
        // inline code：inputBg 底
        .inline_code(HighlightStyle {
            background_color: Some(hex(colors::INPUT_BG)),
            ..Default::default()
        });
    let view = match state {
        Some(st) => TextView::new(st),
        None => TextView::markdown(m.id.clone(), m.text.clone()),
    };
    view.selectable(true)
        .max_w(px(700.0))
        .text_size(fs(14.0))
        .line_height(px(23.1))
        .text_color(if m.is_error() {
            hex(colors::BELL)
        } else {
            hex(colors::TEXT)
        })
        .style(md_style)
}

/// thinking 占位行（原型 .thinking）：accent 圆点 + 4px accentSoft 环。
fn thinking_row(narrow: bool, connecting: bool) -> AnyElement {
    let dot = div()
        .size(px(7.0))
        .flex_shrink_0()
        .rounded(px(9999.0))
        .bg(hex(colors::ACCENT))
        .shadow(thinking_dot_shadow());
    let label = if connecting {
        "正在连接 ACP Agent 并加载工作区环境…"
    } else {
        "正在思考…"
    };
    conv_in(
        narrow,
        THINKING_ROW_GAP,
        h_flex().gap(px(8.0)).child(dot).child(
            div()
                .text_size(fs(12.0))
                .text_color(hex(colors::MUTED))
                .child(label),
        ),
    )
    .into_any_element()
}

// ── composer（原型 .composer / .composer-inner / .composer-shell / .send-btn）────────────────

/// 输入区：与上方 .conv-msgs-in 严格共享 760px 中轴容器（宽屏 px 28 / 窄屏 px 18），100% 居中对齐。
#[allow(clippy::too_many_arguments)]
fn composer(
    input: &Entity<TextareaState>,
    context_filter: &Entity<InputState>,
    filter_query: &str,
    context_files: &[String],
    workspace_files: &[String],
    context_popover_open: bool,
    model_filter: &Entity<InputState>,
    model_query: &str,
    model_popover_open: bool,
    resume_filter: &Entity<InputState>,
    resume_query: &str,
    resume_popover_open: bool,
    acp_sessions: &[AcpSessionSummary],
    acp_loading_sessions: bool,
    current_acp_sid: Option<&str>,
    config_selectors: &[AcpConfigSelector],
    acp_connecting: bool,
    active_trigger: Option<&ComposerTrigger>,
    trigger_suggestions: &[ComposerSuggestion],
    selected_suggestion_ix: usize,
    pending: bool,
    narrow: bool,
    shell_focused: bool,
    kind: ConversationKind,
    agent_label: &str,
    acp_agents: &[AcpAgent],
    state: &Entity<AppState>,
    thread_id: &str,
    this: gpui::WeakEntity<ConversationView>,
) -> gpui::Div {
    let context_chips: Vec<AnyElement> = context_files
        .iter()
        .map(|rel_path| {
            let short = rel_path.rsplit(['/', '\\']).next().unwrap_or(rel_path);
            let remove_path = rel_path.clone();
            let this_rm = this.clone();
            h_flex()
                .id(gpui::SharedString::from(format!("ctx-chip-{rel_path}")))
                .debug_selector({
                    let p = rel_path.clone();
                    move || format!("ctx-chip-{p}")
                })
                .h(px(22.0))
                .px(px(7.0))
                .gap(px(5.0))
                .items_center()
                .rounded(px(5.0))
                .bg(hex(colors::SURFACE))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .font_family("monospace")
                .text_size(fs(11.0))
                .text_color(hex(colors::TEXT_BRIGHT))
                .cursor_pointer()
                .hover(|h| h.bg(hex(colors::SURFACE_HOVER)))
                .child(icon(IconName::File, 11.0, hex(colors::ACCENT_HOVER)))
                .child(format!("@{short}"))
                .child(icon(IconName::Close, 9.5, hex(colors::MUTED)))
                .on_click(move |_, _, cx| {
                    let _ = this_rm.update(cx, |v, cx| {
                        v.toggle_context_file(&remove_path, cx);
                    });
                })
                .into_any_element()
        })
        .collect();

    let add_context_el = context_file_picker(
        context_filter,
        filter_query,
        context_files,
        workspace_files,
        context_popover_open,
        this.clone(),
    );

    let right_controls = acp_toolbar_pills(
        kind,
        agent_label,
        acp_agents,
        config_selectors,
        acp_connecting,
        model_filter,
        model_query,
        model_popover_open,
        resume_filter,
        resume_query,
        resume_popover_open,
        acp_sessions,
        acp_loading_sessions,
        current_acp_sid,
        state,
        thread_id,
        this.clone(),
    );

    let autocomplete_el = active_trigger.map(|trig| {
        composer_autocomplete_panel(
            trig,
            trigger_suggestions,
            selected_suggestion_ix,
            context_files,
            shell_focused,
            this.clone(),
        )
    });

    div()
        .flex_shrink_0()
        .flex()
        .flex_col()
        .items_center()
        .pt(px(6.0))
        .pb(px(12.0))
        .bg(composer_bg())
        .child(
            v_flex()
                .w_full()
                .max_w(px(760.0))
                .px(px(conv_in_x_padding(narrow)))
                .gap(px(5.0))
                .when_some(autocomplete_el, |d, panel| d.child(panel))
                // .composer-shell：inputBg r10 双排盒（上排 @文件上下文 + Agent 选择胶囊，下排 textarea + send 钮）
                .child(
                    v_flex()
                        .w_full()
                        .gap(px(6.0))
                        .py(px(9.0))
                        .px(px(12.0))
                        .border_1()
                        .border_color(if shell_focused {
                            hex(colors::FOCUS_BORDER)
                        } else {
                            hex(colors::BORDER_SUBTLE)
                        })
                        .rounded(px(10.0))
                        .bg(hex(colors::INPUT_BG))
                        .shadow(composer_shadow(shell_focused))
                        // 上排：真实上下文文件胶囊与 Zed ACP 风格控制条（Mode/Thinking + Model + Agent）
                        .child(
                            h_flex()
                                .items_center()
                                .justify_between()
                                .gap(px(6.0))
                                .child(
                                    h_flex()
                                        .flex_1()
                                        .min_w_0()
                                        .flex_wrap()
                                        .items_center()
                                        .gap(px(6.0))
                                        .children(context_chips)
                                        .child(add_context_el),
                                )
                                .child(right_controls),
                        )
                        // 下排：textarea + 发送按钮
                        .child(
                            h_flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    Textarea::new(input)
                                        .appearance(false)
                                        .flex_1()
                                        .min_h(px(24.0))
                                        .text_size(fs(13.0))
                                        .line_height(px(18.0))
                                        .py(px(3.0))
                                        .px(px(2.0))
                                        .text_color(hex(colors::TEXT_BRIGHT)),
                                )
                                .child(send_button(pending, this)),
                        ),
                )
                // .composer-hint：两端对齐 faint 10.5px
                .child(
                    h_flex()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .px(px(2.0))
                        .text_size(fs(10.5))
                        .text_color(hex(colors::FAINT))
                        .child("@ 引用工作区文件 · / 执行快捷指令 · 点击代码块可复制")
                        .child("Enter 发送 · Shift + Enter 换行"),
                ),
        )
}

/// 输入框上方 `/` 斜杠命令与 `@` 工作区文件自动补全浮层面板（支持 ↑/↓ 选择、Enter/Tab 确认、Esc 关闭、鼠标点击）。
fn composer_autocomplete_panel(
    trigger: &ComposerTrigger,
    suggestions: &[ComposerSuggestion],
    selected_ix: usize,
    attached_files: &[String],
    shell_focused: bool,
    this: gpui::WeakEntity<ConversationView>,
) -> AnyElement {
    let has_items = !suggestions.is_empty();
    let capture_active = shell_focused && has_items;
    let this_up = this.clone();
    let this_down = this.clone();
    let this_enter = this.clone();
    let this_tab = this.clone();
    let this_esc = this.clone();

    let key_interceptor = gpui::canvas(
        |_, _, _| (),
        move |_, _, window, _cx| {
            if !capture_active {
                return;
            }
            window.on_action(
                std::any::TypeId::of::<gpui_base::input::MoveUp>(),
                move |_, phase, _window, cx| {
                    if phase == gpui::DispatchPhase::Capture {
                        let _ = this_up.update(cx, |v, cx| v.move_trigger_selection(-1, cx));
                        cx.stop_propagation();
                    }
                },
            );
            window.on_action(
                std::any::TypeId::of::<gpui_base::input::MoveDown>(),
                move |_, phase, _window, cx| {
                    if phase == gpui::DispatchPhase::Capture {
                        let _ = this_down.update(cx, |v, cx| v.move_trigger_selection(1, cx));
                        cx.stop_propagation();
                    }
                },
            );
            window.on_action(
                std::any::TypeId::of::<gpui_base::input::Enter>(),
                move |action, phase, window, cx| {
                    if phase == gpui::DispatchPhase::Capture
                        && let Some(enter) = action.downcast_ref::<gpui_base::input::Enter>()
                        && !enter.shift
                    {
                        let _ =
                            this_enter.update(cx, |v, cx| v.accept_active_suggestion(window, cx));
                        cx.stop_propagation();
                    }
                },
            );
            window.on_action(
                std::any::TypeId::of::<gpui_base::input::IndentInline>(),
                move |_, phase, window, cx| {
                    if phase == gpui::DispatchPhase::Capture {
                        let _ = this_tab.update(cx, |v, cx| v.accept_active_suggestion(window, cx));
                        cx.stop_propagation();
                    }
                },
            );
            window.on_action(
                std::any::TypeId::of::<gpui_base::input::Escape>(),
                move |_, phase, _window, cx| {
                    if phase == gpui::DispatchPhase::Capture {
                        let _ = this_esc.update(cx, |v, cx| v.dismiss_active_trigger(cx));
                        cx.stop_propagation();
                    }
                },
            );
        },
    )
    .size_0()
    .absolute();

    let (title_icon, title_text) = match trigger.kind {
        ComposerTriggerKind::SlashCommand => (IconName::Terminal, "斜杠快捷指令（/）"),
        ComposerTriggerKind::ContextFile => (IconName::File, "引用工作区文件（@）"),
    };
    let attached_set: HashSet<&str> = attached_files.iter().map(String::as_str).collect();

    let mut panel = overlay_shell("conv-autocomplete-panel")
        .debug_selector(|| "conv-autocomplete-panel".to_string())
        .w_full()
        .p(px(6.0))
        .flex()
        .flex_col()
        .gap(px(4.0))
        .child(key_interceptor)
        .child(
            h_flex()
                .px(px(8.0))
                .py(px(3.0))
                .items_center()
                .justify_between()
                .child(
                    h_flex()
                        .gap(px(6.0))
                        .items_center()
                        .font_family("monospace")
                        .text_size(fs(10.5))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(hex(colors::MUTED))
                        .child(icon(title_icon, 11.0, hex(colors::ACCENT_HOVER)))
                        .child(title_text),
                )
                .child(
                    div()
                        .font_family("monospace")
                        .text_size(fs(10.0))
                        .text_color(hex(colors::FAINT))
                        .child("↑↓ 选择 · Enter / Tab 确认 · Esc 关闭"),
                ),
        );

    if suggestions.is_empty() {
        let empty_msg = match trigger.kind {
            ComposerTriggerKind::SlashCommand => "无匹配的斜杠命令",
            ComposerTriggerKind::ContextFile => "无匹配的工作区文件",
        };
        panel = panel.child(
            div()
                .px(px(8.0))
                .py(px(8.0))
                .text_size(fs(11.5))
                .text_color(hex(colors::MUTED))
                .child(empty_msg),
        );
    } else {
        let mut list = v_flex()
            .id("conv-autocomplete-list")
            .max_h(px(210.0))
            .overflow_y_scroll()
            .gap(px(1.5));
        for (ix, item) in suggestions.iter().enumerate() {
            let is_selected = ix == selected_ix;
            let this_click = this.clone();
            let row = match item {
                ComposerSuggestion::SlashCommand(cmd) => {
                    let cmd_label = format!("/{}", cmd.name);
                    let hint = cmd.input_hint.clone();
                    let desc = cmd.description.clone();
                    h_flex()
                        .id(gpui::SharedString::from(format!(
                            "conv-ac-cmd-{}",
                            cmd.name
                        )))
                        .debug_selector({
                            let n = cmd.name.clone();
                            move || format!("conv-ac-cmd-{n}")
                        })
                        .h(px(28.0))
                        .px(px(8.0))
                        .gap(px(8.0))
                        .items_center()
                        .rounded(px(5.0))
                        .cursor_pointer()
                        .when_else(
                            is_selected,
                            |d| d.bg(accent_alpha(0.16)),
                            |d| d.hover(|h| h.bg(hex(colors::SURFACE))),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .font_family("monospace")
                                .text_size(fs(11.5))
                                .font_weight(gpui::FontWeight::SEMIBOLD)
                                .text_color(if is_selected {
                                    hex(colors::ACCENT_HOVER)
                                } else {
                                    hex(colors::TEXT_BRIGHT)
                                })
                                .child(cmd_label),
                        )
                        .when_some(hint, |d, h| {
                            d.child(
                                div()
                                    .flex_shrink_0()
                                    .px(px(5.0))
                                    .py(px(1.0))
                                    .rounded(px(3.5))
                                    .bg(hex(colors::SURFACE))
                                    .font_family("monospace")
                                    .text_size(fs(10.0))
                                    .text_color(hex(colors::MUTED))
                                    .child(h),
                            )
                        })
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_size(fs(11.0))
                                .text_color(hex(colors::MUTED))
                                .child(desc),
                        )
                        .on_click(move |_, window, cx| {
                            cx.stop_propagation();
                            let _ = this_click.update(cx, |v, cx| {
                                v.accept_suggestion_at(ix, window, cx);
                            });
                        })
                }
                ComposerSuggestion::ContextFile(path) => {
                    let short = path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned();
                    let already = attached_set.contains(path.as_str());
                    let full_path = path.clone();
                    h_flex()
                        .id(gpui::SharedString::from(format!("conv-ac-file-{path}")))
                        .debug_selector({
                            let p = path.clone();
                            move || format!("conv-ac-file-{p}")
                        })
                        .h(px(27.0))
                        .px(px(8.0))
                        .gap(px(7.0))
                        .items_center()
                        .rounded(px(5.0))
                        .cursor_pointer()
                        .when_else(
                            is_selected,
                            |d| d.bg(accent_alpha(0.16)),
                            |d| d.hover(|h| h.bg(hex(colors::SURFACE))),
                        )
                        .child(icon(
                            if already {
                                IconName::Check
                            } else {
                                IconName::File
                            },
                            11.5,
                            if is_selected || already {
                                hex(colors::ACCENT_HOVER)
                            } else {
                                hex(colors::MUTED)
                            },
                        ))
                        .child(
                            div()
                                .flex_shrink_0()
                                .font_family("monospace")
                                .text_size(fs(11.5))
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .text_color(if is_selected {
                                    hex(colors::TEXT_BRIGHT)
                                } else {
                                    hex(colors::TEXT)
                                })
                                .child(format!("@{short}")),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .font_family("monospace")
                                .text_size(fs(10.5))
                                .text_color(hex(colors::FAINT))
                                .child(full_path),
                        )
                        .on_click(move |_, window, cx| {
                            cx.stop_propagation();
                            let _ = this_click.update(cx, |v, cx| {
                                v.accept_suggestion_at(ix, window, cx);
                            });
                        })
                }
            };
            list = list.child(row);
        }
        panel = panel.child(list);
    }

    panel.into_any_element()
}

/// 「+ 添加上下文」工作区文件选择浮层。
fn context_file_picker(
    filter_input: &Entity<InputState>,
    filter_query: &str,
    selected_files: &[String],
    workspace_files: &[String],
    popover_open: bool,
    this: gpui::WeakEntity<ConversationView>,
) -> AnyElement {
    let q = filter_query.trim().to_lowercase();
    let candidates: Vec<String> = workspace_files
        .iter()
        .filter(|p| q.is_empty() || p.to_lowercase().contains(&q))
        .take(40)
        .cloned()
        .collect();
    let selected_set: HashSet<String> = selected_files.iter().cloned().collect();
    let filter_entity = filter_input.clone();
    let this_open = this.clone();
    let this_content = this.clone();
    let this_trigger = this;

    let pop = Popover::new("conv-context-popover")
        .open(popover_open)
        .anchor(gpui::Anchor::BottomLeft)
        .offset(px(6.0))
        .on_open_change(move |open, _, cx| {
            let _ = this_open.update(cx, |v, cx| {
                v.context_popover_open = *open;
                cx.notify();
            });
        })
        .trigger(PopupTrigger::new(|_| {
            div()
                .id("conv-ctx-pop-anchor")
                .size(px(0.0))
                .into_any_element()
        }))
        .content(move |_, _, _| {
            let mut panel = overlay_shell("conv-context-pop")
                .debug_selector(|| "conv-context-pop".to_string())
                .w(px(300.0))
                .p(px(6.0))
                .flex()
                .flex_col()
                .gap(px(4.0));
            panel = panel.child(
                h_flex()
                    .h(px(28.0))
                    .px(px(8.0))
                    .gap(px(6.0))
                    .items_center()
                    .rounded(px(6.0))
                    .bg(hex(colors::INPUT_BG))
                    .border_1()
                    .border_color(hex(colors::BORDER_SUBTLE))
                    .child(icon(IconName::Search, 12.0, hex(colors::MUTED)))
                    .child(
                        div().flex_1().min_w_0().child(
                            Input::new(&filter_entity)
                                .appearance(false)
                                .h_full()
                                .text_size(fs(11.5))
                                .text_color(hex(colors::TEXT_BRIGHT)),
                        ),
                    ),
            );
            if candidates.is_empty() {
                panel = panel.child(
                    div()
                        .py(px(12.0))
                        .px(px(8.0))
                        .text_size(fs(11.5))
                        .text_color(hex(colors::MUTED))
                        .child("无匹配的工作区文件"),
                );
            } else {
                let mut list = v_flex()
                    .id("conv-context-file-list")
                    .max_h(px(210.0))
                    .overflow_y_scroll()
                    .gap(px(1.5));
                for path in &candidates {
                    let is_picked = selected_set.contains(path);
                    let path_click = path.clone();
                    let this_pick = this_content.clone();
                    list = list.child(
                        h_flex()
                            .id(gpui::SharedString::from(format!("ctx-opt-{path}")))
                            .debug_selector({
                                let p = path.clone();
                                move || format!("ctx-opt-{p}")
                            })
                            .h(px(26.0))
                            .px(px(8.0))
                            .gap(px(6.0))
                            .items_center()
                            .rounded(px(5.0))
                            .cursor_pointer()
                            .when_else(
                                is_picked,
                                |d| d.bg(accent_alpha(0.14)),
                                |d| d.hover(|h| h.bg(hex(colors::SURFACE))),
                            )
                            .child(icon(
                                if is_picked {
                                    IconName::Check
                                } else {
                                    IconName::File
                                },
                                11.5,
                                if is_picked {
                                    hex(colors::ACCENT_HOVER)
                                } else {
                                    hex(colors::MUTED)
                                },
                            ))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .font_family("monospace")
                                    .text_size(fs(11.0))
                                    .text_color(if is_picked {
                                        hex(colors::TEXT_BRIGHT)
                                    } else {
                                        hex(colors::TEXT)
                                    })
                                    .child(path.clone()),
                            )
                            .on_click(move |_, _, cx| {
                                cx.stop_propagation();
                                let _ = this_pick.update(cx, |v, cx| {
                                    v.toggle_context_file(&path_click, cx);
                                });
                            }),
                    );
                }
                panel = panel.child(list);
            }
            panel.into_any_element()
        });

    h_flex()
        .id("conv-add-context")
        .debug_selector(|| "conv-add-context".to_string())
        .h(px(22.0))
        .px(px(7.0))
        .gap(px(4.0))
        .items_center()
        .rounded(px(5.0))
        .border_1()
        .border_color(if popover_open {
            hex(colors::ACCENT)
        } else {
            hex(colors::BORDER_SUBTLE)
        })
        .when(popover_open, |d| d.bg(hex(colors::SURFACE)))
        .when(!popover_open, |d| d.hover(|h| h.bg(hex(colors::SURFACE))))
        .text_size(fs(11.0))
        .text_color(hex(colors::MUTED))
        .cursor_pointer()
        .child(icon(IconName::Plus, 10.5, hex(colors::MUTED)))
        .child("添加上下文")
        .child(pop)
        .on_click(move |_, _, cx| {
            if popover_open {
                return;
            }
            let _ = this_trigger.update(cx, |v, cx| {
                v.ensure_workspace_files(cx);
                v.context_popover_open = true;
                cx.notify();
            });
        })
        .into_any_element()
}

/// 右侧 Zed ACP 风格控制栏：历史会话恢复（/resume）+ Mode/Thinking 选择器 + Model 选择器 + Agent 选择器。
#[allow(clippy::too_many_arguments)]
fn acp_toolbar_pills(
    kind: ConversationKind,
    agent_label: &str,
    acp_agents: &[AcpAgent],
    config_selectors: &[AcpConfigSelector],
    acp_connecting: bool,
    model_filter: &Entity<InputState>,
    model_query: &str,
    model_popover_open: bool,
    resume_filter: &Entity<InputState>,
    resume_query: &str,
    resume_popover_open: bool,
    acp_sessions: &[AcpSessionSummary],
    acp_loading_sessions: bool,
    current_acp_sid: Option<&str>,
    state: &Entity<AppState>,
    thread_id: &str,
    this: gpui::WeakEntity<ConversationView>,
) -> AnyElement {
    if kind != ConversationKind::Acp {
        return agent_selector_pill(kind, agent_label, acp_agents, state, thread_id);
    }

    let mut row = h_flex().items_center().gap(px(5.0)).flex_shrink_0();

    // 0. 恢复历史会话（对应 `/resume` / `session/list` + `session/load`）
    row = row.child(resume_session_pill(
        resume_filter,
        resume_query,
        resume_popover_open,
        acp_sessions,
        acp_loading_sessions,
        current_acp_sid,
        state,
        thread_id,
        this.clone(),
    ));

    // 1. Mode / Thinking 等级选择器（如 Thinking: low / medium / high）
    for sel in config_selectors.iter().filter(|s| !s.is_model()) {
        row = row.child(config_option_pill(sel, state, thread_id));
    }

    // 2. Model 选择器（带搜索框 + Provider 分组的 Zed ACP 浮层）
    if let Some(model_sel) = config_selectors.iter().find(|s| s.is_model()) {
        row = row.child(model_selector_pill(
            model_sel,
            model_filter,
            model_query,
            model_popover_open,
            state,
            thread_id,
            this,
        ));
    } else {
        let st_connect = state.clone();
        let tid_connect = thread_id.to_owned();
        row = row.child(
            h_flex()
                .id("conv-acp-model-connect")
                .debug_selector(|| "conv-acp-model-connect".to_string())
                .h(px(22.0))
                .px(px(8.0))
                .gap(px(4.0))
                .items_center()
                .rounded(px(5.0))
                .bg(hex(colors::SURFACE))
                .border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .hover(|h| h.bg(hex(colors::SURFACE_HOVER)))
                .font_family("monospace")
                .text_size(fs(10.5))
                .text_color(hex(colors::MUTED))
                .cursor_pointer()
                .child(icon(IconName::Agent, 10.5, hex(colors::MUTED)))
                .child(if acp_connecting {
                    "加载模型中…"
                } else {
                    "加载模型"
                })
                .on_click(move |_, _, cx| {
                    ensure_acp_connected(&st_connect, &tid_connect, cx);
                }),
        );
    }

    // 3. ACP Agent 选择器（Pi / Codex / Claude）
    row = row.child(agent_selector_pill(
        kind,
        agent_label,
        acp_agents,
        state,
        thread_id,
    ));

    row.into_any_element()
}

/// 格式化 `session/list` 返回的 ISO-8601 时间（如 `"2026-10-17T08:30:00.000Z"` → `"10-17 08:30"`）。
fn format_session_updated_at(iso: Option<&str>) -> String {
    let Some(s) = iso.map(str::trim).filter(|s| !s.is_empty()) else {
        return String::new();
    };
    if let Some((date, time)) = s.split_once('T') {
        let short_date = if date.len() >= 10 { &date[5..10] } else { date };
        let short_time = if time.len() >= 5 { &time[..5] } else { time };
        return format!("{short_date} {short_time}");
    }
    s.chars().take(16).collect()
}

/// 历史会话恢复胶囊与浮层（对应 `/resume` 命令，对接 ACP `session/list` + `session/load`）。
#[allow(clippy::too_many_arguments)]
fn resume_session_pill(
    filter_input: &Entity<InputState>,
    filter_query: &str,
    popover_open: bool,
    sessions: &[AcpSessionSummary],
    loading: bool,
    current_sid: Option<&str>,
    state: &Entity<AppState>,
    thread_id: &str,
    this: gpui::WeakEntity<ConversationView>,
) -> AnyElement {
    let q = filter_query.trim().to_lowercase();
    let filtered: Vec<AcpSessionSummary> = sessions
        .iter()
        .filter(|s| {
            q.is_empty()
                || s.title
                    .as_deref()
                    .is_some_and(|t| t.to_lowercase().contains(&q))
                || s.session_id.to_lowercase().contains(&q)
        })
        .cloned()
        .collect();

    let cur_sid_owned = current_sid.map(str::to_owned);
    let filter_entity = filter_input.clone();
    let this_open = this.clone();
    let this_pick = this.clone();
    let this_trigger = this;
    let state_pick = state.clone();
    let state_refresh = state.clone();
    let tid_pick = thread_id.to_owned();
    let tid_refresh = thread_id.to_owned();

    let pop = Popover::new("conv-acp-resume-popover")
        .open(popover_open)
        .anchor(gpui::Anchor::BottomRight)
        .offset(px(6.0))
        .on_open_change(move |open, _, cx| {
            let _ = this_open.update(cx, |v, cx| {
                v.resume_popover_open = *open;
                cx.notify();
            });
        })
        .trigger(PopupTrigger::new(|_| {
            div()
                .id("conv-resume-pop-anchor")
                .size(px(0.0))
                .into_any_element()
        }))
        .content(move |_, _, _| {
            let mut panel = overlay_shell("conv-acp-resume-pop")
                .debug_selector(|| "conv-acp-resume-pop".to_string())
                .w(px(360.0))
                .p(px(6.0))
                .flex()
                .flex_col()
                .gap(px(4.0));

            let st_ref = state_refresh.clone();
            let tid_ref = tid_refresh.clone();
            panel = panel.child(
                h_flex()
                    .px(px(6.0))
                    .py(px(2.0))
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .font_family("monospace")
                            .text_size(fs(10.5))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(hex(colors::MUTED))
                            .child("恢复历史会话 (/resume)"),
                    )
                    .child(
                        h_flex()
                            .id("conv-resume-refresh")
                            .gap(px(4.0))
                            .px(px(5.0))
                            .py(px(2.0))
                            .rounded(px(4.0))
                            .cursor_pointer()
                            .hover(|h| h.bg(hex(colors::SURFACE)))
                            .text_size(fs(10.5))
                            .text_color(hex(colors::MUTED))
                            .child(icon(IconName::Reset, 10.0, hex(colors::MUTED)))
                            .child(if loading { "刷新中…" } else { "刷新" })
                            .on_click(move |_, _, cx| {
                                cx.stop_propagation();
                                fetch_acp_session_list(&st_ref, &tid_ref, cx);
                            }),
                    ),
            );

            panel = panel.child(
                h_flex()
                    .h(px(28.0))
                    .px(px(8.0))
                    .gap(px(6.0))
                    .items_center()
                    .rounded(px(6.0))
                    .bg(hex(colors::INPUT_BG))
                    .border_1()
                    .border_color(hex(colors::BORDER_SUBTLE))
                    .child(icon(IconName::Search, 12.0, hex(colors::MUTED)))
                    .child(
                        div().flex_1().min_w_0().child(
                            Input::new(&filter_entity)
                                .appearance(false)
                                .h_full()
                                .text_size(fs(11.5))
                                .text_color(hex(colors::TEXT_BRIGHT)),
                        ),
                    ),
            );

            if loading && filtered.is_empty() {
                panel = panel.child(
                    div()
                        .py(px(12.0))
                        .px(px(8.0))
                        .text_size(fs(11.5))
                        .text_color(hex(colors::MUTED))
                        .child("正在读取历史会话列表…"),
                );
            } else if filtered.is_empty() {
                panel = panel.child(
                    div()
                        .py(px(12.0))
                        .px(px(8.0))
                        .text_size(fs(11.5))
                        .text_color(hex(colors::MUTED))
                        .child("当前工作区暂无可恢复的历史会话"),
                );
            } else {
                let mut list = v_flex()
                    .id("conv-acp-resume-list")
                    .max_h(px(260.0))
                    .overflow_y_scroll()
                    .gap(px(2.0));
                for item in &filtered {
                    let is_current = cur_sid_owned.as_deref() == Some(item.session_id.as_str());
                    let display_title = item
                        .title
                        .clone()
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| {
                            format!("会话 {}", &item.session_id[..item.session_id.len().min(8)])
                        });
                    let time_str = format_session_updated_at(item.updated_at.as_deref());
                    let short_id: String = item.session_id.chars().take(8).collect();
                    let sid_click = item.session_id.clone();
                    let title_click = item.title.clone();
                    let st_click = state_pick.clone();
                    let tid_click = tid_pick.clone();
                    let this_close = this_pick.clone();

                    list = list.child(
                        h_flex()
                            .id(gpui::SharedString::from(format!(
                                "acp-resume-opt-{}",
                                item.session_id
                            )))
                            .debug_selector({
                                let id = item.session_id.clone();
                                move || format!("acp-resume-opt-{id}")
                            })
                            .py(px(5.0))
                            .px(px(8.0))
                            .gap(px(6.0))
                            .items_center()
                            .rounded(px(5.0))
                            .cursor_pointer()
                            .when_else(
                                is_current,
                                |d| d.bg(accent_alpha(0.16)),
                                |d| d.hover(|h| h.bg(hex(colors::SURFACE))),
                            )
                            .child(if is_current {
                                icon(IconName::Check, 11.5, hex(colors::ACCENT_HOVER))
                                    .into_any_element()
                            } else {
                                icon(IconName::Acp, 11.5, hex(colors::MUTED)).into_any_element()
                            })
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .gap(px(1.5))
                                    .child(
                                        div()
                                            .w_full()
                                            .overflow_hidden()
                                            .whitespace_nowrap()
                                            .text_ellipsis()
                                            .text_size(fs(11.5))
                                            .text_color(if is_current {
                                                hex(colors::TEXT_BRIGHT)
                                            } else {
                                                hex(colors::TEXT)
                                            })
                                            .child(display_title),
                                    )
                                    .child(
                                        h_flex()
                                            .gap(px(6.0))
                                            .items_center()
                                            .font_family("monospace")
                                            .text_size(fs(10.0))
                                            .text_color(hex(colors::FAINT))
                                            .child(format!("#{short_id}"))
                                            .when(!time_str.is_empty(), |d| d.child(time_str)),
                                    ),
                            )
                            .on_click(move |_, _, cx| {
                                cx.stop_propagation();
                                resume_acp_session(
                                    &st_click,
                                    &tid_click,
                                    &sid_click,
                                    title_click.clone(),
                                    cx,
                                );
                                let _ = this_close.update(cx, |v, cx| {
                                    v.resume_popover_open = false;
                                    cx.notify();
                                });
                            }),
                    );
                }
                panel = panel.child(list);
            }
            panel.into_any_element()
        });

    h_flex()
        .id("conv-acp-resume-picker")
        .debug_selector(|| "conv-acp-resume-picker".to_string())
        .h(px(22.0))
        .px(px(7.5))
        .gap(px(4.0))
        .items_center()
        .rounded(px(5.0))
        .bg(if popover_open {
            hex(colors::SURFACE_HOVER)
        } else {
            hex(colors::SURFACE)
        })
        .border_1()
        .border_color(if popover_open {
            hex(colors::ACCENT)
        } else {
            hex(colors::BORDER_SUBTLE)
        })
        .when(!popover_open, |d| {
            d.hover(|h| h.bg(hex(colors::SURFACE_HOVER)))
        })
        .font_family("monospace")
        .text_size(fs(10.5))
        .text_color(hex(colors::MUTED))
        .cursor_pointer()
        .child(icon(IconName::Reset, 10.0, hex(colors::MUTED)))
        .child(if loading {
            "恢复中…"
        } else {
            "恢复会话"
        })
        .child(pop)
        .on_click(move |_, window, cx| {
            if popover_open {
                return;
            }
            let _ = this_trigger.update(cx, |v, cx| {
                v.open_resume_picker(None, window, cx);
            });
        })
        .into_any_element()
}

/// 通用 ACP 配置项下拉胶囊（用于 `thought_level` / `mode` 等非模型项）。
fn config_option_pill(
    sel: &AcpConfigSelector,
    state: &Entity<AppState>,
    thread_id: &str,
) -> AnyElement {
    let config_id = sel.id.clone();
    let current_val = sel.current_value.clone();
    let display_label = sel.short_current_label();
    let entries: Vec<MenuEntry> = sel
        .options
        .iter()
        .map(|opt| {
            let mut item = MenuItem::new(opt.value.clone(), opt.name.clone());
            if opt.value == current_val {
                item = item.icon(IconName::Check);
            }
            if let Some(desc) = &opt.description {
                item = item.shortcut(desc.clone());
            }
            MenuEntry::Item(item)
        })
        .collect();
    let state_pick = state.clone();
    let tid_pick = thread_id.to_owned();
    let cid_pick = config_id.clone();
    let pop_id = gpui::SharedString::from(format!("conv-acp-cfg-pop-{config_id}"));
    let btn_id = gpui::SharedString::from(format!("conv-acp-cfg-{config_id}"));
    let debug_id = format!("conv-acp-cfg-{config_id}");

    menu_popover(
        pop_id,
        entries,
        move |picked_val, _, cx| {
            set_acp_config_option(&state_pick, &tid_pick, &cid_pick, picked_val, cx);
        },
        move |open| {
            let dbg = debug_id.clone();
            h_flex()
                .id(btn_id.clone())
                .debug_selector(move || dbg.clone())
                .h(px(22.0))
                .px(px(7.5))
                .gap(px(4.0))
                .items_center()
                .rounded(px(5.0))
                .bg(if open {
                    hex(colors::SURFACE_HOVER)
                } else {
                    hex(colors::SURFACE)
                })
                .border_1()
                .border_color(if open {
                    hex(colors::ACCENT)
                } else {
                    hex(colors::BORDER_SUBTLE)
                })
                .hover(|h| h.bg(hex(colors::SURFACE_HOVER)))
                .font_family("monospace")
                .text_size(fs(10.5))
                .text_color(hex(colors::TEXT))
                .cursor_pointer()
                .child(display_label.clone())
                .child(icon(IconName::ChevronDown, 10.0, hex(colors::MUTED)))
                .into_any_element()
        },
    )
    .into_any_element()
}

/// Zed ACP 风格模型选择器胶囊与浮层（支持按模型名或 Provider 搜索过滤 + Provider 分组展示）。
fn model_selector_pill(
    model_sel: &AcpConfigSelector,
    filter_input: &Entity<InputState>,
    filter_query: &str,
    popover_open: bool,
    state: &Entity<AppState>,
    thread_id: &str,
    this: gpui::WeakEntity<ConversationView>,
) -> AnyElement {
    let q = filter_query.trim().to_lowercase();
    let filtered_options: Vec<_> = model_sel
        .options
        .iter()
        .filter(|opt| {
            q.is_empty()
                || opt.name.to_lowercase().contains(&q)
                || opt.value.to_lowercase().contains(&q)
                || opt
                    .group
                    .as_deref()
                    .is_some_and(|g| g.to_lowercase().contains(&q))
        })
        .cloned()
        .collect();

    let current_val = model_sel.current_value.clone();
    let config_id = model_sel.id.clone();
    let pill_label = model_sel.short_current_label();
    let provider_badge = model_sel.current_group().map(str::to_owned);

    let filter_entity = filter_input.clone();
    let this_open = this.clone();
    let this_pick = this.clone();
    let this_trigger = this;
    let state_pick = state.clone();
    let tid_pick = thread_id.to_owned();

    let pop = Popover::new("conv-acp-model-popover")
        .open(popover_open)
        .anchor(gpui::Anchor::BottomRight)
        .offset(px(6.0))
        .on_open_change(move |open, _, cx| {
            let _ = this_open.update(cx, |v, cx| {
                v.model_popover_open = *open;
                cx.notify();
            });
        })
        .trigger(PopupTrigger::new(|_| {
            div()
                .id("conv-model-pop-anchor")
                .size(px(0.0))
                .into_any_element()
        }))
        .content(move |_, _, _| {
            let mut panel = overlay_shell("conv-acp-model-pop")
                .debug_selector(|| "conv-acp-model-pop".to_string())
                .w(px(320.0))
                .p(px(6.0))
                .flex()
                .flex_col()
                .gap(px(4.0));
            panel = panel.child(
                h_flex()
                    .h(px(28.0))
                    .px(px(8.0))
                    .gap(px(6.0))
                    .items_center()
                    .rounded(px(6.0))
                    .bg(hex(colors::INPUT_BG))
                    .border_1()
                    .border_color(hex(colors::BORDER_SUBTLE))
                    .child(icon(IconName::Search, 12.0, hex(colors::MUTED)))
                    .child(
                        div().flex_1().min_w_0().child(
                            Input::new(&filter_entity)
                                .appearance(false)
                                .h_full()
                                .text_size(fs(11.5))
                                .text_color(hex(colors::TEXT_BRIGHT)),
                        ),
                    ),
            );
            if filtered_options.is_empty() {
                panel = panel.child(
                    div()
                        .py(px(12.0))
                        .px(px(8.0))
                        .text_size(fs(11.5))
                        .text_color(hex(colors::MUTED))
                        .child("无匹配的模型"),
                );
            } else {
                let mut list = v_flex()
                    .id("conv-acp-model-list")
                    .max_h(px(260.0))
                    .overflow_y_scroll()
                    .gap(px(1.5));
                let mut last_group: Option<String> = None;
                for opt in &filtered_options {
                    if let Some(g) = &opt.group
                        && last_group.as_deref() != Some(g.as_str())
                    {
                        last_group = Some(g.clone());
                        list = list.child(
                            div()
                                .px(px(8.0))
                                .pt(px(5.0))
                                .pb(px(2.0))
                                .font_family("monospace")
                                .text_size(fs(9.5))
                                .font_weight(gpui::FontWeight::SEMIBOLD)
                                .text_color(hex(colors::FAINT))
                                .child(g.to_uppercase()),
                        );
                    }
                    let is_picked = opt.value == current_val;
                    let val_click = opt.value.clone();
                    let cid_click = config_id.clone();
                    let st_click = state_pick.clone();
                    let tid_click = tid_pick.clone();
                    let this_close = this_pick.clone();
                    list = list.child(
                        h_flex()
                            .id(gpui::SharedString::from(format!(
                                "acp-model-opt-{}",
                                opt.value
                            )))
                            .debug_selector({
                                let v = opt.value.clone();
                                move || format!("acp-model-opt-{v}")
                            })
                            .h(px(27.0))
                            .px(px(8.0))
                            .gap(px(6.0))
                            .items_center()
                            .rounded(px(5.0))
                            .cursor_pointer()
                            .when_else(
                                is_picked,
                                |d| d.bg(accent_alpha(0.16)),
                                |d| d.hover(|h| h.bg(hex(colors::SURFACE))),
                            )
                            .child(if is_picked {
                                icon(IconName::Check, 11.5, hex(colors::ACCENT_HOVER))
                                    .into_any_element()
                            } else {
                                div().w(fs(11.5)).flex_shrink_0().into_any_element()
                            })
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .text_size(fs(11.5))
                                    .text_color(if is_picked {
                                        hex(colors::TEXT_BRIGHT)
                                    } else {
                                        hex(colors::TEXT)
                                    })
                                    .child(opt.name.clone()),
                            )
                            .when_some(opt.group.as_ref(), |d, g| {
                                d.child(
                                    div()
                                        .flex_shrink_0()
                                        .font_family("monospace")
                                        .text_size(fs(10.0))
                                        .text_color(hex(colors::FAINT))
                                        .child(g.clone()),
                                )
                            })
                            .on_click(move |_, _, cx| {
                                cx.stop_propagation();
                                set_acp_config_option(
                                    &st_click, &tid_click, &cid_click, &val_click, cx,
                                );
                                let _ = this_close.update(cx, |v, cx| {
                                    v.model_popover_open = false;
                                    cx.notify();
                                });
                            }),
                    );
                }
                panel = panel.child(list);
            }
            panel.into_any_element()
        });

    h_flex()
        .id("conv-acp-model-picker")
        .debug_selector(|| "conv-acp-model-picker".to_string())
        .h(px(22.0))
        .px(px(8.0))
        .gap(px(5.0))
        .items_center()
        .rounded(px(5.0))
        .bg(if popover_open {
            hex(colors::SURFACE_HOVER)
        } else {
            hex(colors::SURFACE)
        })
        .border_1()
        .border_color(if popover_open {
            hex(colors::ACCENT)
        } else {
            hex(colors::BORDER_SUBTLE)
        })
        .when(!popover_open, |d| {
            d.hover(|h| h.bg(hex(colors::SURFACE_HOVER)))
        })
        .font_family("monospace")
        .text_size(fs(10.5))
        .text_color(hex(colors::TEXT_BRIGHT))
        .cursor_pointer()
        .child(icon(IconName::Agent, 11.0, hex(colors::ACCENT_HOVER)))
        .when_some(provider_badge, |d, prov| {
            d.child(
                div()
                    .text_color(hex(colors::MUTED))
                    .child(format!("{prov} /")),
            )
        })
        .child(
            div()
                .max_w(px(180.0))
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(pill_label),
        )
        .child(icon(IconName::ChevronDown, 10.5, hex(colors::MUTED)))
        .child(pop)
        .on_click(move |_, _, cx| {
            if popover_open {
                return;
            }
            let _ = this_trigger.update(cx, |v, cx| {
                v.model_popover_open = true;
                cx.notify();
            });
        })
        .into_any_element()
}

/// 右侧 ACP Agent 选择胶囊（可下拉切换 `settings.acp_agents`，若当前为 Chat 会话选中后自动升级为 ACP）。
fn agent_selector_pill(
    _kind: ConversationKind,
    agent_label: &str,
    acp_agents: &[AcpAgent],
    state: &Entity<AppState>,
    thread_id: &str,
) -> AnyElement {
    let label = agent_label.to_owned();
    if acp_agents.is_empty() {
        return h_flex()
            .id("conv-model-switch")
            .h(px(22.0))
            .px(px(8.0))
            .gap(px(5.0))
            .items_center()
            .rounded(px(5.0))
            .bg(accent_alpha(0.10))
            .border_1()
            .border_color(accent_alpha(0.24))
            .font_family("monospace")
            .text_size(fs(10.5))
            .text_color(hex(colors::MUTED))
            .child(icon(IconName::Chat, 11.0, hex(colors::ACCENT_HOVER)))
            .child(label)
            .into_any_element();
    }

    let entries: Vec<MenuEntry> = acp_agents
        .iter()
        .map(|ag| {
            let cmd = jagent_core::new_session::acp_command_summary(ag);
            MenuEntry::Item(
                MenuItem::new(ag.id.clone(), ag.label.clone())
                    .icon(IconName::Acp)
                    .shortcut(cmd),
            )
        })
        .collect();
    let agents_snapshot = acp_agents.to_vec();
    let state_pick = state.clone();
    let tid_pick = thread_id.to_owned();

    menu_popover(
        "conv-agent-popover",
        entries,
        move |picked_id, _, cx| {
            let Some(ag) = agents_snapshot.iter().find(|a| a.id == picked_id) else {
                return;
            };
            let new_id = ag.id.clone();
            let new_label = ag.label.clone();
            state_pick.update(cx, |s, cx| {
                s.switch_acp_agent(&tid_pick, &new_id, &new_label, cx);
                cx.emit(StateChanged);
            });
            #[cfg(not(test))]
            ensure_acp_connected(&state_pick, &tid_pick, cx);
        },
        move |open| {
            h_flex()
                .id("conv-model-switch")
                .debug_selector(|| "conv-model-switch".to_string())
                .h(px(22.0))
                .px(px(8.0))
                .gap(px(5.0))
                .items_center()
                .rounded(px(5.0))
                .bg(if open {
                    accent_alpha(0.22)
                } else {
                    accent_alpha(0.12)
                })
                .border_1()
                .border_color(accent_alpha(0.32))
                .font_family("monospace")
                .text_size(fs(10.5))
                .text_color(hex(colors::ACCENT_HOVER))
                .cursor_pointer()
                .child(icon(IconName::Acp, 11.0, hex(colors::ACCENT_HOVER)))
                .child(label.clone())
                .child(icon(IconName::ChevronDown, 10.5, hex(colors::ACCENT_HOVER)))
                .into_any_element()
        },
    )
    .into_any_element()
}

/// 发送钮（原型 .send-btn 28² / r7 / accent 底 + 白箭头；
/// pending → surface 底 / borderSubtle 边 / muted 箭头）。
fn send_button(
    pending: bool,
    this: gpui::WeakEntity<ConversationView>,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id("chat-send")
        .flex()
        .items_center()
        .justify_center()
        .size(fs(28.0))
        .flex_shrink_0()
        .border_1()
        .rounded(px(7.0))
        .border_color(if pending {
            hex(colors::BORDER_SUBTLE)
        } else {
            hex(colors::ACCENT)
        })
        .bg(if pending {
            hex(colors::SURFACE)
        } else {
            hex(colors::ACCENT)
        })
        .when(!pending, |d| d.hover(|h| h.bg(hex(colors::ACCENT_HOVER))))
        .child(icon(
            IconName::ArrowRight,
            14.0,
            if pending {
                hex(colors::MUTED)
            } else {
                hex(colors::TEXT_BRIGHT)
            },
        ))
        .on_click(move |_, window, cx| {
            let _ = this.update(cx, |v, cx| v.send(window, cx));
        })
}

// ── 可测的映射 / 投影常量 ────────────────────────────────────────────────────

/// composer 底渐变：原型 `linear-gradient(to top, var(--pane) 75%, transparent)`。
fn composer_bg() -> gpui::Background {
    let mut transparent_pane = hex(colors::PANE);
    transparent_pane.a = 0.0;
    linear_gradient(
        0.0, // to top
        linear_color_stop(hex(colors::PANE), 0.75),
        linear_color_stop(transparent_pane, 1.0),
    )
}

/// composer-shell 投影。原型 :focus-within 是双阴影（3px accentSoft 环 + 下落影），
/// gpui 单阴影取环；非焦点 = `0 8px 24px rgba(0,0,0,.2)` 下落影。
fn composer_shadow(focused: bool) -> Vec<BoxShadow> {
    if focused {
        vec![BoxShadow::new(px(0.0), px(0.0), accent_soft()).spread_radius(px(3.0))]
    } else {
        vec![BoxShadow::new(px(0.0), px(8.0), black(0.2)).blur_radius(px(24.0))]
    }
}

/// user 气泡投影：`0 1px 2px rgba(0,0,0,.2)`。
fn bubble_shadow() -> Vec<BoxShadow> {
    vec![BoxShadow::new(px(0.0), px(1.0), black(0.2)).blur_radius(px(2.0))]
}

/// thinking 圆点环：`0 0 0 4px var(--accentSoft)`。
fn thinking_dot_shadow() -> Vec<BoxShadow> {
    vec![BoxShadow::new(px(0.0), px(0.0), accent_soft()).spread_radius(px(4.0))]
}

/// accentSoft = rgba(99,102,241,.15)（Obsidian Indigo）。
fn accent_soft() -> Hsla {
    accent_alpha(0.15)
}

fn black(a: f32) -> Hsla {
    gpui::hsla(0.0, 0.0, 0.0, a)
}

/// 占位符随线程类型（原型 ConversationView 的 ph）。
#[allow(dead_code)]
fn placeholder_for(kind: ConversationKind) -> &'static str {
    match kind {
        ConversationKind::Acp => "Ask agent…",
        ConversationKind::Chat => "Ask…",
    }
}

/// conv-avatar 图标：chat = agent / acp = acp（色恒 accent，不换紫）。
fn avatar_icon(kind: ConversationKind) -> IconName {
    match kind {
        ConversationKind::Acp => IconName::Acp,
        ConversationKind::Chat => IconName::Agent,
    }
}

/// 状态点旁的文案（pendingReply → 正在回复）。
fn status_text(pending: bool) -> &'static str {
    if pending { "正在回复" } else { "已连接" }
}

/// assistant role 标签（error → ERROR）。
fn role_label(error: bool) -> &'static str {
    if error { "ERROR" } else { "ASSISTANT" }
}

#[derive(Debug, PartialEq, Eq)]
struct ListUpdatePlan {
    replace_old: std::ops::Range<usize>,
    insert_count: usize,
    remeasure: Vec<std::ops::Range<usize>>,
}

#[allow(dead_code)]
fn plan_list_update(
    old: &[(String, String)],
    old_pending: bool,
    new: &[(String, String)],
    new_pending: bool,
) -> ListUpdatePlan {
    let old_rows: Vec<RenderedRow> = old
        .iter()
        .map(|(id, text)| RenderedRow {
            id: id.clone(),
            text: text.clone(),
            tool_calls: vec![],
        })
        .collect();
    let new_rows: Vec<RenderedRow> = new
        .iter()
        .map(|(id, text)| RenderedRow {
            id: id.clone(),
            text: text.clone(),
            tool_calls: vec![],
        })
        .collect();
    plan_list_update_rows(&old_rows, old_pending, &new_rows, new_pending)
}

/// Minimal contiguous splice around structural changes; unchanged prefix/suffix (including
/// the current scroll anchor) remain in the GPUI list's sum tree.
fn plan_list_update_rows(
    old: &[RenderedRow],
    old_pending: bool,
    new: &[RenderedRow],
    new_pending: bool,
) -> ListUpdatePlan {
    let old_len = old.len() + usize::from(old_pending);
    let new_len = new.len() + usize::from(new_pending);
    let same_identity = |old_ix: usize, new_ix: usize| -> bool {
        match (old.get(old_ix), new.get(new_ix)) {
            (Some(old_r), Some(new_r)) => old_r.id == new_r.id,
            (None, None) => {
                old_pending && new_pending && old_ix == old.len() && new_ix == new.len()
            }
            _ => false,
        }
    };
    let mut prefix = 0;
    while prefix < old_len.min(new_len) && same_identity(prefix, prefix) {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < old_len - prefix
        && suffix < new_len - prefix
        && same_identity(old_len - suffix - 1, new_len - suffix - 1)
    {
        suffix += 1;
    }

    let mut remeasure = Vec::new();
    for ix in 0..prefix {
        if let (Some(old_r), Some(new_r)) = (old.get(ix), new.get(ix))
            && old_r.id == new_r.id
            && (old_r.text != new_r.text || old_r.tool_calls != new_r.tool_calls)
        {
            remeasure.push(ix..ix + 1);
        }
    }
    for offset in 0..suffix {
        let old_ix = old_len - suffix + offset;
        let new_ix = new_len - suffix + offset;
        if let (Some(old_r), Some(new_r)) = (old.get(old_ix), new.get(new_ix))
            && old_r.id == new_r.id
            && (old_r.text != new_r.text || old_r.tool_calls != new_r.tool_calls)
        {
            remeasure.push(new_ix..new_ix + 1);
        }
    }
    ListUpdatePlan {
        replace_old: prefix..old_len - suffix,
        insert_count: new_len - prefix - suffix,
        remeasure,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, text: &str) -> (String, String) {
        (id.into(), text.into())
    }

    #[test]
    fn appending_a_message_only_inserts_after_existing_scroll_anchor() {
        let old = vec![msg("u1", "question"), msg("a1", "answer")];
        let new = vec![
            msg("u1", "question"),
            msg("a1", "answer"),
            msg("u2", "next"),
        ];
        assert_eq!(
            plan_list_update(&old, false, &new, false),
            ListUpdatePlan {
                replace_old: 2..2,
                insert_count: 1,
                remeasure: vec![],
            }
        );
    }

    #[test]
    fn streaming_growth_remeasures_only_the_changed_row_and_never_resets_the_list() {
        let old = vec![msg("u1", "question"), msg("a1", "hel")];
        let new = vec![msg("u1", "question"), msg("a1", "hello\nworld")];
        assert_eq!(
            plan_list_update(&old, false, &new, false),
            ListUpdatePlan {
                replace_old: 2..2,
                insert_count: 0,
                // vec![1..2] = 重测下标 1 这一行；collect 写法反而掩盖意图
                #[allow(clippy::single_range_in_vec_init)]
                remeasure: vec![1..2],
            }
        );
    }

    #[test]
    fn scrolled_reader_pauses_tail_and_returns_to_follow_mode_at_bottom() {
        let state = ListState::new(40, ListAlignment::Top, px(480.0));
        state.set_follow_mode(gpui::FollowMode::Tail);
        assert!(state.is_following_tail());
        state.pause_following_tail();
        assert!(!state.is_following_tail());
        state.set_follow_mode(gpui::FollowMode::Tail);
        assert!(
            state.is_following_tail(),
            "explicit return to bottom resumes tail following"
        );
    }

    #[test]
    fn pending_placeholder_is_incrementally_inserted_and_removed() {
        let rows = vec![msg("u1", "question")];
        assert_eq!(
            plan_list_update(&rows, false, &rows, true),
            ListUpdatePlan {
                replace_old: 1..1,
                insert_count: 1,
                remeasure: vec![],
            }
        );
        assert_eq!(
            plan_list_update(&rows, true, &rows, false),
            ListUpdatePlan {
                replace_old: 1..2,
                insert_count: 0,
                remeasure: vec![],
            }
        );
    }

    // ── V6 布局 / 投影对齐 ──────────────────────────────────────────────

    /// 占位符 / 头像 / 状态文案 / role 标签随线程类型与 pending 变化
    #[test]
    fn mapping_helpers_follow_the_prototype_text() {
        assert_eq!(placeholder_for(ConversationKind::Acp), "Ask agent…");
        assert_eq!(placeholder_for(ConversationKind::Chat), "Ask…");
        assert_eq!(avatar_icon(ConversationKind::Chat), IconName::Agent);
        assert_eq!(avatar_icon(ConversationKind::Acp), IconName::Acp);
        assert_eq!(status_text(true), "正在回复");
        assert_eq!(status_text(false), "已连接");
        assert_eq!(role_label(true), "ERROR");
        assert_eq!(role_label(false), "ASSISTANT");
    }

    /// composer 投影：焦点 = 3px accentSoft 环；非焦点 = 0 8 24 黑 20% 下落影
    #[test]
    fn composer_shadow_swaps_between_focus_ring_and_drop_shadow() {
        let focused = composer_shadow(true);
        assert_eq!(focused.len(), 1);
        let f: gpui::Rgba = focused[0].color.into();
        assert!((f.a - 0.15).abs() < 1e-6, "焦点环用 accentSoft");
        assert_eq!(focused[0].spread_radius, px(3.0));
        assert_eq!(focused[0].blur_radius, px(0.0));

        let idle = composer_shadow(false);
        assert_eq!(idle.len(), 1);
        assert_eq!(idle[0].offset.y, px(8.0));
        assert_eq!(idle[0].blur_radius, px(24.0));
        assert_eq!(idle[0].spread_radius, px(0.0));
    }

    /// 气泡 / thinking 点投影值 = 原型字面量
    #[test]
    fn bubble_and_thinking_dot_shadows_match_the_css_literals() {
        let b = bubble_shadow();
        assert_eq!((b[0].offset.y, b[0].blur_radius), (px(1.0), px(2.0)));
        let t = thinking_dot_shadow();
        assert_eq!(t[0].spread_radius, px(4.0));
        assert_eq!(t[0].blur_radius, px(0.0));
    }

    /// composer 底渐变：to top（angle 0），pane 75% → 透明
    #[test]
    fn composer_gradient_is_a_non_solid_fade() {
        let bg = composer_bg();
        // Background 内部字段私有：只能断言不是纯色（渐变路径）且不透明端可见
        assert!(bg.as_solid().is_none(), "渐变背景不应退化为纯色");
        assert!(!bg.is_transparent());
    }

    /// ConvIn 内距：宽屏 28 / 窄屏 18；消息行距 22、thinking 16
    #[test]
    fn conv_padding_constants_match_the_prototype() {
        // 值即布局契约本身，防回归改错
        assert_eq!(conv_in_x_padding(false), 28.0);
        assert_eq!(conv_in_x_padding(true), 18.0);
        assert_eq!(MSG_ROW_GAP, 22.0);
        assert_eq!(THINKING_ROW_GAP, 16.0);
    }

    #[test]
    fn compose_message_with_context_embeds_file_contents_in_prompt_and_tags_in_display() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.rs"), "fn main() {}\n").unwrap();
        let (display, prompt) =
            compose_message_with_context("解释一下这段代码", &["hello.rs".to_owned()], dir.path());
        assert_eq!(display, "@hello.rs\n解释一下这段代码");
        assert!(prompt.contains("### File: `hello.rs`"));
        assert!(prompt.contains("fn main() {}"));
        assert!(prompt.ends_with("解释一下这段代码"));
    }

    #[test]
    fn plan_list_update_rows_remeasures_when_tool_calls_change() {
        let r1 = RenderedRow {
            id: "a1".into(),
            text: "思考中".into(),
            tool_calls: vec![],
        };
        let r2 = RenderedRow {
            id: "a1".into(),
            text: "思考中".into(),
            tool_calls: vec![ToolCallTrace {
                id: "t1".into(),
                kind: Some("read".into()),
                title: Some("Read a.rs".into()),
                status: Some("completed".into()),
                path: Some("a.rs".into()),
            }],
        };
        assert_eq!(
            plan_list_update_rows(&[r1], true, &[r2], true),
            ListUpdatePlan {
                replace_old: 2..2,
                insert_count: 0,
                #[allow(clippy::single_range_in_vec_init)]
                remeasure: vec![0..1],
            }
        );
    }

    #[test]
    fn slash_and_at_triggers_detect_match_and_replace_cleanly() {
        // 1. 行首输入 `/` 与 `/co` 触发 SlashCommand
        assert_eq!(
            detect_composer_trigger("/", 1),
            Some(ComposerTrigger {
                kind: ComposerTriggerKind::SlashCommand,
                replace_range: 0..1,
                query: String::new(),
            })
        );
        assert_eq!(
            detect_composer_trigger("/co", 3),
            Some(ComposerTrigger {
                kind: ComposerTriggerKind::SlashCommand,
                replace_range: 0..3,
                query: "co".into(),
            })
        );
        // 输入完命令加空格后，光标在空格后不再弹 `/` 列表
        assert_eq!(detect_composer_trigger("/compact ", 9), None);
        // 句子中间的 `/`（如路径）不误触发 SlashCommand
        assert_eq!(detect_composer_trigger("检查 src/main.rs", 14), None);

        // 2. 行首或空格后输入 `@` 触发 ContextFile
        assert_eq!(
            detect_composer_trigger("@", 1),
            Some(ComposerTrigger {
                kind: ComposerTriggerKind::ContextFile,
                replace_range: 0..1,
                query: String::new(),
            })
        );
        let text = "请对比 @Cargo.toml 和代码";
        let cursor = "请对比 @Cargo".len();
        assert_eq!(
            detect_composer_trigger(text, cursor),
            Some(ComposerTrigger {
                kind: ComposerTriggerKind::ContextFile,
                replace_range: "请对比 ".len().."请对比 @Cargo.toml".len(),
                query: "Cargo".into(),
            })
        );

        // 3. 补全替换测试：`/` 替换为 `/compact `，`@` 移入顶部胶囊并清理文本内 `@query`
        let (replaced_cmd, cmd_cursor, _) = apply_trigger_replacement("/co", 0..3, "/compact ");
        assert_eq!(replaced_cmd, "/compact ");
        assert_eq!(cmd_cursor, "/compact ".len());

        let (replaced_at, at_cursor, _) =
            apply_trigger_replacement(text, "请对比 ".len().."请对比 @Cargo.toml".len(), "");
        assert_eq!(replaced_at, "请对比 和代码");
        assert_eq!(at_cursor, "请对比 ".len());

        // 4. 手写 `@file` 发送时自动提取匹配的上下文文件
        let ws_files = vec![
            "Cargo.toml".to_owned(),
            "crates/jagent-app/src/main.rs".to_owned(),
        ];
        let mut attached = Vec::new();
        extract_inline_context_mentions("看看 @Cargo.toml 和 @main.rs.", &ws_files, &mut attached);
        assert_eq!(
            attached,
            vec![
                "Cargo.toml".to_owned(),
                "crates/jagent-app/src/main.rs".to_owned()
            ]
        );
    }

    #[gpui::test]
    fn changing_ui_scale_remeasures_conversation_list_items(cx: &mut gpui::TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_string_lossy().into_owned();
        let (state, tid) = cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::install(cx).unwrap();
            let state = crate::state::init(cx, dir.path().to_path_buf(), cwd).unwrap();
            let ws = state.read(cx).workspaces()[0].id.clone();
            let tid = state
                .update(cx, |s, cx| s.create_chat(Some(&ws), cx))
                .unwrap();
            state.update(cx, |s, cx| {
                let req = s
                    .threads
                    .begin_send(&tid, "测试缩放后重测列表行高", ConversationKind::Chat)
                    .unwrap();
                s.threads
                    .finish_send(&req.thread_id, req.kind, Ok("这是一段回复内容".into()));
                s.flush(cx);
            });
            (state, tid)
        });

        let (view, vcx) = cx.add_window_view({
            let state = state.clone();
            let tid = tid.clone();
            move |window, cx| ConversationView::new(state, tid, window, cx)
        });
        vcx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
            assert_eq!(view.read(cx).rendered_ui_scale_bits, (1.0f32).to_bits());
        });

        vcx.update(|window, cx| {
            state.update(cx, |s, cx| {
                s.settings
                    .patch("appearance.uiScale", serde_json::json!(150));
                s.flush(cx);
                cx.emit(StateChanged);
            });
            window.refresh();
            window.draw(cx).clear(cx);
            assert_eq!(view.read(cx).rendered_ui_scale_bits, (1.5f32).to_bits());
        });

        vcx.update(|window, cx| {
            state.update(cx, |s, cx| {
                s.settings.reset("appearance.uiScale");
                s.flush(cx);
                cx.emit(StateChanged);
            });
            window.refresh();
            window.draw(cx).clear(cx);
            assert_eq!(view.read(cx).rendered_ui_scale_bits, (1.0f32).to_bits());
        });
    }
}
