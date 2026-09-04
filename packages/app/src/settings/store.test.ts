/**
 * settings 三切片测试（architecture.md §6.3：内存 adapter，零真盘）。
 *
 * 覆盖：patch/isModified/reset · 坏 JSON / 越界值字段级回默认（zod catch）
 * · 未知 key 往返保真 · 写失败回滚 + writeError（下次成功清除）· 合并写
 * · SETTING_DEFS 的 path 全部真实存在于 Settings（schema 一致性）。
 */

import { beforeEach, describe, expect, test } from 'bun:test'

import { memoryAdapter } from './file'
import {
  DEFAULTS,
  SECTIONS,
  SETTING_DEFS,
  type Settings,
  type SettingsPath,
} from './schema'
import { createSettingsStore, getByPath } from './store'

/** 等异步写盘链走完 */
const flush = () => new Promise((r) => setTimeout(r, 0))

async function makeStore(initial: string | null = null) {
  const file = memoryAdapter(initial)
  const store = createSettingsStore(file)
  await store.init()
  return { file, store }
}

describe('patch / isModified / reset', () => {
  test('patch 即时生效 + isModified 蓝点 + reset 回默认', async () => {
    const { store, file } = await makeStore()
    expect(store.isModified('terminal.fontSize')).toBe(false)

    store.patch('terminal.fontSize', 15)
    expect(store.get().terminal.fontSize).toBe(15)
    expect(store.isModified('terminal.fontSize')).toBe(true)

    await flush()
    expect(file.writes()).toBe(1)
    const onDisk = JSON.parse(file.snapshot()!)
    expect(onDisk.terminal.fontSize).toBe(15)

    store.reset('terminal.fontSize')
    expect(store.get().terminal.fontSize).toBe(DEFAULTS.terminal.fontSize)
    expect(store.isModified('terminal.fontSize')).toBe(false)
  })

  test('patch 越界值 → zod 字段级回默认（UI 立即看到回滚）', async () => {
    const { store } = await makeStore()
    store.patch('terminal.fontSize', 99)
    expect(store.get().terminal.fontSize).toBe(13)
    store.patch('appearance.sidebarWidth', 10)
    expect(store.get().appearance.sidebarWidth).toBe(248)
  })

  test('结构性路径：presets.items / acpAgents 整体可 patch', async () => {
    const { store } = await makeStore()
    store.patch('presets.plusDefault', 'claude')
    expect(store.get().presets.plusDefault).toBe('claude')
    store.patch('acpAgents', [])
    expect(store.get().acpAgents).toEqual([])
  })
})

describe('读盘容错（zod catch / prefault / 顶层兜底）', () => {
  test('坏 JSON → 整体默认', async () => {
    const { store } = await makeStore('{ this is not json')
    expect(store.get()).toEqual(DEFAULTS)
  })

  test('越界值字段级回默认，好字段保留', async () => {
    const raw = JSON.stringify({
      terminal: { fontSize: 99, fontFamily: 'Consolas' },
      appearance: { sidebarWidth: 50 },
    })
    const { store } = await makeStore(raw)
    expect(store.get().terminal.fontSize).toBe(13) // 越界回默认
    expect(store.get().terminal.fontFamily).toBe('Consolas') // 好值保留
    expect(store.get().appearance.sidebarWidth).toBe(248)
    expect(store.get().notifications.desktop).toBe(true) // 整节缺失 → prefault({}) → 叶子默认
  })

  test('section 类型坏（terminal: 123）→ 顶层 catch 整体默认，UI 不炸', async () => {
    const raw = JSON.stringify({ terminal: 123, notifications: { desktop: false } })
    const { store } = await makeStore(raw)
    expect(store.get()).toEqual(DEFAULTS)
  })

  test('未知 key 往返保真（looseObject）：读进来的未知键在写盘后仍在', async () => {
    const raw = JSON.stringify({
      __future: { nested: [1, 2] },
      terminal: { fontSize: 14 },
    })
    const { store, file } = await makeStore(raw)
    expect(file.writes()).toBe(0) // 尚未写盘（snapshot 仍是 initial 原文）

    store.patch('terminal.cursorBlink', false)
    await flush()
    const onDisk = JSON.parse(file.snapshot()!)
    expect(onDisk.__future).toEqual({ nested: [1, 2] }) // 未知键没丢
    expect(onDisk.terminal.fontSize).toBe(14) // 已有值也没丢
    expect(onDisk.terminal.cursorBlink).toBe(false)
  })

  test('presets.items 坏数组 → 回 BUILTIN_PRESETS', async () => {
    const raw = JSON.stringify({ presets: { items: [{ id: 'x' }] } }) // 缺 label/builtin
    const { store } = await makeStore(raw)
    expect(store.get().presets.items.map((p) => p.id)).toEqual([
      'claude', 'pi', 'codex', 'amp', 'shell',
    ])
  })

  test('文件不存在（首次运行）→ 默认且不写盘', async () => {
    const { store, file } = await makeStore(null)
    expect(store.get()).toEqual(DEFAULTS)
    expect(file.snapshot()).toBeNull()
  })
})

