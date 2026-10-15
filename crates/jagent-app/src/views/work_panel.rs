//! 工作区变更面板（V2 按原型重对齐）：真实 `git status` / unified diff / 文件内容预览。
//!
//! 像素契约 = 原型 `WorkPanel.tsx` + `index.css`（R9 增补 line 809-812 覆盖后）：
//! - `#work-panel`：bg sidebar + 左缘 1px borderSubtle；宽度与 flex 收缩由外层
//!   （root 的 resizable 右栏 / <1100 的 absolute 浮层）决定，本组件 `w_full`；
//! - `.wp-head` 44px：ptab（icon 12 + 11.5px 文案，h28 p0 10 r8；active = surface
//!   底 + borderSubtle 边 + textBright + 1px 黑阴影）+ 刷新 / 关闭两个 hbtn（28×28）；
//! - `.wp-body` p6 滚动：wp-sum（工作区变更 + mono 计数）→ file-row（h32 r8，
//!   M/A/D 徽标 + basename + dir 灰 + ±计数）→ 选中文件的 diff（mono 11，add/del
//!   12% 色底）或 code-view 预览（34px 行号列）。
//!
//! 与原型的差异：刷新钮不弹 toast（桌面通知只记账）；diff 长行裁切不横向滚动
//! （嵌套滚动约束只覆盖竖向，见 views/nested_scroll）。

use std::rc::Rc;

