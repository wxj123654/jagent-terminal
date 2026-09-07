/**
 * settings 三切片测试（architecture.md §6.3：内存 adapter，零真盘）。
 *
 * 覆盖：patch/isModified/reset · 坏 JSON / 越界值字段级回默认（zod catch）
 * · 未知 key 往返保真 · 写失败回滚 + writeError（下次成功清除）· 合并写
 * · SETTING_DEFS 的 path 全部真实存在于 Settings（schema 一致性）。
 */

import { describe, expect, test } from 'bun:test'

import { memoryAdapter } from './file'
import {
  DEFAULT_TERMINAL_FONT,
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
  test('终端默认字体使用平台自带等宽字体', () => {
    expect(DEFAULTS.terminal.fontFamily).toBe(DEFAULT_TERMINAL_FONT)
  })

  test('旧 JetBrains Mono 默认值迁移为平台字体', async () => {
    const raw = JSON.stringify({ terminal: { fontFamily: 'JetBrains Mono' } })
    const { store } = await makeStore(raw)
    expect(store.get().terminal.fontFamily).toBe(DEFAULT_TERMINAL_FONT)
  })

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
      'pi',
      'claude',
      'codex',
      'amp',
      'shell',
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
      expect(def.path.startsWith(`${def.section}.`), `${def.path} 前缀应为 ${def.section}.`).toBe(
        true,
      )
    }
  })

  test('SECTIONS 7 分区齐全且 def.section 都在 SECTIONS 中', () => {
    expect(SECTIONS.map((s) => s.id)).toEqual([
      'presets',
      'notifications',
      'terminal',
      'appearance',
      'keybindings',
      'acp',
      'advanced',
    ])
    const sectionIds = new Set(SECTIONS.map((s) => s.id))
    for (const def of SETTING_DEFS) expect(sectionIds.has(def.section)).toBe(true)
  })

  test('SettingsPath 类型抽样：合法路径编译期可表达（运行时存在）', () => {
    const paths: SettingsPath[] = [
      'presets.plusDefault',
      'presets.items',
      'notifications.desktop',
      'terminal.fontSize',
      'appearance.sidebarWidth',
      'acpAgents',
      'advanced.gpuBackend',
    ]
    for (const p of paths) expect(getByPath(DEFAULTS, p)).not.toBeUndefined()
  })

  test('DEFAULTS 关键字段与 settings-ui.md §6 分表一致', () => {
    const d: Settings = DEFAULTS
    expect(d.presets.plusDefault).toBeNull()
    expect(d.presets.items).toHaveLength(5)
    expect(d.notifications).toEqual({ desktop: true, sound: false })
    expect(d.terminal).toEqual({
      fontFamily: DEFAULT_TERMINAL_FONT,
      fontSize: 13,
      cursorBlink: true,
      scrollbackLines: 10000,
      palette: 'one-dark',
      closeOnExit: false,
    })
    expect(d.appearance).toEqual({ theme: 'one-dark', sidebarWidth: 248 })
    expect(d.acpAgents).toHaveLength(2)
    expect(d.advanced).toEqual({ gpuBackend: 'auto', perfHud: false, frameOverlay: false })
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

// ── 预设 CRUD（§7 规则；T3.1）──────────────────────────────────

describe('preset CRUD：add / update', () => {
  test('addPreset → 自定义预设（builtin:false）+ 唯一 id + 落盘', async () => {
    const { store, file } = await makeStore()
    const id = store.addPreset({ label: '自定义 1', program: 'pwsh', args: ['-NoLogo'] })
    const added = store.get().presets.items.find((p) => p.id === id)
    expect(added).toBeDefined()
    expect(added!.builtin).toBe(false)
    expect(added!.program).toBe('pwsh')
    expect(added!.args).toEqual(['-NoLogo'])
    await flush()
    const onDisk = JSON.parse(file.snapshot()!)
    expect(onDisk.presets.items).toHaveLength(6)
    expect(onDisk.presets.items.find((p: { id: string }) => p.id === id).label).toBe('自定义 1')
  })

  test('updatePreset 改字段；空串/空集合归一 undefined（JSON 不留 "" / []）；args 空串行过滤', async () => {
    const { store, file } = await makeStore()
    const id = store.addPreset({
      label: 'X',
      program: 'pwsh',
      args: ['-l'],
      env: { A: '1' },
      initCommand: 'vim',
      cwd: 'D:/',
    })
    store.updatePreset(id, { program: '', args: [], env: {}, initCommand: '', label: 'Y' })
    const p = store.get().presets.items.find((x) => x.id === id)!
    expect(p.label).toBe('Y')
    expect(p.program).toBeUndefined()
    expect(p.args).toBeUndefined()
    expect(p.env).toBeUndefined()
    expect(p.initCommand).toBeUndefined()
    await flush()
    const raw = JSON.parse(file.snapshot()!)
    const onDisk = raw.presets.items.find((x: { id: string }) => x.id === id)
    expect('program' in onDisk).toBe(false)
    expect('args' in onDisk).toBe(false)
    expect('env' in onDisk).toBe(false)

    // 编辑中间态的空串行不进 JSON（LinesField 即时提交原始行，归一在此）
    store.updatePreset(id, { args: ['NoLogo', '', 'NoPrompt'] })
    expect(store.get().presets.items.find((x) => x.id === id)!.args).toEqual(['NoLogo', 'NoPrompt'])
    store.updatePreset(id, { args: [''] })
    expect(store.get().presets.items.find((x) => x.id === id)!.args).toBeUndefined()
  })

  test('updatePreset 内置预设可改字段（id 不可改在类型面）；未知 id no-op', async () => {
    const { store } = await makeStore()
    store.updatePreset('claude', { initCommand: 'claude --dangerously' })
    expect(store.get().presets.items.find((p) => p.id === 'claude')!.initCommand).toBe(
      'claude --dangerously',
    )
    const before = store.get().presets.items
    store.updatePreset('nope', { label: '?' })
    expect(store.get().presets.items).toBe(before) // 引用未变 = no-op
  })
})

describe('preset CRUD：delete / duplicate / reset', () => {
  test('deletePreset 自定义可删；内置 no-op', async () => {
    const { store } = await makeStore()
    const id = store.addPreset({ label: 'X' })
    expect(store.get().presets.items).toHaveLength(6)
    store.deletePreset('claude') // 内置不可删
    expect(store.get().presets.items).toHaveLength(6)
    store.deletePreset(id)
    expect(store.get().presets.items).toHaveLength(5)
    expect(store.get().presets.items.find((p) => p.id === id)).toBeUndefined()
  })

  test('deletePreset plusDefault 指向被删预设 → 回退 null（§15 第 8 条）', async () => {
    const { store } = await makeStore()
    const id = store.addPreset({ label: 'X' })
    store.patch('presets.plusDefault', id)
    expect(store.get().presets.plusDefault).toBe(id)
    store.deletePreset(id)
    expect(store.get().presets.plusDefault).toBeNull()
  })

  test('duplicatePreset 内置 → builtin:false + 副本后缀 + 唯一 id；返回新 id', async () => {
    const { store } = await makeStore()
    const nid1 = store.duplicatePreset('claude')
    expect(nid1).toBe('claude-copy')
    const copy1 = store.get().presets.items.find((p) => p.id === nid1)!
    expect(copy1.builtin).toBe(false)
    expect(copy1.label).toBe('Claude Code 副本')
    expect(copy1.initCommand).toBe('claude') // 字段随源
    // 再复制 claude → -copy2；复制副本本身 → -copy-copy
    const nid2 = store.duplicatePreset('claude')
    expect(nid2).toBe('claude-copy2')
    const nid3 = store.duplicatePreset(nid1)
    expect(nid3).toBe(`${nid1}-copy`)
  })

  test('duplicatePreset 自定义预设 → 同样 builtin:false 副本', async () => {
    const { store } = await makeStore()
    const id = store.addPreset({ label: 'X', program: 'zsh' })
    const nid = store.duplicatePreset(id)
    const copy = store.get().presets.items.find((p) => p.id === nid)!
    expect(copy.builtin).toBe(false)
    expect(copy.program).toBe('zsh')
    expect(copy.label).toBe('X 副本')
  })

  test('resetPreset 内置改坏后恢复出厂；未改的内置 no-op（引用不变）；自定义 no-op', async () => {
    const { store } = await makeStore()
    store.updatePreset('claude', { label: '我的 Claude', initCommand: 'claude --x' })
    store.resetPreset('claude')
    const restored = store.get().presets.items.find((p) => p.id === 'claude')!
    expect(restored.label).toBe('Claude Code')
    expect(restored.initCommand).toBe('claude')

    const before = store.get().presets.items
    store.resetPreset('pi') // 未改过
    expect(store.get().presets.items).not.toBe(before) // 新数组（写链路径）但内容相等
    expect(store.get().presets.items).toEqual(before)

    const id = store.addPreset({ label: 'X' })
    const withCustom = store.get().presets.items
    store.resetPreset(id) // 自定义无出厂值
    expect(store.get().presets.items).toBe(withCustom)
  })

  test('CRUD 写失败同样回滚 + writeError（同一写链面）', async () => {
    const { store, file } = await makeStore()
    const id = store.addPreset({ label: 'X' }) // 成功落盘
    await flush()
    const persisted = store.get()

    file.setFailWrite(new Error('EACCES'))
    store.updatePreset(id, { label: 'Y' })
    expect(store.get().presets.items.find((p) => p.id === id)!.label).toBe('Y')
    await flush()
    expect(store.get()).toEqual(persisted) // 回滚
    expect(store.get().presets.items.find((p) => p.id === id)!.label).toBe('X')
    expect(store.writeError()?.path).toBe('presets.items')
  })
})

describe('运行时态纪律（§15 第 8 条后半）', () => {
  test('lastUsedPreset 不在 Settings schema / DEFAULTS / 序列化产物中', async () => {
    const { store, file } = await makeStore()
    store.patch('terminal.fontSize', 15)
    store.addPreset({ label: 'X' })
    await flush()
    const raw = file.snapshot()!
    expect(raw.includes('lastUsedPreset')).toBe(false)
    expect('lastUsedPreset' in store.get()).toBe(false)
    expect(JSON.stringify(DEFAULTS).includes('lastUsedPreset')).toBe(false)
  })
})

describe('acpAgents CRUD（T3+.1）', () => {
  test('addAcpAgent → 新 agent + 唯一 id + 落盘；默认 2 示例可删（无 builtin）', async () => {
    const { store, file } = await makeStore()
    expect(store.get().acpAgents).toHaveLength(2) // DEFAULT_ACP_AGENTS
    const id = store.addAcpAgent({ label: 'Gemini', command: 'gemini', args: ['--acp'] })
    const added = store.get().acpAgents.find((a) => a.id === id)
    expect(added).toMatchObject({ label: 'Gemini', command: 'gemini', args: ['--acp'] })
    await flush()
    const onDisk = JSON.parse(file.snapshot()!)
    expect(onDisk.acpAgents).toHaveLength(3)

    // 默认示例也是普通条目：可删
    store.deleteAcpAgent(store.get().acpAgents[0].id)
    await flush()
    expect(store.get().acpAgents).toHaveLength(2)
  })

  test('addAcpAgent 缺省：command 空、args []（占位编辑中间态）；updateAcpAgent 改字段 + args 空串行过滤；未知 id no-op', async () => {
    const { store } = await makeStore()
    const id = store.addAcpAgent({ label: 'X' })
    expect(store.get().acpAgents.find((a) => a.id === id)).toMatchObject({
      command: '',
      args: [],
    })
    store.updateAcpAgent(id, { command: 'codex', args: ['--acp', ''] })
    expect(store.get().acpAgents.find((a) => a.id === id)!.args).toEqual(['--acp'])
    store.updateAcpAgent('nope', { label: 'Y' })
    expect(store.get().acpAgents.find((a) => a.id === 'nope')).toBeUndefined()
  })

  test('deleteAcpAgent 落盘；CRUD 写失败同链回滚（path=acpAgents）', async () => {
    const { store, file } = await makeStore()
    const persisted = store.get()
    file.setFailWrite(new Error('EACCES'))
    store.deleteAcpAgent(persisted.acpAgents[0].id)
    await flush()
    expect(store.get()).toEqual(persisted) // 回滚
    expect(store.writeError()?.path).toBe('acpAgents')
  })
})
