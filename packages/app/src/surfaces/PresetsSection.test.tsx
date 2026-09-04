/**
 * surfaces/PresetsSection.test.tsx — T3.1 预设分区 CRUD 测试
 * （settings-ui.md §7 / §15 第 7–8 条验收锚点）。
 *
 * 跑法：bun test packages/app/src/surfaces/PresetsSection.test.tsx
 * 真值接线用真 createSettingsStore + memoryAdapter；textarea 文本在原生
 * 编辑器内不进 getAllText——args/env 断言走 store 快照；行式字段即时提交
 * （blur 不可依赖：TestGpuixRenderer 不派发 focus/blur，实测）。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { memoryAdapter, type MemoryAdapter } from '../settings/file'
import { createSettingsStore } from '../settings/store'
import { PresetsSection } from './PresetsSection'

let t: TestRoot
let file: MemoryAdapter
let store: ReturnType<typeof createSettingsStore>

beforeAll(() => {
  t = createTestRoot({ width: 1000, height: 700 })
  file = memoryAdapter()
  store = createSettingsStore(file)
  t.render(createElement(PresetsSection, { settings: store, query: null }))
})

afterAll(() => {
  t?.unmount()
})

function click(testId: string): void {
  const el = t.renderer.findByTestId(testId)
  expect(el, `not found: ${testId}`).toBeDefined()
  const b = t.renderer.getElementBounds(el!.id)
  expect(b, `no bounds: ${testId}`).toBeDefined()
  t.renderer.nativeSimulateClick(b![0] + b![2] / 2, b![1] + b![3] / 2)
}

function exists(testId: string): boolean {
  return t.renderer.findByTestId(testId) !== undefined
}

function texts(): string {
  return t.renderer.getAllText().join('\n')
}

async function until(desc: string, pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${desc}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 重渲染（query 变化 / 状态重置用；React 提交需 macrotask 让出） */
async function rerender(query: string | null = null): Promise<void> {
  t.render(createElement(PresetsSection, { settings: store, query }))
  await new Promise((r) => setTimeout(r, 10))
  t.renderer.flush()
}

// ── §15 第 7 条：内置 5 个不可删可重置；自定义可增删改；复制内置 → 自定义 ──

describe('PresetsSection · 列表与徽章', () => {
  test('默认 5 内置行 + 内置徽章 + plusDefault「跟随上次使用」+ 新增按钮', () => {
    for (const id of ['claude', 'pi', 'codex', 'amp', 'shell']) {
      expect(exists(`preset-card-${id}`), id).toBe(true)
      expect(exists(`preset-copy-${id}`), `${id} copy`).toBe(true)
      // 内置无删除钮
      expect(exists(`preset-delete-${id}`), `${id} delete`).toBe(false)
    }
    expect(texts().includes('内置')).toBe(true)
    expect(texts().includes('Claude Code')).toBe(true)
    expect(texts().includes('（系统默认 shell）')).toBe(true) // shell 预设摘要
    expect(texts().includes('amp  →')).toBe(false) // amp 无 initCommand
    expect(texts().includes('amp')).toBe(true)
    expect(exists('add-preset')).toBe(true)
    expect(exists('plus-default')).toBe(true)
    expect(texts().includes('跟随上次使用')).toBe(true)
    // 无 API key 字样（§15 第 11 条：无 API key 输入框——note 在编辑器里，收起态无）
  })

  test('plusDefault 固定后 Select 显示对应 label；回 null 恢复', async () => {
    store.patch('presets.plusDefault', 'claude')
    await rerender()
    expect(texts().includes('Claude Code')).toBe(true)
    store.patch('presets.plusDefault', null)
    await rerender()
    expect(texts().includes('跟随上次使用')).toBe(true)
  })
})

describe('PresetsSection · 展开编辑与即时生效', () => {
  test('点 head 展开 → 六字段；改 label 即时生效 + 行内蓝点 + 字段蓝点', async () => {
    expect(exists('preset-editor-claude')).toBe(false)
    click('preset-head-claude')
    t.renderer.flush()
    expect(exists('preset-editor-claude')).toBe(true)
    for (const f of ['label', 'program', 'args', 'env', 'initCommand', 'cwd']) {
      expect(exists(`field-${f}-claude`), f).toBe(true)
    }
    expect(exists('mod-dot-claude')).toBe(false) // 未改

    const label = t.renderer.findByTestId('field-label-claude')!
    t.renderer.nativeSimulateKeystrokes(label.id, 'space X')
    await until(
      'label updated in store',
      () => store.get().presets.items.find((p) => p.id === 'claude')?.label === 'Claude Code X',
    )
    await until('row label rerender', () => texts().includes('Claude Code X'))
    expect(exists('mod-dot-claude')).toBe(true)

    // 收起再展开：编辑器重建，值来自 store（受控）
    click('preset-head-claude')
    t.renderer.flush()
    expect(exists('preset-editor-claude')).toBe(false)
    click('preset-head-claude')
    t.renderer.flush()
    expect(texts().includes('Claude Code X')).toBe(true)
  })

  test('重置内置 → 出厂值 + 蓝点消失（§7 仅 modified 时显示 reset）', async () => {
    expect(exists('preset-reset-claude')).toBe(true) // modified → reset 可见
    click('preset-reset-claude')
    await until(
      'reset to factory',
      () => store.get().presets.items.find((p) => p.id === 'claude')?.label === 'Claude Code',
    )
    await until('mod dot gone', () => !exists('mod-dot-claude'))
    // 未改过 → reset 钮不再渲染
    expect(exists('preset-reset-claude')).toBe(false)
  })
})

