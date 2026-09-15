/**
 * plane/WorkspaceList.test.tsx — Phase W2 侧栏工作区分组树测试。
 *
 * 真 createThreadStore（fake deps + 两个初始工作区）+ TestGpuixRenderer。
 * 覆盖：分组渲染与缩进 · 箭头 toggle（不激活）/ 点行激活 · ＋ 工具菜单
 * （目标工作区头 + spawn 归属）· 添加工作区内联表单。
 * 重命名走上下文菜单 Rename… → RenameDialog（行内双击编辑已移除）；
 * rename 规则在 store.test 已覆盖。跨工作区搜索在 W7 起归
 * SearchDialog（workspaces.searchThreads 单测覆盖查询语义）。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement, useState } from 'react'

import { currentActiveThreadId, navigateTarget, router } from '../../router'
import { memoryAdapter } from '../../settings/file'
import { createSettingsStore, type SettingsStore } from '../../settings/store'
import { builtinPresetOf } from '../../threads/presets'
import { createThreadStore, type ThreadStore } from '../../threads/store'
import { defaultWorkspace } from '../../threads/workspaces'
import { DialogHost } from '../DialogHost'
import { WorkspaceList } from '../WorkspaceList'

let t: TestRoot
let store: ThreadStore
let settings: SettingsStore
let wsA: string // 默认 expanded 工作区
let wsB: string
let nowMs = Date.now() // 注入 store 的可变时钟（跨时间组用例拨动）

/** DialogHost 可控态镜像（测试读取用；真状态在 Harness useState——React
 *  自调度 rerender。W7 教训：事件回调里手动 root.render 会打断渲染管线，
 *  后续树渲染成空） */
let dialogState: {
  kind: string
  workspaceId?: string
  target?: { type: 'thread' | 'workspace'; id: string }
} = { kind: 'none' }
const mirror = (next: typeof dialogState) => {
  dialogState = next
  return next
}

/** picker 可变壳（main.tsx 的 picker 注入等价） */
function Harness({ pickDirectory }: { pickDirectory?: () => Promise<string | null> }) {
  // dialog 状态在组件内（同类型 Harness 跨 t.render 保留——React diff 语义）
  const [dialog, setDialog] = useState({ kind: 'none' } as typeof dialogState)
  const open = (next: typeof dialogState) => setDialog(mirror(next))
  const dialogOpener = {
    openToolMenu: (workspaceId: string) => open({ kind: 'tool', workspaceId }),
    openAddWorkspace: () => open({ kind: 'addWorkspace' }),
    openSearch: () => open({ kind: 'search' }),
    openRename: (target: { type: 'thread' | 'workspace'; id: string }) =>
      open({ kind: 'rename', target }),
    openErrors: () => open({ kind: 'errors' }),
  }
  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', minHeight: 0 }}
    >
      <WorkspaceList store={store} dialog={dialogOpener} />
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
const renderHarness = (props: { pickDirectory?: () => Promise<string | null> } = {}) => {
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
  t.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2, 0)
  t.renderer.flush()
}

/** scrim 点击（带 blur 规避：GPUUIX input 聚焦中时 nativeSimulateClick
 *  到 scrim 的命中被吞——W7 实测；先 blur 再点）。弹窗真居中后 scrim
 *  几何中心被卡片盖住——点左上角（卡片外区域） */
