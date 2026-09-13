/**
 * threads/statePersistence.ts — 工作区状态持久化装配（ThreadDeps.persistWorkspaces
 * 的默认实现；从 main.tsx 提取）。
 *
 * 写 state.json（~/.j-agent/state.json；含运行时态 expanded/lastSession——
 * 「应用状态」与 settings.json 分文件）。fire-and-forget：非关键路径，
 * 丢一次恢复态不阻断 UI，但写失败要可见 → 错误总线 warn。
 */

import { emitError } from '../errors/bus'
import { serializeWorkspaceState, type Workspace } from './workspaces'

/** 最小写面（结构化满足 settings/file.ts 的 FileAdapter——不引 settings 模块） */
export type StateWriter = { write(s: string): Promise<void> }

export function createWorkspacePersister(file: StateWriter): (ws: Workspace[]) => void {
  return (ws) => {
    void file.write(serializeWorkspaceState(ws)).catch((e) => {
      emitError({
        level: 'warn',
        kind: 'io',
        message: `工作区状态写入失败：${e instanceof Error ? e.message : String(e)}`,
        context: 'state.json write',
      })
    })
  }
}
