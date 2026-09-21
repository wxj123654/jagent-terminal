/**
 * e2e/png.ts — 最小 PNG 解码器（RGBA8 输出）。
 *
 * 只支持非隔行 bit-depth 8 的 colorType 2(RGB)/6(RGBA)——captureScreenshot
 * 走 Rust image crate 的默认编码，就这两种。其余格式直接抛错让测试显眼失败。
 */

import { inflateSync } from 'node:zlib'

export interface DecodedPng {
  width: number
  height: number
  /** RGBA8，每行 width*4。 */
  data: Buffer
  /** (x,y) 像素 → [r,g,b,a]。 */
  pixel(x: number, y: number): [number, number, number, number]
}

export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8
  let width = 0
  let height = 0
  let colorType = -1
  let bitDepth = -1
  let interlace = -1
  const idat: Buffer[] = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]!
      colorType = data[9]!
      interlace = data[12]!
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: depth=${bitDepth} type=${colorType} interlace=${interlace}`)
  }
  const ch = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * ch
  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch]! : 0
      const b = prev[x]!
      const c = x >= ch ? prev[x - ch]! : 0
      const v = row[x]!
      let p = 0
      switch (filter) {
        case 0:
          p = v
          break
        case 1:
          p = v + a
          break
        case 2:
          p = v + b
          break
        case 3:
          p = v + ((a + b) >> 1)
          break
        case 4: {
          const pp = a + b - c
          const pa = Math.abs(pp - a)
          const pb = Math.abs(pp - b)
          const pc = Math.abs(pp - c)
          p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          throw new Error(`bad PNG filter ${filter}`)
      }
      cur[x] = p & 0xff
    }
    for (let x = 0; x < width; x++) {
      const si = x * ch
      const di = (y * width + x) * 4
      out[di] = cur[si]!
      out[di + 1] = cur[si + 1]!
      out[di + 2] = cur[si + 2]!
      out[di + 3] = ch === 4 ? cur[si + 3]! : 255
    }
    prev = cur
  }
  return {
    width,
    height,
    data: out,
    pixel(x, y) {
      const i = (y * width + x) * 4
      return [out[i]!, out[i + 1]!, out[i + 2]!, out[i + 3]!]
    },
  }
}
