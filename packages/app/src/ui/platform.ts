/**
 * ui/platform.ts — 平台归一（main/plane 共用；TitleBar 三平台分支的依据）。
 *
 * gpuix 底层是 Zed 的 gpui：窗口装饰策略与 Zed 一致（2026-09 调研
 * .refs/gpuix/zed 源码定稿，详见 plane/TitleBar.tsx 头注释）：
 * - mac：titlebarTransparent，红绿灯系统画，内容延伸到标题栏区
 * - win：无系统条（WS_SYSMENU|WS_THICKFRAME），drag/三键走命中测试
 * - linux：默认 Server decorations（WM 标题栏在上），无自绘窗口控制
 */

export type AppPlatform = 'mac' | 'win' | 'linux'

export const PLATFORM: AppPlatform =
  process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'

/**
 * macOS 红绿灯宽度（Zed TRAFFIC_LIGHT_PADDING）。
 *
 * 红绿灯是固定物理像素、不随 rem 缩放，所以用 px 而非 rem；含窗口
 * 1px 边框余量。Zed 在 macOS SDK 26（Tahoe）下取 78——那是编译期
 * 探测，运行期无法区分，先取旧值 71，待实测 Tahoe 后再调。
 *
 * 注意：这是纯常量，不带平台判断——组件按注入的 platform prop 决定
 * 是否让位（测试可跨平台断言；勿写成「真机平台 ? 71 : 0」）。
 */
export const TRAFFIC_LIGHT_WIDTH = 71
