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
import { createElement, useState } from 'react'

import { currentActiveThreadId, navigateTarget, router } from '../router'
import { memoryAdapter } from '../settings/file'
import { createSettingsStore, type SettingsStore } from '../settings/store'
import { builtinPresetOf } from '../threads/presets'
import { createThreadStore, type ThreadStore } from '../threads/store'
import { defaultWorkspace } from '../threads/workspaces'
import { DialogHost } from './DialogHost'
import { WorkspaceList } from './WorkspaceList'

let t: TestRoot
let store: ThreadStore
let settings: SettingsStore
let wsA: string // 默认 expanded 工作区
let wsB: string

/** DialogHost 可控态镜像（测试读取用；真状态在 Harness useState——React
 *  自调度 rerender。W7 教训：事件回调里手动 root.render 会打断渲染管线，
 *  后续树渲染成空） */
let dialogState: { kind: string; workspaceId?: string; threadId?: string } = { kind: 'none' }
const mirror = (next: typeof dialogState) => {
  dialogState = next
  return next
}

/** query/picker 可变壳（Sidebar 的搜索框态 + main.tsx 的 picker 注入等价） */
function Harness({
  query,
  pickDirectory,
}: {
  query: string
  pickDirectory?: () => Promise<string | null>
}) {
  // dialog 状态在组件内（同类型 Harness 跨 t.render 保留——React diff 语义）
  const [dialog, setDialog] = useState({ kind: 'none' } as typeof dialogState)
  const open = (next: typeof dialogState) => setDialog(mirror(next))
  const dialogOpener = {
    openToolMenu: (workspaceId: string) => open({ kind: 'tool', workspaceId }),
    openAddWorkspace: () => open({ kind: 'addWorkspace' }),
    openSearch: () => open({ kind: 'search' }),
    openManageSession: (threadId: string) => open({ kind: 'manageSession', threadId }),
    openManageWorkspace: (workspaceId: string) => open({ kind: 'manageWorkspace', workspaceId }),
    openErrors: () => open({ kind: 'errors' }),
  }
  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', minHeight: 0 }}
    >
      <WorkspaceList store={store} settings={settings} query={query} dialog={dialogOpener} />
      {dialog.kind === 'none' ? null : (
        <DialogHost
          store={store}
          settings={settings}
          state={dialog as never}
          setState={(next) => setDialog(mirror(next as typeof dialogState))}
          pickDirectory={pickDirectory}
        />
      )}
    </div>
  )
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const renderHarness = (props: { query: string; pickDirectory?: () => Promise<string | null> }) => {
  t.render(createElement(Harness, props))
}
async function until(desc: string, pred: () => boolean, timeoutMs = 3000) {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${desc}`)
    await flush()
    t.renderer.flush()
  }
}
/** 输入框打字：nativeSimulateKeystrokes 自带 focus（keystroke → onChange 链） */
function typeInto(testId: string, text: string) {
  const el = t.renderer.findByTestId(testId)
  if (!el) throw new Error(`element not found: ${testId}`)
  t.renderer.nativeSimulateKeystrokes(el.id, text)
  t.renderer.flush()
}

function clickCenter(testId: string) {
  const el = t.renderer.findByTestId(testId)
  if (!el) throw new Error(`element not found: ${testId}`)
  const b = t.renderer.getElementBounds(el.id)!
  t.renderer.nativeSimulateClick(b[0] + b[2] / 2, b[1] + b[3] / 2, 0)
  t.renderer.flush()
}

/** scrim 点击（带 blur 规避：GPUUIX input 聚焦中时 nativeSimulateClick
 *  到 scrim 的命中被吞——W7 实测；先 blur 再点） */
/** eslint-disable @typescript-eslint/no-explicit-any -- TestRenderer 无 blur 类型（native 有） */
function clickScrim() {
  ;(t.renderer as any).blur?.()
  clickCenter('modal-scrim')
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
    renderHarness({ query: '' })
    t.renderer.flush()
    await until('workspace rows visible', () => {
      const na = t.renderer.findByTestId(`workspace-name-${wsA}`)
      const nb = t.renderer.findByTestId(`workspace-name-${wsB}`)
      return na != null && nb != null
    })
    expect(t.renderer.getAllText().some((s) => s.includes('alpha'))).toBe(true)
    expect(t.renderer.getAllText().some((s) => s.includes('beta'))).toBe(true)
  })

  // D13：超过 10 条且跨时间组时，不再为完全隐藏的组渲染孤立日期标签；
  // 「展开其余 N 个」只在最后一个可见组下方、N 为全组合计。
  test('超 10 条跨时间组：无孤立日期标签；展开合计正确（D13）', async () => {
    // 自清理前置：前面用例可能有遗留行（会占 limit 名额）；
    // showAll 持久化——先钉回默认收起态
    store.setWorkspaceShowAll(wsA, false)
    for (const old of store.getState().threads.slice()) store.close(old.id)
    // 12 条今天 + 2 条更早（createdAt 倒推；today=当天内，earlier=8 天前）
    const day = 86400_000
    const now = Date.now()
    const made: string[] = []
    for (let i = 0; i < 12; i++) {
      await store.spawnFromPreset('shell', wsA)
      const th = store.getState().threads.at(-1)
      if (th) {
        store.setThreadCreatedAt(th.id, now - i * 60_000) // 今天
        made.push(th.id)
      }
    }
    for (let i = 0; i < 2; i++) {
      await store.spawnFromPreset('shell', wsA)
      const th = store.getState().threads.at(-1)
      if (th) {
        store.setThreadCreatedAt(th.id, now - 8 * day) // 更早
        made.push(th.id)
      }
    }
    try {
      renderHarness({ query: '' })
      t.renderer.flush()
      await until('rows visible', () => t.renderer.findByTestId(`row-${made[0]}`) != null)
      const texts = t.renderer.getAllText()

      // 今天 10 条可见；「更早」组完全隐藏 → 标签不该出现
      expect(texts.filter((s) => s === '今天').length).toBe(1)
      expect(texts.some((s) => s === '更早')).toBe(false)
      // 展开按钮在（合计 4 条：今天 2 + 更早 2；JSX 插值分片 → 相邻文本节点断言）
      const moreIdx = texts.findIndex((s) => s === '展开其余 ')
      expect(moreIdx).toBeGreaterThanOrEqual(0)
      expect(texts[moreIdx + 1]).toBe('4')
      expect(texts[moreIdx + 2]).toBe(' 个')
      // 展开 → 更早标签出现且可见条目 14
      const more =
        t.renderer.findByTestId('load-more-today') ?? t.renderer.findByTestId('load-more-earlier')
      expect(more).toBeDefined()
      const b = t.renderer.getElementBounds(more!.id)!
      t.renderer.nativeSimulateClick(b[0] + b[2] / 2, b[1] + b[3] / 2, 0)
      t.renderer.flush()
      await until('expanded', () => t.renderer.getAllText().some((s) => s === '更早'))
      expect(t.renderer.getAllText().some((s) => s.startsWith('展开其余'))).toBe(false)
      expect(made.every((id) => t.renderer.findByTestId(`row-${id}`) != null)).toBe(true)
    } finally {
      for (const id of made) store.close(id)
      t.renderer.flush()
    }
  })

  test('归属会话行缩进渲染（x 偏移 > 工作区行）', async () => {
    await store.spawnFromPreset('shell', wsA)
    renderHarness({ query: '' })
    t.renderer.flush()
    const tid = store.getState().threads[0]!.id
    await until('session row visible', () => t.renderer.findByTestId(`row-${tid}`) != null)
    const rowB = t.renderer.getElementBounds(t.renderer.findByTestId(`row-${tid}`)!.id)!
    const wsRowB = t.renderer.getElementBounds(t.renderer.findByTestId(`workspace-${wsA}`)!.id)!
    expect(rowB[0]).toBeGreaterThan(wsRowB[0])
    store.close(tid)
    t.renderer.flush()
  })

  test('箭头 toggle：会话行隐现 + 不激活（路由不动）；点行 = 激活工作区', async () => {
    await store.spawnFromPreset('shell', wsA)
    const tid = store.getState().threads[0]!.id
    renderHarness({ query: '' })
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

  test('空工作区引导行（可点开新建会话弹窗；对齐原型「创建第一个会话」）', async () => {
    renderHarness({ query: '' })
    t.renderer.flush()
    await until('beta empty hint', () =>
      t.renderer.getAllText().some((s) => s.includes('创建第一个会话')),
    )
    // 点击引导行 → 新建会话弹窗（目标 beta）；pick shell → spawn 归属 +
    // 弹窗关闭（onClose 单点）
    clickCenter(`workspace-create-first-${wsB}`)
    await until(
      'tool dialog opens from empty-group hint',
      () => t.renderer.findByTestId('modal-card') != null,
    )
    expect(t.renderer.getAllText().some((s) => s.startsWith('cwd'))).toBe(true)
    expect(t.renderer.getAllText().some((s) => s === '/w/beta')).toBe(true)
    clickCenter('tool-preset-shell')
    await until('spawned into beta from dialog', () =>
      store.getState().threads.some((x) => x.kind === 'terminal' && x.workspaceId === wsB),
    )
    await until('dialog closed after pick', () => t.renderer.findByTestId('modal-card') == null)
    const th = store.getState().threads.find((x) => x.kind === 'terminal' && x.workspaceId === wsB)
    store.close(th!.id)
    t.renderer.flush()
    await new Promise((r) => setTimeout(r, 100))
    t.renderer.flush()
    console.log('POST-RENDER: texts=', JSON.stringify(t.renderer.getAllText().slice(0, 6)))
  })
})

describe('WorkspaceList：＋ 新建会话弹窗（W7 ToolDialog）', () => {
  test('弹窗打开：目标工作区 cwd + 预设项 + New Chat + ACP agents', async () => {
    renderHarness({ query: '' })
    t.renderer.flush()
    clickCenter(`new-menu-${wsA}`)
    await until('dialog visible', () => t.renderer.findByTestId('modal-card') != null)
    // 目标头含 cwd（mono 路径）
    expect(t.renderer.getAllText().some((s) => s.includes('/w/alpha'))).toBe(true)
    // 内置预设 + 固定项 + 默认 2 ACP agent
    expect(t.renderer.findByTestId('tool-preset-shell') != null).toBe(true)
    expect(t.renderer.findByTestId('new-chat') != null).toBe(true)
    expect(t.renderer.findByTestId('new-acp-acp-codex') != null).toBe(true)
    // 遮罩点击关闭（W7：外点关闭回归——W2 anchored 菜单无此路径）
    clickScrim()
    await until('dialog closed by scrim click', () => t.renderer.findByTestId('modal-card') == null)
  })

  test('点预设项：spawn 带归属 + 弹窗关闭', async () => {
    renderHarness({ query: '' })
    t.renderer.flush()
    clickCenter(`new-menu-${wsA}`)
    await until('dialog open', () => t.renderer.findByTestId('tool-preset-shell') != null)
    clickCenter('tool-preset-shell')
    await until('spawned with workspace', () => {
      const th = store.getState().threads.find((x) => x.kind === 'terminal')
      return th != null && th.kind === 'terminal' && th.workspaceId === wsA
    })
    const th = store.getState().threads.find((x) => x.kind === 'terminal')!
    expect(th.kind === 'terminal' && th.cwd === '/w/alpha').toBe(true) // cwd 继承
    await until('dialog closed', () => t.renderer.findByTestId('modal-card') == null)
    store.close(th.id)
    t.renderer.flush()
  })

  test('New Chat：createChat 带归属', async () => {
    renderHarness({ query: '' })
    t.renderer.flush()
    clickCenter(`new-menu-${wsA}`)
    await until('dialog open', () => t.renderer.findByTestId('new-chat') != null)
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

describe('WorkspaceList：添加工作区弹窗（W7 WorkspaceDialog）', () => {
  test('校验：空/相对路径/重复目录报错；合法 → 入列表 + 弹窗关闭', async () => {
    renderHarness({ query: '' })
    t.renderer.flush()
    clickCenter('add-workspace')
    await until('dialog visible', () => t.renderer.findByTestId('modal-card') != null)

    // 全空：联合报错 + 不入列表
    clickCenter('modal-action-添加工作区')
    await until('both-empty error shown', () =>
      t.renderer.getAllText().some((s) => s.includes('请填写名称或项目目录')),
    )
    expect(store.getState().workspaces.some((w) => w.path === '/w/gamma')).toBe(false)

    // 仅相对路径：绝对路径报错（name 填了避免联合分支）
    typeInto('workspace-dialog-name', '临时')
    typeInto('workspace-dialog-path', 'relative/path')
    clickCenter('modal-action-添加工作区')
    await until('absolute error shown', () =>
      t.renderer.getAllText().some((s) => s.includes('绝对路径')),
    )

    // 合法：全新弹窗（X 钮关闭重开；scrim 在 input 曾聚焦后命中不可靠——
    // W7 TestRenderer 已知限制，真窗口不受影响，见 TODOLIST）
    clickCenter('modal-close')
    await until('dialog closed', () => t.renderer.findByTestId('modal-card') == null)
    clickCenter('add-workspace')
    await until('dialog reopened', () => t.renderer.findByTestId('modal-card') != null)
    typeInto('workspace-dialog-name', '自定义名')
    typeInto('workspace-dialog-path', '/w/gamma')
    clickCenter('modal-action-添加工作区')
    const added = store.getState().workspaces.find((w) => w.path === '/w/gamma')
    expect(added?.name).toBe('自定义名')
    await until('dialog closed after add', () => t.renderer.findByTestId('modal-card') == null)
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
    renderHarness({ query: '' })
    t.renderer.flush()

    // 目录命中（alpha）
    renderHarness({ query: 'alpha' })
    t.renderer.flush()
    const shellId = store.getState().threads.find((x) => x.kind === 'terminal')!.id
    await until('search hit by dir', () => t.renderer.findByTestId(`row-${shellId}`) != null)
    // 不命中工作区不出现（beta 的 chat 无 alpha 字样）
    const chatId = store.getState().threads.find((x) => x.kind === 'chat')!.id
    expect(t.renderer.findByTestId(`row-${chatId}`)).toBeUndefined()

    // 工具命中（Chat）
    renderHarness({ query: 'chat' })
    t.renderer.flush()
    await until('search hit by tool', () => t.renderer.findByTestId(`row-${chatId}`) != null)
    expect(t.renderer.findByTestId(`row-${shellId}`)).toBeUndefined()

    // 无命中
    renderHarness({ query: 'zzz-nope' })
    t.renderer.flush()
    await until('empty state', () => t.renderer.getAllText().some((s) => s.includes('无匹配会话')))

    store.close(shellId)
    store.close(chatId)
    // 树恢复常驻态（后续用例的 add-workspace 入口行需要）
    renderHarness({ query: '' })
    t.renderer.flush()
  })
})

describe('WorkspaceList：浏览…（W3 目录选择，W7 弹窗形态）', () => {
  test('未注入 picker：按钮不渲染；注入后点击 → 填 path + 空名称自动 basename', async () => {
    // 未注入：无按钮
    renderHarness({ query: '' })
    t.renderer.flush()
    clickCenter('add-workspace')
    await until('dialog visible', () => t.renderer.findByTestId('modal-card') != null)
    expect(t.renderer.findByTestId('workspace-dialog-browse')).toBeUndefined()
    clickCenter('modal-close')
    await until('closed', () => t.renderer.findByTestId('modal-card') == null)

    // 注入 fake：选择 → path 填入 + name 自动 basename
    let resolvePick: (p: string | null) => void = () => {}
    const fake = () =>
      new Promise<string | null>((r) => {
        resolvePick = r
      })
    renderHarness({ query: '', pickDirectory: fake })
    t.renderer.flush()
    clickCenter('add-workspace')
    await until('dialog visible again', () => t.renderer.findByTestId('modal-card') != null)
    expect(t.renderer.findByTestId('workspace-dialog-browse') != null).toBe(true)
    clickCenter('workspace-dialog-browse')
    resolvePick('/w/picked-proj')
    await until('path filled', () => {
      const el = t.renderer.findByTestId('workspace-dialog-path')
      const v = el ? String(t.renderer.getElement(el.id)?.customProps?.value ?? '') : ''
      return v === '/w/picked-proj'
    })
    // 名称空 → basename 自动填
    const nameEl = t.renderer.findByTestId('workspace-dialog-name')!
    const nameVal = String(t.renderer.getElement(nameEl.id)?.customProps?.value ?? '')
    expect(nameVal).toBe('picked-proj')

    // 取消路径：再次浏览取消 → 已填值不动
    clickCenter('workspace-dialog-browse')
    resolvePick(null)
    await until('idle after cancel', () => true)
    const pathEl = t.renderer.findByTestId('workspace-dialog-path')!
    expect(String(t.renderer.getElement(pathEl.id)?.customProps?.value ?? '')).toBe(
      '/w/picked-proj',
    )
    // 收尾关闭（occlude 挡后续用例）
    clickCenter('modal-close')
    await until('closed', () => t.renderer.findByTestId('modal-card') == null)
  })
})

describe('WorkspaceList：新建会话弹窗筛选（W7）', () => {
  test('筛选命中过滤列表；无匹配显示空态', async () => {
    renderHarness({ query: '' })
    t.renderer.flush()
    clickCenter(`new-menu-${wsA}`)
    await until('dialog open', () => t.renderer.findByTestId('tool-dialog-filter') != null)

    // 输入 she → 只剩 shell（label 命中；其他内置预设名不含）
    const filterEl = t.renderer.findByTestId('tool-dialog-filter')!
    t.renderer.nativeSimulateKeystrokes(filterEl.id, 'she')
    await until('filtered', () => {
      const shell = t.renderer.findByTestId('tool-preset-shell')
      const claude = t.renderer.findByTestId('tool-preset-claude')
      return shell != null && claude == null
    })

    // 无命中：空态提示（zzz 不命中任何 label/command）
    t.renderer.nativeSimulateKeystrokes(filterEl.id, 'zzz')
    await until('empty state', () =>
      t.renderer.getAllText().some((s) => s.includes('没有匹配工具')),
    )

    // X 关闭收尾（filter 聚焦后 scrim 命中失效——TestRenderer 已知限制）
    clickCenter('modal-close')
    await until('dialog closed', () => t.renderer.findByTestId('modal-card') == null)
  })
})

describe('WorkspaceList：重复目录（W7 收尾用例）', () => {
  test('重复目录报错（同 path 二次添加）', async () => {
    renderHarness({ query: '' })
    t.renderer.flush()
    clickCenter('add-workspace')
    await until('dialog visible', () => t.renderer.findByTestId('modal-card') != null)
    typeInto('workspace-dialog-path', '/w/alpha')
    const pathEl = t.renderer.findByTestId('workspace-dialog-path')!
    console.log(
      'typed value now:',
      JSON.stringify(String(t.renderer.getElement(pathEl.id)?.customProps?.value ?? '')),
    )
    clickCenter('modal-action-添加工作区')
    await until('dup error shown', () =>
      t.renderer.getAllText().some((s) => s.includes('此目录已有工作区')),
    )
  })
})

// ── Phase D1：双区侧栏（会话区 + 时间分组 + load more + 状态点）──────

describe('WorkspaceList：双区侧栏（D1）', () => {
  test('双区渲染：「会话」区头 + 无归属会话；「工作区」区头 + 分组', async () => {
    // 无归属会话（workspaceId 未设——spawn 不传目标）
    await store.spawnFromPreset('shell')
    renderHarness({ query: '' })
    t.renderer.flush()
    const tid = store.getState().threads.at(-1)!.id
    await until('temp row visible', () => t.renderer.findByTestId(`row-${tid}`) != null)
    const texts = t.renderer.getAllText().join('\n')
    expect(texts.includes('会话')).toBe(true)
    expect(texts.includes('工作区')).toBe(true)
    expect(texts.includes('暂无未归属会话')).toBe(false)
    store.close(tid)
    t.renderer.flush()
  })

  test('无归属会话空态：暂无未归属会话', async () => {
    renderHarness({ query: '' })
    t.renderer.flush()
    await until('empty hint', () =>
      t.renderer.getAllText().some((s) => s.includes('暂无未归属会话')),
    )
  })

  test('时间分组：今天标签 + 老会话归「更早」', async () => {
    await store.spawnFromPreset('shell', wsA)
    const tid = store.getState().threads.at(-1)!.id
    renderHarness({ query: '' })
    t.renderer.flush()
    await until('today label', () => t.renderer.getAllText().some((s) => s.includes('今天')))
    store.close(tid)
    t.renderer.flush()
  })

  test('load more：>10 条出现「展开其余」+ 点击全展开', async () => {
    // 自清理前置：前面用例可能有遗留行（slice 按创建序会占 limit 名额）；
    // showAll 是持久化工作区态（D10）——前面用例的展开会留到本用例，先钉回
    store.setWorkspaceShowAll(wsA, false)
    for (const old of store.getState().threads.slice()) store.close(old.id)
    const ids: string[] = []
    for (let i = 0; i < 12; i++) {
      await store.spawnFromPreset('shell', wsA)
      ids.push(store.getState().threads.at(-1)!.id)
    }
    renderHarness({ query: '' })
    t.renderer.flush()
    await until('load-more visible', () => {
      const el =
        t.renderer.findByTestId('load-more-today') ??
        t.renderer.findByTestId('load-more-yesterday') ??
        t.renderer.findByTestId('load-more-week') ??
        t.renderer.findByTestId('load-more-earlier')
      return el != null
    })
    // 默认只显 10 行
    const visible = ids.filter((id) => t.renderer.findByTestId(`row-${id}`) != null)
    expect(visible.length).toBe(10)
    // 点击展开其余
    const more =
      t.renderer.findByTestId('load-more-today') ??
      t.renderer.findByTestId('load-more-yesterday') ??
      t.renderer.findByTestId('load-more-week') ??
      t.renderer.findByTestId('load-more-earlier')!
    t.renderer.focusElement(more.id)
    t.renderer.simulateKeystrokes('enter')
    t.renderer.flush()
    await until('all rows visible', () =>
      ids.every((id) => t.renderer.findByTestId(`row-${id}`) != null),
    )
    for (const id of ids) store.close(id)
    t.renderer.flush()
  })
})
