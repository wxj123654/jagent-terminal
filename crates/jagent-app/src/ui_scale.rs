//! 全局 UI 字号缩放：将设计字号 `base` 按 `appearance.uiScale`（80%–150%）换算为实际 `Pixels`。
//!
//! - 终端视图（`TerminalView`）继续独立使用 `terminal.font_size`，不受 `uiScale` 影响；
//! - 其余界面文字统一通过 [`fs`] 计算字号；
//! - 缩放倍率同时保存在 GPUI `Global`（[`UiScale`]）与进程级原子变量中，使无 `&App` 上下文的纯视图辅助函数也能直接调用 `fs(12.0)`。

use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};

use gpui::{App, Global, Pixels, px};
pub use jagent_core::settings::{DEFAULT_UI_SCALE, MAX_UI_SCALE, MIN_UI_SCALE, Settings, UI_SCALE_STEPS};

/// GPUI 全局 UI 缩放状态（倍率，1.0 = 100%）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UiScale(pub f32);

impl Default for UiScale {
    fn default() -> Self {
        Self(1.0)
    }
}

impl Global for UiScale {}

static UI_SCALE_BITS: AtomicU32 = AtomicU32::new(1.0f32.to_bits());
static UI_SCALE_PERCENT: AtomicI64 = AtomicI64::new(DEFAULT_UI_SCALE);

#[cfg(test)]
thread_local! {
    static TEST_UI_SCALE_BITS: std::cell::Cell<u32> = const { std::cell::Cell::new(1.0f32.to_bits()) };
    static TEST_UI_SCALE_PERCENT: std::cell::Cell<i64> = const { std::cell::Cell::new(DEFAULT_UI_SCALE) };
}

/// 读取当前全局 UI 缩放倍率（如 `1.0`、`1.25`、`1.5`）。
#[inline]
pub fn ui_scale() -> f32 {
    #[cfg(test)]
    {
        f32::from_bits(TEST_UI_SCALE_BITS.with(std::cell::Cell::get))
    }
    #[cfg(not(test))]
    {
        f32::from_bits(UI_SCALE_BITS.load(Ordering::Relaxed))
    }
}

/// 读取当前全局 UI 缩放百分比（80–150，默认 100）。
#[inline]
pub fn ui_scale_percent() -> i64 {
    #[cfg(test)]
    {
        TEST_UI_SCALE_PERCENT.with(std::cell::Cell::get)
    }
    #[cfg(not(test))]
    {
        UI_SCALE_PERCENT.load(Ordering::Relaxed)
    }
}

/// 直接按浮点倍率设置 UI 缩放（钳位在 0.8–1.5）。
pub fn set_ui_scale(scale: f32) {
    let min = MIN_UI_SCALE as f32 / 100.0;
    let max = MAX_UI_SCALE as f32 / 100.0;
    let clamped = if scale.is_finite() {
        scale.clamp(min, max)
    } else {
        1.0
    };
    let pct = (clamped * 100.0).round() as i64;
    let bits = clamped.to_bits();
    UI_SCALE_BITS.store(bits, Ordering::Relaxed);
    UI_SCALE_PERCENT.store(pct, Ordering::Relaxed);
    #[cfg(test)]
    {
        TEST_UI_SCALE_BITS.with(|c| c.set(bits));
        TEST_UI_SCALE_PERCENT.with(|c| c.set(pct));
    }
}

/// 按整数百分比（80–150）设置 UI 缩放；越界时回退到默认 100%。
pub fn set_ui_scale_percent(percent: i64) {
    let valid = if (MIN_UI_SCALE..=MAX_UI_SCALE).contains(&percent) {
        percent
    } else {
        DEFAULT_UI_SCALE
    };
    let scale = valid as f32 / 100.0;
    let bits = scale.to_bits();
    UI_SCALE_BITS.store(bits, Ordering::Relaxed);
    UI_SCALE_PERCENT.store(valid, Ordering::Relaxed);
    #[cfg(test)]
    {
        TEST_UI_SCALE_BITS.with(|c| c.set(bits));
        TEST_UI_SCALE_PERCENT.with(|c| c.set(valid));
    }
}

/// 将基准字号 `base` 按当前全局 UI 缩放倍率换算为 [`Pixels`]。
#[inline]
pub fn fs(base: f32) -> Pixels {
    px(base * ui_scale())
}

