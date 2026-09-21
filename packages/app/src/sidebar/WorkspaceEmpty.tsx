/**
 * WorkspaceEmpty — 已选工作区但无活跃会话时的 Pane 表面（路由
 * `/w/$workspaceId` 且 store.getActive() 无活跃）。
 *
 * R9 对齐原型 WorkspaceEmpty：同一 .home 卡壳 + 差异件——home-mark
 * workspace 变体（folder 绿）、kicker「WORKSPACE」、h1 = 工作区名、
 * ctx = path、section-head「启动会话 / 在当前工作区运行」、pills =
 * pi featured 主胶囊 + 其余预设 + 「选择其他工具」→ 工具弹窗。
 * 不传 thread → spawnFromPreset 走 cwd = workspace.path 分支。
 */

import type { DialogOpener } from '../dialogs/DialogHost'
import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import {
  HomeCard,
  HomeContext,
  HomeKicker,
  HomeMark,
  HomePills,
  HomeSectionHead,
  HomeShell,
  HomeSub,
  HomeTitle,
  Pill,
  presetIcon,
  useHomeNarrow,
} from '../surfaces/EmptyPresets'
import type { ThreadStore } from '../threads/store'
import type { Workspace } from '../threads/workspaces'

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
  const narrow = useHomeNarrow()
  const pi = presets.find((p) => p.id === 'pi')
  const rest = presets.filter((p) => p.id !== 'pi')

  return (
    <HomeShell testId="workspace-empty" narrow={narrow}>
      <HomeCard narrow={narrow}>
        <HomeMark workspace />
        <HomeKicker>WORKSPACE</HomeKicker>
        <HomeTitle>{workspace.name}</HomeTitle>
        <HomeSub>这个工作区还没有会话，选一个工具开始</HomeSub>
        <HomeContext path={workspace.path} />
        <HomeSectionHead left="启动会话" right="在当前工作区运行" />
        <HomePills narrow={narrow}>
          {pi ? (
            <Pill
              icon={presetIcon(pi)}
              label={pi.label}
              testId={`workspace-new-pi-${workspace.id}`}
              featured
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
      </HomeCard>
    </HomeShell>
  )
}
