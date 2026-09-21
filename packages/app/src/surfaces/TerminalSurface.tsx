/**
 * TerminalSurface — 全项目唯一 `<terminal>` 写点（硬约束 2；architecture.md §4）。
 *
 * props = sessionId + 外观；spawn 参数走 createTerminalSession（经
 * ThreadStore.spawnFromPreset）。外层 div：padding 0、无 overflow 包裹、
 * 不设背景色——terminal 用自己的 palette（布局契约 §5.1 C1 无 chrome）。
 *
 * T2.5：外观读 settings.terminal（fontFamily/fontSize/palette/cursorBlink）
 * ——设置变化 → useSettings 重渲染 → setCustomProp → model.set_style
 * （幂等）→ sync_style 调和，无需重建会话。scrollbackLines 属 spawn 参数
 * （nativeDeps 兑底），不在这里。focused prop：挂载即请求焦点（T1.6）。
 */

import { COLORS, FONT } from '@jagent/ui'
import { useSettings } from '../settings/useSettings'
import type { ShellView, TerminalThread } from '../threads/store'
import type { SurfaceProps } from './registry'

// ── `<terminal>` JSX 类型声明（GPUIX jsx-runtime 的 augmentation）──────

export interface TerminalElementProps {
  /** 绑定池中会话（必需；architecture.md §2.4） */
  sessionId: number
  /** 外观 props：设置变化 → 重渲染 → setCustomProp → model.set_style */
  fontFamily?: string
  fontSize?: number
  cursorBlink?: boolean
  palette?: string
  /** activate 后请求焦点 */
  focused?: boolean
  onFocus?: (e: { sessionId: number }) => void
  onBlur?: (e: { sessionId: number }) => void
  key?: string | number
}

declare module '@gpuix/react/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      terminal: TerminalElementProps
    }
  }
}

export function TerminalSurface({ thread, settings }: SurfaceProps) {
  const t = thread as TerminalThread
  return <TerminalView sessionId={t.sessionId} settings={settings} />
}

/**
 * 会话内 shell 视图（SessionView kind='shell'；原型 SessionShell）——
 * 绑独立 PTY（view.sessionId，非 thread.sessionId）。与 TerminalSurface
 * 共享 TerminalView：`<terminal>` 仍只有本文件一个写点（硬约束 2）。
 * 视图 PTY 退出（view.status==='exited'）→ 底部退出条（原型 .exited-bar：
 * 「[进程已退出 · exit code N]」弱化文字；残留输出由池内会话网格保留）。
 */
export function SessionTerminal({
  view,
  settings,
}: {
  view: ShellView
  settings: SurfaceProps['settings']
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <TerminalView sessionId={view.sessionId} settings={settings} />
      {view.status === 'exited' ? (
        <div
          testId="session-exited-bar"
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            height: 26,
            flexShrink: 0,
            paddingLeft: 10,
            paddingRight: 10,
            borderTopWidth: 1,
            borderColor: COLORS.border,
            backgroundColor: COLORS.pane,
          }}
        >
          <text
            style={{
              fontFamily: FONT.mono,
              fontSize: 11,
              color: COLORS.exited,
              pointerEvents: 'none',
            }}
          >
            {`[进程已退出${view.exitCode != null ? ` · exit code ${view.exitCode}` : ''}]`}
          </text>
        </div>
      ) : null}
    </div>
  )
}

/** sessionId + 外观 → `<terminal>` 元素（唯一写点） */
function TerminalView({
  sessionId,
  settings,
}: {
  sessionId: number
  settings: SurfaceProps['settings']
}) {
  const term = useSettings(settings).terminal
  // flexGrow + minWidth/minHeight：主轴吃满剩余、交叉轴 stretch——
  // 主面（workbench 行内）与会话内视图（SessionTerminal 列内 + 退出条
  // 兄弟节点）两种父布局下尺寸都正确；不写死 100% 防兄弟节点溢出。
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        flexGrow: 1,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <terminal
        sessionId={sessionId}
        fontFamily={term.fontFamily}
        fontSize={term.fontSize}
        palette={term.palette}
        cursorBlink={term.cursorBlink}
        focused
      />
    </div>
  )
}
