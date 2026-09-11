/**
 * scripts/pe-fixture.ts — 合成 PE 映像 fixture（仅供 scripts/pe-*.test.ts）。
 *
 * 结构与 `bun build --compile --windows-icon` 的真实产物同构：PE32+ + 单个
 * `.rsrc` 节 + 两个 RT_GROUP_ICON 组（主组只声明 1 帧、另一个 7 帧，两个
 * blob 相邻且前缀一致）——即任务栏图标发糊的最小复现。
 */

import { RT_GROUP_ICON } from './pe-icon-resources'

// ── 合成 PE fixture（结构与 bun --windows-icon 产物同构）────────────────────
//
// 资源树（全部按 id/名字 + 语言 0x409 三层结构）：
//   RT_GROUP_ICON(14)
//     ├─ "IDI_MYICON" → lang 0x409 → dataEntry → blob A（声明 20B = 1 帧）
//     └─ #0           → lang 0x409 → dataEntry → blob B（声明 104B = 7 帧）
//   blob A 与 blob B 相邻且前缀一致（真实产物就是这样：bun 把帧表写了一遍，
//   主组只声明第一帧）。
//
// 这是任务栏图标发糊的最小复现：Windows 按主组的声明值认为「最大 16×16」。

const SECTION_VA = 0x1000
const SECTION_RAW = 0x200
const PE_OFFSET = 0x80
const OPTIONAL = PE_OFFSET + 24
const OPTIONAL_SIZE = 0xf0

/** fixture 中关键结构的文件偏移（测试断言用）。 */
export const FIXTURE_LAYOUT = {
  peOffset: PE_OFFSET,
  optionalHeader: OPTIONAL,
  optionalSize: OPTIONAL_SIZE,
  /** Optional Header 里 CheckSum 字段的偏移 */
  checksumOffset: OPTIONAL + 64,
  sectionVa: SECTION_VA,
  sectionRaw: SECTION_RAW,
} as const

/** 一帧 GROUP_ICON 目录项（14 字节） */
function frameEntry(width: number, height: number, id: number): Buffer {
  const e = Buffer.alloc(14)
  e[0] = width === 256 ? 0 : width
  e[1] = height === 256 ? 0 : height
  e[4] = 1 // planes
  e[6] = 32 // bitCount
  e.writeUInt32LE(100 + id, 8) // dwBytesInRes（值不参与断言）
  e.writeUInt16LE(id, 12)
  return e
}

/** GROUP_ICON blob：reserved(2) + type(2) + count(2) + count×14 */
function iconGroupBlob(frames: [number, number, number][]): Buffer {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(frames.length, 4)
  return Buffer.concat([head, ...frames.map(([w, h, id]) => frameEntry(w, h, id))])
}

export interface IconFixture {
  buf: Buffer
  /** 修正后应当被写入的 blob 文件偏移 */
  expectedBlobOffset: number
  expectedSize: number
  /** 主组（IDI_MYICON）数据项的文件偏移——断言只改它 */
  primaryDataEntryOffset: number
}

