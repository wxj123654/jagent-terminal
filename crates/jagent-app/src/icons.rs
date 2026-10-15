//! SVG 图标原子——lucide 字形全集。
//!
//! 源码逐字取自旧 `packages/ui/src/display/Icon.tsx`（R10 对账：与 React
//! 原型 `design/prototype-react/src/icons.tsx` 实际渲染的 lucide-react@1.46.0
//! 节点逐字对齐）。渲染走 gpui `svg().data()`（内联 SVG，tint 读元素
//! text color——lucide `stroke="currentColor"` 正好吃这一通道）。
//!
//! 用法：`icon(IconName::Gear, 16., tokens-muted)`；hover 提亮由调用方
//! 换色或外层 div 的 `.hover()` 提供。

use gpui::{Hsla, Styled, svg};

/// 图标名（= 旧 Icon.tsx 的 SOURCES 键；arrowLeft 原型死映射不收，
/// minimize/maximize Linux CSD 在用保留）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IconName {
    Chat,
    Terminal,
    Acp,
    Gear,
    Close,
    Minimize,
    Maximize,
    Plus,
    ChevronDown,
    ChevronUp,
    ChevronRight,
    Reset,
    Search,
    Copy,
    Trash,
    Folder,
    File,
    Menu,
    Bell,
    More,
    GitBranch,
    Tag,
    Download,
    PanelLeft,
    PanelRight,
    Check,
    Edit,
    Agent,
    Pin,
    Home,
    Inbox,
    ArrowRight,
    Alert,
}

/// `viewBox 0 0 24 24` 的 stroke 系 SVG（lucide 风格：fill none /
/// stroke currentColor / sw 2 / round cap+join）。
fn stroke(body: &str) -> String {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{body}</svg>"#
    )
}

/// 每个 IconName 的完整 SVG 文档（懒构造一次，按需 clone 开销可忽略——
/// `Svg::data` 按 hash 缓存，同一图标反复 data() 只解析一次）。
pub fn svg_source(name: IconName) -> &'static str {
    use IconName::*;
    match name {
        Chat => r#"<circle cx="12" cy="12" r="1"/><circle cx="12" cy="12" r="10"/>"#,
        Terminal => r#"<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>"#,
        Acp => r#"<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>"#,
        Gear => {
            r#"<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 0-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>"#
        }
        Close => r#"<path d="M18 6 6 18"/><path d="m6 6 12 12"/>"#,
        Minimize => r#"<path d="M5 12h14"/>"#,
        Maximize => r#"<rect width="18" height="18" x="3" y="3" rx="2"/>"#,
        Plus => r#"<path d="M5 12h14"/><path d="M12 5v14"/>"#,
        ChevronDown => r#"<path d="m6 9 6 6 6-6"/>"#,
        ChevronUp => r#"<path d="m18 15-6-6-6 6"/>"#,
        ChevronRight => r#"<path d="m9 18 6-6-6-6"/>"#,
        Reset => {
            r#"<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>"#
        }
        Search => r#"<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>"#,
        Copy => {
            r#"<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>"#
        }
        Trash => {
            r#"<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>"#
        }
        Folder => {
            r#"<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>"#
        }
        File => {
            r#"<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>"#
        }
        Menu => r#"<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>"#,
        Bell => {
            r#"<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>"#
        }
        More => {
            r#"<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>"#
        }
        GitBranch => {
            r#"<path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>"#
        }
        Tag => {
            r#"<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>"#
        }
        Download => {
            r#"<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>"#
        }
        PanelLeft => r#"<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>"#,
        PanelRight => r#"<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>"#,
        Check => r#"<path d="M20 6 9 17l-5-5"/>"#,
        Edit => {
            r#"<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>"#
        }
        Agent => {
            r#"<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>"#
        }
        Pin => {
            r#"<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>"#
        }
        Home => {
            r#"<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>"#
        }
        Inbox => {
            r#"<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>"#
        }
        ArrowRight => r#"<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>"#,
        Alert => {
            r#"<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>"#
        }
    }
}

/// 渲染一个图标：`size` px 见方，`color` 为 stroke tint。
pub fn icon(name: IconName, size: f32, color: Hsla) -> gpui::Svg {
    svg()
        .data(stroke(svg_source(name)).as_bytes())
        .size(gpui::px(size))
        .text_color(color)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_icon_source_is_a_wellformed_stroke_svg() {
        for name in [
            IconName::Chat,
            IconName::Terminal,
            IconName::Acp,
            IconName::Gear,
            IconName::Close,
            IconName::Minimize,
            IconName::Maximize,
            IconName::Plus,
            IconName::ChevronDown,
            IconName::ChevronUp,
            IconName::ChevronRight,
            IconName::Reset,
            IconName::Search,
            IconName::Copy,
            IconName::Trash,
            IconName::Folder,
            IconName::File,
            IconName::Menu,
            IconName::Bell,
            IconName::More,
            IconName::GitBranch,
            IconName::Tag,
            IconName::Download,
            IconName::PanelLeft,
            IconName::PanelRight,
            IconName::Check,
            IconName::Edit,
            IconName::Agent,
            IconName::Pin,
            IconName::Home,
            IconName::Inbox,
            IconName::ArrowRight,
            IconName::Alert,
        ] {
            let doc = stroke(svg_source(name));
            assert!(
                doc.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24""#),
                "{name:?}"
            );
            assert!(doc.ends_with("</svg>"), "{name:?}");
            assert!(doc.contains(r#"stroke="currentColor""#), "{name:?}");
        }
    }

    #[test]
    fn terminal_and_folder_match_the_gpuix_sources_verbatim() {
        // 抽查逐字对齐（Icon.tsx SOURCES 的 body）
        assert_eq!(
            svg_source(IconName::Terminal),
            r#"<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>"#
        );
        assert_eq!(
            svg_source(IconName::Folder),
            r#"<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>"#
        );
    }
}
