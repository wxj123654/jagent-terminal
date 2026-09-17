import { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { wsById, threadById, ksMatch, evKey, rowTitle } from '@/model'
import { NARROW_BP, GIT_COMMITS } from '@/seed'
import { AppRootCtx } from '@/approot'
import { Sidebar } from '@/components/Sidebar'
import { TitleBar } from '@/components/TitleBar'
import { WorkPanel } from '@/components/WorkPanel'
import {
  HomePane, WorkspacePage, TerminalSurface, ConversationView, FileSurface, SessionShell,
} from '@/components/panes'
import { GitGraphView } from '@/components/GitGraphView'
import { SettingsView } from '@/components/SettingsView'
import { DialogHost } from '@/components/Dialogs'

function Pane() {
  const s = useStore()
  const r = s.route
  if (r?.type === 'settings') return <SettingsView />
  if (r?.type === 'workspace') {
    const ws = wsById(s.workspaces, r.id)
    if (ws) return <WorkspacePage ws={ws} />
  }
  if (r?.type === 'thread') {
    const t = threadById(s.threads, r.id)
    if (t) {
      const view = t.views?.find(v => v.id === t.activeViewId)
      if (!view)
        return t.kind === 'terminal' ? <TerminalSurface t={t} /> : <ConversationView t={t} />
      if (view.kind === 'git') {
        const ws = wsById(s.workspaces, t.workspaceId)
        if (ws) return <GitGraphView ws={ws} />
        return t.kind === 'terminal' ? <TerminalSurface t={t} /> : <ConversationView t={t} />
      }
      if (view.kind === 'file') return <FileSurface path={view.path} />
      return <SessionShell threadId={t.id} view={view} />
    }
  }
  return <HomePane />
}

function Toasts() {
  const toasts = useStore(s => s.toasts)
  return (
    <div id="toasts">
      {toasts.map(t => (
        <div className="toast" key={t.id}>
          {t.msg}
        </div>
      ))}
    </div>
  )
}

function newSessionWorkspace() {
  const s = useStore.getState()
  const r = s.route
  if (r?.type === 'thread') {
    const t = threadById(s.threads, r.id)
    if (t?.workspaceId) return t.workspaceId
  }
  if (r?.type === 'workspace') return r.id
  return s.workspaces[0]?.id ?? ''
}

/* ── 演示控制条（原型辅助，非应用 UI）── */
function DemoBar() {
  const st = () => useStore.getState()
  const demoBell = () => {
    const s = st()
    const t = s.threads.find(
      x =>
        x.kind === 'terminal' &&
        x.status === 'running' &&
        !(s.route?.type === 'thread' && s.route.id === x.id),
    )
    if (t) {
      useStore.setState(d => void (threadById(d.threads, t.id)!.hasBell = true))
      s.pushNotice(
        'warn',
        `「${rowTitle(t)}」等待注意`,
        (wsById(s.workspaces, t.workspaceId)?.name ?? '未归属') + ' · BEL',
      )
      if (s.settings.notifications.desktop) s.toast(`🔔 ${rowTitle(t)} 等待注意`)
    } else s.toast('没有可打 BEL 的后台终端（先切走一个终端会话）')
  }
  return (
    <div id="demo">
      <div className="bar">
        <button onClick={demoBell}>模拟 BEL</button>
        <button onClick={() => st().pushNotice('ok', '构建完成：jagent-terminal', 'cargo build · 42s')}>
          + 通知
        </button>
        <button
          onClick={() =>
            useStore.setState(d =>
              void d.errors.push({
                level: 'error',
                area: 'native',
                message: 'PTY write failed: EPIPE (demo)',
                at: Date.now(),
              }),
            )
          }
        >
          + 错误
        </button>
        <button onClick={() => useStore.setState(d => void (d.ui.dialog = { kind: 'crash' }))}>
          崩溃残留
        </button>
        <button onClick={() => st().fitWidth(1280)}>1280</button>
        <button onClick={() => st().fitWidth(1000)}>1000</button>
        <button onClick={() => st().fitWidth(700)}>700</button>
        <button
          onClick={() => {
            useStore.setState(d => {
              d.route = { type: 'settings' }
              d.ui.settingsSection = 'terminal'
              d.ui.fontPicker = { path: 'terminal.fontFamily', q: '', hi: 0 }
            })
          }}
        >
          字体选择器
        </button>
        <button onClick={() => st().resetAll()}>重置数据</button>
      </div>
      <div className="tag">原型 · React + shadcn · 非应用 UI</div>
    </div>
  )
}

/* ── 全局键位（keybindings.ts 分层）── */
function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState()
      const key = evKey(e)
      const ctrl = e.ctrlKey
      const shift = e.shiftKey
      const cmd = e.metaKey
      const kb = st.settings.keybindings
      const inSettings = st.route?.type === 'settings'
      const inInput = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '')

      if (st.ui.kbCapturing) {
        e.preventDefault()
        if (key === 'escape') {
          useStore.setState(d => void (d.ui.kbCapturing = null))
          return
        }
        if (['control', 'shift', 'alt', 'meta'].includes(key)) return
        const combo =
          (ctrl ? 'ctrl-' : '') + (shift ? 'shift-' : '') + (cmd ? 'cmd-' : '') + key
        useStore.setState(d => {
          d.settings.keybindings[st.ui.kbCapturing!] = combo
          d.ui.kbCapturing = null
        })
        return
      }
      if (st.ui.dialog.kind !== 'none') return // Radix Dialog 自管 Esc/焦点
      if (key === 'escape' && (st.ui.notifOpen || st.ui.fontPicker)) {
        useStore.setState(d => {
          d.ui.notifOpen = false
          d.ui.fontPicker = null
        })
        return
      }
      if (!ctrl && inSettings) {
        if (key === 'escape') {
          useStore.setState(d => {
            if (d.ui.settingsQuery === '') d.route = d.lastNonSettings
            else d.ui.settingsQuery = ''
          })
          return
        }
        if (ksMatch(kb.focusSearch, key, ctrl, shift, cmd) && !inInput) {
          e.preventDefault()
          document.querySelector<HTMLElement>('[data-settings-search]')?.focus()
          return
        }
      }
      if (!inSettings && ksMatch(kb.searchThreads, key, ctrl, shift, cmd)) {
        e.preventDefault()
        st.openSearchDialog()
        return
      }
      if (!inSettings && ksMatch(kb.newSession, key, ctrl, shift, cmd)) {
        e.preventDefault()
        st.openToolDialog(newSessionWorkspace())
        return
      }
      if (ksMatch(kb.toggleSidebar, key, ctrl, shift, cmd)) {
        e.preventDefault()
        st.toggleSidebar()
        return
      }
      if (key === 'escape' && !ctrl && !cmd && st.ui.winW < NARROW_BP && st.ui.drawerOpen) {
        useStore.setState(d => void (d.ui.drawerOpen = false))
        return
      }
      if (
        !ctrl &&
        !inSettings &&
        !inInput &&
        st.route?.type === 'workspace' &&
        wsById(st.workspaces, st.route.id)?.paneTab === 'git'
      ) {
        if (key === 'r') {
          st.toast('已刷新')
          return
        }
        if (key === 'escape') {
          useStore.setState(d => void (d.git.selectedSha = null))
          return
        }
        if (key === 'arrowdown' || key === 'arrowup') {
          const i = GIT_COMMITS.findIndex(c => c.sha === st.git.selectedSha)
          const n = key === 'arrowdown' ? Math.min(i + 1, GIT_COMMITS.length - 1) : Math.max(i - 1, 0)
          useStore.setState(d => void (d.git.selectedSha = GIT_COMMITS[n < 0 ? 0 : n].sha))
          e.preventDefault()
          return
        }
        if (key === 'enter') {
          e.preventDefault()
          return
        }
      }
      if (!ctrl) return
      if (ksMatch(kb.cycleNext, key, ctrl, shift, cmd)) {
        e.preventDefault()
        st.cycle(1)
      } else if (ksMatch(kb.cyclePrev, key, ctrl, shift, cmd)) {
        e.preventDefault()
        st.cycle(-1)
      } else if (ksMatch(kb.toggleSettings, key, ctrl, shift, cmd)) {
        e.preventDefault()
        useStore.setState(d => {
          if (inSettings) d.route = d.lastNonSettings
          else {
            d.lastNonSettings = d.route
            d.route = { type: 'settings' }
          }
        })
      } else if (ctrl && shift && key === 'g') {
        e.preventDefault()
        st.openGitGraph()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}

