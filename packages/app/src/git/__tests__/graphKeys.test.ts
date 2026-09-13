/**
 * git/graphKeys.test.ts — Git 图表面裸键语义：激活判定（路由 + paneTab）与
 * 各键路由到 store 动作；非激活/未知键必须透传（返回 false）。
 */

import { describe, expect, test } from 'bun:test'

import type { Workspace } from '../../threads/workspaces'
import { createGitGraphKey } from '../graphKeys'

function ws(id: string, paneTab: 'home' | 'git'): Workspace {
  return {
    id,
    name: id,
    path: '/x',
    expanded: true,
    lastSession: null,
    paneTab,
    createdAt: 0,
  }
}

function fakeStore() {
  const calls: string[] = []
  return {
    calls,
    moveSelection: (d: number) => void calls.push(`move:${d}`),
    select: (sha: string | null) => void calls.push(`select:${sha}`),
    refresh: () => void calls.push('refresh'),
  }
}

function keyFn(opts: { wsId: string | null; workspaces: Workspace[] }) {
  const store = fakeStore()
  const fn = createGitGraphKey({
    activeWorkspaceId: () => opts.wsId,
    workspaces: () => opts.workspaces,
    store,
  })
  return { fn, calls: store.calls }
}

describe('createGitGraphKey', () => {
  test('路由不在工作区 / 工作区非 git tab：全部透传', () => {
    const a = keyFn({ wsId: null, workspaces: [ws('w1', 'git')] })
    expect(a.fn('down')).toBe(false)
    expect(a.fn('enter')).toBe(false)
    expect(a.calls).toEqual([])

    const b = keyFn({ wsId: 'w1', workspaces: [ws('w1', 'home')] })
    expect(b.fn('down')).toBe(false)
    expect(b.fn('r')).toBe(false)
    expect(b.calls).toEqual([])

    const c = keyFn({ wsId: 'ghost', workspaces: [ws('w1', 'git')] })
    expect(c.fn('down')).toBe(false)
    expect(c.calls).toEqual([])
  })

  test('git tab 激活：↓/↑ 移动选择，enter 吃掉，esc 清选，r 刷新', () => {
    const { fn, calls } = keyFn({ wsId: 'w1', workspaces: [ws('w1', 'git')] })
    expect(fn('down')).toBe(true)
    expect(fn('arrowup')).toBe(true)
    expect(fn('enter')).toBe(true)
    expect(fn('escape')).toBe(true)
    expect(fn('r')).toBe(true)
    expect(fn('x')).toBe(false)
    expect(calls).toEqual(['move:1', 'move:-1', 'select:null', 'refresh'])
  })
})
