/**
 * git/components/GitGraphView — ↑↓ 键控对照（独立文件，无前用例状态）。
 *
 * 与 GitGraphView.test.tsx「分支浮层键盘」配对：浮层关着时根 onKeyDown 不得
 * 置 keyConsumed（否则上一条「浮层开着 mark」无判别力）。单独成文件，避免同
 * 文件前用例残留的分支浮层（原生 deferred 层）干扰断言。
 */

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { installGitGraphRowElement } from '@jagent/native'
import { keyConsumed } from '@jagent/ui'
import { memoryAdapter } from '../../settings/file'
import { createSettingsStore, type SettingsStore } from '../../settings/store'
import { WorkspacePage } from '../../sidebar/WorkspacePage'
import { createThreadStore, type ThreadStore } from '../../threads/store'
import { createGitGraphStore } from '../store'
import type { GraphCommit } from '../types'

let t: TestRoot
let store: ThreadStore
let settings: SettingsStore
let pushChunk: ((cs: GraphCommit[]) => void) | null = null
let finishLog: ((ok: boolean) => void) | null = null

const c = (sha: string, parents: string[]): GraphCommit => ({
  sha,
  parents,
  refNames: [],
  shortSha: sha.slice(0, 7),
  authorName: 'wxj',
  authorEmail: 'wxj@jagent.dev',
  timestamp: 1_800_000_000,
  committerName: 'wxj',
  committerEmail: 'wxj@jagent.dev',
  subject: `subject ${sha}`,
})

beforeAll(() => {
  installGitGraphRowElement()
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

async function until(ms = 0) {
  await new Promise((r) => setTimeout(r, ms))
  t.renderer.flush()
}

test('对照：浮层关着时 ↑↓ 不 mark keyConsumed', async () => {
  const gitStore = createGitGraphStore({
    findRepoRoot: async () => '/repo/demo',
    spawnGitLog: (_cwd, onChunk) => {
      pushChunk = onChunk
      return {
        cancel: () => {},
        done: new Promise((resolve) => {
          finishLog = (ok) => resolve({ ok, error: ok ? undefined : 'boom' })
        }),
      }
    },
    showCommitBody: async () => '',
    listChangedFiles: async () => [],
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
        openRename: () => {},
        openErrors: () => {},
      },
      gitStore,
    }),
  )
  t.renderer.flush()
  store.setWorkspacePaneTab(ws.id, 'git')
  await until(10)
  pushChunk?.([c('c2', ['c1']), c('c1', [])])
  finishLog?.(true)
  await until(10)

  expect(t.renderer.findByTestId('git-branch-pop')).toBeUndefined()
  keyConsumed.take()
  const root = t.renderer.findByTestId('git-graph-view')!
  t.renderer.focusElement(root.id)
  await until(10)
  t.renderer.nativeSimulateKeyDown(root.id, 'down')
  await until(10)
  expect(keyConsumed.peek()).toBe(false)
})
