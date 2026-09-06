/**
 * threads/workspaces.ts — 工作区模型（Phase W；architecture.md §3 同步修订）。
 *
 * 工作区 = 项目目录 + 会话分组（交互契约：design/workspace-plane.md）：
 *  - 会话归属工作区（`Thread.workspaceId`），但**不嵌套持有**——threads 保持
 *    平铺创建序（Ctrl-Tab cycle 环形语义与事件定位 R4 不变），分组是派生
 *    视图（`workspaceSessions`）。
 *  - cwd 继承：会话创建时 `preset.cwd ?? workspace.path ?? process.cwd()`
 *    （preset 显式 cwd = 用户配置意图优先；否则继承工作区目录——工具在项目
 *    目录里跑是工作区的存在意义）。
 *  - 持久化：独立 state.json（~/.j-agent/state.json，装配层经 FileAdapter）。
 *    工作区含运行时态（expanded / lastSession），语义是「应用状态」而非
 *    「用户设置」，与 settings.json 分文件；threads 本身不持久化（PTY 重启
 *    即死，恢复行无意义）。lastSession 可能指向重启后不存在的 thread——
 *    消费点（activateWorkspace）做存在性校验兑底。
 */

import { z } from 'zod'

import type { Thread } from './store'

// ── 类型 ─────────────────────────────────────────────────────────────

export type Workspace = {
  /** `w${uuid}`（对齐 chat/acp thread 的 id 前缀模式） */
  id: string
  /** 显示名；默认 = 目录 basename */
  name: string
  /** 项目目录（会话 cwd 继承源） */
  path: string
  /** 侧栏分组展开态（点击箭头仅切换此项，不激活工作区） */
  expanded: boolean
  /** 上次打开的 thread id（activate 归属会话时更新；close 该会话清空） */
  lastSession: string | null
  createdAt: number
}

// ── 持久化（state.json schema 与序列化）──────────────────────────────

const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string().catch(''),
  path: z.string().catch(''),
  expanded: z.boolean().catch(true),
  lastSession: z.string().nullable().catch(null),
  createdAt: z.number().catch(0),
})

const StateSchema = z.object({
  // 元素层 unknown + 逐行 safeParse：zod 的 array.catch 是整组回退，
  // 单行损坏会抹掉全部工作区——逐行容错才是「单行坏不炸全局」
  workspaces: z.array(z.unknown()).catch([]),
})

/**
 * 解析 state.json 内容（装配期一次性）：坏 JSON / 未知结构 → 空列表（调用方
 * 回退默认工作区）；坏行（缺 id / 缺 path）剔除，坏字段按 schema catch 回默认
 * ——单行损坏不炸全局，与 settings 的容错纪律同源。
 */
export function parseWorkspaceState(raw: string | null): Workspace[] {
  if (raw == null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const result = StateSchema.safeParse(parsed)
  if (!result.success) return []
  const out: Workspace[] = []
  for (const item of result.data.workspaces) {
    const w = WorkspaceSchema.safeParse(item)
    // 无 id 无从引用；无 path 的目录语义不成立——两者都剔
    //（name 可由 path 兜底恢复，允许空）
    if (w.success && w.data.id !== '' && w.data.path !== '') out.push(w.data)
  }
  return out
}

/** 序列化形态（与 settings 的 serializeSettings 同风格：2 空格缩进 + 尾换行） */
export function serializeWorkspaceState(workspaces: Workspace[]): string {
  return `${JSON.stringify({ workspaces }, null, 2)}\n`
}

// ── 构造与派生 ───────────────────────────────────────────────────────

/** 目录显示名（basename 兜底：空/根路径原样返回） */
export function workspaceDisplayName(path: string): string {
  const base = path.split(/[\\/]/).filter(Boolean).pop()
  return base ?? path
}

/** 首启默认工作区（装配层在 state.json 为空时建；name = 目录 basename） */
export function defaultWorkspace(path: string, now: number = Date.now()): Workspace {
  return {
    id: `w${crypto.randomUUID()}`,
    name: workspaceDisplayName(path),
    path,
    expanded: true,
    lastSession: null,
    createdAt: now,
  }
}

/** 工作区的会话（创建序派生视图——侧栏分组渲染与「最后一个会话」判定用） */
export function workspaceSessions(threads: Thread[], workspaceId: string): Thread[] {
  return threads.filter((t) => t.workspaceId === workspaceId)
}

// ── 跨工作区搜索（Phase W2；原型：标题、工具、目录）────────────────

/** 会话的搜索命中面：标题 + 工具名（调用方注入 preset 查询）+ 目录 */
export function searchThreads(
  threads: Thread[],
  workspaces: Workspace[],
  query: string,
  presetLabelOf: (presetId?: string) => string | undefined = () => undefined,
): Array<{ thread: Thread; workspace?: Workspace }> {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  const wsById = new Map(workspaces.map((w) => [w.id, w]))
  const hits: Array<{ thread: Thread; workspace?: Workspace }> = []
  for (const t of threads) {
    const ws = t.workspaceId ? wsById.get(t.workspaceId) : undefined
    const title = t.kind === 'terminal' ? terminalTitle(t) : t.title
    const tool =
      t.kind === 'terminal'
        ? (presetLabelOf(t.preset) ?? 'Terminal')
        : t.kind === 'acp'
          ? 'ACP'
          : 'Chat'
    const dir = t.kind === 'terminal' ? t.cwd : (ws?.path ?? '')
    const haystack = `${title} ${tool} ${dir} ${ws?.name ?? ''} ${ws?.path ?? ''}`.toLowerCase()
    if (haystack.includes(q)) hits.push({ thread: t, workspace: ws })
  }
  return hits
}

/** terminal 标题（displayTitle 的本地等价——避免 workspaces→terminal 循环 import） */
function terminalTitle(t: Extract<Thread, { kind: 'terminal' }>): string {
  return t.customTitle ?? t.oscTitle ?? t.initCommand ?? 'Terminal'
}
