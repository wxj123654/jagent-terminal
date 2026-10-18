//! Git 右键菜单装填与危险操作弹层（V3 原型对齐）。
//!
//! 菜单项数据在 core（`jagent_core::git::actions`：commit/branch/remote/tag 四套 +
//! `pick` 派发规则），这里只做两件事：
//! 1. 把 [`GitMenuEntry`] 列表装进 gpui-component 的 `PopupMenu`（`.context_menu()`
//!    在鼠标位置弹出、自带键盘导航——V1 侧栏工作区菜单同款模式）；
//!    danger 项红字（原型 `.ctx-item.danger{color:var(--bell)}`），其余 TEXT 色；
//!    V5 统一浮层系统收编前先按此形态。
//! 2. 「危险操作确认」与「输入名称」两个小弹窗（gpuix Modal 的形态：380 宽、
//!    scrim rgba(8,10,13,.7)、overlay 底、r12、底部按钮行）。

use std::rc::Rc;

use gpui::{
    App, InteractiveElement, IntoElement, ParentElement, SharedString, StatefulInteractiveElement,
    Styled, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_component::menu::{PopupMenu, PopupMenuItem};
use jagent_core::git::actions::{GitMenuEntry, GitMenuItem};

use crate::theme::{colors, hex};
use crate::views::selectable::sel_text_id;
use crate::views::sidebar::WindowActionFn;

/// 一个菜单项被选中后视图要做的下一步（core `pick` 结果 + 弹层关闭）。
pub type PickHandler = Rc<dyn Fn(GitMenuItem, Option<String>, &mut Window, &mut App)>;

/// 把 core 的菜单项列表装进 `PopupMenu`。
///
/// danger 项用 `PopupMenuItem::element` 自绘红字（组件的 `Item` 变体没有 danger 样式位）；
/// 勾选/禁用/分隔线映射到组件原生能力。`at` 是动作目标（sha / 分支名 / 标签名），
/// 原样传给视图的 pick 处理器。
pub fn apply_entries(
    menu: PopupMenu,
    entries: &[GitMenuEntry],
    at: Option<String>,
    on_pick: &PickHandler,
) -> PopupMenu {
    let mut menu = menu;
    for entry in entries {
        match entry {
            GitMenuEntry::Sep => {
                menu = menu.item(PopupMenuItem::separator());
            }
            GitMenuEntry::Item(item) => {
                menu = menu.item(menu_item(item, at.clone(), on_pick));
            }
        }
    }
    menu
}

/// 单个菜单项：danger 红字 / 常规 TEXT 色；勾槽 + label。
fn menu_item(item: &GitMenuItem, at: Option<String>, on_pick: &PickHandler) -> PopupMenuItem {
    let label: SharedString = item.label.clone().into();
    if item.danger {
        // 原型 .ctx-item.danger：字红，hover 底仍 surface（由 MenuItemElement 提供）
        let danger_label = item.label.clone();
        return PopupMenuItem::element(move |_, _| {
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(0.0))
                .text_size(px(12.0))
                .text_color(hex(colors::BELL))
                .child(danger_label.clone())
        })
        .when(item.disabled, |it| it.disabled(true))
        .on_click({
            let item = item.clone();
            let at = at.clone();
            let on_pick = on_pick.clone();
            move |_, window, cx| on_pick(item.clone(), at.clone(), window, cx)
        });
    }
    PopupMenuItem::new(label)
        .checked(item.checked)
        .when(item.disabled, |it| it.disabled(true))
        .on_click({
            let item = item.clone();
            let at = at.clone();
            let on_pick = on_pick.clone();
            move |_, window, cx| on_pick(item.clone(), at.clone(), window, cx)
        })
}

// ── 危险操作确认弹窗（gpuix Confirm Modal 380 宽形态）─────────────────────

/// 确认弹窗的载荷：标题 + 将要执行的 argv。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfirmState {
    pub title: String,
    pub argv: Vec<String>,
}

