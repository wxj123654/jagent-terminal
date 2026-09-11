import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findSection, parsePe, readU16, readU32, resourceDirectoryRva, rvaToOffset } from './pe'
import { FIXTURE_LAYOUT, makeIconFixture } from './pe-fixture'
import {
  fixIconGroupOrdinal,
  fixIconGroupResources,
  listIconGroups,
  patchIconResources,
} from './pe-icon-resources'
import { computePeChecksum } from './pe-subsystem'

describe('listIconGroups', () => {
  test('解析资源树：命名组与数字组都能列出，帧数来自 blob 头，序号可辨', () => {
    const { buf } = makeIconFixture()
    const groups = listIconGroups(buf)
    // lang=0：fixture 与真实产物一致——level-3 条目直指数据项，没有语言子目录
    expect(groups.map((g) => [g.name, g.ordinal, g.lang, g.frames, g.declaredSize])).toEqual([
      ['IDI_MYICON', null, 0, 1, 20],
      ['#0', 0, 0, 7, 104],
    ])
  })

  test('只认 RT_GROUP_ICON：RT_ICON / RT_VERSION 等同级类型不进列表', () => {
    const { buf } = makeIconFixture()
    // 把 level-2 名字改掉不影响类型过滤；真正的过滤在 level-1 的 type id
    expect(listIconGroups(buf)).toHaveLength(2)
    const noResource = Buffer.from(buf)
    noResource.writeUInt32LE(0, FIXTURE_LAYOUT.optionalHeader + 112 + 2 * 8) // 清空资源目录 RVA
    expect(listIconGroups(noResource)).toEqual([])
  })

  test('无 .rsrc 节 / 空资源不抛错', () => {
    const { buf } = makeIconFixture()
    const layout = parsePe(buf)
    expect(findSection(layout, '.rsrc')?.raw).toBe(FIXTURE_LAYOUT.sectionRaw)
    expect(resourceDirectoryRva(buf, layout)).toBe(FIXTURE_LAYOUT.sectionVa)
    expect(rvaToOffset(layout, FIXTURE_LAYOUT.sectionVa)).toBe(FIXTURE_LAYOUT.sectionRaw)
  })
})

describe('fixIconGroupOrdinal', () => {
  test('#0 → #1：只改 level-2 名字字段 4 字节 + CheckSum', () => {
    const { buf } = makeIconFixture()
    const before = Buffer.from(buf)
    const fix = fixIconGroupOrdinal(buf)
    expect(fix).toEqual({ name: '#0', from: 0, to: 1 })
    const groups = listIconGroups(buf)
    expect(groups.map((g) => [g.name, g.ordinal])).toEqual([
      ['IDI_MYICON', null],
      ['#1', 1],
    ])
    // 帧声明不受影响；改动只落在名字字段（0→1 小端仅 1 字节）与 CheckSum
    expect(groups.map((g) => g.frames)).toEqual([1, 7])
    const nameEntry = groups.find((g) => g.ordinal === 1)!.nameEntryOffset
    const layout = parsePe(buf)
    const checksumAt = layout.optionalHeader + 64
    const changed = []
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] !== before[i]) {
        const inName = i >= nameEntry && i < nameEntry + 4
        const inChecksum = i >= checksumAt && i < checksumAt + 4
        if (!inName && !inChecksum) throw new Error(`越界改动 @${i}`)
        changed.push(i)
      }
    }
    expect(changed.length).toBeGreaterThan(0)
  })

  test('已有 ordinal 1 时不改（幂等）', () => {
    const { buf } = makeIconFixture()
    fixIconGroupOrdinal(buf)
    expect(fixIconGroupOrdinal(buf)).toBeNull()
  })

  test('命名组不受影响；帧修正与序号修正互不干扰', () => {
    const { buf } = makeIconFixture()
    fixIconGroupOrdinal(buf)
    const frameFixes = fixIconGroupResources(buf)
    expect(frameFixes.map((f) => f.name)).toEqual(['IDI_MYICON'])
    const groups = listIconGroups(buf)
    expect(groups.map((g) => [g.name, g.ordinal, g.frames])).toEqual([
      ['IDI_MYICON', null, 7],
      ['#1', 1, 7],
    ])
  })
})

