//! 主画布宽幅文件预览与代码编辑器（`FileSurface`）：
//! - **完整源码 / 编辑 (`FileSurfaceMode::Source`)**：复用 `gpui_component::input::{Editor, EditorState}`
//!   （底层 `Rope` + `DisplayMap` 虚拟行渲染，彻底移除 500 行截断；支持直接修改、`Cmd/Ctrl+S` 保存、
//!   `Cmd/Ctrl+F` 页内搜索、`:line` 目标行高亮与跳转）；
//! - **Unified Diff / 并排对比 (`FileSurfaceMode::Diff` / `Split`)**：复用
//!   `gpui_component::diff::{Diff, DiffFile, DiffMode, DiffState}`（虚拟化列表、真实 hunk 行号、
//!   词级内联差异高亮、未跟踪文件合成新增 patch）；
//! - **自动换行联动**：跟随 `Settings.appearance.word_wrap` 动态切换软换行（Soft Wrap）与双向滚动。

use std::ops::Range;
use std::path::{Path, PathBuf};

use gpui::{
    AnyElement, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_base::input::{
    Position, RangeDecoration, RangeDecorationCollection, RangeDecorationStyle,
};
use gpui_component::diff::{Diff, DiffFile, DiffHoverHighlight, DiffMode, DiffState};
use gpui_component::input::{Editor, EditorState};
use gpui_component::notification::Notification;
use gpui_component::{WindowExt as _, h_flex, v_flex};
use jagent_core::git::{WorktreeFile, WorktreeFileKind};

use crate::icons::{IconName, icon};
use crate::theme::{accent_alpha, colors, hex};
use crate::ui_scale::fs;
use crate::views::root::{FileSurfaceMode, RootView};
use crate::views::selectable::sel_text_id;

/// 最大源码读取字节数（2 MiB）：防超大二进制或日志撑爆内存，同时彻底取消旧 500 行截断。
const MAX_SOURCE_BYTES: usize = 2 * 1024 * 1024;

/// 根据文件路径推断编辑器与 Diff 的语法高亮语言名。
pub fn detect_language(path: &str) -> &'static str {
    let file_name = Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match file_name.as_str() {
        "cargo.lock" | "pipfile.lock" | "poetry.lock" | "uv.lock" | "pdm.lock" | "pipfile" => {
            return "toml";
        }
        "dockerfile" | "containerfile" => return "dockerfile",
        "makefile" | "gnumakefile" | "justfile" => return "make",
        "cmakelists.txt" => return "cmake",
        "gemfile" | "gemfile.lock" | "rakefile" | "podfile" => return "ruby",
        "yarn.lock" => return "yaml",
        ".gitignore" | ".dockerignore" | ".env" | ".env.local" | ".env.example" | ".bashrc"
        | ".zshrc" | ".profile" => return "bash",
        _ => {}
    }

    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "json" | "jsonc" => "json",
        "toml" | "lock" => "toml",
        "md" | "mdx" => "markdown",
        "sh" | "bash" | "zsh" => "bash",
        "py" | "pyi" => "python",
        "go" => "go",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "css" | "scss" => "css",
        "html" | "htm" => "html",
        "yaml" | "yml" => "yaml",
        "sql" => "sql",
        "lua" => "lua",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "java" => "java",
        "rb" => "ruby",
        "php" => "php",
        _ => "plaintext",
    }
}

/// 解析文件路径在本地磁盘上的真实位置：
/// 优先使用 `git rev-parse --show-toplevel`（`find_repo_root`）拼接相对路径，
/// 兼容工作区处于 Git 子目录、绝对路径、重命名语法 `{old => new}` 等情况。
pub fn resolve_disk_file_path(cwd: &str, rel_path: &str) -> (PathBuf, String, bool) {
    let trimmed = rel_path.trim().trim_matches('"');
    let resolved = jagent_core::git::resolve_changed_file_path(trimmed);
    let clean = resolved
        .trim_start_matches("./")
        .trim_start_matches('/')
        .replace('\\', "/");

    let abs_candidate = Path::new(&resolved);
    if abs_candidate.is_absolute() && abs_candidate.is_file() {
        return (abs_candidate.to_path_buf(), clean, true);
    }

    let cwd_path = Path::new(cwd);
    let repo_root = jagent_core::git::cli::find_repo_root(cwd_path).map(PathBuf::from);

    if let Some(ref root) = repo_root {
        let p = root.join(&clean);
        if p.is_file() {
            return (p, clean, true);
        }
    }

    let p_cwd = cwd_path.join(&clean);
    if p_cwd.is_file() {
        return (p_cwd, clean, true);
    }

    // 若 cwd 是子目录且 clean 带有子目录前缀，尝试去掉重叠前缀
    if let Some(dir_name) = cwd_path.file_name().and_then(|s| s.to_str())
        && let Some(stripped) = clean.strip_prefix(&format!("{dir_name}/"))
    {
        let p_sub = cwd_path.join(stripped);
        if p_sub.is_file() {
            return (p_sub, clean, true);
        }
    }

    let default_target = repo_root
        .unwrap_or_else(|| cwd_path.to_path_buf())
        .join(&clean);
    (default_target, clean, false)
}

