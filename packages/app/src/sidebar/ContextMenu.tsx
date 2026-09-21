/**
 * sidebar/ContextMenu.tsx — 侧栏上下文菜单（React 原型 .ctx-menu）。
 *
 * 行内 hover 「…」与右键同一面菜单（原型 ctx：置顶 / 重命名… /
 * 标记为未读 / 移除）。承载 = Popover（anchored + deferred + occlude +
 * onMouseDownOutside/Esc 关闭）；项 = h30 r6 行，danger 红字（bell）。
 * 浮层 chrome 按原型：minWidth 180、r12、1px borderSubtle、
 * boxShadow 0 14px 38px rgba(0,0,0,.5)、padding 4。
 *
 * 定位：调用方给窗口坐标（onAuxClick/onClick 的 e.x/e.y；键盘打开时
 * 用行上最后一次 mouseMove 位置兜底）。菜单项点击后一律关单。
 */

import { Popover, COLORS, FONT } from '@jagent/ui'

/** 菜单项：'sep' = 分隔线；danger = 红字（Remove 类） */
export type ContextMenuItem = { id: string; label: string; danger?: boolean } | 'sep'

export function ContextMenu({
  position,
  items,
  onPick,
  onClose,
}: {
  /** 菜单左上角窗口坐标（点击点） */
  position: { x: number; y: number }
  items: ContextMenuItem[]
  onPick: (id: string) => void
  onClose: () => void
}) {
  return (
    <Popover
      testId="context-menu"
      position={position}
      onClose={onClose}
      minWidth={180}
      autoFocus
      style={{
        padding: 4,
        borderRadius: 12,
        boxShadow: {
          offsetX: 0,
          offsetY: 14,
          blurRadius: 38,
          spreadRadius: 0,
          color: 'rgba(0,0,0,0.5)',
        },
      }}
    >
      {items.map((it, i) =>
        it === 'sep' ? (
          <div
            key={`sep-${i}`}
            style={{
              height: 1,
              backgroundColor: COLORS.borderSubtle,
              marginTop: 4,
              marginBottom: 4,
              marginLeft: 6,
              marginRight: 6,
            }}
          />
        ) : (
          <div
            key={it.id}
            testId={`ctx-${it.id}`}
            tabIndex={0}
            onClick={() => {
              onPick(it.id)
              onClose()
            }}
            onKeyDown={(e) => {
              if (e.key === 'enter' || e.key === 'space') {
                onPick(it.id)
                onClose()
              }
            }}
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              // 原型 .ctx-item（第二段 min-h30 r6）：pad 0 8，hover 底 surface
              minHeight: 30,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 6,
              cursor: 'pointer',
              hover: { backgroundColor: COLORS.surface },
            }}
          >
            <text
              style={{
                fontSize: 12,
                fontFamily: FONT.ui,
                color: it.danger ? COLORS.bell : COLORS.text,
                pointerEvents: 'none',
              }}
            >
              {it.label}
            </text>
          </div>
        ),
      )}
    </Popover>
  )
}
