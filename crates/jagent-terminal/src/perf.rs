//! 全局终端绘制统计 — 性能 HUD 数据源（docs/perf-analysis.md 的测量面）。
//!
//! 所有 `TerminalRenderer::paint` 调用各自 [`record_paint`]；跨会话全局
//! 聚合（HUD 关心的是整机渲染压力，不是单会话）。无锁原子累加，读取端
//! [`take_paint_perf`] 周期采样：
//!
//! - `count` / `ns_total`：进程生命期累计值——调用方（500ms 轮询）自己
//!   差分得速率与均值，本模块不维护时间窗。
//! - `ns_max`：**自上次 take 以来的单次最大耗时**——take 时清零，调用方
//!   免差分直接显示本周期峰值。
//!
//! 注意：gpui 是按需重绘（notify 驱动），空闲时 count 增长率为 0——
//! 「空闲零重绘」本身就是 HUD 要展示的指标（省电证明），不是缺陷。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

static PAINT_COUNT: AtomicU64 = AtomicU64::new(0);
static PAINT_NS_TOTAL: AtomicU64 = AtomicU64::new(0);
static PAINT_NS_MAX: AtomicU64 = AtomicU64::new(0);

/// 记录一次 paint 的耗时（纳秒）。渲染线程调用；每帧一次。
pub fn record_paint(ns: u64) {
    PAINT_COUNT.fetch_add(1, Ordering::Relaxed);
    PAINT_NS_TOTAL.fetch_add(ns, Ordering::Relaxed);
    PAINT_NS_MAX.fetch_max(ns, Ordering::AcqRel);
}

/// 周期快照（HUD 每 500ms 采样一次）。`ns_max` 读后即清——下次 take
/// 返回的是本窗口内的峰值。
pub fn take_paint_perf() -> PaintPerfSnapshot {
    PaintPerfSnapshot {
        count: PAINT_COUNT.load(Ordering::Relaxed),
        ns_total: PAINT_NS_TOTAL.load(Ordering::Relaxed),
        ns_max: PAINT_NS_MAX.swap(0, Ordering::AcqRel),
    }
}

/// RAII 打点器：`let _g = PaintGuard::now();` —— 作用域结束（含提前
/// return）自动记录耗时，供 `TerminalRenderer::paint` 使用。
pub struct PaintGuard(Instant);

impl PaintGuard {
    pub fn now() -> Self {
        Self(Instant::now())
    }
}

impl Drop for PaintGuard {
    fn drop(&mut self) {
        record_paint(self.0.elapsed().as_nanos() as u64);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaintPerfSnapshot {
    pub count: u64,
    pub ns_total: u64,
    pub ns_max: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    pub use super::{PaintGuard, PaintPerfSnapshot, record_paint, take_paint_perf};

    #[test]
    fn snapshot_accumulates_and_max_resets() {
        record_paint(1_000);
        record_paint(3_000);
        record_paint(2_000);
        let s1 = take_paint_perf();
        assert_eq!(s1.count, 3);
        assert_eq!(s1.ns_total, 6_000);
        assert_eq!(s1.ns_max, 3_000);

        // max 已清零：窗口内无新 paint → 0；count/total 保持累计
        let s2 = take_paint_perf();
        assert_eq!(s2.count, 3);
        assert_eq!(s2.ns_total, 6_000);
        assert_eq!(s2.ns_max, 0);

        record_paint(500);
        let s3 = take_paint_perf();
        assert_eq!(s3.count, 4);
        assert_eq!(s3.ns_total, 6_500);
        assert_eq!(s3.ns_max, 500);
    }
}
