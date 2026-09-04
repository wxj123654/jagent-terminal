/**
 * threads/presets.ts — TerminalPreset 类型 + 内置预设（agent-plane-layout.md §6 原文）。
 *
 * 类型归 threads（spawn 行为的数据中心）；Phase 2 的 settings/schema.ts
 * 持久化引用此类型与 BUILTIN_PRESETS 初始值（json 事实源在 settings）。
 */

export type TerminalPreset = {
  /** 内置固定为 claude/pi/codex/amp/shell；自定义任意唯一串 */
  id: string
  label: string
  /** 内置不可删、id 不可改；复制内置 → builtin:false */
  builtin: boolean
  /** 留空 = 系统默认 shell */
  program?: string
  args?: string[]
  env?: Record<string, string>
  /** 作为普通键入打进 shell，不是 exec */
  initCommand?: string
  /** 可选；默认项目根目录 */
  cwd?: string
}

/** 五个内置预设（布局契约 §6；E2 预设）。 */
export const BUILTIN_PRESETS: TerminalPreset[] = [
  { id: 'claude', label: 'Claude Code', builtin: true, initCommand: 'claude' },
  { id: 'pi', label: 'Pi', builtin: true, initCommand: 'pi' },
  { id: 'codex', label: 'Codex', builtin: true, initCommand: 'codex' },
  { id: 'amp', label: 'Amp', builtin: true, program: 'amp', env: { AMP_FORCE_BEL: '1' } },
  { id: 'shell', label: 'Shell', builtin: true },
]

export function builtinPresetOf(id: string): TerminalPreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.id === id)
}
