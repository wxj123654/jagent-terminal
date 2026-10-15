//! Git 图 ref 徽标（V3 原型对齐：原型 `RefChip` / gpuix `RefBadges`）。
//!
//! 形态（原型 `.ref-chip` 第二段）：h18 / r5 / inputBg 底 / 8×8 r2 色块 /
//! 10px mono 字 / gap4 / px6；head 边框 accent，tag 字 amber，
//! remote 色块 muted，branch 色块 terminalKind。
//!
//! 徽标可右键：kind → core 的 branch / remote / tag 菜单（head 与 branch 共用
//! branch 菜单——`HEAD -> main` 拆出的 HEAD chip 与 gpuix `refMenu` 同构路由），
//! 菜单装填复用 [`crate::views::git_context_menu::apply_entries`]（danger 红字同源）。

use gpui::{
    InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled, div, px,
};
use gpui_component::menu::ContextMenuExt as _;
use jagent_core::git::actions::{
    GitMenuEntry, branch_menu_items, remote_menu_items, tag_menu_items,
};
use jagent_core::git::format::{RefDecor, RefKind};

use crate::theme::{colors, hex};
use crate::views::git_context_menu::{PickHandler, apply_entries};

/// 徽标三件套颜色（色块 / 边框 / 文字）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct BadgeColors {
    pub square: &'static str,
    pub border: &'static str,
    pub text: &'static str,
}

/// kind → 颜色映射（原型 RefChip.map）。纯函数，测试直接断言十六进制串。
pub fn badge_color(kind: RefKind) -> BadgeColors {
    match kind {
        RefKind::Head => BadgeColors {
            square: colors::ACCENT,
            border: colors::ACCENT,
            text: colors::TEXT_BRIGHT,
        },
        RefKind::Branch => BadgeColors {
            square: colors::TERMINAL_KIND,
            border: colors::BORDER_SUBTLE,
            text: colors::TEXT_BRIGHT,
        },
        RefKind::Remote => BadgeColors {
            square: colors::MUTED,
            border: colors::BORDER_SUBTLE,
            text: colors::TEXT_BRIGHT,
        },
        RefKind::Tag => BadgeColors {
            square: colors::AMBER,
            border: colors::BORDER_SUBTLE,
            text: colors::AMBER,
        },
    }
}

/// `show_remote` 过滤（gpuix：关掉远程徽标时 Remote 不渲染）。
pub fn visible_decors(decors: &[RefDecor], show_remote: bool) -> Vec<&RefDecor> {
    if show_remote {
        decors.iter().collect()
    } else {
        decors
            .iter()
            .filter(|d| d.kind != RefKind::Remote)
            .collect()
    }
}

/// kind → 菜单项（gpuix `refMenu`：head/branch → branch 菜单、remote / tag 各自）。
/// 返回 `(标题, 条目列表)`；标题目前仅用于断言路由（PopupMenu 不带标题行）。
pub fn ref_menu(decor: &RefDecor, current_branch: &str) -> (String, Vec<GitMenuEntry>) {
    match decor.kind {
        RefKind::Head | RefKind::Branch => (
            format!("分支 {}", decor.label),
            branch_menu_items(&decor.label, decor.label == current_branch),
        ),
        RefKind::Remote => (
            format!("远程 {}", decor.label),
            remote_menu_items(&decor.label),
        ),
        RefKind::Tag => (
            format!("标签 {}", decor.label),
            tag_menu_items(&decor.label),
        ),
    }
}

