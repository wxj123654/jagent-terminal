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
  installNativePanicHook,
  installTerminalElement,
  onNativePanic,
  onSessionEvent,
  pickDirectory as pickDirectoryNative,
  takePaintPerf,
} from '@jagent/native'

import { inputFocus, PLATFORM } from '@jagent/ui'
import { appWindow, type AppRenderer } from './appWindow'
import { emitError } from './errors/bus'
import {
  CRASH_HANDLER_FLAG,
  runCrashSidecar,
  setupCrashReportingForApp,
} from './errors/crashReport'
import { ErrorBoundary } from './errors/ErrorBoundary'
import { installGlobalGuards } from './errors/guards'
import { installErrorLog } from './errors/log'
import { registerNativePanicHandler } from './errors/native'
import { wireErrorToasts } from './errors/toastWire'
import { createGitGraphStore } from './git/store'
import { createGlobalKeydown } from './keybindings'
import { App } from './plane/AgentPlane'
import { dialogKeyboard } from './plane/dialogKeyboard'
import type { WindowControls } from './plane/TitleBar'
import { router, activeTargetFromLocation, lastNonSettings } from './router'
import { fsAdapter } from './settings/file'
import { createSettingsStore } from './settings/store'
import { settingsKeyboard } from './surfaces/settingsKeyboard'
import { narrowSessionEvent } from './threads/events'
import { createNativeThreadDeps } from './threads/nativeDeps'
import { createThreadStore } from './threads/store'
import {
  defaultWorkspace,
  parseWorkspaceState,
  serializeWorkspaceState,
} from './threads/workspaces'
import type { PerfSample, PerfSource } from './ui/PerfHud'

// ── 性能 HUD 采样器（native 收口：takePaintPerf / getDebugFrameOverlayStats
// 在此唯一可见）──
// 两层数据面：
// 1. 整 app 帧面：GPUIX 内建 profiler（gpui `profiler` feature，编译进 .node）
//    对每次 Window::draw（build+layout+paint 全程）计时。直方图默认是
//    「最近 1000 帧」滚动窗——低帧率下滚动极慢，启动期大帧会冻结在 max
//    里几分钟（实测 4fps 下 98ms 假峰长期不衰）。因此每窗读后即调
//    resetDebugFrameOverlayStats（清样本、保 frames 计数）：p90/max 变成
//    「本采样窗（500ms）内帧」的读数，与 terminal paint 峰值同语义；
//    差分帧率不受影响。若同时开着屏幕覆盖层，覆盖层读数也同步变实时窗。
// 2. 终端 paint 子系统面：takePaintPerf（crates/jagent-terminal 打点）。
// 首次 sample 建基线（Δ=0）；此后每次调用用与上次的时间差/计数差算速率
// 与均值；cpu 用 process.cpuUsage 差分（含 napi .node 内 Rust 线程，同进程）。
function createPerfSource(renderer: AppRenderer): PerfSource {
  const base = takePaintPerf()
  const frameBase = renderer.getDebugFrameOverlayStats?.()
  renderer.resetDebugFrameOverlayStats?.() // 基线窗从零起算（清启动期样本）
  let last = {
    at: performance.now(),
    cpu: process.cpuUsage(),
    count: base.count,
    totalNs: base.totalNs,
    frames: frameBase?.frames ?? 0,
  }
  return {
    sample(): PerfSample {
      const snap = takePaintPerf()
      const now = performance.now()
      const cpu = process.cpuUsage()
      const dtMs = Math.max(now - last.at, 1)
      const dCount = Math.max(snap.count - last.count, 0)
      const dNs = Math.max(snap.totalNs - last.totalNs, 0)
      const frame = renderer.getDebugFrameOverlayStats?.()
      const dFrames = Math.max((frame?.frames ?? last.frames) - last.frames, 0)
      const cpuPct = ((cpu.user - last.cpu.user + cpu.system - last.cpu.system) / 1e6 / dtMs) * 100
      const memMB = process.memoryUsage().rss / 1048576
      const out = {
        fps: dFrames / (dtMs / 1000),
        // 本采样窗内新帧的 p90/max（读后即清；窗内无新帧时直方图为空 → 0）
        drawP90Ms: dFrames > 0 ? (frame?.p90Ms ?? 0) : 0,
        drawMaxMs: dFrames > 0 ? (frame?.maxMs ?? 0) : 0,
        paintAvgMs: dCount > 0 ? dNs / 1e6 / dCount : 0,
        paintMaxMs: snap.maxNs / 1e6,
        cpuPct,
        memMB,
      }
      last = {
        at: now,
        cpu,
        count: snap.count,
        totalNs: snap.totalNs,
        frames: frame?.frames ?? last.frames,
      }
      renderer.resetDebugFrameOverlayStats?.() // 下一窗从零起算
      return out
    },
  }
}

