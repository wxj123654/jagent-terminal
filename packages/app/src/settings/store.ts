/**
 * settings/store.ts — SettingsStore（architecture.md §6.2）。
 *
 * 底座 zustand/vanilla + immer + zod（与 threads/store.ts 同纪律）。
 * 写失败时序（settings-ui.md §5.3）：patch → 内存更新 + notify → 写盘
 * reject → 回滚内存（到最后确认落盘的快照 persisted）+ 置 writeError +
 * notify；下次成功清除。连续 patch 由 gen 计数合并写（后写快照为全量，
 * 旧写直接跳过，天然省 IO 且无乱序）。
 *
 * 运行时态（lastUsedPreset / hasBell 等）物理上不出现在本目录任何文件。
 */

import { dequal } from 'dequal'
import { produce } from 'immer'
import { createStore } from 'zustand/vanilla'

import { BUILTIN_PRESETS, type TerminalPreset } from '../threads/presets'
import type { FileAdapter } from './file'
import type { AcpAgent } from './schema'
import {
  DEFAULTS,
  migrateLegacySettings,
  RawSettingsSchema,
  SettingsSchema,
  type Settings,
  type SettingsPath,
} from './schema'

export type SettingsWriteError = { path: string; message: string }

/** 新预设输入（id 由 store 生成保证唯一；builtin 恒 false） */
export type PresetInput = Pick<TerminalPreset, 'label'> &
  Partial<Pick<TerminalPreset, 'program' | 'args' | 'env' | 'initCommand' | 'cwd'>>
/** 预设字段补丁（id / builtin 不可改——类型面即规则） */
export type PresetPatch = Partial<Omit<TerminalPreset, 'id' | 'builtin'>>
/** 新 ACP agent 输入（id 由 store 生成；无 builtin 概念——默认 2 项也只是示例） */
export type AcpAgentInput = Pick<AcpAgent, 'label'> & Partial<Pick<AcpAgent, 'command' | 'args'>>
/** ACP agent 字段补丁（id 不可改） */
export type AcpAgentPatch = Partial<Omit<AcpAgent, 'id'>>

export interface SettingsStore {
  /** 快照（zod parse 后的合法 Settings；字段级容错已在边界完成） */
  get(): Settings
  /** 真盘路径（fsAdapter 携带；「在编辑器中打开」用）。memory adapter 无路径 */
  filePath(): string | null
  /** 内存即时 + 异步原子写盘（越界值经 zod 字段级回默认） */
  patch(path: SettingsPath, value: unknown): void
  /** = patch(path, DEFAULTS 值) */
  reset(path: SettingsPath): void
  /** !dequal(cur, DEFAULTS) → 蓝点 */
  isModified(path: SettingsPath): boolean
  subscribe(fn: () => void): () => void
  /** 行内红条；下次写成功清除 */
  writeError(): SettingsWriteError | null
  /** 装配期：读盘 + parse + 首帧 set（main.tsx await 后再渲染） */
  init(): Promise<void>
  // ── 预设 CRUD（settings-ui.md §7 规则单点；走同一写链 / 回滚面）──
  /** 新增自定义预设（builtin:false），返回生成的唯一 id */
  addPreset(input: PresetInput): string
  /** 按 id 改字段（未知 id no-op；空字段归一 undefined） */
  updatePreset(id: string, patch: PresetPatch): void
  /** 删除自定义预设（内置 no-op）；plusDefault 指向它 → 回退 null */
  deletePreset(id: string): void
  /** 复制为自定义副本（builtin:false + label 副本后缀），返回新 id */
  duplicatePreset(id: string): string
  /** 内置预设重置回出厂值（自定义 no-op） */
  resetPreset(id: string): void
  // ── ACP agent CRUD（T3+.1；同写链/回滚面；无 builtin/modified 概念）──
  /** 新增 agent（默认 2 项也只是可删改的示例），返回生成的唯一 id */
  addAcpAgent(input: AcpAgentInput): string
  /** 按 id 改字段（未知 id no-op；args 空串行过滤） */
  updateAcpAgent(id: string, patch: AcpAgentPatch): void
  deleteAcpAgent(id: string): void
}

