import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computePeChecksum,
  describeSubsystem,
  IMAGE_SUBSYSTEM_WINDOWS_CUI,
  IMAGE_SUBSYSTEM_WINDOWS_GUI,
  patchWindowsGuiSubsystem,
  readPeSubsystem,
  setWindowsGuiSubsystem,
} from './pe-subsystem'

const PE_OFFSET = 0x80
const OPTIONAL = PE_OFFSET + 24
const SUBSYSTEM_OFF = OPTIONAL + 68
const CHECKSUM_OFF = OPTIONAL + 64

function writeU16(buf: Uint8Array, off: number, value: number) {
  buf[off] = value & 0xff
  buf[off + 1] = (value >>> 8) & 0xff
}

function writeU32(buf: Uint8Array, off: number, value: number) {
  buf[off] = value & 0xff
  buf[off + 1] = (value >>> 8) & 0xff
  buf[off + 2] = (value >>> 16) & 0xff
  buf[off + 3] = (value >>> 24) & 0xff
}

/** 合成最小 PE 映像（bun --compile 产物同构：PE32+ / CUI / SizeOfOptionalHeader 0xf0） */
function makePe(opts: { magic?: number; subsystem?: number; optionalSize?: number } = {}) {
  const magic = opts.magic ?? 0x20b
  const subsystem = opts.subsystem ?? IMAGE_SUBSYSTEM_WINDOWS_CUI
  const optionalSize = opts.optionalSize ?? 0xf0
  const buf = new Uint8Array(OPTIONAL + optionalSize)
  buf[0] = 0x4d // MZ
  buf[1] = 0x5a
  writeU32(buf, 0x3c, PE_OFFSET)
  buf[PE_OFFSET] = 0x50 // PE\0\0
  buf[PE_OFFSET + 1] = 0x45
  writeU16(buf, PE_OFFSET + 20, optionalSize) // SizeOfOptionalHeader
  writeU16(buf, OPTIONAL, magic)
  writeU16(buf, SUBSYSTEM_OFF, subsystem)
  writeU32(buf, CHECKSUM_OFF, 0)
  // 填充些非零内容，让校验和计算有实质输入
  for (let i = OPTIONAL + 72; i < buf.length; i += 1) buf[i] = (i * 7) & 0xff
  return buf
}

describe('readPeSubsystem', () => {
  test('PE32+ 与 PE32 的 Subsystem 偏移一致（都取 optional+68）', () => {
    expect(readPeSubsystem(makePe({ magic: 0x20b }))).toBe(IMAGE_SUBSYSTEM_WINDOWS_CUI)
    expect(readPeSubsystem(makePe({ magic: 0x10b }))).toBe(IMAGE_SUBSYSTEM_WINDOWS_CUI)
  })

  test('拒绝非 PE：缺 MZ / 短文件 / 缺 PE 签名 / e_lfanew 越界', () => {
    expect(() => readPeSubsystem(new Uint8Array(0x10))).toThrow(/DOS header/)
    const noMz = makePe()
    noMz[0] = 0
    expect(() => readPeSubsystem(noMz)).toThrow(/MZ/)
    const badSig = makePe()
    badSig[PE_OFFSET] = 0x4e
    expect(() => readPeSubsystem(badSig)).toThrow(/PE/)
    const badOffset = makePe()
    writeU32(badOffset, 0x3c, 0xfffff0)
    expect(() => readPeSubsystem(badOffset)).toThrow(/e_lfanew/)
  })

  test('拒绝未知 Optional Header Magic 与过短的 Optional Header', () => {
    expect(() => readPeSubsystem(makePe({ magic: 0x107 }))).toThrow(/Magic/)
    expect(() => readPeSubsystem(makePe({ optionalSize: 0x40 }))).toThrow(/过短/)
  })
})

