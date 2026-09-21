/**
 * git/components/WorkPanel.tsx — 右侧工作面板（原型 #work-panel + .wp-*）。
 *
 * 辅助 Git/文件面——不是第二内容区（终端始终在主区）：
 * - 「变更」tab：工作区变更文件表（M/A/D 徽章 + add/del 计数）+ 选中文件
 *   内联 unified diff（原型 .diff：扁平着色行，无 gutter——280px 窄面板
 *   放不下原生 <diff> 的双行号列；行着色 = 背景洗色 + 文字色）。
 * - 「文件」tab：同一文件表（文件图标行，无徽章/计数）+ 选中文件预览
 *   （.code-view 行号列，与 FileSurface 同款手动行；512KB/400 行截断）。
 * - 左缘拖拽改宽（244–720，默认 280）；窗口 <1100px 时转绝对定位 overlay
 *   右贴（不压缩终端；原型同款）。关闭 → 焦点回工具栏面板钮（调用方管）。
 *
 * 数据面 = WorktreeStore（git/worktree.ts；真实 git status/diff，零原型假
 * 数据）。面板打开或手动刷新时 refresh()；选中态跨刷新保留（文件仍在则
 * 不清）。selected 单字段同时喂 diff 与 preview（原型同款）。
 */

import { useState } from 'react'

import { Icon, IconButton, COLORS, FONT, toast } from '@jagent/ui'
import { SIZES } from '../../tokens'
import type { WorktreeFile } from '../types'
import { useWorktree } from '../useWorktree'
import type { WorktreeStore } from '../worktree'

export type WorkPanelTab = 'changes' | 'files'

/** 变更文件徽章色（原型 .file-row .bdg：M 琥珀 / A 绿 / D 红） */
const BADGE: Record<WorktreeFile['status'], { label: string; color: string }> = {
  m: { label: 'M', color: COLORS.statusRunning },
  a: { label: 'A', color: COLORS.statusDone },
  d: { label: 'D', color: COLORS.statusError },
}

/** diff 行着色（原型 .dl.add/.del/.hunk：12% 洗色底 + 类目文字色） */
const DIFF_STYLE: Record<string, { bg?: string; color: string }> = {
  add: { bg: 'rgba(152,195,121,0.12)', color: COLORS.terminalKind },
  del: { bg: 'rgba(224,108,117,0.12)', color: COLORS.statusError },
  hunk: { bg: COLORS.tile, color: COLORS.cyan },
  meta: { color: COLORS.muted },
  ctx: { color: COLORS.text },
}

/** 面板 tab 钮（原型 .ptab：28px r8；active = surface 底 + borderSubtle 边 + 浅阴影） */
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
        height: 28,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: active ? COLORS.borderSubtle : 'transparent',
        backgroundColor: active ? COLORS.surface : 'transparent',
        boxShadow: active
          ? { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: 'rgba(0,0,0,0.2)' }
          : undefined,
        cursor: 'pointer',
        hover: { backgroundColor: COLORS.surface },
      }}
    >
      <Icon name={icon} size={12} color={active ? COLORS.textBright : COLORS.muted} />
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

function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/')
  return slash >= 0
    ? { dir: path.slice(0, slash), name: path.slice(slash + 1) }
    : { dir: '', name: path }
}

