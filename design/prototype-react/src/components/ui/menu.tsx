import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as ContextMenu from '@radix-ui/react-context-menu'
import type { ReactNode } from 'react'
import { useAppRoot } from '@/approot'
import { cn } from '@/lib/utils'

export type MenuItem = { id: string; label: string; danger?: boolean } | 'sep'

function Items({
  items,
  onPick,
  Item,
  Sep,
}: {
  items: MenuItem[]
  onPick: (id: string) => void
  Item: typeof DropdownMenu.Item
  Sep: typeof DropdownMenu.Separator
}) {
  return (
    <>
      {items.map((it, i) =>
        it === 'sep' ? (
          <Sep key={i} className="ctx-sep" />
        ) : (
          <Item
            key={it.id}
            className={cn('ctx-item', it.danger && 'danger')}
            onSelect={() => onPick(it.id)}
          >
            {it.label}
          </Item>
        ),
      )}
    </>
  )
}

/** 右键菜单（.ctx-menu） */
export function CtxMenu({
  items,
  onPick,
  children,
}: {
  items: MenuItem[]
  onPick: (id: string) => void
  children: ReactNode
}) {
  const appEl = useAppRoot()
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal container={appEl}>
        <ContextMenu.Content className="ctx-menu">
          <Items items={items} onPick={onPick} Item={ContextMenu.Item} Sep={ContextMenu.Separator} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

/** 下拉菜单（「…」钮 / 分支 chip）。items 模式或自定义 children（如 branch-pop）。 */
export function DropMenu({
  items,
  onPick,
  trigger,
  children,
  align = 'start',
  className = 'ctx-menu',
  side,
  sideOffset = 4,
}: {
  items?: MenuItem[]
  onPick?: (id: string) => void
  trigger: ReactNode
  children?: ReactNode
  align?: 'start' | 'center' | 'end'
  className?: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  sideOffset?: number
}) {
  const appEl = useAppRoot()
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal container={appEl}>
        <DropdownMenu.Content
          className={className}
          align={align}
          side={side}
          sideOffset={sideOffset}
        >
          {items && onPick ? (
            <Items items={items} onPick={onPick} Item={DropdownMenu.Item} Sep={DropdownMenu.Separator} />
          ) : (
            children
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
