/**
 * threads/nativeDeps.ts — ThreadDeps 的真 native 装配工厂。
 *
 * main.tsx（真窗口）与 e2e（TestGpuixRenderer）共用的装配层——布线只写
 * 一遍，差异项（notify / closeOnExit / presetOf）经参数覆盖。native 导入
 * 收口点之一（architecture.md §1.2，修订见文档）。
 *
 * napi 命令是同步的（test 路径需本线程 VisualTestState；见 native/lib.rs），
 * seam 接口保持 Promise 形态——spawn 在真窗口模式下会短暂阻塞帧循环
 * （ConPTY 冷启动 ~1s，用户显式操作，可接受）。
 */

import { createTerminalSession, destroyTerminalSession } from '@jagent/native'

import { navigateTarget, currentActiveThreadId } from '../router'
import { builtinPresetOf } from './presets'
import type { ThreadDeps } from './store'

/** 可覆盖项：装配层差异点（Phase 2 的 notify/closeOnExit 接真值处） */
export type NativeDepsOverrides = Partial<Pick<ThreadDeps, 'notify' | 'closeOnExit' | 'presetOf'>>

export function createNativeThreadDeps(overrides: NativeDepsOverrides = {}): ThreadDeps {
  return {
    spawnSession: async (o) => createTerminalSession(o),
    destroySession: async (id) => destroyTerminalSession(id),
    navigate: navigateTarget,
    activeThreadId: currentActiveThreadId,
    presetOf: builtinPresetOf,
    // Phase 2（T2.5 桌面通知定型）前：BEL 通知只落 console
    notify: (t) => console.log(`[notify] bell: t${t.sessionId}`),
    // Phase 2 前默认不关（settings 终端区接线后读真值）
    closeOnExit: () => false,
    ...overrides,
  }
}
