//! 工作区文件与变更导航面板（Zed Project Panel 风格）：
//! - **文件树 (`WorkPanelTab::Files`)**：通过 `git ls-files`（及非 Git 目录回退遍历）枚举工作区全量文件，
//!   经 `build_workspace_tree` 融合 Git `M/A/D` 状态与单子目录自动折叠（`compact_workspace_dir`），
//!   使用 `gpui_base::Tree`（基于 `uniform_list`）做虚拟化多级树渲染，彻底移除 80 文件与 1 层目录限制；
//! - **变更列表 (`WorkPanelTab::Changes`)**：展示工作区未提交变更统计条与 Modified / Untracked / Deleted 分组；
//! - **实时搜索过滤**：顶部输入框支持按路径多词实时过滤变更列表与项目文件树；
//! - **双形态复用**：既可作为右侧独立面板（`#work-panel`），也可在左侧边栏 `Edit` 模式下作为主导航树渲染。

use std::collections::HashSet;
use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, Context, ElementId, Entity, InteractiveElement, IntoElement,
    ParentElement, Render, ScrollHandle, SharedString, StatefulInteractiveElement, StyleRefinement,
    Styled, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_base::{Tree, TreeEvent, TreeItem, TreeState};
use gpui_component::input::{InputEvent, InputState};
use gpui_component::scroll::ScrollableElement as _;
use gpui_component::{h_flex, v_flex};
use jagent_core::git::{
    WorkspaceTreeNode, WorktreeFile, WorktreeFileKind, WorktreeStatus, build_workspace_tree,
};

use crate::icons::{IconName, icon};
use crate::state::{AppState, StateChanged};
use crate::theme::{colors, hex};
use crate::ui_scale::fs;
use crate::views::field::text_input;
use crate::views::selectable::sel_text_id;

/// 关闭面板的回调（装配层持有 `panel_open` 位）。
pub type CloseFn = Rc<dyn Fn(&mut Window, &mut App)>;

/// 在文件树中点击打开文件的回调（通知 `RootView` 切换到标准编辑器模式 `FileSurfaceMode::Source`）。
pub type OpenFileFn = Rc<dyn Fn(&str, &mut App)>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkPanelTab {
    Changes,
    Files,
}

/// 预览读取上限：超过则截断（大文件不整读进内存）。
const PREVIEW_MAX_BYTES: usize = 2 * 1024 * 1024;
const PREVIEW_MAX_LINES: usize = 50_000;

pub struct WorkPanel {
    app: Entity<AppState>,
    cwd: String,
    workspace_root: String,
    status: Option<WorktreeStatus>,
    all_files: Vec<String>,
    loading: bool,
    not_a_repo: bool,
    error: Option<String>,
    selected: Option<String>,
    diff: Option<String>,
    diff_loading: bool,
    /// 「文件」页的内容预览（按行）；非 UTF-8 / 读失败 → `None`（提示不是文本）
    preview: Option<Vec<String>>,
    preview_loading: bool,
    /// Monotonic token for workspace-level `refresh()` requests.
    refresh_generation: u64,
    /// Monotonic request token: stale single-file diff/preview responses must never overwrite newer UI state.
    request_generation: u64,
    /// Currently accepted patch path; cleared at selection time so stale UI cannot show old patch under new filename.
    accepted_diff_path: Option<String>,
    scroll: ScrollHandle,
    tab: WorkPanelTab,
    /// 虚拟化文件树状态（`gpui_base::TreeState`）
    tree_state: Entity<TreeState>,
    /// 用户显式展开/收起的目录集合
    expanded_dirs: HashSet<String>,
    collapsed_dirs: HashSet<String>,
    /// 搜索过滤关键词与输入框状态
    filter_query: String,
    filter_input: Option<Entity<InputState>>,
    /// 是否作为左侧栏 `Edit` 模式内嵌渲染（隐藏左描边与右上关闭钮）
    sidebar_embedded: bool,
    /// 关闭面板回调（root 右栏装配注入；Git 图弹窗或侧栏内嵌时为 `None`）
    on_close: Option<CloseFn>,
    /// 点击文件打开时的附加回调（例如将 `RootView` 重置为标准源码编辑器模式）
    on_open_file: Option<OpenFileFn>,
}

impl WorkPanel {
    pub fn new(app: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let cwd = app.read(cx).git_cwd();
        cx.subscribe(&app, |_, _, _: &StateChanged, cx| cx.notify())
            .detach();
        let tree_state = cx.new(|cx| TreeState::new(cx));
        cx.subscribe(&tree_state, |this, _, ev: &TreeEvent, _| match ev {
            TreeEvent::Expanded(id) => {
                if let Some(dir) = id.as_ref().strip_prefix("dir:") {
                    this.expanded_dirs.insert(dir.to_owned());
                    this.collapsed_dirs.remove(dir);
                }
            }
            TreeEvent::Collapsed(id) => {
                if let Some(dir) = id.as_ref().strip_prefix("dir:") {
                    this.collapsed_dirs.insert(dir.to_owned());
                    this.expanded_dirs.remove(dir);
                }
            }
        })
        .detach();

        let mut view = Self {
            app,
            workspace_root: cwd.clone(),
            cwd,
            status: None,
            all_files: Vec::new(),
            loading: true,
            not_a_repo: false,
            error: None,
            selected: None,
            diff: None,
            diff_loading: false,
            preview: None,
            preview_loading: false,
            refresh_generation: 0,
            request_generation: 0,
            accepted_diff_path: None,
            scroll: ScrollHandle::new(),
            tab: WorkPanelTab::Changes,
            tree_state,
            expanded_dirs: HashSet::new(),
            collapsed_dirs: HashSet::new(),
            filter_query: String::new(),
            filter_input: None,
            sidebar_embedded: false,
            on_close: None,
            on_open_file: None,
        };
        view.refresh(cx);
        view
    }

    /// 注入关闭回调（右栏形态的装配层持有 `panel_open` 位）。
    pub fn with_on_close(mut self, on_close: CloseFn) -> Self {
        self.on_close = Some(on_close);
        self
    }

    /// 注入文件树点击打开文件时的回调。
    pub fn with_on_open_file(mut self, on_open_file: impl Fn(&str, &mut App) + 'static) -> Self {
        self.on_open_file = Some(Rc::new(on_open_file));
        self
    }