/** 文件名 + 目录尾（原型 .nm 内嵌 .dir 段：name 提亮 / dir muted） */
function FileName({ path, selected }: { path: string; selected: boolean }) {
  const { dir, name } = splitPath(path)
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        flexGrow: 1,
        minWidth: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <text
        style={{
          flexShrink: 1,
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
      </text>
      {dir ? (
        <text
          style={{
            flexShrink: 1,
            minWidth: 0,
            fontSize: 12,
            fontFamily: FONT.mono,
            color: COLORS.muted,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {`  ${dir}`}
        </text>
      ) : null}
    </div>
  )
}

const ROW_STYLE = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  gap: 7,
  height: 32,
  paddingLeft: 10,
  paddingRight: 10,
  borderRadius: 8,
  cursor: 'pointer',
  flexShrink: 0,
} as const

/** 变更文件行（原型 .file-row 变更形态：M/A/D 徽章 + add/del 计数） */
function ChangeRow({
  file,
  selected,
  onClick,
}: {
  file: WorktreeFile
  selected: boolean
  onClick: () => void
}) {
  const badge = BADGE[file.status]
  return (
    <div
      tabIndex={0}
      testId={`panel-file-${file.path}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onClick()
      }}
      style={{
        ...ROW_STYLE,
        backgroundColor: selected ? COLORS.surfaceActive : 'transparent',
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
      <FileName path={file.path} selected={selected} />
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
          {`+${file.added}`}
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
          {`−${file.deleted}`}
        </text>
      ) : null}
    </div>
  )
}

/** 文件行（原型 .file-row 文件形态：file 图标占徽章位，无 add/del 计数） */
function FileRow({
  file,
  selected,
  onClick,
}: {
  file: WorktreeFile
  selected: boolean
  onClick: () => void
}) {
  return (
    <div
      tabIndex={0}
      testId={`panel-file-${file.path}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onClick()
      }}
      style={{
        ...ROW_STYLE,
        backgroundColor: selected ? COLORS.surfaceActive : 'transparent',
        hover: { backgroundColor: selected ? COLORS.surfaceActive : COLORS.surface },
      }}
    >
      <div style={{ width: 18, flexShrink: 0, pointerEvents: 'none' }}>
        <Icon name="file" size={12} color={COLORS.muted} />
      </div>
      <FileName path={file.path} selected={selected} />
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

/** 行类目（与原型同序判定：`---`/`+++` 头行落 del/add 色是原型固有特征） */
function diffLineKind(l: string): keyof typeof DIFF_STYLE {
  if (l.startsWith('@@')) return 'hunk'
  if (l.startsWith('+')) return 'add'
  if (l.startsWith('-')) return 'del'
  if (l.startsWith('diff') || l.startsWith('index')) return 'meta'
  return 'ctx'
}

/**
 * 内联 diff（原型 .diff/.dl：mt6 + 顶分隔线 + pt6；mono 11 lh1.5 扁平行，
 * 行 pad 0 8）。横向溢出经 row 视口滚动（GPUIX overflowX 只在 row 容器
 * 生效）；行 minWidth:'100%' 保证短行洗色也铺满面宽。
 */
function DiffBlock({ patch, width }: { patch: string; width: number }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        overflowX: 'scroll',
        flexShrink: 0,
        maxWidth: '100%',
        marginTop: 6,
        borderTopWidth: 1,
        borderColor: COLORS.border,
        paddingTop: 6,
        fontFamily: FONT.mono,
        fontSize: 11,
        lineHeight: 16.5,
      }}
    >
      {/* minWidth = 面板内容宽：短行洗色铺满整宽；长行把列撑宽走 x 滚动 */}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: width }}>
        {patch.split('\n').map((l, i) => {
          const s = DIFF_STYLE[diffLineKind(l)]
          return (
            <div
              key={i}
              style={{
                paddingLeft: 8,
                paddingRight: 8,
                ...(s.bg ? { backgroundColor: s.bg } : {}),
              }}
            >
              <text style={{ color: s.color, whiteSpace: 'nowrap' }}>{l || ' '}</text>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * 文件预览（原型 .code-view/.cl/.ln-no：mono 11 lh1.55→17px；行号 34px
 * 右对齐 pr10 muted）。FileSurface 同款手动行——预览不是编辑器。
 */
function Preview({ code, width }: { code: string; width: number }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        overflowX: 'scroll',
        flexShrink: 0,
        fontFamily: FONT.mono,
        fontSize: 11,
        lineHeight: 17,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: width }}>
        {code.split('\n').map((l, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'row' }}>
            <text
              style={{
                width: 34,
                flexShrink: 0,
                textAlign: 'right',
                paddingRight: 10,
                color: COLORS.muted,
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
              }}
            >
              {String(i + 1)}
            </text>
            <text style={{ color: COLORS.text, whiteSpace: 'nowrap' }}>{l || ' '}</text>
          </div>
        ))}
      </div>
    </div>
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
  // wp-body 内容宽：w(border-box) − 左缘 1px 边线 − padding 6×2
  const bodyW = w - 13
  const [dragging, setDragging] = useState(false)
  const files = useWorktree(worktree, (s) => s.files)
  const status = useWorktree(worktree, (s) => s.status)
  const selected = useWorktree(worktree, (s) => s.selected)
  const diff = useWorktree(worktree, (s) => s.diff)
  const diffLoading = useWorktree(worktree, (s) => s.diffLoading)
  const preview = useWorktree(worktree, (s) => s.preview)
  const previewLoading = useWorktree(worktree, (s) => s.previewLoading)

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
        position: 'relative',
        backgroundColor: COLORS.sidebar,
        borderLeftWidth: 1,
        borderColor: COLORS.borderSubtle,
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
      {/* 左缘拖拽把手（overlay 态不渲染——宽固定）。
          mouseDown+mouseMove → renderer 自动 capture_pointer，拖出把手
          不中断（侧栏右缘把手同款）。 */}
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

      {/* 面板头（原型 .wp-head 44px：ptabs + 刷新 + 关闭） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 2,
          height: 44,
          paddingLeft: 8,
          paddingRight: 8,
          borderBottomWidth: 1,
          borderColor: COLORS.borderSubtle,
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
        {/* 原型 .hbtn 28² + title 提示 → IconButton（hitSize 28 + Tip 文案） */}
        <IconButton
          name="reset"
          label="刷新"
          testId="work-panel-refresh"
          size={16}
          hitSize={28}
          radius={8}
          onClick={() => {
            worktree.refresh()
            toast('已刷新工作区状态')
          }}
        />
        <IconButton
          name="close"
          label="关闭面板"
          testId="work-panel-close"
          size={16}
          hitSize={28}
          radius={8}
          onClick={onClose}
        />
      </div>

      {/* 面板体（原型 .wp-body：pad 6 单列滚动） */}
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
        {status === 'idle' ? (
          <Hint text="当前没有打开的工作区。" />
        ) : status === 'not-a-repo' ? (
          <Hint text="当前目录不是 Git 仓库。" />
        ) : status === 'error' ? (
          <Hint text="读取 Git 状态失败。" />
        ) : tab === 'changes' ? (
          <>
            {/* 汇总行（原型 .wp-sum：标题 + n 文件 +add −del） */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingLeft: 6,
                paddingRight: 6,
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
                {`${files.length} 个文件 +${addedTotal} −${deletedTotal}`}
              </text>
            </div>
            {files.length === 0 ? (
              <Hint text={status === 'loading' ? '读取中…' : '工作区干净，没有变更。'} />
            ) : (
              files.map((f) => (
                <ChangeRow
                  key={f.path}
                  file={f}
                  selected={f.path === selected}
                  onClick={() => worktree.select(f.path)}
                />
              ))
            )}
            {/* 选中文件内联 diff（原型 .diff 区） */}
            {selectedFile ? (
              diffLoading ? (
                <Hint text="加载 diff…" />
              ) : diff ? (
                <DiffBlock patch={diff} width={bodyW} />
              ) : (
                <Hint text="未跟踪文件——无 diff，在「文件」页查看内容。" />
              )
            ) : null}
          </>
        ) : (
          /* 文件 tab：同一文件表（图标行）+ 选中文件预览 */
          <>
            {files.length === 0 ? (
              <Hint text={status === 'loading' ? '读取中…' : '工作区没有文件。'} />
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
            {selectedFile ? (
              <>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingLeft: 6,
                    paddingRight: 6,
                    paddingTop: 4,
                    paddingBottom: 8,
                    minWidth: 0,
                  }}
                >
                  <Icon name="file" size={12} color={COLORS.muted} />
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
                  <Preview code={preview} width={bodyW} />
                ) : (
                  <Hint text="文件无法预览（二进制或超过 512KB）。" />
                )}
              </>
            ) : (
              <Hint text="选择一个文件查看内容。" />
            )}
          </>
        )}
      </div>
    </div>
  )
}
