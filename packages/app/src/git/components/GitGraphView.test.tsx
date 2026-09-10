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
  authorEmail: 'wxj@jagent.dev',
  timestamp: 1_800_000_000,
  committerName: 'wxj',
  committerEmail: 'wxj@jagent.dev',
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
    showCommitBody: async (_cwd, sha) => `BODY-${sha}`,
    listChangedFiles: async (_cwd, sha) => [{ path: `${sha}.ts`, added: 2, deleted: 1 }],
    listBranches: async () => [{ name: 'main', current: true }],
    runGit: async () => '',
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
      showCommitBody: async () => '',
      listChangedFiles: async () => [],
      listBranches: async () => [],
      runGit: async () => '',
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

  test('行渲染 + 点击选中 → 详情列出现（元数据 + 说明）', async () => {
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
    expect(gitStore.getState().body).toBe('BODY-c2')
    expect(gitStore.getState().selectedSha).toBe('c2')
    expect(texts()).toContain('subject c2')
    expect(texts()).toContain('Commit:')
    expect(texts()).toContain('Parents:')
    expect(texts()).toContain('Author:')
    expect(texts()).toContain('wxj <wxj@jagent.dev>')
    expect(texts()).not.toContain('PATCH-')
  })

  test('选中后详情作为独立行插在提交下方，不与下一提交重叠', async () => {
    const gitStore = renderPage()
    await click('workspace-tab-git')
    await until(10)
    pushChunk?.([c('c3', ['c2']), c('c2', ['c1']), c('c1', [])])
    finishLog?.(true)
    await until(10)
    gitStore.select('c3')
    await until(20)
    expect(has('git-cdv-0')).toBe(true)
    const r0 = t.renderer.findByTestId('git-row-0')
    const cdv = t.renderer.findByTestId('git-cdv-0')
    const r1 = t.renderer.findByTestId('git-row-1')
    expect(r0).toBeDefined()
    expect(cdv).toBeDefined()
    expect(r1).toBeDefined()
    const b0 = t.renderer.getElementBounds(r0!.id)
    const bd = t.renderer.getElementBounds(cdv!.id)
    const b1 = t.renderer.getElementBounds(r1!.id)
    expect(b0).toBeDefined()
    expect(bd).toBeDefined()
    expect(b1).toBeDefined()
    expect(b0![3]).toBeLessThanOrEqual(30)
    expect(bd![3]).toBeGreaterThan(100)
    expect(bd![1]).toBeGreaterThanOrEqual(b0![1] + b0![3] - 1)
    expect(b1![1]).toBeGreaterThanOrEqual(bd![1] + bd![3] - 1)
  })

  test('CDV 左栏元数据与右栏文件树分栏，长路径不盖住统计', async () => {
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
      showCommitBody: async () => 'body line',
      listChangedFiles: async () => [
        {
          path: 'packages/app/src/very/long/path/name.ts',
          added: 2,
          deleted: 1,
        },
      ],
      listBranches: async () => [{ name: 'main', current: true }],
      runGit: async () => '',
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
    pushChunk?.([c('c3', ['c2']), c('c2', ['c1']), c('c1', [])])
    finishLog?.(true)
    await until(10)
    gitStore.select('c3')
    await until(20)

    const summary = t.renderer.findByTestId('git-cdv-summary')
    const files = t.renderer.findByTestId('git-cdv-files')
    expect(summary).toBeDefined()
    expect(files).toBeDefined()
    const bs = t.renderer.getElementBounds(summary!.id)
    const bf = t.renderer.getElementBounds(files!.id)
    expect(bs).toBeDefined()
    expect(bf).toBeDefined()
    // 左栏裁剪盒右缘不得越过右栏左缘（允许 1px 分割线误差）
    expect(bs![0] + bs![2]).toBeLessThanOrEqual(bf![0] + 1)
    expect(texts()).toContain('packages / app / src / very / long / path')
    expect(texts()).toContain('name.ts')
    expect(texts()).toContain('+2')
    expect(texts()).toContain('-1')
  })
})
