/**
 * git/store.test.ts — GitGraphStore 状态机（docs/git-graph.md §2.3）。
 *
 * 假 deps：可控 log 流（手动推 chunk / 手动收尾）、可延迟 patch。
 * 覆盖：mount 幂等 / 非 repo / 流式写入 / 换 cwd 重启（旧流取消）/
 * refresh / select+patch 时序丢弃 / moveSelection 钳制 / unmount 复位。
 */

import { describe, expect, test } from 'bun:test'

import type { GraphCommit } from './cli'
import { createGitGraphStore, type GitGraphDeps } from './store'

/** 可控假流：spawn 记录到 streams（断言次数/取消），finish 手动收尾 */
function fakeStream() {
  const streams: Array<{
    cwd: string
    onChunk: (cs: GraphCommit[]) => void
    cancelled: boolean
    finish: (ok: boolean, error?: string) => void
  }> = []
  const spawn: GitGraphDeps['spawnGitLog'] = (cwd, onChunk) => {
    const s = {
      cwd,
      onChunk,
      cancelled: false,
      finish: (ok: boolean, error?: string) => {
        void ok
        void error
      },
    }
    streams.push(s)
    return {
      cancel: () => {
        s.cancelled = true
      },
      done: new Promise<{ ok: boolean; error?: string }>((resolve) => {
        s.finish = (ok, error) => resolve({ ok, error })
      }),
    }
  }
  return { streams, spawn }
}

const c = (sha: string, parents: string[]): GraphCommit => ({
  sha,
  parents,
  refNames: [],
  shortSha: sha.slice(0, 7),
  authorName: 'a',
  timestamp: 0,
  subject: `s-${sha}`,
})

function makeDeps(
  over: Partial<GitGraphDeps> = {},
): GitGraphDeps & { roots: string[]; patches: string[] } {
  const roots: string[] = []
  const patches: string[] = []
  const deps: GitGraphDeps = {
    findRepoRoot: async (cwd) => {
      roots.push(cwd)
      return cwd === '/plain' ? null : `/repo/${cwd}`
    },
    spawnGitLog: () => {
      throw new Error('测试应覆写 spawnGitLog')
    },
    showPatch: async (_cwd, sha) => {
      patches.push(sha)
      return `PATCH-${sha}`
    },
  }
  return { ...deps, ...over, roots, patches }
}

const until = () => new Promise((r) => setTimeout(r, 0))

describe('GitGraphStore.mount', () => {
  test('非 repo → not-a-repo', async () => {
    const deps = makeDeps()
    const store = createGitGraphStore(deps)
    store.mount('/plain')
    await until()
    expect(store.getState().status).toBe('not-a-repo')
  })

  test('流式 chunk 写入 rows/loadedCount；done 后 ready', async () => {
    const { streams, spawn } = fakeStream()
    const deps = makeDeps()
    deps.spawnGitLog = spawn
    const store = createGitGraphStore(deps)
    store.mount('/w1')
    await until()
    expect(store.getState().status).toBe('loading')

    streams[0]!.onChunk([c('a', []), c('b', ['a'])])
    let st = store.getState()
    expect(st.rows).toHaveLength(2)
    expect(st.loadedCount).toBe(2)
    expect(st.rows[0].lane).toBe(0)

    streams[0]!.finish(true)
    await until()
    st = store.getState()
    expect(st.status).toBe('ready')
    expect(st.selectedSha).toBeNull()
  })

  test('同 cwd 幂等复用（不重复 spawn）；换 cwd 取消旧流重启', async () => {
    const { streams, spawn } = fakeStream()
    const deps = makeDeps()
    deps.spawnGitLog = spawn
    const store = createGitGraphStore(deps)
    store.mount('/w1')
    await until()
    store.mount('/w1')
    await until()
    expect(streams).toHaveLength(1)

    store.mount('/w2')
    await until()
    expect(streams).toHaveLength(2)
    expect(streams[0]!.cancelled).toBe(true)
    expect(streams[1]!.cwd).toBe('/repo//w2')
  })

  test('git log 失败 → error 态带文案', async () => {
    const { streams, spawn } = fakeStream()
    const deps = makeDeps()
    deps.spawnGitLog = spawn
    const store = createGitGraphStore(deps)
    store.mount('/w1')
    await until()
    streams[0]!.finish(false, 'fatal: bad object')
    await until()
    expect(store.getState().status).toBe('error')
    expect(store.getState().error).toBe('fatal: bad object')
  })
})