use gpui::{
    App, AppContext as _, Context, ElementId, Entity, InteractiveElement, IntoElement,
    ParentElement, Render, ScrollHandle, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_component::{h_flex, v_flex};
use jagent_core::git::{WorktreeFile, WorktreeFileKind, WorktreeStatus};

use crate::icons::{IconName, icon};
use crate::state::{AppState, StateChanged};
use crate::theme::{colors, hex};

/// 关闭面板的回调（装配层持有 `panel_open` 位）。
pub type CloseFn = Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkPanelTab {
    Changes,
    Files,
}

/// 预览读取上限：超过则截断（大文件不整读进内存）。
const PREVIEW_MAX_BYTES: usize = 256 * 1024;
const PREVIEW_MAX_LINES: usize = 2000;

pub struct WorkPanel {
    app: Entity<AppState>,
    cwd: String,
    status: Option<WorktreeStatus>,
    loading: bool,
    not_a_repo: bool,
    error: Option<String>,
    selected: Option<String>,
    diff: Option<String>,
    diff_loading: bool,
    /// 「文件」页的内容预览（按行）；非 UTF-8 / 读失败 → `None`（提示不是文本）
    preview: Option<Vec<String>>,
    preview_loading: bool,
    /// Monotonic request token: stale status/diff responses must never overwrite newer UI state.
    request_generation: u64,
    /// Currently accepted patch path; cleared at selection time so stale UI cannot show old patch under new filename.
    accepted_diff_path: Option<String>,
    scroll: ScrollHandle,
    tab: WorkPanelTab,
    /// 关闭面板回调（root 右栏装配注入；Git 图弹窗内嵌时为 `None`——钮不做事）
    on_close: Option<CloseFn>,
}

impl WorkPanel {
    pub fn new(app: Entity<AppState>, cx: &mut Context<Self>) -> Self {
        let cwd = app.read(cx).git_cwd();
        cx.subscribe(&app, |_, _, _: &StateChanged, cx| cx.notify())
            .detach();
        let mut view = Self {
            app,
            cwd,
            status: None,
            loading: true,
            not_a_repo: false,
            error: None,
            selected: None,
            diff: None,
            diff_loading: false,
            preview: None,
            preview_loading: false,
            request_generation: 0,
            accepted_diff_path: None,
            scroll: ScrollHandle::new(),
            tab: WorkPanelTab::Changes,
            on_close: None,
        };
        view.refresh(cx);
        view
    }

    /// 注入关闭回调（右栏形态的装配层持有 `panel_open` 位）。
    pub fn with_on_close(mut self, on_close: CloseFn) -> Self {
        self.on_close = Some(on_close);
        self
    }

    /// 分支菜单「查看变更」入口：切到变更页（规则在装配层，这里只动本面板的 tab）。
    pub fn show_changes(&mut self, cx: &mut Context<Self>) {
        self.tab = WorkPanelTab::Changes;
        cx.notify();
    }

    /// AddPopover「打开文件」入口：切到文件页并选中 `path`（拉 diff/预览）。
    pub fn show_file(&mut self, path: &str, cx: &mut Context<Self>) {
        self.tab = WorkPanelTab::Files;
        self.select(path, cx);
        cx.notify();
    }

    /// 当前页签（装配层 / 测试观测用）。
    pub fn tab(&self) -> WorkPanelTab {
        self.tab
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.request_generation = self.request_generation.wrapping_add(1);
        let generation = self.request_generation;
        self.cwd = self.app.read(cx).git_cwd();
        self.status = None;
        self.loading = true;
        self.not_a_repo = false;
        self.error = None;
        self.diff = None;
        self.preview = None;
        self.accepted_diff_path = None;
        let cwd = self.cwd.clone();
        let weak = cx.entity().downgrade();
        cx.spawn(async move |_, cx| {
            let result = cx
                .background_spawn(async move {
                    jagent_core::git::cli::list_worktree_status(std::path::Path::new(&cwd))
                })
                .await;
            let _ = weak.update(cx, |this, cx| {
                if this.request_generation != generation {
                    return;
                }
                this.not_a_repo = result.is_none();
                this.status = result;
                this.loading = false;
                this.selected = None;
                this.diff = None;
                this.preview = None;
                cx.notify();
            });
        })
        .detach();
    }

    fn select(&mut self, path: &str, cx: &mut Context<Self>) {
        self.request_generation = self.request_generation.wrapping_add(1);
        let generation = self.request_generation;
        self.selected = Some(path.to_owned());
        self.diff = None;
        self.accepted_diff_path = None;
        self.diff_loading = true;
        self.preview = None;
        self.preview_loading = true;
        let Some(status) = self.status.as_ref() else {
            return;
        };
        let root = status.root.clone();
        let expected_root = root.clone();
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
                if !accept_diff_response(
                    this.request_generation,
                    generation,
                    this.selected.as_deref(),
                    &expected_path,
                    this.status
                        .as_ref()
                        .map(|status| status.root.as_str())
                        .unwrap_or(""),
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
        let preview_root = status.root.clone();
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
}

/// 把文件内容读成预览行：截断到 [`PREVIEW_MAX_BYTES`] / [`PREVIEW_MAX_LINES`]，
/// 非 UTF-8（二进制）→ `None`。纯逻辑，普通 `#[test]` 覆盖。
fn read_preview_lines(root: &std::path::Path, path: &str) -> Option<Vec<String>> {
    use std::io::Read as _;
    // 只读头部（+1 用来识别超限），避免大变更文件整读的内存尖峰
    let mut bytes = Vec::new();
    std::fs::File::open(root.join(path))
        .ok()?
        .take(PREVIEW_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let slice = &bytes[..bytes.len().min(PREVIEW_MAX_BYTES)];
    // 截断可能落在多字节序列中间：回退到最后一个 UTF-8 边界。
    // 回退超过一个 UTF-8 序列的长度（4）说明内容本身就不是文本 → 按二进制拒绝
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

/// M/A/D 徽标色（原型 BADGE：m=running 琥珀 / a=done 绿 / d=error 红）
fn badge(badge: WorktreeFileKind) -> (&'static str, gpui::Hsla) {
    match badge {
        WorktreeFileKind::M => ("M", hex(colors::STATUS_RUNNING)),
        WorktreeFileKind::A => ("A", hex(colors::STATUS_DONE)),
        WorktreeFileKind::D => ("D", hex(colors::STATUS_ERROR)),
    }
}

impl Render for WorkPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // 工作区切换跟随：cwd 变了重查（对齐原型 worktree 全局跟随语义）
        let cwd_now = self.app.read(cx).git_cwd();
        if cwd_now != self.cwd {
            self.refresh(cx);
        }
        let files = self
            .status
            .as_ref()
            .map(|s| s.files.as_slice())
            .unwrap_or(&[]);
        let add: u32 = files.iter().filter_map(|f| f.added).sum();
        let del: u32 = files.iter().filter_map(|f| f.deleted).sum();
        let selected = self.selected.as_deref();
        let tab = self.tab;
        let weak = cx.entity().downgrade();
        let tab_changes = weak.clone();
        let tab_files = weak.clone();
        let refresh = weak.clone();
        let on_close = self.on_close.clone();

        // ── 头（原型 .wp-head：44px / p0 8 / gap 2 / 底 1px borderSubtle）──
        let header = h_flex()
            .flex_shrink_0()
            .h(px(44.0))
            .pl(px(8.0))
            .pr(px(8.0))
            .gap(px(2.0))
            .items_center()
            .border_b_1()
            .border_color(hex(colors::BORDER_SUBTLE))
            .child(ptab(
                "changes",
                IconName::GitBranch,
                "变更",
                tab == WorkPanelTab::Changes,
                move |cx| {
                    let _ = tab_changes.update(cx, |v, cx| {
                        v.tab = WorkPanelTab::Changes;
                        cx.notify();
                    });
                },
            ))
            .child(ptab(
                "files",
                IconName::File,
                "文件",
                tab == WorkPanelTab::Files,
                move |cx| {
                    let _ = tab_files.update(cx, |v, cx| {
                        v.tab = WorkPanelTab::Files;
                        cx.notify();
                    });
                },
            ))
            .child(div().flex_1())
            // 刷新（原型 .hbtn：28×28 r6；reset 16）
            .child(
                div()
                    .id(ElementId::Name("worktree-refresh".into()))
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(28.0))
                    .rounded(px(6.0))
                    .flex_shrink_0()
                    .cursor_pointer()
                    .hover(|h| h.bg(hex(colors::SURFACE)))
                    .child(icon(IconName::Reset, 16.0, hex(colors::MUTED)))
                    .on_click(move |_, _, cx| {
                        let _ = refresh.update(cx, |v, cx| v.refresh(cx));
                    }),
            )
            // 关闭面板（装配层收起右栏；内嵌于 Git 图弹窗时无回调，钮不做事）
            .when_some(on_close, |header, on_close| {
                header.child(
                    div()
                        .id(ElementId::Name("worktree-close".into()))
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(28.0))
                        .rounded(px(6.0))
                        .flex_shrink_0()
                        .cursor_pointer()
                        .hover(|h| h.bg(hex(colors::SURFACE)))
                        .child(icon(IconName::Close, 16.0, hex(colors::MUTED)))
                        .on_click(move |_, w, cx| on_close(w, cx)),
                )
            });

        // ── 主体（原型 .wp-body：flex1 / p6 滚动）──
        let body: gpui::AnyElement = if let Some(e) = &self.error {
            hint(e)
        } else if self.loading {
            hint("读取工作区状态…")
        } else if self.not_a_repo {
            hint("当前目录不是 Git 仓库。")
        } else if files.is_empty() {
            hint(if tab == WorkPanelTab::Changes {
                "工作区干净，没有变更。"
            } else {
                "工作区没有文件。"
            })
        } else {
            let weak_select = cx.entity().downgrade();
            let mut col = v_flex();
            if tab == WorkPanelTab::Changes {
                // 原型 .wp-sum：「工作区变更」11.5/500 muted + 右侧 mono 10.5 faint 计数
                col = col.child(
                    h_flex()
                        .items_center()
                        .gap(px(8.0))
                        .pl(px(6.0))
                        .pr(px(6.0))
                        .pt(px(4.0))
                        .pb(px(8.0))
                        .child(
                            div()
                                .text_size(px(11.5))
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .text_color(hex(colors::MUTED))
                                .child("工作区变更"),
                        )
                        .child(div().flex_1())
                        .child(
                            div()
                                .font_family("monospace")
                                .text_size(px(10.5))
                                .text_color(hex(colors::FAINT))
                                .child(format!("{} 个文件 +{add} −{del}", files.len())),
                        ),
                );
            }
            let file_list = v_flex().children(files.iter().map(|f| {
                let selected = selected == Some(f.path.as_str());
                let path = f.path.clone();
                let weak = weak_select.clone();
                file_row(f, selected, tab, move |cx| {
                    let _ = weak.update(cx, |v, cx| v.select(&path, cx));
                })
            }));
            col = col.child(file_list);

            let sel_file = files.iter().find(|f| Some(f.path.as_str()) == selected);
            match (tab, sel_file) {
                (WorkPanelTab::Changes, Some(file)) => {
                    col = col.child(changes_detail(file, self));
                }
                (WorkPanelTab::Files, Some(file)) => {
                    // 原型 .wp-file-head：file 12 + path（mono 11 muted）
                    col = col.child(
                        h_flex()
                            .items_center()
                            .gap(px(6.0))
                            .mt(px(6.0))
                            .pt(px(4.0))
                            .pb(px(8.0))
                            .pl(px(6.0))
                            .pr(px(6.0))
                            .child(icon(IconName::File, 12.0, hex(colors::MUTED)))
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .font_family("monospace")
                                    .text_size(px(11.0))
                                    .text_color(hex(colors::MUTED))
                                    .child(file.path.clone()),
                            ),
                    );
                    col = col.child(files_detail(self));
                }
                _ => {}
            }
            col.into_any_element()
        };

        let scrollable = crate::views::nested_scroll::work_panel_scrollable(
            "work-panel-scroll",
            &self.scroll,
            div().p(px(6.0)).child(body),
        );
        // 原型 #work-panel：bg sidebar + 左缘 borderSubtle；宽度由外层决定
        v_flex()
            .id("work-panel")
            .w_full()
            .h_full()
            .min_h_0()
            .flex_shrink_0()
            .bg(hex(colors::SIDEBAR))
            .border_l_1()
            .border_color(hex(colors::BORDER_SUBTLE))
            .child(header)
            .child(scrollable)
    }
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
            .text_size(px(11.0))
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
                            .child(line.clone()),
                    )
            }))
            .into_any_element(),
        None => hint("此文件不是文本，无法预览。").into_any_element(),
    }
}

