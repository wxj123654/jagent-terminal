/**
 * plane/WorkPanel.tsx — 右侧工作面板（D5；原型 aside.panel）。
 *
 * 辅助 Git/文件面——不是第二内容区（终端始终在主区）：
 * - 「变更」tab：工作区变更文件表（M/A/D 徽章 + add/del 计数）+ 选中文件
 *   内联 unified diff（gpuix <diff>；未跟踪文件退回 <code> 预览）。
 * - 「文件」tab：选中文件预览（<code> 行号 + 语法高亮，512KB/400 行截断）。
 * - 左缘拖拽改宽（244–720，默认 280）；窗口 <1100px 时转绝对定位 overlay
 *   右贴（不压缩终端；原型同款）。关闭 → 焦点回工具栏面板钮（调用方管）。
 *
 * 数据面 = WorktreeStore（git/worktree.ts；真实 git status/diff，零原型假
 * 数据）。面板打开或手动刷新时 refresh()；选中态跨刷新保留（文件仍在则
 * 不清）。
 */

import { useState } from 'react'
import { useSyncExternalStore } from 'react'

import { Icon, COLORS, FONT } from '@jagent/ui'
import type { WorktreeFile } from '../git/cli'
import type { WorktreeStore } from '../git/worktree'
import { SIZES } from '../tokens'

export type WorkPanelTab = 'changes' | 'files'

/** diff/code 元素共用的 V2 色（GpuixTheme 层；底 = 面板 pane 色） */
const DIFF_THEME = {
  bg: COLORS.pane,
  text: COLORS.text,
  textMuted: COLORS.muted,
  border: COLORS.border,
  accent: COLORS.textBright,
  diffAdd: 'rgba(64,201,119,0.09)',
  diffDel: 'rgba(255,103,100,0.09)',
  diffHunkBg: 'rgba(255,255,255,0.03)',
} as const

/** 变更文件徽章色（原型 .badge-m/a/d） */
const BADGE: Record<WorktreeFile['status'], { label: string; color: string }> = {
  m: { label: 'M', color: COLORS.statusRunning },
  a: { label: 'A', color: COLORS.statusDone },
  d: { label: 'D', color: COLORS.statusError },
}

export function useWorktree<T>(
  store: WorktreeStore,
  select: (s: ReturnType<WorktreeStore['getState']>) => T,
): T {
  return useSyncExternalStore(
    (fn) => store.subscribe(fn),
    () => select(store.getState()),
    () => select(store.getState()),
  )
}

/** 面板 tab 钮（原型 .ptab：胶囊底 + on 态抬亮） */
function PanelTab({
  icon,
  label,
  active,
  testId,
  onClick,
}: {
  icon: 'gitBranch' | 'file'
  label: string
  active: boolean
  testId: string
  onClick: () => void
}) {
  return (
    <div
      tabIndex={0}
      testId={testId}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onClick()
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        height: 24,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 9999,
        backgroundColor: active ? COLORS.surfaceActive : 'transparent',
        cursor: 'pointer',
        hover: { backgroundColor: active ? COLORS.surfaceActive : COLORS.surface },
      }}
    >
      <Icon name={icon} size={11} color={active ? COLORS.textBright : COLORS.muted} />
      <text
        style={{
          fontSize: 11.5,
          fontFamily: FONT.ui,
          color: active ? COLORS.textBright : COLORS.muted,
          pointerEvents: 'none',
        }}
      >
        {label}
      </text>
    </div>
  )
}

/** 头部小图标钮（原型 .icon-btn 28px） */
function HeadButton({
  icon,
  testId,
  label: _label,
  onClick,
}: {
  icon: 'reset' | 'close'
  testId: string
  label: string
  onClick: () => void
}) {
  return (
    <div
      tabIndex={0}
      testId={testId}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onClick()
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 8,
        cursor: 'pointer',
        flexShrink: 0,
        hover: { backgroundColor: COLORS.surface },
      }}
    >
      <Icon name={icon} size={13} color={COLORS.muted} />
    </div>
  )
}