/* ── ?view= 深链（截图/演示）── */
function applyDeepLink() {
  const params = new URLSearchParams(location.search)
  const v = params.get('view')
  if (!v) return
  useStore.setState(d => {
    if (v === 'home') d.route = null
    else if (v === 'settings') d.route = { type: 'settings' }
    else if (v === 'git') {
      d.workspaces[0].paneTab = 'git'
      d.route = { type: 'workspace', id: 'ws-jt' }
    } else if (v === 'workspace') d.route = { type: 'workspace', id: 'ws-web' }
    else if (v === 'chat') d.route = { type: 'thread', id: 't-sidebar' }
    else if (v === 'acp') d.route = { type: 'thread', id: 't-acp' }
    else if (v === 'panel') {
      d.ui.panelOpen = true
      d.worktree.selected = 'packages/app/src/plane/Sidebar.tsx'
    } else if (v === 'search') d.ui.dialog = { kind: 'search' }
    else if (v === 'tool') {
      d.ui.dialog = { kind: 'tool' }
      d.ui.toolWs = 'ws-jt'
    } else if (v === 'addws') d.ui.dialog = { kind: 'addWorkspace' }
    else if (v === 'errors') d.ui.dialog = { kind: 'errors' }
    else if (v === 'crash') d.ui.dialog = { kind: 'crash' }
    else if (v === 'notif') d.ui.notifOpen = true
    else if (v === 'narrow') d.ui.winW = 700
    else if (v === 'hidden') d.ui.sidebarHidden = true
    else if (v === 'font') {
      d.route = { type: 'settings' }
      d.ui.settingsSection = 'terminal'
      d.ui.fontPicker = { path: 'terminal.fontFamily', q: params.get('q') ?? '', hi: 0 }
    }
  })
}

