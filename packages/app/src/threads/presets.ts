/**
 * threads/presets.ts — TerminalPreset 类型 + 内置预设（agent-plane-layout.md §6 原文）。
 *
 * 类型归 threads（spawn 行为的数据中心）；Phase 2 的 settings/schema.ts
 * 持久化引用此类型与 BUILTIN_PRESETS 初始值（json 事实源在 settings）。
 */

import { dequal } from 'dequal'

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

/** 预设行命令摘要（settings-ui §7 / 原型 p-cmd）：program args… → initCommand；无 program 显示「系统默认 shell」 */
export function presetCommandSummary(p: TerminalPreset): string {
  if (!p.program) return p.initCommand ? `（shell）→ ${p.initCommand}` : '（系统默认 shell）'
  const cmd = [p.program, ...(p.args ?? [])].join(' ')
  return p.initCommand ? `${cmd}  →  ${p.initCommand}` : cmd
}

/** 搜索命中（原型 data-search 面：label / id / program / initCommand 子串） */
export function presetMatches(p: TerminalPreset, q: string): boolean {
  const lower = q.toLowerCase()
  return (
    p.label.toLowerCase().includes(lower) ||
    p.id.toLowerCase().includes(lower) ||
    (p.program?.toLowerCase().includes(lower) ?? false) ||
    (p.initCommand?.toLowerCase().includes(lower) ?? false)
  )
}

/** 内置预设被改过（modified 蓝点 / reset 钮出现条件；自定义无出厂值恒 false） */
export function presetModified(p: TerminalPreset): boolean {
  if (!p.builtin) return false
  return !dequal(p, builtinPresetOf(p.id))
}

/** 字段级 modified（编辑器字段行蓝点；自定义无出厂值恒 false） */
export function presetFieldModified(
  p: TerminalPreset,
  field: 'label' | 'program' | 'args' | 'env' | 'initCommand' | 'cwd',
): boolean {
  if (!p.builtin) return false
  const d = builtinPresetOf(p.id)
  return d ? !dequal(p[field], d[field]) : false
}
