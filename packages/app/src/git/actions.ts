/**
 * git/actions.ts — 右键菜单项 → git CLI argv（design/git-graph-v2.md）。
 *
 * 纯函数：不 spawn。危险操作（reset --hard / drop / 删分支）由 UI 二次确认
 * 后再 runGit。命令形状由 actions.test.ts 锁定。
 */

export type GitActionKind = 'commit' | 'branch' | 'remote' | 'tag'

export interface GitMenuItem {
  id: string
  label: string
  /** 交给 runGit 的 argv（不含 `git`）。prompt 项为 null，UI 先弹输入。 */
  argv: string[] | null
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  /** 需要输入框（分支名 / 标签名） */
  prompt?: 'branch' | 'tag' | 'rename'
}

export type GitMenuEntry = GitMenuItem | { sep: true }

export function commitMenuItems(sha: string, isHead: boolean): GitMenuEntry[] {
  return [
    { id: 'checkout', label: '检出到此提交', argv: ['checkout', sha], disabled: isHead },
    { id: 'detach', label: '检出此提交（分离 HEAD）', argv: ['checkout', '--detach', sha] },
    { sep: true },
    { id: 'branch-here', label: '从此提交创建分支…', argv: null, prompt: 'branch' },
    { id: 'tag-here', label: '从此提交创建标签…', argv: null, prompt: 'tag' },
    { id: 'copy-sha', label: '复制提交哈希', argv: null },
    { sep: true },
    { id: 'cherry-pick', label: 'Cherry Pick 到当前分支', argv: ['cherry-pick', sha] },
    { id: 'revert', label: '还原提交', argv: ['revert', '--no-edit', sha] },
    { sep: true },
    { id: 'merge', label: '合并进当前分支', argv: ['merge', sha] },
    { id: 'rebase', label: '将当前分支变基到此提交', argv: ['rebase', sha] },
    { id: 'reset-soft', label: '重置当前分支到此提交（--soft）', argv: ['reset', '--soft', sha] },
    {
      id: 'reset-mixed',
      label: '重置当前分支到此提交（--mixed）',
      argv: ['reset', '--mixed', sha],
    },
    {
      id: 'reset-hard',
      label: '重置当前分支到此提交（--hard）',
      argv: ['reset', '--hard', sha],
      danger: true,
    },
  ]
}

export function branchMenuItems(name: string, isCurrent: boolean): GitMenuEntry[] {
  return [
    {
      id: 'checkout',
      label: `检出 ${name}`,
      argv: ['checkout', name],
      disabled: isCurrent,
      checked: isCurrent,
    },
    { id: 'pull', label: '拉取…', argv: ['pull', 'origin', name] },
    { id: 'push', label: '推送…', argv: ['push', 'origin', name] },
    { sep: true },
    { id: 'merge', label: '合并进当前分支', argv: ['merge', name] },
    { id: 'rebase', label: `变基当前分支到 ${name}…`, argv: ['rebase', name] },
    { sep: true },
    { id: 'rename', label: '重命名…', argv: null, prompt: 'rename' },
    { id: 'delete', label: '删除…', argv: ['branch', '-d', name], danger: true },
  ]
}

export function remoteMenuItems(name: string): GitMenuEntry[] {
  const ref = name.startsWith('origin/') ? name : `origin/${name}`
  const short = ref.replace(/^origin\//, '')
  return [
    {
      id: 'checkout-remote',
      label: `检出为新分支 ${short}`,
      argv: ['checkout', '-b', short, ref],
    },
    { id: 'pull', label: '拉取…', argv: ['pull', 'origin', short] },
    { sep: true },
    { id: 'merge', label: '合并进当前分支', argv: ['merge', ref] },
    {
      id: 'delete-remote',
      label: '删除远程分支…',
      argv: ['push', 'origin', '--delete', short],
      danger: true,
    },
  ]
}

export function tagMenuItems(name: string): GitMenuEntry[] {
  return [
    { id: 'checkout-tag', label: '检出此标签（分离 HEAD）', argv: ['checkout', name] },
    { sep: true },
    { id: 'push-tag', label: '推送标签…', argv: ['push', 'origin', name] },
    { id: 'delete-tag', label: '删除标签…', argv: ['tag', '-d', name], danger: true },
    { id: 'copy-tag', label: '复制标签名', argv: null },
  ]
}

/** prompt 项填入用户输入后生成 argv。`at` = 旧分支名（rename）或提交 sha（branch/tag）。 */
export function resolvePrompt(item: GitMenuItem, value: string, at?: string): string[] {
  const v = value.trim()
  if (!v) throw new Error('名称为空')
  if (item.prompt === 'branch') return ['branch', v, at ?? 'HEAD']
  if (item.prompt === 'tag') return ['tag', v, ...(at ? [at] : [])]
  if (item.prompt === 'rename') {
    if (!at) throw new Error('缺少旧分支名')
    return ['branch', '-m', at, v]
  }
  throw new Error(`不是 prompt 项: ${item.id}`)
}
