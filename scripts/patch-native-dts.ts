/**
 * scripts/patch-native-dts.ts — napi build 重写 index.d.ts 后回补
 * gpuix 面手工类型（Linux CSD：minimizeWindow/closeWindow/windowDecorations）。
 *
 * 生成器永远不知道这些（来自 gpuix 补丁而非 napi 导出）。build.ts 与
 * 本地 `bun run build --platform` 之后都应跑一遍（幂等）。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './refs-config'

const dts = join(REPO_ROOT, 'packages', 'native', 'index.d.ts')
let src = readFileSync(dts, 'utf8')
let changed = false

if (!src.includes('minimizeWindow')) {
  const anchor = '  titlebarDoubleClick(): void\n'
  if (!src.includes(anchor)) {
    console.error('index.d.ts 结构变化：titlebarDoubleClick 锚点丢失，无法回补 CSD 类型')
    process.exit(1)
  }
  src = src.replace(
    anchor,
    `${anchor}  /** Minimize the window (Linux CSD caption button; also usable elsewhere). */\n  minimizeWindow(): void\n  /** Close the window (Linux CSD caption button; also usable elsewhere). */\n  closeWindow(): void\n`,
  )
  changed = true
}

if (!src.includes('windowDecorations')) {
  const anchor = '  titlebarTransparent?: boolean\n'
  if (!src.includes(anchor)) {
    console.error('index.d.ts 结构变化：titlebarTransparent 锚点丢失，无法回补 CSD 类型')
    process.exit(1)
  }
  src = src.replace(
    anchor,
    `${anchor}  /**\n   * 'client' | 'server'. Linux/X11/Wayland window decorations. Client\n   * asks the WM to omit its title bar so the app can draw CSD chrome.\n   * Ignored on macOS/Windows. Defaults to server-side decorations.\n   */\n  windowDecorations?: string\n`,
  )
  changed = true
}

if (changed) {
  writeFileSync(dts, src)
  console.log('── native: index.d.ts CSD 类型已回补')
}
