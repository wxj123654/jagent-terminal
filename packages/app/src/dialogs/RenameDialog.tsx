/**
 * dialogs/RenameDialog.tsx — 重命名弹窗（codex-sidebar-v2 方案 C；原型
 * <dialog>.ren-dlg：Enter 提交，Esc/Cancel/点遮罩取消）。
 *
 * 上下文菜单 Rename… 的二级交互；会话（terminal customTitle / chat·acp
 * title）与工作区共用一壳——目标经 DialogHost 的 rename kind 传入。
 * 重命名唯一入口（行内双击编辑已移除）。输入框 autoFocus：deferred 层
 * 点击聚焦不可靠（W7 实测），弹窗主输入必须挂载即聚焦。
 */

import { useState } from 'react'

import { Modal, ModalActions, ModalBody, ModalHeading, TextInput, COLORS, FONT } from '@jagent/ui'
import type { ThreadStore } from '../threads/store'
import { displayTitle } from '../threads/terminal'
import { useThreadStore } from '../threads/useThreadStore'

export type RenameTarget = { type: 'thread' | 'workspace'; id: string }

export function RenameDialog({
  store,
  target,
  onClose,
}: {
  store: ThreadStore
  target: RenameTarget
  onClose: () => void
}) {
  const thread = useThreadStore(store, (s) =>
    target.type === 'thread' ? s.threads.find((t) => t.id === target.id) : undefined,
  )
  const workspace = useThreadStore(store, (s) =>
    target.type === 'workspace' ? s.workspaces.find((w) => w.id === target.id) : undefined,
  )
  const current =
    target.type === 'thread'
      ? thread
        ? thread.kind === 'terminal'
          ? displayTitle(thread)
          : thread.title
        : ''
      : (workspace?.name ?? '')
  const [name, setName] = useState(current)

  // 目标在弹窗开着时被移除（他处 close/removeWorkspace）→ 直接关
  if (target.type === 'thread' ? !thread : !workspace) return null

  const title = target.type === 'thread' ? '重命名会话' : '重命名工作区'
  const commit = () => {
    if (name.trim()) {
      if (target.type === 'thread') store.rename(target.id, name)
      else store.renameWorkspace(target.id, name)
    }
    onClose()
  }

  return (
    <Modal width={320} onClose={onClose}>
      <ModalHeading title={title} onClose={onClose} />
      <ModalBody>
        <text style={{ fontSize: 11, fontFamily: FONT.ui, color: COLORS.muted }}>名称</text>
        <TextInput
          testId="rename-dialog-input"
          value={name}
          onChange={setName}
          onSubmit={commit}
          width="fill"
          autoFocus
        />
        <ModalActions
          actions={[
            { label: '取消', onClick: onClose },
            { label: '重命名', primary: true, onClick: commit },
          ]}
        />
      </ModalBody>
    </Modal>
  )
}
