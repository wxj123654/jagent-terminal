/**
 * plane/DialogHost.tsx — 弹窗状态中枢（Phase W7）。
 *
 * AgentPlane 根挂载；四类弹窗（tool / add-workspace / search / manage
 * session）单一显示源。侧栏各入口（行 ＋ / 空组引导 / 添加工作区 /
 * 会话 …）不再自持 anchored 菜单，改经 props 回调打开本处弹窗——
 * 入口唯一、状态单点、Esc/遮罩统一在 Modal。
 *
 * ⌘K：keybindings.openSearch（原 W4 语义「聚焦侧栏搜索框」废弃）→
 * 搜索会话弹窗——挂点在 main.tsx/e2e 装配层，经 dialogKeyboard 模块态
 * 注入（与 planeKeyboard/settingsKeyboard 同款纪律）。
 */

import type { LastCrash } from '../errors/crashReport'
import type { SettingsStore } from '../settings/store'
import type { ThreadStore } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { CrashDialog } from './CrashDialog'
import { ErrorDialog } from './ErrorDialog'
import { RenameDialog, type RenameTarget } from './RenameDialog'
import { SearchDialog } from './SearchDialog'
import { ToolDialog } from './ToolDialog'
import { WorkspaceDialog } from './WorkspaceDialog'
import type { DirectoryPicker } from './WorkspaceList'

export type DialogState =
  | { kind: 'none' }
  | { kind: 'tool'; workspaceId: string }
  | { kind: 'addWorkspace' }
  | { kind: 'search' }
  | { kind: 'rename'; target: RenameTarget }
  | { kind: 'errors' }
  | { kind: 'crash'; last: LastCrash }

/** DialogHost 的打开接口（Sidebar 等入口消费） */
export type DialogOpener = {
  openToolMenu: (workspaceId: string) => void
  openAddWorkspace: () => void
  openSearch: () => void
  /** codex-sidebar-v2：上下文菜单 Rename… → 重命名弹窗（会话/工作区共用） */
  openRename: (target: RenameTarget) => void
  openErrors: () => void
}

export function DialogHost({
  store,
  settings,
  state,
  setState,
  pickDirectory,
}: {
  store: ThreadStore
  settings: SettingsStore
  state: DialogState
  setState: (next: DialogState) => void
  pickDirectory?: DirectoryPicker
}) {
  const workspaces = useThreadStore(store, (s) => s.workspaces)
  const close = () => setState({ kind: 'none' })

  switch (state.kind) {
    case 'tool':
      return (
        <ToolDialog
          store={store}
          settings={settings}
          workspaces={workspaces}
          initialWorkspaceId={state.workspaceId}
          onClose={close}
        />
      )
    case 'addWorkspace':
      return (
        <WorkspaceDialog
          store={store}
          workspaces={workspaces}
          pickDirectory={pickDirectory}
          onClose={close}
        />
      )
    case 'search':
      return <SearchDialog store={store} settings={settings} onClose={close} />
    case 'errors':
      return <ErrorDialog onClose={close} />
    case 'crash':
      return <CrashDialog last={state.last} onClose={close} />
    case 'rename':
      // key 随目标变：同壳复用时重置输入初值（React 复用实例会留旧 draft）
      return (
        <RenameDialog
          key={`${state.target.type}:${state.target.id}`}
          store={store}
          target={state.target}
          onClose={close}
        />
      )
    default:
      return null
  }
}