/// 危险操作确认卡（原型 `.modal` + `.mbtn.danger`）：
/// scrim `rgba(8,10,13,.7)`、380 宽 r12 overlay 底、标题行 + 命令正文 + 取消/执行。
pub fn confirm_modal(
    confirm: &ConfirmState,
    on_cancel: WindowActionFn,
    on_run: WindowActionFn,
) -> impl IntoElement {
    let command = format!("git {}", confirm.argv.join(" "));
    modal_scrim("git-confirm-modal").child(
        modal_card().child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                // 标题
                .child(
                    div()
                        .px(px(16.0))
                        .pt(px(16.0))
                        .text_size(px(15.0))
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .child("确认操作"),
                )
                // 正文：操作名 + 命令
                .child(
                    div()
                        .px(px(16.0))
                        .py(px(14.0))
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
                        .text_size(px(13.0))
                        .text_color(hex(colors::TEXT))
                        .child(sel_text_id("git-confirm-title", confirm.title.clone()))
                        .child(
                            div()
                                .font_family("monospace")
                                .text_size(px(12.0))
                                .text_color(hex(colors::BELL))
                                .child(sel_text_id("git-confirm-cmd", command)),
                        ),
                )
                // 按钮行
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .justify_end()
                        .gap(px(8.0))
                        .px(px(16.0))
                        .pb(px(12.0))
                        .child(modal_button("git-confirm-cancel", "取消", false, on_cancel))
                        .child(modal_button("git-confirm-run", "执行", true, on_run)),
                ),
        ),
    )
}

// ── 输入名称弹窗（gpuix Prompt Modal）────────────────────────────────────

/// prompt 弹窗的载荷：正在命名的菜单项 + 目标。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptState {
    pub item: GitMenuItem,
    pub at: Option<String>,
}

/// 语义化输入框值（视图持有 `InputState`，这里只出按钮回调接线）。
pub fn prompt_modal(
    prompt: &PromptState,
    input: gpui::Entity<gpui_component::input::InputState>,
    on_cancel: WindowActionFn,
    on_submit: WindowActionFn,
) -> impl IntoElement {
    modal_scrim("git-prompt-modal").child(
        modal_card().child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .px(px(16.0))
                        .pt(px(16.0))
                        .text_size(px(15.0))
                        .text_color(hex(colors::TEXT_BRIGHT))
                        .child(prompt.item.label.clone()),
                )
                .child(
                    div()
                        .px(px(16.0))
                        .py(px(14.0))
                        .child(crate::views::field::text_input(&input).w_full()),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .justify_end()
                        .gap(px(8.0))
                        .px(px(16.0))
                        .pb(px(12.0))
                        .child(modal_button("git-prompt-cancel", "取消", false, on_cancel))
                        .child(modal_button("git-prompt-submit", "创建", true, on_submit)),
                ),
        ),
    )
}

// ── 弹窗原子 ────────────────────────────────────────────────────────────

/// 全屏半透明遮罩 + 居中卡（原型 `.modal-scrim`/`.modal`：blur 由 scrim 透出）。
fn modal_scrim(id: &'static str) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .absolute()
        .top_0()
        .bottom_0()
        .left_0()
        .right_0()
        .flex()
        .items_center()
        .justify_center()
        .bg(gpui::rgba(0x080A0DB3))
}

/// 弹窗卡：380 宽、r12、overlay 底、borderSubtle 边 + 深阴影（0 24 80）。
fn modal_card() -> gpui::Div {
    div()
        .w(px(380.0))
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(px(12.0))
        .bg(hex(colors::OVERLAY))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .shadow(vec![
            gpui::BoxShadow::new(px(0.0), px(24.0), gpui::hsla(0.0, 0.0, 0.0, 0.58))
                .blur_radius(px(80.0)),
        ])
}

