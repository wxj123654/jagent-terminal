/**
 * git/components/GitGraphView — 右键派发回归。
 *
 * 锁定：
 * - 右键行（非 chip 区）→ commit 菜单
 * - 右键 ref chip → 分支/标签/远程菜单，且**紧接着的行右键不得被吞**
 *   （回归：旧 suppressRowMenu 标记在 chip 右键后残留，吞掉下一次行右键）
 *
 * 独立文件：不与前用例共享 GitGraph 状态（菜单为页面级单例）。
 */

import { test, beforeAll, afterAll, expect } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { installGitGraphRowElement } from '@jagent/native'
import { memoryAdapter } from '../../settings/file'
import { createSettingsStore } from '../../settings/store'
import { WorkspacePage } from '../../sidebar/WorkspacePage'
import { createThreadStore } from '../../threads/store'
import { createGitGraphStore } from '../store'
import type { GraphCommit } from '../types'

let t: TestRoot
let pushChunk: ((cs: GraphCommit[]) => void) | null = null
let finishLog: ((ok: boolean) => void) | null = null

const c = (sha: string, parents: string[], refNames: string[] = []): GraphCommit => ({
  sha,
  parents,
  refNames,
  shortSha: sha.slice(0, 7),
  authorName: 'w',
  authorEmail: 'w@x',
  timestamp: 1_800_000_000,
  committerName: 'w',
  committerEmail: 'w@x',
  subject: `s ${sha}`,
})

beforeAll(() => {
  installGitGraphRowElement()
  t = createTestRoot({ width: 1000, height: 700 })
})
afterAll(() => t?.unmount())

const until = async (ms = 10) => {
  await new Promise((r) => setTimeout(r, ms))
  t.renderer.flush()
}
const hasCommitMenu = () =>
  t.renderer.getAllText().some((x) => /检出到此提交|Cherry Pick|还原提交/.test(x))
// 分支菜单独有的标题项（commit 菜单无）：「检出 HEAD」与「合并进当前分支」只在分支菜单
const hasRefMenu = () => t.renderer.getAllText().some((x) => /^检出 HEAD$/.test(x))
const closeMenu = () => {
  const m = t.renderer.findByTestId('git-menu')
  if (m) {
    t.renderer.nativeSimulateKeyDown(m.id, 'escape')
    t.renderer.flush()
  }
}

async function setup() {
  const store = createThreadStore({
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
  const ws = store.getState().workspaces[0]!
  const gitStore = createGitGraphStore({
    findRepoRoot: async () => '/repo/demo',
    spawnGitLog: (_cwd, onChunk) => {
      pushChunk = onChunk
      return {
        cancel: () => {},
        done: new Promise((r) => {
          finishLog = (ok) => r({ ok, error: ok ? undefined : 'x' })
        }),
      }
    },
    showCommitBody: async () => '',
    listChangedFiles: async () => [],
    listBranches: async () => [{ name: 'main', current: true }],
    runGit: async () => '',
  })
  t.render(
    createElement(WorkspacePage, {
      store,
      settings: createSettingsStore(memoryAdapter()),
      workspace: ws,
      dialog: {
        openToolMenu: () => {},
        openAddWorkspace: () => {},
        openSearch: () => {},
        openRename: () => {},
        openErrors: () => {},
      },
      gitStore,
    }),
  )
  t.renderer.flush()
  store.setWorkspacePaneTab(ws.id, 'git')
  await until()
  pushChunk?.([c('c2', ['c1'], ['HEAD -> main']), c('c1', [])])
  finishLog?.(true)
  await until()
}

const rightRowNonChip = () => {
  const rb = t.renderer.getElementBounds(t.renderer.findByTestId('git-row-0')!.id)!
  t.renderer.nativeSimulateClick(rb.x + rb.width - 40, rb.y + rb.height / 2, 2)
  t.renderer.flush()
}
const rightChip = () => {
  const cb = t.renderer.getElementBounds(t.renderer.findByTestId('git-ref-head')!.id)!
  t.renderer.nativeSimulateClick(cb.x + cb.width / 2, cb.y + cb.height / 2, 2)
  t.renderer.flush()
}

test('右键行（非 chip 区）→ commit 菜单', async () => {
  await setup()
  rightRowNonChip()
  expect(hasCommitMenu()).toBe(true)
  expect(hasRefMenu()).toBe(false)
})

test('右键 ref chip → 分支菜单，且不打开 commit 菜单', async () => {
  await setup()
  rightChip()
  expect(hasRefMenu()).toBe(true)
  expect(hasCommitMenu()).toBe(false)
})

test('回归：chip 右键后紧接的行右键不得被吞（旧 suppressRowMenu 残留 bug）', async () => {
  await setup()
  rightChip()
  closeMenu()
  rightRowNonChip()
  expect(hasCommitMenu()).toBe(true)
})
