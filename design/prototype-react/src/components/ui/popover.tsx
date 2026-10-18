import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAppRoot } from '@/approot'

/** 受控浮层（通知中心 / 字体选择器 / 分支菜单 / 伴随视图菜单），Portal 进 #app */
export function Pop({
  open,
  onOpenChange,
  anchor,
  children,
  className,
  side = 'bottom',
  align = 'start',
  sideOffset = 4,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  anchor: ReactNode
  children: ReactNode
  className?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  onOpenAutoFocus?: (e: Event) => void
}) {
  const appEl = useAppRoot()
  const trigRef = useRef<HTMLSpanElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 })

  useLayoutEffect(() => {
    if (!open || !appEl || !trigRef.current) return
    const appRect = appEl.getBoundingClientRect()
    const trigRect = trigRef.current.getBoundingClientRect()
    const popRect = popRef.current?.getBoundingClientRect()
    const popW = popRect?.width ?? 240
    const popH = popRect?.height ?? 180

    let left = trigRect.left - appRect.left
    if (align === 'end') left = trigRect.right - appRect.left - popW
    else if (align === 'center') left = trigRect.left - appRect.left + (trigRect.width - popW) / 2
    left = Math.max(8, Math.min(left, appRect.width - popW - 8))

    let top =
      side === 'top'
        ? trigRect.top - appRect.top - popH - sideOffset
        : trigRect.bottom - appRect.top + sideOffset
    top = Math.max(8, Math.min(top, appRect.height - popH - 8))

    setPos({ left: Math.round(left), top: Math.round(top) })
  }, [open, appEl, side, align, sideOffset])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (popRef.current?.contains(t) || trigRef.current?.contains(t)) return
      onOpenChange(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, onOpenChange])

  return (
    <>
      <span ref={trigRef} style={{ display: 'inline-flex' }}>
        {anchor}
      </span>
      {open &&
        appEl &&
        createPortal(
          <div
            ref={popRef}
            className={className}
            style={{
              position: 'absolute',
              left: pos.left,
              top: pos.top,
              zIndex: 160,
            }}
          >
            {children}
          </div>,
          appEl,
        )}
    </>
  )
}
