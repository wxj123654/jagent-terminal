/**
 * ui/PerfHud.tsx — 性能指标 HUD（advanced.perfHud 开启时挂在标题栏右上角）。
 *
 * 数据源经 PerfSource seam 注入（native 收口纪律：takePaintPerf /
 * getDebugFrameOverlayStats 的导入只出现在 main.tsx 装配层；本组件纯 TS
 * 可测——AgentPlane.test 注入 fake）。
 *
 * 指标语义（两层数据面）：
 * - fps：**整 app 重绘帧率**（GPUIX Window::draw 次数 / 采样窗秒数——
 *   build+layout+paint 一整帧计一次，覆盖全部 UI 而非仅终端）。
 *   gpui 按需重绘——空闲时 0 是「零重绘省电」的证明，不是故障。
 * - draw p90/max：**整帧耗时**毫秒（GPUIX 内建 profiler；采样器每窗读后
 *   即清 reset——读数是本采样窗（500ms）内新帧的 p90/max，无新帧时 0。
 *   不清的话低帧率下启动期大帧会冻结在滚动窗 max 里几分钟）。这是「整
 *   个 app 渲染压力」的直接读数——含 JS 提交后的 Rust build/layout/paint 全程。
 * - term 均值/峰值：终端 paint 子系统耗时（TerminalRenderer::paint
 *   打点，本窗均值 / 本窗最大）——整帧中的大头归因项。
 * - cpu：bun 进程整体占用（含 napi .node 内的 Rust 渲染线程）。
 * - mem：进程 RSS。
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { COLORS, FONT } from './tokens'

/** 一次采样的快照（main.tsx 采样器产出；数字均为本窗差分/滚动窗读数） */
export type PerfSample = {
  /** 整 app 重绘帧/秒（GPUIX frames 差分；空闲 0） */
  fps: number
  /** 整帧 draw p90 ms（GPUIX 最近 1000 帧直方图；本窗无新帧时 0） */
  drawP90Ms: number
  /** 整帧 draw 最大 ms（同一直方图；本窗无新帧时 0） */
  drawMaxMs: number
  /** 终端 paint 均值 ms（本窗；无绘制时 0） */
  paintAvgMs: number
  /** 本窗终端 paint 峰值 ms */
  paintMaxMs: number
  /** 进程 CPU 占用 %（含 Rust 线程；可能 >100 = 多核） */
  cpuPct: number
  /** 进程 RSS MB */
  memMB: number
}

/** 数据源 seam：sample 由采样器按需调用（HUD 以 500ms 轮询） */
export type PerfSource = {
  sample(): PerfSample
}

/** 采样间隔（ms）——paint 峰值/max 读后即清的窗口也由它决定 */
const SAMPLE_INTERVAL_MS = 500

export function PerfHud({ source }: { source: PerfSource }): ReactElement {
  const [s, setS] = useState<PerfSample>(() => source.sample())

  useEffect(() => {
    const timer = setInterval(() => setS(source.sample()), SAMPLE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [source])

  return (
    <text
      testId="perf-hud"
      style={{
        marginRight: 12,
        marginTop: 1,
        fontFamily: FONT.mono,
        fontSize: 10,
        color: COLORS.muted,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      {`${s.fps.toFixed(0)}fps · draw ${s.drawP90Ms.toFixed(1)}/${s.drawMaxMs.toFixed(1)}ms · term ${s.paintAvgMs.toFixed(1)}/${s.paintMaxMs.toFixed(1)}ms · cpu ${s.cpuPct.toFixed(0)}% · mem ${s.memMB.toFixed(0)}MB`}
    </text>
  )
}
// draw/term 各自均值-峰值语义见文件头注：draw=整帧 p90/滚动窗 max，term=本窗均值/峰值。
