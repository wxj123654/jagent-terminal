/**
 * plane/WorkspaceList.test.tsx — Phase W2 侧栏工作区分组树测试。
 *
 * 真 createThreadStore（fake deps + 两个初始工作区）+ TestGpuixRenderer。
 * 覆盖：分组渲染与缩进 · 箭头 toggle（不激活）/ 点行激活 · ＋ 工具菜单
 * （目标工作区头 + spawn 归属）· 添加工作区内联表单 · 搜索结果态。
 * 双击重命名工作区不可测（TestRenderer click_count 恒 1，TitleBar 已知
 * 限制）；rename 规则在 store.test 已覆盖。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { currentActiveThreadId, navigateTarget, router } from '../router'
import { memoryAdapter } from '../settings/file'
import { createSettingsStore, type SettingsStore } from '../settings/store'
import { builtinPresetOf } from '../threads/presets'
import { createThreadStore, type ThreadStore } from '../threads/store'
import { defaultWorkspace } from '../threads/workspaces'
import { WorkspaceList } from './WorkspaceList'

let t: TestRoot
let store: ThreadStore
let settings: SettingsStore
let wsA: string // 默认 expanded 工作区
let wsB: string

/** query/picker 可变壳（Sidebar 的搜索框态 + main.tsx 的 picker 注入等价） */
function Harness({
  query,
  pickDirectory,
}: {
  query: string
  pickDirectory?: () => Promise<string | null>
}) {
  return (
    <WorkspaceList store={store} settings={settings} query={query} pickDirectory={pickDirectory} />
  )
}

