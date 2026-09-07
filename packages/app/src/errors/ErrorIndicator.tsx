/**
 * errors/ErrorIndicator.tsx — TitleBar 错误入口（方案 A 可见面）。
 *
 * ring 内 error/fatal > 0 时显示警示图标 + 计数徽章，点击打开错误面板
 * （DialogHost 'errors'）。trailing 插槽挂载（PerfHud 旁）；数据源是
 * errors/bus（进程级模块态单例，无 props 注入）。
 */

import { useEffect, useState } from 'react'

import { COLORS, FONT } from '../ui/tokens'
import { errorCount, subscribeErrors } from './bus'

export function ErrorIndicator({ onOpen }: { onOpen: () => void }) {
  const [, bump] = useState(0)
  useEffect(() => subscribeErrors(() => bump((v) => v + 1)), [])
  const count = errorCount()
  if (count === 0) return null
  return (
    <div
      testId="error-indicator"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'enter') onOpen()
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 3,
        paddingBottom: 3,
        marginLeft: 8,
        borderRadius: 6,
        backgroundColor: 'rgba(224, 108, 117, 0.15)',
        borderWidth: 1,
        borderColor: 'rgba(224, 108, 117, 0.4)',
      }}
    >
      <text style={{ fontSize: 11, fontFamily: FONT.ui, color: COLORS.bell }}>⚠ {count}</text>
    </div>
  )
}