describe('setWindowsGuiSubsystem', () => {
  test('CUI → GUI：改 Subsystem 并重算 CheckSum', () => {
    const buf = makePe()
    const before = computePeChecksum(buf, CHECKSUM_OFF)
    const patch = setWindowsGuiSubsystem(buf)
    expect(patch).toEqual({
      changed: true,
      from: IMAGE_SUBSYSTEM_WINDOWS_CUI,
      to: IMAGE_SUBSYSTEM_WINDOWS_GUI,
    })
    expect(readPeSubsystem(buf)).toBe(IMAGE_SUBSYSTEM_WINDOWS_GUI)
    const after = computePeChecksum(buf, CHECKSUM_OFF)
    expect(after).not.toBe(before)
    // 写回的 CheckSum 字段与重算结果一致
    const stored =
      buf[CHECKSUM_OFF] |
      (buf[CHECKSUM_OFF + 1] << 8) |
      (buf[CHECKSUM_OFF + 2] << 16) |
      (buf[CHECKSUM_OFF + 3] << 24)
    expect(stored >>> 0).toBe(after)
  })

  test('幂等：已是 GUI 时不动任何字节', () => {
    const buf = makePe()
    setWindowsGuiSubsystem(buf)
    const snapshot = Uint8Array.from(buf)
    const second = setWindowsGuiSubsystem(buf)
    expect(second).toEqual({
      changed: false,
      from: IMAGE_SUBSYSTEM_WINDOWS_GUI,
      to: IMAGE_SUBSYSTEM_WINDOWS_GUI,
    })
    expect(Array.from(buf)).toEqual(Array.from(snapshot))
  })

  test('除 Subsystem(2B) 与 CheckSum(4B) 外，其它字节原样', () => {
    const buf = makePe()
    const original = Uint8Array.from(buf)
    setWindowsGuiSubsystem(buf)
    const editable = (i: number) =>
      i === SUBSYSTEM_OFF || i === SUBSYSTEM_OFF + 1 || (i >= CHECKSUM_OFF && i < CHECKSUM_OFF + 4)
    for (let i = 0; i < buf.length; i += 1) {
      if (!editable(i)) expect(buf[i]).toBe(original[i])
    }
    expect(buf[SUBSYSTEM_OFF]).toBe(IMAGE_SUBSYSTEM_WINDOWS_GUI & 0xff)
    expect(buf[SUBSYSTEM_OFF + 1]).toBe(0)
  })
})

describe('computePeChecksum', () => {
  test('按 16 位字折叠累加 + 文件长度（CheckSum 字段零化）', () => {
    const buf = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0])
    // 跳过 offset 0 起的 4 字节（word0/word1）→ 3 + 4 = 7；+ 长度 8 = 15
    expect(computePeChecksum(buf, 0)).toBe(15)
    // 不跳过任何字段 → 1+2+3+4 = 10；+ 8 = 18
    expect(computePeChecksum(buf, 0x1000)).toBe(18)
  })

  test('奇数长度：末字节单独累加', () => {
    expect(computePeChecksum(new Uint8Array([1, 0, 2, 0, 5]), 0x1000)).toBe(1 + 2 + 5 + 5)
  })
})

describe('patchWindowsGuiSubsystem', () => {
  test('写回文件并可重复调用', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pe-subsystem-'))
    try {
      const file = join(dir, 'fake.exe')
      await writeFile(file, makePe())
      const first = patchWindowsGuiSubsystem(file)
      expect(first.changed).toBe(true)
      expect(readPeSubsystem(await readFile(file))).toBe(IMAGE_SUBSYSTEM_WINDOWS_GUI)
      const second = patchWindowsGuiSubsystem(file)
      expect(second.changed).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('describeSubsystem', () => {
  test('人类可读输出', () => {
    expect(describeSubsystem(2)).toBe('2=GUI')
    expect(describeSubsystem(3)).toBe('3=CUI(console)')
    expect(describeSubsystem(9)).toBe('9=?')
  })
})