/// 按预设档位 `[80, 90, 100, 110, 125, 150]` 步进：
/// - `dir > 0`：跳到严格大于 `current` 的下一档（已达上限则保持 150）；
/// - `dir < 0`：跳到严格小于 `current` 的上一档（已达下限则保持 80）；
/// - `dir == 0`：钳位在 `[80, 150]`。
pub fn step_ui_scale(current: i64, dir: i64) -> i64 {
    if dir > 0 {
        UI_SCALE_STEPS
            .iter()
            .copied()
            .find(|&s| s > current)
            .unwrap_or(MAX_UI_SCALE)
    } else if dir < 0 {
        UI_SCALE_STEPS
            .iter()
            .rev()
            .copied()
            .find(|&s| s < current)
            .unwrap_or(MIN_UI_SCALE)
    } else {
        current.clamp(MIN_UI_SCALE, MAX_UI_SCALE)
    }
}

/// 从 `Settings` 同步全局 UI 缩放至原子状态与 GPUI `Global`；若倍率变化则触发所有窗口重绘。
pub fn apply_ui_scale(cx: &mut App, settings: &Settings) {
    set_ui_scale_percent(settings.appearance.ui_scale);
    let scale = ui_scale();
    let changed = cx
        .try_global::<UiScale>()
        .is_none_or(|g| (g.0 - scale).abs() > f32::EPSILON);
    cx.set_global(UiScale(scale));
    if changed {
        for win in cx.windows() {
            let _ = win.update(cx, |_, window, _| window.refresh());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fs_scales_pixels_at_default_and_custom_scales() {
        set_ui_scale(1.0);
        assert_eq!(ui_scale_percent(), 100);
        assert_eq!(fs(12.0), px(12.0));

        set_ui_scale(1.5);
        assert_eq!(ui_scale_percent(), 150);
        assert_eq!(fs(12.0), px(18.0));

        set_ui_scale_percent(80);
        assert_eq!(fs(10.0), px(8.0));

        set_ui_scale_percent(125);
        assert_eq!(fs(12.0), px(15.0));

        // 恢复默认，保持当前测试线程干净
        set_ui_scale_percent(DEFAULT_UI_SCALE);
        assert_eq!(fs(12.0), px(12.0));
    }

    #[test]
    fn set_ui_scale_percent_falls_back_to_default_on_out_of_range() {
        set_ui_scale_percent(125);
        assert_eq!(ui_scale_percent(), 125);

        set_ui_scale_percent(50);
        assert_eq!(ui_scale_percent(), 100);
        assert_eq!(fs(12.0), px(12.0));

        set_ui_scale_percent(200);
        assert_eq!(ui_scale_percent(), 100);
        assert_eq!(fs(12.0), px(12.0));
    }

    #[test]
    fn step_ui_scale_moves_across_defined_tiers_and_clamps_at_bounds() {
        // 正向步进：80 -> 90 -> 100 -> 110 -> 125 -> 150 -> 150
        let mut cur = 80;
        let mut forward = Vec::new();
        for _ in 0..6 {
            cur = step_ui_scale(cur, 1);
            forward.push(cur);
        }
        assert_eq!(forward, vec![90, 100, 110, 125, 150, 150]);

        // 反向步进：150 -> 125 -> 110 -> 100 -> 90 -> 80 -> 80
        let mut back = Vec::new();
        for _ in 0..6 {
            cur = step_ui_scale(cur, -1);
            back.push(cur);
        }
        assert_eq!(back, vec![125, 110, 100, 90, 80, 80]);

        // 非档位中间值（如手动输入 105）也能对齐到相邻档位
        assert_eq!(step_ui_scale(105, 1), 110);
        assert_eq!(step_ui_scale(105, -1), 100);
    }

    #[gpui::test]
    fn apply_ui_scale_syncs_gpui_global_and_fs(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            let mut s = Settings::default();
            apply_ui_scale(cx, &s);
            assert_eq!(cx.global::<UiScale>().0, 1.0);
            assert_eq!(fs(12.0), px(12.0));

            s.appearance.ui_scale = 150;
            apply_ui_scale(cx, &s);
            assert_eq!(cx.global::<UiScale>().0, 1.5);
            assert_eq!(fs(12.0), px(18.0));

            s.appearance.ui_scale = 100;
            apply_ui_scale(cx, &s);
            assert_eq!(cx.global::<UiScale>().0, 1.0);
        });
    }
}
