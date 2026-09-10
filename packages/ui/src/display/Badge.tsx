/**
 * ui/Badge.tsx — 胶囊徽章（architecture.md §7；settings-ui.md §7 内置/自定义、
 * §5.3 Phase 2/3 路线图徽章）。10px mono、999 圆角、低透明度底 + 同色系边。
 */

import type { ReactElement } from 'react'

import { COLORS, FONT } from '../theme/tokens'

export type BadgeVariant = 'builtin' | 'custom' | 'phase'

const VARIANT_STYLE: Record<BadgeVariant, { color: string; bg: string; border: string }> = {
  /** 内置预设：绿（原型 .builtin-badge） */
  builtin: {
    color: COLORS.terminalKind,
    bg: 'rgba(152, 195, 121, 0.10)',
    border: 'rgba(152, 195, 121, 0.25)',
  },
  /** 自定义预设：青（原型 .custom-badge） */
  custom: {
    color: COLORS.cyan,
    bg: 'rgba(86, 182, 194, 0.10)',
    border: 'rgba(86, 182, 194, 0.25)',
  },
  /** 路线图：灰（原型 .phase-badge） */
  phase: {
    color: COLORS.muted,
    bg: 'transparent',
    border: COLORS.borderSubtle,
  },
}

export function Badge({
  variant,
  children,
  testId,
}: {
  variant: BadgeVariant
  children: string
  testId?: string
}): ReactElement {
  const v = VARIANT_STYLE[variant]
  return (
    <text
      testId={testId}
      style={{
        fontSize: 10,
        fontFamily: FONT.mono,
        color: v.color,
        backgroundColor: v.bg,
        borderWidth: 1,
        borderColor: v.border,
        borderRadius: 999,
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 7,
        paddingRight: 7,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {children}
    </text>
  )
}
