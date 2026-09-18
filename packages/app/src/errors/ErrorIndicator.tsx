/**
 * errors/ErrorIndicator.tsx — TitleBar 错误入口（方案 A 可见面）。
 *
 * ring 内 error/fatal > 0 时显示警示图标 + 计数，点击打开错误面板
 * （DialogHost 'errors'）。trailing 插槽挂载（PerfHud 旁）；数据源是
 * errors/bus（进程级模块态单例，无 props 注入）。
 * 形态 = 原型 .tb-cell.tb-error-btn：28px cell / pad 0 7 / r8 / margin 0 2 /
 * alert 图标 + mono 计数，bell 色（hover 只换底不改色）。
 */

import { useEffect, useState } from 'react'

import { COLORS, FONT, Icon, focusRing } from '@jagent/ui'
import { errorCount, subscribeErrors } from './bus'

export function ErrorIndicator({ onOpen }: { onOpen: () => void }) {
  const [, bump] = useState(0)
  const [focused, setFocused] = useState(false)
  useEffect(() => subscribeErrors(() => bump((v) => v + 1)), [])
  const count = errorCount()
  if (count === 0) return null
  return (
    <div
      testId="error-indicator"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onOpen()
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
        gap: 5,
        height: 28,
        marginLeft: 2,
        marginRight: 2,
        paddingLeft: 7,
        paddingRight: 7,
        borderRadius: 8,
        color: COLORS.bell,
        cursor: 'pointer',
        userSelect: 'none',
        flexShrink: 0,
        // 同 tb-cell：win HTCAPTION 下必须 occlude 才可点
        pointerEvents: 'auto',
        boxShadow: focused ? focusRing() : undefined,
        hover: { backgroundColor: COLORS.surface },
      }}
    >
      <Icon name="alert" size={13} color={COLORS.bell} />
      {/* 原型 .err-n：11px mono 计数（button fw500 继承） */}
      <text
        style={{
          fontSize: 11,
          fontFamily: FONT.mono,
          fontWeight: '500',
          color: COLORS.bell,
          pointerEvents: 'none',
        }}
      >
        {count}
      </text>
    </div>
  )
}