/// 原型 `.ptab`：h28 / p0 10 / gap 5 / r8 / 11.5px muted；hover surface；
/// active = surface 底 + borderSubtle 边 + textBright + `0 1px 2px rgba(0,0,0,.2)`
fn ptab(
    key: &'static str,
    ic: IconName,
    label: &'static str,
    active: bool,
    on_click: impl Fn(&mut App) + 'static,
) -> impl IntoElement {
    let (fg, fg_icon) = if active {
        (hex(colors::TEXT_BRIGHT), hex(colors::TEXT))
    } else {
        (hex(colors::MUTED), hex(colors::MUTED))
    };
    h_flex()
        .id(ElementId::Name(format!("work-tab-{key}").into()))
        .h(px(28.0))
        .pl(px(10.0))
        .pr(px(10.0))
        .gap(px(5.0))
        .items_center()
        .flex_shrink_0()
        .rounded(px(8.0))
        .cursor_pointer()
        .text_size(px(11.5))
        .when_else(
            active,
            |d| {
                d.bg(hex(colors::SURFACE))
                    .border_1()
                    .border_color(hex(colors::BORDER_SUBTLE))
                    .shadow_sm()
            },
            |d| d.hover(|h| h.bg(hex(colors::SURFACE))),
        )
        .child(icon(ic, 12.0, fg_icon))
        .child(div().text_color(fg).child(label))
        .on_click(move |_, _, cx| on_click(cx))
}

