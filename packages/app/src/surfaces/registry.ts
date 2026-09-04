/**
 * surfaces/registry.ts — Pane 表面注册表（architecture.md §4）。
 *
 * kind → Surface 组件。chat/acp 在 Phase 2/3 前为占位表面。
 * Pane 是唯一消费方（「整块替换」的条件渲染点）。
 */

import type { ComponentType } from 'react'

import type { Thread, ThreadStore } from '../threads/store'
import { TerminalSurface } from './TerminalSurface'
import { ChatSurface } from './ChatSurface'
import { AcpSurface } from './AcpSurface'

export type SurfaceProps = {
  thread: Thread
  store: ThreadStore
}

export type Surface = ComponentType<SurfaceProps>

const SURFACES: Record<Thread['kind'], Surface> = {
  terminal: TerminalSurface,
  chat: ChatSurface,
  acp: AcpSurface,
}

export function getSurface(kind: Thread['kind']): Surface {
  return SURFACES[kind]
}
