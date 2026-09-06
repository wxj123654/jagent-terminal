import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { Resvg } from '@resvg/resvg-js'
import { REPO_ROOT } from './refs-config'

const root = join(REPO_ROOT, 'packages/app/assets/icons')
const svg = readFileSync(join(root, 'app.svg'))
const hash = createHash('sha256').update(svg).digest('hex')
const png = (size: number) => readFileSync(join(root, `app-${size}.png`))
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

function pngChunks(buffer: Buffer) {
  expect(buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  const chunks: { type: string; data: Buffer; raw: Buffer }[] = []
  let offset = 8
  while (offset < buffer.length) {
    const size = buffer.readUInt32BE(offset)
    const end = offset + 12 + size
    expect(end).toBeLessThanOrEqual(buffer.length)
    expect(buffer.readUInt32BE(end - 4)).toBe(crc32(buffer.subarray(offset + 4, end - 4)))
    chunks.push({
      type: buffer.toString('ascii', offset + 4, offset + 8),
      data: buffer.subarray(offset + 8, end - 4),
      raw: buffer.subarray(offset, end),
    })
    offset = end
  }
  expect(offset).toBe(buffer.length)
  expect(chunks.at(-1)?.type).toBe('IEND')
  return chunks
}

describe('packaged application icons', () => {
  test.each(sizes)('%ipx PNG is RGBA, valid, and generated from the current SVG', (size) => {
    const file = png(size)
    const chunks = pngChunks(file)
    expect(chunks[0].type).toBe('IHDR')
    expect(chunks[0].data.readUInt32BE(0)).toBe(size)
    expect(chunks[0].data.readUInt32BE(4)).toBe(size)
    expect([...chunks[0].data.subarray(8, 10)]).toEqual([8, 6])
    const texts = chunks.filter((c) => c.type === 'tEXt').map((c) => c.data.toString('latin1'))
    expect(texts).toContain(`SourceSHA256\0${hash}`)
    expect(texts.some((t) => t.includes('Original JAgent artwork'))).toBe(true)
    const pixelsOnly = Buffer.concat([
      file.subarray(0, 8),
      ...chunks.filter((c) => c.type !== 'tEXt').map((c) => c.raw),
    ])
    const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
    expect(pixelsOnly.equals(rendered)).toBe(true)
  })

  test('artwork retains transparency, graphite tile, prompt, and both parts of j', () => {
    const rendered = new Resvg(svg).render()
    const pixels = rendered.pixels
    const at = (x: number, y: number) => [
      ...pixels.subarray((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 4),
    ]
    expect(at(0, 0)).toEqual([0, 0, 0, 0])
    expect(at(512, 150)).toEqual([50, 57, 69, 255])
    expect(at(304, 378)).toEqual([237, 242, 247, 255])
    expect(at(692, 432)).toEqual([97, 175, 239, 255])
    expect(at(692, 316)).toEqual([97, 175, 239, 255])
  })

  test('ICO contains seven correctly indexed 32-bit PNG frames', () => {
    const ico = readFileSync(join(root, 'app.ico'))
    const expected = sizes.filter((s) => s <= 256)
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(expected.length)
    let offset = 6 + expected.length * 16
    expected.forEach((size, index) => {
      const entry = 6 + index * 16
      expect(ico[entry] || 256).toBe(size)
      expect(ico[entry + 1] || 256).toBe(size)
      expect(ico.readUInt16LE(entry + 2)).toBe(0)
      expect(ico.readUInt16LE(entry + 4)).toBe(1)
      expect(ico.readUInt16LE(entry + 6)).toBe(32)
      expect(ico.readUInt32LE(entry + 12)).toBe(offset)
      const length = ico.readUInt32LE(entry + 8)
      expect(ico.subarray(offset, offset + length).equals(png(size))).toBe(true)
      offset += length
    })
    expect(offset).toBe(ico.length)
  })

  test('ICNS includes macOS standard and Retina representations', () => {
    const icns = readFileSync(join(root, 'app.icns'))
    expect(icns.toString('ascii', 0, 4)).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    const expected = new Map([
      ['icp4', 16],
      ['icp5', 32],
      ['ic07', 128],
      ['ic08', 256],
      ['ic09', 512],
      ['ic10', 1024],
      ['ic11', 32],
      ['ic12', 64],
      ['ic13', 256],
      ['ic14', 512],
    ])
    let offset = 8
    while (offset < icns.length) {
      const type = icns.toString('ascii', offset, offset + 4)
      const size = expected.get(type)
      expect(size).toBeDefined()
      const length = icns.readUInt32BE(offset + 4)
      expect(length).toBeGreaterThan(8)
      expect(icns.subarray(offset + 8, offset + length).equals(png(size!))).toBe(true)
      expected.delete(type)
      offset += length
    }
    expect(offset).toBe(icns.length)
    expect(expected.size).toBe(0)
  })
})