export function makeIconFixture(): IconFixture {
  // 帧表：A = 1 帧，B = 同前缀的 7 帧
  const allFrames: [number, number, number][] = [
    [16, 16, 1],
    [24, 24, 2],
    [32, 32, 3],
    [48, 48, 4],
    [64, 64, 5],
    [128, 128, 6],
    [256, 256, 7],
  ]
  const blobA = iconGroupBlob(allFrames.slice(0, 1))
  const blobB = iconGroupBlob(allFrames)
  expect(blobA.length).toBe(20)
  expect(blobB.length).toBe(104)

  // ── 资源段布局（顺序分配，记录关键偏移）──
  const lvl1 = 0
  const lvl1Size = 16 + 1 * 8
  const lvl2 = lvl1 + lvl1Size
  const lvl2Size = 16 + 2 * 8
  const lvl3A = lvl2 + lvl2Size
  const lvl3Size = 16 + 1 * 8
  const lvl3B = lvl3A + lvl3Size
  const dataA = lvl3B + lvl3Size
  const dataEntrySize = 16
  const dataB = dataA + dataEntrySize
  const nameStr = dataB + dataEntrySize
  const name = 'IDI_MYICON'
  const nameStrSize = 2 + name.length * 2
  const blobAOffset = align4(nameStr + nameStrSize)
  const blobBOffset = blobAOffset + blobA.length
  const sectionSize = blobBOffset + blobB.length

  const section = Buffer.alloc(align4(sectionSize))
  const writeDir = (offset: number, named: number, ids: number) => {
    section.writeUInt16LE(named, offset + 12)
    section.writeUInt16LE(ids, offset + 14)
  }
  const writeEntry = (offset: number, nameRaw: number, childOffset: number, isDir: boolean) => {
    section.writeUInt32LE(nameRaw >>> 0, offset)
    section.writeUInt32LE(((isDir ? 0x80000000 : 0) | childOffset) >>> 0, offset + 4)
  }
  const writeDataEntry = (offset: number, blobOffset: number, size: number) => {
    section.writeUInt32LE(SECTION_VA + blobOffset, offset)
    section.writeUInt32LE(size, offset + 4)
    section.writeUInt32LE(0x409, offset + 8) // code page
    section.writeUInt32LE(0, offset + 12) // reserved
  }
  // level 1：唯一类型 RT_GROUP_ICON
  writeDir(lvl1, 0, 1)
  writeEntry(lvl1 + 16, RT_GROUP_ICON, lvl2, true)
  // level 2：命名组 IDI_MYICON + 数字组 #0
  writeDir(lvl2, 1, 1)
  writeEntry(lvl2 + 16, 0x80000000 | nameStr, lvl3A, true)
  writeEntry(lvl2 + 24, 0, lvl3B, true)
  // level 3：语言层直接是数据项（真实产物同构；lang 因此为 0）
  writeDir(lvl3A, 0, 1)
  writeEntry(lvl3A + 16, 0x409, dataA, false)
  writeDir(lvl3B, 0, 1)
  writeEntry(lvl3B + 16, 0x409, dataB, false)
  // 数据项
  writeDataEntry(dataA, blobAOffset, blobA.length)
  writeDataEntry(dataB, blobBOffset, blobB.length)
  // 名字字符串（len + UTF-16LE）
  section.writeUInt16LE(name.length, nameStr)
  section.write(name, nameStr + 2, 'utf16le')
  // blob
  blobA.copy(section, blobAOffset)
  blobB.copy(section, blobBOffset)

  // ── PE 骨架 ──
  const buf = Buffer.alloc(SECTION_RAW + section.length)
  buf[0] = 0x4d
  buf[1] = 0x5a
  buf.writeUInt32LE(PE_OFFSET, 0x3c)
  buf.write('PE\0\0', PE_OFFSET, 'latin1')
  buf.writeUInt16LE(1, PE_OFFSET + 6) // NumberOfSections
  buf.writeUInt16LE(OPTIONAL_SIZE, PE_OFFSET + 20)
  buf.writeUInt16LE(0x20b, OPTIONAL) // PE32+
  buf.writeUInt32LE(SECTION_VA + lvl1, OPTIONAL + 112 + 2 * 8) // DataDirectory[2].VirtualAddress
  buf.writeUInt32LE(sectionSize, OPTIONAL + 112 + 2 * 8 + 4)
  const sh = OPTIONAL + OPTIONAL_SIZE
  buf.write('.rsrc\0\0\0', sh, 'latin1')
  buf.writeUInt32LE(sectionSize, sh + 8)
  buf.writeUInt32LE(SECTION_VA, sh + 12)
  buf.writeUInt32LE(section.length, sh + 16)
  buf.writeUInt32LE(SECTION_RAW, sh + 20)
  section.copy(buf, SECTION_RAW)

  return {
    buf,
    expectedBlobOffset: SECTION_RAW + blobBOffset,
    expectedSize: blobB.length,
    primaryDataEntryOffset: SECTION_RAW + dataA,
  }
}

export function align4(value: number): number {
  return (value + 3) & ~3
}
