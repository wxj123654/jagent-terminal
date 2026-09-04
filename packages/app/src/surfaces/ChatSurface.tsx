/**
 * ChatSurface — Phase 2 前占位（architecture.md §4 registry）。
 * 实装后：virtual-list 消息 + 底 composer（布局契约 §5.2）。
 */

import { COLORS, FONT } from '../plane/tokens'
import type { SurfaceProps } from './registry'

export function ChatSurface({ thread }: SurfaceProps) {
  const title = thread.kind === 'chat' ? thread.title : ''
  return (
    <div
      style={{
        flexGrow: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: COLORS.pane,
      }}
    >
      <text style={{ color: COLORS.muted, fontSize: 13, fontFamily: FONT.ui }}>
        chat — Phase 2
      </text>
      {title ? (
        <text style={{ color: COLORS.text, fontSize: 13, fontFamily: FONT.ui, marginTop: 4 }}>
          {title}
        </text>
      ) : null}
    </div>
  )
}
