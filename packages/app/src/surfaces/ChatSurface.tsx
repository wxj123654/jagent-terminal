/**
 * surfaces/ChatSurface.tsx — chat 表面（布局契约 §5.2；T3.2 实装）。
 *
 * 结构：薄顶栏（CHAT pill + 标题，只属 chat 表面）+ virtual-list 消息区
 * （alignment:bottom + followTail 尾部跟随）+ 底 composer。
 * composer 只把输入送进 ChatAgent seam（threads/chat.ts）——与 PTY stdin
 * 无关（契约硬规则）；enter=发送（GPUIX textarea 内建 Submit 键绑定），
 * shift-enter=换行。
 *
 * 状态机在 store.sendChatMessage 一处（locality）；本组件纯展示 + draft
 * 局部态。assistant 消息走 GPUIX <markdown>（GFM；ACP/LLM 富文本免费），
 * user 消息纯 text 按 \n 拆行（StyleDesc 无 pre-wrap）。
 */

import { useState } from 'react'

import type { ChatMessage } from '../threads/chat'
import type { ChatThread } from '../threads/store'
import { COLORS, FONT } from '../ui/tokens'
import type { SurfaceProps } from './registry'

export function ChatSurface({ thread, store }: SurfaceProps) {
  const t = thread as ChatThread // registry 保证 kind==='chat' 进此表面
  const [draft, setDraft] = useState('')

  const submit = () => {
    if (!draft.trim() || t.pendingReply) return
    store.sendChatMessage(t.id, draft)
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
      {/* 薄顶栏：CHAT pill + 标题（原型 .chat-header；高度 36px 契约 §5.2「锁死」） */}
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
            color: COLORS.accent,
            backgroundColor: COLORS.accentSoft,
            paddingTop: 2,
            paddingBottom: 2,
            paddingLeft: 6,
            paddingRight: 6,
            borderRadius: 3,
            pointerEvents: 'none',
          }}
        >
          CHAT
        </text>
        <text
          testId="chat-title"
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
          {t.title}
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
        {t.messages.map((m) => (
          <MessageRow key={m.id} m={m} />
        ))}
        {t.pendingReply ? (
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
          testId="chat-composer"
          value={draft}
          placeholder="Ask…"
          minRows={1}
          maxRows={6}
          autoFocus
          onChange={(e) => setDraft(e.value ?? '')}
          onSubmit={() => submit()}
          style={{
            flexGrow: 1,
            fontFamily: FONT.ui,
            fontSize: 13,
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
          testId="chat-send"
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
            backgroundColor: t.pendingReply ? COLORS.surface : COLORS.accentSoft,
            cursor: t.pendingReply ? 'default' : 'pointer',
            userSelect: 'none',
            hover: t.pendingReply ? undefined : { backgroundColor: COLORS.surfaceHover },
          }}
        >
          <text
            style={{
              fontFamily: FONT.ui,
              fontSize: 12,
              color: t.pendingReply ? COLORS.muted : COLORS.textBright,
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
function MessageRow({ m }: { m: ChatMessage }) {
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