/** 深取值（dot-path；不存在返回 undefined） */
export function getByPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]),
      obj,
    )
}

/** 序列化形态（写盘与 Advanced JSON 实时视图同源） */
export function serializeSettings(s: Settings): string {
  return `${JSON.stringify(s, null, 2)}\n`
}

// ── 预设 CRUD 内部辅助（规则单点；不进接口）────────────────────────

/** 空串 / 空集合字段归一 undefined；args 顺带过滤空串行（编辑中间态的空行
 *  不进 JSON——LinesField 即时提交原始行，归一在此单点完成）。 */
function normalizePreset(p: TerminalPreset): TerminalPreset {
  const args = p.args?.filter((s) => s !== '')
  return {
    ...p,
    program: p.program || undefined,
    args: args && args.length > 0 ? args : undefined,
    env: p.env && Object.keys(p.env).length > 0 ? p.env : undefined,
    initCommand: p.initCommand || undefined,
    cwd: p.cwd || undefined,
  }
}

/** 递增后缀保证 id 唯一（原型语义：base → base2 → base3 …） */
function uniqueId(base: string, items: { id: string }[]): string {
  let id = base
  let n = 2
  while (items.some((p) => p.id === id)) {
    id = `${base}${n}`
    n++
  }
  return id
}

/** ACP agent 归一：args 空串行过滤（编辑中间态空行不进 JSON）；command 空串保留
 *  （保存后 spawn 会在首条消息时报错行——可见可修，不阻断编辑） */
function normalizeAcpAgent(a: AcpAgent): AcpAgent {
  const args = a.args.filter((s) => s !== '')
  return { ...a, args }
}

