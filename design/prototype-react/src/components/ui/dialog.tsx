import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
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

/** 模态壳：scrim + 居中卡片，Portal 进 #app（对齐原型 .modal-scrim/.modal） */
export function Modal({ open, onClose, title, width = 440, r20, children }: ModalProps) {
  const appEl = useAppRoot()
  return (
    <Dialog.Root open={open} onOpenChange={o => !o && onClose()}>
      <Dialog.Portal container={appEl}>
        <Dialog.Overlay className="modal-scrim" />
        <Dialog.Content
          className={cn('modal', r20 && 'r20')}
          style={{ width }}
          onOpenAutoFocus={e => e.preventDefault()}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
