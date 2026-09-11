/**
 * scripts/pe.ts — PE32/PE32+ 映像的共享解析工具（打包收尾脚本专用）。
 *
 * 提供：头部定位（Optional Header / 数据目录 / 节表）、RVA ↔ 文件偏移换算、
 * PE CheckSum 计算。被 scripts/pe-subsystem.ts（Subsystem 改写）与
 * scripts/pe-icon-resources.ts（图标资源修正）共用。
 */

/** IMAGE_SUBSYSTEM_WINDOWS_GUI */
export const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2
/** IMAGE_SUBSYSTEM_WINDOWS_CUI（bun --compile 的默认） */
export const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3

/** Subsystem 字段在 Optional Header 中的偏移（PE32 与 PE32+ 同为 68） */
export const SUBSYSTEM_OFFSET = 68
/** CheckSum 字段在 Optional Header 中的偏移（PE32 与 PE32+ 同为 64） */
export const CHECKSUM_OFFSET = 64
/** Optional Header 至少要覆盖到 Subsystem 字段末尾 */
const MIN_OPTIONAL_HEADER_SIZE = SUBSYSTEM_OFFSET + 2

/** 资源目录（DataDirectory[2]）在 Optional Header 中的偏移 */
const RESOURCE_DIRECTORY_INDEX = 2
/** IMAGE_DIRECTORY_ENTRY_RESOURCE 的数据目录项位置（PE32+ 为 112，PE32 为 96） */
function dataDirectoryBase(optionalHeader: number, magic: number): number {
  return optionalHeader + (magic === 0x20b ? 112 : 96)
}

export interface PeSection {
  name: string
  /** 虚拟地址（RVA） */
  va: number
  /** 虚拟大小 */
  vsize: number
  /** 文件偏移 */
  raw: number
  /** 文件中的原始大小 */
  rawSize: number
}

export interface PeLayout {
  /** e_lfanew 指向的 PE\0\0 */
  peOffset: number
  /** Optional Header 起始偏移 */
  optionalHeader: number
  /** SizeOfOptionalHeader（文件头上的声明值） */
  sizeOfOptionalHeader: number
  /** Optional Header Magic（0x10b=PE32 / 0x20b=PE32+） */
  magic: number
  sections: PeSection[]
}

export function readU16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8)
}

export function readU32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
}

export function writeU16(buf: Uint8Array, off: number, value: number): void {
  buf[off] = value & 0xff
  buf[off + 1] = (value >>> 8) & 0xff
}

export function writeU32(buf: Uint8Array, off: number, value: number): void {
  buf[off] = value & 0xff
  buf[off + 1] = (value >>> 8) & 0xff
  buf[off + 2] = (value >>> 16) & 0xff
  buf[off + 3] = (value >>> 24) & 0xff
}

/** 解析并校验 PE 结构；不是合法 PE32/PE32+ 映像则抛错。 */
export function parsePe(buf: Uint8Array): PeLayout {
  if (buf.length < 0x40) throw new Error('不是 PE 文件：长度不足以容纳 DOS header')
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error('不是 PE 文件：缺少 MZ 签名')
  const peOffset = readU32(buf, 0x3c)
  if (peOffset + 24 > buf.length) throw new Error('不是 PE 文件：e_lfanew 越界')
  const signature = String.fromCharCode(
    buf[peOffset],
    buf[peOffset + 1],
    buf[peOffset + 2],
    buf[peOffset + 3],
  )
  if (signature !== 'PE\u0000\u0000') throw new Error('不是 PE 文件：缺少 PE\\0\\0 签名')
  const sizeOfOptionalHeader = readU16(buf, peOffset + 20)
  const optionalHeader = peOffset + 24
  if (sizeOfOptionalHeader < MIN_OPTIONAL_HEADER_SIZE) {
    throw new Error(`Optional Header 过短（${sizeOfOptionalHeader}），无法定位 Subsystem`)
  }
  if (optionalHeader + sizeOfOptionalHeader > buf.length) {
    throw new Error('Optional Header 越界（文件被截断？）')
  }
  const magic = readU16(buf, optionalHeader)
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`未知 Optional Header Magic 0x${magic.toString(16)}（非 PE32/PE32+）`)
  }
  const numberOfSections = readU16(buf, peOffset + 6)
  const sectionBase = optionalHeader + sizeOfOptionalHeader
  const sections: PeSection[] = []
  for (let i = 0; i < numberOfSections; i += 1) {
    const s = sectionBase + i * 40
    if (s + 40 > buf.length) throw new Error('节表越界（文件被截断？）')
    let name = ''
    for (let j = 0; j < 8; j += 1) {
      const c = buf[s + j]
      if (c === 0) break
      name += String.fromCharCode(c)
    }
    sections.push({
      name,
      vsize: readU32(buf, s + 8),
      va: readU32(buf, s + 12),
      rawSize: readU32(buf, s + 16),
      raw: readU32(buf, s + 20),
    })
  }
  return { peOffset, optionalHeader, sizeOfOptionalHeader, magic, sections }
}

