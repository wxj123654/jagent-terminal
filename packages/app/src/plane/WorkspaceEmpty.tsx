/**
 * WorkspaceEmpty — 已选工作区但无活跃会话时的 Pane 表面（路由
 * `/w/$workspaceId` 且 store.getActive() 无活跃）。
 *
 * V2 统一空态（D15）：与 EmptyPresets 同套 .home 壳——h1 = 工作区名、
 * ctx = path、pills = pi 快捷 + 其余预设 + 「选择其他工具」→ 工具弹窗。
 * 不传 thread → spawnFromPreset 走 cwd = workspace.path 分支。
 */

import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import {
  HomeContext,
  HomePills,
  HomeShell,
  HomeSub,
  HomeTitle,
  Pill,
  presetIcon,
} from '../surfaces/EmptyPresets'
import type { ThreadStore } from '../threads/store'
import type { Workspace } from '../threads/workspaces'
import type { DialogOpener } from './DialogHost'

export function WorkspaceEmpty({
  workspace,
  store,
  settings,
  dialog,
}: {
  workspace: Workspace
  store: ThreadStore
  settings: SettingsStore
  dialog: DialogOpener
}) {
  const presets = useSettings(settings).presets.items
  const pi = presets.find((p) => p.id === 'pi')
  const rest = presets.filter((p) => p.id !== 'pi')

  return (
    <HomeShell testId="workspace-empty">
      <HomeTitle>{workspace.name}</HomeTitle>
      <HomeSub>这个工作区还没有会话，选一个工具开始</HomeSub>
      <HomeContext path={workspace.path} />
      <HomePills>
        {pi ? (
          <Pill
            icon={presetIcon(pi)}
            label={pi.label}
            testId={`workspace-new-pi-${workspace.id}`}
            onClick={() => void store.spawnFromPreset(pi.id, workspace.id)}
          />
        ) : null}
        {rest.map((p) => (
          <Pill
            key={p.id}
            icon={presetIcon(p)}
            label={p.label}
            testId={`workspace-quick-${p.id}`}
            onClick={() => void store.spawnFromPreset(p.id, workspace.id)}
          />
        ))}
        <Pill
          icon="more"
          label="选择其他工具"
          testId={`workspace-more-tools-${workspace.id}`}
          onClick={() => dialog.openToolMenu(workspace.id)}
        />
      </HomePills>
    </HomeShell>
  )
}
