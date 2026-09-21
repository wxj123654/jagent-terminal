/**
 * SessionTabs.test.tsx — 顶栏第二行会话视图 tab 条（最新原型 #tb-tabs）。
 *
 * 走 App 整树装配（TitleBar tabs 插槽 + Pane 视图调度同链锁定）：
 * 真 ThreadStore（fake PTY deps）+ 假 WorktreeStore（两个变更文件）+
 * 假 GitGraphStore（repo 空图）。chat 会话当主面（<terminal> 面 e2e 锁，
 * 本文件不重复）；shell 视图经 installTerminalElement 注册后挂载。
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { installGitGraphRowElement, installTerminalElement } from '@jagent/native'
import { createGitGraphStore } from '../../git/store'
import { createWorktreeStore } from '../../git/worktree'
import { currentActiveThreadId, navigateTarget } from '../../router'
import { memoryAdapter } from '../../settings/file'
import { createSettingsStore } from '../../settings/store'
import { builtinPresetOf } from '../../threads/presets'
import { createThreadStore, type ThreadDeps, type ThreadStore } from '../../threads/store'
import { defaultWorkspace } from '../../threads/workspaces'
import { App } from '../AgentPlane'

let t: TestRoot

beforeAll(() => {
  // 顺序敏感：custom element 工厂须先于 renderer（GitGraphView.test 同款）
  installGitGraphRowElement()
  installTerminalElement()
})

afterEach(() => {
  t?.unmount()
})

function makeDeps() {
  let next = 1
  const destroyed: number[] = []
  const deps: ThreadDeps = {
    spawnSession: async () => next++,
    destroySession: async (id) => {
      destroyed.push(id)
    },
    navigate: navigateTarget,
    notify: () => {},
    closeOnExit: () => false,
    presetOf: (id) => builtinPresetOf(id),
    activeThreadId: currentActiveThreadId,
    activeWorkspaceId: () => null,
    chatAgent: { send: () => Promise.resolve('') },
    createAcpAgent: () => ({ send: () => Promise.resolve('') }),
  }
  return { deps, destroyed }
}

function setup(): { store: ThreadStore; destroyed: number[] } {
  const { deps, destroyed } = makeDeps()
  const store = createThreadStore(deps, {
    initialWorkspaces: [defaultWorkspace('/w/proj')],
  })
  t = createTestRoot({ width: 1000, height: 700 })
  t.render(
    createElement(App, {
      store,
      settings: createSettingsStore(memoryAdapter()),
      gitStore: createGitGraphStore({
        findRepoRoot: async () => '/w/proj',
        spawnGitLog: () => ({ cancel: () => {}, done: Promise.resolve({ ok: true }) }),
        showCommitBody: async () => '',
        listChangedFiles: async () => [],
        listBranches: async () => [],
        runGit: async () => '',
      }),
      worktree: createWorktreeStore({
        status: async () => ({
          root: '/w/proj',
          branch: 'main',
          files: [
            { path: 'src/a.ts', added: 3, deleted: 1, status: 'm' },
            { path: 'README.md', added: 1, deleted: 0, status: 'a' },
          ],
        }),
        diff: async () => '',
        readFile: async () => null,
      }),
    }),
  )
  t.renderer.flush()
  return { store, destroyed }
}

const has = (testId: string) => t.renderer.findByTestId(testId) != null

function click(testId: string, button = 0) {
  const el = t.renderer.findByTestId(testId)
  if (!el) throw new Error(`not found: ${testId}`)
  const b = t.renderer.getElementBounds(el.id)!
  t.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2, button)
  t.renderer.flush()
}

async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** chat 会话（主面无 PTY；归属首个工作区）→ /thread 路由 + tab 条 */
async function spawnChat(store: ThreadStore) {
  const wsId = store.getState().workspaces[0]!.id
  store.createChat(wsId)
  await until(() => has('tab-main'))
  return store.getState().threads[0]!
}

