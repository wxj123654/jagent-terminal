import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  ErrItem, Notice, RouteTarget, Settings, TermLine, TermSpan, Thread, ToastItem, UiState,
  Workspace, WorktreeState, GitState, TermState,
} from './types'
import {
  NARROW_BP, seedErrors, seedGit, seedNotices, seedSettings, seedThreads,
  seedUi, seedWorkspaces, seedWorktree, GIT_COMMITS,
} from './seed'
import {
  displayTitle, rowTitle, sortThreads, sortWorkspaces, threadById, wsById, tabKey, tabInfo,
  routeFromKey,
} from './model'

let uidN = 0
const uid = (p: string) => `${p}${++uidN}`

export interface StoreState {
  route: RouteTarget
  lastNonSettings: RouteTarget
  workspaces: Workspace[]
  threads: Thread[]
  notices: Notice[]
  noticesRead: number
  errors: ErrItem[]
  settings: Settings
  ui: UiState
  git: GitState
  worktree: WorktreeState
  unassignedShowAll: boolean
  terms: Record<string, TermState>
  toasts: ToastItem[]
}

interface Store extends StoreState {
  activate: (target: RouteTarget, opts?: { nav?: boolean }) => void
  activateWorkspace: (id: string) => void
  closeThread: (id: string) => void
  spawnFromPreset: (presetId: string, workspaceId?: string) => void
  createChat: (workspaceId?: string | null) => void
  createAcp: (agentId: string, label: string, workspaceId?: string | null) => void
  sendChat: (threadId: string, text: string) => void
  toast: (msg: string) => void
  pushNotice: (tone: Notice['tone'], title: string, sub: string) => void
  toggleSidebar: () => void
  toggleDrawer: () => void
  openToolDialog: (wsId?: string | null) => void
  openSearchDialog: () => void
  openSettings: () => void
  closeDialog: () => void
  tabActivate: (key: string) => void
  closeTab: (key: string) => void
  navGo: (d: number) => void
  cycle: (d: number) => void
  openGitGraph: () => void
  openSessionFile: (threadId: string, path: string) => void
  addSessionShell: (threadId: string) => void
  activateSessionView: (threadId: string, viewId: string) => void
  closeSessionView: (threadId: string, viewId: string) => void
  sessionShellKey: (threadId: string, viewId: string, e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) => void
  gitFindStep: (d: number) => void
  checkoutBranch: (name: string) => void
  gitSelect: (sha: string) => void
  wsRemove: (id: string) => void
  termKey: (id: string, e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) => void
  ensureTerm: (id: string) => void
  resetAll: () => void
  fitWidth: (w: number) => void
}

function ensureTab(ui: UiState, r: RouteTarget) {
  const k = tabKey(r)
  if (!k) return
  if (!ui.tabs.some(x => tabKey(x) === k)) ui.tabs.push({ type: r!.type, id: r!.id })
}

