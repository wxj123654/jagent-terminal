/**
 * ui/PerfHud.tsx — 性能指标 HUD（advanced.perfHud 开启时挂在标题栏右上角）。
 *
 * 数据源经 PerfSource seam 注入（native 收口纪律：takePaintPerf 的导入
 * 只出现在 main.tsx 装配层；本组件纯 TS 可测——AgentPlane.test 注入 fake）。
 *
 * 指标语义：
 * - fps：终端绘制帧率（TerminalRenderer::paint 次数 / 采样窗秒数）。
 *   gpui 按需重绘——空闲时 0 是「零重绘省电」的证明，不是故障。
 * - paint 均值/峰值：单次 paint 的毫秒耗时（本窗均值 / 本窗最大）。
 * - cpu：bun 进程整体占用（含 napi .node 内的 Rust 渲染线程）。
 * - mem：进程 RSS。
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { COLORS, FONT } from './tokens'

/** 一次采样的快照（main.tsx 采样器产出；数字均为本窗差分值） */
export type PerfSample = {
  /** 绘制帧/秒（本窗差分；空闲 0） */
  fps: number
  /** 单次 paint 均值 ms（本窗；无绘制时 0） */
  paintAvgMs: number
  /** 本窗单次 paint 峰值 ms */
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
      {`${s.fps.toFixed(0)}fps · paint ${s.paintAvgMs.toFixed(1)}/${s.paintMaxMs.toFixed(1)}ms · cpu ${s.cpuPct.toFixed(0)}% · mem ${s.memMB.toFixed(0)}MB`}
    </text>
  )
}
