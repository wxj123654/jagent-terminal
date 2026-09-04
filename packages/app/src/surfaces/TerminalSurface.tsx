/**
 * TerminalSurface — 全项目唯一 `<terminal>` 写点（硬约束 2；architecture.md §4）。
 *
 * props = sessionId + 外观；spawn 参数走 createTerminalSession（经
 * ThreadStore.spawnFromPreset）。外层 div：padding 0、无 overflow 包裹、
 * 不设背景色——terminal 用自己的 palette（布局契约 §5.1 C1 无 chrome）。
 *
 * Phase 1：外观先用契约默认值（JetBrains Mono / 13）；Phase 2 接
 * settings.terminal 区。focused prop：挂载即请求焦点（焦点模型验证 T1.6）。
 * onFocus/onBlur 元素事件：Rust 侧 Phase 2 才发射（见 native/element.rs
 * TODO），此处先不挂，避免「注册了永不触发」的假象。
 */

import type { TerminalThread } from '../threads/store'
import type { SurfaceProps } from './registry'
import { FONT } from '../plane/tokens'

// ── `<terminal>` JSX 类型声明（GPUIX jsx-runtime 的 augmentation）──────

export interface TerminalElementProps {
  /** 绑定池中会话（必需；architecture.md §2.4） */
  sessionId: number
  /** 外观 props：设置变化 → 重渲染 → setCustomProp → model.set_style */
  fontFamily?: string
  fontSize?: number
  cursorBlink?: boolean
  palette?: string
  /** activate 后请求焦点 */
  focused?: boolean
  onFocus?: (e: { sessionId: number }) => void
  onBlur?: (e: { sessionId: number }) => void
  key?: string | number
}

declare module '@gpuix/react/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      terminal: TerminalElementProps
    }
  }
}

// Phase 1 契约默认值（JetBrains Mono / 13；Phase 2 换 useSettings()）
const DEFAULT_FONT_FAMILY = FONT.mono
const DEFAULT_FONT_SIZE = 13

export function TerminalSurface({ thread }: SurfaceProps) {
  const t = thread as TerminalThread
  return (
    <div style={{ display: 'flex', flexDirection: 'row', flexGrow: 1, width: '100%', height: '100%' }}>
      <terminal
        sessionId={t.sessionId}
        fontFamily={DEFAULT_FONT_FAMILY}
        fontSize={DEFAULT_FONT_SIZE}
        focused
      />
    </div>
  )
}
