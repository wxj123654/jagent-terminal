/**
 * TerminalSurface — 全项目唯一 `<terminal>` 写点（硬约束 2；architecture.md §4）。
 *
 * props = sessionId + 外观；spawn 参数走 createTerminalSession（经
 * ThreadStore.spawnFromPreset）。外层 div：padding 0、无 overflow 包裹、
 * 不设背景色——terminal 用自己的 palette（布局契约 §5.1 C1 无 chrome）。
 *
 * T2.5：外观读 settings.terminal（fontFamily/fontSize/palette/cursorBlink）
 * ——设置变化 → useSettings 重渲染 → setCustomProp → model.set_style
 * （幂等）→ sync_style 调和，无需重建会话。scrollbackLines 属 spawn 参数
 * （nativeDeps 兑底），不在这里。focused prop：挂载即请求焦点（T1.6）。
 */

import { useSettings } from '../settings/useSettings'
import type { TerminalThread } from '../threads/store'
import type { SurfaceProps } from './registry'

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

export function TerminalSurface({ thread, settings }: SurfaceProps) {
  const t = thread as TerminalThread
  const term = useSettings(settings).terminal
  return (
    <div
      style={{ display: 'flex', flexDirection: 'row', flexGrow: 1, width: '100%', height: '100%' }}
    >
      <terminal
        sessionId={t.sessionId}
        fontFamily={term.fontFamily}
        fontSize={term.fontSize}
        palette={term.palette}
        cursorBlink={term.cursorBlink}
        focused
      />
    </div>
  )
}
