/**
 * AcpSurface — Phase 3 前占位（architecture.md §4 registry）。
 * 实装后：ACP transcript + composer，顶部 ACP pill（布局契约 §5.3）。
 */

import { COLORS, FONT } from '../plane/tokens'
import type { SurfaceProps } from './registry'

export function AcpSurface({ thread }: SurfaceProps) {
  const title = thread.kind === 'acp' ? thread.title : ''
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
        acp — Phase 3
      </text>
      {title ? (
        <text style={{ color: COLORS.text, fontSize: 13, fontFamily: FONT.ui, marginTop: 4 }}>
          {title}
        </text>
      ) : null}
    </div>
  )
}