/** RVA → 文件偏移；落在任何节之外抛错。 */
export function rvaToOffset(layout: PeLayout, rva: number): number {
  for (const s of layout.sections) {
    const span = Math.max(s.vsize, s.rawSize)
    if (rva >= s.va && rva < s.va + span) return s.raw + (rva - s.va)
  }
  throw new Error(`RVA 0x${rva.toString(16)} 不在任何节内`)
}

/** 文件偏移 → RVA；落在任何节之外抛错。 */
export function offsetToRva(layout: PeLayout, offset: number): number {
  for (const s of layout.sections) {
    if (offset >= s.raw && offset < s.raw + s.rawSize) return s.va + (offset - s.raw)
  }
  throw new Error(`文件偏移 0x${offset.toString(16)} 不在任何节内`)
}

/** 首次出现且名为 `name` 的节；没有则返回 null。 */
export function findSection(layout: PeLayout, name: string): PeSection | null {
  return layout.sections.find((s) => s.name === name) ?? null
}

/**
 * PE CheckSum（`CheckSumMappedFile` 算法）：把文件当 16 位字序列累加，
 * 每次加法后把进位折叠回低 16 位；CheckSum 自身的 4 字节按 0 处理；
 * 最后折叠一次并加上文件长度。
 */
export function computePeChecksum(buf: Uint8Array, checksumFieldOffset: number): number {
  let sum = 0
  const evenEnd = buf.length - (buf.length & 1)
  for (let i = 0; i < evenEnd; i += 2) {
    if (i === checksumFieldOffset || i === checksumFieldOffset + 2) continue
    sum += readU16(buf, i)
    sum = (sum & 0xffff) + (sum >>> 16)
  }
  if (buf.length & 1) {
    sum += buf[buf.length - 1]
    sum = (sum & 0xffff) + (sum >>> 16)
  }
  sum = (sum & 0xffff) + (sum >>> 16)
  return (sum + buf.length) >>> 0
}

/** 用当前字节重算并写回 Optional Header 的 CheckSum 字段。 */
export function rewritePeChecksum(buf: Uint8Array, layout: PeLayout): number {
  const offset = layout.optionalHeader + CHECKSUM_OFFSET
  const checksum = computePeChecksum(buf, offset)
  writeU32(buf, offset, checksum)
  return checksum
}

/** 资源目录（DataDirectory[IMAGE_DIRECTORY_ENTRY_RESOURCE]）的 RVA；无资源返回 null。 */
export function resourceDirectoryRva(buf: Uint8Array, layout: PeLayout): number | null {
  const entry =
    dataDirectoryBase(layout.optionalHeader, layout.magic) + RESOURCE_DIRECTORY_INDEX * 8
  const rva = readU32(buf, entry)
  return rva === 0 ? null : rva
}

/**
 * 文件读写重试（Windows 专有坑）：刚编译出的 ~137MB 产物常被杀软/索引器
 * 短暂独占，或被上一次运行的 jagent.exe 拖住，`readFileSync`/`writeFileSync`
 * 会随机报 EBUSY/EPERM（本仓实测构建时撞到过）。构建脚本按退避重试，
 * 最终仍失败才抛错。
 */
export function withWindowsFileLockRetry<T>(op: () => T, attempts = 6, delayMs = 250): T {
  let lastError: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return op()
    } catch (e) {
      lastError = e
      const code = (e as { code?: string }).code
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES' && code !== 'ETXTBSY') throw e
      if (i < attempts - 1) Bun.sleepSync(delayMs)
    }
  }
  const code = (lastError as { code?: string }).code ?? '未知'
  throw new Error(
    `无法写入产物（${code}）：文件被占用。请确认没有正在运行的 jagent.exe` +
      `（或杀软正在扫描刚构建的文件），稍后重试。原始错误：${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
  )
}
