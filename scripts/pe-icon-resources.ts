/**
 * scripts/pe-icon-resources.ts — Windows PE 图标资源修正（打包收尾步骤）。
 *
 * 为什么需要：
 *   `bun build --compile --windows-icon <ico>` 在 PE 里写图标时留下两个
 *   `RT_GROUP_ICON` 资源组，其中**主组（IDI_MYICON）的 dwBytesInRes 只声明
 *   第一帧**（bun 1.3.13 实测：`IDI_MYICON` size=20 = 1 帧，紧随其后的
 *   `#0` size=104 = 7 帧，两者共享同一份帧表数据）。Windows / Explorer /
 *   任务栏看到的「这个图标组里有多少可选尺寸」由该声明值决定，于是它们
 *   认为最大只有 16×16，把 16px 帧放大到任务栏需要的 32px（96 DPI）——
 *   图标发糊的根因。ICO 源文件本身是好的（16…256 七档齐全）。
 *
 * 修法（两步）：
 *   ① 帧声明：把各组的数据项指向含帧最多的那个 blob（同一次 --windows-icon
 *      写入，帧表内容一致），否则 Windows 认为图标最大 16×16。
 *   ② 组序号：gpui 的窗口类注册用 `LoadImageW(module, MAKEINTRESOURCE(1),
 *      IMAGE_ICON, …)` 取图标（gpui_windows/src/platform.rs `load_icon`），
 *      但 bun 把组名写成 `IDI_MYICON` 和 ordinal `#0`，没有 id=1 —— 取图
 *      标永远失败 → 窗口类 hIcon=0 → 任务栏对「无窗口图标的窗口”走 16px
 *      小图标回退再放大，这是任务栏图标发糊的第二层根因。把 ordinal 组
 *      改名为 1 后窗口图标立即生效，无需改 gpuix。
 *
 * 幂等：两步各自判断，已达标时不动字节。**不改变**任何帧数据本身。
 *
 * CLI：
 *   bun scripts/pe-icon-resources.ts <exe>            # 修正，打印变化
 *   bun scripts/pe-icon-resources.ts <exe> --check    # 只读检查（非 0 退出=需修正）
 */

import { readFileSync, writeFileSync } from 'node:fs'

import {
  offsetToRva,
  parsePe,
  readU16,
  readU32,
  resourceDirectoryRva,
  rvaToOffset,
  rewritePeChecksum,
  withWindowsFileLockRetry,
  writeU32,
  type PeLayout,
} from './pe'

/** IMAGE_DIRECTORY_ENTRY_RESOURCE 的 type id */
export const RT_ICON = 3
export const RT_GROUP_ICON = 14

/** 一个 RT_GROUP_ICON 资源组（叶子数据项）。 */
export interface IconGroupResource {
  /** 资源名（如 `IDI_MYICON`；数字名以 `#N` 表示） */
  name: string
  /** 资源的数字序号（命名组为 null）——gpui 的 MAKEINTRESOURCE(1) 找的就是它 */
  ordinal: number | null
  /** level-2 目录项（名字字段所在）的文件偏移——改序号就是改这里 4 字节 */
  nameEntryOffset: number
  /** 语言 id */
  lang: number
  /** 数据项（IMAGE_RESOURCE_DATA_ENTRY）的文件偏移——改的就是这里的 RVA/Size */
  dataEntryOffset: number
  /** 图标 blob 的文件偏移 */
  blobOffset: number
  /** 数据项声明的字节数（决定帧数的就是它） */
  declaredSize: number
  /** 声明帧数（blob 第 5-6 字节） */
  frames: number
}

/** 资源目录树：把 level-3 的叶子数据项收集进 `out`。 */
function walkResourceLeaves(
  buf: Uint8Array,
  layout: PeLayout,
  base: number,
  dirOffset: number,
  level: number,
  name: string,
  out: IconGroupResource[],
): void {
  const named = readU16(buf, dirOffset + 12)
  const ids = readU16(buf, dirOffset + 14)
  for (let i = 0; i < named + ids; i += 1) {
    const entry = dirOffset + 16 + i * 8
    const nameRaw = readU32(buf, entry)
    const offsetRaw = readU32(buf, entry + 4)
    const child = base + (offsetRaw & 0x7fffffff)
    const isDir = (offsetRaw & 0x80000000) !== 0
    if (level === 1) {
      // 只关心 RT_GROUP_ICON（数字类型 id；命名类型不是图标组，跳过）
      if ((nameRaw & 0x80000000) !== 0 || nameRaw !== RT_GROUP_ICON) continue
      walkResourceLeaves(buf, layout, base, child, 2, '', out)
      continue
    }
    if (level === 2) {
      const isNamed = (nameRaw & 0x80000000) !== 0
      const ordinal = isNamed ? null : nameRaw
      walkResourceLeaves(buf, layout, base, child, 3, resourceName(buf, base, nameRaw), out)
      // 把 level-2 入口信息回填给刚收集的叶子（同层可能多个语言叶共享入口）
      for (const leaf of out) {
        if (leaf.nameEntryOffset === -1) {
          leaf.ordinal = ordinal
          leaf.nameEntryOffset = entry
        }
      }
      continue
    }
    // level 3：语言层可以是目录，也可以直接是数据项（本仓见到的都是目录）
    const dataEntry = isDir ? child + 16 + 4 : child
    const lang = isDir ? readU32(buf, child + 16) & 0xffff : 0
    const blobRva = readU32(buf, dataEntry)
    const declaredSize = readU32(buf, dataEntry + 4)
    const blobOffset = rvaToOffset(layout, blobRva)
    out.push({
      name,
      ordinal: null,
      nameEntryOffset: -1,
      lang,
      dataEntryOffset: dataEntry,
      blobOffset,
      declaredSize,
      frames: readU16(buf, blobOffset + 4),
    })
  }
}