export const useStore = create<Store>()(
  immer((set, get) => {
    const push = (fn: (s: Store) => void) => set(fn)

    function toast(msg: string) {
      const id = uid('toast')
      push(s => {
        s.toasts.push({ id, msg })
      })
      setTimeout(() => {
        push(s => {
          s.toasts = s.toasts.filter(t => t.id !== id)
        })
      }, 2600)
    }

    function pushNotice(tone: Notice['tone'], title: string, sub: string) {
      push(s => {
        s.notices.push({ id: uid('n'), tone, title, sub, at: Date.now() })
      })
    }

    function termPrint(id: string, spans: TermSpan[]) {
      push(s => {
        s.terms[id] ??= { lines: [], draft: '' }
        s.terms[id].lines.push({ spans })
      })
    }

    function runTermCmd(t: Thread, cmd: string) {
      const c = cmd.trim()
      const id = t.id
      if (c === '') return
      if (c === 'exit') {
        termPrint(id, [{ text: 'exit', cls: 'c-dim' }])
        termPrint(id, [{ text: '[进程已退出 · exit code 0]', cls: 'exited-bar c-dim' }])
        setTimeout(() => {
          push(s => {
            t.status = 'exited'
            if (s.settings.terminal.closeOnExit) {
              s.threads = s.threads.filter(x => x.id !== id)
            }
          })
          const s2 = get()
          if (s2.route?.type === 'thread' && s2.route.id === id) get().activate(null)
        }, 300)
        return
      }
      if (c === 'clear') {
        push(s => {
          s.terms[id].lines = []
        })
        return
      }
      if (c === 'bell' || c === "printf '\\a'") {
        termPrint(id, [{ text: '# 触发 BEL（\\x07）——切走后该行出现紫点 + 通知', cls: 'c-dim' }])
        setTimeout(() => {
          const s = get()
          if (!(s.route?.type === 'thread' && s.route.id === id)) {
            push(d => {
              const tt = threadById(d.threads, id)
              if (tt) tt.hasBell = true
            })
            pushNotice('warn', `「${rowTitle(t)}」等待注意`, (wsById(get().workspaces, t.workspaceId)?.name ?? '未归属') + ' · BEL')
            if (get().settings.notifications.desktop) toast(`🔔 ${rowTitle(t)} 等待注意`)
          } else {
            termPrint(id, [{ text: '# 当前已聚焦——BEL 不落红点（契约：仅未聚焦时）', cls: 'c-dim' }])
          }
        }, 600)
        return
      }
      if (c.startsWith('title ')) {
        const v = c.slice(6)
        push(s => {
          const tt = threadById(s.threads, id)
          if (tt) tt.oscTitle = v
        })
        termPrint(id, [{ text: `# OSC 标题 → ${v}`, cls: 'c-dim' }])
        return
      }
      if (c === 'ls' || c === 'dir') {
        termPrint(id, [
          { text: 'crates/  packages/  design/  docs/  e2e/', cls: 'c-blue' },
          { text: '  AGENTS.md  Cargo.toml  package.json  README.md  TODOLIST.md' },
        ])
        return
      }
      if (c === 'git status' || c === 'git st') {
        termPrint(id, [{ text: 'On branch ', cls: 'c-dim' }, { text: 'main', cls: 'c-green' }])
        termPrint(id, [{ text: 'Changes not staged:', cls: 'c-dim' }])
        termPrint(id, [{ text: '  modified:   packages/app/src/plane/Sidebar.tsx', cls: 'c-red' }])
        termPrint(id, [{ text: '  modified:   packages/app/src/plane/WorkspaceList.tsx', cls: 'c-red' }])
        return
      }
      if (c === 'pi' || c === 'claude' || c === 'codex' || c === 'amp') {
        termPrint(id, [
          { text: `◆ ${c}`, cls: 'c-purple' },
          { text: ' agent 会话已接入（模拟输出）', cls: 'c-dim' },
        ])
        termPrint(id, [{ text: '  读取 AGENTS.md … 就绪。输入 prompt 开始。', cls: 'c-dim' }])
        return
      }
      if (c.startsWith('echo ')) {
        termPrint(id, [{ text: c.slice(5) }])
        return
      }
      termPrint(id, [{ text: `$ ${c}`, cls: 'c-dim' }])
      termPrint(id, [{ text: '（原型模拟终端——试试 ls / git status / bell / title xxx / exit）', cls: 'c-dim' }])
    }

    function termScript(t: Thread, presetId: string) {
      const p = get().settings.presets.items.find(x => x.id === presetId)
      if (!p) return
      setTimeout(() => {
        const s = get()
        if (!s.terms[t.id]) return
        termPrint(t.id, [
          { text: `# spawn: ${p.program ?? '（系统默认 shell）'}${p.initCommand ? ` → ${p.initCommand}` : ''}`, cls: 'c-dim' },
        ])
        if (p.initCommand)
          termPrint(t.id, [{ text: `◆ ${p.initCommand}`, cls: 'c-purple' }, { text: ' ready', cls: 'c-dim' }])
      }, 50)
    }

    return {
      route: { type: 'thread', id: 't-ime' },
      lastNonSettings: { type: 'thread', id: 't-ime' },
      workspaces: seedWorkspaces(),
      threads: seedThreads(),
      notices: seedNotices(),
      noticesRead: 1,
      errors: seedErrors(),
      settings: seedSettings(),
      ui: seedUi(),
      git: seedGit(),
      worktree: seedWorktree(),
      unassignedShowAll: false,
      terms: {},
      toasts: [],

      activate(target, opts) {
        push(s => {
          const prev = s.route
          if (target?.type === 'thread') {
            const t = threadById(s.threads, target.id)
            if (t) {
              t.unread = false
              t.hasBell = false
            }
          }
          if (target?.type !== 'settings') s.lastNonSettings = target ?? s.lastNonSettings
          if (!opts?.nav) {
            if (prev && (prev.type !== target?.type || prev.id !== target?.id)) s.ui.navBack.push(prev)
            s.ui.navFwd = []
          }
          s.route = target
          if (target) ensureTab(s.ui, target)
        })
      },

      activateWorkspace(id) {
        const s = get()
        const ws = wsById(s.workspaces, id)
        if (!ws) return
        const sessions = s.threads.filter(t => t.workspaceId === id)
        if (ws.lastSessionId && sessions.some(t => t.id === ws.lastSessionId)) {
          s.activate({ type: 'thread', id: ws.lastSessionId })
        } else if (sessions.length) {
          s.activate({ type: 'thread', id: sortThreads(sessions)[0].id })
        } else {
          push(d => {
            const w = wsById(d.workspaces, id)
            if (w) w.paneTab = 'home'
          })
          s.activate({ type: 'workspace', id })
        }
      },

      closeThread(id) {
        const s = get()
        const t = threadById(s.threads, id)
        if (!t) return
        push(d => {
          const tt = threadById(d.threads, id)!
          if (tt.kind === 'terminal' && tt.status !== 'exited' && !d.settings.terminal.closeOnExit) {
            tt.status = 'exited'
          } else {
            d.threads = d.threads.filter(x => x.id !== id)
          }
        })
        const s2 = get()
        if (s2.route?.type === 'thread' && s2.route.id === id) {
          const rest = s2.threads.filter(x => x.workspaceId === t.workspaceId)
          const ws = t.workspaceId ? wsById(s2.workspaces, t.workspaceId) : null
          if (rest.length) s2.activate({ type: 'thread', id: sortThreads(rest)[0].id })
          else if (ws) s2.activate({ type: 'workspace', id: ws.id })
          else s2.activate(null)
        }
      },

      spawnFromPreset(presetId, workspaceId) {
        const s = get()
        const p = s.settings.presets.items.find(x => x.id === presetId)
        if (!p) return
        const ws = workspaceId ? wsById(s.workspaces, workspaceId) : s.workspaces[0]
        const t: Thread = {
          id: uid('t'), kind: 'terminal', title: p.label, workspaceId: ws?.id ?? null,
          sessionId: 100 + s.threads.length, status: 'running', cwd: p.cwd ?? ws?.path ?? '',
          createdAt: Date.now(), preset: presetId,
        }
        push(d => {
          d.threads.push(t)
          const w = ws ? wsById(d.workspaces, ws.id) : null
          if (w) {
            w.expanded = true
            w.lastSessionId = t.id
          }
          d.terms[t.id] = {
            draft: '',
            lines: [{ spans: [{ text: `# ${t.cwd || '~'} — ${p.label}（session ${t.sessionId}）`, cls: 'c-dim' }] }],
          }
        })
        termScript(t, presetId)
        get().activate({ type: 'thread', id: t.id })
        toast(`已启动 ${p.label}`)
      },

      createChat(workspaceId) {
        const s = get()
        const ws = workspaceId ? wsById(s.workspaces, workspaceId) : null
        if (!ws) return
        const t: Thread = {
          id: uid('t'), kind: 'chat', title: 'New Chat', workspaceId, createdAt: Date.now(),
          messages: [], pendingReply: false,
        }
        push(d => {
          d.threads.push(t)
          const w = wsById(d.workspaces, workspaceId!)
          if (w) w.expanded = true
        })
        get().activate({ type: 'thread', id: t.id })
      },

      createAcp(agentId, label, workspaceId) {
        const s = get()
        const ws = workspaceId ? wsById(s.workspaces, workspaceId) : null
        if (!ws) return
        const cmd = s.settings.acpAgents.find(a => a.id === agentId)?.command
        const t: Thread = {
          id: uid('t'), kind: 'acp', title: label, workspaceId, createdAt: Date.now(),
          messages: [{ id: uid('m'), role: 'assistant', text: `ACP session initialized: \`${cmd}\`` }],
          pendingReply: false,
        }
        push(d => {
          d.threads.push(t)
          const w = wsById(d.workspaces, workspaceId!)
          if (w) w.expanded = true
        })
        get().activate({ type: 'thread', id: t.id })
      },

      sendChat(threadId, text) {
        push(s => {
          const t = threadById(s.threads, threadId)
          if (!t) return
          t.messages ??= []
          t.messages.push({ id: uid('m'), role: 'user', text })
          t.pendingReply = true
        })
        setTimeout(() => {
          push(s => {
            const t = threadById(s.threads, threadId)
            if (!t) return
            t.messages!.push({
              id: uid('m'), role: 'assistant',
              text:
                t.kind === 'acp'
                  ? `收到。ACP agent 回显：\n\n\`\`\`\n${text}\n\`\`\``
                  : `Echo：${text}\n\n这是原型模拟回复——真实实现里这里走 ChatAgent seam（chat 的 EchoAgent / acp 的 JSON-RPC 连接）。`,
            })
            t.pendingReply = false
            if (!(s.route?.type === 'thread' && s.route.id === t.id)) t.unread = true
          })
        }, 900)
      },

      toast,
      pushNotice,

      toggleSidebar() {
        push(s => {
          if (s.ui.winW < NARROW_BP) s.ui.drawerOpen = !s.ui.drawerOpen
          else s.ui.sidebarHidden = !s.ui.sidebarHidden
        })
      },
      toggleDrawer() {
        push(s => {
          s.ui.drawerOpen = !s.ui.drawerOpen
        })
      },

      openToolDialog(wsId) {
        push(s => {
          s.ui.toolWs = wsId ?? null
          s.ui.toolWsIncludeTemp = wsId === ''
          s.ui.toolFilter = ''
          s.ui.dialog = { kind: 'tool' }
        })
      },
      openSearchDialog() {
        push(s => {
          s.ui.dialog = { kind: 'search' }
          s.ui.searchQuery = ''
          s.ui.searchCursor = 0
        })
      },
      openSettings() {
        push(s => {
          if (s.route?.type !== 'settings') s.lastNonSettings = s.route
          s.route = { type: 'settings' }
        })
      },
      closeDialog() {
        push(s => {
          s.ui.dialog = { kind: 'none' }
        })
      },

      tabActivate(key) {
        const s = get()
        const r = routeFromKey(s.threads, s.workspaces, key)
        if (r) s.activate(r)
      },
      closeTab(key) {
        const s = get()
        const i = s.ui.tabs.findIndex(x => tabKey(x) === key)
        if (i < 0) return
        push(d => {
          d.ui.tabs.splice(i, 1)
        })
        const s2 = get()
        if (tabKey(s2.route) === key) {
          const nxt = s2.ui.tabs[i] ?? s2.ui.tabs[i - 1] ?? null
          s2.activate(nxt ? { ...nxt } : null)
        }
      },
      navGo(d) {
        const s = get()
        const from = d < 0 ? s.ui.navBack : s.ui.navFwd
        const to = d < 0 ? s.ui.navFwd : s.ui.navBack
        let t: RouteTarget
        while ((t = from.pop()!) && !tabInfo(s.threads, s.workspaces, t));
        if (!t) return
        push(x => {
          if (x.route) to.push(x.route)
        })
        get().activate(t, { nav: true })
      },
      cycle(d) {
        const s = get()
        const order: Thread[] = []
        for (const ws of sortWorkspaces(s.workspaces))
          order.push(...sortThreads(s.threads.filter(t => t.workspaceId === ws.id)))
        order.push(...sortThreads(s.threads.filter(t => t.workspaceId == null)))
        if (!order.length) return
        const cur = s.route?.type === 'thread' ? order.findIndex(t => t.id === s.route!.id) : -1
        const next = order[(cur + d + order.length) % order.length]
        s.activate({ type: 'thread', id: next.id })
      },

      openGitGraph() {
        const s = get()
        const r = s.route
        if (r?.type === 'thread') {
          const t = threadById(s.threads, r.id)
          if (t?.workspaceId) {
            push(d => {
              const tt = threadById(d.threads, r.id)
              if (!tt) return
              tt.views ??= []
              if (!tt.views.some(v => v.id === 'git'))
                tt.views.push({ id: 'git', kind: 'git', label: 'Git 图' })
              tt.activeViewId = 'git'
            })
            return
          }
        }
        let wsId = r?.type === 'workspace' ? r.id : null
        if (r?.type === 'thread') wsId = threadById(s.threads, r.id)?.workspaceId ?? null
        wsId = wsId ?? s.workspaces[0]?.id
        if (!wsId) return
        push(d => {
          const ws = wsById(d.workspaces, wsId!)
          if (ws) ws.paneTab = 'git'
        })
        get().activate({ type: 'workspace', id: wsId })
      },

      openSessionFile(threadId, path) {
        push(s => {
          const t = threadById(s.threads, threadId)
          if (!t) return
          t.views ??= []
          const id = `file:${path}`
          if (!t.views.some(v => v.id === id))
            t.views.push({ id, kind: 'file', label: path.split('/').pop() ?? path, path })
          t.activeViewId = id
        })
      },

      addSessionShell(threadId) {
        push(s => {
          const t = threadById(s.threads, threadId)
          if (!t) return
          t.views ??= []
          let n = 1
          while (t.views.some(v => v.id === `shell:${n}`)) n++
          const cwd = t.cwd || wsById(s.workspaces, t.workspaceId)?.path || '~'
          t.views.push({
            id: `shell:${n}`,
            kind: 'shell',
            label: `Shell ${n}`,
            cwd,
            lines: [{ spans: [{ text: `# ${cwd} — Session 内工具`, cls: 'c-dim' }] }],
            draft: '',
          })
          t.activeViewId = `shell:${n}`
        })
      },

      activateSessionView(threadId, viewId) {
        push(s => {
          const t = threadById(s.threads, threadId)
          if (!t) return
          if (viewId !== 'main' && !t.views?.some(v => v.id === viewId)) return
          t.activeViewId = viewId
        })
      },

      closeSessionView(threadId, viewId) {
        push(s => {
          const t = threadById(s.threads, threadId)
          if (!t || viewId === 'main') return
          const i = t.views?.findIndex(v => v.id === viewId) ?? -1
          if (i < 0) return
          t.views!.splice(i, 1)
          if (t.activeViewId === viewId) t.activeViewId = t.views![i - 1]?.id ?? 'main'
        })
      },

      sessionShellKey(threadId, viewId, e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return
        push(s => {
          const t = threadById(s.threads, threadId)
          const v = t?.views?.find(v => v.id === viewId)
          if (!v || v.kind !== 'shell') return
          if (e.key === 'Enter') {
            v.lines.push({ spans: [{ text: '❯ ', cls: 'c-green' }, { text: v.draft }] })
            v.lines.push({ spans: [{ text: '（Session 内 Shell 原型）', cls: 'c-dim' }] })
            v.draft = ''
          } else if (e.key === 'Backspace') {
            v.draft = v.draft.slice(0, -1)
          } else if (e.key.length === 1) {
            v.draft += e.key
          }
        })
      },

      gitFindStep(d) {
        const s = get()
        const q = s.ui.gitFindDraft.trim().toLowerCase()
        if (!q) return
        const m = GIT_COMMITS.map((c, i) => ({ c, i })).filter(
          x => x.c.msg.toLowerCase().includes(q) || x.c.sha.startsWith(q),
        )
        if (!m.length) return
        push(x => {
          x.git.findIdx = (x.git.findIdx + d + m.length) % m.length
          x.git.selectedSha = m[x.git.findIdx].c.sha
        })
      },

      checkoutBranch(name) {
        const s = get()
        const b = s.git.branches.find(x => x.name === name)
        if (!b || b.current) return
        push(d => {
          d.git.branches.forEach(x => (x.current = false))
          const bb = d.git.branches.find(x => x.name === name)!
          bb.current = true
          d.git.branch = name
          d.worktree.branch = name
        })
        toast(`已切换到 ${name}`)
      },

      gitSelect(sha) {
        push(s => {
          s.git.selectedSha = s.git.selectedSha === sha ? null : sha
        })
      },

      wsRemove(id) {
        push(s => {
          s.threads = s.threads.filter(t => t.workspaceId !== id)
          s.workspaces = s.workspaces.filter(x => x.id !== id)
          if (s.route?.type === 'workspace' && s.route.id === id)
            s.route = s.workspaces[0] ? { type: 'workspace', id: s.workspaces[0].id } : null
        })
        toast('工作区已移除')
      },

      ensureTerm(id) {
        const s = get()
        if (s.terms[id]) return
        const t = threadById(s.threads, id)
        if (!t) return
        push(d => {
          const lines: TermLine[] = [
            { spans: [{ text: `# ${t.cwd || '~'} — ${rowTitle(t)}（session ${t.sessionId}）`, cls: 'c-dim' }] },
          ]
          if (t.status === 'exited')
            lines.push({
              spans: [{ text: '[进程已退出 · exit code 0] — 灰行保留，「退出后直接关闭」开启时销毁', cls: 'exited-bar c-dim' }],
            })
          d.terms[id] = { lines, draft: '' }
        })
      },

      termKey(id, e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return
        const s = get()
        const t = threadById(s.threads, id)
        if (!t || t.status === 'exited') return
        const term = s.terms[id]
        if (!term) return
        if (e.key === 'Enter') {
          const cmd = term.draft
          push(d => {
            d.terms[id].draft = ''
            d.terms[id].lines.push({ spans: [{ text: '❯ ', cls: 'c-green' }, { text: cmd }] })
          })
          runTermCmd(t, cmd)
        } else if (e.key === 'Backspace') {
          push(d => {
            d.terms[id].draft = d.terms[id].draft.slice(0, -1)
          })
        } else if (e.key.length === 1) {
          push(d => {
            d.terms[id].draft += e.key
          })
        }
      },

      resetAll() {
        push(s => {
          Object.assign(s, {
            route: { type: 'thread', id: 't-ime' } as RouteTarget,
            lastNonSettings: { type: 'thread', id: 't-ime' } as RouteTarget,
            workspaces: seedWorkspaces(),
            threads: seedThreads(),
            notices: seedNotices(),
            noticesRead: 1,
            errors: seedErrors(),
            settings: seedSettings(),
            ui: seedUi(),
            git: seedGit(),
            worktree: seedWorktree(),
            unassignedShowAll: false,
            terms: {},
            toasts: [],
          })
        })
      },

      fitWidth(w) {
        push(s => {
          s.ui.winW = w
        })
      },
    }
  }),
)

/* ── 会话搜索（searchThreads）── */
export function searchThreads(s: StoreState, q: string) {
  const lower = q.toLowerCase()
  const hits: { thread: Thread; workspace: Workspace | null }[] = []
  for (const t of s.threads) {
    const ws = t.workspaceId ? wsById(s.workspaces, t.workspaceId) ?? null : null
    const title = t.kind === 'terminal' ? displayTitle(t) : t.title
    const tool =
      t.kind === 'terminal'
        ? s.settings.presets.items.find(p => p.id === t.preset)?.label ?? 'Terminal'
        : t.kind === 'acp'
          ? 'ACP'
          : 'Chat'
    const dir = t.kind === 'terminal' ? t.cwd : ws?.path ?? ''
    if (`${title} ${tool} ${dir} ${ws?.name ?? ''} ${ws?.path ?? ''}`.toLowerCase().includes(lower))
      hits.push({ thread: t, workspace: ws })
  }
  return hits
}