/// 徽标行渲染。左键 = 选中该行（原型 onClick → gitSelect）；
/// 右键（head 除外）= 该 ref 的操作菜单，装填走 [`apply_entries`]。
pub fn ref_badges(
    decors: &[RefDecor],
    show_remote: bool,
    current_branch: &str,
    on_pick: &PickHandler,
    on_select: &crate::views::sidebar::WindowActionFn,
) -> gpui::Div {
    let mut row = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .flex_shrink_0()
        .mr(px(6.0));
    for d in visible_decors(decors, show_remote) {
        let c = badge_color(d.kind);
        let chip = div()
            .id(gpui::ElementId::Name(
                format!("git-ref-{}-{}", kind_tag(d.kind), d.label).into(),
            ))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .h(px(18.0))
            .pl(px(6.0))
            .pr(px(6.0))
            .rounded(px(5.0))
            .bg(hex(colors::INPUT_BG))
            .border_1()
            .border_color(hex(c.border))
            .flex_shrink_0()
            .child(div().size(px(8.0)).rounded(px(2.0)).bg(hex(c.square)))
            .child(
                div()
                    .text_size(px(10.0))
                    .font_family("monospace")
                    .text_color(hex(c.text))
                    .child(d.label.clone()),
            );
        let chip: gpui::AnyElement = if d.kind != RefKind::Head {
            // head 徽标只展示；branch/remote/tag 右键出操作菜单（在鼠标位置弹出）
            let d = d.clone();
            let on_pick = on_pick.clone();
            let on_select = on_select.clone();
            let current = current_branch.to_owned();
            chip.on_click(move |_, window, cx| on_select(window, cx))
                .context_menu(move |menu, _window, _cx| {
                    let (_title, entries) = ref_menu(&d, &current);
                    apply_entries(menu, &entries, Some(d.label.clone()), &on_pick)
                })
                .into_any_element()
        } else {
            chip.into_any_element()
        };
        row = row.child(chip);
    }
    row
}

fn kind_tag(kind: RefKind) -> &'static str {
    match kind {
        RefKind::Head => "head",
        RefKind::Branch => "branch",
        RefKind::Remote => "remote",
        RefKind::Tag => "tag",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(kind: RefKind, label: &str) -> RefDecor {
        RefDecor {
            kind,
            label: label.into(),
        }
    }

    #[test]
    fn badge_colors_match_the_prototype_chip_map() {
        // 原型 RefChip.map：head=accent 边、branch=terminalKind 块、remote=muted 块、tag=amber 字
        assert_eq!(
            badge_color(RefKind::Head),
            BadgeColors {
                square: colors::ACCENT,
                border: colors::ACCENT,
                text: colors::TEXT_BRIGHT
            }
        );
        assert_eq!(badge_color(RefKind::Branch).square, colors::TERMINAL_KIND);
        assert_eq!(badge_color(RefKind::Remote).square, colors::MUTED);
        assert_eq!(badge_color(RefKind::Tag).text, colors::AMBER);
    }

    #[test]
    fn hiding_remote_filters_only_remote_chips() {
        let decors = vec![
            r(RefKind::Head, "HEAD"),
            r(RefKind::Branch, "main"),
            r(RefKind::Remote, "origin/main"),
            r(RefKind::Tag, "v1.0"),
        ];
        let shown: Vec<&str> = visible_decors(&decors, true)
            .iter()
            .map(|d| d.label.as_str())
            .collect();
        assert_eq!(shown, ["HEAD", "main", "origin/main", "v1.0"]);
        let hidden: Vec<&str> = visible_decors(&decors, false)
            .iter()
            .map(|d| d.label.as_str())
            .collect();
        assert_eq!(hidden, ["HEAD", "main", "v1.0"]);
    }

    #[test]
    fn ref_menu_routes_kinds_to_their_core_menus() {
        let (t1, e1) = ref_menu(&r(RefKind::Branch, "dev"), "main");
        assert_eq!(t1, "分支 dev");
        assert!(
            e1.iter()
                .any(|e| matches!(e, GitMenuEntry::Item(i) if i.id == "checkout"))
        );

        let (t2, e2) = ref_menu(&r(RefKind::Head, "HEAD"), "main");
        assert_eq!(t2, "分支 HEAD", "head 落 branch 菜单（gpuix 同构）");
        assert_eq!(e2.len(), e1.len());

        let (t3, e3) = ref_menu(&r(RefKind::Remote, "origin/feat"), "main");
        assert_eq!(t3, "远程 origin/feat");
        assert!(
            e3.iter()
                .any(|e| matches!(e, GitMenuEntry::Item(i) if i.id == "checkout-remote"))
        );

        let (t4, e4) = ref_menu(&r(RefKind::Tag, "v1"), "main");
        assert_eq!(t4, "标签 v1");
        assert!(
            e4.iter()
                .any(|e| matches!(e, GitMenuEntry::Item(i) if i.id == "delete-tag" && i.danger))
        );
    }

    #[test]
    fn current_branch_is_checked_in_its_own_menu() {
        let (_, entries) = ref_menu(&r(RefKind::Branch, "main"), "main");
        assert!(
            entries
                .iter()
                .any(|e| matches!(e, GitMenuEntry::Item(i) if i.checked && i.disabled)),
            "当前分支：勾选且 checkout 禁用"
        );
    }
}
