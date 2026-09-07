/**
 * git/fileTree.test.ts — 嵌套 + 单子目录折叠。
 */

import { describe, expect, test } from 'bun:test'

import { compactDir, nestChangedFiles } from './fileTree'

const f = (path: string) => ({ path, added: 1, deleted: 0 })

describe('nestChangedFiles', () => {
  test('按路径分层', () => {
    const root = nestChangedFiles([f('a.ts'), f('src/b.ts')])
    expect(root.files.map((x) => x.path)).toEqual(['a.ts'])
    expect(Object.keys(root.dirs)).toEqual(['src'])
    expect(root.dirs.src!.files.map((x) => x.path)).toEqual(['src/b.ts'])
  })
})

describe('compactDir', () => {
  test('单链目录折叠为 a / b', () => {
    const root = nestChangedFiles([f('src/pages/index.ts')])
    const c = compactDir('src', root.dirs.src!)
    expect(c.name).toBe('src / pages')
    expect(c.node.files.map((x) => x.path)).toEqual(['src/pages/index.ts'])
  })

  test('目录下有文件则不折叠', () => {
    const root = nestChangedFiles([f('src/a.ts'), f('src/pages/b.ts')])
    const c = compactDir('src', root.dirs.src!)
    expect(c.name).toBe('src')
    expect(Object.keys(c.node.dirs)).toEqual(['pages'])
  })

  test('兄弟目录不折叠', () => {
    const root = nestChangedFiles([f('src/a/x.ts'), f('src/b/y.ts')])
    const c = compactDir('src', root.dirs.src!)
    expect(c.name).toBe('src')
    expect(Object.keys(c.node.dirs).sort()).toEqual(['a', 'b'])
  })
})