describe('写失败：回滚 + writeError + 下次成功清除', () => {
  test('失败回滚到已持久化快照；成功后清除', async () => {
    const { store, file } = await makeStore()
    store.patch('terminal.fontSize', 15) // 成功落盘
    await flush()
    const persistedSnapshot = store.get()

    file.setFailWrite(new Error('EACCES: disk on fire'))
    store.patch('terminal.fontSize', 18) // 内存先见 18
    expect(store.get().terminal.fontSize).toBe(18)
    await flush()
    // 写盘 reject → 回滚 + writeError
    expect(store.get()).toEqual(persistedSnapshot) // 回到 15
    expect(store.get().terminal.fontSize).toBe(15)
    const err = store.writeError()
    expect(err?.path).toBe('terminal.fontSize')
    expect(err?.message).toContain('EACCES')

    // 下次成功 → writeError 清除、新值生效
    file.setFailWrite(null)
    store.patch('terminal.cursorBlink', false)
    await flush()
    expect(store.writeError()).toBeNull()
    expect(store.get().terminal.cursorBlink).toBe(false)
    const onDisk = JSON.parse(file.snapshot()!)
    expect(onDisk.terminal.cursorBlink).toBe(false)
    expect(onDisk.terminal.fontSize).toBe(15) // 回滚后的值被重新落盘
  })

  test('合并写：连续 patch 只落盘最后一个全量快照', async () => {
    const { store, file } = await makeStore()
    store.patch('terminal.fontSize', 16)
    store.patch('appearance.sidebarWidth', 300)
    store.patch('notifications.desktop', false)
    await flush()
    expect(file.writes()).toBe(1) // 三个 patch 合并成一次写
    const onDisk = JSON.parse(file.snapshot()!)
    expect(onDisk.terminal.fontSize).toBe(16)
    expect(onDisk.appearance.sidebarWidth).toBe(300)
    expect(onDisk.notifications.desktop).toBe(false)
  })

  test('失败作废在途写：失败后不再落盘超前快照', async () => {
    const { store, file } = await makeStore()
    file.setFailWrite(new Error('boom'))
    store.patch('terminal.fontSize', 20)
    await flush()
    expect(store.get().terminal.fontSize).toBe(13) // 已回滚
    // 旧的排队写即便链上也不得把 20 写下去
    await flush()
    const onDisk = file.snapshot()
    expect(onDisk == null || JSON.parse(onDisk).terminal.fontSize !== 20).toBe(true)
  })
})

describe('schema 一致性（§6.3）', () => {
  test('SETTING_DEFS 的 path 全部真实存在于 Settings', () => {
    expect(SETTING_DEFS.length).toBeGreaterThan(0)
    for (const def of SETTING_DEFS) {
      expect(getByPath(DEFAULTS, def.path), `path 不存在: ${def.path}`).not.toBeUndefined()
      // section 前缀匹配
      expect(def.path.startsWith(`${def.section}.`), `${def.path} 前缀应为 ${def.section}.`).toBe(true)
    }
  })

  test('SECTIONS 7 分区齐全且 def.section 都在 SECTIONS 中', () => {
    expect(SECTIONS.map((s) => s.id)).toEqual([
      'presets', 'notifications', 'terminal', 'appearance', 'keybindings', 'acp', 'advanced',
    ])
    const sectionIds = new Set(SECTIONS.map((s) => s.id))
    for (const def of SETTING_DEFS) expect(sectionIds.has(def.section)).toBe(true)
  })

  test('SettingsPath 类型抽样：合法路径编译期可表达（运行时存在）', () => {
    const paths: SettingsPath[] = [
      'presets.plusDefault', 'presets.items', 'notifications.desktop', 'terminal.fontSize',
      'appearance.sidebarWidth', 'acpAgents', 'advanced.gpuBackend',
    ]
    for (const p of paths) expect(getByPath(DEFAULTS, p)).not.toBeUndefined()
  })

  test('DEFAULTS 关键字段与 settings-ui.md §6 分表一致', () => {
    const d: Settings = DEFAULTS
    expect(d.presets.plusDefault).toBeNull()
    expect(d.presets.items).toHaveLength(5)
    expect(d.notifications).toEqual({ desktop: true, sound: false })
    expect(d.terminal).toEqual({
      fontFamily: 'JetBrains Mono', fontSize: 13, cursorBlink: true,
      scrollbackLines: 10000, palette: 'one-dark', closeOnExit: false,
    })
    expect(d.appearance).toEqual({ theme: 'one-dark', sidebarWidth: 248 })
    expect(d.acpAgents).toHaveLength(2)
    expect(d.advanced).toEqual({ gpuBackend: 'auto' })
  })
})

describe('subscribe', () => {
  test('patch / 写失败回滚 / 成功清除都 notify', async () => {
    const { store, file } = await makeStore()
    let n = 0
    const unsub = store.subscribe(() => n++)
    store.patch('terminal.fontSize', 15)
    expect(n).toBe(1)
    file.setFailWrite(new Error('x'))
    store.patch('terminal.fontSize', 18)
    await flush()
    expect(n).toBe(3) // patch + 失败回滚（writeError 变化）
    file.setFailWrite(null)
    store.patch('terminal.cursorBlink', false)
    await flush()
    expect(n).toBe(4) // patch；成功路径无 writeError 可清，不额外 notify
    unsub()
    store.patch('terminal.fontSize', 20)
    expect(n).toBe(4)
  })
})
