/**
 * git/components/GitGraphView.test.tsx — Git 图表面集成测试（TestRenderer）。
 *
 * 真 ThreadStore + 真 WorkspacePage 壳 + 假 GitGraphStore deps：锁 tab 切换、
 * not-a-repo 空态、行渲染、点击选中 → 详情列、Esc 经全局层（此处测 store 面）。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { WorkspacePage } from '../../plane/WorkspacePage'
import { memoryAdapter } from '../../settings/file'
import { createSettingsStore, type SettingsStore } from '../../settings/store'
import { createThreadStore, type ThreadStore } from '../../threads/store'
import type { GraphCommit } from '../cli'
import { createGitGraphStore } from '../store'

let t: TestRoot
let store: ThreadStore
let settings: SettingsStore
let pushChunk: ((cs: GraphCommit[]) => void) | null = null
let finishLog: ((ok: boolean) => void) | null = null

const c = (sha: string, parents: string[]): GraphCommit => ({
  sha,
  parents,
  refNames: sha === 'a' ? ['HEAD -> main'] : [],
  shortSha: sha.slice(0, 7),
  authorName: 'wxj',
  timestamp: 1_800_000_000,
  subject: `subject ${sha}`,
})

beforeAll(() => {
  t = createTestRoot({ width: 1000, height: 700 })
  settings = createSettingsStore(memoryAdapter())
  store = createThreadStore({
    spawnSession: async () => 0,
    destroySession: async () => {},
    navigate: () => {},
    notify: () => {},
    closeOnExit: () => false,
    presetOf: () => undefined,
    chatAgent: { send: () => Promise.resolve('') },
    createAcpAgent: () => ({ send: () => Promise.resolve('') }),
  })
  store.addWorkspace('demo', '/repo/demo')
})

afterAll(() => {
  t?.unmount()
})

function renderPage() {
  const gitStore = createGitGraphStore({
    findRepoRoot: async () => '/repo/demo',
    spawnGitLog: (_cwd, onChunk) => {
      pushChunk = onChunk
      return {
        cancel: () => {},
        done: new Promise<{ ok: boolean; error?: string }>((resolve) => {
          finishLog = (ok) => resolve({ ok, error: ok ? undefined : 'boom' })
        }),
      }
    },
    showPatch: async (_cwd, sha) => `PATCH-${sha}`,
  })
  const ws = store.getState().workspaces[0]!
  t.render(
    createElement(WorkspacePage, {
      store,
      settings,
      workspace: ws,
      dialog: {
        openToolMenu: () => {},
        openAddWorkspace: () => {},
        openSearch: () => {},
        openManageSession: () => {},
        openErrors: () => {},
      },
      gitStore,
    }),
  )
  t.renderer.flush()
  return gitStore
}

const texts = () => t.renderer.getAllText().join('\n')
const has = (testId: string) => t.renderer.findByTestId(testId) != null

async function until(ms = 0) {
  await new Promise((r) => setTimeout(r, ms))
  t.renderer.flush()
}

/** 中心点点击（GPUI hit-test 全管线，ui.test.tsx 同款）；bounds 未就绪时重试 */
async function click(testId: string) {
  const el = t.renderer.findByTestId(testId)
  expect(el, `element not found: ${testId}`).toBeDefined()
  let b: number[] | null | undefined = null
  // bounds 就绪需要 layout 帧同步（React 提交 macrotask 让出，时序三律）
  for (let i = 0; i < 20 && !b; i++) {
    b = t.renderer.getElementBounds(el!.id)
    if (!b) {
      await new Promise<void>((r) => setTimeout(r, 5))
      t.renderer.flush()
    }
  }
  expect(b, `no bounds: ${testId}`).toBeDefined()
  t.renderer.nativeSimulateClick(b![0] + b![2] / 2, b![1] + b![3] / 2)
}

describe('WorkspacePage tab 切换', () => {
  test('默认 home tab → 起始页；点 Git 图 → git-graph-view', async () => {
    renderPage()
    await until()
    expect(has('workspace-tab-home')).toBe(true)
    expect(has('workspace-tab-git')).toBe(true)
    expect(has('git-graph-view')).toBe(false)

    await click('workspace-tab-git')
    await until()
    expect(has('git-graph-view')).toBe(true)
    // tab 状态持久化（persistWorkspaces 未注入 deps → 仅内存，但 getState 可查）
    expect(store.getState().workspaces[0]!.paneTab).toBe('git')

    await click('workspace-tab-home')
    await until()
    expect(has('git-graph-view')).toBe(false)
  })
})

describe('GitGraphView 渲染与选中', () => {
  test('非 repo 空态', async () => {
    const gitStore = createGitGraphStore({
      findRepoRoot: async () => null,
      spawnGitLog: () => {
        throw new Error('不应 spawn')
      },
      showPatch: async () => '',
    })
    const ws = store.getState().workspaces[0]!
    t.render(
      createElement(WorkspacePage, {
        store,
        settings,
        workspace: ws,
        dialog: {
          openToolMenu: () => {},
          openAddWorkspace: () => {},
          openSearch: () => {},
          openManageSession: () => {},
          openErrors: () => {},
        },
        gitStore,
      }),
    )
    t.renderer.flush()
    await click('workspace-tab-git')
    await until(10)
    expect(has('git-not-a-repo')).toBe(true)
  })

  test('行渲染 + 点击选中 → 详情列出现（patch 加载）', async () => {
    const gitStore = renderPage()
    await click('workspace-tab-git')
    await until(10)
    expect(has('git-not-a-repo')).toBe(false)

    pushChunk?.([c('c3', ['c2']), c('c2', ['c1']), c('c1', [])])
    finishLog?.(true)
    await until(10)
    expect(texts()).toContain('subject c3')
    expect(texts()).toContain('3 提交')
    expect(has('git-row-0')).toBe(true)
    expect(has('git-detail')).toBe(false)

    // virtual-list 行由 gpui list 内部渲染，React 侧拿不到行 bounds（
    // nativeSimulateClick 不可达）——选中管线直接走 store（onClick 绑定
    // 是简单 JSX 声明；真机点击在 G3 手测）
    gitStore.select('c2')
    await until(10)
    expect(has('git-detail')).toBe(true)
    // <diff> 是 native 元素：patch 内容不进 getAllText（同 markdown，T2.3）
    expect(gitStore.getState().patch).toBe('PATCH-c2')
    expect(gitStore.getState().selectedSha).toBe('c2')
    expect(texts()).toContain('subject c2')
  })
})
