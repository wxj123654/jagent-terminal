/**
 * plane/SessionDialog.tsx — 管理会话弹窗（Phase W7；原型 session-dialog）。
 *
 * 会话行「…」的二级交互（替代 W6 的 anchored 行内菜单——形态回到原型）：
 * 上下文行（工作区 · 工具）+ 重命名（行内编辑保留在行双击，这里表单化）
 * + 移除（danger）。输入框 Enter 提交。
 */

import { useState } from 'react'

import type { ThreadStore } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { Modal, ModalActions, ModalBody, ModalHeading } from '../ui/Modal'
import { TextInput } from '../ui/TextInput'
import { COLORS, FONT } from '../ui/tokens'

export function SessionDialog({
  store,
  threadId,
  onClose,
}: {
  store: ThreadStore
  threadId: string
  onClose: () => void
}) {
  const thread = useThreadStore(store, (s) => s.threads.find((t) => t.id === threadId))
  const workspaceName = useThreadStore(
    store,
    (s) => s.workspaces.find((w) => w.id === thread?.workspaceId)?.name,
  )
  const [name, setName] = useState(
    thread
      ? thread.kind === 'terminal'
        ? (thread.customTitle ?? thread.oscTitle ?? thread.initCommand ?? 'Terminal')
        : thread.title
      : '',
  )

  if (!thread) return null
  const toolLabel =
    thread.kind === 'terminal'
      ? (thread.initCommand ?? 'shell')
      : thread.kind === 'acp'
        ? `ACP · ${thread.title}`
        : 'Chat'

  const save = () => {
    if (name.trim()) store.rename(threadId, name)
    onClose()
  }
  const remove = () => {
    store.close(threadId)
    onClose()
  }

  return (
    <Modal width={400} onClose={onClose}>
      <ModalHeading title="管理会话" onClose={onClose} />
      <ModalBody>
        <text
          style={{
            fontSize: 11,
            fontFamily: FONT.ui,
            color: COLORS.muted,
            marginBottom: 10,
          }}
        >
          {workspaceName ? `${workspaceName} · ` : ''}
          {toolLabel}。移除会关闭其终端进程。
        </text>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <text style={{ fontSize: 11, fontFamily: FONT.ui, color: COLORS.muted }}>会话名称</text>
          <TextInput
            testId="session-dialog-name"
            value={name}
            onChange={setName}
            onSubmit={save}
            width="fill"
          />
        </div>
        <ModalActions
          actions={[
            { label: '移除会话', danger: true, onClick: remove },
            { label: '保存名称', primary: true, onClick: save },
          ]}
        />
      </ModalBody>
    </Modal>
  )
}
