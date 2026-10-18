import { useEffect, useState } from 'react'
import { useStore } from '@/store'
import { wsById, threadById, ksMatch, evKey } from '@/model'
import { NARROW_BP, GIT_COMMITS } from '@/seed'
import { AppRootCtx } from '@/approot'
import { Sidebar } from '@/components/Sidebar'
import { TitleBar } from '@/components/TitleBar'
import { WorkPanel } from '@/components/WorkPanel'
import {
  HomePane, WorkspacePage, TerminalSurface, ConversationView, FileSurface, SessionShell,
} from '@/components/panes'
import { GitGraphView } from '@/components/GitGraphView'
import { SettingsWindow } from '@/components/SettingsView'
import { DialogHost } from '@/components/Dialogs'
import { cn } from '@/lib/utils'

function Pane() {
  const s = useStore()
  const r = s.route
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

/* ── 原型快速页面切换与多窗口演示控制条 ── */
function DemoBar() {
  const settingsOpen = useStore(s => s.ui.settingsWindowOpen)
  const panelOpen = useStore(s => s.ui.panelOpen)
  const st = () => useStore.getState()

  const goLaunchpad = () => {
    useStore.setState(d => {
      d.ui.settingsWindowOpen = false
      d.ui.dialog = { kind: 'none' }
      d.workspaces[0].paneTab = 'home'
      d.route = { type: 'workspace', id: 'ws-jt' }
    })
  }

  const goChat = () => {
    useStore.setState(d => {
      d.ui.settingsWindowOpen = false
      d.ui.dialog = { kind: 'none' }
      d.route = { type: 'thread', id: 't-sidebar' }
    })
  }

  const goTerm = () => {
    useStore.setState(d => {
      d.ui.settingsWindowOpen = false
      d.ui.dialog = { kind: 'none' }
      const t = d.threads.find(x => x.id === 't-ime')
      if (t) t.activeViewId = 'main'
      d.route = { type: 'thread', id: 't-ime' }
    })
  }

  const goGit = () => {
    useStore.setState(d => {
      d.ui.settingsWindowOpen = false
      d.ui.dialog = { kind: 'none' }
      d.workspaces[0].paneTab = 'git'
      d.route = { type: 'workspace', id: 'ws-jt' }
      d.git.selectedSha = GIT_COMMITS[0]?.sha ?? null
    })
  }

  const togglePanel = () => {
    const nextOpen = !useStore.getState().ui.panelOpen
    useStore.setState(d => {
      d.ui.panelOpen = nextOpen
      if (nextOpen && !d.worktree.selected) {
        d.worktree.selected = 'packages/app/src/plane/Sidebar.tsx'
      }
    })
    if (nextOpen) {
      const sel = useStore.getState().worktree.selected ?? 'packages/app/src/plane/Sidebar.tsx'
      useStore.getState().openSessionFile('t-ime', sel)
      useStore.getState().activate({ type: 'thread', id: 't-ime' })
    }
  }

  const toggleSettingsWin = () => {
    useStore.setState(d => {
      d.ui.settingsWindowOpen = !d.ui.settingsWindowOpen
    })
  }

  const demoClearPresets = () => {
    useStore.setState(d => {
      d.settings.presets.items = []
      d.settings.presets.plusDefault = null
      d.ui.expandedPreset = null
      d.workspaces[0].paneTab = 'home'
      d.route = { type: 'workspace', id: 'ws-jt' }
    })
    st().toast('已清空全部预设（可查看启动台 / 设置页 / 新建会话弹窗的空预设展示效果）')
  }

  return (
    <div id="demo">
      <div className="bar" style={{ flexWrap: 'wrap', gap: 5 }}>
        <button type="button" onClick={goLaunchpad}>01 启动台</button>
        <button type="button" onClick={goChat}>02 AI 对话</button>
        <button type="button" onClick={goTerm}>03 终端+副视图</button>
        <button
          type="button"
          onClick={togglePanel}
          style={panelOpen ? { borderColor: 'var(--accent)', color: 'var(--textBright)' } : undefined}
        >
          04 变更面板
        </button>
        <button type="button" onClick={goGit}>05 Git 图谱</button>
        <button
          type="button"
          onClick={toggleSettingsWin}
          style={
            settingsOpen
              ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }
              : { borderColor: 'rgba(99,102,241,.5)', color: 'var(--accentHover)' }
          }
        >
          06 ⚙ 独立设置窗口
        </button>
        <button type="button" onClick={() => st().openToolDialog('ws-jt')}>07 新建会话</button>
        <button type="button" onClick={() => st().openSearchDialog()}>08 ⌘K 搜索</button>
        <span style={{ width: 1, height: 16, background: 'var(--borderSubtle)', margin: '0 2px' }} />
        <button
          type="button"
          style={{ borderColor: 'rgba(248,113,113,.45)', color: '#fca5a5' }}
          onClick={demoClearPresets}
        >
          🧪 删空预设
        </button>
        <button
          type="button"
          style={{ borderColor: 'rgba(248,113,113,.45)', color: '#fca5a5' }}
          onClick={() => st().clearAllSessions()}
        >
          🧪 清空会话
        </button>
        <button
          type="button"
          style={{ borderColor: 'rgba(52,211,153,.45)', color: 'var(--terminalKind)' }}
          onClick={() => st().loadManySessions()}
        >
          🧪 28+ 会话高密度
        </button>
        <button
          type="button"
          onClick={() => {
            st().resetAll()
            st().toast('已恢复全部默认数据与预设')
          }}
        >
          ↺ 恢复默认
        </button>
        <span style={{ width: 1, height: 16, background: 'var(--borderSubtle)', margin: '0 2px' }} />
        <button type="button" onClick={() => st().fitWidth(1280)}>1280</button>
        <button type="button" onClick={() => st().fitWidth(1000)}>1000</button>
        <button type="button" onClick={() => st().fitWidth(700)}>700</button>
      </div>
      <div className="tag">React 模块化原型 · 支持选择框弹出、预设删减/清空联动、会话清空与 28+ 会话高密度测试</div>
    </div>
  )
}