const flush = () => new Promise((r) => setTimeout(r, 0))
async function until(desc: string, pred: () => boolean, timeoutMs = 3000) {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${desc}`)
    await flush()
    t.renderer.flush()
  }
}
function clickCenter(testId: string) {
  const el = t.renderer.findByTestId(testId)
  if (!el) throw new Error(`element not found: ${testId}`)
  const b = t.renderer.getElementBounds(el.id)!
  t.renderer.nativeSimulateClick(b[0] + b[2] / 2, b[1] + b[3] / 2, 0)
  t.renderer.flush()
}

beforeAll(() => {
  t = createTestRoot({ width: 900, height: 700 })
  settings = createSettingsStore(memoryAdapter())
  const a = defaultWorkspace('/w/alpha')
  const b = { ...defaultWorkspace('/w/beta'), name: 'beta' }
  wsA = a.id
  wsB = b.id
  let nextSession = 1
  store = createThreadStore(
    {
      spawnSession: async () => nextSession++,
      destroySession: async () => {},
      navigate: navigateTarget,
      notify: () => {},
      closeOnExit: () => false,
      presetOf: (id) => builtinPresetOf(id),
      activeThreadId: currentActiveThreadId,
      chatAgent: { send: async () => '' },
      createAcpAgent: () => {
        throw new Error('nope')
      },
    },
    { initialWorkspaces: [a, b] },
  )
})

afterAll(() => {
  t?.unmount()
})

beforeEach(() => {
  void router.navigate({ to: '/' })
})

describe('WorkspaceList：分组树', () => {
  test('两工作区行渲染（name + 展开箭头）；默认展开', async () => {
    t.render(createElement(Harness, { query: '' }))
    t.renderer.flush()
    await until('workspace rows visible', () => {
      const na = t.renderer.findByTestId(`workspace-name-${wsA}`)
      const nb = t.renderer.findByTestId(`workspace-name-${wsB}`)
      return na != null && nb != null
    })
    expect(t.renderer.getAllText().some((s) => s.includes('alpha'))).toBe(true)
    expect(t.renderer.getAllText().some((s) => s.includes('beta'))).toBe(true)
  })

  test('归属会话行缩进渲染（x 偏移 > 工作区行）', async () => {
    await store.spawnFromPreset('shell', wsA)
    t.render(createElement(Harness, { query: '' }))
    t.renderer.flush()
    const tid = store.getState().threads[0]!.id
    await until('session row visible', () => t.renderer.findByTestId(`row-${tid}`) != null)
    const rowB = t.renderer.getElementBounds(t.renderer.findByTestId(`row-${tid}`)!.id)!
    const wsRowB = t.renderer.getElementBounds(t.renderer.findByTestId(`workspace-${wsA}`)!.id)!
    expect(rowB[0]).toBeGreaterThan(wsRowB[0])
    // 会话数 badge：含工作区名行文本（1 会话）
    expect(t.renderer.getAllText().some((s) => s.includes('1'))).toBe(true)
    store.close(tid)
    t.renderer.flush()
  })

  test('箭头 toggle：会话行隐现 + 不激活（路由不动）；点行 = 激活工作区', async () => {
    await store.spawnFromPreset('shell', wsA)
    const tid = store.getState().threads[0]!.id
    t.render(createElement(Harness, { query: '' }))
    t.renderer.flush()
    await until('session row visible', () => t.renderer.findByTestId(`row-${tid}`) != null)

    // 收起：行消失 + active 不变（spawn 时 activate 了该 thread——保持）
    clickCenter(`workspace-toggle-${wsA}`)
    await until('collapsed', () => t.renderer.findByTestId(`row-${tid}`) == null)
    expect(currentActiveThreadId()).toBe(tid) // toggle 不导航

    // 展开回来；点行激活工作区（lastSession 恢复）
    clickCenter(`workspace-toggle-${wsA}`)
    await until('expanded again', () => t.renderer.findByTestId(`row-${tid}`) != null)
    void router.navigate({ to: '/' }) // 模拟离开
    clickCenter(`workspace-${wsA}`)
    await until('workspace activated → lastSession restored', () => currentActiveThreadId() === tid)

    store.close(tid)
    t.renderer.flush()
  })

  test('空工作区引导行（expanded 且无会话）', async () => {
    t.render(createElement(Harness, { query: '' }))
    t.renderer.flush()
    await until('beta empty hint', () =>
      t.renderer.getAllText().some((s) => s.includes('空工作区')),
    )
  })
})

describe('WorkspaceList：＋ 工具菜单', () => {
  test('菜单打开：目标工作区头（name + path）+ 预设项 + New Chat + ACP agents', async () => {
    t.render(createElement(Harness, { query: '' }))
    t.renderer.flush()
    clickCenter(`new-menu-${wsA}`)
    await until('menu target visible', () => t.renderer.findByTestId('tool-menu-target') != null)
    // 目标头含 cwd（mono 路径）
    expect(t.renderer.getAllText().some((s) => s.includes('/w/alpha'))).toBe(true)
    // 内置预设 + 固定项 + 默认 2 ACP agent
    expect(t.renderer.findByTestId('tool-preset-shell') != null).toBe(true)
    expect(t.renderer.findByTestId('new-chat') != null).toBe(true)
    expect(t.renderer.findByTestId('new-acp-acp-codex') != null).toBe(true)
    // 收尾关闭（toggle；后续用例自包含打开）
    clickCenter(`new-menu-${wsA}`)
    await until('menu closed', () => t.renderer.findByTestId('tool-menu-target') == null)
  })

  test('点预设项：spawn 带归属 + 菜单关闭', async () => {
    t.render(createElement(Harness, { query: '' }))
    t.renderer.flush()
    clickCenter(`new-menu-${wsA}`)
    await until('menu open', () => t.renderer.findByTestId('tool-preset-shell') != null)
    clickCenter('tool-preset-shell')
    await until('spawned with workspace', () => {
      const th = store.getState().threads.find((x) => x.kind === 'terminal')
      return th != null && th.kind === 'terminal' && th.workspaceId === wsA
    })
    const th = store.getState().threads.find((x) => x.kind === 'terminal')!
    expect(th.kind === 'terminal' && th.cwd === '/w/alpha').toBe(true) // cwd 继承
    await until('menu closed', () => t.renderer.findByTestId('tool-menu-target') == null)
    store.close(th.id)
    t.renderer.flush()
  })

  test('New Chat：createChat 带归属', async () => {
    t.render(createElement(Harness, { query: '' }))
    t.renderer.flush()
    clickCenter(`new-menu-${wsA}`)
    await until('menu open', () => t.renderer.findByTestId('new-chat') != null)
    clickCenter('new-chat')
    await until('chat created with workspace', () => {
      const c = store.getState().threads.find((x) => x.kind === 'chat')
      return c != null && c.workspaceId === wsA
    })
    const c = store.getState().threads.find((x) => x.kind === 'chat')!
    store.close(c.id)
    t.renderer.flush()
  })
})

describe('WorkspaceList：添加工作区', () => {
  test('表单：路径必填 + 名称空回退 basename + 入列表', async () => {
    t.render(createElement(Harness, { query: '' }))
    t.renderer.flush()
    clickCenter('add-workspace')
    await until('form visible', () => t.renderer.findByTestId('add-workspace-form') != null)

    // 空 path：submit 无效
    clickCenter('add-workspace-submit')
    expect(store.getState().workspaces.some((w) => w.path === '/w/gamma')).toBe(false)

    // 输入 path（名称空 → basename）
    const nameInput = t.renderer.findByTestId('add-workspace-name')!
    const nb = t.renderer.getElementBounds(nameInput.id)!
    t.renderer.nativeSimulateClick(nb[0] + 10, nb[1] + 10)
    t.renderer.simulateKeystrokes('自定义名')
    const pathInput = t.renderer.findByTestId('add-workspace-path')!
    const pb = t.renderer.getElementBounds(pathInput.id)!
    t.renderer.nativeSimulateClick(pb[0] + 10, pb[1] + 10)
    t.renderer.simulateKeystrokes('/w/gamma')
    clickCenter('add-workspace-submit')

    const added = store.getState().workspaces.find((w) => w.path === '/w/gamma')
    expect(added?.name).toBe('自定义名')
    await until(
      'new workspace row visible',
      () => t.renderer.findByTestId(`workspace-${added!.id}`) != null,
    )
    store.removeWorkspace(added!.id)
    t.renderer.flush()
  })
})

describe('WorkspaceList：搜索态', () => {
  test('query 命中：跨工作区结果行（标题/目录）+ 工作区名标注；无命中空态', async () => {
    await store.spawnFromPreset('shell', wsA) // cwd=/w/alpha
    await store.createChat(wsB) // beta
    t.render(createElement(Harness, { query: '' }))
    t.renderer.flush()

    // 目录命中（alpha）
    t.render(createElement(Harness, { query: 'alpha' }))
    t.renderer.flush()
    const shellId = store.getState().threads.find((x) => x.kind === 'terminal')!.id
    await until('search hit by dir', () => t.renderer.findByTestId(`row-${shellId}`) != null)
    // 不命中工作区不出现（beta 的 chat 无 alpha 字样）
    const chatId = store.getState().threads.find((x) => x.kind === 'chat')!.id
    expect(t.renderer.findByTestId(`row-${chatId}`)).toBeUndefined()

    // 工具命中（Chat）
    t.render(createElement(Harness, { query: 'chat' }))
    t.renderer.flush()
    await until('search hit by tool', () => t.renderer.findByTestId(`row-${chatId}`) != null)
    expect(t.renderer.findByTestId(`row-${shellId}`)).toBeUndefined()

    // 无命中
    t.render(createElement(Harness, { query: 'zzz-nope' }))
    t.renderer.flush()
    await until('empty state', () => t.renderer.getAllText().some((s) => s.includes('无匹配会话')))

    store.close(shellId)
    store.close(chatId)
    t.renderer.flush()
  })
})

describe('WorkspaceList：浏览…（W3 目录选择）', () => {
  test('未注入 picker：按钮不渲染；注入后点击 → 填 path + 空名称自动 basename', async () => {
    // 未注入：无按钮
    t.render(createElement(Harness, { query: '' }))
    t.renderer.flush()
    clickCenter('add-workspace')
    await until('form visible', () => t.renderer.findByTestId('add-workspace-form') != null)
    expect(t.renderer.findByTestId('browse-directory')).toBeUndefined()

    // 注入 fake：选择 → path 填入 + name 自动 basename（表单在同构树上保持 open）
    let resolvePick: (p: string | null) => void = () => {}
    const fake = () =>
      new Promise<string | null>((r) => {
        resolvePick = r
      })
    t.render(createElement(Harness, { query: '', pickDirectory: fake }))
    t.renderer.flush()
    expect(t.renderer.findByTestId('browse-directory') != null).toBe(true)
    clickCenter('browse-directory')
    resolvePick('/w/picked-proj')
    await until('path filled', () => {
      const el = t.renderer.findByTestId('add-workspace-path')
      const v = el ? String(t.renderer.getElement(el.id)?.customProps?.value ?? '') : ''
      return v === '/w/picked-proj'
    })
    // 名称空 → basename 自动填
    const nameEl = t.renderer.findByTestId('add-workspace-name')!
    const nameVal = String(t.renderer.getElement(nameEl.id)?.customProps?.value ?? '')
    expect(nameVal).toBe('picked-proj')

    // 取消路径：再次浏览取消 → 已填值不动
    clickCenter('browse-directory')
    resolvePick(null)
    await until('idle after cancel', () => true)
    const pathEl = t.renderer.findByTestId('add-workspace-path')!
    expect(String(t.renderer.getElement(pathEl.id)?.customProps?.value ?? '')).toBe(
      '/w/picked-proj',
    )
  })
})