export default function App() {
  const winW = useStore(s => s.ui.winW)
  const winH = useStore(s => s.ui.winH)
  const sidebarHidden0 = useStore(s => s.ui.sidebarHidden)
  const drawerOpen = useStore(s => s.ui.drawerOpen)
  const panelOpen = useStore(s => s.ui.panelOpen)
  const sidebarWidth = useStore(s => s.settings.appearance.sidebarWidth)
  const [appEl, setAppEl] = useState<HTMLDivElement | null>(null)

  const narrow = winW < NARROW_BP
  const sidebarHidden = !narrow && sidebarHidden0

  useGlobalKeys()

  useEffect(() => {
    applyDeepLink()
  }, [])

  useEffect(() => {
    const fit = () => {
      const el = appEl
      if (!el) return
      const vw = window.innerWidth
      const vh = window.innerHeight
      const w = Math.min(useStore.getState().ui.winW, vw)
      const h = Math.min(useStore.getState().ui.winH, vh)
      el.style.width = w + 'px'
      el.style.height = h + 'px'
      if (w < vw - 4 || h < vh - 4) {
        el.style.border = '1px solid var(--borderSubtle)'
        el.style.borderRadius = '10px'
        el.style.boxShadow = '0 24px 80px rgba(0,0,0,.6)'
      } else {
        el.style.border = 'none'
        el.style.borderRadius = '0'
        el.style.boxShadow = 'none'
      }
      if (w >= NARROW_BP && useStore.getState().ui.drawerOpen)
        useStore.setState(d => void (d.ui.drawerOpen = false))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [appEl, winW, winH])

  return (
    <AppRootCtx.Provider value={appEl}>
      <div id="winwrap">
        <div id="app" ref={setAppEl}>
          {!narrow && !sidebarHidden && <Sidebar />}
          <div id="main">
            <TitleBar narrow={narrow} sidebarHidden={sidebarHidden} />
            <div id="workbench">
              <Pane />
              {panelOpen && <WorkPanel />}
            </div>
          </div>
          {narrow && drawerOpen && (
            <>
              <div
                id="drawer-scrim"
                onClick={() => useStore.setState(d => void (d.ui.drawerOpen = false))}
              />
              <div id="drawer-panel" style={{ width: sidebarWidth }}>
                <Sidebar />
              </div>
            </>
          )}
          <DialogHost />
          <Toasts />
        </div>
        <DemoBar />
      </div>
    </AppRootCtx.Provider>
  )
}
