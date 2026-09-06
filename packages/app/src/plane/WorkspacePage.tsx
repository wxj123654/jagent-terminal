/**
 * plane/WorkspacePage.tsx — 工作区内 tab 容器（git-graph.md §4.2）。
 *
 * workspace 路由的内容宿主：tab 条（起始页 / Git 图）+ 内容切换。
 * paneTab 是 Workspace 运行时态（持久化 state.json）；GitGraphStore 单例
 * 由装配层注入（main.tsx 创建、e2e/测试可注入假 deps），切 workspace 时
 * 经 mount(cwd) 幂等换流（D5：git 数据非会话，不进 ThreadStore）。
 */

import { GitGraphView } from '../git/components/GitGraphView'
import type { GitGraphStore } from '../git/store'
import type { SettingsStore } from '../settings/store'
import type { ThreadStore, Workspace } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { COLORS, FONT } from '../ui/tokens'
import type { DialogOpener } from './DialogHost'
import { WorkspaceEmpty } from './WorkspaceEmpty'

function TabButton({
  label,
  active,
  testId,
  onClick,
}: {
  label: string
  active: boolean
  testId: string
  onClick: () => void
}) {
  return (
    <div
      testId={testId}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 30,
        paddingLeft: 12,
        paddingRight: 12,
        borderBottomWidth: active ? 2 : 0,
        borderColor: active ? COLORS.accent : 'transparent',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      <text
        style={{
          fontSize: 12,
          fontFamily: FONT.ui,
          color: active ? COLORS.textBright : COLORS.muted,
        }}
      >
        {label}
      </text>
    </div>
  )
}

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
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'flex-end',
          paddingLeft: 8,
          backgroundColor: COLORS.titlebar,
          borderBottomWidth: 1,
          borderColor: COLORS.border,
          flexShrink: 0,
        }}
      >
        <TabButton
          label="起始页"
          testId="workspace-tab-home"
          active={tab === 'home'}
          onClick={() => store.setWorkspacePaneTab(workspace.id, 'home')}
        />
        <TabButton
          label="Git 图"
          testId="workspace-tab-git"
          active={tab === 'git'}
          onClick={() => store.setWorkspacePaneTab(workspace.id, 'git')}
        />
      </div>
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