function resourceName(buf: Uint8Array, base: number, raw: number): string {
  if ((raw & 0x80000000) === 0) return `#${raw}`
  const strOffset = base + (raw & 0x7fffffff)
  const len = readU16(buf, strOffset)
  let out = ''
  for (let i = 0; i < len; i += 1) {
    out += String.fromCharCode(readU16(buf, strOffset + 2 + i * 2))
  }
  return out
}

/** 列出 PE 里所有 RT_GROUP_ICON 资源组；无资源段/无图标返回 []。 */
export function listIconGroups(buf: Uint8Array): IconGroupResource[] {
  const layout = parsePe(buf)
  const resourceRva = resourceDirectoryRva(buf, layout)
  if (resourceRva == null) return []
  const base = rvaToOffset(layout, resourceRva)
  const out: IconGroupResource[] = []
  walkResourceLeaves(buf, layout, base, base, 1, '', out)
  return out
}

/** 一次修正里某一组的变化。 */
export interface IconGroupFix {
  name: string
  fromFrames: number
  toFrames: number
  fromSize: number
  toSize: number
}

/**
 * 原地把所有 RT_GROUP_ICON 组指向含帧最多的 blob（见文件头注）。
 * 走 [] 表示无需修正（幂等）；有任何改动时重算 PE CheckSum。
 */
export function fixIconGroupResources(buf: Uint8Array): IconGroupFix[] {
  const layout = parsePe(buf)
  const groups = listIconGroups(buf)
  if (groups.length < 2) return []
  const best = groups.reduce((a, b) => (b.frames > a.frames ? b : a))
  const fixes: IconGroupFix[] = []
  for (const g of groups) {
    if (g.frames >= best.frames) continue
    writeU32(buf, g.dataEntryOffset, offsetToRva(layout, best.blobOffset))
    writeU32(buf, g.dataEntryOffset + 4, best.declaredSize)
    fixes.push({
      name: g.name,
      fromFrames: g.frames,
      toFrames: best.frames,
      fromSize: g.declaredSize,
      toSize: best.declaredSize,
    })
  }
  if (fixes.length > 0) rewritePeChecksum(buf, layout)
  return fixes
}

/** 组序号修正（ordinal #0 → #1，供 gpui 的 MAKEINTRESOURCE(1) 命中）。 */
export interface IconOrdinalFix {
  /** 改名的组 */
  name: string
  from: number
  to: number
}

/**
 * 把 ordinal #0 的图标组改名为 #1（见文件头注②）。
 * 已存在 ordinal 1（或没有 ordinal 0）时不动，返回 null 表示无需修正。
 */
export function fixIconGroupOrdinal(buf: Uint8Array): IconOrdinalFix | null {
  const groups = listIconGroups(buf)
  if (groups.some((g) => g.ordinal === 1)) return null
  const zero = groups.find((g) => g.ordinal === 0)
  if (!zero) return null
  const layout = parsePe(buf)
  writeU32(buf, zero.nameEntryOffset, 1)
  rewritePeChecksum(buf, layout)
  return { name: zero.name, from: 0, to: 1 }
}

/** 一次 patchIconResources 的全部变化。 */
export interface IconResourcePatch {
  frameFixes: IconGroupFix[]
  ordinalFix: IconOrdinalFix | null
}

/** 读文件 → 修正图标资源（序号 + 帧声明）→ 仅在需要时写回（Windows 文件锁退避重试）。 */
export function patchIconResources(exePath: string): IconResourcePatch {
  return withWindowsFileLockRetry(() => {
    const buf = readFileSync(exePath)
    const ordinalFix = fixIconGroupOrdinal(buf)
    const frameFixes = fixIconGroupResources(buf)
    if (ordinalFix !== null || frameFixes.length > 0) writeFileSync(exePath, buf)
    return { frameFixes, ordinalFix }
  })
}

function describePatch(patch: IconResourcePatch): string {
  const parts: string[] = []
  if (patch.ordinalFix) {
    parts.push(`组序号 #${patch.ordinalFix.from}→#${patch.ordinalFix.to}（窗口图标 MAKEINTRESOURCE(1) 可命中）`)
  }
  if (patch.frameFixes.length > 0) {
    parts.push(
      patch.frameFixes
        .map((f) => `${f.name}: ${f.fromFrames} 帧/${f.fromSize}B → ${f.toFrames} 帧/${f.toSize}B`)
        .join('；'),
    )
  }
  return parts.join('；')
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [exePath, ...flags] = process.argv.slice(2)
  if (!exePath) {
    console.error('用法: bun scripts/pe-icon-resources.ts <exe> [--check]')
    process.exit(2)
  }
  if (flags.includes('--check')) {
    const groups = listIconGroups(readFileSync(exePath))
    const best = groups.reduce((a, b) => (b.frames > a.frames ? b : a), { frames: 0 })
    const badFrames = groups.filter((g) => g.frames < best.frames)
    const hasOrdinal1 = groups.some((g) => g.ordinal === 1)
    console.log(
      `${exePath}: RT_GROUP_ICON ${groups.map((g) => `${g.name}=${g.frames}帧/${g.declaredSize}B`).join(' ')}` +
        `; ordinal1=${hasOrdinal1 ? '有' : '无'}`,
    )
    process.exit(badFrames.length === 0 && hasOrdinal1 ? 0 : 1)
  }
  const patch = patchIconResources(exePath)
  const described = describePatch(patch)
  console.log(
    described.length > 0
      ? `${exePath}: 图标资源已修正 — ${described}`
      : `${exePath}: 图标资源无需修正`,
  )
}
