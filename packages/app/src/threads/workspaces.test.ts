/**
 * threads/workspaces.test.ts — 工作区模型纯函数面（Phase W）。
 *
 * 覆盖：state.json parse 容错（坏 JSON/坏行剔除/字段 catch 回默认）、
 * serialize 往返保真、defaultWorkspace / workspaceDisplayName、
 * workspaceSessions 派生（创建序 + 无关行过滤）。
 */

import { describe, expect, test } from 'bun:test'

import type { ChatThread, Thread } from './store'
import {
  defaultWorkspace,
  parseWorkspaceState,
  serializeWorkspaceState,
  workspaceDisplayName,
  workspaceSessions,
  type Workspace,
} from './workspaces'

describe('workspaces: parseWorkspaceState（state.json 读盘容错）', () => {
  test('null / 坏 JSON → 空列表（装配层回退默认工作区）', () => {
    expect(parseWorkspaceState(null)).toEqual([])
    expect(parseWorkspaceState('')).toEqual([])
    expect(parseWorkspaceState('{oops')).toEqual([])
  })

  test('未知结构 / 非 workspaces 键 → 空列表', () => {
    expect(parseWorkspaceState('{"foo":1}')).toEqual([])
    expect(parseWorkspaceState('[1,2]')).toEqual([])
  })

  test('完整行保真 + 坏字段按 schema catch 回默认', () => {
    const raw = JSON.stringify({
      workspaces: [
        { id: 'w1', name: 'proj', path: '/a/b', expanded: false, lastSession: 't3', createdAt: 42 },
        // expanded 缺失 → true；lastSession 类型坏 → null；createdAt 缺失 → 0
        { id: 'w2', name: 'x', path: '/c', lastSession: 7 },
        // name 缺失 → ''（path 兜底是 UI/装配层职责，parse 只管类型面）
        { id: 'w3', path: '/d' },
      ],
    })
    const ws = parseWorkspaceState(raw)
    expect(ws).toHaveLength(3)
    expect(ws[0]).toEqual({
      id: 'w1',
      name: 'proj',
      path: '/a/b',
      expanded: false,
      lastSession: 't3',
      createdAt: 42,
    })
    expect(ws[1]?.expanded).toBe(true)
    expect(ws[1]?.lastSession).toBeNull()
    expect(ws[1]?.createdAt).toBe(0)
    expect(ws[2]?.name).toBe('')
  })

  test('坏行剔除：缺 id 或缺 path 的行不进列表（单行损坏不炸全局）', () => {
    const raw = JSON.stringify({
      workspaces: [
        { id: 'w1', name: 'ok', path: '/a' },
        { id: '', name: '无 id', path: '/b' },
        { id: 'w3', name: '无 path' },
        'garbage',
      ],
    })
    const ws = parseWorkspaceState(raw)
    expect(ws.map((w) => w.id)).toEqual(['w1'])
  })
})

describe('workspaces: serialize ↔ parse 往返', () => {
  test('serializeWorkspaceState 产出可被 parse 完整还原（尾换行 + 2 空格缩进）', () => {
    const ws: Workspace[] = [
      defaultWorkspace('/Users/u/proj', 1),
      { ...defaultWorkspace('/srv/web', 2), expanded: false, lastSession: 't7' },
    ]
    const raw = serializeWorkspaceState(ws)
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw).toContain('"workspaces"')
    expect(parseWorkspaceState(raw)).toEqual(ws)
  })
})

describe('workspaces: 构造与派生', () => {
  test('defaultWorkspace：name = basename；expanded 默认开；lastSession 空', () => {
    const ws = defaultWorkspace('/Users/u/jagent-terminal', 99)
    expect(ws.name).toBe('jagent-terminal')
    expect(ws.path).toBe('/Users/u/jagent-terminal')
    expect(ws.expanded).toBe(true)
    expect(ws.lastSession).toBeNull()
    expect(ws.createdAt).toBe(99)
    expect(ws.id).toStartWith('w')
  })

  test('workspaceDisplayName：posix / windows 分隔符 + 尾分隔符 + 根路径兜底', () => {
    expect(workspaceDisplayName('/Users/u/proj')).toBe('proj')
    expect(workspaceDisplayName('D:\\document\\j-agent')).toBe('j-agent')
    expect(workspaceDisplayName('/a/b/')).toBe('b')
    expect(workspaceDisplayName('/')).toBe('/')
    expect(workspaceDisplayName('')).toBe('')
  })

  test('workspaceSessions：按创建序过滤归属行；无归属/他工作区行不进', () => {
    const t = (id: string, workspaceId?: string): ChatThread => ({
      kind: 'chat',
      id,
      title: id,
      createdAt: 0,
      messages: [],
      pendingReply: false,
      workspaceId,
    })
    const threads: Thread[] = [t('c1', 'w1'), t('c2'), t('c3', 'w2'), t('c4', 'w1')]
    expect(workspaceSessions(threads, 'w1').map((x) => x.id)).toEqual(['c1', 'c4'])
    expect(workspaceSessions(threads, 'w-none')).toEqual([])
  })
})