describe('GitGraphStore.select / moveSelection', () => {
  async function makeReady() {
    const { streams, spawn } = fakeStream()
    const deps = makeDeps()
    deps.spawnGitLog = spawn
    const store = createGitGraphStore(deps)
    store.mount('/w1')
    await until()
    streams[0]!.onChunk([c('a', []), c('b', ['a']), c('c2', ['b'])])
    streams[0]!.finish(true)
    await until()
    return { store, deps }
  }

  test('select 加载 patch；清除时不再加载', async () => {
    const { store, deps } = await makeReady()
    store.select('b')
    await until()
    expect(store.getState().selectedSha).toBe('b')
    expect(store.getState().patch).toBe('PATCH-b')
    expect(deps.patches).toEqual(['b'])

    store.select(null)
    await until()
    expect(store.getState().selectedSha).toBeNull()
    expect(deps.patches).toEqual(['b'])
  })

  test('快速换选：旧 patch 迟到不覆盖新选中', async () => {
    const { streams, spawn } = fakeStream()
    const deps = makeDeps()
    deps.spawnGitLog = spawn
    // showPatch：a 慢（手动放行），b 立即
    let releaseA: (p: string) => void = () => {}
    deps.showPatch = async (_cwd, sha) => {
      if (sha === 'a') {
        return new Promise<string>((resolve) => {
          releaseA = resolve
        })
      }
      return `PATCH-${sha}`
    }
    const store = createGitGraphStore(deps)
    store.mount('/w1')
    await until()
    streams[0]!.onChunk([c('a', []), c('b', ['a'])])
    streams[0]!.finish(true)
    await until()

    store.select('a')
    store.select('b')
    await until()
    expect(store.getState().patch).toBe('PATCH-b')
    releaseA('PATCH-a-LATE')
    await until()
    expect(store.getState().selectedSha).toBe('b')
    expect(store.getState().patch).toBe('PATCH-b')
  })

  test('moveSelection：首行起步 / 越界钳制', async () => {
    const { store } = await makeReady()
    store.moveSelection(1)
    await until()
    expect(store.getState().selectedSha).toBe('a') // 首行
    store.moveSelection(1)
    await until()
    expect(store.getState().selectedSha).toBe('b')
    store.moveSelection(-1)
    store.moveSelection(-1)
    await until()
    expect(store.getState().selectedSha).toBe('a')
  })
})

describe('GitGraphStore.refresh / unmount', () => {
  test('refresh 重跑流并清选中', async () => {
    const { streams, spawn } = fakeStream()
    const deps = makeDeps()
    deps.spawnGitLog = spawn
    const store = createGitGraphStore(deps)
    store.mount('/w1')
    await until()
    streams[0]!.onChunk([c('a', [])])
    streams[0]!.finish(true)
    await until()
    store.select('a')
    await until()

    store.refresh()
    await until()
    expect(streams).toHaveLength(2)
    expect(store.getState().status).toBe('loading')
    expect(store.getState().selectedSha).toBeNull()
  })

  test('unmount 复位 idle + 后续 done 不写回', async () => {
    const { streams, spawn } = fakeStream()
    const deps = makeDeps()
    deps.spawnGitLog = spawn
    const store = createGitGraphStore(deps)
    store.mount('/w1')
    await until()
    store.unmount()
    expect(store.getState().status).toBe('idle')
    expect(store.getState().rows).toHaveLength(0)
    streams[0]!.onChunk([c('a', [])])
    streams[0]!.finish(true)
    await until()
    expect(store.getState().status).toBe('idle')
    expect(store.getState().rows).toHaveLength(0)
  })
})
