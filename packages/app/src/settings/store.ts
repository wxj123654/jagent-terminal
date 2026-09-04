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

import { createStore } from 'zustand/vanilla'
import { produce } from 'immer'
import { dequal } from 'dequal'

import { DEFAULTS, RawSettingsSchema, SettingsSchema, type Settings, type SettingsPath } from './schema'
import type { FileAdapter } from './file'

export type SettingsWriteError = { path: string; message: string }

export interface SettingsStore {
  /** 快照（zod parse 后的合法 Settings；字段级容错已在边界完成） */
  get(): Settings
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
}

/** 深取值（dot-path；不存在返回 undefined） */
export function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, k) => (acc == null ? undefined : (acc as Record<string, unknown>)[k]),
    obj,
  )
}

function serialize(s: Settings): string {
  return `${JSON.stringify(s, null, 2)}\n`
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
        await file.write(serialize(snapshot))
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

  return {
    get: () => store.getState().settings,
    subscribe: (fn) => store.subscribe(fn),

    async init() {
      const raw = await file.read()
      if (raw == null) return // 首次运行：内存默认即可，首次 patch 自然落盘
      let parsed: Settings
      try {
        parsed = SettingsSchema.parse(JSON.parse(raw))
      } catch {
        parsed = DEFAULTS // JSON.parse 炸（坏 JSON）→ 整体默认
      }
      persisted = parsed
      set({ settings: parsed })
    },

    patch(path, value) {
      const next = RawSettingsSchema.parse(
        produce(store.getState().settings, (draft) => {
          const keys = path.split('.')
          let cur: Record<string, unknown> = draft as unknown as Record<string, unknown>
          for (let i = 0; i < keys.length - 1; i++) {
            cur = cur[keys[i]!] as Record<string, unknown>
          }
          cur[keys[keys.length - 1]!] = value
        }),
      )
      set({ settings: next, writeError: null })
      enqueueWrite(next, path)
    },

    reset(path) {
      this.patch(path, getByPath(DEFAULTS, path))
    },

    isModified(path) {
      return !dequal(getByPath(store.getState().settings, path), getByPath(DEFAULTS, path))
    },

    writeError: () => store.getState().writeError,
  }
}
