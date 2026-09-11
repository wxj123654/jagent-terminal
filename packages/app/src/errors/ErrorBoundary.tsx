/**
 * errors/ErrorBoundary.tsx — 区域隔离（方案 A 第 3 组件）。
 *
 * 三层布防（docs/error-management.md）：
 * 1. App 根（area='root'）：最后防线，fallback = 全屏错误页 + 重试。
 * 2. ThreadPanel/Pane（area='pane'）：单个 surface 崩了只崩那格。
 * 3. Settings（area='settings'）。
 *
 * 重试 = attempt 递增 → Fragment key 变化 → 整棵子树强制重挂载（GPUIX
 * 下同样有效：react-reconciler 的 key 语义与宿主无关）。render 错误经
 * componentDidCatch 进总线（kind='render'），与 Toast/面板/落盘同链。
 *
 * class 组件：getDerivedStateFromError / componentDidCatch 是 React 核心
 * 机制，@gpuix/react（react-reconciler 宿主）完整支持。
 */

import { Component, Fragment, type ReactNode } from 'react'

import { COLORS, FONT } from '@jagent/ui'
import { emitError } from './bus'

type Props = {
  area: 'root' | 'pane' | 'settings'
  children: ReactNode
  /** 自定义 fallback（error + retry 回调）；缺省用内置样式 */
  fallback?: (error: Error, retry: () => void) => ReactNode
}

type State = { error: Error | null; attempt: number }

class ErrorBoundaryImpl extends Component<Props, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    emitError({
      level: 'error',
      kind: 'render',
      message: `界面渲染出错：${error.message}`,
      detail: [error.stack, info?.componentStack ? `componentStack:\n${info.componentStack}` : null]
        .filter(Boolean)
        .join('\n'),
      context: `boundary:${this.props.area}`,
    })
  }

  private retry = () => {
    this.setState({ error: null, attempt: this.state.attempt + 1 })
  }

  render() {
    const { error, attempt } = this.state
    if (error == null) {
      return <Fragment key={attempt}>{this.props.children}</Fragment>
    }
    const fb = this.props.fallback
    if (fb) return fb(error, this.retry)
    return this.props.area === 'root' ? (
      <RootFallback error={error} retry={this.retry} />
    ) : (
      <PaneFallback error={error} retry={this.retry} area={this.props.area} />
    )
  }
}

export const ErrorBoundary = ErrorBoundaryImpl

/** 根防线：全屏错误页（最后一级；此时 App 树已不可信）。 */
function RootFallback({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div
      testId="error-boundary-root"
      style={{
        flexGrow: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: COLORS.app,
        padding: 32,
      }}
    >
      <text style={{ fontSize: 16, fontFamily: FONT.ui, color: COLORS.bell, marginBottom: 12 }}>
        j-agent 遇到严重错误
      </text>
      <text
        style={{
          fontSize: 12,
          fontFamily: FONT.ui,
          color: COLORS.text,
          whiteSpace: 'normal',
          maxWidth: 480,
          marginBottom: 20,
        }}
      >
        {error.message}
      </text>
      <div
        testId="error-boundary-retry"
        tabIndex={0}
        onClick={retry}
        onKeyDown={(e) => {
          if (e.key === 'enter') retry()
        }}
        style={{
          paddingLeft: 14,
          paddingRight: 14,
          paddingTop: 6,
          paddingBottom: 6,
          borderRadius: 6,
          backgroundColor: COLORS.accent,
        }}
      >
        <text style={{ fontSize: 12, fontFamily: FONT.ui, color: '#fff' }}>重试</text>
      </div>
    </div>
  )
}

/** 区域防线：单格错误卡（其余界面继续工作）。 */
function PaneFallback({
  error,
  retry,
  area,
}: {
  error: Error
  retry: () => void
  area: 'pane' | 'settings'
}) {
  return (
    <div
      testId={`error-boundary-${area}`}
      style={{
        flexGrow: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: COLORS.pane,
        padding: 24,
      }}
    >
      <text style={{ fontSize: 13, fontFamily: FONT.ui, color: COLORS.bell, marginBottom: 8 }}>
        此区域渲染异常
      </text>
      <text
        style={{
          fontSize: 11,
          fontFamily: FONT.ui,
          color: COLORS.muted,
          whiteSpace: 'normal',
          maxWidth: 420,
          marginBottom: 16,
        }}
      >
        {error.message}
      </text>
      <div
        testId={`error-boundary-${area}-retry`}
        tabIndex={0}
        onClick={retry}
        onKeyDown={(e) => {
          if (e.key === 'enter') retry()
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
        }}
      >
        <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.textBright }}>重试</text>
      </div>
    </div>
  )
}
