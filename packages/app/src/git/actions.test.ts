/**
 * git/actions.test.ts — 菜单项 → argv 形状（design/git-graph-v2.md）。
 */

import { describe, expect, test } from 'bun:test'

import {
  branchMenuItems,
  commitMenuItems,
  remoteMenuItems,
  resolvePrompt,
  tagMenuItems,
  type GitMenuItem,
} from './actions'

const items = (entries: ReturnType<typeof commitMenuItems>) =>
  entries.filter((e): e is GitMenuItem => !('sep' in e))

describe('commitMenuItems', () => {
  test('HEAD 行禁用检出；argv 含 sha', () => {
    const all = items(commitMenuItems('abc1234', true))
    expect(all.find((i) => i.id === 'checkout')?.disabled).toBe(true)
    expect(all.find((i) => i.id === 'cherry-pick')?.argv).toEqual(['cherry-pick', 'abc1234'])
    expect(all.find((i) => i.id === 'reset-hard')?.danger).toBe(true)
    expect(all.find((i) => i.id === 'copy-sha')?.argv).toBeNull()
  })

  test('非 HEAD 可检出', () => {
    expect(
      items(commitMenuItems('x', false)).find((i) => i.id === 'checkout')?.disabled,
    ).toBeFalsy()
  })
})

describe('branch / remote / tag', () => {
  test('当前分支 checked + 禁用检出', () => {
    const all = items(branchMenuItems('main', true))
    expect(all[0]!.checked).toBe(true)
    expect(all[0]!.disabled).toBe(true)
    expect(all.find((i) => i.id === 'delete')?.danger).toBe(true)
  })

  test('远程 origin/feat 抽出短名', () => {
    const all = items(remoteMenuItems('origin/feat/ime'))
    expect(all.find((i) => i.id === 'checkout-remote')?.argv).toEqual([
      'checkout',
      '-b',
      'feat/ime',
      'origin/feat/ime',
    ])
    expect(all.find((i) => i.id === 'delete-remote')?.argv).toEqual([
      'push',
      'origin',
      '--delete',
      'feat/ime',
    ])
  })

  test('tag 菜单', () => {
    const all = items(tagMenuItems('v0.2.0'))
    expect(all.find((i) => i.id === 'checkout-tag')?.argv).toEqual(['checkout', 'v0.2.0'])
    expect(all.find((i) => i.id === 'copy-tag')?.argv).toBeNull()
  })
})

describe('resolvePrompt', () => {
  const branchHere: GitMenuItem = {
    id: 'branch-here',
    label: '从此提交创建分支…',
    argv: null,
    prompt: 'branch',
  }
  test('空名抛错', () => {
    expect(() => resolvePrompt(branchHere, '  ')).toThrow('名称为空')
  })
  test('branch / tag / rename', () => {
    expect(resolvePrompt(branchHere, 'feat/x', 'abc')).toEqual(['branch', 'feat/x', 'abc'])
    expect(
      resolvePrompt({ id: 'tag-here', label: '', argv: null, prompt: 'tag' }, 'v1', 'abc'),
    ).toEqual(['tag', 'v1', 'abc'])
    expect(
      resolvePrompt({ id: 'rename', label: '', argv: null, prompt: 'rename' }, 'new', 'old'),
    ).toEqual(['branch', '-m', 'old', 'new'])
  })
})
