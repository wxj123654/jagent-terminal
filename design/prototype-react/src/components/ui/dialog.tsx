import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAppRoot } from '@/approot'
import { cn } from '@/lib/utils'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  width?: number
  r20?: boolean
  children: ReactNode
}

/** 模态壳：scrim + 居中卡片，Portal 进 #app */
export function Modal({ open, onClose, title, width = 440, r20, children }: ModalProps) {
  const appEl = useAppRoot()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !appEl) return null

  return createPortal(
    <>
      <div className="modal-scrim" onMouseDown={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn('modal', r20 && 'r20')}
        style={{ width }}
      >
        {children}
      </div>
    </>,
    appEl,
  )
}