/** 变更文件行（原型 .file：grid 18 | 1fr | auto auto；hover 抬底） */
function FileRow({
  file,
  selected,
  onClick,
}: {
  file: WorktreeFile
  selected: boolean
  onClick: () => void
}) {
  const badge = BADGE[file.status]
  const slash = file.path.lastIndexOf('/')
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path
  const dir = slash >= 0 ? file.path.slice(0, slash) : ''
  return (
    <div
      tabIndex={0}
      testId={`panel-file-${file.path}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onClick()
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        height: 28,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 8,
        backgroundColor: selected ? COLORS.surfaceActive : 'transparent',
        cursor: 'pointer',
        hover: { backgroundColor: selected ? COLORS.surfaceActive : COLORS.surface },
      }}
    >
      <text
        style={{
          width: 18,
          fontSize: 10,
          fontFamily: FONT.mono,
          fontWeight: '700',
          color: badge.color,
          flexShrink: 0,
          pointerEvents: 'none',
        }}
      >
        {badge.label}
      </text>
      <text
        style={{
          flexGrow: 1,
          minWidth: 0,
          fontSize: 12,
          fontFamily: FONT.mono,
          color: selected ? COLORS.textBright : COLORS.text,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
          pointerEvents: 'none',
        }}
      >
        {name}
        {dir ? `  ${dir}` : ''}
      </text>
      {file.added != null ? (
        <text
          style={{
            fontSize: 10,
            fontFamily: FONT.mono,
            color: COLORS.statusDone,
            flexShrink: 0,
            pointerEvents: 'none',
          }}
        >
          +{file.added}
        </text>
      ) : null}
      {file.deleted != null ? (
        <text
          style={{
            fontSize: 10,
            fontFamily: FONT.mono,
            color: COLORS.statusError,
            flexShrink: 0,
            pointerEvents: 'none',
          }}
        >
          −{file.deleted}
        </text>
      ) : null}
    </div>
  )
}

function Hint({ text }: { text: string }) {
  return (
    <text
      style={{
        fontSize: 11.5,
        fontFamily: FONT.ui,
        color: COLORS.muted,
        padding: 12,
        whiteSpace: 'normal',
      }}
    >
      {text}
    </text>
  )
}

export function WorkPanel({
  worktree,
  width,
  overlay,
  overlayMaxWidth,
  tab,
  onTabChange,
  onClose,
  onWidthChange,
  windowWidth,
}: {
  worktree: WorktreeStore
  /** 正常模式宽（overlay 时被 clamp 到 overlayMaxWidth） */
  width: number
  /** <1100px 窗口：absolute 右贴覆盖（不压缩终端） */
  overlay: boolean
  overlayMaxWidth: number
  tab: WorkPanelTab
  onTabChange: (tab: WorkPanelTab) => void
  onClose: () => void
  /** 左缘拖拽实时回调（overlay 态不渲染把手） */
  onWidthChange?: (width: number) => void
  windowWidth: number
}) {
  const w = overlay ? Math.min(width, overlayMaxWidth) : width
  const [dragging, setDragging] = useState(false)
  const files = useWorktree(worktree, (s) => s.files)
  const status = useWorktree(worktree, (s) => s.status)
  const selected = useWorktree(worktree, (s) => s.selected)
  const diff = useWorktree(worktree, (s) => s.diff)
  const diffLoading = useWorktree(worktree, (s) => s.diffLoading)
  const preview = useWorktree(worktree, (s) => s.preview)
  const previewLoading = useWorktree(worktree, (s) => s.previewLoading)
  const root = useWorktree(worktree, (s) => s.root)

  const addedTotal = files.reduce((n, f) => n + (f.added ?? 0), 0)
  const deletedTotal = files.reduce((n, f) => n + (f.deleted ?? 0), 0)
  const selectedFile = files.find((f) => f.path === selected) ?? null

  return (
    <div
      testId="work-panel"
      style={{
        width: w,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        backgroundColor: COLORS.pane,
        borderLeftWidth: 1,
        borderColor: COLORS.border,
        ...(overlay
          ? {
              position: 'absolute' as const,
              top: 0,
              right: 0,
              bottom: 0,
              boxShadow: {
                offsetX: -12,
                offsetY: 0,
                blurRadius: 32,
                spreadRadius: 0,
                color: 'rgba(0,0,0,0.35)',
              },
            }
          : {}),
      }}
    >
      {/* 左缘拖拽把手（overlay 态不渲染——宽固定） */}
      {!overlay ? (
        <div
          testId="work-panel-resize"
          onMouseDown={(e) => {
            if (e.button === 0) setDragging(true)
          }}
          onMouseUp={() => setDragging(false)}
          onMouseLeave={() => setDragging(false)}
          onMouseMove={(e) => {
            if (!dragging || e.pressedButton !== 0) return
            const next = Math.round(
              Math.min(
                SIZES.panelWidthMax,
                Math.max(SIZES.panelWidthMin, windowWidth - (e.x ?? 0)),
              ),
            )
            onWidthChange?.(next)
          }}
          style={{
            position: 'absolute',
            left: -3,
            top: 0,
            bottom: 0,
            width: 6,
            cursor: 'col-resize',
            backgroundColor: 'transparent',
          }}
        />
      ) : null}

      {/* 面板头（原型 .panel-head 46px：ptabs + 关闭） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 2,
          height: 46,
          paddingLeft: 8,
          paddingRight: 8,
          borderBottomWidth: 1,
          borderColor: COLORS.border,
          flexShrink: 0,
        }}
      >
        <PanelTab
          icon="gitBranch"
          label="变更"
          testId="work-panel-tab-changes"
          active={tab === 'changes'}
          onClick={() => onTabChange('changes')}
        />
        <PanelTab
          icon="file"
          label="文件"
          testId="work-panel-tab-files"
          active={tab === 'files'}
          onClick={() => onTabChange('files')}
        />
        <div style={{ flexGrow: 1 }} />
        <HeadButton
          icon="reset"
          testId="work-panel-refresh"
          label="刷新"
          onClick={() => worktree.refresh()}
        />
        <HeadButton icon="close" testId="work-panel-close" label="关闭面板" onClick={onClose} />
      </div>

      {/* 面板体 */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          minHeight: 0,
          overflowY: 'scroll',
          padding: 6,
        }}
      >
        {status === 'not-a-repo' ? (
          <Hint text="当前目录不是 Git 仓库。" />
        ) : status === 'error' ? (
          <Hint text="读取 Git 状态失败。" />
        ) : tab === 'changes' ? (
          <>
            {/* 汇总行（原型 .pv-h：标题 + n 文件 +add −del） */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingLeft: 6,
                paddingTop: 4,
                paddingBottom: 8,
              }}
            >
              <text
                style={{
                  fontSize: 11.5,
                  fontFamily: FONT.ui,
                  fontWeight: '500',
                  color: COLORS.muted,
                  pointerEvents: 'none',
                }}
              >
                工作区变更
              </text>
              <div style={{ flexGrow: 1 }} />
              <text
                style={{
                  fontSize: 10.5,
                  fontFamily: FONT.mono,
                  color: COLORS.faint,
                  pointerEvents: 'none',
                }}
              >
                {files.length} 个文件 +{addedTotal} −{deletedTotal}
              </text>
            </div>
            {files.length === 0 ? (
              <Hint text={status === 'loading' ? '读取中…' : '工作区干净，没有变更。'} />
            ) : (
              files.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  selected={f.path === selected}
                  onClick={() => worktree.select(f.path)}
                />
              ))
            )}
            {/* 选中文件内联 diff（原型 .pdiff 区） */}
            {selectedFile ? (
              <div style={{ marginTop: 6, flexShrink: 0 }}>
                {diffLoading ? (
                  <Hint text="加载 diff…" />
                ) : diff ? (
                  <diff
                    patch={diff}
                    wordDiff
                    maxLines={400}
                    theme={DIFF_THEME}
                    style={{
                      fontSize: 11,
                      fontFamily: FONT.mono,
                      borderTopWidth: 1,
                      borderColor: COLORS.border,
                      paddingTop: 6,
                    }}
                  />
                ) : (
                  <Hint text="未跟踪文件——无 diff，在「文件」页查看内容。" />
                )}
              </div>
            ) : null}
          </>
        ) : (
          /* 文件 tab：选中文件预览 */
          <>
            {selectedFile ? (
              <>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingLeft: 6,
                    paddingTop: 4,
                    paddingBottom: 8,
                    minWidth: 0,
                  }}
                >
                  <Icon name="file" size={11} color={COLORS.muted} />
                  <text
                    style={{
                      fontSize: 11,
                      fontFamily: FONT.mono,
                      color: COLORS.muted,
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                      overflow: 'hidden',
                      pointerEvents: 'none',
                    }}
                  >
                    {selectedFile.path}
                  </text>
                </div>
                {previewLoading ? (
                  <Hint text="读取中…" />
                ) : preview != null ? (
                  <code
                    code={preview}
                    path={root ? `${root}/${selectedFile.path}` : selectedFile.path}
                    showLineNumbers
                    theme={DIFF_THEME}
                    style={{ fontSize: 11, fontFamily: FONT.mono }}
                  />
                ) : (
                  <Hint text="文件无法预览（二进制或超过 512KB）。" />
                )}
              </>
            ) : (
              <Hint text="在「变更」页选择一个文件查看预览。" />
            )}
          </>
        )}
      </div>
    </div>
  )
}
