/**
 * scripts/crash-client-smoke.ts — 冒烟用的「会崩的主进程」。
 * 用 app 同款装配（crashReport.ts：spawn sidecar + setup）→ 触发真崩溃。
 * 此进程必死。参数：panic | sigsegv
 */

import { debugTriggerCrash, installNativePanicHook } from '../packages/native/index.js'

import { setupCrashReportingForApp } from '../packages/app/src/errors/crashReport'

const kind = process.argv[2] ?? 'panic'

// 与 main.tsx 同序：先 hook（接管 abort），再 sidecar + crash-handler。
installNativePanicHook(null)
const last = await setupCrashReportingForApp('smoke')
console.log(`client: crash reporting armed (last=${last ? '有残留' : '无'})`)
await new Promise((r) => setTimeout(r, 400))
console.log(`client: 触发崩溃 [${kind}]`)
debugTriggerCrash(kind)
console.error('client: 崩溃未触发！')
process.exit(4)