/// 当磁盘与 `git show` 均未命中但存在 Unified Diff patch 时，从 patch hunk 中提取源码文本兜底。
pub fn extract_source_from_patch(patch: &str) -> Option<String> {
    let mut new_lines = Vec::new();
    let mut old_lines = Vec::new();
    let mut in_hunk = false;
    for line in patch.lines() {
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            continue;
        }
        if line.starts_with("\\ No newline") {
            continue;
        }
        if let Some(rest) = line.strip_prefix('+') {
            new_lines.push(rest);
        } else if let Some(rest) = line.strip_prefix('-') {
            old_lines.push(rest);
        } else if let Some(rest) = line.strip_prefix(' ') {
            new_lines.push(rest);
            old_lines.push(rest);
        } else if line.is_empty() {
            new_lines.push("");
            old_lines.push("");
        }
    }
    if !new_lines.is_empty() {
        let mut s = new_lines.join("\n");
        s.push('\n');
        Some(s)
    } else if !old_lines.is_empty() {
        let mut s = old_lines.join("\n");
        s.push('\n');
        Some(s)
    } else {
        None
    }
}

/// 读取完整 UTF-8 源码（剥离 `\r\n` 为 `\n`），不限制行数。
pub fn read_full_source(full_path: &Path, rel_path: &str) -> (String, bool) {
    use std::io::Read as _;
    let Ok(file) = std::fs::File::open(full_path) else {
        return (
            format!("// {rel_path}\n// 文件不存在或尚未落盘，可直接编辑后按 Cmd/Ctrl+S 保存创建\n"),
            false,
        );
    };
    let mut bytes = Vec::new();
    if file
        .take(MAX_SOURCE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return (format!("// 无法读取文件：{rel_path}\n"), false);
    }
    let slice = &bytes[..bytes.len().min(MAX_SOURCE_BYTES)];
    let mut end = slice.len();
    while end > 0 && std::str::from_utf8(&slice[..end]).is_err() {
        if slice.len() - end > 4 {
            return (
                format!("// 二进制文件（{} bytes），不支持文本编辑\n", bytes.len()),
                false,
            );
        }
        end -= 1;
    }
    let Ok(raw) = std::str::from_utf8(&slice[..end]) else {
        return (format!("// 二进制文件：{rel_path}\n"), false);
    };
    let normalized = if raw.contains('\r') {
        raw.replace("\r\n", "\n")
    } else {
        raw.to_owned()
    };
    (normalized, true)
}

/// 计算 1-based 行号在文本中的 UTF-8 字节范围（用于 `RangeDecoration` 行高亮）。
pub fn line_byte_range(text: &str, line_1based: u32) -> Option<Range<usize>> {
    if line_1based == 0 || text.is_empty() {
        return None;
    }
    let target_ix = (line_1based - 1) as usize;
    let mut offset = 0usize;
    for (ix, line) in text.split('\n').enumerate() {
        let line_end = offset + line.len();
        if ix == target_ix {
            if offset < line_end {
                return Some(offset..line_end);
            }
            let fallback_end = (offset + 1).min(text.len());
            return (offset < fallback_end).then_some(offset..fallback_end);
        }
        offset = (line_end + 1).min(text.len());
    }
    None
}

/// 挂载在 `RootView` 上的主画布文件预览/编辑器状态机。
#[derive(Default)]
pub struct FileSurfaceController {
    diff_state: Option<Entity<DiffState>>,
    editor_state: Option<Entity<EditorState>>,
    line_decorations: Option<RangeDecorationCollection>,
    /// 已加载的文件键 `(cwd, rel_path, commit_sha)`；不变时不重复读盘或起 git 子进程
    loaded_key: Option<(String, String, Option<String>)>,
    /// 若从 Git Graph 点击某个历史提交的文件，记录该提交 SHA 以展示对应提交的 patch
    pub commit_sha: Option<String>,
    resolved_disk_path: Option<PathBuf>,
    file_content: String,
    saved_content: String,
    has_diff: bool,
    diff_additions: u32,
    diff_deletions: u32,
    line_count: usize,
    is_dirty: bool,
    editor_content_rev: u64,
    editor_synced_rev: u64,
    applied_target_line: Option<(String, u32)>,
    last_word_wrap: Option<bool>,
}

impl FileSurfaceController {
    /// 强制下次渲染重新从磁盘和 Git 加载当前文件。
    pub fn invalidate(&mut self) {
        self.loaded_key = None;
    }

    /// 当前编辑器是否存在未保存修改。
    pub fn is_dirty(&self, cx: &gpui::App) -> bool {
        self.editor_state
            .as_ref()
            .is_some_and(|ed| ed.read(cx).value().as_ref() != self.saved_content.as_str())
    }

    /// 当前打开文件的总行数。
    pub fn line_count(&self) -> usize {
        self.line_count
    }

    /// 读取当前编辑器中的文本内容（仅供测试或保存）。
    pub fn current_editor_text(&self, cx: &gpui::App) -> Option<String> {
        self.editor_state
            .as_ref()
            .map(|ed| ed.read(cx).value().to_string())
    }

    fn reload_file_and_diff(
        &mut self,
        cwd: &str,
        rel_path: &str,
        worktree_files: &[WorktreeFile],
        git_selected_sha: Option<&str>,
        cx: &mut Context<RootView>,
    ) {
        let (disk_path, clean_rel, exists_on_disk) = resolve_disk_file_path(cwd, rel_path);
        self.resolved_disk_path = Some(disk_path.clone());

        let effective_sha_owned = self
            .commit_sha
            .clone()
            .or_else(|| git_selected_sha.map(str::to_owned));
        let effective_sha = effective_sha_owned.as_deref();
        let raw_patch = if let Some(sha) = self.commit_sha.as_deref() {
            jagent_core::git::cli::diff_commit_file(Path::new(cwd), sha, &clean_rel)
                .ok()
                .filter(|s| !s.trim().is_empty())
        } else if exists_on_disk {
            jagent_core::git::cli::diff_worktree_file(Path::new(cwd), &clean_rel)
                .ok()
                .filter(|s| !s.trim().is_empty())
        } else {
            jagent_core::git::cli::diff_worktree_file(Path::new(cwd), &clean_rel)
                .ok()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| {
                    effective_sha.and_then(|sha| {
                        jagent_core::git::cli::diff_commit_file(Path::new(cwd), sha, &clean_rel)
                            .ok()
                            .filter(|s| !s.trim().is_empty())
                    })
                })
        };

