/**
 * plane/CrashDialog.tsx — 上次会话崩溃提示（方案 C 启动横幅）。
 *
 * 启动时 crash.json 存在 → 自动弹出（DialogState kind='crash'）：原因/
 * 位置/版本/时间 + 「打开崩溃目录」（openInSystemApp）+ 「知道了」（删
 * crash.json 关闭；dump 文件保留供复盘）。
 */

import { Modal, ModalBody, ModalHeading, COLORS, FONT } from '@jagent/ui'
import { CRASH_DIR, dismissLastCrash, type LastCrash } from '../errors/crashReport'
import { openInSystemApp } from '../settings/file'

function timeLabel(at?: number): string {
  if (!at) return '未知'
  return new Date(at).toLocaleString()
}

export function CrashDialog({ last, onClose }: { last: LastCrash; onClose: () => void }) {
  const dismiss = () => {
    dismissLastCrash()
    onClose()
  }
  return (
    <Modal width={480} height={260} onClose={dismiss}>
      <ModalHeading title="上次会话异常退出" onClose={dismiss} />
      <ModalBody>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
          <text
            style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.textBright, marginBottom: 8 }}
          >
            {last.kind === 'panic'
              ? `原生层异常：${last.message || '（无消息）'}`
              : '原生崩溃（信号/异常访问）'}
          </text>
          <text
            style={{
              fontSize: 11,
              fontFamily: FONT.mono,
              color: COLORS.muted,
              whiteSpace: 'normal',
            }}
          >
            {[
              last.location ? `位置：${last.location}` : null,
              last.thread ? `线程：${last.thread}` : null,
              `时间：${timeLabel(last.at)}`,
              last.appVersion ? `版本：${last.appVersion}` : null,
              last.dumpPath ? '转储与日志：~/.j-agent/crashes' : null,
            ]
              .filter(Boolean)
              .join('\n')}
          </text>
          <div style={{ display: 'flex', flexDirection: 'row', marginTop: 16 }}>
            {last.dumpPath ? (
              <div
                testId="crash-dialog-open-dir"
                tabIndex={0}
                onClick={() => void openInSystemApp(CRASH_DIR)}
                onKeyDown={(e) => {
                  if (e.key === 'enter') void openInSystemApp(CRASH_DIR)
                }}
                style={{
                  paddingLeft: 12,
                  paddingRight: 12,
                  paddingTop: 5,
                  paddingBottom: 5,
                  borderRadius: 6,
                  backgroundColor: COLORS.surface,
                  borderWidth: 1,
                  borderColor: COLORS.borderSubtle,
                  marginRight: 8,
                }}
              >
                <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.text }}>
                  打开崩溃目录
                </text>
              </div>
            ) : null}
            <div
              testId="crash-dialog-dismiss"
              tabIndex={0}
              onClick={dismiss}
              onKeyDown={(e) => {
                if (e.key === 'enter') dismiss()
              }}
              style={{
                paddingLeft: 12,
                paddingRight: 12,
                paddingTop: 5,
                paddingBottom: 5,
                borderRadius: 6,
                backgroundColor: COLORS.accent,
              }}
            >
              <text style={{ fontSize: 12, fontFamily: FONT.ui, color: '#fff' }}>知道了</text>
            </div>
          </div>
        </div>
      </ModalBody>
    </Modal>
  )
}
