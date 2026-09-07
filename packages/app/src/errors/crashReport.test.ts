/**
 * errors/crashReport.test.ts — crash 残留解析（方案 C JS 面）。
 *
 * 真崩溃链路（进程死、sidecar dump）由手动冒烟/e2e 负责；这里覆盖
 * crash.json 解析/容错/删除与 sidecar 判定（路径注入临时目录）。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  crashSocketName,
  CRASH_HANDLER_FLAG,
  dismissLastCrash,
  isCrashSidecar,
  readLastCrash,
  sidecarSpawnArgs,
} from './crashReport'

async function tmpJson(doc: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jagent-crash-'))
  const p = join(dir, 'crash.json')
  await writeFile(p, JSON.stringify(doc), 'utf8')
  return p
}

const FAKE = {
  schema: 'jagent.crash.v1',
  kind: 'panic',
  message: 'index out of bounds',
  location: 'src/pty.rs:88:21',
  thread: 'main',
  dumpPath: '/tmp/x.dmp',
  appVersion: '0.1.0',
  at: 1770000000000,
}

describe('crashReport', () => {
  test('isCrashSidecar 按环境变量判定', () => {
    const prev = process.env.JAGENT_CRASH_SIDECAR
    delete process.env.JAGENT_CRASH_SIDECAR
    expect(isCrashSidecar()).toBe(false)
    process.env.JAGENT_CRASH_SIDECAR = '1'
    expect(isCrashSidecar()).toBe(true)
    if (prev === undefined) delete process.env.JAGENT_CRASH_SIDECAR
    else process.env.JAGENT_CRASH_SIDECAR = prev
  })

  test('crashSocketName：macOS 无斜杠（mach port 合法名）', () => {
    const name = crashSocketName(4242)
    if (process.platform === 'darwin') {
      expect(name).toBe('jagent.crash.4242')
      expect(name.includes('/')).toBe(false)
    } else {
      expect(name.endsWith('crash-4242.sock')).toBe(true)
    }
  })

  test('sidecarSpawnArgs：dev 指向独立 crash-handler.ts', () => {
    const { cmd, args } = sidecarSpawnArgs()
    expect(cmd).toBe(process.execPath)
    expect(args.some((a) => a.endsWith('scripts/crash-handler.ts'))).toBe(true)
    expect(args).not.toContain(CRASH_HANDLER_FLAG)
  })

  test('readLastCrash：合法 panic 档全字段解析', async () => {
    const r = readLastCrash(await tmpJson(FAKE))
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('panic')
    expect(r!.message).toBe('index out of bounds')
    expect(r!.location).toBe('src/pty.rs:88:21')
    expect(r!.dumpPath).toBe('/tmp/x.dmp')
    expect(r!.at).toBe(1770000000000)
  })

  test('readLastCrash：signal 档与缺省字段容错', async () => {
    const r = readLastCrash(await tmpJson({ schema: 'jagent.crash.v1', kind: 'signal' }))
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('signal')
    expect(r!.message).toBe('')
    expect(r!.location).toBeUndefined()
  })

  test('readLastCrash：坏 schema/坏 JSON → null', async () => {
    expect(readLastCrash(await tmpJson({ schema: 'other.v9' }))).toBeNull()
    const dir = await mkdtemp(join(tmpdir(), 'jagent-crash-'))
    const p = join(dir, 'crash.json')
    await writeFile(p, '{broken json', 'utf8')
    expect(readLastCrash(p)).toBeNull()
  })

  test('readLastCrash：不存在的路径 → null', () => {
    expect(readLastCrash(join(tmpdir(), `nope-${Date.now()}.json`))).toBeNull()
  })

  test('dismissLastCrash：删除后读不到，重复调用不抛', async () => {
    const p = await tmpJson(FAKE)
    expect(readLastCrash(p)).not.toBeNull()
    dismissLastCrash(p)
    expect(readLastCrash(p)).toBeNull()
    expect(() => dismissLastCrash(p)).not.toThrow()
  })
})
