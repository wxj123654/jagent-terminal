import type { Preset, RouteTarget, Thread, Workspace } from './types'
import { DEFAULTS, KEY_ACTIONS, FIXED_KEYS, SETTING_DEFS, FONT_CANDIDATES } from './seed'
import type { Settings, RouteType } from './types'

/* ── 查询（对齐 workspaces.ts / terminal.ts）── */
export const threadById = (threads: Thread[], id?: string | null) => threads.find(t => t.id === id)
export const wsById = (ws: Workspace[], id?: string | null) => ws.find(w => w.id === id)

export function displayTitle(t: Thread) {
  return t.customTitle ?? t.oscTitle ?? t.title
}
export function rowTitle(t: Thread) {
  return t.kind === 'terminal' ? displayTitle(t) : t.title
}
function threadPriority(t: Thread) {
  if (t.kind === 'terminal') {
    if (t.hasBell) return 1
    return t.unread ? 2 : 3
  }
  if (t.pendingReply) return 0
  const last = t.messages?.at(-1)
  if (last?.role === 'assistant' && last.error) return 3
  return t.unread ? 2 : 3
}
export function sortThreads(ts: Thread[]) {
  return ts
    .map((t, i) => ({ t, i }))
    .sort(
      (a, b) =>
        Number(!!b.t.pin) - Number(!!a.t.pin) ||
        threadPriority(a.t) - threadPriority(b.t) ||
        b.t.createdAt - a.t.createdAt ||
        b.i - a.i,
    )
    .map(x => x.t)
}
export function sortWorkspaces(ws: Workspace[]) {
  return [...ws].sort((a, b) => Number(!!b.pin) - Number(!!a.pin) || a.createdAt - b.createdAt)
}
export function statusDot(t: Thread) {
  if (t.kind === 'terminal') {
    if (t.status === 'exited') return 'exited'
    if (t.hasBell) return 'need'
    if (t.unread) return 'unread'
    return 'idle'
  }
  if (t.pendingReply) return 'running'
  const last = t.messages?.at(-1)
  if (last?.role === 'assistant' && last.error) return 'error'
  if (t.unread) return 'unread'
  return 'idle'
}
export function relTime(at: number) {
  const s = (Date.now() - at) / 1e3
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}
export function presetCmdSummary(p: Preset) {
  if (!p.program) return p.initCommand ? `（shell）→ ${p.initCommand}` : '（系统默认 shell）'
  const cmd = [p.program, ...(p.args ?? [])].join(' ')
  return p.initCommand ? `${cmd}  →  ${p.initCommand}` : cmd
}
export const presetIcon = (p: Preset) => (p.category === 'agent' ? 'agent' : 'terminal')
export const KIND_ICON = { terminal: 'terminal', chat: 'chat', acp: 'acp' } as const

/* ── settings path ── */
export const getPath = (o: unknown, p: string): unknown =>
  p.split('.').reduce<unknown>((x, k) => (x as Record<string, unknown>)?.[k], o)
export const setPath = (o: unknown, p: string, v: unknown) => {
  const ks = p.split('.')
  let x = o as Record<string, unknown>
  for (let i = 0; i < ks.length - 1; i++) x = x[ks[i]] as Record<string, unknown>
  x[ks[ks.length - 1]] = v
}
export const isModified = (settings: Settings, p: string) =>
  String(getPath(settings, p)) !== String(DEFAULTS[p])

/* ── 设置搜索 ── */
export function matchDef(d: (typeof SETTING_DEFS)[number], q: string) {
  const s = q.toLowerCase()
  return (
    d.label.toLowerCase().includes(s) ||
    d.desc.toLowerCase().includes(s) ||
    d.path.toLowerCase().includes(s)
  )
}
export function sectionHits(settings: Settings, q0: string) {
  const q = q0.trim()
  const hits: Record<string, number> = {}
  if (!q) return hits
  for (const d of SETTING_DEFS) if (matchDef(d, q)) hits[d.section] = (hits[d.section] ?? 0) + 1
  const kl = q.toLowerCase()
  hits.keybindings =
    (hits.keybindings ?? 0) +
    KEY_ACTIONS.filter(
      a => a.label.toLowerCase().includes(kl) || settings.keybindings[a.action]?.includes(kl),
    ).length +
    FIXED_KEYS.filter(([l, k]) => l.toLowerCase().includes(kl) || k.toLowerCase().includes(kl)).length
  const ph = settings.presets.items.filter(p =>
    `${p.label} ${p.id} ${p.program ?? ''} ${p.initCommand ?? ''}`.toLowerCase().includes(kl),
  ).length
  if (ph) hits.presets = (hits.presets ?? 0) + ph
  const ah = settings.acpAgents.filter(a =>
    `${a.label} ${a.command} ${a.args.join(' ')}`.toLowerCase().includes(kl),
  ).length
  if (ah) hits.acp = (hits.acp ?? 0) + ah
  return hits
}

