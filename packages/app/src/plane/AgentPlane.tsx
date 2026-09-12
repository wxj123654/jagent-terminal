/**
 * AgentPlane — 根组件（architecture.md §5 组件树；布局契约 §12 验收面）。
 *
 * V2 布局（原型 .app 左右两列，不再是「顶栏行 + 内容行」）：
 * - 左列 = Sidebar（整列自带头 52px / 列表 / 脚，宽 = appearance.sidebarWidth；
 *   mac 红绿灯让位在其头内）。⌘B 收起 = 整列不渲染。
 * - 右列 = main：46px 工具栏（TitleBar）+ workbench 行（Pane + WorkPanel）。
 * - 窄窗口 <760px：侧栏转绝对定位抽屉 + scrim（面板同 breakpoint 保持列）。
 * - 窗口 <1100px：工作面板转 absolute 右贴 overlay（不压缩终端；原型同款）。
 *
 * store 经 props 注入（main.tsx 装配），组件树内部零全局单例。
 */

import { useWindowSize } from '@gpuix/react'
import { IconButton, PLATFORM, ToastHost, COLORS, FONT } from '@jagent/ui'
import { useEffect, useRef, useState } from 'react'
import type { LastCrash } from '../errors/crashReport'
import { ErrorIndicator } from '../errors/ErrorIndicator'
import type { GitGraphStore } from '../git/store'
import type { WorktreeStore } from '../git/worktree'
import { useActiveTarget } from '../router'
import type { SettingsStore } from '../settings/store'
import { useSettingsValue } from '../settings/useSettings'
import type { ThreadStore } from '../threads/store'
import { displayTitle } from '../threads/terminal'
import { useThreadStore } from '../threads/useThreadStore'
import { SIZES } from '../tokens'
import type { PerfSource } from '../ui/PerfHud'
import { PerfHud } from '../ui/PerfHud'
import { DialogHost, type DialogState } from './DialogHost'
import { dialogKeyboard } from './dialogKeyboard'
import { Pane } from './Pane'
import { planeKeyboard } from './planeKeyboard'
import { Sidebar } from './Sidebar'
import { TitleBar, type WindowControls } from './TitleBar'
import { useWorktree, WorkPanel, type WorkPanelTab } from './WorkPanel'
import type { DirectoryPicker } from './WorkspaceList'

/** 窄窗口抽屉断点（原型 W0 契约）：低于此宽 sidebar 变 overlay 抽屉 */
const NARROW_BREAKPOINT = 760

/** 工具栏会话 chip：当前上下文 → 图标 + 文案（原型 #chip-session） */
function useSessionChip(store: ThreadStore): {
  icon: 'terminal' | 'chat' | 'acp' | 'agent' | 'folder' | 'gear'
  label: string
} {
  const active = useActiveTarget()
  const thread = useThreadStore(store, (s) =>
    active?.type === 'thread' ? s.threads.find((t) => t.id === active.id) : undefined,
  )
  const workspace = useThreadStore(store, (s) =>
    active?.type === 'workspace' ? s.workspaces.find((w) => w.id === active.id) : undefined,
  )
  if (active?.type === 'settings') return { icon: 'gear', label: '设置' }
  if (active?.type === 'workspace' && workspace) return { icon: 'folder', label: workspace.name }
  if (!thread) return { icon: 'agent', label: 'j-agent' }
  const icon = thread.kind === 'terminal' ? 'terminal' : thread.kind === 'acp' ? 'acp' : 'chat'
  return {
    icon,
    label: thread.kind === 'terminal' ? displayTitle(thread) : thread.title,
  }
}

