//! 统一浮层系统（V5）：浮层壳 + 菜单组件，收编全 app 的弹出面。
//!
//! 像素契约 = 原型 `index.css` R9 增补行（833–834）：
//! `.ctx-menu, .sel-pop, .font-pop, .session-add-pop, .branch-pop, .notif-pop`
//! 统一 `borderSubtle 边 + r12（--radius-lg）+ overlay 底 + 0 14px 38px rgba(0,0,0,.5)`
//! 阴影；菜单项 `.ctx-item` min-h 30 / r6，danger 项文字 `var(--bell)`（红）。
//!
//! 底座是 `gpui_base::Popover`（deferred 绘制 / occlude / 点外关闭 / Esc /
//! 焦点归还全部内建）。它公开的 [`gpui_base::Popover::trigger`] 要求触发器
//! 实现 `Selectable`——本模块的 [`PopupTrigger`] 就是这个薄适配：任何
//! 「按 open 态渲染」的元素闭包包一下即可，全程公开 API（V2 期间两处
//! 借用的 `#[doc(hidden)] trigger_with` 由此退役）。
//!
//! 用法两档：
//!
//! - 简单菜单：[`menu_popover`]（条目 + 选中回调 + 触发器闭包）一站成型；
//! - 自定义内容（notif / 字体选择器 / AddPopover）：[`overlay_shell`] 壳 +
//!   [`PopupTrigger`] + `Popover` 自行组装。
//!
//! 左键 / 右键：`Popover::mouse_button` 单值，行级「左键 = 右键同一菜单」
//! （原型 DropMenu + CtxMenu 双 Radix Root 同条目）由调用方用受控 `open` +
//! 触发器上 `on_mouse_down(Right)` 合流到一个浮层实例（见 sidebar.rs）。

use std::rc::Rc;

use gpui::{
    AnyElement, App, BoxShadow, InteractiveElement as _, IntoElement, ParentElement as _,
    RenderOnce, Stateful, StatefulInteractiveElement as _, Styled, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_base::{Popover, PopoverState, Selectable};

use crate::icons::{IconName, icon};
use crate::theme::{colors, hex};

/// 菜单项选中回调：`(item id, window, app)`。
pub type PickFn = Rc<dyn Fn(&str, &mut Window, &mut App)>;

/// 浮层阴影（原型 R9：`0 14px 38px rgba(0,0,0,.5)`）。
pub fn overlay_shadow() -> Vec<BoxShadow> {
    vec![BoxShadow::new(px(0.), px(14.), gpui::hsla(0., 0., 0., 0.5)).blur_radius(px(38.))]
}

/// 统一浮层壳（`.ctx-menu` 等 R9 增补族）：overlay 底 + borderSubtle 1px +
/// r12 + 大投影。padding / 宽度由调用方链式补（菜单 p4·min-w180，
/// notif 无 padding·300–320）。
pub fn overlay_shell(id: impl Into<gpui::ElementId>) -> Stateful<gpui::Div> {
    div()
        .id(id)
        .bg(hex(colors::OVERLAY))
        .border_1()
        .border_color(hex(colors::BORDER_SUBTLE))
        .rounded(px(12.0))
        .shadow(overlay_shadow())
}

// ── PopupTrigger：Selectable 薄适配（走 Popover 公开 API）───────────────────

/// 触发器适配器：把「按 open 态渲染」的闭包变成 `Selectable` 组件交给
/// [`gpui_base::Popover::trigger`]。闭包收到浮层是否展开，自行决定高亮。
#[derive(IntoElement)]
pub struct PopupTrigger {
    open: bool,
    render: Rc<dyn Fn(bool) -> AnyElement>,
}

impl PopupTrigger {
    pub fn new(render: impl Fn(bool) -> AnyElement + 'static) -> Self {
        Self {
            open: false,
            render: Rc::new(render),
        }
    }
}

impl Selectable for PopupTrigger {
    fn selected(mut self, open: bool) -> Self {
        self.open = open;
        self
    }
    fn is_selected(&self) -> bool {
        self.open
    }
}

impl RenderOnce for PopupTrigger {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        (self.render)(self.open)
    }
}

// ── 菜单条目 ────────────────────────────────────────────────────────────────

/// 一条菜单数据（原型 `MenuItem = { id, label, danger? } | 'sep'`，扩展
/// icon 槽与快捷键列以覆盖分支菜单 / Git 右键等同族场景）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MenuItem {
    pub id: String,
    pub label: String,
    /// 左侧图标槽（14px 宽，随 danger 变红）；原型 ctx-item 无图标，None 不占位
    pub icon: Option<IconName>,
    /// 右缘快捷键列（mono muted 11px）；原型把快捷键写进 label，None 不占位
    pub shortcut: Option<String>,
    /// 危险项：文字与图标红（`var(--bell)` = #e06c75）
    pub danger: bool,
}