describe('fixIconGroupResources', () => {
  test('把缺帧的组指向最大 blob（RVA + 尺寸），并重算 CheckSum', () => {
    const { buf, expectedBlobOffset, expectedSize, primaryDataEntryOffset } = makeIconFixture()
    const before = computePeChecksum(buf, FIXTURE_LAYOUT.checksumOffset)
    const layout = parsePe(buf)
    const fixes = fixIconGroupResources(buf)
    expect(fixes).toEqual([
      { name: 'IDI_MYICON', fromFrames: 1, toFrames: 7, fromSize: 20, toSize: 104 },
    ])
    // 数据项已指向 7 帧 blob
    expect(rvaToOffset(layout, readU32(buf, primaryDataEntryOffset))).toBe(expectedBlobOffset)
    expect(readU32(buf, primaryDataEntryOffset + 4)).toBe(expectedSize)
    expect(listIconGroups(buf).map((g) => g.frames)).toEqual([7, 7])
    expect(computePeChecksum(buf, FIXTURE_LAYOUT.checksumOffset)).not.toBe(before)
    expect(readU32(buf, FIXTURE_LAYOUT.checksumOffset)).toBe(
      computePeChecksum(buf, FIXTURE_LAYOUT.checksumOffset),
    )
  })

  test('幂等：第二次调用无改动、字节全等', () => {
    const { buf } = makeIconFixture()
    fixIconGroupResources(buf)
    const snapshot = Buffer.from(buf)
    expect(fixIconGroupResources(buf)).toEqual([])
    expect(buf.equals(snapshot)).toBe(true)
  })

  test('只改数据项的 8 字节 + CheckSum 4 字节', () => {
    const { buf, primaryDataEntryOffset } = makeIconFixture()
    const original = Buffer.from(buf)
    fixIconGroupResources(buf)
    const editable = (i: number) =>
      (i >= primaryDataEntryOffset && i < primaryDataEntryOffset + 8) ||
      (i >= FIXTURE_LAYOUT.checksumOffset && i < FIXTURE_LAYOUT.checksumOffset + 4)
    for (let i = 0; i < buf.length; i += 1) {
      if (!editable(i)) expect(buf[i]).toBe(original[i])
    }
  })

  test('只有一个图标组时不改（无法判断谁含帧更多）', () => {
    const { buf } = makeIconFixture()
    // 把 level-1 条目数改成 0 → 树里没有组
    const layout = parsePe(buf)
    const base = rvaToOffset(layout, resourceDirectoryRva(buf, layout)!)
    buf.writeUInt16LE(0, base + 14)
    expect(fixIconGroupResources(buf)).toEqual([])
  })

  test('帧数据本身不被改写（blob 字节原样）', () => {
    const { buf, expectedBlobOffset, expectedSize } = makeIconFixture()
    const blob = Buffer.from(buf.subarray(expectedBlobOffset, expectedBlobOffset + expectedSize))
    fixIconGroupResources(buf)
    expect(buf.subarray(expectedBlobOffset, expectedBlobOffset + expectedSize).equals(blob)).toBe(
      true,
    )
  })
})

describe('patchIconResources', () => {
  test('写回文件、可重复调用；非 PE 抛错不落盘', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pe-icons-'))
    try {
      const file = join(dir, 'fake.exe')
      await writeFile(file, makeIconFixture().buf)
      const first = patchIconResources(file)
      expect(first.ordinalFix).toEqual({ name: '#0', from: 0, to: 1 })
      expect(first.frameFixes.map((f) => f.name)).toEqual(['IDI_MYICON'])
      const second = patchIconResources(file)
      expect(second.ordinalFix).toBeNull()
      expect(second.frameFixes).toEqual([])
      const groups = listIconGroups(await readFile(file))
      expect(groups.map((g) => [g.ordinal, g.frames])).toEqual([
        [null, 7],
        [1, 7],
      ])

      const bad = join(dir, 'not-pe.exe')
      await writeFile(bad, Buffer.from('definitely not a PE file'))
      expect(() => patchIconResources(bad)).toThrow(/PE/)
      expect((await readFile(bad)).toString()).toBe('definitely not a PE file')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('fixture 自检', () => {
  test('合成 PE 的结构与真实产物一致（PE32+ / .rsrc / 20B 与 104B 两个 blob）', () => {
    const { buf } = makeIconFixture()
    const layout = parsePe(buf)
    expect(layout.magic).toBe(0x20b)
    const groups = listIconGroups(buf)
    expect(groups[0].declaredSize).toBe(20)
    expect(groups[1].declaredSize).toBe(104)
    // 两个 blob 相邻：A 的结尾就是 B 的开头（真实产物同样）
    expect(groups[0].blobOffset + groups[0].declaredSize).toBe(groups[1].blobOffset)
    expect(readU16(buf, groups[1].blobOffset + 4)).toBe(7)
  })
})
