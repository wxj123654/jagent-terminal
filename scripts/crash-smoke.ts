/**
 * scripts/crash-smoke.ts — 崩溃报告链路端到端冒烟（方案 C 验收）。
 *
 * 独立子进程跑 crash-client-smoke.ts（setupCrashReporting + 触发真崩溃），
 * 父进程等待退出 → 验证 ~/.j-agent/crashes/ 出现 crash.json + .dmp +
 * 内容字段。用法：bun scripts/crash-smoke.ts [panic|sigsegv]。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const kind = process.argv[2] ?? 'panic'
const CRASH_DIR = join(homedir(), '.j-agent', 'crashes')
const CLIENT = join(import.meta.dir, 'crash-client-smoke.ts')

mkdirSync(CRASH_DIR, { recursive: true })
rmSync(join(CRASH_DIR, 'crash.json'), { force: true })
for (const f of readdirSync(CRASH_DIR).filter((x) => x.endsWith('.dmp'))) {
  rmSync(join(CRASH_DIR, f))
}

console.log(`── crash smoke [${kind}]：启动子进程（真崩溃）`)
const child = spawn(process.execPath, [CLIENT, kind], { stdio: ['pipe', 'inherit', 'inherit'] })
const code = await new Promise<number>((resolve) => {
  child.on('exit', (c) => resolve(c ?? -1))
  setTimeout(() => resolve(-2), 30000)
})

console.log(`── 子进程退出码：${code}（预期非零/被信号杀）`)

// 等侧车写盘（dump 可能比主进程退出慢几秒）
let crashJson: unknown = null
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250))
  if (existsSync(join(CRASH_DIR, 'crash.json'))) {
    try {
      crashJson = JSON.parse(readFileSync(join(CRASH_DIR, 'crash.json'), 'utf8'))
      break
    } catch {
      /* 写一半，再等 */
    }
  }
}

const dumps = readdirSync(CRASH_DIR).filter((x) => x.endsWith('.dmp'))
let ok = true
const fail = (msg: string) => {
  ok = false
  console.error(`  ✗ ${msg}`)
}

if (!crashJson) fail('crash.json 未生成（sidecar 未写盘或 10s 超时）')
else {
  const doc = crashJson as Record<string, unknown>
  if (doc.schema !== 'jagent.crash.v1') fail(`schema 错误：${doc.schema}`)
  if (kind === 'panic') {
    if (doc.kind !== 'panic') fail(`kind 应为 panic：${doc.kind}`)
    if (!String(doc.message ?? '').includes('crash-reporting verification'))
      fail(`message 应含验证串：${doc.message}`)
  }
  if (!doc.dumpPath) fail('dumpPath 缺失')
  if (!doc.sessionId) fail('sessionId 缺失（HELLO 未送达）')
  if (doc.pid !== child.pid) fail(`pid 不符：${doc.pid} != ${child.pid}`)
  console.log('  crash.json:', JSON.stringify(doc, null, 2).slice(0, 600))
}
if (dumps.length === 0) fail('.dmp 未生成')
else console.log(`  dumps: ${dumps.join(', ')}`)

console.log(ok ? `✓ 崩溃链路冒烟通过 [${kind}]` : '✗ 冒烟失败')
process.exit(ok ? 0 : 1)