export function App({
  store,
  settings,
  windowControls,
  pickDirectory,
  gitStore,
  worktree,
  scrollToItem,
  perfSource,
  lastCrash,
  version,
}: {
  store: ThreadStore
  settings: SettingsStore
  windowControls?: WindowControls
  /** 原生目录选择（W3；main.tsx 包装 native pickDirectory；缺省隐藏「浏览…」） */
  pickDirectory?: DirectoryPicker
  /** Git 图 store（git-graph.md §4.2；装配层单例，测试可注假 deps） */
  gitStore: GitGraphStore
  /** 工作面板数据面（D5；main.tsx createWorktreeStore；测试可注假 deps） */
  worktree: WorktreeStore
  /** 键盘导航视口跟随（renderer.scrollToItem；装配层注入） */
  scrollToItem?: (elementId: number, index: number) => void
  /** 性能 HUD 数据源（main.tsx 装配：takePaintPerf + process CPU/MEM 采样器；不传则 HUD 不挂载） */
  perfSource?: PerfSource
  /** 上次会话崩溃残留（方案 C 启动提示；main.tsx 读 crash.json 注入） */
  lastCrash?: LastCrash | null
  /** 侧栏脚版本号（装配层注入；缺省不显示） */
  version?: string
}) {
  const chip = useSessionChip(store)
  const active = useActiveTarget()
  // 窄窗口抽屉（W4）：useWindowSize poll 100ms（TestRenderer 无窗口面时
  // fallback 800×600 → 宽窗口态，测试零影响）
  const { width } = useWindowSize()
  const narrow = width < NARROW_BREAKPOINT
  const sidebarWidth = useSettingsValue(settings, (s) => s.appearance.sidebarWidth)
  // 性能 HUD（advanced.perfHud）：单值订阅——开关切换才重渲染顶栏行
  const perfHud = useSettingsValue(settings, (s) => s.advanced.perfHud)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // v2（D2）：侧栏收起态（宽窗口 = 藏 sidebar；窄窗口抽屉同效切换）。
  // ⌘B/Ctrl-B 经 planeKeyboard 模块态进来（main.tsx 键位层）。
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const toggleSidebar = () => {
    if (narrow) setDrawerOpen((v) => !v)
    else setSidebarHidden((v) => !v)
  }
  // 最新回调 ref（D18）：⌘B 经 planeKeyboard 模块态进来，但注册只在挂载时
  // 做一次——若直接闭包 toggleSidebar，跨 760 断口 resize 后快捷键仍作用
  // 于旧宽窄态（stale closure）。ref 每帧刷新，注册的转发函数永读最新。
  const toggleRef = useRef(toggleSidebar)
  toggleRef.current = toggleSidebar
  const drawerRef = useRef({ narrow, drawerOpen })
  drawerRef.current = { narrow, drawerOpen }

  // 工作面板（D5）：开关 / tab / 宽（本地态——原型同款非持久 UI 态）
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelTab, setPanelTab] = useState<WorkPanelTab>('changes')
  const [panelWidth, setPanelWidth] = useState<number>(SIZES.panelWidth)
  const panelOverlay = width < SIZES.panelOverlayWidth

  // 上下文 cwd（工具栏 cwd 文案 + worktree 挂载点）：
  // 活动 terminal → thread.cwd；chat/acp/工作区 → 其工作区 path；其余 null。
  const contextCwd = useThreadStore(store, (s) => {
    if (active?.type === 'thread') {
      const t = s.threads.find((x) => x.id === active.id)
      if (!t) return null
      if (t.kind === 'terminal') return t.cwd
      return s.workspaces.find((w) => w.id === t.workspaceId)?.path ?? null
    }
    if (active?.type === 'workspace')
      return s.workspaces.find((w) => w.id === active.id)?.path ?? null
    return null
  })
  useEffect(() => {
    worktree.mount(contextCwd)
  }, [worktree, contextCwd])
  const branch = useWorktree(worktree, (s) => s.branch)

  // 新建会话目标工作区（侧栏 ＋ / ⌘N / 会话 chip 共用）：
  // 活跃会话归属 → 活跃工作区 → 首个工作区 → ''（弹窗内自选）
  const newSessionWorkspace = (): string => {
    const s = store.getState()
    if (active?.type === 'thread') {
      const t = s.threads.find((x) => x.id === active.id)
      if (t?.workspaceId) return t.workspaceId
    }
    if (active?.type === 'workspace') return active.id
    return s.workspaces[0]?.id ?? ''
  }

  // 弹窗中枢（W7）：四类弹窗单一显示源，入口经 dialog 回调打开。
  // 启动崩溃提示（方案 C）：残留存在 → 初始即弹 crash dialog
  const [dialog, setDialog] = useState<DialogState>(
    lastCrash ? { kind: 'crash', last: lastCrash } : { kind: 'none' },
  )
  const dialogOpener = {
    openToolMenu: (workspaceId: string) => setDialog({ kind: 'tool', workspaceId }),
    openAddWorkspace: () => setDialog({ kind: 'addWorkspace' }),
    openSearch: () => setDialog({ kind: 'search' }),
    openManageSession: (threadId: string) => setDialog({ kind: 'manageSession', threadId }),
    openManageWorkspace: (workspaceId: string) =>
      setDialog({ kind: 'manageWorkspace', workspaceId }),
    openErrors: () => setDialog({ kind: 'errors' }),
  }
  useEffect(() => {
    dialogKeyboard.register({
      openSearch: () => setDialog({ kind: 'search' }),
      newSession: () => setDialog({ kind: 'tool', workspaceId: newSessionWorkspace() }),
    })
    planeKeyboard.register({
      toggle: () => toggleRef.current(),
      // Esc：窄窗抽屉开着 → 关闭并吃掉（弹窗 Esc 由 Modal 自管）
      escape: () => {
        const d = drawerRef.current
        if (d.narrow && d.drawerOpen) {
          setDrawerOpen(false)
          return true
        }
        return false
      },
    })
    return () => {
      dialogKeyboard.register(null)
      planeKeyboard.register(null)
    }
    // active 仅经 newSessionWorkspace 闭包内 getState+ref 读取——注册一次，
    // 永不重挂（D18 stale closure 同款纪律）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openPanel = (tab?: WorkPanelTab) => {
    if (tab) setPanelTab(tab)
    setPanelOpen(true)
    worktree.refresh()
  }

  const sidebar = (
    <Sidebar
      store={store}
      settings={settings}
      dialog={dialogOpener}
      platform={PLATFORM}
      windowControls={windowControls}
      version={version}
      onNewSession={() => dialogOpener.openToolMenu(newSessionWorkspace())}
    />
  )
  const pane = (
    <Pane
      store={store}
      settings={settings}
      dialog={dialogOpener}
      gitStore={gitStore}
      scrollToItem={scrollToItem}
    />
  )
  const panel = panelOpen ? (
    <WorkPanel
      worktree={worktree}
      width={panelWidth}
      overlay={panelOverlay}
      overlayMaxWidth={Math.min(420, width)}
      tab={panelTab}
      onTabChange={setPanelTab}
      onClose={() => setPanelOpen(false)}
      onWidthChange={(w) => setPanelWidth(w)}
      windowWidth={width}
    />
  ) : null

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'row',
        backgroundColor: COLORS.app,
        fontFamily: FONT.ui,
        color: COLORS.text,
        position: 'relative',
      }}
    >
      {/* 左列：侧栏整列（头/列表/脚一体；窄窗口转抽屉，见下） */}
      {!narrow && !sidebarHidden ? sidebar : null}

      {/* 右列 main：46px 工具栏 + workbench（Pane + 工作面板） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          minWidth: 0,
          minHeight: 0,
          backgroundColor: COLORS.pane,
        }}
      >
        <TitleBar
          platform={PLATFORM}
          windowControls={windowControls}
          narrow={narrow}
          drawerOpen={drawerOpen}
          onToggleDrawer={narrow ? () => setDrawerOpen((v) => !v) : undefined}
          sidebarHidden={!narrow && sidebarHidden}
          onToggleSidebar={!narrow ? toggleSidebar : undefined}
          chipIcon={chip.icon}
          chipLabel={chip.label}
          onChipClick={() => dialogOpener.openToolMenu(newSessionWorkspace())}
          cwd={contextCwd}
          branch={branch}
          onBranchClick={() => openPanel('changes')}
          onSearch={() => dialogOpener.openSearch()}
          panelOpen={panelOpen}
          onTogglePanel={() => (panelOpen ? setPanelOpen(false) : openPanel())}
          trailing={
            <>
              <IconButton
                name="gitBranch"
                label="Git 图"
                testId="titlebar-git"
                size={15}
                hitSize={28}
                radius={9999}
                tooltip={false}
                onClick={() => store.openGitGraph()}
              />
              <ErrorIndicator onOpen={dialogOpener.openErrors} />
              {perfHud && perfSource ? <PerfHud source={perfSource} /> : null}
            </>
          }
        />
        {/* workbench：内容面 + 工作面板。<1100px 时面板转 absolute
            overlay（GPUI 按树序绘制——面板后画，盖住 Pane 右缘）。 */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            flexGrow: 1,
            minHeight: 0,
            position: 'relative',
          }}
        >
          {pane}
          {panel}
        </div>
      </div>

      {/* 窄窗口抽屉：Pane 先、抽屉（Sidebar+scrim）后——GPUI 按树序绘制，
          后画的覆盖层才不会被内容整块盖住。 */}
      {narrow && drawerOpen ? (
        <>
          <div
            testId="drawer-scrim"
            onClick={() => setDrawerOpen(false)}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
              backgroundColor: '#00000099',
            }}
          />
          <div
            testId="drawer-panel"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: sidebarWidth,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {sidebar}
          </div>
        </>
      ) : null}

      {/* 弹窗（W7）：全屏遮罩 + 居中卡（deferred 画在一切之上）；
          Toast 右下角浮条 */}
      <DialogHost
        store={store}
        settings={settings}
        state={dialog}
        setState={setDialog}
        pickDirectory={pickDirectory}
      />
      <ToastHost />
    </div>
  )
}
