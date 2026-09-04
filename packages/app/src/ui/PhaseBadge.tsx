/**
 * ui/PhaseBadge.tsx — Phase 2/3 路线图徽章（settings-ui.md §5.3：第一期不可用项
 * disabled + 徽章可见，不隐藏）。Badge 的 phase 变体语法糖。
 */

import type { ReactElement } from 'react'

import { Badge } from './Badge'

export function PhaseBadge({ phase, testId }: { phase: 2 | 3; testId?: string }): ReactElement {
  return (
    <Badge variant="phase" testId={testId}>
      {`Phase ${phase}`}
    </Badge>
  )
}