        let content = if exists_on_disk {
            read_full_source(&disk_path, &clean_rel).0
        } else if let Some(git_text) = jagent_core::git::cli::show_file_from_git_history(
            Path::new(cwd),
            effective_sha,
            &clean_rel,
        ) {
            git_text
        } else if let Some(patch_text) = raw_patch.as_deref().and_then(extract_source_from_patch) {
            patch_text
        } else {
            read_full_source(&disk_path, &clean_rel).0
        };

        self.line_count = content.lines().count().max(1);
        self.file_content = content.clone();
        self.saved_content = content.clone();
        self.is_dirty = false;
        self.editor_content_rev = self.editor_content_rev.wrapping_add(1);
        self.applied_target_line = None;

        self.rebuild_diff_files_from_patch(&clean_rel, &content, raw_patch, worktree_files, cx);
        self.loaded_key = Some((cwd.to_owned(), rel_path.to_owned(), effective_sha_owned));
    }

    fn rebuild_diff_files(
        &mut self,
        cwd: &str,
        rel_path: &str,
        content: &str,
        worktree_files: &[WorktreeFile],
        git_selected_sha: Option<&str>,
        cx: &mut Context<RootView>,
    ) {
        let (_, clean_rel, exists_on_disk) = resolve_disk_file_path(cwd, rel_path);
        let fallback_commit_sha = self.commit_sha.as_deref().or(git_selected_sha);
        let raw_patch = if let Some(sha) = self.commit_sha.as_deref() {
            jagent_core::git::cli::diff_commit_file(Path::new(cwd), sha, &clean_rel)
                .ok()
                .filter(|s| !s.trim().is_empty())
        } else if exists_on_disk {
            jagent_core::git::cli::diff_worktree_file(Path::new(cwd), &clean_rel)
                .ok()
                .filter(|s| !s.trim().is_empty())
        } else {
            jagent_core::git::cli::diff_worktree_file(Path::new(cwd), &clean_rel)
                .ok()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| {
                    fallback_commit_sha.and_then(|sha| {
                        jagent_core::git::cli::diff_commit_file(Path::new(cwd), sha, &clean_rel)
                            .ok()
                            .filter(|s| !s.trim().is_empty())
                    })
                })
        };
        self.rebuild_diff_files_from_patch(&clean_rel, content, raw_patch, worktree_files, cx);
    }

    fn rebuild_diff_files_from_patch(
        &mut self,
        rel_path: &str,
        content: &str,
        raw_patch: Option<String>,
        worktree_files: &[WorktreeFile],
        cx: &mut Context<RootView>,
    ) {
        let changed = worktree_files.iter().find(|f| f.path == rel_path);
        let patch_to_parse = match raw_patch {
            Some(p) => Some(p),
            None if changed.is_some_and(|c| c.status == WorktreeFileKind::A) => Some(
                jagent_core::git::cli::synthetic_added_patch(rel_path, content),
            ),
            None => None,
        };

        let lang = detect_language(rel_path);
        let parsed_files: Vec<DiffFile> = patch_to_parse
            .as_deref()
            .and_then(|p| DiffFile::parse(p).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|f| f.with_language(lang))
            .collect();

        self.has_diff = !parsed_files.is_empty();
        self.diff_additions = parsed_files.iter().map(|f| f.additions() as u32).sum();
        self.diff_deletions = parsed_files.iter().map(|f| f.deletions() as u32).sum();
        let files_for_state = if parsed_files.is_empty() {
            vec![DiffFile::unchanged(rel_path.to_owned(), content).with_language(lang)]
        } else {
            parsed_files
        };

        if let Some(ds) = &self.diff_state {
            ds.update(cx, |s, cx| {
                s.set_files(files_for_state, cx);
            });
        } else {
            self.diff_state =
                Some(cx.new(|cx| DiffState::new(files_for_state, cx).with_context_lines(None)));
        }
    }
}

impl RootView {
    /// 将当前在 `FileSurface` 编辑器中修改的内容写回磁盘，并刷新 Git 状态与 Diff。
    pub fn save_active_file(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((cwd, rel_path, _)) = self.file_surface.loaded_key.clone() else {
            return;
        };
        let Some(ed) = self.file_surface.editor_state.clone() else {
            return;
        };
        let new_content = ed.read(cx).value().to_string();
        let full_path = self
            .file_surface
            .resolved_disk_path
            .clone()
            .unwrap_or_else(|| Path::new(&cwd).join(&rel_path));
        if let Some(parent) = full_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::write(&full_path, &new_content) {
            Ok(()) => {
                self.file_surface.saved_content = new_content.clone();
                self.file_surface.file_content = new_content.clone();
                self.file_surface.line_count = new_content.lines().count().max(1);
                self.file_surface.is_dirty = false;
                let wf = self.worktree_files.clone();
                let git_sha = self.state.read(cx).git_graph.selected_sha.clone();
                self.file_surface.rebuild_diff_files(
                    &cwd,
                    &rel_path,
                    &new_content,
                    &wf,
                    git_sha.as_deref(),
                    cx,
                );
                self.refresh_branch(cx);
                if let Some(panel) = &self.panel {
                    panel.update(cx, |p, cx| p.refresh_preserve_selection(cx));
                }
                if let Some(edit_panel) = &self.sidebar_edit_panel {
                    edit_panel.update(cx, |p, cx| p.refresh_preserve_selection(cx));
                }
                window.push_notification(Notification::success(format!("已保存 {rel_path}")), cx);
                cx.notify();
            }
            Err(e) => {
                window.push_notification(
                    Notification::error(format!("保存 {rel_path} 失败：{e}")),
                    cx,
                );
            }
        }
    }

