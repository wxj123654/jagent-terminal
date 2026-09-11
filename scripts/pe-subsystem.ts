/**
 * scripts/pe-subsystem.ts — Windows PE 映像 Subsystem 改写（打包收尾步骤）。
 *
 * 为什么需要：
 *   `bun build --compile` 产出的 Windows 可执行默认是 CUI（console）子系统，
 *   双击启动时 Windows 会分配一个控制台窗口——用户看到"多一个终端框"。
 *   本仓 bun 1.3.13 的 `--windows-hide-console` 标志**不生效**（实测：加与不加
 *   产物的 Subsystem 都是 3=CUI；上游修复 PR oven-sh/bun#20594 在 Rust 重写
 *   后按 stale 关闭）。因此打包后自行把 PE 头部 Subsystem 改成 2=GUI。
 *
 * 副作用（改 GUI 后父进程不再持有 console，GUI 化后**必须**同步处理）：
 *   GUI 子系统进程 spawn console 子进程时，Windows 会给子进程新建可见的
 *   控制台窗口。所以打包后所有 spawn（git / ACP agent / 系统打开文件）
 *   都要 `windowsHide: true`。注意 Bun.spawn 的 `windowsHide` 在 1.3.13
 *   实测**无效**，必须走 `node:child_process` 的 spawn（实测有效）。
 *
 * 只改 Optional Header 的 Subsystem（2 字节）+ 重算 PE CheckSum；不动任何
 * 其它字节，Bun SFE 追加在文件尾部的 payload 不受影响。幂等：已是 GUI 时
 * 直接跳过（返回 changed:false）。
 *
 * CLI：
 *   bun scripts/pe-subsystem.ts <exe>            # 改写为 GUI，打印结果
 *   bun scripts/pe-subsystem.ts <exe> --check    # 只读检查（非 0 退出=不是 GUI）
 */

import { readFileSync, writeFileSync } from 'node:fs'

import {
  IMAGE_SUBSYSTEM_WINDOWS_GUI,
  parsePe,
  readU16,
  rewritePeChecksum,
  SUBSYSTEM_OFFSET,
  withWindowsFileLockRetry,
  writeU16,
} from './pe'

// 重导出（既有调用方/测试从本模块取这些名字；实现已下沉至 pe.ts）
export { computePeChecksum, IMAGE_SUBSYSTEM_WINDOWS_CUI, IMAGE_SUBSYSTEM_WINDOWS_GUI } from './pe'

export interface PeSubsystemPatch {
  /** 是否真的改了字节（false = 本来就是 GUI） */
  changed: boolean
  /** 改前 Subsystem */
  from: number
  /** 改后 Subsystem */
  to: number
}

/** 读取 PE 映像的 Subsystem 值（非法 PE 抛错）。 */
export function readPeSubsystem(buf: Uint8Array): number {
  const layout = parsePe(buf)
  return readU16(buf, layout.optionalHeader + SUBSYSTEM_OFFSET)
}

/**
 * 原地把映像改成 Windows GUI 子系统，并重算 CheckSum。
 * 已是 GUI 时不动任何字节（changed:false，CheckSum 也不重算）。
 */
export function setWindowsGuiSubsystem(buf: Uint8Array): PeSubsystemPatch {
  const layout = parsePe(buf)
  const subsystemOffset = layout.optionalHeader + SUBSYSTEM_OFFSET
  const from = readU16(buf, subsystemOffset)
  if (from === IMAGE_SUBSYSTEM_WINDOWS_GUI) {
    return { changed: false, from, to: from }
  }
  writeU16(buf, subsystemOffset, IMAGE_SUBSYSTEM_WINDOWS_GUI)
  rewritePeChecksum(buf, layout)
  return { changed: true, from, to: IMAGE_SUBSYSTEM_WINDOWS_GUI }
}

/** 读文件 → 改 GUI 子系统 → 仅在需要时写回（Windows 文件锁退避重试）。 */
export function patchWindowsGuiSubsystem(exePath: string): PeSubsystemPatch {
  return withWindowsFileLockRetry(() => {
    const buf = readFileSync(exePath)
    const patch = setWindowsGuiSubsystem(buf)
    if (patch.changed) writeFileSync(exePath, buf)
    return patch
  })
}

const SUBSYSTEM_NAMES: Record<number, string> = { 2: 'GUI', 3: 'CUI(console)' }

export function describeSubsystem(value: number): string {
  return `${value}=${SUBSYSTEM_NAMES[value] ?? '?'}`
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [exePath, ...flags] = process.argv.slice(2)
  if (!exePath) {
    console.error('用法: bun scripts/pe-subsystem.ts <exe> [--check]')
    process.exit(2)
  }
  if (flags.includes('--check')) {
    const value = readPeSubsystem(readFileSync(exePath))
    console.log(`${exePath}: subsystem ${describeSubsystem(value)}`)
    process.exit(value === IMAGE_SUBSYSTEM_WINDOWS_GUI ? 0 : 1)
  }
  const patch = patchWindowsGuiSubsystem(exePath)
  console.log(
    patch.changed
      ? `${exePath}: subsystem ${describeSubsystem(patch.from)} → ${describeSubsystem(patch.to)}`
      : `${exePath}: 已是 GUI 子系统，未改动`,
  )
}
