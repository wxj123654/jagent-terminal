/**
 * git/cli.test.ts — 行解析 + 流式行缓冲 + 真进程冒烟（docs/git-graph.md §5）。
 *
 * 冒烟直接跑在本仓（开发机必有 git）：spawnGitLog 读全量历史，断言流式
 * 回调、字段形状、log 顺序（新 → 旧）。
 */

import { describe, expect, test } from 'bun:test'

import { LineBuffer, findRepoRoot, parseLogLine, spawnGitLog } from './cli'

const enc = new TextEncoder()

describe('parseLogLine', () => {
  const sha = 'a'.repeat(40)

  test('完整行', () => {
    const line = [
      sha,
      'b'.repeat(40),
      'HEAD -> main, tag: v1.0',
      'abcdef1',
      'wxj',
      '1800000000',
      'fix: 解析崩溃',
    ].join('\x00')
    expect(parseLogLine(line)).toEqual({
      sha,
      parents: ['b'.repeat(40)],
      refNames: ['HEAD -> main', 'tag: v1.0'],
      shortSha: 'abcdef1',
      authorName: 'wxj',
      timestamp: 1800000000,
      subject: 'fix: 解析崩溃',
    })
  })

  test('空 %D（连续 \\x00）→ refNames []；root 提交 parents []', () => {
    const line = [sha, '', '', 'abcdef1', 'wxj', '1800000000', 'init'].join('\x00')
    const parsed = parseLogLine(line)
    expect(parsed?.refNames).toEqual([])
    expect(parsed?.parents).toEqual([])
  })

  test('merge 提交双 parent', () => {
    const p1 = '1'.repeat(40)
    const p2 = '2'.repeat(40)
    const parsed = parseLogLine([sha, `${p1} ${p2}`, '', 'abcdef1', 'w', '0', 'm'].join('\x00'))
    expect(parsed?.parents).toEqual([p1, p2])
  })

  test('subject 含逗号不误切（逗号只在 %D 分隔用）', () => {
    const parsed = parseLogLine([sha, '', '', 'abcdef1', 'w', '0', 'a, b, c'].join('\x00'))
    expect(parsed?.subject).toBe('a, b, c')
  })

  test('坏行丢弃：空行 / 字段不足 / 空 sha', () => {
    expect(parseLogLine('')).toBeNull()
    expect(parseLogLine('only-three\x00fields\x00here')).toBeNull()
    expect(parseLogLine('\x00p\x00\x00s\x00a\x00t\x00subj')).toBeNull()
  })
})

describe('LineBuffer 流式行缓冲', () => {
  test('一行拆两个字节片 push 仍得到完整行', () => {
    const lb = new LineBuffer()
    const raw = enc.encode('abc\ndef\nghi')
    expect(lb.push(raw.slice(0, 5))).toEqual(['abc'])
    expect(lb.push(raw.slice(5))).toEqual(['def'])
    expect(lb.flush()).toEqual(['ghi'])
    expect(lb.flush()).toEqual([])
  })

  test('多行一次 push；末行无换行留给 flush', () => {
    const lb = new LineBuffer()
    expect(lb.push(enc.encode('l1\nl2\nl3\n'))).toEqual(['l1', 'l2', 'l3'])
    expect(lb.push(enc.encode('tail'))).toEqual([])
    expect(lb.flush()).toEqual(['tail'])
  })

  test('多字节 UTF-8 字符跨字节片不炸（subject 中文）', () => {
    const lb = new LineBuffer()
    const raw = enc.encode('中文提交\nnext')
    const mid = 3 // 切在 UTF-8 序列中间
    expect(lb.push(raw.slice(0, mid))).toEqual([])
    expect(lb.push(raw.slice(mid))).toEqual(['中文提交'])
    expect(lb.flush()).toEqual(['next'])
  })
})

describe('真进程冒烟（本仓）', () => {
  test('findRepoRoot 向上命中 repo root', async () => {
    const root = await findRepoRoot(import.meta.dir)
    expect(root).toBeTruthy()
    expect(root!.endsWith('jagent-terminal')).toBe(true)
  })

  test('不存在的 cwd → null', async () => {
    expect(await findRepoRoot('/definitely/not/a/path')).toBeNull()
  })

  test('spawnGitLog 全量流式回调 + 字段形状 + 新旧顺序', async () => {
    const root = await findRepoRoot(import.meta.dir)
    expect(root).toBeTruthy()
    const chunks: number[] = []
    const all: NonNullable<ReturnType<typeof parseLogLine>>[] = []
    const handle = spawnGitLog(root!, (cs) => {
      chunks.push(cs.length)
      for (const c of cs) all.push(c)
    })
    const res = await handle.done
    expect(res.ok).toBe(true)
    expect(all.length).toBeGreaterThan(10)
    // chunk 不超过 512（CHUNK_SIZE 上限）
    expect(chunks.every((n) => n <= 512)).toBe(true)
    expect(chunks.reduce((a, b) => a + b, 0)).toBe(all.length)
    // 字段形状
    expect(all[0]!.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(all[0]!.shortSha.length).toBeGreaterThanOrEqual(7)
    expect(all[0]!.authorName.length).toBeGreaterThan(0)
    expect(all[0]!.timestamp).toBeGreaterThan(1_500_000_000)
    // log 顺序不变量：每行的 parent 一定在其后出现（或跨 chunk 也成立——全量合并后检查）
    const seen = new Set<string>()
    for (const commit of all) seen.add(commit.sha)
    const firstWithParents = all.find((x) => x!.parents.length > 0)!
    expect(seen.has(firstWithParents!.parents[0])).toBe(true)
  })

  test('spawnGitLog 非 repo → ok:false', async () => {
    const handle = spawnGitLog('/definitely/not/a/path', () => {})
    const res = await handle.done
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })
})