describe('PresetsSection · 复制 / 删除 / 新增', () => {
  test('复制内置 → 自定义副本行（badge 自定义 + 展开）', async () => {
    click('preset-copy-claude')
    await until('copy row appears', () => exists('preset-card-claude-copy'))
    expect(texts().includes('Claude Code 副本')).toBe(true)
    expect(texts().includes('自定义')).toBe(true)
    expect(exists('preset-delete-claude-copy')).toBe(true) // 自定义可删
    expect(exists('preset-delete-claude')).toBe(false) // 内置不可删
    // 展开新副本
    expect(exists('preset-editor-claude-copy')).toBe(true)
  })

  test('删除自定义 → 行消失；plusDefault 指向它 → 回退 null（§15 第 8 条）', async () => {
    // 先把 plusDefault 固定到副本
    store.patch('presets.plusDefault', 'claude-copy')
    expect(store.get().presets.plusDefault).toBe('claude-copy')

    click('preset-delete-claude-copy')
    await until('row removed', () => !exists('preset-card-claude-copy'))
    expect(store.get().presets.plusDefault).toBeNull()
    expect(store.get().presets.items).toHaveLength(5)
  })

  test('新增预设 → 新行展开 + store +1；改 program/env 即时生效（空串归一）', async () => {
    click('add-preset')
    await until('new preset editor', () => {
      const ids = store
        .get()
        .presets.items.filter((p) => !p.builtin)
        .map((p) => p.id)
      return ids.length === 1 && exists(`preset-editor-${ids[0]}`)
    })
    const nid = store.get().presets.items.find((p) => !p.builtin)!.id
    expect(store.get().presets.items.find((p) => p.id === nid)!.label).toBe('自定义 1')
    expect(texts().includes('自定义 1')).toBe(true)

    // program 即时输入
    const prog = t.renderer.findByTestId(`field-program-${nid}`)!
    t.renderer.nativeSimulateKeystrokes(prog.id, 'pwsh')
    await until(
      'program set',
      () => store.get().presets.items.find((p) => p.id === nid)?.program === 'pwsh',
    )

    // args 行式即时提交：enter 换行，空串行在 store 层过滤（提交不依赖 blur
    // ——TestGpuixRenderer 不派发 focus/blur；keystroke 语法 '-' 是 modifier 连接符，
    // 测试数据避开）
    const args = t.renderer.findByTestId(`field-args-${nid}`)!
    t.renderer.nativeSimulateKeystrokes(args.id, 'N o L o g o shift-enter N o P r o m p t')
    await until('args committed immediately', () => {
      const p = store.get().presets.items.find((x) => x.id === nid)
      return p?.args?.length === 2
    })
    const p = store.get().presets.items.find((x) => x.id === nid)!
    expect(p.args).toEqual(['NoLogo', 'NoPrompt'])

    // cwd 即时输入
    const cwd = t.renderer.findByTestId(`field-cwd-${nid}`)!
    t.renderer.nativeSimulateKeystrokes(cwd.id, 'D : / t m p')
    await until(
      'cwd set',
      () => store.get().presets.items.find((x) => x.id === nid)?.cwd === 'D:/tmp',
    )

    // env 行式：KEY=VALUE（无 = 的行忽略）
    const env = t.renderer.findByTestId(`field-env-${nid}`)!
    t.renderer.nativeSimulateKeystrokes(env.id, 'A M P = 1 shift-enter b r o k e n')
    await until(
      'env committed',
      () => store.get().presets.items.find((x) => x.id === nid)?.env?.AMP === '1',
    )
    const after = store.get().presets.items.find((x) => x.id === nid)!
    expect(after.env).toEqual({ AMP: '1' }) // 'broken' 无 = 被忽略
  })

  test('写失败 → 分区顶部红条（回滚由 store 层完成）', async () => {
    file.setFailWrite(new Error('EACCES: presets boom'))
    const nid = store.get().presets.items.find((p) => !p.builtin)!.id
    const label = t.renderer.findByTestId(`field-label-${nid}`)!
    t.renderer.nativeSimulateKeystrokes(label.id, '!')
    await until('write error bar', () => exists('writeerror'))
    expect(texts().includes('EACCES')).toBe(true)
    file.setFailWrite(null)
  })
})

describe('PresetsSection · 搜索过滤（§9：预设名命中）', () => {
  test('query 过滤行：amp 命中 amp（+摘要 program）；claude 不显示', async () => {
    await rerender('amp')
    expect(exists('preset-card-amp')).toBe(true)
    expect(exists('preset-card-claude')).toBe(false)
    // 自定义预设「自定义 1」program=pwshx → program 命中
    const nid = store.get().presets.items.find((p) => !p.builtin)!.id
    expect(exists(`preset-card-${nid}`)).toBe(false)

    await rerender('pwsh')
    expect(exists(`preset-card-${nid}`)).toBe(true) // program 命中
    expect(exists('preset-card-amp')).toBe(false)

    await rerender('zzz-no-hit')
    expect(exists('settings-empty-hits')).toBe(true)

    await rerender(null) // 还原
  })
})
