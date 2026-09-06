/**
 * git/format.test.ts — %D 解析 + 相对时间（docs/git-graph.md §3.3）。
 */

import { describe, expect, test } from 'bun:test'

import { parseRefNames, relativeTime } from './format'

describe('parseRefNames', () => {
  test('空串 → 空数组', () => {
    expect(parseRefNames('')).toEqual([])
  })

  test('HEAD -> branch', () => {
    expect(parseRefNames('HEAD -> main')).toEqual([{ kind: 'head', label: 'main' }])
  })

  test('detached HEAD', () => {
    expect(parseRefNames('HEAD')).toEqual([{ kind: 'head', label: 'HEAD' }])
  })

  test('本地分支', () => {
    expect(parseRefNames('feature/x')).toEqual([{ kind: 'remote', label: 'feature/x' }])
    expect(parseRefNames('main')).toEqual([{ kind: 'branch', label: 'main' }])
  })

  test('远程 / tag', () => {
    expect(parseRefNames('origin/main')).toEqual([{ kind: 'remote', label: 'origin/main' }])
    expect(parseRefNames('tag: v1.0')).toEqual([{ kind: 'tag', label: 'v1.0' }])
  })

  test('多装饰混合保序', () => {
    expect(parseRefNames('HEAD -> dev, origin/dev, tag: v0.9.0, main')).toEqual([
      { kind: 'head', label: 'dev' },
      { kind: 'remote', label: 'origin/dev' },
      { kind: 'tag', label: 'v0.9.0' },
      { kind: 'branch', label: 'main' },
    ])
  })
})

describe('relativeTime（now 注入，确定性）', () => {
  const NOW = 1_800_000_000_000
  const at = (secAgo: number) => NOW / 1000 - secAgo

  test('阶梯', () => {
    expect(relativeTime(at(30), NOW)).toBe('刚刚')
    expect(relativeTime(at(59), NOW)).toBe('刚刚')
    expect(relativeTime(at(61), NOW)).toBe('1 分钟前')
    expect(relativeTime(at(3599), NOW)).toBe('59 分钟前')
    expect(relativeTime(at(3600), NOW)).toBe('1 小时前')
    expect(relativeTime(at(25 * 3600), NOW)).toBe('1 天前')
    expect(relativeTime(at(29 * 86400), NOW)).toBe('29 天前')
    expect(relativeTime(at(30 * 86400), NOW)).toBe('1 个月前')
    expect(relativeTime(at(350 * 86400), NOW)).toBe('11 个月前')
    expect(relativeTime(at(366 * 86400), NOW)).toBe('1 年前')
    expect(relativeTime(at(800 * 86400), NOW)).toBe('2 年前')
  })

  test('未来时间钳到 刚刚', () => {
    expect(relativeTime(NOW / 1000 + 120, NOW)).toBe('刚刚')
  })
})
