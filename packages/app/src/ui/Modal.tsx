/**
 * ui/Modal.tsx — 居中模态原语（Phase W7；对齐原型 <dialog> 形态）。
 *
 * 实现：全屏遮罩 div（backgroundColor 半透明 + occlude 吞点）+ 点击遮罩
 * 关闭；内容卡用 <anchored position={x,y}> + deferred（画在一切内容之上，
 * CONSTRAINS #2 树序绘制）+ occlude。居中经 useWindowSize（TestRenderer
 * fallback 800×600——测试断言按几何而非窗口常量）。
 *
 * 键盘：Esc 关闭（遮罩容器 onKeyDown；GPUX 无 :focus-within，输入框聚焦
 * 时事件命中输入框自身——Modal 内输入 onKeyDown 需先自理再放行 Esc，
 * 见 TextInput onKeyDown 用法）。gpui 无窗口级鼠标事件，遮罩 onClick 是
 * 唯一外点关闭路径。
 *
 * 尺寸事实（W2 记录）：anchored 不支持 inset 拉伸——宽 = 内容宽，这里用
 * width 钳制（GPUIX 显式 width 参与布局）；maxHeight + overflowY scroll
 * 防长内容溢窗。
 */

import { useWindowSize } from '@gpuix/react'
import type { ReactNode } from 'react'

import { Icon } from './Icon'
import { COLORS, FONT } from './tokens'

/** 卡片目标高（可缺省 = 内容自适应；设了则列表区独立滚动——原型 tool-dialog 固定高形态） */
export function Modal({
  width,
  height,
  children,
  onClose,
}: {
  /** 卡片目标宽（px；内容区自带 padding） */
  width: number
  /** 卡片目标高（px；缺省内容自适应，anchored 高随内容） */
  height?: number
  children: ReactNode
  /** Esc / 点击遮罩 → 关闭（调用方通常 setShow(false)） */
  onClose: () => void
}) {
  const { width: vw, height: vh } = useWindowSize()
  // 窄窗钳制（D18，原型 min(92vw, ...)）：卡片宽不超出视口（两侧至少 12px），
  // 高不超出 vh-48。原固定宽 440/460/480 在 390px 窗口会横向溢出。
  const cardWidth = Math.min(width, vw - 24)
  const cardHeight = height ? Math.min(height, vh - 48) : undefined
  // 居中（窗口比卡片窄时贴边防御——测试窗口 800×600 场景）
  const x = Math.max((vw - cardWidth) / 2, 12)
  const y = cardHeight ? Math.max((vh - cardHeight) / 2, 12) : Math.max((vh - 360) / 2, 12)

  // 覆盖层定位：absolute 四边 0。W7 实测：GPUIX absolute 需要最近定位
  // 祖先 relative，否则塌缩 0×0——本组件要求挂载点在有 relative 的容器
  // 内（AgentPlane 内容行已满足；测试 Harness 需包一层）。自身
  // pointerEvents none 让底下的内容可点，scrim 自行 auto。
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        pointerEvents: 'none',
      }}
    >
      {/* 遮罩：全屏、半透明、吞点（GPUIX 树序：先于内容渲染，anchored
          deferred 层永远画在其上）；点击 = 关闭。GPUIX 事实（W7 实测）：
          absolute 定位需要最近的定位祖先是 relative——无 relative 时
          四边全 0 塌缩为 0×0 不渲染。本容器自带 relative，任意挂载点可用 */}
      <div
        testId="modal-scrim"
        onClick={onClose}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          backgroundColor: '#00000066',
          pointerEvents: 'auto',
        }}
      />
      <anchored
        position={{ x, y }}
        deferred
        occlude
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: cardWidth,
          height: cardHeight,
          maxHeight: vh - 48,
          backgroundColor: COLORS.inputBg,
          borderWidth: 1,
          borderColor: COLORS.borderSubtle,
          borderRadius: 8,
          color: COLORS.text,
          fontFamily: FONT.ui,
        }}
      >
        <div
          testId="modal-card"
          onKeyDown={(e) => {
            if (e.key === 'escape') onClose()
          }}
          style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
        >
          {children}
        </div>
      </anchored>
    </div>
  )
}

/** 弹窗标题行（heading）：标题 + 可选尾插槽 + 关闭钮（对齐原型 dialog-heading） */
export function ModalHeading({
  title,
  onClose,
  trailing,
}: {
  title: string
  onClose: () => void
  /** 标题与关闭钮之间的插槽（ErrorDialog 清空钮等） */
  trailing?: ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: 16,
        paddingRight: 10,
        paddingTop: 12,
        paddingBottom: 10,
      }}
    >
      <text
        style={{
          fontSize: 14,
          fontFamily: FONT.ui,
          fontWeight: '600',
          color: COLORS.textBright,
        }}
      >
        {title}
      </text>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
        {trailing != null ? <div style={{ marginRight: 8 }}>{trailing}</div> : null}
        <div
          tabIndex={0}
          testId="modal-close"
          onClick={onClose}
          onKeyDown={(e) => {
            if (e.key === 'enter' || e.key === 'space') onClose()
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 4,
            cursor: 'pointer',
            hover: { backgroundColor: COLORS.closeHover },
          }}
        >
          <Icon name="close" size={13} color={COLORS.muted} />
        </div>
      </div>
    </div>
  )
}

/** 弹窗主体（padding 统一） */
export function ModalBody({ children }: { children: ReactNode }) {
  return (
    <div
      testId="modal-body"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        paddingLeft: 16,
        paddingRight: 16,
        paddingBottom: 14,
        flexGrow: 1,
      }}
    >
      {children}
    </div>
  )
}

/** 主/次按钮对（对齐原型 dialog-actions：主按钮右侧） */
export function ModalActions({
  actions,
}: {
  actions: {
    label: string
    primary?: boolean
    danger?: boolean
    disabled?: boolean
    onClick: () => void
  }[]
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
        paddingTop: 10,
      }}
    >
      {actions.map((a) => (
        <div
          key={a.label}
          tabIndex={0}
          testId={`modal-action-${a.label}`}
          onClick={() => {
            if (!a.disabled) a.onClick()
          }}
          onKeyDown={(e) => {
            if ((e.key === 'enter' || e.key === 'space') && !a.disabled) a.onClick()
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 28,
            paddingLeft: 13,
            paddingRight: 13,
            borderRadius: 5,
            cursor: a.disabled ? 'default' : 'pointer',
            opacity: a.disabled ? 0.5 : 1,
            backgroundColor: a.primary ? COLORS.accent : a.danger ? COLORS.bell : COLORS.surface,
            borderWidth: a.primary || a.danger ? 0 : 1,
            borderColor: COLORS.borderSubtle,
            hover: a.disabled
              ? {}
              : {
                  backgroundColor: a.primary
                    ? COLORS.accentHover
                    : a.danger
                      ? '#e78c85'
                      : COLORS.surfaceHover,
                },
          }}
        >
          <text
            style={{
              fontSize: 12,
              fontFamily: FONT.ui,
              color: a.primary || a.danger ? '#ffffff' : COLORS.text,
              pointerEvents: 'none',
            }}
          >
            {a.label}
          </text>
        </div>
      ))}
    </div>
  )
}
