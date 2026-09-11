/**
 * surfaces/ChatSurface.tsx — chat 表面（布局契约 §5.2；T3.2 实装）。
 *
 * T3+.1 起消息面/composer 提取到 ConversationView（与 AcpSurface 同构）；
 * 本组件 = chat 特化（CHAT pill + ChatAgent seam 经 store.sendChatMessage）。
 */

import { COLORS } from '@jagent/ui'
import type { ChatThread } from '../threads/store'
import { ConversationView } from './ConversationView'
import type { SurfaceProps } from './registry'

export function ChatSurface({ thread, store }: SurfaceProps) {
  const t = thread as ChatThread // registry 保证 kind==='chat' 进此表面
  return (
    <ConversationView
      pill="CHAT"
      pillColor={COLORS.accent}
      title={t.title}
      titleTestId="chat-title"
      composerTestId="chat-composer"
      sendTestId="chat-send"
      placeholder="Ask…"
      messages={t.messages}
      pendingReply={t.pendingReply}
      onSend={(text) => store.sendChatMessage(t.id, text)}
    />
  )
}
