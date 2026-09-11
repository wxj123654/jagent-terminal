/**
 * errors/crashReport.test.ts — crash 残留解析（方案 C JS 面）。
 *
 * 真崩溃链路（进程死、sidecar dump）由手动冒烟/e2e 负责；这里覆盖
 * crash.json 解析/容错/删除与 sidecar 判定（路径注入临时目录）。
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync as readdirSyncSync, utimesSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join as joinPath } from 'node:path'
import { join } from 'node:path'

import {
  crashSocketName,
  pruneStaleCrashIpc,
  CRASH_HANDLER_FLAG,
  dismissLastCrash,
  enterCrashSidecarIfRequested,
  isCrashSidecar,
  readLastCrash,
  setupCrashReportingForApp,
  sidecarReadyPath,
  sidecarSpawnArgs,
  waitForSidecar,
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

  // 绝对路径是硬要求：GUI（LaunchServices）启动的 app CWD 是只读的「/」，
  // 相对路径的 UDS bind 会 EROFS(errno 30) → sidecar 秒退、崩溃报告静默降级。
  test('crashSocketName：绝对路径（相对路径在 GUI 进程里 bind 失败）', () => {
    const name = crashSocketName(4242)
    expect(isAbsolute(name)).toBe(true)
    expect(name.endsWith(joinPath('crashes', 'crash-4242.sock'))).toBe(true)
  })

  test('pruneStaleCrashIpc：只清 24h 前的 socket/标记，保留与本次无关的文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jagent-prune-'))
    const oldSocket = join(dir, 'crash-1.sock')
    const freshReady = join(dir, 'sidecar-2.ready')
    const unrelated = join(dir, 'keep.json')
    await writeFile(oldSocket, '', 'utf8')
    await writeFile(freshReady, '', 'utf8')
    await writeFile(unrelated, '', 'utf8')
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(oldSocket, past, past)

    const removed = pruneStaleCrashIpc(dir)
    expect(removed).toBe(1)
    expect(readdirSyncSync(dir).sort()).toEqual(['keep.json', 'sidecar-2.ready'])
  })

  test('sidecarSpawnArgs：dev 指向独立 crash-handler.ts', () => {
    const { cmd, args } = sidecarSpawnArgs()
    expect(cmd).toBe(process.execPath)
    // 平台无关：Windows path.join 产反斜杠，统一归一后再比对尾段
    expect(args.some((a) => a.replaceAll('\\', '/').endsWith('scripts/crash-handler.ts'))).toBe(
      true,
    )
    expect(args).not.toContain(CRASH_HANDLER_FLAG)
  })

  // 发布形态回归（2026-09-11）：bun compile 只有一个 entry，sidecar 与主进程
  // 共用 main.tsx。runCrashSidecar 非阻塞，若入口不收敛，每个 sidecar 都会
  // 装配 UI（各自开窗）并再 spawn 子 sidecar —— 实机数秒 21+ 窗口。
  test('enterCrashSidecarIfRequested：主进程返回 false，sidecar 返回 true 且跑监控', () => {
    const prev = process.env.JAGENT_CRASH_SIDECAR
    const calls: number[] = []
    const spy = () => {
      calls.push(1)
    }
    try {
      delete process.env.JAGENT_CRASH_SIDECAR
      expect(enterCrashSidecarIfRequested(spy)).toBe(false)
      expect(calls.length).toBe(0)

      process.env.JAGENT_CRASH_SIDECAR = '1'
      expect(enterCrashSidecarIfRequested(spy)).toBe(true)
      expect(calls.length).toBe(1)
    } finally {
      if (prev === undefined) delete process.env.JAGENT_CRASH_SIDECAR
      else process.env.JAGENT_CRASH_SIDECAR = prev
    }
  })

  test('setupCrashReportingForApp：sidecar 进程绝不 spawn 子 sidecar（进程树爆炸防护）', async () => {
    const prev = process.env.JAGENT_CRASH_SIDECAR
    let spawned = 0
    const fakeSpawn = (() => {
      spawned += 1
      throw new Error('sidecar 不得再 spawn 子进程')
    }) as unknown as typeof import('node:child_process').spawn
    try {
      process.env.JAGENT_CRASH_SIDECAR = '1'
      const r = await setupCrashReportingForApp('0.1.0', { spawn: fakeSpawn })
      expect(r).toBeNull()
      expect(spawned).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.JAGENT_CRASH_SIDECAR
      else process.env.JAGENT_CRASH_SIDECAR = prev
    }
  })

  // 就绪握手（2026-09-11）：handshake 之前是 macOS 固定 sleep 猜就绪，
  // .app 冷启动（Gatekeeper + 80MB 单文件加载）会误判降级并把 sidecar 掐掉。
  test('waitForSidecar：标记文件出现即就绪，缺失则超时 false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jagent-ready-'))
    const readyFile = join(dir, 'sidecar-1.ready')
    expect(await waitForSidecar(readyFile, 120)).toBe(false)
    await writeFile(readyFile, '', 'utf8')
    expect(await waitForSidecar(readyFile, 120)).toBe(true)
  })

  test('sidecarReadyPath：崩溃目录下按 pid 命名', () => {
    expect(sidecarReadyPath(4242).endsWith('sidecar-4242.ready')).toBe(true)
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
