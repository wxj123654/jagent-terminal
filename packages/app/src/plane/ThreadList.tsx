/**
 * ThreadList — 混排列表（布局契约 §2/§4；chat/terminal/acp 同一列表）。
 *
 * 只订阅 id 数组（threads 顺序/增删），每行 ThreadRow 自行按粒度订阅。
 * 可滚动（列表超 sidebar 高时）。
 */

import { useThreadStore } from '../threads/useThreadStore'
import type { ThreadStore } from '../threads/store'
import { ThreadRow } from './ThreadRow'

export function ThreadList({ store }: { store: ThreadStore }) {
  const ids = useThreadStore(store, (s) => s.threads.map((t) => t.id).join(','))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, overflowY: 'scroll' }}>
      {ids === '' ? null : ids.split(',').map((id) => (
        <ThreadRow key={id} id={id} store={store} />
      ))}
    </div>
  )
}