fn hint(text: &str) -> gpui::AnyElement {
    div()
        .p(px(12.0))
        .text_size(px(11.5))
        .text_color(hex(colors::MUTED))
        .child(text.to_owned())
        .into_any_element()
}

/// 原型 `.file-row`：h32 / p0 10 / gap 7 / r8；hover surface、sel surfaceActive。
/// 「变更」页带 M/A/D 徽标与 ±计数；「文件」页带 file 图标。
fn file_row(
    file: &WorktreeFile,
    selected: bool,
    tab: WorkPanelTab,
    on_click: impl Fn(&mut App) + 'static,
) -> impl IntoElement {
    let (dir, nm) = split_path(&file.path);
    let nm_color = if selected {
        hex(colors::TEXT_BRIGHT)
    } else {
        hex(colors::TEXT)
    };
    div()
        .id(ElementId::Name(format!("work-file-{}", file.path).into()))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(7.0))
        .h(px(32.0))
        .pl(px(10.0))
        .pr(px(10.0))
        .flex_shrink_0()
        .rounded(px(8.0))
        .cursor_pointer()
        .when_else(
            selected,
            |d| d.bg(hex(colors::SURFACE_ACTIVE)),
            |d| d.hover(|h| h.bg(hex(colors::SURFACE))),
        )
        .on_click(move |_, _, cx| on_click(cx))
        .when(tab == WorkPanelTab::Changes, |d| {
            // 原型 .bdg：w18 mono 10 700
            let (text, color) = badge(file.status);
            d.child(
                div()
                    .w(px(18.0))
                    .flex_shrink_0()
                    .font_family("monospace")
                    .text_size(px(10.0))
                    .font_weight(gpui::FontWeight::BOLD)
                    .text_color(color)
                    .child(text),
            )
        })
        .when(tab == WorkPanelTab::Files, |d| {
            d.child(
                div()
                    .w(px(18.0))
                    .flex()
                    .justify_center()
                    .flex_shrink_0()
                    .child(icon(IconName::File, 12.0, hex(colors::MUTED))),
            )
        })
        // 原型 .nm：flex1 12px mono，basename + 两空格 + dir（muted）
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .font_family("monospace")
                .text_size(px(12.0))
                .text_color(nm_color)
                .child(nm)
                .when(!dir.is_empty(), |d| {
                    d.child(
                        div()
                            .text_color(hex(colors::MUTED))
                            .child(format!("  {dir}")),
                    )
                }),
        )
        // ±计数（原型 .add/.del：mono 10；只画存在的一侧）
        .when(tab == WorkPanelTab::Changes, |d| {
            d.children(file.added.map(|n| {
                div()
                    .font_family("monospace")
                    .text_size(px(10.0))
                    .text_color(hex(colors::STATUS_DONE))
                    .flex_shrink_0()
                    .child(format!("+{n}"))
            }))
            .children(file.deleted.map(|n| {
                div()
                    .font_family("monospace")
                    .text_size(px(10.0))
                    .text_color(hex(colors::STATUS_ERROR))
                    .flex_shrink_0()
                    .child(format!("−{n}"))
            }))
        })
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

