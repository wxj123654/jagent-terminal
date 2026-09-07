/**
 * git/fileTree.ts — 变更文件嵌套 + vscode-git-graph 式单子目录折叠。
 *
 * `src/pages/a.ts` 且中间目录无兄弟 → 显示为 `src / pages`。零 IO。
 */

import type { ChangedFile } from './cli'

export interface FileTreeNode {
  dirs: Record<string, FileTreeNode>
  files: ChangedFile[]
}

export function nestChangedFiles(files: readonly ChangedFile[]): FileTreeNode {
  const root: FileTreeNode = { dirs: {}, files: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let n = root
    parts.forEach((p, i) => {
      if (i === parts.length - 1) n.files.push(f)
      else {
        n.dirs[p] ??= { dirs: {}, files: [] }
        n = n.dirs[p]!
      }
    })
  }
  return root
}

/** 连续「单子目录、无文件」链折叠为 `a / b / c` */
export function compactDir(
  name: string,
  node: FileTreeNode,
): { name: string; node: FileTreeNode } {
  const parts = [name]
  let n = node
  for (;;) {
    const dirNames = Object.keys(n.dirs)
    if (dirNames.length !== 1 || n.files.length !== 0) break
    const only = dirNames[0]!
    parts.push(only)
    n = n.dirs[only]!
  }
  return { name: parts.join(' / '), node: n }
}