/// 弹窗按钮（原型 `.mbtn` 34 高；danger = bell 底白字，普通 = 透明底 TEXT 字）。
fn modal_button(
    id: &'static str,
    label: &'static str,
    danger: bool,
    on_click: WindowActionFn,
) -> impl IntoElement {
    div()
        .id(id)
        .h(px(34.0))
        .px(px(14.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(8.0))
        .cursor_pointer()
        .text_size(px(13.0))
        .when(danger, |d| {
            d.bg(hex(colors::BELL))
                .border_1()
                .border_color(hex(colors::BELL))
                .text_color(gpui::white())
                .hover(|h| h.opacity(0.9))
        })
        .when(!danger, |d| {
            d.border_1()
                .border_color(hex(colors::BORDER_SUBTLE))
                .text_color(hex(colors::TEXT))
                .hover(|h| h.bg(hex(colors::SURFACE)))
        })
        .child(label)
        .on_click(move |_, window, cx| on_click(window, cx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jagent_core::git::actions::{
        GitMenuItem, MenuPick, branch_menu_items, commit_menu_items, tag_menu_items,
    };

    fn item_ids(entries: &[GitMenuEntry]) -> Vec<&'static str> {
        entries
            .iter()
            .filter_map(|e| match e {
                GitMenuEntry::Item(i) => Some(i.id),
                GitMenuEntry::Sep => None,
            })
            .collect()
    }

    #[test]
    fn commit_menu_keeps_the_danger_reset_and_prompt_items() {
        let entries = commit_menu_items("abc", false);
        let ids = item_ids(&entries);
        assert_eq!(ids.first(), Some(&"checkout"));
        assert!(ids.contains(&"branch-here"));
        assert!(ids.contains(&"reset-hard"));
        let danger: Vec<_> = entries
            .iter()
            .filter_map(|e| match e {
                GitMenuEntry::Item(i) if i.danger => Some(i.id),
                _ => None,
            })
            .collect();
        assert_eq!(danger, ["reset-hard"], "红字项只有 reset-hard");
    }

    #[test]
    fn head_rows_disable_checkout_like_core_rules() {
        assert!(
            commit_menu_items("x", true)
                .iter()
                .any(|e| matches!(e, GitMenuEntry::Item(i) if i.id == "checkout" && i.disabled))
        );
    }

    #[test]
    fn tag_and_branch_menus_carry_their_danger_items() {
        assert!(
            tag_menu_items("v1")
                .iter()
                .any(|e| matches!(e, GitMenuEntry::Item(i) if i.id == "delete-tag" && i.danger))
        );
        assert!(
            branch_menu_items("main", true)
                .iter()
                .any(|e| matches!(e, GitMenuEntry::Item(i) if i.id == "delete" && i.danger))
        );
    }

    /// 视图接线用的 core 派发规则抽查：danger 必须先确认、prompt 要回输入框。
    #[test]
    fn core_pick_routes_danger_to_confirm_and_prompt_to_prompt() {
        let reset = commit_menu_items("abc", false)
            .into_iter()
            .find_map(|e| match e {
                GitMenuEntry::Item(i) if i.id == "reset-hard" => Some(i),
                _ => None,
            })
            .unwrap();
        let (mut notes, mut runs): (Vec<String>, Vec<Vec<String>>) = (vec![], vec![]);
        let p = crate_pick(&reset, Some("abc"), &mut notes, &mut runs);
        assert!(matches!(p, MenuPick::Confirm { .. }));
        assert!(runs.is_empty());

        let branch = commit_menu_items("abc", false)
            .into_iter()
            .find_map(|e| match e {
                GitMenuEntry::Item(i) if i.id == "branch-here" => Some(i),
                _ => None,
            })
            .unwrap();
        let p = crate_pick(&branch, Some("abc"), &mut notes, &mut runs);
        assert!(matches!(p, MenuPick::Prompt { .. }));

        // ConfirmState / PromptState 载荷可比较（视图开浮层的判等依据）
        let c1 = ConfirmState {
            title: "t".into(),
            argv: vec!["reset".into()],
        };
        assert_eq!(c1.clone(), c1);
        let p1 = PromptState {
            item: GitMenuItem::default(),
            at: None,
        };
        assert_eq!(p1.clone(), p1);
    }

    fn crate_pick(
        item: &GitMenuItem,
        at: Option<&str>,
        notes: &mut Vec<String>,
        runs: &mut Vec<Vec<String>>,
    ) -> MenuPick {
        jagent_core::git::actions::pick(item, at, &mut |m| notes.push(m), &mut |a| runs.push(a))
    }
}
