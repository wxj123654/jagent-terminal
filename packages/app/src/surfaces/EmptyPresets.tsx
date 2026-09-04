/**
 * EmptyPresets — 无 thread 时的 Pane 表面（布局契约 §5.4 E2；路由 `/`）。
 *
 * 预设卡片网格：每项绑定 program/args/env/initCommand（数据在
 * threads/presets.ts）。点击 → spawnFromPreset（内部更新 lastUsedPreset）。
 */

import { BUILTIN_PRESETS } from '../threads/presets'
import { COLORS, FONT } from '../ui/tokens'

export function EmptyPresets({ onPick }: { onPick: (presetId: string) => void }) {
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
        {BUILTIN_PRESETS.map((p) => (
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
                pointerEvents: 'none',
              }}
            >
              {p.initCommand ?? p.program ?? 'shell'}
            </text>
          </div>
        ))}
      </div>
    </div>
  )
}