export function createSettingsStore(file: FileAdapter): SettingsStore {
  const store = createStore<{ settings: Settings; writeError: SettingsWriteError | null }>(() => ({
    settings: DEFAULTS,
    writeError: null,
  }))
  const set = (patch: Partial<{ settings: Settings; writeError: SettingsWriteError | null }>) =>
    store.setState(patch)

  /** 最后确认落盘成功的快照（写失败回滚锚点；盘与内存的一致真值） */
  let persisted: Settings = DEFAULTS
  let writeChain: Promise<void> = Promise.resolve()
  let gen = 0

  function enqueueWrite(snapshot: Settings, path: string) {
    const myGen = ++gen
    writeChain = writeChain
      .then(async () => {
        // myGen 落后 = 已有更新全量快照排队（合并写）——跳过本次
        if (myGen !== gen) return
        await file.write(serializeSettings(snapshot))
        persisted = snapshot
        // 仅在确有错误时清除（避免每次成功写的无效 notify）
        if (store.getState().writeError) set({ writeError: null })
      })
      .catch((err: unknown) => {
        // 迟到的失败（快照已被作废）忽略
        if (myGen !== gen) return
        // 作废一切在途/排队写：内存即将回滚到 persisted，落盘超前无意义
        gen++
        const message = err instanceof Error ? err.message : String(err)
        set({ settings: persisted, writeError: { path, message } })
      })
  }

  /** 统一提交面：parse 容错 → 内存即时 → 异步写链（patch 与 CRUD 共用） */
  function commit(next: Settings, path: string) {
    const parsed = RawSettingsSchema.parse(next)
    set({ settings: parsed, writeError: null })
    enqueueWrite(parsed, path)
  }

  /** 替换 presets.items（+ 可选 plusDefault 联动）后提交 */
  function withItems(
    s: Settings,
    items: TerminalPreset[],
    plusDefault: string | null = s.presets.plusDefault,
  ) {
    commit({ ...s, presets: { ...s.presets, items, plusDefault } }, 'presets.items')
  }

  return {
    get: () => store.getState().settings,
    filePath: () => file.path ?? null,
    subscribe: (fn) => store.subscribe(fn),

    async init() {
      const raw = await file.read()
      if (raw == null) return // 首次运行：内存默认即可，首次 patch 自然落盘
      let parsed: Settings
      try {
        parsed = SettingsSchema.parse(migrateLegacySettings(JSON.parse(raw)))
      } catch {
        parsed = DEFAULTS // JSON.parse 炸（坏 JSON）→ 整体默认
      }
      persisted = parsed
      set({ settings: parsed })
    },

    patch(path, value) {
      commit(
        produce(store.getState().settings, (draft) => {
          const keys = path.split('.')
          let cur: Record<string, unknown> = draft as unknown as Record<string, unknown>
          for (let i = 0; i < keys.length - 1; i++) {
            cur = cur[keys[i]!] as Record<string, unknown>
          }
          cur[keys[keys.length - 1]!] = value
        }) as Settings,
        path,
      )
    },

    reset(path) {
      this.patch(path, getByPath(DEFAULTS, path))
    },

    isModified(path) {
      return !dequal(getByPath(store.getState().settings, path), getByPath(DEFAULTS, path))
    },

    writeError: () => store.getState().writeError,

    addPreset(input) {
      const cur = store.getState().settings
      const id = uniqueId(`custom-${Date.now().toString(36)}`, cur.presets.items)
      const preset = normalizePreset({ id, builtin: false, ...input })
      withItems(cur, [...cur.presets.items, preset])
      return id
    },

    updatePreset(id, patch) {
      const cur = store.getState().settings
      const idx = cur.presets.items.findIndex((p) => p.id === id)
      if (idx === -1) return
      const items = cur.presets.items.slice()
      items[idx] = normalizePreset({ ...items[idx]!, ...patch })
      withItems(cur, items)
    },

    deletePreset(id) {
      const cur = store.getState().settings
      const p = cur.presets.items.find((x) => x.id === id)
      if (!p || p.builtin) return
      // §7：删除前若 plusDefault 指向它 → 回退 null（跟随 lastUsedPreset）。
      // lastUsedPreset 是 ThreadStore 运行时态，settings 不碰——消费侧兜底。
      withItems(
        cur,
        cur.presets.items.filter((x) => x.id !== id),
        cur.presets.plusDefault === id ? null : cur.presets.plusDefault,
      )
    },

    duplicatePreset(id) {
      const cur = store.getState().settings
      const p = cur.presets.items.find((x) => x.id === id)
      if (!p) return ''
      const nid = uniqueId(`${id}-copy`, cur.presets.items)
      const copy = normalizePreset({ ...p, id: nid, label: `${p.label} 副本`, builtin: false })
      withItems(cur, [...cur.presets.items, copy])
      return nid
    },

    resetPreset(id) {
      const cur = store.getState().settings
      const idx = cur.presets.items.findIndex((p) => p.id === id)
      if (idx === -1 || !cur.presets.items[idx]!.builtin) return
      const factory = BUILTIN_PRESETS.find((p) => p.id === id)
      if (!factory) return
      const items = cur.presets.items.slice()
      items[idx] = factory
      withItems(cur, items)
    },

    addAcpAgent(input) {
      const cur = store.getState().settings
      const id = uniqueId(`acp-${Date.now().toString(36)}`, cur.acpAgents)
      const agent = normalizeAcpAgent({ command: '', args: [], ...input, id })
      commit({ ...cur, acpAgents: [...cur.acpAgents, agent] }, 'acpAgents')
      return id
    },

    updateAcpAgent(id, patch) {
      const cur = store.getState().settings
      const idx = cur.acpAgents.findIndex((a) => a.id === id)
      if (idx === -1) return
      const agents = cur.acpAgents.slice()
      agents[idx] = normalizeAcpAgent({ ...agents[idx]!, ...patch })
      commit({ ...cur, acpAgents: agents }, 'acpAgents')
    },

    deleteAcpAgent(id) {
      const cur = store.getState().settings
      // 存量 acp thread 持 agentId 引用：删配置不影响已建连接（store 侧情建已
      // 兜底 unknown agentId → 错误行）；新 thread 只看新列表
      commit({ ...cur, acpAgents: cur.acpAgents.filter((a) => a.id !== id) }, 'acpAgents')
    },
  }
}
