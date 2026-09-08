import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './refs-config'
import { inspectPatchSuite, inspectRefs, normalizePatchText, type PatchSuite } from './refs-state'

let dir: string
let options: Parameters<typeof inspectRefs>[0]

async function initialize(path: string) {
  await mkdir(path, { recursive: true })
  await git(['init', '-q'], { cwd: path })
  await git(['config', 'user.email', 'fixture@example.invalid'], { cwd: path })
  await git(['config', 'user.name', 'Patch fixture'], { cwd: path })
  await git(['config', 'commit.gpgsign', 'false'], { cwd: path })
  await writeFile(join(path, 'managed.txt'), 'base\n')
  await writeFile(join(path, 'legacy.txt'), 'upstream\n')
  await writeFile(join(path, '.gitignore'), 'dist/\n')
  await git(['add', 'managed.txt', 'legacy.txt', '.gitignore'], { cwd: path })
  await git(['commit', '-qm', 'base'], { cwd: path })
}

async function patch(gitDir: string, patchDir: string): Promise<PatchSuite> {
  await mkdir(patchDir)
  await writeFile(join(gitDir, 'managed.txt'), 'patched\n')
  const { out } = await git(['diff', '--', 'managed.txt'], { cwd: gitDir })
  await writeFile(join(patchDir, '0001.patch'), out)
  return { gitDir, patchDir, manifest: { '0001.patch': ['managed.txt'] } }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jagent-refs-state-'))
  const gpuix = join(dir, 'gpuix')
  const zed = join(gpuix, 'zed')
  await initialize(gpuix)
  await initialize(zed)
  const { out: zedPin } = await git(['rev-parse', 'HEAD'], { cwd: zed })
  await git(['update-index', '--add', '--cacheinfo', `160000,${zedPin.trim()},zed`], { cwd: gpuix })
  await git(['commit', '-qm', 'pin zed'], { cwd: gpuix })
  const { out: pin } = await git(['rev-parse', 'HEAD'], { cwd: gpuix })
  await mkdir(join(gpuix, 'dist'))
  await writeFile(join(gpuix, 'dist/index.js'), 'built\n')
  options = {
    pin: pin.trim(),
    gpuix: await patch(gpuix, join(dir, 'gpuix-patches')),
    zed: await patch(zed, join(dir, 'zed-patches')),
    requiredFiles: ['dist/index.js'],
  }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const inspect = async () => (await inspectRefs(options)).join('\n')

describe('refs-state', () => {
  test('accepts both pinned repositories with exact patches and build output', async () => {
    expect(await inspectRefs(options)).toEqual([])
  })

  test('treats CRLF-normalized patch files as matching LF git diffs', async () => {
    const patchPath = join(options.gpuix.patchDir, '0001.patch')
    const lf = await Bun.file(patchPath).text()
    await writeFile(patchPath, lf.replace(/\n/g, '\r\n'))
    expect(normalizePatchText(await Bun.file(patchPath).text())).toBe(normalizePatchText(lf))
    expect(await inspectRefs(options)).toEqual([])
  })

  test('rejects a missing applied hunk even when other files are dirty', async () => {
    await writeFile(join(options.zed.gitDir, 'managed.txt'), 'base\n')
    expect(await inspect()).toContain('gpuix-zed: patch drift: 0001.patch')
  })

  test('rejects additional edits to a managed source file', async () => {
    await writeFile(join(options.gpuix.gitDir, 'managed.txt'), 'patched\nuser edit\n')
    expect(await inspect()).toContain('gpuix: patch drift')
  })

  test('rejects removed-patch residue and untracked files (including spaces)', async () => {
    await writeFile(join(options.gpuix.gitDir, 'legacy.txt'), 'old patch\n')
    await writeFile(join(options.gpuix.gitDir, 'extra source.txt'), 'user edit\n')
    const problems = await inspect()
    expect(problems).toContain('unmanaged change: legacy.txt')
    expect(problems).toContain('unmanaged change: extra source.txt')
  })

  test('rejects staged content even if its working tree is restored to the patch', async () => {
    const { gitDir } = options.gpuix
    await writeFile(join(gitDir, 'managed.txt'), 'staged edit\n')
    await git(['add', 'managed.txt'], { cwd: gitDir })
    await writeFile(join(gitDir, 'managed.txt'), 'patched\n')
    expect(await inspect()).toContain('staged changes: managed.txt')
    expect((await inspectPatchSuite(options.gpuix, false)).problems.join('\n')).toContain('staged')
  })

  test('rejects a wrong zed commit independently of patch contents', async () => {
    await git(['commit', '--allow-empty', '-qm', 'different pin'], { cwd: options.zed.gitDir })
    expect(await inspect()).toContain('zed pin mismatch')
  })

  test('rejects a wrong gpuix commit', async () => {
    await git(['commit', '--allow-empty', '-qm', 'different pin'], { cwd: options.gpuix.gitDir })
    expect(await inspect()).toContain('gpuix pin mismatch')
  })

  test('rejects a missing build output', async () => {
    await unlink(join(options.gpuix.gitDir, 'dist/index.js'))
    expect(await inspect()).toContain('missing build output: dist/index.js')
  })

  test('rejects a patch file absent from the manifest or missing from disk', async () => {
    await writeFile(join(options.gpuix.patchDir, '0003-old.patch'), 'old patch')
    await unlink(join(options.zed.patchDir, '0001.patch'))
    const problems = await inspect()
    expect(problems).toContain('unmanaged patch: 0003-old.patch')
    expect(problems).toContain('missing patch: 0001.patch')
  })

  test('export mode permits a new managed diff, but never unmanaged edits', async () => {
    await writeFile(join(options.gpuix.gitDir, 'managed.txt'), 'new patch\n')
    const state = await inspectPatchSuite(options.gpuix, false)
    expect(state.problems).toEqual([])
    expect(state.diffs['0001.patch']).toContain('+new patch')
    await writeFile(join(options.gpuix.gitDir, 'legacy.txt'), 'unmanaged\n')
    expect((await inspectPatchSuite(options.gpuix, false)).problems).toContain(
      'unmanaged change: legacy.txt',
    )
  })
})
