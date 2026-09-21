/**
 * surfaces/ConversationView.tsx — 会话表面共享件（T3+.1 从 ChatSurface 提取）。
 *
 * chat 与 acp 两种 thread 的消息面同构（布局契约 §5.2/§5.3）。R9 对齐原型
 * ConversationView（index.css 第二段 :root 生效值）：
 *   .conv-head 44px——conv-avatar 26² 图标块 + conv-title 600 + 右置
 *     conv-status（done 点 + 「正在回复/已连接」）；
 *   .conv-msgs——virtual-list（alignment:top + followTail）；行内套
 *     .conv-msgs-in 居中列（min(760,100%) / pad 28，窄态 22·18）；
 *   .msg——user 右对齐 .bubble（accentSoft + 12·12·3·12 圆角 + 投影）；
 *     assistant = .role（mono 10，error→bell）+ .body <markdown>；
 *   .thinking——accent 圆点 + 「正在思考…」（pendingReply）；
 *   .composer——居中 704 列：.composer-shell（inputBg + r12 + 投影，焦点态
 *     换 focusBorder 边 + accentSoft 环）内 textarea + .send-btn 34²
 *     accent 箭头钮（pendingReply→disabled 灰面）；下方 .composer-hint
 *     「Enter 发送 · Shift + Enter 换行」右对齐。
 *
 * composer 只把输入送进 onSend（→ ChatAgent seam：chat 的 EchoAgent / acp 的
 * JSON-RPC 连接）——与 PTY stdin 无关（契约硬规则）；enter=发送（GPUIX
 * textarea 内建 Submit 键绑定），shift-enter=换行。
 *
 * GPUIX 不支持项（有意偏离）：letter-spacing（role/kicker）、:focus-visible
 * 双环（focusRing 近似）、composer 阴影多值叠加（单阴影近似）。
 */

import { useWindowSize } from '@gpuix/react'
import type { GpuixTheme } from '@gpuix/react'
import { useState } from 'react'
import type { ReactElement } from 'react'

import { Icon, COLORS, FONT, focusRing, inputFocus, type IconName } from '@jagent/ui'
import type { ChatMessage } from '../threads/chat'
import { SIZES } from '../tokens'

export type ConversationViewProps = {
  /** conv-avatar 图标（chat=agent / acp=acp；图标色恒 accent——原型
      对 chat/acp 同用 --accent，acp 不换紫） */
  avatarIcon: IconName
  title: string
  titleTestId: string
  composerTestId: string
  sendTestId: string
  placeholder: string
  messages: ChatMessage[]
  /** agent 回复进行中：send 钮 disabled + thinking 占位 + status 翻「正在回复」 */
  pendingReply: boolean
  onSend: (text: string) => void
}

/** .msg .body 的 <markdown> 主题（原型第二段：正文 14/1.65 text 色、
 *  pre 底 #15181d + borderSubtle 边 r8 + pad 13·14、inline code inputBg 底） */
const MD_THEME: GpuixTheme = {
  fontSans: FONT.ui,
  fontMono: FONT.mono,
  text: COLORS.text,
  textMuted: COLORS.muted,
  textFaint: COLORS.faint,
  accent: COLORS.accent,
  bg: '#15181d',
  border: COLORS.borderSubtle,
  codeWash: COLORS.inputBg,
  metrics: {
    mdTextSize: 14,
    mdLineHeight: 23.1, // 1.65 × 14
    mdBlockGap: 12, // p/ul margin 6+6 合并
    mdCodePaddingX: 14,
    mdCodePaddingY: 13,
    mdCodeRadius: 8,
    mdInlineCodeRadius: 4,
  },
}
/** error 行：.body color→bell（原型 inline style 覆盖） */
const MD_THEME_ERR: GpuixTheme = { ...MD_THEME, text: COLORS.bell }

