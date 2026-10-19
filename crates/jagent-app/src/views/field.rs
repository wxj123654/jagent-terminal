//! 统一文本输入外壳：所有「带框」的单行 / 多行输入都走这里，像素一处定。
//!
//! 像素真源：原型 `index.css` R9 增补行 805（`.sel-trig,.num-in,.txt-in…{height:30px;
//! border-radius:var(--radius);background:var(--inputBg)}`）+ `.field-row input`
//! （12px / textBright / borderSubtle 边 / focus accent 边）。
//!
//! gpui-component 的 `Input` 默认外观是「border 色 30% 透明底 + theme.radius +
//! 14px 字 + 32 高」，与原型不符；这里用 `refine_style`（在默认外观之后应用）
//! 覆盖底色 / 圆角 / 高度 / 字号，边框色与 focus 环沿用主题（`input.border` =
//! borderSubtle、`ring` = accent），因此焦点表现与库内其他控件一致。
//!
//! 「无框」输入（搜索条、命令面板、数字框内芯）仍直接用
//! `Input::new(..).appearance(false)` 嵌进自绘外壳，不走本模块。

use gpui::{Entity, SharedString, Styled as _, px};
use gpui_component::input::{Input, InputState, Textarea, TextareaState};

use crate::theme::{colors, hex};
use crate::ui_scale::fs;

/// 控件统一高度（与 Select / Number / Font 触发器同高）
pub const FIELD_H: f32 = 30.0;
/// 控件统一圆角（原型 `--radius`）
pub const FIELD_RADIUS: f32 = 8.0;
/// 控件统一字号
pub const FIELD_TEXT: f32 = 12.0;

/// 单行输入（`.txt-in`）：30 高 / r8 / inputBg / 12px textBright。
pub fn text_input(state: &Entity<InputState>) -> Input {
    Input::new(state)
        .h(px(FIELD_H))
        .px(px(10.0))
        .rounded(px(FIELD_RADIUS))
        .bg(hex(colors::INPUT_BG))
        .text_size(fs(FIELD_TEXT))
        .text_color(hex(colors::TEXT_BRIGHT))
}

/// 等宽单行输入（`.txt-in.mono`）：命令 / 路径 / 参数类字段。
pub fn mono_input(state: &Entity<InputState>) -> Input {
    text_input(state).font_family(mono_family())
}

/// 多行输入（`.field-row textarea`）：mono / r8 / inputBg，高度由调用方给。
pub fn text_area(state: &Entity<TextareaState>, height: f32) -> Textarea {
    Textarea::new(state)
        .h(px(height))
        .rounded(px(FIELD_RADIUS))
        .bg(hex(colors::INPUT_BG))
        .text_size(fs(FIELD_TEXT))
        .text_color(hex(colors::TEXT_BRIGHT))
        .font_family(mono_family())
}

/// 原型 `--font-mono` 的 gpui 等价：交给平台回退链解析。
pub fn mono_family() -> SharedString {
    SharedString::new_static("monospace")
}
