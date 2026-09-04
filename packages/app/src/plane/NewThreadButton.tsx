/**
 * NewThreadButton — `[+ {lastPreset}] [▾]`（布局契约 §6 E2）。
 *
 * 单击 + → spawn lastUsedPreset（默认 claude）；
 * 单击 ▾ → 预设菜单（Phase 1 = BUILTIN_PRESETS 五项；Phase 3 接
 * settings.presets.items 自定义预设）。菜单项 → spawn 该预设。
 */

import { useState } from 'react'

import type { ThreadStore } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { BUILTIN_PRESETS } from '../threads/presets'
import { Icon } from '../ui/Icon'
import { COLORS, FONT, SIZES } from './tokens'

export function NewThreadButton({ store }: { store: ThreadStore }) {
  const lastPreset = useThreadStore(store, (s) => s.lastUsedPreset)
  const [open, setOpen] = useState(false)

  const last = BUILTIN_PRESETS.find((p) => p.id === lastPreset) ?? BUILTIN_PRESETS[0]
  const presets = BUILTIN_PRESETS

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'row', marginTop: 4, marginBottom: 6, marginLeft: SIZES.rowMarginX, marginRight: SIZES.rowMarginX }}>
      {/* 主按钮：+ lastPreset */}
      <div
        tabIndex={0}
        onClick={() => void store.spawnFromPreset(last.id)}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          flexGrow: 1,
          gap: 6,
          height: 28,
          paddingLeft: 8,
          paddingRight: 8,
          borderRadius: SIZES.rowRadius,
          backgroundColor: COLORS.surface,
          cursor: 'pointer',
          userSelect: 'none',
          hover: { backgroundColor: COLORS.surfaceHover },
        }}
      >
        <Icon name="plus" size={12} color={COLORS.textBright} />
        <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.textBright }}>
          {last.label}
        </text>
      </div>
      {/* ▾：预设菜单 */}
      <div
        tabIndex={0}
        testId="open-preset-menu"
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 28,
          marginLeft: 4,
          borderRadius: SIZES.rowRadius,
          backgroundColor: COLORS.surface,
          cursor: 'pointer',
          hover: { backgroundColor: COLORS.surfaceHover },
        }}
      >
        <Icon name="chevronDown" size={12} color={COLORS.muted} />
      </div>

      {/* 菜单：右对齐下拉（absolute，向上展开受限于按钮位置——向下展开） */}
      {open ? (
        <div
          style={{
            position: 'absolute',
            top: 32,
            left: 0,
            right: 0,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: COLORS.inputBg,
            borderWidth: 1,
            borderColor: COLORS.borderSubtle,
            borderRadius: 6,
            padding: 4,
          }}
        >
          {presets.map((p) => (
            <div
              key={p.id}
              tabIndex={0}
              onClick={() => {
                setOpen(false)
                void store.spawnFromPreset(p.id)
              }}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                height: 26,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 4,
                cursor: 'pointer',
                hover: { backgroundColor: COLORS.surface },
              }}
            >
              <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.text }}>
                {p.label}
              </text>
              <text style={{ fontSize: 10, fontFamily: FONT.mono, color: COLORS.muted }}>
                {p.initCommand ?? p.program ?? 'shell'}
              </text>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
