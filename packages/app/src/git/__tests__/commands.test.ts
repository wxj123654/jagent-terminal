/**
 * git/commands.test.ts — 菜单动作派发规则：复制→notify、prompt→视图指令、
 * danger→确认指令、普通项→直执（notify+runAction 单点）；submitPrompt
 * 校验失败转 notify。菜单构造（commitMenu/refMenu）的 title/items/at。
 */

import { describe, expect, test } from 'bun:test'

import type { GitMenuItem } from '../actions'
import { commitMenu, createGitCommands, refMenu } from '../commands'
import type { GraphRow } from '../graph'

function fakeDeps() {
  const notes: string[] = []
  const ran: string[][] = []
  return {
    notes,
    ran,
    deps: createGitCommands({
      notify: (m) => notes.push(m),
      runAction: (a) => void ran.push(a),
    }),
  }
}

function row(sha: string): GraphRow {
  return {
    commit: {
      sha,
      shortSha: sha.slice(0, 7),
      subject: 'subj',
      parents: [],
      authorName: 'a',
      authorEmail: '',
      committerName: 'a',
      committerEmail: '',
      timestamp: 0,
      refNames: [],
    },
    lane: 0,
    colorIdx: 0,
  } as GraphRow
}

describe('createGitCommands.pick', () => {
  test('copy-sha / copy-tag → notify，不开叠加层', () => {
    const { deps, notes, ran } = fakeDeps()
    expect(
      deps.pick({ id: 'copy-sha', label: '', argv: null } as GitMenuItem, 'abcdef123'),
    ).toEqual({ kind: 'none' })
    expect(deps.pick({ id: 'copy-tag', label: '', argv: null } as GitMenuItem, 'v1.0')).toEqual({
      kind: 'none',
    })
    expect(notes).toEqual(['已复制 abcdef1', '已复制 v1.0'])
    expect(ran).toEqual([])
  })

  test('prompt 项 → prompt 指令（带 at）', () => {
    const { deps } = fakeDeps()
    const item = { id: 'branch-here', label: '', argv: null, prompt: 'branch' } as GitMenuItem
    expect(deps.pick(item, 'sha1')).toEqual({ kind: 'prompt', item, at: 'sha1' })
  })

  test('danger 项 → confirm 指令（不执行）', () => {
    const { deps, ran } = fakeDeps()
    const item = {
      id: 'reset-hard',
      label: '重置（--hard）',
      argv: ['reset', '--hard', 's'],
      danger: true,
    } as GitMenuItem
    expect(deps.pick(item)).toEqual({
      kind: 'confirm',
      title: '重置（--hard）',
      argv: ['reset', '--hard', 's'],
    })
    expect(ran).toEqual([])
  })

  test('普通项 → 就地 notify + runAction', () => {
    const { deps, notes, ran } = fakeDeps()
    const item = { id: 'revert', label: '', argv: ['revert', '--no-edit', 's'] } as GitMenuItem
    expect(deps.pick(item)).toEqual({ kind: 'none' })
    expect(notes).toEqual(['$ git revert --no-edit s'])
    expect(ran).toEqual([['revert', '--no-edit', 's']])
  })

  test('无 argv 且非已知 id → none（兜底）', () => {
    const { deps } = fakeDeps()
    expect(deps.pick({ id: '???', label: '', argv: null } as GitMenuItem)).toEqual({
      kind: 'none',
    })
  })
})

describe('createGitCommands.submitPrompt / runGit', () => {
  test('submitPrompt：resolvePrompt → 执行；空名 → notify 且返回 false', () => {
    const { deps, notes, ran } = fakeDeps()
    const item = { id: 'tag-here', label: '', argv: null, prompt: 'tag' } as GitMenuItem
    expect(deps.submitPrompt(item, 'v2', 'sha9')).toBe(true)
    expect(ran).toEqual([['tag', 'v2', 'sha9']])
    expect(deps.submitPrompt(item, '  ', 'sha9')).toBe(false)
    expect(notes).toEqual(['$ git tag v2 sha9', '名称为空'])
  })

  test('runGit：回显 + 执行单点', () => {
    const { deps, notes, ran } = fakeDeps()
    deps.runGit(['fetch', '--all', '--prune'])
    expect(notes).toEqual(['$ git fetch --all --prune'])
    expect(ran).toEqual([['fetch', '--all', '--prune']])
  })
})

describe('菜单构造', () => {
  test('commitMenu：title 截断 subject、isHead 仅第 0 行', () => {
    const m0 = commitMenu(row('deadbeefcafe'), 0)
    expect(m0.at).toBe('deadbeefcafe')
    expect(m0.title.startsWith('deadbee')).toBe(true)
    const head = m0.items.find((i) => 'id' in i && i.id === 'checkout')
    expect(head && 'disabled' in head && head.disabled).toBe(true)
    const m1 = commitMenu(row('deadbeefcafe'), 3)
    const other = m1.items.find((i) => 'id' in i && i.id === 'checkout')
    expect(other && 'disabled' in other && other.disabled).toBeFalsy()
  })

  test('refMenu：branch/remote/tag 三类分派', () => {
    const b = refMenu({ kind: 'branch', label: 'main' }, 'main')
    expect(b.title).toBe('分支 main')
    const r = refMenu({ kind: 'remote', label: 'origin/x' }, 'main')
    expect(r.title).toBe('远程 origin/x')
    const t = refMenu({ kind: 'tag', label: 'v1' }, 'main')
    expect(t.title).toBe('标签 v1')
  })
})