/* ── 全局键位 ── */
function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState()
      const key = evKey(e)
      const ctrl = e.ctrlKey
      const shift = e.shiftKey
      const cmd = e.metaKey
      const kb = st.settings.keybindings
      const inSettings = st.ui.settingsWindowOpen
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
      if (st.ui.dialog.kind !== 'none') return
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
            if (d.ui.settingsQuery === '') d.ui.settingsWindowOpen = false
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
      }
      if (!ctrl && !cmd) return
      if (ksMatch(kb.cycleNext, key, ctrl, shift, cmd)) {
        e.preventDefault()
        st.cycle(1)
      } else if (ksMatch(kb.cyclePrev, key, ctrl, shift, cmd)) {
        e.preventDefault()
        st.cycle(-1)
      } else if (ksMatch(kb.toggleSettings, key, ctrl, shift, cmd) || (cmd && key === ',')) {
        e.preventDefault()
        useStore.setState(d => void (d.ui.settingsWindowOpen = !d.ui.settingsWindowOpen))
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
    else if (v === 'settings') {
      d.ui.settingsWindowOpen = true
    } else if (v === 'git') {
      d.workspaces[0].paneTab = 'git'
      d.route = { type: 'workspace', id: 'ws-jt' }
    } else if (v === 'workspace') d.route = { type: 'workspace', id: 'ws-web' }
    else if (v === 'chat') d.route = { type: 'thread', id: 't-sidebar' }
    else if (v === 'acp') d.route = { type: 'thread', id: 't-acp' }
    else if (v === 'panel') {
      d.ui.panelOpen = true
      d.worktree.selected = 'packages/app/src/plane/Sidebar.tsx'
      const t = d.threads.find(x => x.id === 't-ime')
      if (t) {
        d.route = { type: 'thread', id: 't-ime' }
        t.activeViewId = 'file:packages/app/src/plane/Sidebar.tsx'
      }
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
    else if (v === 'sess-main' || v === 'sess-git' || v === 'sess-file' || v === 'sess-shell') {
      const t = d.threads.find(x => x.id === 't-ime')
      if (t) {
        d.route = { type: 'thread', id: 't-ime' }
        t.activeViewId =
          v === 'sess-main'
            ? 'main'
            : v === 'sess-git'
              ? 'git'
              : v === 'sess-file'
                ? 'file:packages/app/src/plane/Sidebar.tsx'
                : 'shell:1'
      }
    } else if (v === 'font') {
      d.ui.settingsWindowOpen = true
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
        el.style.borderRadius = '12px'
        el.style.boxShadow = '0 24px 80px rgba(0,0,0,.65)'
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
          <div id="main" className={cn((narrow || sidebarHidden) && 'sidebar-hidden')}>
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
          {/* ── 独立多窗口设置中心 ── */}
          <SettingsWindow />
          <Toasts />
        </div>
        <DemoBar />
      </div>
    </AppRootCtx.Provider>
  )
}
