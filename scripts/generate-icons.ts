import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
/**
 * app.svg → 已入库的 PNG / ICO / ICNS。仅修改图标时运行 bun run icons。
 * resvg 在三平台使用同一渲染器；普通 build 不执行本脚本，不需要图像工具。
 */
import { Resvg } from '@resvg/resvg-js'
import { REPO_ROOT } from './refs-config'

const output = join(REPO_ROOT, 'packages/app/assets/icons')
const sourcePath = 'packages/app/assets/icons/app.svg'
const svg = readFileSync(join(REPO_ROOT, sourcePath))
const sourceHash = createHash('sha256').update(svg).digest('hex')
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

/** PNG tEXt：保留原创来源及源稿 hash，便于测试发现忘记重新生成的资产。 */
function textChunk(key: string, value: string) {
  const data = Buffer.from(`tEXt${key}\0${value}`, 'latin1')
  const chunk = Buffer.alloc(data.length + 8)
  chunk.writeUInt32BE(data.length - 4, 0)
  data.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(data), chunk.length - 4)
  return chunk
}

const metadata = [
  textChunk('Description', `Original JAgent artwork; source: ${sourcePath}; renderer: resvg.`),
  textChunk('SourceSHA256', sourceHash),
]
mkdirSync(output, { recursive: true })
const images = new Map<number, Buffer>()
for (const size of sizes) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
  // IEND 固定占最后 12 bytes；在它之前写入文本元数据，不重压缩像素。
  const image = Buffer.concat([png.subarray(0, -12), ...metadata, png.subarray(-12)])
  images.set(size, image)
  writeFileSync(join(output, `app-${size}.png`), image)
}

// ICO：PNG 编码的 32-bit RGBA 帧，Windows Vista+ 支持（项目最低 Windows 10）。
const icoSizes = sizes.filter((size) => size <= 256)
const directory = Buffer.alloc(6 + 16 * icoSizes.length)
directory.writeUInt16LE(1, 2)
directory.writeUInt16LE(icoSizes.length, 4)
let offset = directory.length
const icoImages = icoSizes.map((size, index) => {
  const png = images.get(size)!
  const entry = 6 + index * 16
  directory[entry] = size === 256 ? 0 : size
  directory[entry + 1] = size === 256 ? 0 : size
  directory.writeUInt16LE(1, entry + 4)
  directory.writeUInt16LE(32, entry + 6)
  directory.writeUInt32LE(png.length, entry + 8)
  directory.writeUInt32LE(offset, entry + 12)
  offset += png.length
  return png
})
writeFileSync(join(output, 'app.ico'), Buffer.concat([directory, ...icoImages]))

// ICNS：PNG chunk 容器。显式包括 1× / 2× 类型；无需 macOS iconutil。
const types: [string, number][] = [
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
]
const chunks = types.map(([type, size]) => {
  const png = images.get(size)!
  const header = Buffer.alloc(8)
  header.write(type, 0, 'ascii')
  header.writeUInt32BE(png.length + 8, 4)
  return Buffer.concat([header, png])
})
const header = Buffer.alloc(8)
header.write('icns', 0, 'ascii')
header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
writeFileSync(join(output, 'app.icns'), Buffer.concat([header, ...chunks]))
console.log(`✓ ${output}: PNG (${sizes.join(', ')}) + ICO + ICNS`)
