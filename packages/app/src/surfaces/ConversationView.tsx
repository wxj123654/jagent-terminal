/**
 * surfaces/ConversationView.tsx — 会话表面共享件（T3+.1 从 ChatSurface 提取）。
 *
 * chat 与 acp 两种 thread 的消息面同构（布局契约 §5.2/§5.3）：薄顶栏（pill +
 * 标题）+ virtual-list 消息区（alignment:bottom + followTail）+ composer。
 * 差异全部参数化：pill 文案/颜色、testId 前缀、消息源、发送回调。
 *
 * composer 只把输入送进 onSend（→ ChatAgent seam：chat 的 EchoAgent / acp 的
 * JSON-RPC 连接）——与 PTY stdin 无关（契约硬规则）；enter=发送（GPUIX
 * textarea 内建 Submit 键绑定），shift-enter=换行。
 *
 * assistant 消息走 GPUIX <markdown>（GFM；agent 富文本免费），user 消息纯
 * text 按 \n 拆行（StyleDesc 无 pre-wrap）。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'

import { COLORS, FONT } from '@jagent/ui'
import type { ChatMessage } from '../threads/chat'

export type ConversationViewProps = {
  pill: string
  pillColor: string
  title: string
  titleTestId: string
  composerTestId: string
  sendTestId: string
  placeholder: string
  messages: ChatMessage[]
  /** agent 回复进行中：composer 发送钮禁用 + thinking 占位 */
  pendingReply: boolean
  onSend: (text: string) => void
}

export function ConversationView({
  pill,
  pillColor,
  title,
  titleTestId,
  composerTestId,
  sendTestId,
  placeholder,
  messages,
  pendingReply,
  onSend,
}: ConversationViewProps): ReactElement {
  const [draft, setDraft] = useState('')

  const submit = () => {
    if (!draft.trim() || pendingReply) return
    onSend(draft)
    setDraft('')
  }

  return (
    <div
      style={{
        flexGrow: 1,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: COLORS.pane,
      }}
    >
      {/* 薄顶栏：pill + 标题（原型 .chat-header；高度 36px 契约 §5.2「锁死」） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          height: 36,
          paddingLeft: 16,
          paddingRight: 16,
          borderBottomWidth: 1,
          borderColor: COLORS.border,
          flexShrink: 0,
        }}
      >
        <text
          style={{
            fontFamily: FONT.mono,
            fontSize: 10,
            color: pillColor,
            backgroundColor: COLORS.accentSoft,
            paddingTop: 2,
            paddingBottom: 2,
            paddingLeft: 6,
            paddingRight: 6,
            borderRadius: 3,
            pointerEvents: 'none',
          }}
        >
          {pill}
        </text>
        <text
          testId={titleTestId}
          style={{
            fontFamily: FONT.ui,
            fontSize: 13,
            color: COLORS.textBright,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {title}
        </text>
      </div>

      {/* 消息区：尾部跟随的虚拟列表（空态贴底；消息内边距契约 §3 20–24px） */}
      <virtual-list
        alignment="bottom"
        followTail
        estimatedItemHeight={64}
        style={{
          flexGrow: 1,
          paddingTop: 20,
          paddingBottom: 20,
          paddingLeft: 24,
          paddingRight: 24,
        }}
      >
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} />
        ))}
        {pendingReply ? (
          <div
            key="__thinking"
            style={{ display: 'flex', flexDirection: 'row', flexShrink: 0, marginBottom: 16 }}
          >
            <text
              style={{
                fontFamily: FONT.mono,
                fontSize: 11,
                color: COLORS.muted,
                pointerEvents: 'none',
              }}
            >
              thinking…
            </text>
          </div>
        ) : null}
      </virtual-list>

      {/* composer：textarea + 发送钮（原型 .composer-box）。pendingReply 禁发 */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: 8,
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 10,
          paddingBottom: 12,
          borderTopWidth: 1,
          borderColor: COLORS.border,
          flexShrink: 0,
        }}
      >
        <textarea
          testId={composerTestId}
          value={draft}
          placeholder={placeholder}
          minRows={1}
          maxRows={6}
          autoFocus
          onChange={(e) => setDraft(e.value ?? '')}
          onSubmit={() => submit()}
          style={{
            flexGrow: 1,
            fontFamily: FONT.ui,
            fontSize: 13,
            lineHeight: 18,
            color: COLORS.textBright,
            backgroundColor: COLORS.inputBg,
            borderWidth: 1,
            borderColor: COLORS.borderSubtle,
            borderRadius: 6,
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 10,
            paddingRight: 10,
          }}
        />
        <div
          testId={sendTestId}
          tabIndex={0}
          onClick={() => submit()}
          onKeyDown={(e) => {
            if (e.key === 'enter' || e.key === 'space') submit()
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 34,
            paddingLeft: 12,
            paddingRight: 12,
            borderRadius: 6,
            backgroundColor: pendingReply ? COLORS.surface : COLORS.accentSoft,
            cursor: pendingReply ? 'default' : 'pointer',
            userSelect: 'none',
            hover: pendingReply ? undefined : { backgroundColor: COLORS.surfaceHover },
          }}
        >
          <text
            style={{
              fontFamily: FONT.ui,
              fontSize: 12,
              color: pendingReply ? COLORS.muted : COLORS.textBright,
              pointerEvents: 'none',
            }}
          >
            Send
          </text>
        </div>
      </div>
    </div>
  )
}

/** 单条消息行：user 右对齐气泡 / assistant 左对齐 markdown + role 标签（原型 .msg） */
export function MessageRow({ m }: { m: ChatMessage }): ReactElement {
  if (m.role === 'user') {
    return (
      <div
        key={m.id}
        style={{
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'flex-end',
          flexShrink: 0,
          marginBottom: 16,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            maxWidth: 640,
            backgroundColor: COLORS.accentSoft,
            borderWidth: 1,
            borderColor: COLORS.borderSubtle,
            borderRadius: 10,
            paddingTop: 10,
            paddingBottom: 10,
            paddingLeft: 14,
            paddingRight: 14,
          }}
        >
          {/* StyleDesc 无 pre-wrap：换行拆多段 text */}
          {m.text.split('\n').map((line, i) => (
            <text key={i} style={{ fontFamily: FONT.ui, fontSize: 14, color: COLORS.textBright }}>
              {line || ' '}
            </text>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div
      key={m.id}
      style={{ display: 'flex', flexDirection: 'row', flexShrink: 0, marginBottom: 16 }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 640 }}>
        <text
          style={{
            fontFamily: FONT.mono,
            fontSize: 10,
            color: m.error ? COLORS.bell : COLORS.terminalKind,
            marginBottom: 4,
            pointerEvents: 'none',
          }}
        >
          {m.error ? 'ERROR' : 'ASSISTANT'}
        </text>
        <markdown
          source={m.text}
          style={{ fontFamily: FONT.ui, fontSize: 14, color: m.error ? COLORS.bell : COLORS.text }}
        />
      </div>
    </div>
  )
}
