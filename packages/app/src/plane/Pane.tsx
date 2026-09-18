/**
 * Pane — 全项目唯一的表面调度（architecture.md §4）。
 *
 * 「整块替换」= 条件渲染：旧 surface 卸载、新 surface 挂载（无
 * display:none 藏匿）。retain 由两层保证：thread 记录在 ThreadStore、
 * 会话在 Rust TerminalPool（元素 destroy 只解绑视图）。
 *
 * 路由（§3.5）：/ → EmptyPresets · /thread/$id → 按 kind 查 registry ·
 * /settings → SettingsView（settings-ui.md §3：Pane 特殊表面，非 thread
 * kind——不进混排列表、不进 History）。
 *
 * 会话内视图（最新原型 SessionTabs）：activeViewId 指向 git/file/shell
 * 视图时整块替换主面——git 视图 = 归属工作区的 GitGraphView，file =
 * FileSurface 真读盘预览，shell = SessionTerminal（独立 PTY）。
 */

import type { DialogOpener } from '../dialogs/DialogHost'
import { ErrorBoundary } from '../errors/ErrorBoundary'
import { GitGraphView } from '../git/components/GitGraphView'
import type { GitGraphStore } from '../git/store'
import { useActiveTarget } from '../router'
import type { SettingsStore } from '../settings/store'
import { SettingsView } from '../settings/ui/SettingsView'
import { WorkspacePage } from '../sidebar/WorkspacePage'
import { EmptyPresets } from '../surfaces/EmptyPresets'
import { FileSurface } from '../surfaces/FileSurface'
import { getSurface } from '../surfaces/registry'
import { SessionTerminal } from '../surfaces/TerminalSurface'
import type { ThreadStore } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'

export function Pane({
  store,
  settings,
  dialog,
  gitStore,
  scrollToItem,
}: {
  store: ThreadStore
  settings: SettingsStore
  /** 弹窗入口（W7）：起始页「选择其他工具」 */
  dialog: DialogOpener
  /** Git 图 store（git-graph.md §4.2；装配层单例注入） */
  gitStore: GitGraphStore
  /** 键盘导航视口跟随（renderer.scrollToItem；透传） */
  scrollToItem?: (elementId: number, index: number) => void
}) {
  const active = useActiveTarget()
  const thread = useThreadStore(store, (s) =>
    active?.type === 'thread' ? s.threads.find((t) => t.id === active.id) : undefined,
  )

  if (active?.type === 'settings')
    return (
      <ErrorBoundary area="settings">
        <SettingsView settings={settings} />
      </ErrorBoundary>
    )
  // 工作区起始页（Phase W；原型「空工作区/会话移除后回退目的地」）。
  // 死 id（工作区已删，removeWorkspace 兑底前的一瞬）→ 落全局空态兜底
  if (active?.type === 'workspace') {
    const ws = store.getState().workspaces.find((w) => w.id === active.id)
    if (ws)
      return (
        <ErrorBoundary area="pane">
          <WorkspacePage
            store={store}
            settings={settings}
            workspace={ws}
            dialog={dialog}
            gitStore={gitStore}
            scrollToItem={scrollToItem}
          />
        </ErrorBoundary>
      )
  }
  if (!thread) {
    // 空态预设卡：spawn 进第一个工作区（无工作区则不归属——防御；正常装配
    // 首启即有默认工作区，Phase W2 起新建入口全带归属）；ctx 行显示其 path
    const firstWs = store.getState().workspaces[0]
    return (
      <EmptyPresets
        onPick={(id) => void store.spawnFromPreset(id, firstWs?.id)}
        settings={settings}
        cwd={firstWs?.path}
      />
    )
  }
  // 会话内视图调度（原型 Pane 同款顺序：无视图/失效 id → 主面）
  const view = thread.views?.find((v) => v.id === thread.activeViewId)
  if (view) {
    if (view.kind === 'git') {
      const ws = store.getState().workspaces.find((w) => w.id === thread.workspaceId)
      if (ws)
        return (
          <ErrorBoundary area="pane">
            <GitGraphView
              cwd={ws.path}
              store={gitStore}
              repoLabel={ws.name}
              scrollToItem={scrollToItem}
            />
          </ErrorBoundary>
        )
      // 归属工作区已删 → 落回主面（同原型 fallback）
    } else if (view.kind === 'file') {
      const base =
        (thread.kind === 'terminal' ? thread.cwd : undefined) ??
        store.getState().workspaces.find((w) => w.id === thread.workspaceId)?.path ??
        null
      return (
        <ErrorBoundary area="pane">
          <FileSurface path={view.path} base={base} />
        </ErrorBoundary>
      )
    } else {
      return (
        <ErrorBoundary area="pane">
          <SessionTerminal sessionId={view.sessionId} settings={settings} />
        </ErrorBoundary>
      )
    }
  }
  const S = getSurface(thread.kind)
  return (
    <ErrorBoundary area="pane">
      <S thread={thread} store={store} settings={settings} />
    </ErrorBoundary>
  )
}