// ── 发布形态 sidecar 变道（方案 C）──
// bun compile 后 sidecarSpawnArgs 走 `<exe> --crash-handler`。独立脚本
// （dev）不经过本文件；本分支只服务发布二进制。runCrashSidecar 阻塞至
// dump/EOF，永不返回——不会再走 setupCrashReportingForApp。
if (process.argv.includes(CRASH_HANDLER_FLAG)) {
  runCrashSidecar()
}

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
const lastCrash = await setupCrashReportingForApp('0.1.0')

// ── seam 装配（顺序敏感：先注册元素，再开窗）──────────────────────────
installTerminalElement()

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
    persistWorkspaces: (ws) => {
      void stateFile.write(serializeWorkspaceState(ws)).catch((e) => {
        // 非关键路径：丢一次恢复态不阻断 UI，但错误要可见（错误总线）
        emitError({
          level: 'warn',
          kind: 'io',
          message: `工作区状态写入失败：${e instanceof Error ? e.message : String(e)}`,
          context: 'state.json write',
        })
      })
    },
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

// ── 屏幕帧 overlay（advanced.frameOverlay：GPUIX 内建调试覆盖层）──
// 整帧耗时直方图的屏幕可视化（full 模式画在场景之上，profiler feature 已编
// 译进 .node）。设置开关即时切换；初值启动应用一次。仅 subscribed 变化时
// 才调 native（settingsStore.subscribe 是全量回调，需自行去重）。
let appliedOverlay: string | null = null
const applyFrameOverlay = () => {
  const mode = settingsStore.get().advanced.frameOverlay ? 'full' : 'hidden'
  if (mode === appliedOverlay) return
  appliedOverlay = mode
  try {
    renderer.setDebugFrameOverlay(mode)
  } catch {
    appliedOverlay = null // native 面未就绪/失败：置空允许下次订阅重试
  }
}
settingsStore.subscribe(applyFrameOverlay)
applyFrameOverlay()

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
  inSettings: () => activeTargetFromLocation(router.history.location.pathname)?.type === 'settings',
  closeSettings: () => threadStore.activate(lastNonSettings()),
  focusSearch: () => {
    const id = settingsKeyboard.searchInputId()
    if (id != null) renderer.focusElement(id)
  },
  focusThreadSearch: () => {
    // W7 ⌘K/Ctrl-K：打开搜索会话弹窗（原型语义；原 W4 聚焦侧栏搜索框废弃）
    dialogKeyboard.openSearch()
  },
  // Git 图键位（git-graph.md §4.3）：与顶栏按钮共用 store.openGitGraph
  openGitGraph: () => threadStore.openGitGraph(),
  gitGraphKey: (key) => {
    const active = activeTargetFromLocation(router.history.location.pathname)
    if (active?.type !== 'workspace') return false
    const ws = threadStore.getState().workspaces.find((w) => w.id === active.id)
    if (!ws || ws.paneTab !== 'git') return false
    switch (key) {
      case 'down':
      case 'arrowdown':
        gitStore.moveSelection(1)
        return true
      case 'up':
      case 'arrowup':
        gitStore.moveSelection(-1)
        return true
      case 'enter':
        // 选中态即详情打开态（↑↓/点击已带），吃掉防透传
        return true
      case 'escape':
        gitStore.select(null)
        return true
      case 'r':
        gitStore.refresh()
        return true
      default:
        return false
    }
  },
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
      windowControls={windowControls}
      scrollToItem={(elementId, index) => renderer.scrollToItem(elementId, index)}
      pickDirectory={() =>
        // native 面是回调式（TSF 两参契约）；装配层包装成 Promise（面板可能
        // 长时间开着——macOS runModal 阻塞 JS 线程，resolve 在模态结束后）
        new Promise<string | null>((resolve) => {
          pickDirectoryNative((_err, path) => resolve(path ?? null))
        })
      }
      perfSource={createPerfSource(renderer)}
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
