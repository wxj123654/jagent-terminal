/**
 * threads/nativeDeps.ts — ThreadDeps 的真 native 装配工厂。
 *
 * main.tsx（真窗口）与 e2e（TestGpuixRenderer）共用的装配层——布线只写
 * 一遍，差异项（notify / closeOnExit / presetOf）经参数覆盖。native 导入
 * 收口点之一（architecture.md §1.2，修订见文档）。
 *
 * T2.5 接线：notify 读 settings.notifications（desktop/sound）→ WinRT toast；
 * closeOnExit 读 settings.terminal.closeOnExit；spawnSession 补
 * scrollbackLines 兜底（契约 §3.2：scrollback 是全局设置，随 spawn 参数
 * 下发——alacritty Term 构造后不可变）。
 *
 * napi 命令是同步的（test 路径需本线程 VisualTestState；见 native/lib.rs），
 * seam 接口保持 Promise 形态——spawn 在真窗口模式下会短暂阻塞帧循环
 * （ConPTY 冷启动 ~1s，用户显式操作，可接受）。
 */

import { createTerminalSession, destroyTerminalSession, notifyDesktop } from '@jagent/native'

import { navigateTarget, currentActiveThreadId } from '../router'
import type { SettingsStore } from '../settings/store'
import { createEchoAgent } from './chat'
import type { ThreadDeps } from './store'
import { displayTitle } from './terminal'

/** 可覆盖项：装配层差异点（e2e：notify 静默、注入测试预设、chatAgent 零延迟） */
export type NativeDepsOverrides = Partial<
  Pick<ThreadDeps, 'notify' | 'closeOnExit' | 'presetOf' | 'chatAgent'>
>

export function createNativeThreadDeps(
  settings: SettingsStore,
  overrides: NativeDepsOverrides = {},
): ThreadDeps {
  return {
    spawnSession: async (o) =>
      createTerminalSession({
        ...o,
        scrollbackLines: o.scrollbackLines ?? settings.get().terminal.scrollbackLines,
      }),
    destroySession: async (id) => destroyTerminalSession(id),
    navigate: navigateTarget,
    activeThreadId: currentActiveThreadId,
    presetOf: (id) => settings.get().presets.items.find((p) => p.id === id),
    // bell → 非激活 thread → 桌面 toast（WinRT；Rust 侧 AUMID 注册幂等）。
    // sound 依赖 desktop（settings-ui.md §6）；失败在 Rust 侧静默 warn。
    notify: (t) => {
      const n = settings.get().notifications
      if (!n.desktop) return
      notifyDesktop(`j-agent · ${displayTitle(t)}`, '终端铃（BEL）', n.sound)
    },
    closeOnExit: () => settings.get().terminal.closeOnExit,
    // chat 后端 seam（T3.2）：默认 EchoAgent 本地模拟——ACP/LLM 接入时换 adapter
    chatAgent: createEchoAgent(),
    ...overrides,
  }
}