export function ConversationView({
  avatarIcon,
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
  /** composer-shell :focus-within 等价（GPUIX 无该伪类——textarea 自报） */
  const [shellFocused, setShellFocused] = useState(false)
  const [sendFocused, setSendFocused] = useState(false)
  const narrow = useWindowSize().width < SIZES.narrowBreakpoint

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
        minWidth: 0,
      }}
    >
      {/* .conv-head：44px——avatar + title + 右置 status */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          height: 44,
          paddingLeft: 20,
          paddingRight: 20,
          borderBottomWidth: 1,
          borderColor: COLORS.borderSubtle,
          flexShrink: 0,
        }}
      >
        {/* .conv-avatar：26² r7 surface 块 + accent 图标 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            flexShrink: 0,
            borderWidth: 1,
            borderColor: COLORS.borderSubtle,
            borderRadius: 7,
            backgroundColor: COLORS.surface,
          }}
        >
          <Icon name={avatarIcon} size={14} color={COLORS.accent} />
        </div>
        <text
          testId={titleTestId}
          style={{
            fontFamily: FONT.ui,
            fontSize: 13,
            fontWeight: '600',
            color: COLORS.textBright,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            minWidth: 0,
            flexShrink: 1,
            pointerEvents: 'none',
          }}
        >
          {title}
        </text>
        {/* margin-left:auto 等价（StyleDesc margin 只吃数值） */}
        <div style={{ flexGrow: 1 }} />
        {/* .conv-status：done 点 + 状态文案 */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: 9999,
              backgroundColor: COLORS.statusDone,
              flexShrink: 0,
            }}
          />
          <text
            style={{
              fontFamily: FONT.ui,
              fontSize: 11,
              color: COLORS.muted,
              pointerEvents: 'none',
            }}
          >
            {pendingReply ? '正在回复' : '已连接'}
          </text>
        </div>
      </div>

      {/* 消息区：尾部跟随的虚拟列表。alignment=top + followTail = 原型
          scrollTop=scrollHeight 语义：短内容顶锚（原型 .conv-msgs 是
          flex-column 普通滚动容器），溢出后跟随尾部。
          .conv-msgs-in 居中列拆到每行：行根 w100% 居中 → 内列
          min(760,100%) pad 0 28（窄 18）；列纵向 pad 在列表自身
          （28 顶 / 18 底，窄 22 顶）。水平 padding 不能放列表上——
          virtual-list 行根 width:100% 吃的是列表全宽（走查 D2 坑）。 */}
      <virtual-list
        alignment="top"
        followTail
        estimatedItemHeight={64}
        style={{
          flexGrow: 1,
          paddingTop: narrow ? 22 : 28,
          paddingBottom: 18,
        }}
      >
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} narrow={narrow} />
        ))}
        {pendingReply ? <ThinkingRow narrow={narrow} /> : null}
      </virtual-list>

      {/* .composer：居中 704 列（max(20,(100%-704)/2) 横内距 → 内列
          maxWidth 居中表达）；border-top 无，底 = pane 向上渐隐 */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: 10,
          paddingBottom: 14,
          paddingLeft: narrow ? 14 : 20,
          paddingRight: narrow ? 14 : 20,
          flexShrink: 0,
          background: {
            type: 'linear-gradient',
            angle: 0, // to top
            stops: [
              { color: COLORS.pane, position: 0.75 },
              { color: 'rgba(28,31,37,0)', position: 1 },
            ],
          },
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 704,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {/* .composer-shell：inputBg r12 盒（textarea + send 钮） */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'flex-end',
              gap: 8,
              paddingTop: 7,
              paddingBottom: 7,
              paddingLeft: 12,
              paddingRight: 7,
              borderWidth: 1,
              borderColor: shellFocused ? COLORS.focusBorder : COLORS.borderSubtle,
              borderRadius: 12,
              backgroundColor: COLORS.inputBg,
              // focus-within 原型双阴影（3px accentSoft 环 + 下落影）——
              // GPUI 单阴影取环；非焦点 = 0 8 24 .2 下落影
              boxShadow: shellFocused
                ? {
                    offsetX: 0,
                    offsetY: 0,
                    blurRadius: 0,
                    spreadRadius: 3,
                    color: COLORS.accentSoft,
                  }
                : {
                    offsetX: 0,
                    offsetY: 8,
                    blurRadius: 24,
                    spreadRadius: 0,
                    color: 'rgba(0,0,0,0.2)',
                  },
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
              onFocus={() => {
                setShellFocused(true)
                inputFocus.acquire()
              }}
              onBlur={() => {
                setShellFocused(false)
                inputFocus.release()
              }}
              style={{
                flexGrow: 1,
                minHeight: 32,
                fontFamily: FONT.ui,
                fontSize: 13,
                lineHeight: 18,
                color: COLORS.textBright,
                backgroundColor: 'transparent',
                borderWidth: 0,
                paddingTop: 7,
                paddingBottom: 7,
                paddingLeft: 2,
                paddingRight: 2,
              }}
            />
            {/* .send-btn：34² accent 箭头钮；pendingReply → disabled
                （surface 底 / borderSubtle 边 / muted 图标 / default 光标） */}
            <div
              testId={sendTestId}
              tabIndex={0}
              onClick={() => submit()}
              onKeyDown={(e) => {
                if (e.key === 'enter' || e.key === 'space') submit()
              }}
              onFocus={() => setSendFocused(true)}
              onBlur={() => setSendFocused(false)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 34,
                flexShrink: 0,
                borderWidth: 1,
                borderRadius: 8,
                borderColor: pendingReply ? COLORS.borderSubtle : COLORS.accent,
                backgroundColor: pendingReply ? COLORS.surface : COLORS.accent,
                cursor: pendingReply ? 'default' : 'pointer',
                userSelect: 'none',
                boxShadow: sendFocused ? focusRing() : undefined,
                hover: pendingReply ? undefined : { backgroundColor: COLORS.accentHover },
              }}
            >
              {/* 原型 send-btn color #17202a（accent 底上的深字色） */}
              <Icon name="arrowRight" size={15} color={pendingReply ? COLORS.muted : '#17202a'} />
            </div>
          </div>
          {/* .composer-hint：右对齐 faint 10px */}
          <text
            style={{
              fontFamily: FONT.ui,
              fontSize: 10,
              color: COLORS.faint,
              textAlign: 'right',
              paddingLeft: 4,
              paddingRight: 4,
              pointerEvents: 'none',
            }}
          >
            Enter 发送 · Shift + Enter 换行
          </text>
        </div>
      </div>
    </div>
  )
}