describe('SessionTabs（原型 #tb-tabs：主面 + git/file/shell 视图）', () => {
  test('会话路由：tab-main + 「+」钮；非会话路由：ContextTab 单态页签', async () => {
    const { store } = setup()
    // 起始页 → ContextTab「主页」
    expect(has('tab-context')).toBe(true)
    expect(has('tab-main')).toBe(false)
    // 工作区起始页 → ContextTab 工作区名
    store.activate({ type: 'workspace', id: store.getState().workspaces[0]!.id })
    t.renderer.flush()
    expect(has('tab-context')).toBe(true)
    // 会话路由 → 主面 tab + 添加钮
    await spawnChat(store)
    expect(has('tab-main')).toBe(true)
    expect(has('session-add')).toBe(true)
    expect(has('tab-context')).toBe(false)
  })

  test('「+」浮层：打开 Git 图 / 打开文件；激活/回主面/×关闭闭环', async () => {
    const { store } = setup()
    await spawnChat(store)
    // 等 worktree status 落（mount 在 effect + async）
    await until(() => has('session-add'))
    click('session-add')
    expect(has('session-add-pop')).toBe(true)
    expect(has('sa-git')).toBe(true)
    expect(has('sa-shell')).toBe(true)
    await until(() => has('sa-file-src/a.ts'))
    expect(has('sa-file-README.md')).toBe(true)

    // 打开 Git 图 → git 视图激活 → Pane 整块换 GitGraphView
    click('sa-git')
    await until(() => has('git-graph-view'))
    expect(has('tab-git')).toBe(true)
    expect(store.getState().threads[0]!.activeViewId).toBe('git')
    // 浮层已随 pick 关闭
    expect(has('session-add-pop')).toBe(false)

    // 回主面 → chat 面；再点 git tab → 回图
    click('tab-main')
    expect(has('git-graph-view')).toBe(false)
    click('tab-git')
    await until(() => has('git-graph-view'))

    // 打开文件 → file 视图激活 → FileSurface
    click('session-add')
    await until(() => has('sa-file-src/a.ts'))
    click('sa-file-src/a.ts')
    await until(() => has('file-surface'))
    expect(store.getState().threads[0]!.activeViewId).toBe('file:src/a.ts')

    // × 关闭当前 file tab → 回退左邻（git）；git-graph-view 重现
    click('tab-file:src/a.ts-close')
    t.renderer.flush()
    expect(has('tab-file:src/a.ts')).toBe(false)
    expect(store.getState().threads[0]!.activeViewId).toBe('git')
    await until(() => has('git-graph-view'))

    // 中键关闭 git tab（非当前时先激活 git——直接中键关：视图移除）
    click('tab-git', 1)
    t.renderer.flush()
    expect(has('tab-git')).toBe(false)
    expect(store.getState().threads[0]!.activeViewId).toBe('main')
    expect(store.getState().threads[0]!.views).toEqual([])
  })

  test('新建 Shell：shell 视图 tab（独立 PTY）；×关闭销毁 PTY 并回退', async () => {
    const { store, destroyed } = setup()
    await spawnChat(store)
    click('session-add')
    await until(() => has('sa-shell'))
    click('sa-shell')
    // spawnSession async → 视图落后一帧
    await until(() => has('tab-shell:1'))
    const th = store.getState().threads[0]!
    expect(th.activeViewId).toBe('shell:1')
    const view = th.views![0]!
    expect(view.kind).toBe('shell')
    // 独立 PTY id（chat 会话不占 PTY，spawnSession 首个返回 1）
    if (view.kind === 'shell') expect(view.sessionId).toBe(1)
    // × 关闭 → PTY 销毁 + 回主面
    click('tab-shell:1-close')
    t.renderer.flush()
    expect(destroyed).toEqual([1])
    expect(store.getState().threads[0]!.activeViewId).toBe('main')
    expect(has('tab-shell:1')).toBe(false)
  })

  test('视图切换 retain：切走不销毁 PTY，切回重挂载同一 sessionId', async () => {
    const { store, destroyed } = setup()
    await spawnChat(store)
    click('session-add')
    await until(() => has('sa-shell'))
    click('sa-shell')
    await until(() => has('tab-shell:1'))
    const sid = t.renderer.findByType('terminal')[0]?.customProps?.sessionId
    expect(sid).toBe(1)
    // 切回主面 → 视图 PTY 不销毁（retain 在池，destroy() 只解绑元素）
    click('tab-main')
    t.renderer.flush()
    expect(destroyed).toEqual([])
    expect(t.renderer.findByType('terminal')).toHaveLength(0)
    // 切回 shell → 同 sessionId 重挂
    click('tab-shell:1')
    t.renderer.flush()
    expect(destroyed).toEqual([])
    expect(store.getState().threads[0]!.activeViewId).toBe('shell:1')
    expect(t.renderer.findByType('terminal')[0]?.customProps?.sessionId).toBe(1)
  })

  test('视图 PTY exit → 底部退出条（exitCode 文案）；closeOnExit=false', async () => {
    const { store } = setup()
    await spawnChat(store)
    click('session-add')
    await until(() => has('sa-shell'))
    click('sa-shell')
    await until(() => has('tab-shell:1'))
    expect(has('session-exited-bar')).toBe(false)
    store.onSessionEvent({ type: 'exit', sessionId: 1, code: 3 })
    t.renderer.flush()
    await until(() => has('session-exited-bar'))
    expect([...t.renderer.getAllText()].join('\n')).toContain('exit code 3')
  })

  test('空变更工作区：「打开文件」列表显示空态文案', async () => {
    const { deps } = makeDeps()
    const store = createThreadStore(deps, {
      initialWorkspaces: [defaultWorkspace('/w/proj')],
    })
    t = createTestRoot({ width: 1000, height: 700 })
    t.render(
      createElement(App, {
        store,
        settings: createSettingsStore(memoryAdapter()),
        gitStore: createGitGraphStore({
          findRepoRoot: async () => null,
          spawnGitLog: () => {
            throw new Error('不应 spawn')
          },
          showCommitBody: async () => '',
          listChangedFiles: async () => [],
          listBranches: async () => [],
          runGit: async () => '',
        }),
        worktree: createWorktreeStore({
          status: async () => null,
          diff: async () => '',
          readFile: async () => null,
        }),
      }),
    )
    t.renderer.flush()
    await spawnChat(store)
    click('session-add')
    expect(has('session-add-pop')).toBe(true)
    const texts = [...t.renderer.getAllText()].join('\n')
    expect(texts).toContain('当前工作区无变更文件')
  })
})