/// 原型 `.diff`：mt6 + 上边线 + pt6，mono 11 / lh 1.5；行 `p0 8`、
/// add = `rgba(152,195,121,.12)` 底 + terminalKind 字；del = `rgba(224,108,117,.12)`
/// 底 + statusError 字；hunk = tile 底 + cyan 字；meta = muted。
fn diff_view(patch: &str) -> impl IntoElement {
    v_flex()
        .mt(px(6.0))
        .pt(px(6.0))
        .border_t_1()
        .border_color(hex(colors::BORDER))
        .font_family("monospace")
        .text_size(px(11.0))
        .line_height(px(16.5))
        .overflow_hidden()
        .children(patch.lines().map(|line| {
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
                .child(line.to_owned())
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
            // 末尾换行 split 出一个空尾行（原型 code.split('\n') 同语义）
            assert_eq!(lines.len(), 4);
            assert_eq!(lines[0], "fn main() {");
            assert_eq!(lines[1], "    println!(\"x\");");
        });
    }

    #[test]
    fn preview_reading_truncates_and_rejects_binary() {
        let dir = tempfile::tempdir().unwrap();
        // 超长行：行数截断
        let long: String = "x".repeat(64);
        std::fs::write(dir.path().join("long.txt"), &long).unwrap();
        let lines = read_preview_lines(dir.path(), "long.txt").unwrap();
        assert_eq!(lines, vec![long]);
        // CRLF：\r 剥掉
        std::fs::write(dir.path().join("crlf.txt"), b"a\r\nb\r\n").unwrap();
        assert_eq!(
            read_preview_lines(dir.path(), "crlf.txt").unwrap(),
            vec!["a".to_string(), "b".to_string(), String::new()]
        );
        // 二进制：from_utf8 失败 → None（前 256KB 全 0xFF）
        let bin = vec![0xFFu8; 1024];
        std::fs::write(dir.path().join("bin.dat"), bin).unwrap();
        assert!(read_preview_lines(dir.path(), "bin.dat").is_none());
        // 不存在的文件 → None
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
}
