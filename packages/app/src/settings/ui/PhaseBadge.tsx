/**
 * ui/PhaseBadge.tsx — Phase 2/3 路线图徽章（settings-ui.md §5.3：第一期不可用项
 * disabled + 徽章可见，不隐藏）。原型 .phase-badge：mono 9px amber +
 * rgba(229,192,123,.4) 细边 + r3 + pad 0 4 + lh14。
 */

import type { ReactElement } from 'react'

import { COLORS, FONT } from '@jagent/ui'

export function PhaseBadge({ phase, testId }: { phase: 2 | 3; testId?: string }): ReactElement {
  return (
    <div
      testId={testId}
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 14,
        paddingLeft: 4,
        paddingRight: 4,
        borderWidth: 1,
        borderColor: 'rgba(229, 192, 123, 0.4)',
        borderRadius: 3,
        flexShrink: 0,
        pointerEvents: 'none',
      }}
    >
      <text
        style={{
          fontSize: 9,
          lineHeight: 14,
          fontFamily: FONT.mono,
          color: COLORS.amber,
          pointerEvents: 'none',
        }}
      >
        {`Phase ${phase}`}
      </text>
    </div>
  )
}