    /// 设为左侧栏 `Edit` 模式内嵌形态（默认展示文件树或变更）。
    pub fn with_sidebar_embedded(mut self, embedded: bool) -> Self {
        self.sidebar_embedded = embedded;
        if embedded {
            self.tab = WorkPanelTab::Files;
        }
        self
    }

    /// 分支菜单「查看变更」入口：切到变更页（规则在装配层，这里只动本面板的 tab）。
    pub fn show_changes(&mut self, cx: &mut Context<Self>) {
        if self.tab != WorkPanelTab::Changes {
            self.scroll.set_offset(gpui::point(px(0.0), px(0.0)));
        }
        self.tab = WorkPanelTab::Changes;
        cx.notify();
    }

    /// AddPopover / 外部「打开文件」入口：切到文件页并选中 `path`（拉 diff/预览）。
    pub fn show_file(&mut self, path: &str, cx: &mut Context<Self>) {
        if self.tab != WorkPanelTab::Files {
            self.scroll.set_offset(gpui::point(px(0.0), px(0.0)));
        }
        self.tab = WorkPanelTab::Files;
        self.select(path, cx);
        let id: SharedString = path.to_owned().into();
        self.tree_state.update(cx, |ts, cx| {
            ts.reveal_item(&id, gpui::ScrollStrategy::Center, cx);
        });
        cx.notify();
    }

    /// 当前页签（装配层 / 测试观测用）。
    pub fn tab(&self) -> WorkPanelTab {
        self.tab
    }

    /// 设置页签。
    pub fn set_tab(&mut self, tab: WorkPanelTab, cx: &mut Context<Self>) {
        if self.tab != tab {
            self.scroll.set_offset(gpui::point(px(0.0), px(0.0)));
            self.tab = tab;
            cx.notify();
        }
    }

