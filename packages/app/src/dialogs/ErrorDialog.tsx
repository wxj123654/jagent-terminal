/**
 * dialogs/ErrorDialog.tsx — 错误历史面板（方案 A；Modal 形态，对齐原型
 * renderErrorDialog）。
 *
 * 数据源 errors/bus 环形缓冲（新→旧）。行结构（原型 .err-item，~50px）：
 * level 大写标签（mono 10px 着色）+ msg 列（12px 摘要 + 10px area 小字）
 * + 右侧相对时间。点击行展开 detail（stack/链；原型无此交互，实现保留
 * 详情可读面）。清空 = clearErrors（原型 mini-btn：trash 图标 + 文字）。
 * body 固定 340px（原型 modal-body height:340px）。
 */

import { useEffect, useState } from 'react'

import { Icon, Modal, ModalHeading, COLORS, FONT } from '@jagent/ui'
import { clearErrors, listErrors, subscribeErrors, type AppError } from '../errors/bus'
import { relTime } from '../threads/workspaces'

const LEVEL_COLOR: Record<AppError['level'], string> = {
  fatal: COLORS.bell,
  error: COLORS.bell,
  warn: COLORS.amber,
}

export function ErrorDialog({ onClose }: { onClose: () => void }) {
  const [, bump] = useState(0)
  useEffect(() => subscribeErrors(() => bump((v) => v + 1)), [])
  const errors = listErrors()
  const [expanded, setExpanded] = useState<number | null>(null)
  // .mini-btn:hover 同时变色（muted→text）：svg tint 不继承父级 hover
  const [clearHover, setClearHover] = useState(false)

  return (
    <Modal width={520} onClose={onClose}>
      <ModalHeading
        title="错误历史"
        onClose={onClose}
        trailing={
          errors.length > 0 ? (
            // 原型 .mini-btn：trash 12 + 「清空」，无底色（hover 抬底+字色 text）
            <div
              testId="error-dialog-clear"
              tabIndex={0}
              onClick={clearErrors}
              onMouseEnter={() => setClearHover(true)}
              onMouseLeave={() => setClearHover(false)}
              onKeyDown={(e) => {
                if (e.key === 'enter') clearErrors()
              }}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                height: 22,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 5,
                cursor: 'pointer',
                hover: { backgroundColor: COLORS.surface },
              }}
            >
              <Icon name="trash" size={12} color={clearHover ? COLORS.text : COLORS.muted} />
              <text
                style={{
                  fontSize: 11,
                  fontFamily: FONT.ui,
                  color: clearHover ? COLORS.text : COLORS.muted,
                  pointerEvents: 'none',
                }}
              >
                清空
              </text>
            </div>
          ) : null
        }
      />
      {/* 原型 .modal-body 固定 340px（内容少不塌、多滚动） */}
      <div
        testId="modal-body"
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          height: 340,
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 14,
          paddingBottom: 18,
          overflowY: 'scroll',
          flexShrink: 0,
        }}
      >
        {errors.length === 0 ? (
          <div
            testId="error-dialog-empty"
            style={{
              flexGrow: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted }}>
              没有记录的错误。
            </text>
          </div>
        ) : (
          errors.map((e) => {
            const isOpen = expanded === e.id
            return (
              // 原型 .err-item：border 卡行（padding 8 10 / radius 6 /
              // gap 8 / 行间 6px）
              <div
                key={e.id}
                testId={`error-dialog-row-${e.id}`}
                tabIndex={0}
                onClick={() => setExpanded(isOpen ? null : e.id)}
                onKeyDown={(ev) => {
                  if (ev.key === 'enter') setExpanded(isOpen ? null : e.id)
                }}
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  gap: 8,
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: COLORS.border,
                  marginBottom: 6,
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                {/* level 大写标签（原型 .lv：mono 10px 着色，顶对齐 1px） */}
                <text
                  style={{
                    fontSize: 10,
                    fontFamily: FONT.mono,
                    color: LEVEL_COLOR[e.level],
                    flexShrink: 0,
                    marginTop: 1,
                    pointerEvents: 'none',
                  }}
                >
                  {e.level.toUpperCase()}
                </text>
                {/* msg 列（原型 .msg：12px 摘要 + 10px area 小字） */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    flexGrow: 1,
                    minWidth: 0,
                  }}
                >
                  <text
                    style={{
                      fontSize: 12,
                      fontFamily: FONT.ui,
                      color: COLORS.text,
                      whiteSpace: 'normal',
                      minWidth: 0,
                      pointerEvents: 'none',
                    }}
                  >
                    {e.message}
                  </text>
                  <text
                    style={{
                      fontSize: 10,
                      fontFamily: FONT.ui,
                      color: COLORS.faint,
                      marginTop: 2,
                      pointerEvents: 'none',
                    }}
                  >
                    {`${e.kind}${e.context ? ` · ${e.context}` : ''}`}
                  </text>
                  {isOpen && e.detail ? (
                    <text
                      style={{
                        fontSize: 10,
                        fontFamily: FONT.mono,
                        color: COLORS.text,
                        whiteSpace: 'normal',
                        marginTop: 4,
                        pointerEvents: 'none',
                      }}
                    >
                      {e.detail}
                    </text>
                  ) : null}
                </div>
                {/* 相对时间（原型 .tm：mono 10px faint 右侧） */}
                <text
                  style={{
                    fontSize: 10,
                    fontFamily: FONT.mono,
                    color: COLORS.faint,
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                  }}
                >
                  {relTime(e.at)}
                </text>
              </div>
            )
          })
        )}
      </div>
    </Modal>
  )
}
