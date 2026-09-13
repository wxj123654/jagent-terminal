/**
 * git/commands.ts — Git 图表面的菜单动作派发（design/git-graph-v2.md）。
 *
 * actions.ts 定义「菜单项 → argv」；本模块定义「菜单项 → 下一步」：
 * 复制类 → notify；prompt 项 → 视图开输入框；danger → 视图开二次确认；
 * 其余 → 直接执行。执行单点 runGit = notify('$ git …') + store.runAction，
 * 收敛视图层（GitGraphView）里重复的 toast+runAction 惯用法。
 *
 * 不持有 React 状态——哪个叠加层开着是视图状态，归视图；本模块只有规则。
 * notify/runAction 注入（视图 = toast/store，测试 = spy）。
 */

import {
  branchMenuItems,
  commitMenuItems,
  remoteMenuItems,
  resolvePrompt,
  tagMenuItems,
  type GitMenuEntry,
  type GitMenuItem,
} from './actions'
import type { RefDecor } from './format'
import type { GraphRow } from './graph'

/** pick 返回的视图指令：需要打开的叠加层（none = 已自行处理/无操作） */
export type MenuPick =
  | { kind: 'prompt'; item: GitMenuItem; at?: string }
  | { kind: 'confirm'; title: string; argv: string[] }
  | { kind: 'none' }

export interface GitCommandDeps {
  /** store.runAction（argv 不含 `git`） */
  runAction: (argv: string[]) => unknown
  /** 用户可见通知（视图 = toast） */
  notify: (message: string) => void
}

export interface GitCommands {
  /** 菜单项选择：复制/直执类就地处理，否则返回待开叠加层 */
  pick: (item: GitMenuItem, at?: string) => MenuPick
  /** prompt 提交：resolvePrompt → 执行；校验失败 notify 并返回 false */
  submitPrompt: (item: GitMenuItem, value: string, at?: string) => boolean
  /** 执行单点：回显命令 + runAction（fetch/分支切换/确认执行共用） */
  runGit: (argv: string[]) => void
}

export function createGitCommands(deps: GitCommandDeps): GitCommands {
  const runGit = (argv: string[]) => {
    deps.notify(`$ git ${argv.join(' ')}`)
    void deps.runAction(argv)
  }
  return {
    pick(item, at) {
      if (item.id === 'copy-sha' && at) {
        deps.notify(`已复制 ${at.slice(0, 7)}`)
        return { kind: 'none' }
      }
      if (item.id === 'copy-tag' && at) {
        deps.notify(`已复制 ${at}`)
        return { kind: 'none' }
      }
      if (item.prompt) return { kind: 'prompt', item, at }
      if (!item.argv) return { kind: 'none' }
      if (item.danger) return { kind: 'confirm', title: item.label, argv: item.argv }
      runGit(item.argv)
      return { kind: 'none' }
    },
    submitPrompt(item, value, at) {
      try {
        runGit(resolvePrompt(item, value, at))
        return true
      } catch (e) {
        deps.notify(e instanceof Error ? e.message : String(e))
        return false
      }
    },
    runGit,
  }
}

/** 菜单内容构造（坐标来自事件，归视图；title/items/at 是域规则） */
export function commitMenu(
  row: GraphRow,
  index: number,
): {
  title: string
  items: GitMenuEntry[]
  at: string
} {
  return {
    title: `${row.commit.shortSha} · ${row.commit.subject.slice(0, 24)}`,
    items: commitMenuItems(row.commit.sha, index === 0),
    at: row.commit.sha,
  }
}

export function refMenu(
  d: RefDecor,
  currentBranch: string,
): { title: string; items: GitMenuEntry[]; at: string } {
  if (d.kind === 'head' || d.kind === 'branch') {
    return {
      title: `分支 ${d.label}`,
      items: branchMenuItems(d.label, d.label === currentBranch),
      at: d.label,
    }
  }
  if (d.kind === 'remote') {
    return { title: `远程 ${d.label}`, items: remoteMenuItems(d.label), at: d.label }
  }
  return { title: `标签 ${d.label}`, items: tagMenuItems(d.label), at: d.label }
}
