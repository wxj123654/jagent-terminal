/**
 * diagnostics/perfSource.ts — PerfHud 的 PerfSource 实现（从 main.tsx 提取）。
 *
 * 两层数据面：
 * 1. 整 app 帧面：GPUIX 内建 profiler（gpui `profiler` feature，编译进 .node）
 *    对每次 Window::draw（build+layout+paint 全程）计时。直方图默认是
 *    「最近 1000 帧」滚动窗——低帧率下滚动极慢，启动期大帧会冻结在 max
 *    里几分钟（实测 4fps 下 98ms 假峰长期不衰）。因此每窗读后即调
 *    resetDebugFrameOverlayStats（清样本、保 frames 计数）：p90/max 变成
 *    「本采样窗（500ms）内帧」的读数，与 terminal paint 峰值同语义；
 *    差分帧率不受影响。若同时开着屏幕覆盖层，覆盖层读数也同步变实时窗。
 * 2. 终端 paint 子系统面：takePaintPerf（crates/jagent-terminal 打点）。
 * 首次 sample 建基线（Δ=0）；此后每次调用用与上次的时间差/计数差算速率
 * 与均值；cpu 用 process.cpuUsage 差分（含 napi .node 内 Rust 线程，同进程）。
 *
 * native 收口纪律（§1.2）：takePaintPerf 经参数注入，本文件不 import native；
 * clock/cpu 同注入（测试面确定性）。
 */

import type { AppRenderer } from '../appWindow'
import type { PerfSample, PerfSource } from './PerfHud'

/** takePaintPerf 的最小结构面（不 import @jagent/native——seam 纪律） */
export type PaintPerfSnapshot = { count: number; totalNs: number; maxNs: number }

export function createPerfSource(
  renderer: Pick<AppRenderer, 'getDebugFrameOverlayStats' | 'resetDebugFrameOverlayStats'>,
  deps: {
    /** crates/jagent-terminal 打点快照（装配层 = native takePaintPerf） */
    takePaintPerf: () => PaintPerfSnapshot
    now?: () => number
    cpuUsage?: () => NodeJS.CpuUsage
    memoryUsage?: () => NodeJS.MemoryUsage
  },
): PerfSource {
  const now = deps.now ?? performance.now.bind(performance)
  const cpuUsage = deps.cpuUsage ?? process.cpuUsage.bind(process)
  const memoryUsage = deps.memoryUsage ?? process.memoryUsage.bind(process)
  const base = deps.takePaintPerf()
  const frameBase = renderer.getDebugFrameOverlayStats?.()
  renderer.resetDebugFrameOverlayStats?.() // 基线窗从零起算（清启动期样本）
  let last = {
    at: now(),
    cpu: cpuUsage(),
    count: base.count,
    totalNs: base.totalNs,
    frames: frameBase?.frames ?? 0,
  }
  return {
    sample(): PerfSample {
      const snap = deps.takePaintPerf()
      const at = now()
      const cpu = cpuUsage()
      const dtMs = Math.max(at - last.at, 1)
      const dCount = Math.max(snap.count - last.count, 0)
      const dNs = Math.max(snap.totalNs - last.totalNs, 0)
      const frame = renderer.getDebugFrameOverlayStats?.()
      const dFrames = Math.max((frame?.frames ?? last.frames) - last.frames, 0)
      const cpuPct = ((cpu.user - last.cpu.user + cpu.system - last.cpu.system) / 1e6 / dtMs) * 100
      const memMB = memoryUsage().rss / 1048576
      const out = {
        fps: dFrames / (dtMs / 1000),
        // 本采样窗内新帧的 p90/max（读后即清；窗内无新帧时直方图为空 → 0）
        drawP90Ms: dFrames > 0 ? (frame?.p90Ms ?? 0) : 0,
        drawMaxMs: dFrames > 0 ? (frame?.maxMs ?? 0) : 0,
        paintAvgMs: dCount > 0 ? dNs / 1e6 / dCount : 0,
        paintMaxMs: snap.maxNs / 1e6,
        cpuPct,
        memMB,
      }
      last = {
        at,
        cpu,
        count: snap.count,
        totalNs: snap.totalNs,
        frames: frame?.frames ?? last.frames,
      }
      renderer.resetDebugFrameOverlayStats?.() // 下一窗从零起算
      return out
    },
  }
}
