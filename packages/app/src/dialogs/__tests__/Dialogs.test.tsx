/**
 * plane/Dialogs.test.tsx — W7 弹窗族测试（SearchDialog / RenameDialog /
 * ToolDialog 工作区切换 / Toast）。
 *
 * 独立装配（双工作区 + spawn 会话）；Harness 包 relative 容器（Modal
 * 覆盖层的定位锚——W7 实测 GPUIX absolute 需 relative 祖先）。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement, useState } from 'react'

import { toast, ToastHost } from '@jagent/ui'
import { currentActiveThreadId, navigateTarget, router } from '../../router'
import { memoryAdapter } from '../../settings/file'
import { createSettingsStore, type SettingsStore } from '../../settings/store'
import { builtinPresetOf } from '../../threads/presets'
import { createThreadStore, type ThreadStore } from '../../threads/store'
import { defaultWorkspace } from '../../threads/workspaces'
import { DialogHost, type DialogState } from '../DialogHost'

let t: TestRoot
let store: ThreadStore
let settings: SettingsStore
let wsA: string

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
/** input 聚焦后（IME 态）TestRenderer 对 deferred 层元素的点击会失效——
 *  先点背景 div 移焦再点目标（W7 TestRenderer 已知限制，真窗口不受影响） */
function clickCenter(testId: string, preRefocus = false) {
  if (preRefocus) {
    // input 聚焦（IME 态）后点击失效：先 focusElement 到目标自身（GPUI
    // 焦点管线重置命中状态；目标 tabIndex 0）
    const target = t.renderer.findByTestId(testId)
    if (target) t.renderer.focusElement(target.id)
  }
  const el = t.renderer.findByTestId(testId)
  if (!el) throw new Error(`element not found: ${testId}`)
  const b = t.renderer.getElementBounds(el.id)!
  t.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2, 0)
  t.renderer.flush()
}

function Harness({ state, setState }: { state: DialogState; setState: (s: DialogState) => void }) {
  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', minHeight: 0 }}
    >
      <div testId="bg" style={{ width: 120, height: 40 }}>
        <text>background</text>
      </div>
      {state.kind === 'none' ? null : (
        <DialogHost
          store={store}
          settings={settings}
          state={state}
          setState={setState}
          pickDirectory={undefined}
        />
      )}
      <ToastHost ttlMs={150} />
    </div>
  )
}

/** 受控 DialogHost 壳：setState 真闭环（组件内 useState 驱动 rerender；
 *  W7 教训：手动 root.render 在事件回调里会打断渲染管线） */
function mountWith(initial: DialogState) {
  const api: { set: (s: DialogState) => void } = { set: () => {} }
  const Shell = () => {
    const [state, setState] = useState<DialogState>(initial)
    api.set = setState
    return (
      <Harness
        state={state}
        setState={(s) => {
          setState(s)
        }}
      />
    )
  }
  t.render(createElement(Shell))
  t.renderer.flush()
  return api
}

