/**
 * EmptyPresets — 无 thread 时的 Pane 表面（布局契约 §5.4 E2；路由 `/`）。
 *
 * 预设卡片网格：T3.1 起接 settings.presets.items（内置 5 + 自定义，
 * 设置里增删实时反映）。点击 → spawnFromPreset（内部更新 lastUsedPreset）。
 */

import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import { presetCommandSummary } from '../threads/presets'
import { COLORS, FONT } from '../ui/tokens'

export function EmptyPresets({
  onPick,
  settings,
}: {
  onPick: (presetId: string) => void
  settings: SettingsStore
}) {
  const presets = useSettings(settings).presets.items

  return (
    <div
      style={{
        flexGrow: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: COLORS.pane,
        padding: 24,
      }}
    >
      <text style={{ color: COLORS.muted, fontSize: 13, fontFamily: FONT.ui, marginBottom: 16 }}>
        新建会话
      </text>
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 12,
          justifyContent: 'center',
          maxWidth: 480,
        }}
      >
        {presets.map((p) => (
          <div
            key={p.id}
            testId={`preset-${p.id}`}
            tabIndex={0}
            onClick={() => onPick(p.id)}
            onKeyDown={(e) => {
              if (e.key === 'enter' || e.key === 'space') onPick(p.id)
            }}
            style={{
              width: 132,
              height: 84,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              backgroundColor: COLORS.sidebar,
              borderWidth: 1,
              borderColor: COLORS.borderSubtle,
              borderRadius: 8,
              cursor: 'pointer',
              hover: {
                borderColor: COLORS.accent,
                backgroundColor: COLORS.surface,
              },
            }}
          >
            <text
              style={{
                color: COLORS.textBright,
                fontSize: 14,
                fontFamily: FONT.ui,
                pointerEvents: 'none',
              }}
            >
              {p.label}
            </text>
            <text
              style={{
                color: COLORS.muted,
                fontSize: 11,
                fontFamily: FONT.mono,
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
                overflow: 'hidden',
                maxWidth: 116,
                pointerEvents: 'none',
              }}
            >
              {presetCommandSummary(p)}
            </text>
          </div>
        ))}
      </div>
    </div>
  )
}
