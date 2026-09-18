/**
 * main.tsx — 装配层（architecture.md §1.2 / §5）。
 *
 * 职责（且仅此三件）：
 * 1. seam 装配：installTerminalElement（renderer.init 之前）+ onSessionEvent
 *    → ThreadStore（全局会话事件，后台也送达）
 * 2. ThreadStore 创建（native 装配在 threads/nativeDeps.ts 工厂）
 *    + 路由 + App 渲染（appWindow 持有 renderer，公开 startFrameLoop 泵 macOS）
 * 3. 全局键位层（Ctrl-Tab / Ctrl-Shift-Tab / Ctrl-,）：窗口级 keyDown，
 *    只处理带修饰键组合，其余透传（硬约束 2：不吃 vim/claude 按键）。
 *    ⚠ T1.6 验证项：TerminalView 聚焦时窗口 keyDown 是否仍到达——
 *    到达则 Ctrl-Tab 全局可用；否则降级「列表/UI 聚焦时生效」并记录。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  installGitGraphRowElement,
  installNativePanicHook,
  installTerminalElement,
  onNativePanic,
  onSessionEvent,
  pickDirectory as pickDirectoryNative,
  takePaintPerf,
} from '@jagent/native'

import { inputFocus, PLATFORM } from '@jagent/ui'
import { appWindow } from './appWindow'
import { watchFrameOverlay } from './diagnostics/frameOverlay'
import { createPerfSource } from './diagnostics/perfSource'
import { dialogKeyboard } from './dialogs/dialogKeyboard'
import { enterCrashSidecarIfRequested, setupCrashReportingForApp } from './errors/crashReport'
import { ErrorBoundary } from './errors/ErrorBoundary'
import { installGlobalGuards } from './errors/guards'
import { installErrorLog } from './errors/log'
import { registerNativePanicHandler } from './errors/native'
import { wireErrorToasts } from './errors/toastWire'
import { createGitGraphKey } from './git/graphKeys'
import { createGitGraphStore } from './git/store'
import { createWorktreeStore } from './git/worktree'
import { createGlobalKeydown } from './keybindings'
import { App } from './plane/AgentPlane'
import { planeKeyboard } from './plane/planeKeyboard'
import type { WindowControls } from './plane/TitleBar'
import {
  router,
  activeTargetFromLocation,
  currentActiveThreadId,
  currentActiveWorkspaceId,
  lastNonSettings,
} from './router'
import { fsAdapter } from './settings/file'
import { createSettingsStore } from './settings/store'
import { settingsKeyboard } from './surfaces/settingsKeyboard'
import { narrowSessionEvent } from './threads/events'
import { createNativeThreadDeps } from './threads/nativeDeps'
import { createWorkspacePersister } from './threads/statePersistence'
import { createThreadStore } from './threads/store'
import { defaultWorkspace, parseWorkspaceState } from './threads/workspaces'
import { APP_VERSION } from './version'

// ── 发布形态 sidecar 变道（方案 C）──
// bun compile 只有一个 entry：sidecar 与主进程共用本文件（dev 形态走独立
// 脚本 scripts/crash-handler.ts，不经过这里）。runCrashSidecar 是「注册监控
// + 靠 stdin 事件循环存活」的非阻塞调用——返回不代表结束，所以 sidecar 必须
// 在这里被挂起，让下面的应用装配一行都不执行。否则每个 sidecar 都会开一个
// 自己的窗口，并在 setupCrashReportingForApp 里再 spawn 子 sidecar → 进程树
// 与窗口数持续暴涨（2026-09-11 实机复现：数秒内 21+ 个窗口）。
if (enterCrashSidecarIfRequested()) {
  await new Promise<never>(() => {}) // 存活至 stdin EOF（runCrashSidecar 的 finish 收尾）
} else {
  await mountApp()
}

/** 主进程装配（仅非 sidecar 进程执行）。 */
async function mountApp(): Promise<void> {
  // ── 错误管理装配（docs/error-management.md 方案 A；最先做——后续任何装配
  // 错误都进总线而非无声崩溃）──
  // 全局守卫：uncaughtException/unhandledRejection → 总线，进程保活
  installGlobalGuards()
  // 落盘：~/.j-agent/logs/errors-YYYYMMDD.log（保留 7 天）
  installErrorLog()
  // error/fatal → 右下角 toast（4s）
  wireErrorToasts()
  // Rust panic 转发（方案 B）：TSF 先注册、hook 后装（hook 触发时读 TSF）
  registerNativePanicHandler(onNativePanic)
  installNativePanicHook(join(homedir(), '.j-agent', 'logs'))

  // ── 进程外崩溃报告（方案 C）：拉 sidecar + crash-handler + 读残留 ──
  // 在 renderer 开窗之前：崩溃保护越早生效越好。失败静默降级（panic
  // hook 照装，无 dump）。返回的残留用于启动提示（App prop 传入）。
  // 与 SettingsSections / packages/app/package.json 同步（resolveJsonModule 未开）
  const lastCrash = await setupCrashReportingForApp(APP_VERSION)

  // ── seam 装配（顺序敏感：先注册元素，再开窗）──────────────────────────
  installTerminalElement()
  installGitGraphRowElement()

  // ── SettingsStore（~/.j-agent/settings.json；S3 事实源）──
  // 装配期读盘 await 后再建 ThreadStore（T2.5：nativeDeps 读设置面）。
  // 首次运行只读不写（实测 ~/.j-agent 不创建，S3 语义正确）
  const settingsStore = createSettingsStore(fsAdapter(join(homedir(), '.j-agent', 'settings.json')))
  await settingsStore.init()

  // ── ThreadStore（native 依赖注入收口处；设置面先行）──
  // 工作区持久化（Phase W）：独立 state.json（含运行时态 expanded/lastSession，
  // 与用户设置的 settings.json 分文件）；threads 不持久化（PTY 重启即死）。
  // 首启空列表 → 默认工作区（当前目录）；parse 已容错坏 JSON/坏行
  const stateFile = fsAdapter(join(homedir(), '.j-agent', 'state.json'))
  const initialWorkspaces = parseWorkspaceState(await stateFile.read())
  const threadStore = createThreadStore(
    {
      ...createNativeThreadDeps(settingsStore),
      persistWorkspaces: createWorkspacePersister(stateFile),
    },
    {
      initialWorkspaces:
        initialWorkspaces.length > 0 ? initialWorkspaces : [defaultWorkspace(process.cwd())],
    },
  )

  onSessionEvent((_err, e) => {
    // seam 边界窄化：未知 type 拒绝（events.ts）
    const n = narrowSessionEvent(e)
    if (n) threadStore.onSessionEvent(n)
  })

  // ── GitGraphStore（git-graph.md §4.1；单例，mount 跟随 workspace tab）──
  const gitStore = createGitGraphStore()
  // ── WorktreeStore（D5 工作面板 + 工具栏分支徽章；mount 跟随上下文 cwd）──
  const worktreeStore = createWorktreeStore()

  // ── 窗口（renderer 实例自持：`/` 全局聚焦需要 focusElement 命令面）──
  // 先建 renderer 再接键位层（闭包引用 renderer，声明顺序即初始化顺序）
  const renderer = appWindow.renderer({
    title: 'j-agent',
    appName: 'j-agent',
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    // 自绘顶栏（plane/TitleBar.tsx）：三平台均隐系统条；linux 另请求
    // Client decorations（CSD），TitleBar 承担拖拽 + 最小化/最大化/关闭。
    titlebarTransparent: true,
    ...(PLATFORM === 'linux' ? { windowDecorations: 'client' as const } : {}),
  })

  // ── 屏幕帧 overlay（advanced.frameOverlay → native 覆盖层；同步去重
  // 与失败重试归 diagnostics/frameOverlay.ts）──
  watchFrameOverlay(renderer, settingsStore)

  // ── 全局键位层（keybindings.ts：main/e2e 共用语义；布线在此）──
  // ── 窗口控制 seam（TitleBar 注入；闭包 renderer）──
  const windowControls: WindowControls = {
    startMove: () => void renderer.startWindowMove(),
    doubleClick: () => void renderer.titlebarDoubleClick(),
    minimize: () => void renderer.minimizeWindow?.(),
    maximize: () => void renderer.titlebarDoubleClick(),
    close: () => void renderer.closeWindow?.(),
  }
  const handleKeyDown = createGlobalKeydown({
    store: threadStore,
    inSettings: () =>
      activeTargetFromLocation(router.history.location.pathname)?.type === 'settings',
    closeSettings: () => threadStore.activate(lastNonSettings()),
    focusSearch: () => {
      const id = settingsKeyboard.searchInputId()
      if (id != null) renderer.focusElement(id)
    },
    // W7 ⌘K/Ctrl-K：打开搜索会话弹窗（原型语义；原 W4 聚焦侧栏搜索框废弃）
    openSearch: () => dialogKeyboard.openSearch(),
    toggleSidebar: () => {
      // D2 ⌘B/Ctrl-B：经 plane 模块态（AgentPlane useEffect 注册）
      planeKeyboard.toggleSidebar()
    },
    // D7 ⌘N（mac）/Ctrl-Shift-N：新建会话弹窗（目标工作区由 AgentPlane 算）
    newSession: () => dialogKeyboard.newSession(),
    // D18 抽屉 Esc：窄窗侧栏抽屉开着时吃掉关闭之（弹窗 Esc 归 Modal 管）
    drawerEsc: () => planeKeyboard.escape(),
    // Git 图键位（git-graph.md §4.3）：与顶栏按钮共用 store.openGitGraph
    openGitGraph: () => threadStore.openGitGraph(),
    gitGraphKey: createGitGraphKey({
      activeWorkspaceId: currentActiveWorkspaceId,
      workspaces: () => threadStore.getState().workspaces,
      // 会话内 git 视图（SessionTabs 'git' tab）也算 Git 图激活态
      activeSessionGitView: () => {
        const id = currentActiveThreadId()
        if (!id) return false
        const t = threadStore.getState().threads.find((x) => x.id === id)
        return t?.views?.find((v) => v.id === t.activeViewId)?.kind === 'git'
      },
      store: gitStore,
    }),
    inputFocused: () => inputFocus.any,
    settingsQuery: settingsKeyboard.query,
    escConsumed: settingsKeyboard.escConsumed,
    clearEscConsumed: settingsKeyboard.clearEscConsumed,
    // 键位真值 = settings 快照（修改即时生效，无需重启；T3+.2）
    keys: () => settingsStore.get().keybindings,
  })

  appWindow.mount(
    <ErrorBoundary area="root">
      <App
        store={threadStore}
        settings={settingsStore}
        gitStore={gitStore}
        worktree={worktreeStore}
        version={APP_VERSION}
        windowControls={windowControls}
        scrollToItem={(elementId, index) => renderer.scrollToItem(elementId, index)}
        pickDirectory={() =>
          // native 面是回调式（TSF 两参契约）；装配层包装成 Promise（面板可能
          // 长时间开着——macOS runModal 阻塞 JS 线程，resolve 在模态结束后）
          new Promise<string | null>((resolve) => {
            pickDirectoryNative((_err, path) => resolve(path ?? null))
          })
        }
        perfSource={createPerfSource(renderer, { takePaintPerf })}
        lastCrash={lastCrash}
      />
    </ErrorBoundary>,
    {
      onEvent: (event) => {
        if (event.eventType === 'keyDown') {
          const m = event.modifiers
          handleKeyDown(event.key ?? '', m?.ctrl ?? false, m?.shift ?? false, m?.cmd ?? false)
        }
      },
    },
  )
}
