/**
 * ui/platform.ts — 平台归一（main/plane 共用；TitleBar 三平台分支的依据）。
 *
 * gpuix 底层是 Zed 的 gpui：窗口装饰策略与 Zed 一致（2026-09 调研
 * .refs/gpuix/zed 源码定稿，详见 plane/TitleBar.tsx 头注释）：
 * - mac：titlebarTransparent，红绿灯系统画，内容延伸到标题栏区
 * - win：无系统条（WS_SYSMENU|WS_THICKFRAME），drag/三键走命中测试
 * - linux：Client decorations（CSD）——请求 WM 去掉系统标题栏；TitleBar
 *   自绘拖拽 + 最小化/最大化/关闭（windowDecorations: "client"）
 */

import { release } from 'node:os'

export type AppPlatform = 'mac' | 'win' | 'linux'

export const PLATFORM: AppPlatform =
  process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'

/** Darwin 25 = macOS 26 Tahoe；Zed 对 SDK 26+ 把红绿灯让位从 71 提到 78。 */
const MACOS_TAHOE_DARWIN_MAJOR = 25

export function trafficLightWidth(platform: NodeJS.Platform, kernelRelease: string): number {
  if (platform !== 'darwin') return 71
  const major = Number.parseInt(kernelRelease.split('.')[0] ?? '0', 10)
  return Number.isFinite(major) && major >= MACOS_TAHOE_DARWIN_MAJOR ? 78 : 71
}

/**
 * macOS 红绿灯宽度（Zed TRAFFIC_LIGHT_PADDING）。
 *
 * 红绿灯是固定物理像素、不随 UI 缩放，所以用 px 而非 em；含窗口
 * 1px 边框余量。组件按注入的 platform prop 决定是否让位（测试可跨
 * 平台断言；勿写成「真机平台 ? 78 : 0」）。
 */
export const TRAFFIC_LIGHT_WIDTH = trafficLightWidth(process.platform, release())