/** eslint-disable @typescript-eslint/no-explicit-any -- TestRenderer 无 blur 类型（native 有） */
function clickScrim() {
  ;(t.renderer as any).blur?.()
  const el = t.renderer.findByTestId('modal-scrim')
  if (!el) throw new Error('element not found: modal-scrim')
  const b = t.renderer.getElementBounds(el.id)!
  t.renderer.nativeSimulateClick(b.x + 10, b.y + 10, 0)
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
      now: () => nowMs,
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
    renderHarness()
    t.renderer.flush()
    await until('workspace rows visible', () => {
      const na = t.renderer.findByTestId(`workspace-name-${wsA}`)
      const nb = t.renderer.findByTestId(`workspace-name-${wsB}`)
      return na != null && nb != null
    })
    expect(t.renderer.getAllText().some((s) => s.includes('alpha'))).toBe(true)
    expect(t.renderer.getAllText().some((s) => s.includes('beta'))).toBe(true)
  })

  // 方案 C：组内 priority 排序（pin > run > queue > unread > recency）+
  // 默认前 4 条 + Show more/less；active/focus 行不被截断。
  test('超 4 条截断：默认前 4 + 「展开其余 N 个」合计正确；展开全显', async () => {
    // 自清理前置：前面用例可能有遗留行（会占 limit 名额）；
    // showAll 持久化——先钉回默认收起态
    store.setWorkspaceShowAll(wsA, false)
    for (const old of store.getState().threads.slice()) store.close(old.id)
    // 注入时钟拉开 createdAt（同毫秒并列会让稳定排序保持创建序，
    // active 行落截断外触发 lim 扩展——干扰断言）
    const base = Date.now()
    const made: string[] = []
    for (let i = 0; i < 6; i++) {
      nowMs = base + i * 1000
      await store.spawnFromPreset('shell', wsA)
      const th = store.getState().threads.at(-1)
      if (th) made.push(th.id)
    }
    nowMs = Date.now()
    try {
      renderHarness()
      t.renderer.flush()
      // recency 新→旧：made[5] 在首位可见；made[0]（最旧）被截断
      await until('rows visible', () => t.renderer.findByTestId(`row-${made[5]}`) != null)
      const texts = t.renderer.getAllText()

      // 默认 4 条可见；「展开其余 2 个」（JSX 插值分片 → 相邻文本节点断言）
      const moreIdx = texts.findIndex((s) => s === '展开其余 ')
      expect(moreIdx).toBeGreaterThanOrEqual(0)
      expect(texts[moreIdx + 1]).toBe('2')
      expect(texts[moreIdx + 2]).toBe(' 个')
      const visible = made.filter((id) => t.renderer.findByTestId(`row-${id}`) != null)
      expect(visible.length).toBe(4)
      // filter 保留创建序——比集合不比顺序（排序后可见集 = recency 最新 4 条）
      expect(new Set(visible)).toEqual(new Set([made[5], made[4], made[3], made[2]]))
      // 展开 → 全部 6 条可见 + 「只显示前 4 个」
      const more = t.renderer.findByTestId(`load-more-${wsA}`)
      expect(more).toBeDefined()
      const b = t.renderer.getElementBounds(more!.id)!
      t.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2, 0)
      t.renderer.flush()
      await until('expanded', () =>
        made.every((id) => t.renderer.findByTestId(`row-${id}`) != null),
      )
      expect(t.renderer.getAllText().some((s) => s.startsWith('只显示前'))).toBe(true)
    } finally {
      for (const id of made) store.close(id)
      t.renderer.flush()
    }
  })

  test('priority 排序：pin 行排最前；active 行不被截断（lim 自动扩展）', async () => {
    store.setWorkspaceShowAll(wsA, false)
    for (const old of store.getState().threads.slice()) store.close(old.id)
    const base = Date.now()
    const made: string[] = []
    for (let i = 0; i < 6; i++) {
      nowMs = base + i * 1000 // 拉开 createdAt（同毫秒并列干扰排序断言）
      await store.spawnFromPreset('shell', wsA)
      made.push(store.getState().threads.at(-1)!.id)
    }
    nowMs = Date.now()
    try {
      // 最旧的一条 pin → 排序后应进前 4（recency 最末被 pin 提升）
      store.setThreadPinned(made[0]!, true)
      renderHarness()
      t.renderer.flush()
      await until('rows visible', () => t.renderer.findByTestId(`row-${made[0]}`) != null)
      const visible = made.filter((id) => t.renderer.findByTestId(`row-${id}`) != null)
      expect(visible).toContain(made[0]) // pin 提升进前 4
      expect(visible.length).toBe(4)

      // active 行不被截断：取消 pin 后激活排序第 5 位（made[1]，
      // recency 倒数第二）→ lim 扩展到 5，该行保持可见
      store.setThreadPinned(made[0]!, false)
      store.activate({ type: 'thread', id: made[1]! })
      await until('5th-priority row kept visible', () => {
        const vis = made.filter((id) => t.renderer.findByTestId(`row-${id}`) != null)
        return vis.length === 5 && vis.includes(made[1]!)
      })
    } finally {
      for (const id of made) store.close(id)
      t.renderer.flush()
    }
  })

  test('归属会话行缩进渲染（x 偏移 > 工作区行）', async () => {
    await store.spawnFromPreset('shell', wsA)
    renderHarness()
    t.renderer.flush()
    const tid = store.getState().threads[0]!.id
    await until('session row visible', () => t.renderer.findByTestId(`row-${tid}`) != null)
    const rowB = t.renderer.getElementBounds(t.renderer.findByTestId(`row-${tid}`)!.id)!
    const wsRowB = t.renderer.getElementBounds(t.renderer.findByTestId(`workspace-${wsA}`)!.id)!
    expect(rowB.x).toBeGreaterThan(wsRowB.x)
    store.close(tid)
    t.renderer.flush()
  })

  test('箭头 toggle：会话行隐现 + 不激活（路由不动）；点行 = 激活工作区', async () => {
    await store.spawnFromPreset('shell', wsA)
    const tid = store.getState().threads[0]!.id
    renderHarness()
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
    renderHarness()
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
    // cwd 在 tool-ctx 行右侧（原型 .cwd：mono 路径，无「cwd」前缀）
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
    renderHarness()
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
    renderHarness()
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
    renderHarness()
    t.renderer.flush()
    clickCenter(`new-menu-${wsA}`)
    await until('dialog open', () => t.renderer.findByTestId('new-chat') != null)
    // 原型 .tool-list max-height 320：「对话」组在视口下——先滚到底再点
    const list = t.renderer.findByTestId('tool-list')!
    t.renderer.scrollTo(list.id, 0, -100000)
    t.renderer.flush()
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
    renderHarness()
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

describe('WorkspaceList：浏览…（W3 目录选择，W7 弹窗形态）', () => {
  test('未注入 picker：按钮不渲染；注入后点击 → 填 path + 空名称自动 basename', async () => {
    // 未注入：无按钮
    renderHarness()
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
    renderHarness({ pickDirectory: fake })
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
    renderHarness()
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
    renderHarness()
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

// ── 方案 C：nav 行组 + 未归属组 + 上下文菜单（codex-sidebar-v2）──────

describe('WorkspaceList：方案 C 结构', () => {
  test('nav 行组：新建会话 / 搜索两行渲染；搜索行 → openSearch', async () => {
    renderHarness()
    t.renderer.flush()
    // 前用例可能留开着的弹窗（遮罩吞点击）——先关
    if (t.renderer.findByTestId('modal-card') != null) {
      clickCenter('modal-close')
      await until('dialog closed', () => t.renderer.findByTestId('modal-card') == null)
    }
    await until('nav rows visible', () => t.renderer.findByTestId('nav-new-chat') != null)
    expect(t.renderer.findByTestId('nav-search') != null).toBe(true)
    expect(t.renderer.getAllText().some((s) => s === '新建会话')).toBe(true)
    expect(t.renderer.getAllText().some((s) => s === '搜索')).toBe(true)
    clickCenter('nav-search')
    await until('search dialog opened', () => dialogState.kind === 'search')
    // 收尾：遮罩点击关弹窗（SearchDialog 无 X 钮；不关会吞后续用例点击）
    clickScrim()
    await until('search dialog closed', () => t.renderer.findByTestId('modal-card') == null)
  })

  test('无归属会话归入「未归属」虚拟组（无独立「会话」区头）', async () => {
    await store.spawnFromPreset('shell') // 不传 workspaceId → 未归属
    renderHarness()
    t.renderer.flush()
    const tid = store.getState().threads.at(-1)!.id
    await until(
      'unassigned group visible',
      () => t.renderer.findByTestId('workspace-unassigned') != null,
    )
    expect(t.renderer.findByTestId(`row-${tid}`) != null).toBe(true)
    expect(t.renderer.getAllText().some((s) => s === '未归属')).toBe(true)
    // 虚拟组无 … 菜单（不可 pin/rename/remove）
    expect(t.renderer.findByTestId('menu-workspace-unassigned')).toBeUndefined()
    store.close(tid)
    t.renderer.flush()
    await until(
      'unassigned group gone',
      () => t.renderer.findByTestId('workspace-unassigned') == null,
    )
  })

  test('未归属组：点组名激活最高优先级会话；箭头仅折叠', async () => {
    await store.spawnFromPreset('shell')
    const tid = store.getState().threads.at(-1)!.id
    renderHarness()
    t.renderer.flush()
    await until('unassigned row visible', () => t.renderer.findByTestId(`row-${tid}`) != null)
    // 箭头折叠：行消失 + 不导航
    void router.navigate({ to: '/' })
    clickCenter('workspace-toggle-unassigned')
    await until('collapsed', () => t.renderer.findByTestId(`row-${tid}`) == null)
    expect(currentActiveThreadId()).toBeNull()
    // 展开 + 点组名 → 激活该会话
    clickCenter('workspace-toggle-unassigned')
    await until('expanded', () => t.renderer.findByTestId(`row-${tid}`) != null)
    clickCenter('workspace-unassigned')
    await until('activated', () => currentActiveThreadId() === tid)
    store.close(tid)
    t.renderer.flush()
  })

  test('会话行「…」→ 上下文菜单：Pin / Rename / Mark as unread / Remove', async () => {
    await store.spawnFromPreset('shell', wsA)
    const tid = store.getState().threads.at(-1)!.id
    renderHarness()
    t.renderer.flush()
    await until('row visible', () => t.renderer.findByTestId(`row-${tid}`) != null)
    clickCenter(`menu-thread-${tid}`)
    await until('context menu open', () => t.renderer.findByTestId('context-menu') != null)
    for (const id of ['ctx-pin', 'ctx-rename', 'ctx-unread', 'ctx-remove']) {
      expect(t.renderer.findByTestId(id) != null).toBe(true)
    }
    // Mark as unread → 行加粗点出现
    clickCenter('ctx-unread')
    await until('unread dot', () => t.renderer.findByTestId('dot-unread') != null)
    expect(store.getState().threads.find((x) => x.id === tid)?.unread).toBe(true)
    // 再开菜单 → Pin
    clickCenter(`menu-thread-${tid}`)
    await until('menu again', () => t.renderer.findByTestId('context-menu') != null)
    clickCenter('ctx-pin')
    await until('pinned', () => store.getState().threads.find((x) => x.id === tid)?.pin === true)
    store.close(tid)
    t.renderer.flush()
  })

  test('会话行右键（auxClick）→ 同一面菜单；Remove 关闭会话', async () => {
    await store.spawnFromPreset('shell', wsA)
    const tid = store.getState().threads.at(-1)!.id
    renderHarness()
    t.renderer.flush()
    await until('row visible', () => t.renderer.findByTestId(`row-${tid}`) != null)
    const row = t.renderer.findByTestId(`row-${tid}`)!
    const b = t.renderer.getElementBounds(row.id)!
    // 右键（button=2）→ auxClick → 菜单
    t.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2, 2)
    t.renderer.flush()
    await until('context menu open', () => t.renderer.findByTestId('context-menu') != null)
    clickCenter('ctx-remove')
    await until('thread removed', () => !store.getState().threads.some((x) => x.id === tid))
  })

  test('工作区行「…」→ 项目菜单：Pin / Rename / Remove；Rename 开重命名弹窗', async () => {
    renderHarness()
    t.renderer.flush()
    await until('ws row visible', () => t.renderer.findByTestId(`workspace-${wsB}`) != null)
    clickCenter(`menu-workspace-${wsB}`)
    await until('context menu open', () => t.renderer.findByTestId('context-menu') != null)
    for (const id of ['ctx-pin', 'ctx-rename', 'ctx-remove']) {
      expect(t.renderer.findByTestId(id) != null).toBe(true)
    }
    clickCenter('ctx-rename')
    await until('rename dialog opened', () => dialogState.kind === 'rename')
    expect(dialogState.target).toEqual({ type: 'workspace', id: wsB })
  })

  test('工作区 pin：排序提前（pin 的工作区排最前）', async () => {
    store.setWorkspacePinned(wsB, true)
    renderHarness()
    t.renderer.flush()
    await until('ws rows visible', () => t.renderer.findByTestId(`workspace-${wsB}`) != null)
    const aB = t.renderer.getElementBounds(t.renderer.findByTestId(`workspace-${wsA}`)!.id)!
    const bB = t.renderer.getElementBounds(t.renderer.findByTestId(`workspace-${wsB}`)!.id)!
    expect(bB.y).toBeLessThan(aB.y) // pin 的 beta 在 alpha 上方
    store.setWorkspacePinned(wsB, false)
    t.renderer.flush()
  })
})
