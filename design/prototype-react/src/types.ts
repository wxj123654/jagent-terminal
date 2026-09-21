export type ThreadKind = 'terminal' | 'chat' | 'acp'
export type RouteType = 'thread' | 'workspace' | 'settings'
export type RouteTarget = { type: RouteType; id?: string } | null

export interface Msg {
  id: string
  role: 'user' | 'assistant'
  text: string
  error?: boolean
}

export interface Workspace {
  id: string
  name: string
  path: string
  pin?: boolean
  expanded: boolean
  createdAt: number
  paneTab: 'home' | 'git'
  lastSessionId?: string
  showAll?: boolean
}

export type SessionView =
  | { id: string; kind: 'git'; label: string }
  | { id: string; kind: 'file'; label: string; path: string }
  | { id: string; kind: 'shell'; label: string; cwd: string; lines: TermLine[]; draft: string }

export interface Thread {
  id: string
  kind: ThreadKind
  title: string
  customTitle?: string
  oscTitle?: string
  workspaceId?: string | null
  pin?: boolean
  unread?: boolean
  hasBell?: boolean
  createdAt: number
  sessionId?: number
  status?: 'running' | 'exited'
  cwd?: string
  messages?: Msg[]
  pendingReply?: boolean
  preset?: string
  views?: SessionView[]
  activeViewId?: string
  _editing?: boolean
  _draft?: string
}

export interface Notice {
  id: string
  tone: 'ok' | 'warn' | 'err'
  title: string
  sub: string
  at: number
}

export interface ErrItem {
  level: 'error' | 'warn' | 'info'
  area: string
  message: string
  at: number
}

export interface Preset {
  id: string
  label: string
  program?: string
  args?: string[]
  env?: Record<string, string>
  initCommand?: string
  cwd?: string
  category: 'agent' | 'tool'
  builtin?: boolean
  description?: string
  _mod?: Record<string, number>
}

export interface AcpAgent {
  id: string
  label: string
  command: string
  args: string[]
}

export interface Settings {
  notifications: { desktop: boolean; sound: boolean }
  terminal: {
    fontFamily: string
    fontSize: number
    cursorBlink: boolean
    scrollbackLines: number
    palette: string
    closeOnExit: boolean
  }
  appearance: { theme: string; sidebarWidth: number }
  keybindings: Record<string, string>
  presets: { plusDefault: string | null; items: Preset[] }
  acpAgents: AcpAgent[]
  advanced: { gpuBackend: string; perfHud: boolean; frameOverlay: boolean }
}

export type DialogState =
  | { kind: 'none' }
  | { kind: 'tool' }
  | { kind: 'search' }
  | { kind: 'addWorkspace' }
  | { kind: 'rename'; target: { type: 'thread' | 'workspace'; id: string } }
  | { kind: 'errors' }
  | { kind: 'crash' }

export interface FontPickerState {
  path: string
  q: string
  hi: number
}

export interface UiState {
  sidebarHidden: boolean
  drawerOpen: boolean
  panelOpen: boolean
  panelTab: 'changes' | 'files'
  panelWidth: number
  dialog: DialogState
  notifOpen: boolean
  settingsSection: string
  settingsQuery: string
  toolFilter: string
  toolWs: string | null
  toolWsIncludeTemp?: boolean
  searchQuery: string
  searchCursor: number
  expandedPreset: string | null
  expandedAgent: string | null
  kbCapturing: string | null
  gitFindOpen: boolean
  gitFindDraft: string
  fontPicker: FontPickerState | null
  tabs: { type: RouteType; id?: string }[]
  navBack: RouteTarget[]
  navFwd: RouteTarget[]
  winW: number
  winH: number
}

export interface GitBranch {
  name: string
  current: boolean
  up: string
}

export interface GitRef {
  k: 'head' | 'branch' | 'remote' | 'tag'
  t: string
}

export interface GitCommit {
  sha: string
  msg: string
  author: string
  time: string
  lane: number
  lanes: number[]
  merge?: { from: number; to: number }
  refs?: GitRef[]
  files: string[]
  body?: string
  hollow?: boolean
}

export interface GitState {
  branch: string
  showRemote: boolean
  selectedSha: string | null
  findIdx: number
  branches: GitBranch[]
}

export interface WtFile {
  path: string
  status: 'm' | 'a' | 'd'
  added: number | null
  deleted: number | null
}

export interface WorktreeState {
  status: string
  selected: string | null
  branch: string
  files: WtFile[]
}

export interface TermSpan {
  text: string
  cls?: string
}

export interface TermLine {
  spans: TermSpan[]
}

export interface TermState {
  lines: TermLine[]
  draft: string
}

export interface ToastItem {
  id: string
  msg: string
}