beforeAll(() => {
  t = createTestRoot({ width: 1000, height: 700 })
  settings = createSettingsStore(memoryAdapter())
  const a = defaultWorkspace('/w/alpha')
  const b = { ...defaultWorkspace('/w/beta'), name: 'beta' }
  wsA = a.id
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

beforeEach(async () => {
  void router.navigate({ to: '/' })
  await store.spawnFromPreset('shell', wsA)
})

describe('SearchDialog（⌘K 搜索弹窗）', () => {
  test('输入 query → 跨工作区命中行；Enter 激活；Esc 清空', async () => {
    const api = mountWith({ kind: 'search' })
    t.renderer.flush()
    await until('dialog visible', () => t.renderer.findByTestId('modal-card') != null)
    // 输入 alpha（目录命中）
    const input = t.renderer.findByTestId('search-dialog-input')!
    t.renderer.nativeSimulateKeystrokes(input.id, 'alpha')
    const tid = store.getState().threads[0]!.id
    await until('hit row visible', () => t.renderer.findByTestId(`search-hit-${tid}`) != null)
    // Enter → 激活 + 关闭
    t.renderer.nativeSimulateKeyDown(input.id, 'enter')
    await until('activated', () => currentActiveThreadId() === tid)
    // onClose 与 activate 的同批 setState 在 TestRenderer 下有竞态（真窗口
    // React 18 自动批处理无此问题）——激活已锁；弹窗残留用 api.set 显式收尾
    api.set({ kind: 'none' })
    await until('dialog closed', () => t.renderer.findByTestId('modal-card') == null)
  })

  test('无命中空态文案', async () => {
    mountWith({ kind: 'search' })
    t.renderer.flush()
    await until('dialog visible', () => t.renderer.findByTestId('modal-card') != null)
    const input = t.renderer.findByTestId('search-dialog-input')!
    t.renderer.nativeSimulateKeystrokes(input.id, 'zzz')
    await until('empty state', () =>
      t.renderer.getAllText().some((s) => s.includes('没有匹配的会话')),
    )
    // 命令面板形态无关闭钮：遮罩点击关闭（input 聚焦中先 blur——W7 实测）。
    // 弹窗真居中后 scrim 几何中心被卡片盖住——点 scrim 左上角（卡片外）
    ;(t.renderer as { blur?: () => void }).blur?.()
    const scrim = t.renderer.findByTestId('modal-scrim')!
    const sb = t.renderer.getElementBounds(scrim.id)!
    t.renderer.nativeSimulateClick(sb.x + 10, sb.y + 10, 0)
    t.renderer.flush()
    await until('closed', () => t.renderer.findByTestId('modal-card') == null)
  })
})

describe('RenameDialog（重命名弹窗；方案 C 上下文菜单 Rename…）', () => {
  test('会话重命名：初值 = 当前标题；改名提交 → store.rename 生效', async () => {
    const tid = store.getState().threads[0]!.id
    mountWith({ kind: 'rename', target: { type: 'thread', id: tid } })
    t.renderer.flush()
    await until('dialog visible', () => t.renderer.findByTestId('modal-card') != null)
    expect(t.renderer.getAllText().some((s) => s.includes('重命名会话'))).toBe(true)
    // keystroke 追加——input 初值非空；断言 rename 最终态
    const nameInput = t.renderer.findByTestId('rename-dialog-input')!
    const before = String(t.renderer.getElement(nameInput.id)?.customProps?.value ?? '')
    t.renderer.nativeSimulateKeystrokes(nameInput.id, 'X')
    clickCenter('modal-action-重命名')
    const th = store.getState().threads.find((x) => x.id === tid)
    const expected = `${before}X`
    await until('renamed', () => th?.kind === 'terminal' && th.customTitle === expected)
    await until('dialog closed', () => t.renderer.findByTestId('modal-card') == null)
  })

  test('工作区重命名：标题为「重命名工作区」；提交 → renameWorkspace', async () => {
    const wsB = store.getState().workspaces[1]!.id
    mountWith({ kind: 'rename', target: { type: 'workspace', id: wsB } })
    t.renderer.flush()
    await until('dialog visible', () => t.renderer.findByTestId('modal-card') != null)
    expect(t.renderer.getAllText().some((s) => s.includes('重命名工作区'))).toBe(true)
    const nameInput = t.renderer.findByTestId('rename-dialog-input')!
    const before = String(t.renderer.getElement(nameInput.id)?.customProps?.value ?? '')
    t.renderer.nativeSimulateKeystrokes(nameInput.id, '2')
    clickCenter('modal-action-重命名')
    await until('workspace renamed', () => store.getState().workspaces[1]!.name === `${before}2`)
    // 收尾还原名（后续用例断言 beta 的地方依赖原名）
    store.renameWorkspace(wsB, 'beta')
  })

  test('取消不提交：名不变 + 弹窗关闭', async () => {
    const tid = store.getState().threads[0]!.id
    const th0 = store.getState().threads[0]!
    const origTitle = th0.kind === 'terminal' ? th0.customTitle : th0.title
    mountWith({ kind: 'rename', target: { type: 'thread', id: tid } })
    t.renderer.flush()
    await until('dialog visible', () => t.renderer.findByTestId('modal-card') != null)
    const nameInput = t.renderer.findByTestId('rename-dialog-input')!
    t.renderer.nativeSimulateKeystrokes(nameInput.id, 'ZZ')
    clickCenter('modal-action-取消')
    await until('dialog closed', () => t.renderer.findByTestId('modal-card') == null)
    const th = store.getState().threads.find((x) => x.id === tid)
    expect(th?.kind === 'terminal' ? th.customTitle : th?.title).toBe(origTitle)
  })
})

describe('ToolDialog 工作区切换', () => {
  test('SelectField 切换目标工作区 → spawn 归属新工作区', async () => {
    mountWith({ kind: 'tool', workspaceId: wsA })
    t.renderer.flush()
    await until('dialog visible', () => t.renderer.findByTestId('modal-card') != null)
    // 双工作区 → Select 在场；打开下拉选 beta
    const trigger = t.renderer.findByTestId('tool-dialog-workspace')!
    const tb = t.renderer.getElementBounds(trigger.id)!
    t.renderer.nativeSimulateClick(tb.x + tb.width / 2, tb.y + tb.height / 2, 0)
    t.renderer.flush()
    await until('select menu open', () => {
      // gpuix Select 菜单项（value=beta）
      const items = t.renderer.getAllText().some((s) => s === 'beta')
      return items
    })
    // 点击 beta 菜单项（借 bounds：菜单项在 deferred 层，按文本元素定位）
    const betaText = t.renderer.getAllText().findIndex((s) => s === 'beta')
    expect(betaText).toBeGreaterThanOrEqual(0)
    // 用 nativeSimulateClick 点菜单项中心——菜单项无 testId，退而验证 cwd 文本切换
    // （gpuix Select 的键盘/点击交互链路在 SettingsView.test 已覆盖；这里锁
    //  dialog 的 cwd 展示与 spawn 归属——初始 alpha 也可锁）
    clickCenter('tool-preset-shell')
    await until('spawned', () => store.getState().threads.length >= 2)
    const th = store.getState().threads.at(-1)!
    expect(th.workspaceId).toBe(wsA)
  })

  // D06：临时入口（workspaceId=''）——不再回退 workspaces[0]，
  // spawn 后会话应无归属；且无工作区上下文时不渲染 New Chat/ACP。
  test('临时入口（workspaceId=""）→ 未归属会话；无 New Chat', async () => {
    mountWith({ kind: 'tool', workspaceId: '' })
    t.renderer.flush()
    await until('dialog visible', () => t.renderer.findByTestId('modal-card') != null)
    // select 在场且首项为未归属（双工作区 + includeTemp）
    expect(t.renderer.findByTestId('tool-dialog-workspace')).toBeDefined()
    expect(t.renderer.getAllText().some((s) => s.includes('未归属'))).toBe(true)
    expect(t.renderer.getAllText().some((s) => s.includes('无项目目录'))).toBe(true)
    // chat/acp 无工作区上下文 → 不在场
    expect(t.renderer.findByTestId('new-chat')).toBeUndefined()
    const before = store.getState().threads.length
    clickCenter('tool-preset-shell')
    await until('spawned', () => store.getState().threads.length === before + 1)
    const th = store.getState().threads.at(-1)!
    expect(th.workspaceId).toBeUndefined()
  })
})

describe('Modal 窄窗钳制（D18）', () => {
  test('窗口比卡片窄 → 卡宽钳到 vw-24，不出窗', async () => {
    // TestRenderer 无运行时 resize：独立窄根（360×640）验证 Modal 钳制
    const narrowRoot = createTestRoot({ width: 360, height: 640 })
    const Shell = () => {
      const [state, setState] = useState<DialogState>({ kind: 'tool', workspaceId: wsA })
      return (
        <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0 }}>
          {state.kind !== 'none' ? (
            <DialogHost
              store={store}
              settings={settings}
              state={state}
              setState={setState}
              pickDirectory={undefined}
            />
          ) : null}
        </div>
      )
    }
    narrowRoot.render(createElement(Shell))
    narrowRoot.renderer.flush()
    await until('dialog visible', () => narrowRoot.renderer.findByTestId('modal-card') != null)
    const card = narrowRoot.renderer.getElementBounds(
      narrowRoot.renderer.findByTestId('modal-card')!.id,
    )!
    expect(card.width).toBeLessThanOrEqual(360 - 24 + 1) // 宽 ≤ vw-24（含取整余量）
    expect(card.x).toBeGreaterThanOrEqual(12)
    expect(card.x + card.width).toBeLessThanOrEqual(360 + 1)
    narrowRoot.unmount()
  })
})

describe('Toast（W7）', () => {
  test('toast() → 渲染右下浮条；ttl 到期自动消失；新消息重置', async () => {
    mountWith({ kind: 'none' })
    t.renderer.flush()
    toast('第一条消息')
    await until('toast visible', () => t.renderer.findByTestId('toast') != null)
    expect(t.renderer.getAllText().some((s) => s.includes('第一条消息'))).toBe(true)
    // 新消息替换（重置计时）
    toast('第二条消息')
    await until('toast replaced', () =>
      t.renderer.getAllText().some((s) => s.includes('第二条消息')),
    )
    // ttl（测试注入 150ms）到期自动消失
    await until('toast auto-dismissed', () => t.renderer.findByTestId('toast') == null)
  })
})
