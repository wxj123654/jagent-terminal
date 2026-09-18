/**
 * plane/WorkspacePage.tsx — 工作区页内容宿主（git-graph.md §4.2）。
 *
 * workspace 路由的内容宿主：无 tab 条——paneTab==='git' 时整页为 Git 图
 * （由 titlebar 分支 chip / Ctrl-Shift-G 进入），否则为工作区起始页
 * （原型 renderWorkspacePage 同款整页切换）。
 * paneTab 是 Workspace 运行时态（持久化 state.json）；GitGraphStore 单例
 * 由装配层注入（main.tsx 创建、e2e/测试可注入假 deps），切 workspace 时
 * 经 mount(cwd) 幂等换流（D5：git 数据非会话，不进 ThreadStore）。
 */

import type { DialogOpener } from '../dialogs/DialogHost'
import { GitGraphView } from '../git/components/GitGraphView'
import type { GitGraphStore } from '../git/store'
import type { SettingsStore } from '../settings/store'
import type { ThreadStore, Workspace } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { WorkspaceEmpty } from './WorkspaceEmpty'

export function WorkspacePage({
  store,
  settings,
  workspace,
  dialog,
  gitStore,
  scrollToItem,
}: {
  store: ThreadStore
  settings: SettingsStore
  workspace: Workspace
  /** 弹窗入口（W7；透传 WorkspaceEmpty） */
  dialog: DialogOpener
  gitStore: GitGraphStore
  /** 键盘导航视口跟随（renderer.scrollToItem；透传 GitGraphView） */
  scrollToItem?: (elementId: number, index: number) => void
}) {
  // paneTab 响应式（setWorkspacePaneTab 不导航 → getState 读不到更新）
  const ws = useThreadStore(store, (s) => s.workspaces.find((w) => w.id === workspace.id))
  const tab = ws?.paneTab ?? 'home'

  return (
    <div
      testId="workspace-page"
      style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}
    >
      {tab === 'git' ? (
        <GitGraphView
          cwd={workspace.path}
          store={gitStore}
          repoLabel={workspace.name}
          scrollToItem={scrollToItem}
        />
      ) : (
        <WorkspaceEmpty store={store} settings={settings} workspace={workspace} dialog={dialog} />
      )}
    </div>
  )
}