/** .conv-msgs-in 居中槽：virtual-list 每行的公共壳（行根撑满居中 →
 *  内列 min(760,100%) pad 0 28，窄态 18；行距 = .msg 22 / .thinking 16）。
 *  行距必须用 paddingBottom 而不能用 marginBottom——gpui ListState 测行高
 *  时行根的 margin 不计入自身尺寸（margin 塌陷），padding 才算。 */
function ConvIn({
  narrow,
  padBottom,
  children,
}: {
  narrow: boolean
  padBottom: number
  children: React.ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'center',
        width: '100%',
        flexShrink: 0,
        paddingBottom: padBottom,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: 760,
          paddingLeft: narrow ? 18 : 28,
          paddingRight: narrow ? 18 : 28,
        }}
      >
        {children}
      </div>
    </div>
  )
}

/** .thinking：accent 圆点（7² + 4px accentSoft 环）+ 12px muted 文案 */
function ThinkingRow({ narrow }: { narrow: boolean }) {
  return (
    <ConvIn narrow={narrow} padBottom={16}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            width: 7,
            height: 7,
            borderRadius: 9999,
            backgroundColor: COLORS.accent,
            flexShrink: 0,
            boxShadow: {
              offsetX: 0,
              offsetY: 0,
              blurRadius: 0,
              spreadRadius: 4,
              color: COLORS.accentSoft,
            },
          }}
        />
        <text
          style={{
            fontFamily: FONT.ui,
            fontSize: 12,
            color: COLORS.muted,
            pointerEvents: 'none',
          }}
        >
          正在思考…
        </text>
      </div>
    </ConvIn>
  )
}

/** 单条消息行：user 右对齐气泡 / assistant 左对齐 markdown + role 标签（原型 .msg） */
export function MessageRow({ m, narrow = false }: { m: ChatMessage; narrow?: boolean }) {
  if (m.role === 'user') {
    return (
      <ConvIn narrow={narrow} padBottom={22}>
        {/* .msg.user → bubble alignSelf:flex-end；620 上限 / accentSoft 底 /
            12·12·3·12 圆角 / rgba(97,175,239,.28) 边 / 0 1 2 投影 */}
        <div
          style={{
            alignSelf: 'flex-end',
            display: 'flex',
            flexDirection: 'column',
            maxWidth: 620,
            backgroundColor: COLORS.accentSoft,
            borderWidth: 1,
            borderColor: 'rgba(97,175,239,0.28)',
            borderTopLeftRadius: 12,
            borderTopRightRadius: 12,
            borderBottomRightRadius: 3,
            borderBottomLeftRadius: 12,
            paddingTop: 10,
            paddingBottom: 10,
            paddingLeft: 14,
            paddingRight: 14,
            boxShadow: {
              offsetX: 0,
              offsetY: 1,
              blurRadius: 2,
              spreadRadius: 0,
              color: 'rgba(0,0,0,0.2)',
            },
          }}
        >
          {/* StyleDesc 无 pre-wrap：换行拆多段 text（14px lh≈1.5 → 21） */}
          {m.text.split('\n').map((line, i) => (
            <text
              key={i}
              style={{
                fontFamily: FONT.ui,
                fontSize: 14,
                lineHeight: 21,
                color: COLORS.textBright,
              }}
            >
              {line || ' '}
            </text>
          ))}
        </div>
      </ConvIn>
    )
  }
  return (
    <ConvIn narrow={narrow} padBottom={22}>
      {/* .msg:not(.user)>div{width:100%}：role 标签 + body 全宽列 */}
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
        <text
          style={{
            fontFamily: FONT.mono,
            fontSize: 10,
            fontWeight: '600',
            color: m.error ? COLORS.bell : COLORS.terminalKind,
            marginBottom: 7,
            pointerEvents: 'none',
          }}
        >
          {m.error ? 'ERROR' : 'ASSISTANT'}
        </text>
        {/* .body：maxWidth 700；主题见 MD_THEME（字号/行高/色块对齐原型） */}
        <markdown
          source={m.text}
          theme={m.error ? MD_THEME_ERR : MD_THEME}
          style={{ maxWidth: 700 }}
        />
      </div>
    </ConvIn>
  )
}