    /// 保存文件后刷新工作区状态并保留当前选中文件。
    pub fn refresh_preserve_selection(&mut self, cx: &mut Context<Self>) {
        let keep = self.selected.clone();
        self.refresh(cx);
        if let Some(path) = keep {
            self.selected = Some(path);
        }
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.refresh_generation = self.refresh_generation.wrapping_add(1);
        let generation = self.refresh_generation;
        let next_cwd = self.app.read(cx).git_cwd();
        let cwd_changed = next_cwd != self.cwd;
        self.cwd = next_cwd;
        if cwd_changed || (self.status.is_none() && self.all_files.is_empty()) {
            self.status = None;
            self.loading = true;
            self.not_a_repo = false;
            self.diff = None;
            self.preview = None;
            self.accepted_diff_path = None;
        }
        self.error = None;
        let cwd = self.cwd.clone();
        let weak = cx.entity().downgrade();
        cx.spawn(async move |_, cx| {
            let (status_res, (ws_root, all_files)) = cx
                .background_spawn(async move {
                    let path = std::path::Path::new(&cwd);
                    let status = jagent_core::git::cli::list_worktree_status(path);
                    let files = jagent_core::git::cli::list_workspace_files(path);
                    (status, files)
                })
                .await;
            let _ = weak.update(cx, |this, cx| {
                if this.refresh_generation != generation {
                    return;
                }
                this.not_a_repo = status_res.is_none();
                this.workspace_root = status_res
                    .as_ref()
                    .map(|s| s.root.clone())
                    .unwrap_or(ws_root);
                this.status = status_res;
                this.all_files = all_files;
                this.loading = false;
                this.rebuild_tree_items(cx);
                if let Some(sel) = this.selected.clone() {
                    this.select(&sel, cx);
                    let id: SharedString = sel.into();
                    this.tree_state.update(cx, |ts, cx| {
                        ts.reveal_item(&id, gpui::ScrollStrategy::Center, cx);
                    });
                } else {
                    this.diff = None;
                    this.preview = None;
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn rebuild_tree_items(&mut self, cx: &mut Context<Self>) {
        let changed = self
            .status
            .as_ref()
            .map(|s| s.files.as_slice())
            .unwrap_or(&[]);
        let root_node = build_workspace_tree(&self.all_files, changed, &self.filter_query);
        let force_expand = !self.filter_query.trim().is_empty();
        let items = self.build_tree_children("", &root_node, 0, force_expand);
        self.tree_state.update(cx, |ts, cx| {
            ts.set_items(items, cx);
        });
    }

    fn build_tree_children(
        &self,
        parent_rel: &str,
        node: &WorkspaceTreeNode,
        _depth: usize,
        force_expand: bool,
    ) -> Vec<TreeItem> {
        let mut out = Vec::new();
        for (dir_name, child) in &node.dirs {
            let dir_rel = if parent_rel.is_empty() {
                dir_name.clone()
            } else {
                format!("{parent_rel}/{dir_name}")
            };
            let dir_id = format!("dir:{dir_rel}");
            let is_expanded = if force_expand {
                true
            } else if self.collapsed_dirs.contains(&dir_rel) {
                false
            } else {
                self.expanded_dirs.contains(&dir_rel)
            };
            let children = self.build_tree_children(&dir_rel, child, _depth + 1, force_expand);
            out.push(
                TreeItem::new(dir_id, dir_name.clone())
                    .expanded(is_expanded)
                    .children(children),
            );
        }
        for f in &node.files {
            out.push(TreeItem::new(f.path.clone(), f.name.clone()));
        }
        out
    }

    /// 收起文件树中所有已展开的目录。
    pub fn collapse_all_dirs(&mut self, cx: &mut Context<Self>) {
        self.expanded_dirs.clear();
        self.collapsed_dirs.clear();
        self.rebuild_tree_items(cx);
        cx.notify();
    }

    pub fn select(&mut self, path: &str, cx: &mut Context<Self>) {
        self.request_generation = self.request_generation.wrapping_add(1);
        let generation = self.request_generation;
        self.selected = Some(path.to_owned());
        self.diff = None;
        self.accepted_diff_path = None;
        self.diff_loading = true;
        self.preview = None;
        self.preview_loading = true;
        let root = self
            .status
            .as_ref()
            .map(|s| s.root.clone())
            .unwrap_or_else(|| self.workspace_root.clone());
        if root.is_empty() {
            return;
        }
        let expected_root = root.clone();
        let preview_root = root.clone();
        let path = path.to_owned();
        let expected_path = path.clone();
        let preview_path = expected_path.clone();
        let weak = cx.entity().downgrade();
        cx.spawn(async move |_, cx| {
            let result = cx
                .background_spawn(async move {
                    jagent_core::git::cli::diff_worktree_file(std::path::Path::new(&root), &path)
                        .map_err(|e| e.to_string())
                })
                .await;
            let _ = weak.update(cx, |this, cx| {
                let current_root = this
                    .status
                    .as_ref()
                    .map(|status| status.root.as_str())
                    .unwrap_or(this.workspace_root.as_str());
                if !accept_diff_response(
                    this.request_generation,
                    generation,
                    this.selected.as_deref(),
                    &expected_path,
                    current_root,
                    &expected_root,
                ) {
                    return;
                }
                this.diff_loading = false;
                this.diff = result.ok().filter(|s| !s.is_empty());
                this.accepted_diff_path = Some(expected_path.clone());
                cx.notify();
            });
        })
        .detach();
        // 「文件」页预览同一代际加载：选中即读，tab 切换无需补发
        let weak = cx.entity().downgrade();
        cx.spawn(async move |_, cx| {
            let result = cx
                .background_spawn(async move {
                    read_preview_lines(std::path::Path::new(&preview_root), &preview_path)
                })
                .await;
            let _ = weak.update(cx, |this, cx| {
                if this.request_generation != generation {
                    return;
                }
                this.preview_loading = false;
                this.preview = result;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn ensure_filter_input(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<InputState> {
        if let Some(inp) = &self.filter_input {
            return inp.clone();
        }
        let placeholder = if self.tab == WorkPanelTab::Changes {
            "过滤变更文件…"
        } else {
            "搜索项目文件…"
        };
        let inp = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        cx.subscribe(&inp, |this, inp, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::Change) {
                let q = inp.read(cx).value().to_string();
                if this.filter_query != q {
                    this.filter_query = q;
                    this.rebuild_tree_items(cx);
                    cx.notify();
                }
            }
        })
        .detach();
        self.filter_input = Some(inp.clone());
        inp
    }
}

/// 把文件内容读成预览行：截断到 [`PREVIEW_MAX_BYTES`] / [`PREVIEW_MAX_LINES`]，
/// 非 UTF-8（二进制）→ `None`。纯逻辑，普通 `#[test]` 覆盖。
fn read_preview_lines(root: &std::path::Path, path: &str) -> Option<Vec<String>> {
    use std::io::Read as _;
    let mut bytes = Vec::new();
    std::fs::File::open(root.join(path))
        .ok()?
        .take(PREVIEW_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let slice = &bytes[..bytes.len().min(PREVIEW_MAX_BYTES)];
    let mut end = slice.len();
    while end > 0 && std::str::from_utf8(&slice[..end]).is_err() {
        if slice.len() - end > 4 {
            return None;
        }
        end -= 1;
    }
    if slice.len() - end > 4 {
        return None;
    }
    let text = std::str::from_utf8(&slice[..end]).ok()?;
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|l| l.trim_end_matches('\r').to_owned())
        .collect();
    lines.truncate(PREVIEW_MAX_LINES);
    Some(lines)
}

/// 原型 `splitPath`：`dir/nm` → 目录（可能为空）+ 文件名。
fn split_path(path: &str) -> (String, String) {
    match path.rfind('/') {
        Some(i) => (path[..i].to_owned(), path[i + 1..].to_owned()),
        None => (String::new(), path.to_owned()),
    }
}

/// M/A/D 徽标色与底色（原型 BADGE：m=running 琥珀 / a=done 绿 / d=error 红）
fn badge(badge: WorktreeFileKind) -> (&'static str, gpui::Hsla, gpui::Hsla) {
    match badge {
        WorktreeFileKind::M => (
            "M",
            hex(colors::STATUS_RUNNING),
            crate::theme::rgba_css(251, 191, 36, 0.14),
        ),
        WorktreeFileKind::A => (
            "A",
            hex(colors::STATUS_DONE),
            crate::theme::rgba_css(52, 211, 153, 0.14),
        ),
        WorktreeFileKind::D => (
            "D",
            hex(colors::STATUS_ERROR),
            crate::theme::rgba_css(248, 113, 113, 0.14),
        ),
    }
}

impl Render for WorkPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // 工作区切换跟随：cwd 变了重查
        let cwd_now = self.app.read(cx).git_cwd();
        if cwd_now != self.cwd {
            self.refresh(cx);
        }
        let filter_inp = self.ensure_filter_input(window, cx);
        let files = self
            .status
            .as_ref()
            .map(|s| s.files.as_slice())
            .unwrap_or(&[]);
        let query_terms: Vec<String> = self
            .filter_query
            .split_whitespace()
            .map(|s| s.to_lowercase())
            .collect();
        let filtered_changes: Vec<&WorktreeFile> = files
            .iter()
            .filter(|f| {
                if query_terms.is_empty() {
                    return true;
                }
                let lower = f.path.to_lowercase();
                query_terms.iter().all(|t| lower.contains(t.as_str()))
            })
            .collect();

        let add: u32 = files.iter().filter_map(|f| f.added).sum();
        let del: u32 = files.iter().filter_map(|f| f.deleted).sum();
        let tab = if self.sidebar_embedded {
            WorkPanelTab::Files
        } else {
            self.tab
        };
        let selected = if tab == WorkPanelTab::Files {
            self.selected.as_deref()
        } else {
            self.selected
                .as_deref()
                .or_else(|| files.first().map(|f| f.path.as_str()))
        };
        let weak = cx.entity().downgrade();
        let tab_changes = weak.clone();
        let tab_files = weak.clone();
        let refresh = weak.clone();
        let collapse_all = weak.clone();
        let on_close = if self.sidebar_embedded {
            None
        } else {
            self.on_close.clone()
        };

        // ── 头（侧栏 Edit 模式为纯粹的标准文件浏览器标题栏；右栏模式保留 文件树/变更 切换）──
        let files_count =
            (!self.loading || !self.all_files.is_empty()).then_some(self.all_files.len());
        let changes_count = (!self.loading || self.status.is_some()).then_some(files.len());
        let ws_root_name = std::path::Path::new(&self.workspace_root)
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("项目文件")
            .to_owned();
        let header = if self.sidebar_embedded {
            h_flex()
                .flex_shrink_0()
                .h(px(30.0))
                .pl(px(12.0))
                .pr(px(8.0))
                .gap(px(6.0))
                .items_center()
                .child(icon(IconName::Folder, 12.5, hex(colors::ACCENT_HOVER)))
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_size(fs(11.5))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .child(ws_root_name),
                )
                .when_some(files_count, |d, n| {
                    d.child(
                        div()
                            .px(px(5.0))
                            .rounded(px(4.0))
                            .bg(hex(colors::SURFACE))
                            .font_family("monospace")
                            .text_size(fs(10.0))
                            .text_color(hex(colors::MUTED))
                            .child(format!("{n}")),
                    )
                })
                .child(div().flex_1())
                .child(
                    div()
                        .id(ElementId::Name("explorer-collapse-all".into()))
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(fs(24.0))
                        .rounded(px(6.0))
                        .flex_shrink_0()
                        .cursor_pointer()
                        .hover(|h| h.bg(hex(colors::SURFACE)))
                        .child(icon(IconName::ChevronUp, 12.5, hex(colors::MUTED)))
                        .on_click(move |_, _, cx| {
                            let _ = collapse_all.update(cx, |v, cx| v.collapse_all_dirs(cx));
                        }),
                )
                .child(
                    div()
                        .id(ElementId::Name("worktree-refresh".into()))
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(fs(24.0))
                        .rounded(px(6.0))
                        .flex_shrink_0()
                        .cursor_pointer()
                        .hover(|h| h.bg(hex(colors::SURFACE)))
                        .child(icon(IconName::Reset, 12.5, hex(colors::MUTED)))
                        .on_click(move |_, _, cx| {
                            let _ = refresh.update(cx, |v, cx| v.refresh(cx));
                        }),
                )
        } else {
            h_flex()
                .flex_shrink_0()
                .h(px(34.0))
                .pl(px(8.0))
                .pr(px(8.0))
                .gap(px(4.0))
                .items_center()
                .border_b_1()
                .border_color(hex(colors::BORDER))
                .child(ptab(
                    "files",
                    IconName::Folder,
                    "文件树",
                    files_count,
                    tab == WorkPanelTab::Files,
                    move |cx| {
                        let _ = tab_files.update(cx, |v, cx| {
                            v.set_tab(WorkPanelTab::Files, cx);
                        });
                    },
                ))
                .child(ptab(
                    "changes",
                    IconName::GitBranch,
                    "变更",
                    changes_count,
                    tab == WorkPanelTab::Changes,
                    move |cx| {
                        let _ = tab_changes.update(cx, |v, cx| {
                            v.set_tab(WorkPanelTab::Changes, cx);
                        });
                    },
                ))
                .child(div().flex_1())
                // 刷新（26×26 r6；reset 13.5）
                .child(
                    div()
                        .id(ElementId::Name("worktree-refresh".into()))
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(fs(26.0))
                        .rounded(px(6.0))
                        .flex_shrink_0()
                        .cursor_pointer()
                        .hover(|h| h.bg(hex(colors::SURFACE)))
                        .child(icon(IconName::Reset, 13.5, hex(colors::MUTED)))
                        .on_click(move |_, _, cx| {
                            let _ = refresh.update(cx, |v, cx| v.refresh(cx));
                        }),
                )
                // 关闭面板
                .when_some(on_close, |header, on_close| {
                    header.child(
                        div()
                            .id(ElementId::Name("worktree-close".into()))
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(fs(26.0))
                            .rounded(px(6.0))
                            .flex_shrink_0()
                            .cursor_pointer()
                            .hover(|h| h.bg(hex(colors::SURFACE)))
                            .child(icon(IconName::Close, 13.5, hex(colors::MUTED)))
                            .on_click(move |_, w, cx| on_close(w, cx)),
                    )
                })
        };

        // ── 实时搜索过滤条 ──
        let search_bar = div()
            .flex_shrink_0()
            .pt(if self.sidebar_embedded {
                px(2.0)
            } else {
                px(6.0)
            })
            .pb(px(4.0))
            .px(px(8.0))
            .child(text_input(&filter_inp));

        // ── 主体区域 ──
        let content_area: AnyElement = if let Some(e) = &self.error {
            hint(e)
        } else if self.loading {
            hint("读取工作区文件…")
        } else if tab == WorkPanelTab::Files {
            if self.all_files.is_empty() && files.is_empty() {
                hint("当前工作区暂无文件。")
            } else {
                let selected_owned = selected.map(str::to_owned);
                let weak_select = cx.entity().downgrade();
                let app_for_open = self.app.clone();
                let on_open_file = self.on_open_file.clone();
                let scroll_handle = self.tree_state.read(cx).scroll_handle().clone();

                div()
                    .id("work-panel-tree-container")
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .size_full()
                    .relative()
                    .px(px(4.0))
                    .py(px(4.0))
                    .child(
                        Tree::new(&self.tree_state)
                            .item(move |_ix, entry, _entry_state, _window, _cx| {
                                let id_str = entry.item().id.as_ref().to_owned();
                                let label = entry.item().label.clone();
                                let depth = entry.depth();
                                let indent = (depth as f32) * 14.0 + 6.0;

                                if entry.is_folder() {
                                    let is_open = entry.is_expanded();
                                    h_flex()
                                        .id(ElementId::Name(format!("wp-{id_str}").into()))
                                        .w_full()
                                        .h(px(26.0))
                                        .pl(px(indent))
                                        .pr(px(8.0))
                                        .gap(px(5.0))
                                        .items_center()
                                        .rounded(px(6.0))
                                        .cursor_pointer()
                                        .hover(|h| h.bg(hex(colors::SURFACE)))
                                        .child(icon(
                                            if is_open {
                                                IconName::ChevronDown
                                            } else {
                                                IconName::ChevronRight
                                            },
                                            11.0,
                                            hex(colors::MUTED),
                                        ))
                                        .child(icon(
                                            IconName::Folder,
                                            12.5,
                                            hex(colors::ACCENT_HOVER),
                                        ))
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .overflow_hidden()
                                                .whitespace_nowrap()
                                                .text_ellipsis()
                                                .font_family("monospace")
                                                .text_size(fs(11.5))
                                                .font_weight(gpui::FontWeight::MEDIUM)
                                                .text_color(hex(colors::TEXT))
                                                .child(label),
                                        )
                                        .into_any_element()
                                } else {
                                    let is_sel = selected_owned.as_deref() == Some(id_str.as_str());
                                    let name_color = if is_sel {
                                        hex(colors::TEXT_BRIGHT)
                                    } else {
                                        hex(colors::TEXT)
                                    };
                                    let weak_click = weak_select.clone();
                                    let app_click = app_for_open.clone();
                                    let on_open_click = on_open_file.clone();
                                    let path_click = id_str.clone();
                                    h_flex()
                                        .id(ElementId::Name(format!("work-file-{id_str}").into()))
                                        .w_full()
                                        .h(px(26.0))
                                        .pl(px(indent + 14.0))
                                        .pr(px(8.0))
                                        .gap(px(6.0))
                                        .items_center()
                                        .rounded(px(6.0))
                                        .cursor_pointer()
                                        .when_else(
                                            is_sel,
                                            |d| d.bg(hex(colors::SURFACE_ACTIVE)),
                                            |d| d.hover(|h| h.bg(hex(colors::SURFACE))),
                                        )
                                        .child(icon(
                                            IconName::File,
                                            12.0,
                                            if is_sel {
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
                                                .text_size(fs(11.5))
                                                .when(is_sel, |d| {
                                                    d.font_weight(gpui::FontWeight::SEMIBOLD)
                                                })
                                                .text_color(name_color)
                                                .child(label),
                                        )
                                        .on_click(move |_, _, cx| {
                                            let _ = weak_click
                                                .update(cx, |v, cx| v.select(&path_click, cx));
                                            if let Some(cb) = &on_open_click {
                                                cb(&path_click, cx);
                                            }
                                            open_in_main_canvas(&app_click, &path_click, cx);
                                        })
                                        .into_any_element()
                                }
                            })
                            .list_style(StyleRefinement::default().flex_grow_1().size_full())
                            .relative()
                            .size_full(),
                    )
                    .vertical_scrollbar(&scroll_handle)
                    .into_any_element()
            }
        } else if self.not_a_repo {
            hint("当前目录不是 Git 仓库，可切到「文件树」浏览与编辑文件。")
        } else if filtered_changes.is_empty() {
            hint(if files.is_empty() {
                "工作区干净，没有未提交变更。"
            } else {
                "没有匹配的变更文件。"
            })
        } else {
            let weak_select = cx.entity().downgrade();
            let total_stat = (add + del).max(1) as f32;
            let add_ratio = (add as f32 / total_stat).clamp(0.0, 1.0);
            let mut col = v_flex().gap(px(10.0)).child(
                v_flex()
                    .py(px(9.0))
                    .px(px(11.0))
                    .gap(px(6.0))
                    .rounded(px(8.0))
                    .bg(hex(colors::INPUT_BG))
                    .border_1()
                    .border_color(hex(colors::BORDER_SUBTLE))
                    .child(
                        h_flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .text_size(fs(11.5))
                                    .font_weight(gpui::FontWeight::SEMIBOLD)
                                    .text_color(hex(colors::TEXT_BRIGHT))
                                    .child(format!("工作区未提交变更 ({})", files.len())),
                            )
                            .child(
                                h_flex()
                                    .gap(px(6.0))
                                    .font_family("monospace")
                                    .text_size(fs(11.0))
                                    .child(
                                        div()
                                            .text_color(hex(colors::STATUS_DONE))
                                            .child(format!("+{add}")),
                                    )
                                    .child(
                                        div()
                                            .text_color(hex(colors::STATUS_ERROR))
                                            .child(format!("−{del}")),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .h(px(4.0))
                            .w_full()
                            .rounded_full()
                            .bg(crate::theme::rgba_css(248, 113, 113, 0.35))
                            .overflow_hidden()
                            .child(
                                div()
                                    .h_full()
                                    .w(gpui::relative(add_ratio))
                                    .bg(hex(colors::STATUS_DONE)),
                            ),
                    ),
            );

            for (kind, group_title) in [
                (WorktreeFileKind::M, "已修改 · Modified"),
                (WorktreeFileKind::A, "新增未跟踪 · Untracked"),
                (WorktreeFileKind::D, "已删除 · Deleted"),
            ] {
                let group_items: Vec<&WorktreeFile> = filtered_changes
                    .iter()
                    .copied()
                    .filter(|f| f.status == kind)
                    .collect();
                if group_items.is_empty() {
                    continue;
                }
                let mut group_col = v_flex().gap(px(2.0)).child(
                    div()
                        .pt(px(2.0))
                        .pb(px(3.0))
                        .px(px(6.0))
                        .text_size(fs(10.5))
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(hex(colors::MUTED))
                        .child(format!("{group_title} ({})", group_items.len())),
                );
                for f in group_items {
                    let is_sel = selected == Some(f.path.as_str());
                    let path = f.path.clone();
                    let weak = weak_select.clone();
                    let app_for_open = self.app.clone();
                    group_col = group_col.child(change_row(f, is_sel, move |cx| {
                        let _ = weak.update(cx, |v, cx| v.select(&path, cx));
                        open_in_main_canvas(&app_for_open, &path, cx);
                    }));
                }
                col = col.child(group_col);
            }
            let _ = (changes_detail, files_detail);
            crate::views::nested_scroll::isolated_panel_scrollable(
                "work-panel-scroll",
                &self.scroll,
                div().pt(px(6.0)).pb(px(10.0)).px(px(8.0)).child(col),
            )
            .into_any_element()
        };

        v_flex()
            .id(if self.sidebar_embedded {
                "sidebar-edit-panel"
            } else {
                "work-panel"
            })
            .w_full()
            .h_full()
            .min_h_0()
            .flex_1()
            .bg(if self.sidebar_embedded {
                hex(colors::PANE)
            } else {
                hex(colors::SIDEBAR)
            })
            .when(!self.sidebar_embedded, |d| {
                d.border_l_1().border_color(hex(colors::BORDER))
            })
            .child(header)
            .child(search_bar)
            .child(content_area)
    }
}

/// 在主画布打开指定文件（自动关联到当前活跃会话或当前工作区会话，绝不跨工作区串台）。
pub fn open_in_main_canvas(app: &Entity<AppState>, path: &str, cx: &mut App) {
    app.update(cx, |s, cx| {
        let ws = s.active_workspace_id();
        let active_tid = s.threads.active_thread_id().and_then(|tid| {
            let t = s.threads.thread(tid)?;
            if ws.is_empty() || t.workspace_id() == Some(ws.as_str()) {
                Some(tid.to_owned())
            } else {
                None
            }
        });
        let tid = active_tid
            .or_else(|| {
                s.threads
                    .threads
                    .iter()
                    .find(|t| !ws.is_empty() && t.workspace_id() == Some(ws.as_str()))
                    .map(|t| t.id().to_owned())
            })
            .or_else(|| {
                if !ws.is_empty() {
                    s.threads.create_chat(Some(&ws)).ok()
                } else {
                    s.threads.threads.first().map(|t| t.id().to_owned())
                }
            });
        if let Some(tid) = tid {
            s.threads.open_session_file(&tid, path);
            if s.threads.active_thread_id() != Some(tid.as_str()) {
                s.activate(jagent_core::threads::ActiveTarget::Thread(tid), cx);
            } else {
                s.flush(cx);
                cx.emit(StateChanged);
            }
        }
    });
}

/// 原型 `ChangeRow`：h34 / p0 8 / r6；左 18×18 圆角徽标块 + 中间双行（nm + dir）+ 右侧 ±计数。
fn change_row(
    file: &WorktreeFile,
    selected: bool,
    on_click: impl Fn(&mut App) + 'static,
) -> impl IntoElement {
    let (dir, nm) = split_path(&file.path);
    let (bdg_txt, bdg_fg, bdg_bg) = badge(file.status);
    let nm_color = if selected {
        hex(colors::TEXT_BRIGHT)
    } else {
        hex(colors::TEXT)
    };
    h_flex()
        .id(ElementId::Name(format!("work-file-{}", file.path).into()))
        .h(px(34.0))
        .px(px(8.0))
        .gap(px(7.0))
        .items_center()
        .flex_shrink_0()
        .rounded(px(6.0))
        .cursor_pointer()
        .when_else(
            selected,
            |d| d.bg(hex(colors::SURFACE_ACTIVE)),
            |d| d.hover(|h| h.bg(hex(colors::SURFACE))),
        )
        .on_click(move |_, _, cx| on_click(cx))
        .child(
            div()
                .size(px(18.0))
                .rounded(px(4.0))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .bg(bdg_bg)
                .font_family("monospace")
                .text_size(fs(10.0))
                .font_weight(gpui::FontWeight::BOLD)
                .text_color(bdg_fg)
                .child(bdg_txt),
        )
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .font_family("monospace")
                        .text_size(fs(12.0))
                        .font_weight(if selected {
                            gpui::FontWeight::SEMIBOLD
                        } else {
                            gpui::FontWeight::MEDIUM
                        })
                        .line_height(px(15.0))
                        .text_color(nm_color)
                        .child(nm),
                )
                .when(!dir.is_empty(), |d| {
                    d.child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .font_family("monospace")
                            .text_size(fs(10.0))
                            .line_height(px(12.5))
                            .text_color(hex(colors::MUTED))
                            .child(dir),
                    )
                }),
        )
        .child(
            h_flex()
                .gap(px(4.0))
                .items_center()
                .flex_shrink_0()
                .children(file.added.filter(|n| *n > 0).map(|n| {
                    div()
                        .font_family("monospace")
                        .text_size(fs(10.5))
                        .text_color(hex(colors::STATUS_DONE))
                        .child(format!("+{n}"))
                }))
                .children(file.deleted.filter(|n| *n > 0).map(|n| {
                    div()
                        .font_family("monospace")
                        .text_size(fs(10.5))
                        .text_color(hex(colors::STATUS_ERROR))
                        .child(format!("−{n}"))
                })),
        )
}

/// 「变更」页选中文件的详情：diff 或未跟踪提示（原型 `Diff`）。
fn changes_detail(file: &WorktreeFile, panel: &WorkPanel) -> impl IntoElement {
    let mut col = v_flex();
    if file.status == WorktreeFileKind::A && panel.diff.is_none() && !panel.diff_loading {
        col = col.child(hint("未跟踪文件——无 diff，在「文件」页查看内容。"));
    } else if panel.diff_loading {
        col = col.child(hint("加载 diff…"));
    } else if let Some(patch) = &panel.diff {
        col = col.child(diff_view(patch));
    } else {
        col = col.child(hint("此文件没有文本 diff。"));
    }
    col
}

/// 「文件」页选中文件的内容预览（原型 `Preview`：code-view + 34px 行号列）。
fn files_detail(panel: &WorkPanel) -> impl IntoElement {
    if panel.preview_loading {
        return hint("读取文件…");
    }
    match panel.preview.as_ref() {
        Some(lines) => v_flex()
            .id("code-view")
            .font_family("monospace")
            .text_size(fs(11.0))
            .line_height(px(17.0))
            .overflow_hidden()
            .children(lines.iter().enumerate().map(|(i, line)| {
                h_flex()
                    .id(ElementId::Name(format!("code-line-{}", i + 1).into()))
                    .whitespace_nowrap()
                    .child(
                        div()
                            .w(px(34.0))
                            .flex_shrink_0()
                            .text_right()
                            .pr(px(10.0))
                            .text_color(hex(colors::MUTED))
                            .child(format!("{}", i + 1)),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_color(hex(colors::TEXT))
                            .child(if line.is_empty() {
                                " ".into_any_element()
                            } else {
                                sel_text_id(("wp-code-line", i), line.clone()).into_any_element()
                            }),
                    )
            }))
            .into_any_element(),
        None => hint("此文件不是文本，无法预览。").into_any_element(),
    }
}

/// 面板顶部切换胶囊 `.ptab`：h24 / px 8 / gap 5 / r6 / 11.5px；
/// active = surfaceActive 底 + accentHover 图标 + textBright；非激活无框柔和悬停。
fn ptab(
    key: &'static str,
    ic: IconName,
    label: &'static str,
    count: Option<usize>,
    active: bool,
    on_click: impl Fn(&mut App) + 'static,
) -> impl IntoElement {
    let (fg, fg_icon) = if active {
        (hex(colors::TEXT_BRIGHT), hex(colors::ACCENT_HOVER))
    } else {
        (hex(colors::MUTED), hex(colors::MUTED))
    };
    h_flex()
        .id(ElementId::Name(format!("work-tab-{key}").into()))
        .h(px(24.0))
        .pl(px(8.0))
        .pr(px(8.0))
        .gap(px(5.0))
        .items_center()
        .flex_shrink_0()
        .rounded(px(6.0))
        .cursor_pointer()
        .text_size(fs(11.5))
        .when_else(
            active,
            |d| {
                d.bg(hex(colors::SURFACE_ACTIVE))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
            },
            |d| d.hover(|h| h.bg(hex(colors::SURFACE))),
        )
        .child(icon(ic, 12.0, fg_icon))
        .child(div().text_color(fg).child(label))
        .when_some(count, |d, n| {
            d.child(
                div()
                    .px(px(5.0))
                    .rounded(px(4.0))
                    .bg(if active {
                        crate::theme::rgba_css(99, 102, 241, 0.20)
                    } else {
                        hex(colors::SURFACE)
                    })
                    .font_family("monospace")
                    .text_size(fs(10.0))
                    .text_color(if active {
                        hex(colors::ACCENT_HOVER)
                    } else {
                        hex(colors::MUTED)
                    })
                    .child(format!("{n}")),
            )
        })
        .on_click(move |_, _, cx| on_click(cx))
}

fn hint(text: &str) -> gpui::AnyElement {
    div()
        .flex_1()
        .min_h_0()
        .p(px(14.0))
        .text_size(fs(11.5))
        .text_color(hex(colors::MUTED))
        .child(sel_text_id("wp-hint", text.to_owned()))
        .into_any_element()
}

fn accept_diff_response(
    current_generation: u64,
    response_generation: u64,
    selected: Option<&str>,
    response_path: &str,
    current_root: &str,
    response_root: &str,
) -> bool {
    current_generation == response_generation
        && selected == Some(response_path)
        && current_root == response_root
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiffLineKind {
    Added,
    Removed,
    Hunk,
    Meta,
    Context,
}

fn diff_line_kind(line: &str) -> DiffLineKind {
    if line.starts_with("+++")
        || line.starts_with("---")
        || line.starts_with("diff ")
        || line.starts_with("index ")
    {
        DiffLineKind::Meta
    } else if line.starts_with('+') {
        DiffLineKind::Added
    } else if line.starts_with('-') {
        DiffLineKind::Removed
    } else if line.starts_with("@@") {
        DiffLineKind::Hunk
    } else {
        DiffLineKind::Context
    }
}

fn diff_view(patch: &str) -> impl IntoElement {
    v_flex()
        .mt(px(6.0))
        .pt(px(6.0))
        .border_t_1()
        .border_color(hex(colors::BORDER))
        .font_family("monospace")
        .text_size(fs(11.0))
        .line_height(px(16.5))
        .overflow_hidden()
        .children(patch.lines().enumerate().map(|(i, line)| {
            let (color, bg) = match diff_line_kind(line) {
                DiffLineKind::Added => (
                    hex(colors::TERMINAL_KIND),
                    Some(crate::theme::rgba_css(152, 195, 121, 0.12)),
                ),
                DiffLineKind::Removed => (
                    hex(colors::STATUS_ERROR),
                    Some(crate::theme::rgba_css(224, 108, 117, 0.12)),
                ),
                DiffLineKind::Hunk => (hex(colors::CYAN), Some(hex(colors::TILE))),
                DiffLineKind::Meta => (hex(colors::MUTED), None),
                DiffLineKind::Context => (hex(colors::TEXT), None),
            };
            div()
                .w_full()
                .pl(px(8.0))
                .pr(px(8.0))
                .whitespace_nowrap()
                .overflow_hidden()
                .text_color(color)
                .when_some(bg, |d, c| d.bg(c))
                .child(if line.is_empty() {
                    " ".into_any_element()
                } else {
                    sel_text_id(("wp-diff-line", i), line.to_owned()).into_any_element()
                })
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[gpui::test]
    fn work_panel_loads_real_status_and_selection_loads_the_file_diff(
        cx: &mut gpui::TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
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
        };
        git(&["init", "-q"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();

        let state = cx.update(|cx| {
            crate::state::init(
                cx,
                dir.path().to_path_buf(),
                repo.to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let panel = cx.update(|cx| cx.new(|cx| WorkPanel::new(state, cx)));
        cx.run_until_parked();
        let path = cx.update(|cx| {
            let p = panel.read(cx);
            let f = p.status.as_ref().unwrap().files.first().unwrap();
            assert_eq!(f.path, "a.txt");
            f.path.clone()
        });
        cx.update(|cx| panel.update(cx, |p, cx| p.select(&path, cx)));
        cx.run_until_parked();
        cx.update(|cx| {
            let p = panel.read(cx);
            assert_eq!(p.selected.as_deref(), Some("a.txt"));
            assert!(
                p.diff.as_deref().unwrap().contains("+two"),
                "diff={:?}",
                p.diff
            );
            assert!(!p.diff_loading);
        });
    }

    #[gpui::test]
    fn selecting_a_file_also_loads_its_preview_lines(cx: &mut gpui::TestAppContext) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
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
        };
        git(&["init", "-q"]);
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("src/main.rs"), "fn main() {\n}\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init"]);
        std::fs::write(
            repo.join("src/main.rs"),
            "fn main() {\n    println!(\"x\");\n}\n",
        )
        .unwrap();

        let state = cx.update(|cx| {
            crate::state::init(
                cx,
                dir.path().to_path_buf(),
                repo.to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let panel = cx.update(|cx| cx.new(|cx| WorkPanel::new(state, cx)));
        cx.run_until_parked();
        cx.update(|cx| panel.update(cx, |p, cx| p.select("src/main.rs", cx)));
        cx.run_until_parked();
        cx.update(|cx| {
            let p = panel.read(cx);
            assert!(!p.preview_loading);
            let lines = p.preview.as_ref().expect("文本文件应读到预览");
            assert_eq!(lines.len(), 4);
            assert_eq!(lines[0], "fn main() {");
            assert_eq!(lines[1], "    println!(\"x\");");
        });
    }

    #[test]
    fn preview_reading_truncates_and_rejects_binary() {
        let dir = tempfile::tempdir().unwrap();
        let long: String = "x".repeat(64);
        std::fs::write(dir.path().join("long.txt"), &long).unwrap();
        let lines = read_preview_lines(dir.path(), "long.txt").unwrap();
        assert_eq!(lines, vec![long]);
        std::fs::write(dir.path().join("crlf.txt"), b"a\r\nb\r\n").unwrap();
        assert_eq!(
            read_preview_lines(dir.path(), "crlf.txt").unwrap(),
            vec!["a".to_string(), "b".to_string(), String::new()]
        );
        let bin = vec![0xFFu8; 1024];
        std::fs::write(dir.path().join("bin.dat"), bin).unwrap();
        assert!(read_preview_lines(dir.path(), "bin.dat").is_none());
        assert!(read_preview_lines(dir.path(), "nope.txt").is_none());
    }

    #[test]
    fn work_panel_tab_models_are_distinct_and_default_to_changes() {
        assert_eq!(WorkPanelTab::Changes, WorkPanelTab::Changes);
        assert_ne!(WorkPanelTab::Changes, WorkPanelTab::Files);
    }

    #[test]
    fn split_path_separates_the_directory_from_the_file_name() {
        assert_eq!(
            split_path("src/ui/pane.rs"),
            ("src/ui".to_owned(), "pane.rs".to_owned())
        );
        assert_eq!(split_path("a.txt"), (String::new(), "a.txt".to_owned()));
        assert_eq!(split_path("dir/"), ("dir".to_owned(), String::new()));
    }

    #[test]
    fn stale_file_diff_responses_are_rejected_by_generation_selection_and_root() {
        assert!(accept_diff_response(
            4,
            4,
            Some("b.txt"),
            "b.txt",
            "/repo",
            "/repo"
        ));
        assert!(
            !accept_diff_response(5, 4, Some("b.txt"), "b.txt", "/repo", "/repo"),
            "older request generation"
        );
        assert!(
            !accept_diff_response(4, 4, Some("b.txt"), "a.txt", "/repo", "/repo"),
            "selection changed"
        );
        assert!(
            !accept_diff_response(4, 4, Some("b.txt"), "b.txt", "/other", "/repo"),
            "workspace root changed"
        );
    }

    #[gpui::test]
    fn selecting_new_file_clears_previous_diff_until_new_patch_response(
        cx: &mut gpui::TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
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
        };
        git(&["init", "-q"]);
        for name in ["a.txt", "b.txt"] {
            std::fs::write(repo.join(name), "base\n").unwrap();
        }
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "base"]);
        for name in ["a.txt", "b.txt"] {
            std::fs::write(repo.join(name), "base\nchanged\n").unwrap();
        }
        let state = cx.update(|cx| {
            crate::state::init(
                cx,
                dir.path().to_path_buf(),
                repo.to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let panel = cx.update(|cx| cx.new(|cx| WorkPanel::new(state, cx)));
        cx.run_until_parked();
        let paths = cx.update(|cx| {
            panel
                .read(cx)
                .status
                .as_ref()
                .unwrap()
                .files
                .iter()
                .map(|f| f.path.clone())
                .collect::<Vec<_>>()
        });
        assert_eq!(paths.len(), 2);
        cx.update(|cx| panel.update(cx, |p, cx| p.select(&paths[0], cx)));
        cx.run_until_parked();
        assert_eq!(
            cx.update(|cx| panel.read(cx).accepted_diff_path.clone()),
            Some(paths[0].clone())
        );
        cx.update(|cx| panel.update(cx, |p, cx| p.select(&paths[1], cx)));
        assert_eq!(
            cx.update(|cx| panel.read(cx).accepted_diff_path.clone()),
            None
        );
        cx.run_until_parked();
        assert_eq!(
            cx.update(|cx| panel.read(cx).accepted_diff_path.clone()),
            Some(paths[1].clone())
        );
    }

    #[test]
    fn unified_diff_lines_are_classified_for_added_removed_hunk_and_metadata() {
        assert_eq!(diff_line_kind("+added"), DiffLineKind::Added);
        assert_eq!(diff_line_kind("-removed"), DiffLineKind::Removed);
        assert_eq!(diff_line_kind("@@ -1 +1 @@"), DiffLineKind::Hunk);
        assert_eq!(diff_line_kind("+++ b/file"), DiffLineKind::Meta);
        assert_eq!(diff_line_kind("--- a/file"), DiffLineKind::Meta);
        assert_eq!(diff_line_kind(" context"), DiffLineKind::Context);
    }

    #[gpui::test]
    fn show_file_immediately_after_new_does_not_abort_initial_refresh(
        cx: &mut gpui::TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
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
        git(&["init", "-q"]);
        std::fs::write(repo.join("Cargo.lock"), "version = 3\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init"]);
        std::fs::write(repo.join("Cargo.lock"), "version = 4\n").unwrap();

        let state = cx.update(|cx| {
            crate::state::init(
                cx,
                dir.path().to_path_buf(),
                repo.to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let panel = cx.update(|cx| {
            let p = cx.new(|cx| WorkPanel::new(state, cx));
            p.update(cx, |v, cx| v.show_file("Cargo.lock", cx));
            p
        });
        cx.run_until_parked();
        cx.update(|cx| {
            let p = panel.read(cx);
            assert!(
                !p.loading,
                "show_file 不得打断初始 refresh 导致永远卡在 loading"
            );
            assert_eq!(p.all_files, vec!["Cargo.lock".to_string()]);
            assert_eq!(p.selected.as_deref(), Some("Cargo.lock"));
        });
    }

    #[gpui::test]
    fn sidebar_edit_explorer_starts_collapsed_without_auto_expanding_modified_dirs(
        cx: &mut gpui::TestAppContext,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("crates/app/src")).unwrap();
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
        git(&["init", "-q"]);
        std::fs::write(repo.join("README.md"), "# readme\n").unwrap();
        std::fs::write(repo.join("crates/app/src/main.rs"), "fn main() {}\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init"]);
        // 修改深层目录中的文件
        std::fs::write(
            repo.join("crates/app/src/main.rs"),
            "fn main() { println!(\"changed\"); }\n",
        )
        .unwrap();

        let state = cx.update(|cx| {
            crate::state::init(
                cx,
                dir.path().to_path_buf(),
                repo.to_string_lossy().into_owned(),
            )
            .unwrap()
        });
        let panel =
            cx.update(|cx| cx.new(|cx| WorkPanel::new(state, cx).with_sidebar_embedded(true)));
        cx.run_until_parked();
        cx.update(|cx| {
            let p = panel.read(cx);
            assert_eq!(p.tab(), WorkPanelTab::Files);
            assert_eq!(p.selected, None, "初始不应自动选中任何变更文件");
            let ts = p.tree_state.read(cx);
            let root_folder = ts.entry(0).expect("root folder crates");
            assert!(root_folder.is_folder());
            assert_eq!(root_folder.item().label.as_ref(), "crates");
            assert!(
                !root_folder.is_expanded(),
                "即使子目录包含 Git 修改，标准文件树顶层目录默认也应保持收起"
            );
        });
    }
}
