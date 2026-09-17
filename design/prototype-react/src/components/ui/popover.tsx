import * as Popover from '@radix-ui/react-popover'
import type { ReactNode } from 'react'
import { useAppRoot } from '@/approot'

/** 受控浮层（通知中心 / 字体选择器），Portal 进 #app */
export function Pop({
  open,
  onOpenChange,
  anchor,
  children,
  className,
  side = 'bottom',
  align = 'start',
  sideOffset = 4,
  onOpenAutoFocus,
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
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor asChild>{anchor}</Popover.Anchor>
      <Popover.Portal container={appEl}>
        <Popover.Content
          className={className}
          side={side}
          align={align}
          sideOffset={sideOffset}
          onOpenAutoFocus={onOpenAutoFocus}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
