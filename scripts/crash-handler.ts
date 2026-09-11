/**
 * scripts/crash-handler.ts — 崩溃监视 sidecar 入口（方案 C，dev 形态）。
 *
 * 只做一件事：调用 `packages/app/src/errors/crashReport.ts` 的
 * runCrashSidecar。发布形态的 sidecar（`<exe> --crash-handler`）走 main.tsx
 * 的 enterCrashSidecarIfRequested()，两条路径共用同一份实现 —— 就绪标记、
 * stdin EOF 收尾、非阻塞语义都在那里，本文件不再自带副本。
 *
 * 环境：
 *   JAGENT_CRASH_SOCKET  IPC 名（macOS 为 mach-port 合法名，不含 /）
 *   JAGENT_CRASH_DIR     dump/crash.json 目录（缺省 ~/.j-agent/crashes）
 *
 * 退出：dump 完成 / 失败 / stdin EOF（主进程死）。永不开窗、永不再 spawn。
 */

import { runCrashSidecar } from '../packages/app/src/errors/crashReport'

runCrashSidecar()
