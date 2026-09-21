/**
 * dialogs/CrashDialog.tsx — 上次会话崩溃提示（方案 C 启动横幅）。
 *
 * 启动时 crash.json 存在 → 自动弹出（DialogState kind='crash'）。布局对齐
 * 原型：480 宽卡 + 200px body——标题行（真实异常消息）+ meta 行（位置/
 * 线程/时间/版本，mono faint）+ 说明行 + .crash-path 路径盒（crash.json
 * 与 dump 真实路径）+ ModalActions「打开目录 / 知道了」（后者删
 * crash.json 关闭；dump 文件保留供复盘）。
 */

import { Modal, ModalActions, ModalHeading, COLORS, FONT } from '@jagent/ui'
import { crashDir, dismissLastCrash, lastCrashPath, type LastCrash } from '../errors/crashReport'
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
  const meta = [
    last.location ? `位置 ${last.location}` : null,
    last.thread ? `线程 ${last.thread}` : null,
    last.at ? `时间 ${timeLabel(last.at)}` : null,
    last.appVersion ? `版本 ${last.appVersion}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    // 原型：480 宽、内容自适应——head 44 + body 200 + 2 边框 = 246
    <Modal width={480} onClose={dismiss}>
      <ModalHeading title="上次会话异常退出" onClose={dismiss} />
      {/* 原型 .modal-body 固定 200px */}
      <div
        testId="modal-body"
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: 200,
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 14,
          paddingBottom: 18,
          overflowY: 'scroll',
          flexShrink: 0,
        }}
      >
        <text
          style={{
            fontSize: 12,
            fontFamily: FONT.ui,
            color: COLORS.textBright,
            marginBottom: 8,
            whiteSpace: 'normal',
          }}
        >
          {last.kind === 'panic'
            ? `j-agent 上次运行时发生了异常退出（panic）：${last.message || '（无消息）'}`
            : 'j-agent 上次运行时发生了异常退出（原生崩溃）。'}
        </text>
        {meta ? (
          <text
            style={{
              fontSize: 11,
              fontFamily: FONT.mono,
              color: COLORS.faint,
              marginBottom: 8,
              whiteSpace: 'normal',
            }}
          >
            {meta}
          </text>
        ) : null}
        <text
          style={{
            fontSize: 12,
            fontFamily: FONT.ui,
            color: COLORS.muted,
            whiteSpace: 'normal',
          }}
        >
          崩溃报告已写入本地目录，可提交 issue 时附上：
        </text>
        {/* 原型 .crash-path：mono 11 faint + inputBg 底 + r4 + pad 6 8 + mt8 */}
        <text
          testId="crash-dialog-path"
          style={{
            fontSize: 11,
            fontFamily: FONT.mono,
            color: COLORS.faint,
            backgroundColor: COLORS.inputBg,
            borderRadius: 4,
            paddingLeft: 8,
            paddingRight: 8,
            paddingTop: 6,
            paddingBottom: 6,
            marginTop: 8,
            whiteSpace: 'normal',
          }}
        >
          {last.dumpPath ? `${lastCrashPath()}\n${last.dumpPath}` : lastCrashPath()}
        </text>
        <ModalActions
          actions={[
            {
              label: '打开目录',
              onClick: () => void openInSystemApp(crashDir()),
            },
            { label: '知道了', primary: true, onClick: dismiss },
          ]}
        />
      </div>
    </Modal>
  )
}