impl MenuItem {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            icon: None,
            shortcut: None,
            danger: false,
        }
    }
    pub fn danger(mut self) -> Self {
        self.danger = true;
        self
    }
    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }
    pub fn shortcut(mut self, shortcut: impl Into<String>) -> Self {
        self.shortcut = Some(shortcut.into());
        self
    }
}

/// 菜单条目流：项或分隔线（原型 `'sep'` → `.ctx-sep`：1px borderSubtle，
/// 上下 4 / 左右 6 边距）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuEntry {
    Item(MenuItem),
    Separator,
}

impl MenuEntry {
    pub fn item(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self::Item(MenuItem::new(id, label))
    }
    /// 危险项直写（`{ id, label, danger: true }` 的等价简写）。
    pub fn danger(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self::Item(MenuItem::new(id, label).danger())
    }
}

/// 单个菜单项（`.ctx-item` R9：min-h 30 / r6 / 12px / hover surface）。
fn ctx_item(
    m: MenuItem,
    on_pick: &PickFn,
    popover: &gpui::Entity<PopoverState>,
) -> impl IntoElement {
    let fg = if m.danger {
        hex(colors::BELL)
    } else {
        hex(colors::TEXT)
    };
    let item_id = m.id.clone();
    let dbg_id = m.id.clone();
    let on_pick = on_pick.clone();
    let popover = popover.clone();
    div()
        .id(gpui::ElementId::Name(format!("menu-item-{}", m.id).into()))
        // 测试钩子：debug_selector 仅 debug+test-support 构建记录（生产 no-op）
        .debug_selector(move || format!("menu-item-{dbg_id}"))
        .flex()
        .items_center()
        .gap(px(8.0))
        .min_h(px(30.0))
        .pl(px(8.0))
        .pr(px(8.0))
        .rounded(px(6.0))
        .cursor_pointer()
        .text_size(px(12.0))
        .text_color(fg)
        .hover(|h| h.bg(hex(colors::SURFACE)))
        .when_some(m.icon, |d, ic| {
            d.child(div().w(px(14.0)).flex_shrink_0().child(icon(ic, 13.0, fg)))
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(m.label.clone()),
        )
        .when_some(m.shortcut, |d, key| {
            d.child(
                div()
                    .flex_shrink_0()
                    .font_family("monospace")
                    .text_size(px(11.0))
                    .text_color(hex(colors::MUTED))
                    .child(key),
            )
        })
        .on_click(move |_, window, cx| {
            cx.stop_propagation();
            on_pick(&item_id, window, cx);
            // 选中即收起（PopoverState::dismiss 是公开 API）
            popover.update(cx, |s, cx| s.dismiss(window, cx));
        })
}

/// 菜单壳 + 条目流（`.ctx-menu`：min-w 180 + p4 + 统一浮层壳）。
/// 需要浮层实体（点击项后 dismiss），签名与 `Popover::content` 闭包对齐。
pub fn menu_surface(
    entries: &[MenuEntry],
    on_pick: &PickFn,
    popover: &gpui::Entity<PopoverState>,
) -> Stateful<gpui::Div> {
    let mut menu = overlay_shell("ctx-menu")
        .debug_selector(|| "ctx-menu".to_string())
        .min_w(px(180.0))
        .p(px(4.0));
    for entry in entries {
        menu = match entry {
            MenuEntry::Item(m) => menu.child(ctx_item(m.clone(), on_pick, popover)),
            MenuEntry::Separator => menu.child(
                div()
                    .h(px(1.0))
                    .mt(px(4.0))
                    .mb(px(4.0))
                    .ml(px(6.0))
                    .mr(px(6.0))
                    .bg(hex(colors::BORDER_SUBTLE)),
            ),
        };
    }
    menu
}

/// 一站菜单浮层：trigger 闭包（收 open 态）+ 条目 + 选中回调。
/// 锚定 = trigger 下方左对齐（原型 DropMenu side bottom / align start /
/// sideOffset 4）；点外关闭 / Esc / deferred 由 Popover 内建。
pub fn menu_popover(
    id: impl Into<gpui::ElementId>,
    entries: Vec<MenuEntry>,
    on_pick: impl Fn(&str, &mut Window, &mut App) + 'static,
    trigger: impl Fn(bool) -> AnyElement + 'static,
) -> Popover {
    let on_pick: PickFn = Rc::new(on_pick);
    Popover::new(id)
        .anchor(gpui::Anchor::TopLeft)
        .offset(px(4.0))
        .trigger(PopupTrigger::new(trigger))
        .content(move |_, _, cx| {
            let popover = cx.entity();
            menu_surface(&entries, &on_pick, &popover).into_any_element()
        })
}

// ── 浮层内容元素的工具（供 AddPopover 等自定义壳复用）──────────────────────

/// 浮层内动作行（`.sa-act`：h28 / gap7 / r5 / hover surface / icon muted）。
/// 与 ctx_item 的差别是定高 28（session-add-pop 专用形态）。
pub fn action_row(
    id: impl Into<gpui::ElementId>,
    ic: IconName,
    label: &str,
    on_click: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .id(id)
        .flex()
        .items_center()
        .gap(px(7.0))
        .h(px(28.0))
        .pl(px(8.0))
        .pr(px(8.0))
        .rounded(px(5.0))
        .cursor_pointer()
        .text_size(px(12.0))
        .text_color(hex(colors::TEXT))
        .hover(|h| h.bg(hex(colors::SURFACE)))
        .child(icon(ic, 13.0, hex(colors::MUTED)))
        .child(label.to_owned())
        .on_click(move |_, window, cx| {
            cx.stop_propagation();
            on_click(window, cx);
        })
}

/// 小节标题（`.sa-sub`：10.5 / 500 / muted，padding 8 8 4）。
pub fn section_label(text: &str) -> impl IntoElement {
    div()
        .text_size(px(10.5))
        .font_weight(gpui::FontWeight::MEDIUM)
        .text_color(hex(colors::MUTED))
        .pt(px(8.0))
        .pr(px(8.0))
        .pb(px(4.0))
        .pl(px(8.0))
        .child(text.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Context, Render};
    use std::cell::RefCell;

    #[test]
    fn menu_item_builders_set_the_variants() {
        let plain = MenuItem::new("pin", "置顶");
        assert!(!plain.danger && plain.icon.is_none() && plain.shortcut.is_none());
        let danger = MenuItem::new("remove", "移除")
            .danger()
            .icon(IconName::Trash)
            .shortcut("Del");
        assert!(danger.danger);
        assert_eq!(danger.icon, Some(IconName::Trash));
        assert_eq!(danger.shortcut.as_deref(), Some("Del"));
    }

    #[test]
    fn menu_entry_item_helper_wraps_menu_item() {
        assert_eq!(
            MenuEntry::item("graph", "打开 Git 图"),
            MenuEntry::Item(MenuItem::new("graph", "打开 Git 图"))
        );
    }

    /// 薄适配语义：`selected` 写入的 open 态由 `is_open` 读回
    /// （`open` 默认走 `selected`，见 gpui_base::Selectable）。
    #[test]
    fn popup_trigger_round_trips_the_open_state() {
        let t = PopupTrigger::new(|_| div().into_any_element());
        assert!(!t.is_selected());
        assert!(t.selected(true).is_selected(), "open 即 selected");
    }

    /// 完整浮层回路（gpui_base popover 测试模式）：点触发器开浮层 →
    /// 点 danger 项回调到达且浮层关闭。
    #[gpui::test]
    fn menu_popover_opens_picks_and_closes(cx: &mut gpui::TestAppContext) {
        struct Harness {
            picked: Rc<RefCell<Vec<&'static str>>>,
        }
        impl Render for Harness {
            fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
                let picked = self.picked.clone();
                let weak = cx.entity().downgrade();
                menu_popover(
                    "row-menu",
                    vec![
                        MenuEntry::item("pin", "置顶"),
                        MenuEntry::Separator,
                        MenuEntry::danger("remove", "移除"),
                    ],
                    move |id, _, cx| {
                        picked.borrow_mut().push(match id {
                            "pin" => "pin",
                            "remove" => "remove",
                            _ => "other",
                        });
                        let _ = weak.update(cx, |_, cx| cx.notify());
                    },
                    move |open| {
                        div()
                            .id("menu-dot")
                            .debug_selector(|| "menu-dot".to_string())
                            .size(px(24.0))
                            .when(open, |d| d.bg(hex(colors::SURFACE)))
                            .into_any_element()
                    },
                )
            }
        }

        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::install(cx).expect("主题安装");
        });
        let picked: Rc<RefCell<Vec<&'static str>>> = Rc::new(RefCell::new(vec![]));
        let (_, cx) = cx.add_window_view({
            let picked = picked.clone();
            move |_, _| Harness { picked }
        });
        cx.update(|window, cx| window.draw(cx).clear(cx));

        // 初始无浮层内容；点触发器 → 菜单出现
        assert!(cx.debug_bounds("ctx-menu").is_none());
        let dot = cx.debug_bounds("menu-dot").expect("触发器在屏").center();
        cx.simulate_click(dot, Default::default());
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert!(cx.debug_bounds("ctx-menu").is_some(), "点开后菜单在屏");

        // 点 danger 项 → 回调到达 + 浮层关闭
        let item = cx
            .debug_bounds("menu-item-remove")
            .expect("danger 项在屏")
            .center();
        cx.simulate_click(item, Default::default());
        cx.update(|window, cx| window.draw(cx).clear(cx));
        assert_eq!(*picked.borrow(), vec!["remove"]);
        assert!(cx.debug_bounds("ctx-menu").is_none(), "选中后浮层收起");
    }
}
