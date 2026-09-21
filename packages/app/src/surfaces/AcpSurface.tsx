/**
 * surfaces/AcpSurface.tsx — ACP thread 表面（布局契约 §5.3；T3+.1 实装）。
 *
 * 外部 agent（ACP JSON-RPC 子进程，threads/acp.ts）的会话面：acp avatar
 * 图标 + agent 标题 + ConversationView 消息/composer（原型 conv-avatar
 * 对 acp 也用 accent 色图标，不换紫）。发送走
 * store.sendAcpMessage → ChatAgent seam（连接惰性建立；agent 侧工具调用/
 * 权限以 markdown bullet/文本摘要随回复呈现，权限自动应答见 acp.ts 注记）。
 */

import type { AcpThread } from '../threads/store'
import { ConversationView } from './ConversationView'
import type { SurfaceProps } from './registry'

export function AcpSurface({ thread, store }: SurfaceProps) {
  const t = thread as AcpThread // registry 保证 kind==='acp' 进此表面
  return (
    <ConversationView
      avatarIcon="acp"
      title={t.title}
      titleTestId="acp-title"
      composerTestId="acp-composer"
      sendTestId="acp-send"
      placeholder="Ask agent…"
      messages={t.messages}
      pendingReply={t.pendingReply}
      onSend={(text) => store.sendAcpMessage(t.id, text)}
    />
  )
}
