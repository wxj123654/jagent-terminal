/**
 * NewThreadButton — `[+ {lastPreset}] [▾]`（布局契约 §6 E2）。
 *
 * T3.1 起预设列表接 settings.presets.items（内置 5 + 自定义，增删实时反映）。
 * 单击 + 的目标 = plusDefault ?? lastUsedPreset ?? 首个预设（plusDefault 固定
 * 优先；null 跟随上次使用；lastUsedPreset 悬空——指向被删预设——时兜底首项）。
 * 菜单项 → spawn 该预设（store 内部更新 lastUsedPreset）。
 * T3.2：菜单底部固定「New Chat」项（分隔线下；chat 不是预设，不占预设槽）。
 */

import { useState } from 'react'

import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import { presetCommandSummary } from '../threads/presets'
import type { ThreadStore } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { Icon } from '../ui/Icon'
import { COLORS, FONT, SIZES } from '../ui/tokens'

export function NewThreadButton({
  store,
  settings,
}: {
  store: ThreadStore
  settings: SettingsStore
}) {
  const lastPreset = useThreadStore(store, (s) => s.lastUsedPreset)
  const presets = useSettings(settings).presets.items
  const [open, setOpen] = useState(false)

  // + 的目标：plusDefault 固定 → 上次使用 → 首项兜底（列表至少含 5 内置）
  const targetId =
    presets.find((p) => p.id === (settings.get().presets.plusDefault ?? lastPreset))?.id ??
    presets[0]?.id
  const target = presets.find((p) => p.id === targetId) ?? presets[0]
  if (!target) return null

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'row',
        marginTop: 4,
        marginBottom: 6,
        marginLeft: SIZES.rowMarginX,
        marginRight: SIZES.rowMarginX,
      }}
    >
      {/* 主按钮：+ target */}
      <div
        tabIndex={0}
        onClick={() => void store.spawnFromPreset(target.id)}
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
        <text
          style={{
            fontSize: 12,
            fontFamily: FONT.ui,
            color: COLORS.textBright,
            pointerEvents: 'none',
          }}
        >
          {target.label}
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

      {/* 菜单：右对齐下拉（absolute，向下展开） */}
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
              <text
                style={{
                  fontSize: 12,
                  fontFamily: FONT.ui,
                  color: COLORS.text,
                  pointerEvents: 'none',
                }}
              >
                {p.label}
              </text>
              <text
                style={{
                  fontSize: 10,
                  fontFamily: FONT.mono,
                  color: COLORS.muted,
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  overflow: 'hidden',
                  pointerEvents: 'none',
                }}
              >
                {presetCommandSummary(p)}
              </text>
            </div>
          ))}
          {/* 分隔线 + 固定 New Chat（chat 非预设；入口拍板 2026-09-05） */}
          <div
            style={{
              height: 1,
              backgroundColor: COLORS.borderSubtle,
              marginTop: 4,
              marginBottom: 4,
            }}
          />
          <div
            tabIndex={0}
            testId="new-chat"
            onClick={() => {
              setOpen(false)
              store.createChat()
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
            <Icon name="chat" size={12} color={COLORS.accent} />
            <text
              style={{
                fontSize: 12,
                fontFamily: FONT.ui,
                color: COLORS.textBright,
                pointerEvents: 'none',
              }}
            >
              New Chat
            </text>
          </div>
        </div>
      ) : null}
    </div>
  )
}
