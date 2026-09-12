/**
 * plane/WorkspaceEmpty.test.tsx — 工作区起始页（Phase W；原型体验路径 6）。
 *
 * 真 createThreadStore（fake deps + 一个空工作区）+ 默认内置预设。
 * 覆盖：引导文案与快捷列表渲染 · 「新建 pi 会话」spawn 归属 ·
 * 「选择其他工具」打开新建会话弹窗（ToolDialog）· 快捷项 spawn 归属。
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
import { DialogHost, type DialogState } from './DialogHost'
import { WorkspaceEmpty } from './WorkspaceEmpty'

let t: TestRoot
let store: ThreadStore
let settings: SettingsStore
let wsId: string
/** DialogHost 可控壳：dialogState 驱动四类弹窗（本测试只用 tool） */
let dialogState: DialogState = { kind: 'none' }

function Harness() {
  const ws = store.getState().workspaces[0]!
  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', minHeight: 0 }}
    >
      <WorkspaceEmpty
        store={store}
        settings={settings}
        workspace={ws}
        dialog={{
          openToolMenu: (workspaceId) => {
            dialogState = { kind: 'tool', workspaceId }
            rerender()
          },
          openAddWorkspace: () => {},
          openSearch: () => {},
          openManageSession: () => {},
          openManageWorkspace: () => {},
          openErrors: () => {},
        }}
      />
      <DialogHost
        store={store}
        settings={settings}
        state={dialogState}
        setState={(next) => {
          dialogState = next
          rerender()
        }}
        pickDirectory={undefined}
      />
    </div>
  )
}
/** 同一 root 重复 render = rerender（createTestRoot.render 即 root.render） */
let rerender = () => t.render(createElement(Harness))
const mount = () => rerender()

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
  const ws = defaultWorkspace('/w/demo')
  wsId = ws.id
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
    { initialWorkspaces: [ws] },
  )
})

afterAll(() => {
  t?.unmount()
})

beforeEach(() => {
  void router.navigate({ to: '/workspace/$id', params: { id: wsId } })
})

describe('WorkspaceEmpty：工作区起始页', () => {
  test('引导渲染：工作区名 + path + pi 主按钮 + 其余预设快捷行', async () => {
    mount()
    t.renderer.flush()
    await until('empty page visible', () =>
      t.renderer.getAllText().some((s) => s.includes('这个工作区还没有会话')),
    )
    expect(t.renderer.getAllText().some((s) => s === 'demo')).toBe(true)
    expect(t.renderer.getAllText().some((s) => s.includes('/w/demo'))).toBe(true)
    // 快捷列表 = 非 pi 预设（内置五预设去 pi → Claude Code/Codex/Amp/Shell）
    for (const label of ['Claude Code', 'Codex', 'Amp', 'Shell']) {
      expect(t.renderer.getAllText().some((s) => s === label)).toBe(true)
    }
  })

  test('「新建 pi 会话」→ spawnFromPreset(pi, ws) + 激活', async () => {
    mount()
    t.renderer.flush()
    await until(
      'pi button visible',
      () => t.renderer.findByTestId(`workspace-new-pi-${wsId}`) != null,
    )
    clickCenter(`workspace-new-pi-${wsId}`)
    await until('thread spawned + activated', () => currentActiveThreadId() != null)
    const th = store.getState().threads[0]
    expect(th?.kind === 'terminal' && th.preset === 'pi').toBe(true)
    expect(th?.workspaceId).toBe(wsId)
    expect(store.getState().lastUsedPreset).toBe('pi')
  })

  test('「选择其他工具」→ 新建会话弹窗（ToolDialog；W7 形态）', async () => {
    mount()
    t.renderer.flush()
    await until(
      'more-tools visible',
      () => t.renderer.findByTestId(`workspace-more-tools-${wsId}`) != null,
    )
    clickCenter(`workspace-more-tools-${wsId}`)
    await until('tool dialog visible', () => t.renderer.findByTestId('modal-card') != null)
    // 弹窗内 pick 一项 → onClose 关闭 + spawn 归属（选择路径）
    clickCenter('tool-preset-shell')
    await until('shell spawned from dialog', () =>
      store.getState().threads.some((x) => x.kind === 'terminal' && x.preset === 'shell'),
    )
    await until('dialog closed', () => t.renderer.findByTestId('modal-card') == null)
    const fromMenu = store
      .getState()
      .threads.find((x) => x.kind === 'terminal' && x.preset === 'shell')
    expect(fromMenu?.workspaceId).toBe(wsId)
    store.close(fromMenu!.id)
    t.renderer.flush()
  })

  test('快捷项 → spawn 归属（Shell）', async () => {
    mount()
    t.renderer.flush()
    await until(
      'shell quick visible',
      () => t.renderer.findByTestId('workspace-quick-shell') != null,
    )
    clickCenter('workspace-quick-shell')
    await until('thread spawned', () =>
      store.getState().threads.some((x) => x.kind === 'terminal' && x.preset === 'shell'),
    )
    const th = store.getState().threads.find((x) => x.kind === 'terminal' && x.preset === 'shell')
    expect(th?.workspaceId).toBe(wsId)
    store.close(th!.id)
    t.renderer.flush()
  })
})