    /// 放弃当前编辑器中的未保存修改，还原为磁盘内容。
    pub fn revert_active_file(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(ed) = self.file_surface.editor_state.clone() else {
            return;
        };
        let saved = self.file_surface.saved_content.clone();
        ed.update(cx, |s, cx| {
            s.set_value(saved, window, cx);
        });
        self.file_surface.is_dirty = false;
        cx.notify();
    }

    /// 渲染主画布 `FileSurface`（支持 `Editor` 编辑保存与 `Diff` 统一/并排对比）。
    pub(crate) fn render_file_surface(
        &mut self,
        rel_path: &str,
        target_line: Option<u32>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let cwd = self.state.read(cx).git_cwd();
        let word_wrap = self.state.read(cx).settings.get().appearance.word_wrap;
        let git_sha = self.state.read(cx).git_graph.selected_sha.clone();
        let effective_sha = self.file_surface.commit_sha.clone().or(git_sha.clone());
        let expected_key = (cwd.clone(), rel_path.to_owned(), effective_sha);
        if self.file_surface.loaded_key.as_ref() != Some(&expected_key) {
            let wf = self.worktree_files.clone();
            self.file_surface
                .reload_file_and_diff(&cwd, rel_path, &wf, git_sha.as_deref(), cx);
        }

        let changed = self
            .worktree_files
            .iter()
            .find(|f| f.path == rel_path)
            .cloned();
        let has_diff = self.file_surface.has_diff || changed.is_some();
        let effective_mode = if has_diff {
            self.file_surface_mode
        } else {
            FileSurfaceMode::Source
        };

        // 确保 EditorState 初始化并同步内容、语言、自动换行与目标行高亮
        let lang = detect_language(rel_path);
        let editor_entity = match &self.file_surface.editor_state {
            Some(ed) => ed.clone(),
            None => {
                let ed = cx.new(|cx| {
                    EditorState::new(window, cx)
                        .language(lang)
                        .soft_wrap(word_wrap)
                });
                let decos = ed.update(cx, |s, cx| {
                    s.create_range_decorations_collection(vec![], cx)
                });
                cx.observe(&ed, |this, ed, cx| {
                    let dirty =
                        ed.read(cx).value().as_ref() != this.file_surface.saved_content.as_str();
                    if this.file_surface.is_dirty != dirty {
                        this.file_surface.is_dirty = dirty;
                        cx.notify();
                    }
                })
                .detach();
                self.file_surface.line_decorations = Some(decos);
                self.file_surface.editor_state = Some(ed.clone());
                self.file_surface.last_word_wrap = Some(word_wrap);
                ed
            }
        };

        if self.file_surface.editor_synced_rev != self.file_surface.editor_content_rev {
            let content = self.file_surface.file_content.clone();
            editor_entity.update(cx, |s, cx| {
                s.set_highlighter(lang, cx);
                s.set_value(content, window, cx);
            });
            self.file_surface.editor_synced_rev = self.file_surface.editor_content_rev;
        }

        if self.file_surface.last_word_wrap != Some(word_wrap) {
            editor_entity.update(cx, |s, cx| {
                s.set_soft_wrap(word_wrap, window, cx);
            });
            self.file_surface.last_word_wrap = Some(word_wrap);
        }

        let desired_target = target_line.map(|l| (rel_path.to_owned(), l));
        if self.file_surface.applied_target_line != desired_target {
            if let Some(decos) = &self.file_surface.line_decorations {
                if let Some(line1) = target_line {
                    if let Some(range) = line_byte_range(&self.file_surface.file_content, line1) {
                        decos.set(
                            vec![
                                RangeDecoration::new(range)
                                    .with_style(RangeDecorationStyle::Fill)
                                    .with_color(accent_alpha(0.18)),
                            ],
                            cx,
                        );
                    } else {
                        decos.clear(cx);
                    }
                    let line0 = line1.saturating_sub(1);
                    editor_entity.update(cx, |s, cx| {
                        let _ = s.unfold_at(Position::new(line0, 0), cx);
                        s.set_cursor_position(Position::new(line0, 0), window, cx);
                    });
                } else {
                    decos.clear(cx);
                }
            }
            self.file_surface.applied_target_line = desired_target;
        }

        // 同步 DiffState 的模式（Unified vs Split）
        if let Some(ds) = &self.file_surface.diff_state {
            let target_diff_mode = match effective_mode {
                FileSurfaceMode::Split => DiffMode::Split,
                _ => DiffMode::Unified,
            };
            if ds.read(cx).mode() != target_diff_mode {
                ds.update(cx, |s, cx| s.set_mode(target_diff_mode, cx));
            }
        }

        let (dir_prefix, file_name) = match rel_path.rfind('/') {
            Some(idx) => (
                format!("{} / ", rel_path[..idx].replace('/', " / ")),
                rel_path[idx + 1..].to_owned(),
            ),
            None => (String::new(), rel_path.to_owned()),
        };

        let is_dirty = self.file_surface.is_dirty(cx);
        self.file_surface.is_dirty = is_dirty;
        let line_count = self.file_surface.line_count;
        let fallback_add = self.file_surface.diff_additions;
        let fallback_del = self.file_surface.diff_deletions;
        let weak = cx.entity().downgrade();
        let weak_save = weak.clone();
        let weak_revert = weak.clone();
        let weak_key_save = weak.clone();

        let header = h_flex()
            .h(px(34.0))
            .pl(px(14.0))
            .pr(px(14.0))
            .gap(px(8.0))
            .items_center()
            .justify_between()
            .flex_shrink_0()
            .bg(hex(colors::PANE))
            .border_b_1()
            .border_color(hex(colors::BORDER))
            .child(
                h_flex()
                    .gap(px(8.0))
                    .items_center()
                    .min_w_0()
                    .child(icon(IconName::File, 13.0, hex(colors::ACCENT_HOVER)))
                    .child(
                        h_flex()
                            .min_w_0()
                            .items_center()
                            .font_family("monospace")
                            .text_size(fs(12.0))
                            .when(!dir_prefix.is_empty(), |d| {
                                d.child(
                                    div()
                                        .text_color(hex(colors::MUTED))
                                        .child(sel_text_id("fs-dir-prefix", dir_prefix)),
                                )
                            })
                            .child(
                                div()
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .text_color(hex(colors::TEXT_BRIGHT))
                                    .child(sel_text_id("fs-file-name", file_name)),
                            )
                            .when(is_dirty, |d| {
                                d.child(
                                    div()
                                        .id("fs-dirty-dot")
                                        .ml(px(6.0))
                                        .px(px(6.0))
                                        .py(px(1.0))
                                        .rounded(px(4.0))
                                        .bg(crate::theme::rgba_css(251, 191, 36, 0.14))
                                        .text_size(fs(10.5))
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .text_color(hex(colors::STATUS_RUNNING))
                                        .child("● 未保存"),
                                )
                            })
                            .when_some(target_line, |d, ln| {
                                d.child(
                                    div()
                                        .id("fs-target-line-badge")
                                        .ml(px(4.0))
                                        .px(px(6.0))
                                        .py(px(1.0))
                                        .rounded(px(4.0))
                                        .bg(accent_alpha(0.16))
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .text_size(fs(11.0))
                                        .text_color(hex(colors::ACCENT_HOVER))
                                        .child(format!(":{ln}")),
                                )
                            }),
                    )
                    .child(if effective_mode != FileSurfaceMode::Source {
                        match &changed {
                            Some(ch) => {
                                let add = ch.added.unwrap_or(fallback_add);
                                let del = ch.deleted.unwrap_or(fallback_del);
                                let (st_label, st_col, st_bg) = match ch.status {
                                    WorktreeFileKind::M => (
                                        "Modified",
                                        hex(colors::STATUS_RUNNING),
                                        crate::theme::rgba_css(251, 191, 36, 0.12),
                                    ),
                                    WorktreeFileKind::A => (
                                        "Added",
                                        hex(colors::STATUS_DONE),
                                        crate::theme::rgba_css(52, 211, 153, 0.12),
                                    ),
                                    WorktreeFileKind::D => (
                                        "Deleted",
                                        hex(colors::STATUS_ERROR),
                                        crate::theme::rgba_css(248, 113, 113, 0.12),
                                    ),
                                };
                                h_flex()
                                    .gap(px(5.0))
                                    .px(px(7.0))
                                    .py(px(1.5))
                                    .rounded(px(5.0))
                                    .bg(st_bg)
                                    .font_family("monospace")
                                    .text_size(fs(10.5))
                                    .child(
                                        div()
                                            .font_weight(gpui::FontWeight::SEMIBOLD)
                                            .text_color(st_col)
                                            .child(st_label),
                                    )
                                    .when(add > 0, |d| {
                                        d.child(
                                            div()
                                                .text_color(hex(colors::STATUS_DONE))
                                                .child(format!("+{add}")),
                                        )
                                    })
                                    .when(del > 0, |d| {
                                        d.child(
                                            div()
                                                .text_color(hex(colors::STATUS_ERROR))
                                                .child(format!("−{del}")),
                                        )
                                    })
                                    .into_any_element()
                            }
                            None => div()
                                .px(px(6.0))
                                .py(px(1.0))
                                .rounded(px(4.0))
                                .bg(hex(colors::SURFACE))
                                .font_family("monospace")
                                .text_size(fs(10.0))
                                .text_color(hex(colors::MUTED))
                                .child(lang.to_ascii_uppercase())
                                .into_any_element(),
                        }
                    } else {
                        div()
                            .px(px(6.0))
                            .py(px(1.0))
                            .rounded(px(4.0))
                            .bg(hex(colors::SURFACE))
                            .font_family("monospace")
                            .text_size(fs(10.0))
                            .text_color(hex(colors::MUTED))
                            .child(lang.to_ascii_uppercase())
                            .into_any_element()
                    }),
            )
            .child(
                h_flex()
                    .gap(px(8.0))
                    .items_center()
                    .when(effective_mode == FileSurfaceMode::Source && is_dirty, |d| {
                        d.child(
                            div()
                                .id("fs-revert-btn")
                                .h(px(22.0))
                                .px(px(8.0))
                                .rounded(px(5.0))
                                .flex()
                                .items_center()
                                .cursor_pointer()
                                .bg(hex(colors::SURFACE))
                                .hover(|h| h.bg(hex(colors::SURFACE_HOVER)))
                                .text_size(fs(11.0))
                                .text_color(hex(colors::MUTED))
                                .child("还原")
                                .on_click(move |_, window, cx| {
                                    let _ = weak_revert.update(cx, |v, cx| {
                                        v.revert_active_file(window, cx);
                                    });
                                }),
                        )
                    })
                    .when(effective_mode == FileSurfaceMode::Source, |d| {
                        let save_label = if cfg!(target_os = "macos") {
                            "保存 ⌘S"
                        } else {
                            "保存 Ctrl+S"
                        };
                        d.child(
                            div()
                                .id("fs-save-btn")
                                .h(px(22.0))
                                .px(px(8.0))
                                .rounded(px(5.0))
                                .flex()
                                .items_center()
                                .cursor_pointer()
                                .text_size(fs(11.0))
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .when_else(
                                    is_dirty,
                                    |b| {
                                        b.bg(hex(colors::ACCENT))
                                            .text_color(hex(colors::TEXT_BRIGHT))
                                            .hover(|h| h.bg(hex(colors::ACCENT_HOVER)))
                                    },
                                    |b| {
                                        b.text_color(hex(colors::MUTED)).hover(|h| {
                                            h.bg(hex(colors::SURFACE)).text_color(hex(colors::TEXT))
                                        })
                                    },
                                )
                                .child(save_label)
                                .on_click(move |_, window, cx| {
                                    let _ = weak_save.update(cx, |v, cx| {
                                        v.save_active_file(window, cx);
                                    });
                                }),
                        )
                    })
                    .when(has_diff, |d| {
                        d.child(
                            h_flex()
                                .p(px(2.0))
                                .gap(px(2.0))
                                .items_center()
                                .rounded(px(6.0))
                                .bg(hex(colors::INPUT_BG))
                                .children(
                                    [
                                        (FileSurfaceMode::Source, "源码编辑", "fs-mode-source"),
                                        (FileSurfaceMode::Diff, "Unified Diff", "fs-mode-diff"),
                                        (FileSurfaceMode::Split, "并排对比", "fs-mode-split"),
                                    ]
                                    .into_iter()
                                    .map(|(m, lbl, btn_id)| {
                                        let is_act = effective_mode == m;
                                        let wk = weak.clone();
                                        div()
                                            .id(btn_id)
                                            .h(px(20.0))
                                            .px(px(8.0))
                                            .rounded(px(4.5))
                                            .flex()
                                            .items_center()
                                            .cursor_pointer()
                                            .text_size(fs(11.0))
                                            .when_else(
                                                is_act,
                                                |b| {
                                                    b.bg(hex(colors::SURFACE_ACTIVE))
                                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                                        .text_color(hex(colors::TEXT_BRIGHT))
                                                },
                                                |b| {
                                                    b.text_color(hex(colors::MUTED))
                                                        .hover(|h| h.text_color(hex(colors::TEXT)))
                                                },
                                            )
                                            .child(lbl)
                                            .on_click(move |_, _, cx| {
                                                let _ = wk.update(cx, |v, cx| {
                                                    v.file_surface_mode = m;
                                                    cx.notify();
                                                });
                                            })
                                    }),
                                ),
                        )
                    })
                    .child(
                        div()
                            .font_family("monospace")
                            .text_size(fs(11.0))
                            .text_color(hex(colors::FAINT))
                            .child(format!("{line_count} lines · UTF-8")),
                    ),
            );

        let main_body: AnyElement = match effective_mode {
            FileSurfaceMode::Diff => {
                let ds = self
                    .file_surface
                    .diff_state
                    .as_ref()
                    .expect("diff_state initialized")
                    .clone();
                div()
                    .id("main-file-surface")
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .size_full()
                    .bg(hex(colors::PANE))
                    .child(
                        Diff::new(&ds)
                            .header_visible(false)
                            .hover_highlight(DiffHoverHighlight::Both)
                            .soft_wrap(word_wrap)
                            .bg(hex(colors::PANE))
                            .size_full(),
                    )
                    .into_any_element()
            }
            FileSurfaceMode::Split => {
                let del_cnt = changed
                    .as_ref()
                    .and_then(|c| c.deleted)
                    .unwrap_or(fallback_del);
                let add_cnt = changed
                    .as_ref()
                    .and_then(|c| c.added)
                    .unwrap_or(fallback_add);
                let ds = self
                    .file_surface
                    .diff_state
                    .as_ref()
                    .expect("diff_state initialized")
                    .clone();
                let sticky_split_head = h_flex()
                    .id("split-diff-header")
                    .h(px(28.0))
                    .w_full()
                    .flex_shrink_0()
                    .bg(crate::theme::rgba_css(18, 21, 30, 0.92))
                    .border_b_1()
                    .border_color(hex(colors::BORDER))
                    .font_family("monospace")
                    .text_size(fs(11.0))
                    .child(
                        h_flex()
                            .w(gpui::relative(0.5))
                            .h_full()
                            .px(px(14.0))
                            .items_center()
                            .justify_between()
                            .border_r_1()
                            .border_color(hex(colors::BORDER))
                            .text_color(hex(colors::MUTED))
                            .child("HEAD (变更前基准)")
                            .child(
                                div()
                                    .text_color(hex(colors::STATUS_ERROR))
                                    .child(format!("−{del_cnt} 行移除")),
                            ),
                    )
                    .child(
                        h_flex()
                            .w(gpui::relative(0.5))
                            .h_full()
                            .px(px(14.0))
                            .items_center()
                            .justify_between()
                            .text_color(hex(colors::MUTED))
                            .child("Working Tree (当前修改)")
                            .child(
                                div()
                                    .text_color(hex(colors::STATUS_DONE))
                                    .child(format!("+{add_cnt} 行新增")),
                            ),
                    );

                v_flex()
                    .id("main-file-surface")
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .size_full()
                    .bg(hex(colors::PANE))
                    .child(sticky_split_head)
                    .child(
                        div().flex_1().min_h_0().min_w_0().size_full().child(
                            Diff::new(&ds)
                                .header_visible(false)
                                .hover_highlight(DiffHoverHighlight::Both)
                                .soft_wrap(word_wrap)
                                .bg(hex(colors::PANE))
                                .size_full(),
                        ),
                    )
                    .into_any_element()
            }
            FileSurfaceMode::Source => div()
                .id("main-file-surface")
                .flex_1()
                .min_h_0()
                .min_w_0()
                .size_full()
                .child(
                    Editor::new(&editor_entity)
                        .h(gpui::relative(1.0))
                        .w_full()
                        .appearance(false)
                        .bordered(false)
                        .readonly(false),
                )
                .into_any_element(),
        };

        let scroll_for_apply = self.file_surface_scroll.clone();
        let pending_scroll = self.pending_file_scroll_y.clone();
        v_flex()
            .id("file-surface-container")
            .size_full()
            .min_h_0()
            .min_w_0()
            .bg(hex(colors::PANE))
            .on_key_down(move |ev, window, cx| {
                let ks = &ev.keystroke;
                let save_mod = if cfg!(target_os = "macos") {
                    ks.modifiers.platform && !ks.modifiers.alt && !ks.modifiers.shift
                } else {
                    ks.modifiers.control && !ks.modifiers.alt && !ks.modifiers.shift
                };
                if save_mod && ks.key.eq_ignore_ascii_case("s") {
                    cx.stop_propagation();
                    let _ = weak_key_save.update(cx, |v, cx| {
                        v.save_active_file(window, cx);
                    });
                }
            })
            .child(header)
            .child(main_body)
            .child(
                gpui::canvas(
                    |_, _, _| (),
                    move |_, _, _, _| {
                        if let Some(y) = pending_scroll.take() {
                            scroll_for_apply.set_offset(gpui::point(px(0.0), -y));
                        }
                    },
                )
                .size_0()
                .absolute(),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_byte_range_resolves_one_based_lines_accurately() {
        assert_eq!(detect_language("Cargo.lock"), "toml");
        assert_eq!(detect_language("crates/jagent-app/Cargo.toml"), "toml");
        assert_eq!(detect_language("src/main.rs"), "rust");
        assert_eq!(detect_language("Dockerfile"), "dockerfile");
        assert_eq!(detect_language("Makefile"), "make");
        let src = "first\nsecond line\nthird\n";
        assert_eq!(line_byte_range(src, 1), Some(0..5));
        assert_eq!(line_byte_range(src, 2), Some(6..17));
        assert_eq!(line_byte_range(src, 3), Some(18..23));
        assert_eq!(line_byte_range(src, 0), None);
        assert_eq!(line_byte_range(src, 99), None);
    }

    #[test]
    fn read_full_source_does_not_truncate_at_500_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.rs");
        let mut content = String::new();
        for i in 1..=1200 {
            content.push_str(&format!("pub const LINE_{i}: usize = {i};\n"));
        }
        std::fs::write(&p, &content).unwrap();
        let (loaded, exists) = read_full_source(&p, "big.rs");
        assert!(exists);
        assert_eq!(loaded.lines().count(), 1200);
        assert!(loaded.contains("pub const LINE_1200: usize = 1200;"));
    }

    #[gpui::test]
    fn file_surface_loads_over_500_lines_supports_editing_saving_and_word_wrap_setting(
        cx: &mut gpui::TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let src_dir = dir.path().join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        let target_file = src_dir.join("large.rs");
        let mut body = String::new();
        for i in 1..=900 {
            body.push_str(&format!("pub fn f_{i}() -> usize {{ {i} }}\n"));
        }
        std::fs::write(&target_file, &body).unwrap();

        let (state, thread_id) = cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::install(cx).unwrap();
            crate::actions::install(cx, &jagent_core::settings::Settings::default());
            let state = crate::state::init(
                cx,
                dir.path().to_path_buf(),
                dir.path().to_string_lossy().into_owned(),
            )
            .unwrap();
            let ws = state.read(cx).workspaces()[0].id.clone();
            let tid = state.update(cx, |s, cx| {
                let tid = s.threads.create_chat(Some(&ws)).unwrap();
                s.threads.open_session_file(&tid, "src/large.rs");
                s.flush(cx);
                cx.emit(crate::state::StateChanged);
                tid
            });
            (state, tid)
        });

