/**
 * Sidebar — 左栏（布局契约 §2/§3：248px 固定宽）。
 *
 * Header("AGENT" + Ctrl-Tab hint) · ThreadList · NewThreadButton ·
 * Footer(齿轮 → settings 表面)。
 */

import type { ThreadStore } from '../threads/store'
import { Icon } from '../ui/Icon'
import { COLORS, FONT, SIZES } from './tokens'
import { ThreadList } from './ThreadList'
import { NewThreadButton } from './NewThreadButton'

export function Sidebar({ store }: { store: ThreadStore }) {
  return (
    <div
      style={{
        width: SIZES.sidebarWidth,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: COLORS.sidebar,
        borderWidth: 0,
        borderRightWidth: 1,
        borderColor: COLORS.border,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 36,
          paddingLeft: 12,
          paddingRight: 10,
          userSelect: 'none',
        }}
      >
        <text style={{ fontSize: 11, fontFamily: FONT.ui, fontWeight: '600', color: COLORS.muted }}>
          AGENT
        </text>
        <text style={{ fontSize: 10, fontFamily: FONT.mono, color: COLORS.muted }}>
          ⌃⇥
        </text>
      </div>

      <NewThreadButton store={store} />

      <ThreadList store={store} />

      {/* Footer：设置入口（Ctrl-, 同效，见 main.tsx 键位层） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          height: 34,
          paddingLeft: 12,
          borderTopWidth: 1,
          borderColor: COLORS.border,
        }}
      >
        <div
          tabIndex={0}
          testId="open-settings"
          onClick={() => store.activate({ type: 'settings' })}
          onKeyDown={(e) => {
            if (e.key === 'enter') store.activate({ type: 'settings' })
          }}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            height: 24,
            paddingLeft: 6,
            paddingRight: 6,
            borderRadius: 4,
            cursor: 'pointer',
            hover: { backgroundColor: COLORS.surface },
          }}
        >
          <Icon name="gear" size={13} color={COLORS.muted} />
          <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted }}>
            设置
          </text>
          <text style={{ fontSize: 10, fontFamily: FONT.mono, color: COLORS.muted }}>
            Ctrl-,
          </text>
        </div>
      </div>
    </div>
  )
}
