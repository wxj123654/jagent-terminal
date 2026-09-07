/**
 * plane/ErrorDialog.tsx — 错误历史面板（方案 A；Modal 形态，对齐 SearchDialog）。
 *
 * 数据源 errors/bus 环形缓冲（新→旧）：level 色点（fatal/error 红、warn
 * 琥珀）+ kind 徽章 + 一行摘要；点击行展开 detail（stack/链）。清空 =
 * clearErrors。打开入口：TitleBar ErrorIndicator。
 */

import { useEffect, useState } from 'react'

import { clearErrors, listErrors, subscribeErrors, type AppError } from '../errors/bus'
import { Modal, ModalBody, ModalHeading } from '../ui/Modal'
import { COLORS, FONT } from '../ui/tokens'

const LEVEL_COLOR: Record<AppError['level'], string> = {
  fatal: COLORS.bell,
  error: COLORS.bell,
  warn: COLORS.amber,
}

const LEVEL_LABEL: Record<AppError['level'], string> = {
  fatal: '致命',
  error: '错误',
  warn: '警告',
}

function timeLabel(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => `${n}`.padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function ErrorDialog({ onClose }: { onClose: () => void }) {
  const [, bump] = useState(0)
  useEffect(() => subscribeErrors(() => bump((v) => v + 1)), [])
  const errors = listErrors()
  const [expanded, setExpanded] = useState<number | null>(null)

  return (
    <Modal width={520} height={400} onClose={onClose}>
      <ModalHeading
        title="错误历史"
        onClose={onClose}
        trailing={
          errors.length > 0 ? (
            <div
              testId="error-dialog-clear"
              tabIndex={0}
              onClick={clearErrors}
              onKeyDown={(e) => {
                if (e.key === 'enter') clearErrors()
              }}
              style={{
                paddingLeft: 10,
                paddingRight: 10,
                paddingTop: 4,
                paddingBottom: 4,
                borderRadius: 6,
                backgroundColor: COLORS.surface,
                borderWidth: 1,
                borderColor: COLORS.borderSubtle,
              }}
            >
              <text style={{ fontSize: 11, fontFamily: FONT.ui, color: COLORS.text }}>清空</text>
            </div>
          ) : null
        }
      />
      <ModalBody>
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
              没有记录的错误
            </text>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {errors.map((e) => {
              const isOpen = expanded === e.id
              return (
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
                    flexDirection: 'column',
                    paddingTop: 6,
                    paddingBottom: 6,
                    paddingLeft: 10,
                    paddingRight: 10,
                    borderRadius: 6,
                    backgroundColor: isOpen ? COLORS.surface : 'transparent',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: LEVEL_COLOR[e.level],
                        marginRight: 8,
                      }}
                    />
                    <text
                      style={{ fontSize: 10, fontFamily: FONT.ui, color: COLORS.muted, width: 64 }}
                    >
                      {timeLabel(e.at)}
                    </text>
                    <text
                      style={{
                        fontSize: 10,
                        fontFamily: FONT.ui,
                        color: LEVEL_COLOR[e.level],
                        width: 36,
                      }}
                    >
                      {LEVEL_LABEL[e.level]}
                    </text>
                    <text
                      style={{
                        fontSize: 11,
                        fontFamily: FONT.ui,
                        color: COLORS.textBright,
                        minWidth: 0,
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis',
                        flexGrow: 1,
                      }}
                    >
                      {e.message}
                    </text>
                  </div>
                  {isOpen ? (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        paddingLeft: 16,
                        paddingTop: 4,
                      }}
                    >
                      <text style={{ fontSize: 10, fontFamily: FONT.ui, color: COLORS.muted }}>
                        {`类型 ${e.kind}${e.context ? ` · ${e.context}` : ''}`}
                      </text>
                      {e.detail ? (
                        <text
                          style={{
                            fontSize: 10,
                            fontFamily: FONT.mono,
                            color: COLORS.text,
                            whiteSpace: 'normal',
                          }}
                        >
                          {e.detail}
                        </text>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </ModalBody>
    </Modal>
  )
}