        let (root_win, cx) = cx.add_window_view(|window, cx| {
            let root_view = cx.new(|cx| RootView::new(state.clone(), cx));
            gpui_base::Root::new(root_view, window, cx)
        });
        cx.run_until_parked();

        cx.update(|window, cx| {
            let _ = window.draw(cx);
            let rv = root_win
                .read(cx)
                .view()
                .clone()
                .downcast::<RootView>()
                .unwrap();

            // 1. 验证超过 500 行的文件完整加载进 EditorState，未截断
            assert_eq!(rv.read(cx).file_surface.line_count(), 900);
            let loaded_text = rv
                .read(cx)
                .file_surface
                .current_editor_text(cx)
                .expect("editor state initialized");
            assert!(loaded_text.contains("pub fn f_900() -> usize { 900 }"));
            assert!(!rv.read(cx).file_surface.is_dirty(cx));

            // 2. 模拟在 Editor 中修改内容 → 标记为 is_dirty
            let ed = rv.read(cx).file_surface.editor_state.clone().unwrap();
            ed.update(cx, |s, cx| {
                s.insert("// edited header\n", window, cx);
            });
            assert!(
                rv.read(cx).file_surface.is_dirty(cx),
                "修改编辑器文本后应标记为未保存 (is_dirty)"
            );

            // 3. 保存修改 → 写回磁盘并清除 is_dirty
            rv.update(cx, |v, cx| {
                v.save_active_file(window, cx);
            });
            assert!(
                !rv.read(cx).file_surface.is_dirty(cx),
                "保存后应清除 is_dirty"
            );
            let on_disk = std::fs::read_to_string(&target_file).unwrap();
            assert!(on_disk.starts_with("// edited header\npub fn f_1()"));
            assert!(on_disk.contains("pub fn f_900()"));

            // 4. 在设置中切换 appearance.wordWrap → 同步到 EditorState
            state.update(cx, |s, cx| {
                s.settings
                    .patch("appearance.wordWrap", serde_json::json!(true));
                s.flush(cx);
                cx.emit(crate::state::StateChanged);
            });
            let _ = window.draw(cx);
            assert_eq!(rv.read(cx).file_surface.last_word_wrap, Some(true));
            let _ = thread_id;
        });
    }

    #[gpui::test]
    fn file_surface_loads_full_source_from_git_when_file_deleted_or_in_history(
        cx: &mut gpui::TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("legacy")).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_owned()
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(
            repo.join("legacy/old_module.ts"),
            "export const LEGACY_VALUE = 42;\nexport function hello() {}\n",
        )
        .unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "add legacy"]);
        let first_sha = git(&["rev-parse", "HEAD"]);

        // 第二个提交删除了 legacy/old_module.ts
        std::fs::remove_file(repo.join("legacy/old_module.ts")).unwrap();
        std::fs::write(repo.join("README.md"), "# New Repo\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "remove legacy"]);

        let state = cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::install(cx).unwrap();
            crate::actions::install(cx, &jagent_core::settings::Settings::default());
            let state = crate::state::init(
                cx,
                dir.path().to_path_buf(),
                repo.to_string_lossy().into_owned(),
            )
            .unwrap();
            let ws = state.read(cx).workspaces()[0].id.clone();
            state.update(cx, |s, cx| {
                let tid = s.threads.create_chat(Some(&ws)).unwrap();
                s.git_graph.selected_sha = Some(first_sha.clone());
                s.threads.open_session_file(&tid, "legacy/old_module.ts");
                s.flush(cx);
                cx.emit(crate::state::StateChanged);
            });
            state
        });

        let (root_win, cx) = cx.add_window_view(|window, cx| {
            let root_view = cx.new(|cx| RootView::new(state.clone(), cx));
            gpui_base::Root::new(root_view, window, cx)
        });
        cx.run_until_parked();

        cx.update(|window, cx| {
            let _ = window.draw(cx);
            let rv = root_win
                .read(cx)
                .view()
                .clone()
                .downcast::<RootView>()
                .unwrap();
            assert!(rv.read(cx).file_surface.has_diff, "历史提交应有 diff");
            let loaded_text = rv
                .read(cx)
                .file_surface
                .current_editor_text(cx)
                .expect("editor state initialized");
            assert!(
                loaded_text.contains("export const LEGACY_VALUE = 42;"),
                "磁盘已删除的历史文件也应从 Git 对象库恢复完整源码，实际: {loaded_text}"
            );
            assert!(!loaded_text.contains("文件不存在"));
        });
    }

    #[gpui::test]
    fn opening_modified_file_defaults_to_source_editor_not_diff(cx: &mut gpui::TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(out.status.success());
        };
        git(&["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("src/lib.rs"), "pub fn v() -> i32 { 1 }\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init"]);
        // 修改工作区文件使其产生 git diff
        std::fs::write(repo.join("src/lib.rs"), "pub fn v() -> i32 { 2 }\n").unwrap();

        let state = cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::install(cx).unwrap();
            crate::actions::install(cx, &jagent_core::settings::Settings::default());
            let state = crate::state::init(
                cx,
                dir.path().to_path_buf(),
                repo.to_string_lossy().into_owned(),
            )
            .unwrap();
            let ws = state.read(cx).workspaces()[0].id.clone();
            state.update(cx, |s, cx| {
                let tid = s.threads.create_chat(Some(&ws)).unwrap();
                s.threads.open_session_file(&tid, "src/lib.rs");
                s.flush(cx);
                cx.emit(crate::state::StateChanged);
            });
            state
        });

        let (root_win, cx) = cx.add_window_view(|window, cx| {
            let root_view = cx.new(|cx| RootView::new(state.clone(), cx));
            gpui_base::Root::new(root_view, window, cx)
        });
        cx.run_until_parked();

        cx.update(|window, cx| {
            let _ = window.draw(cx);
            let rv = root_win
                .read(cx)
                .view()
                .clone()
                .downcast::<RootView>()
                .unwrap();
            assert_eq!(
                rv.read(cx).file_surface_mode,
                FileSurfaceMode::Source,
                "打开文件（即使存在 git diff）默认必须是标准源码编辑器 FileSurfaceMode::Source，而非 Diff"
            );
            assert!(rv.read(cx).file_surface.has_diff);
        });
    }
}
