/**
 * sidebar/ContextMenu.tsx — 侧栏上下文菜单（codex-sidebar-v2 方案 C）。
 *
 * 行内 hover 「…」与右键同一面菜单（原型 ctx：Pin / Rename / Mark as
 * unread / Remove）。承载 = Popover（anchored + deferred + occlude +
 * onMouseDownOutside/Esc 关闭）；项 = 26px 行，danger 红字。
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
      style={{ padding: 4 }}
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