/* ── 字体清单 ── */
export const SYSTEM_FONTS = (() => {
  const ok = (n: string) => {
    try {
      return document.fonts?.check(`12px "${n}"`)
    } catch {
      return true
    }
  }
  const list = FONT_CANDIDATES.filter(ok)
  return list.length ? list : FONT_CANDIDATES
})()

export interface FontItem {
  name: string
  free?: boolean
}
export function fontItems(settings: Settings, path: string, q0: string): FontItem[] {
  const q = q0.trim().toLowerCase()
  const cur = String(getPath(settings, path))
  const base = SYSTEM_FONTS.includes(cur) ? SYSTEM_FONTS : [cur, ...SYSTEM_FONTS]
  let items: FontItem[]
  if (!q) items = base.map(name => ({ name }))
  else {
    const scored: { name: string; rank: number; i: number }[] = []
    base.forEach((name, i) => {
      const l = name.toLowerCase()
      const rank = l.startsWith(q) ? 0 : l.includes(q) ? 1 : -1
      if (rank >= 0) scored.push({ name, rank, i })
    })
    items = scored.sort((a, b) => a.rank - b.rank || a.i - b.i)
  }
  const qRaw = q0.trim()
  if (qRaw && !base.some(n => n.toLowerCase() === qRaw.toLowerCase()))
    items.push({ name: qRaw, free: true })
  return items
}

/* ── tab / 导航模型 ── */
export interface TabRef {
  type: RouteType
  id?: string
}
export const tabKey = (r: RouteTarget | TabRef | null) => (r ? `${r.type}:${r.id ?? ''}` : null)
export function routeFromKey(threads: Thread[], workspaces: Workspace[], k: string): RouteTarget {
  const i = k.indexOf(':')
  const type = k.slice(0, i)
  const id = k.slice(i + 1)
  if (type === 'thread' && !threadById(threads, id)) return null
  if (type === 'workspace' && !wsById(workspaces, id)) return null
  return type === 'settings' ? { type: 'settings' } : ({ type, id } as RouteTarget)
}
export function tabInfo(threads: Thread[], workspaces: Workspace[], r: TabRef) {
  if (r.type === 'thread') {
    const t = threadById(threads, r.id)
    if (!t) return null
    const label = rowTitle(t)
    const cwd = t.kind === 'terminal' ? t.cwd : wsById(workspaces, t.workspaceId)?.path
    return { icon: KIND_ICON[t.kind], label, tip: cwd ? `${label} — ${cwd}` : label, dot: statusDot(t) }
  }
  if (r.type === 'workspace') {
    const ws = wsById(workspaces, r.id)
    if (!ws) return null
    return { icon: ws.paneTab === 'git' ? 'gitBranch' : 'folder', label: ws.name, tip: ws.path, dot: null }
  }
  if (r.type === 'settings') return { icon: 'gear', label: '设置', tip: '设置', dot: null }
  return null
}

/* ── 键位 ── */
export function ksMatch(ks: string, key: string, ctrl: boolean, shift: boolean, cmd: boolean) {
  const parts = ks.split('-')
  const k = parts[parts.length - 1]
  if (k === '' || parts.includes('alt')) return false
  return key === k && ctrl === parts.includes('ctrl') && shift === parts.includes('shift') && cmd === parts.includes('cmd')
}
export const evKey = (e: { key: string }) => (e.key === ' ' ? 'space' : e.key.toLowerCase())
