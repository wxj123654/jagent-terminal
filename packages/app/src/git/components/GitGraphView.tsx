/**
 * git/components/GitGraphView.tsx — Git 图表面（R6：React 原型
 * design/prototype-react GitGraphView 为唯一视觉/交互基准；git-graph-v2.md
 * 的 vgg 形态已被取代——mute 淡化、CDV 穿线、文件树/统计、Commit/Parents/
 * Committer 元数据行均不按原型，已移除）。
 *
 * 工具条（仓库名 / 分支下拉 / 远程开关 / n 提交 / find / fetch / refresh）
 * + 表头列 + 虚拟化提交列表。选中行下方插入独立 CDV 卡片行（virtual-list
 * 定高模型不能把同一行撑开；卡片盖住 lane 列——原型不画穿线）。
 * 右键走 onAuxClick + <anchored> 菜单；git actions 经 store.runAction。
 */

import { useGpuix, useWindowSize } from '@gpuix/react'
import type { PublicInstance } from '@gpuix/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  Icon,
  IconButton,
  Modal,
  ModalActions,
  ModalBody,
  ModalHeading,
  Popover,
  TextInput,
  toast,
  Toggle,
  COLORS,
  FONT,
} from '@jagent/ui'
import { GRAPH_LANE_COLORS, SIZES } from '../../tokens'
import type { GitMenuEntry, GitMenuItem } from '../actions'
import { commitMenu, createGitCommands, refMenu } from '../commands'
import { parseRefNames, relativeTime, type RefDecor } from '../format'
import type { GraphRow } from '../graph'
import {
  buildRowGraphics,
  graphColumnWidth,
  ROW_HEIGHT,
  COL_AUTHOR,
  COL_DATE,
  COL_SHA,
} from '../graphSvg'
import { buildRowColumns, type RowSpec } from '../rowColumns'
import type { ChangedFile } from '../types'

// ── `<git-graph-row>` JSX 类型声明（GPUIX jsx-runtime 的 augmentation，
// 同 TerminalSurface 模式；元素本体在 packages/native/src/git_graph.rs）──

export interface GitGraphRowElementProps {
  /** 行文本列规格（useMemo 稳定引用：GPUIX 按引用 diff custom props） */
  row: RowSpec
  /** 布局/命中透明（setStyle 对一切元素生效；pe:none 让行点击穿透到行容器） */
  style?: import('@gpuix/react').StyleDesc
  key?: string | number
}

declare module '@gpuix/react/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      'git-graph-row': GitGraphRowElementProps
    }
  }
}
import type { GitGraphStore } from '../store'
import { useGitGraphStore } from '../useGitGraphStore'

// 原型第二段实测：工具条 42 / 表头 30 / 行 30 / 错误条 33 / CDV 卡 218+margin
const TOOLBAR_H = 42
const HEADER_H = 30
const ERROR_H = 33
const CDV_H = 218
const CDV_SLOT_H = CDV_H + 8 + 10 // margin 8 上 + 10 下（原型 .git-cdv margin:8px 10px 10px）
/** 原型 .cdv-meta .k = 82px */
const CDV_LABEL_W = 82
/** 会话内视图标签条高（pane 内容区在 topChrome 之下，列表高需扣除） */
const TAB_H = 30
/** 原型 .git-toolbar 底色（sidebar 42% 透明压 pane） */
const TOOLBAR_BG = 'rgba(32, 36, 43, 0.42)'
/** 原型 .git-header 底色（第二段字面量 #1a1d22，非 token 变量） */
const HEADER_BG = '#1a1d22'
/** 原型 .git-row 底部分隔线 */
const ROW_SEPARATOR = 'rgba(255, 255, 255, 0.025)'
/** 原型 .git-err 底色 */
const ERROR_BG = 'rgba(224, 108, 117, 0.08)'
/** 原型浮层 chrome（.ctx-menu/.branch-pop 第二段）：r12 + 0 14 38 阴影 */
const POP_SHADOW = {
  offsetX: 0,
  offsetY: 14,
  blurRadius: 38,
  spreadRadius: 0,
  color: 'rgba(0,0,0,0.5)',
}

type MenuState = {
  x: number
  y: number
  title: string
  items: GitMenuEntry[]
  at?: string
}

type ConfirmState = { title: string; argv: string[] }
type PromptState = { item: GitMenuItem; at?: string }

function RefBadges({
  decors,
  showRemote,
  onAux,
  onSelect,
}: {
  decors: RefDecor[]
  showRemote: boolean
  onAux: (d: RefDecor, e: { x?: number; y?: number }) => void
  onSelect: () => void
}) {
  const visible = showRemote ? decors : decors.filter((d) => d.kind !== 'remote')
  if (visible.length === 0) return null
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        gap: 6,
        flexShrink: 0,
        marginRight: 6,
      }}
    >
      {visible.map((d, i) => {
        // 原型 .ref-chip（第二段）：h18 / r5 / inputBg 底 / 8px 色块 /
        // 10px mono / textBright 字；head 边框 accent，tag 字 amber，remote 色块 muted
        const sq =
          d.kind === 'head'
            ? COLORS.accent
            : d.kind === 'tag'
              ? COLORS.amber
              : d.kind === 'remote'
                ? COLORS.muted
                : COLORS.terminalKind
        const border = d.kind === 'head' ? COLORS.accent : COLORS.borderSubtle
        const color = d.kind === 'tag' ? COLORS.amber : COLORS.textBright
        return (
          <div
            key={`${d.kind}-${d.label}-${i}`}
            testId={`git-ref-${d.kind}`}
            onClick={onSelect}
            onAuxClick={(e) => onAux(d, e)}
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              height: 18,
              paddingLeft: 6,
              paddingRight: 6,
              borderWidth: 1,
              borderColor: border,
              borderRadius: 5,
              backgroundColor: COLORS.inputBg,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                backgroundColor: sq,
                flexShrink: 0,
                pointerEvents: 'none',
              }}
            />
            <text
              style={{
                fontSize: 10,
                fontFamily: FONT.mono,
                color,
                pointerEvents: 'none',
              }}
            >
              {d.label}
            </text>
          </div>
        )
      })}
    </div>
  )
}

function person(name: string, email: string): string {
  return email ? `${name} <${email}>` : name
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  // 原型 .cdv-meta：行 mb4 / .k w82 muted / .v mono 11.5 text
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'flex-start',
        minWidth: 0,
        marginBottom: 4,
      }}
    >
      <text
        style={{
          width: CDV_LABEL_W,
          minWidth: CDV_LABEL_W,
          flexShrink: 0,
          fontSize: 12,
          fontFamily: FONT.ui,
          color: COLORS.muted,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}
      >
        {label}
      </text>
      <div style={{ flexGrow: 1, minWidth: 0 }}>{children}</div>
    </div>
  )
}

function ellipsisText(
  value: string,
  extra?: { color?: string; fontFamily?: string; size?: number; onClick?: () => void },
) {
  return (
    <text
      onClick={extra?.onClick}
      style={{
        fontSize: extra?.size ?? 12,
        fontFamily: extra?.fontFamily ?? FONT.ui,
        color: extra?.color ?? COLORS.text,
        minWidth: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        cursor: extra?.onClick ? 'pointer' : undefined,
      }}
    >
      {value}
    </text>
  )
}

/** 原型 .ftree/.frow：扁平文件列表（icon 12 + 目录前缀 muted + 文件名），
 *  无目录树/无增删统计——原型不画。容器可横向滚动，路径不 ellipsis。 */
function FileList({ files }: { files: readonly ChangedFile[] }) {
  if (files.length === 0) {
    return <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted }}>无变更</text>
  }
  return (
    <>
      {files.map((f) => {
        const sl = f.path.lastIndexOf('/')
        const dir = sl >= 0 ? f.path.slice(0, sl + 1) : ''
        const name = sl >= 0 ? f.path.slice(sl + 1) : f.path
        return (
          <div
            key={f.path}
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingTop: 1,
              paddingBottom: 1,
              flexShrink: 0,
            }}
          >
            {/* 原型 .ftree .frow>svg{color:var(--muted)} */}
            <Icon name="file" size={12} color={COLORS.muted} />
            {dir ? (
              <text
                style={{
                  fontSize: 12,
                  fontFamily: FONT.mono,
                  color: COLORS.muted,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {dir}
              </text>
            ) : null}
            <text
              style={{
                fontSize: 12,
                fontFamily: FONT.mono,
                color: COLORS.text,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {name}
            </text>
          </div>
        )
      })}
    </>
  )
}

/** 原型 .git-cdv 卡片：margin 8/10/10、r12、borderSubtle 全边、sidebar 底、
 *  左右各半（sum 右缘 1px border 分隔）。 */
function Cdv({
  row,
  files,
  body,
  detailLoading,
  detailError,
}: {
  row: GraphRow
  files: readonly ChangedFile[]
  body: string | null
  detailLoading: boolean
  detailError: string | null
}) {
  const c = row.commit
  return (
    <div
      testId="git-detail"
      style={{
        height: CDV_H,
        display: 'flex',
        flexDirection: 'row',
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 12,
        backgroundColor: COLORS.sidebar,
        minWidth: 0,
        overflow: 'hidden',
      }}
    >
      <div
        testId="git-cdv-summary"
        style={{
          width: '50%',
          minWidth: 0,
          overflow: 'hidden',
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 12,
          paddingRight: 12,
          borderRightWidth: 1,
          borderColor: COLORS.border,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* .cdv-title：13px textBright lh1.4 mb8 */}
        <text
          style={{
            fontSize: 13,
            fontFamily: FONT.ui,
            color: COLORS.textBright,
            lineHeight: 18,
            marginBottom: 8,
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          {c.subject}
        </text>
        <MetaRow label="Author:">
          {ellipsisText(person(c.authorName, c.authorEmail), { fontFamily: FONT.mono, size: 11.5 })}
        </MetaRow>
        <MetaRow label="Date:">
          {ellipsisText(relativeTime(c.timestamp), { fontFamily: FONT.mono, size: 11.5 })}
        </MetaRow>
        <MetaRow label="SHA:">{ellipsisText(c.sha, { fontFamily: FONT.mono, size: 11.5 })}</MetaRow>
        {/* .cdv-body：12px muted mt8 lh1.5 pre-wrap */}
        {detailLoading ? (
          <text
            style={{
              fontSize: 12,
              fontFamily: FONT.ui,
              color: COLORS.muted,
              marginTop: 8,
            }}
          >
            加载说明…
          </text>
        ) : detailError ? (
          <text
            style={{
              fontSize: 12,
              fontFamily: FONT.ui,
              color: COLORS.bell,
              marginTop: 8,
            }}
          >
            {detailError}
          </text>
        ) : body ? (
          <text
            style={{
              marginTop: 8,
              fontSize: 12,
              fontFamily: FONT.ui,
              color: COLORS.muted,
              whiteSpace: 'normal',
              lineHeight: 18,
            }}
          >
            {body}
          </text>
        ) : null}
      </div>
      <div
        testId="git-cdv-files"
        style={{ flexGrow: 1, minWidth: 0, padding: 10, overflow: 'scroll' }}
      >
        <FileList files={files} />
      </div>
    </div>
  )
}

function GraphRowView({
  row,
  index,
  lines,
  maxLanes,
  selected,
  dimmed,
  hollow,
  rowWidth,
  showRemote,
  narrow,
  onSelect,
  onMenu,
}: {
  row: GraphRow
  index: number
  lines: readonly import('../graph').CommitLine[]
  maxLanes: number
  selected: boolean
  /** find 有查询且本行非命中 → opacity .35（原型 .git-row dim） */
  dimmed: boolean
  hollow: boolean
  rowWidth: number
  showRemote: boolean
  /** 原型 @media(≤900px)：author/date 列隐藏 */
  narrow: boolean
  onSelect: () => void
  onMenu: (e: { x?: number; y?: number }, kind: 'commit' | RefDecor) => void
}) {
  const suppressRowMenu = useRef(false)
  const width = graphColumnWidth(maxLanes)
  const pieces = buildRowGraphics({
    row: index,
    lines,
    commitLane: row.lane,
    commitColorIdx: row.colorIdx,
    maxLanes,
    hollow,
  })
  const decors = parseRefNames(row.commit.refNames.join(', '))
  const msgColor = selected ? COLORS.textBright : COLORS.text
  const rowSpec = useMemo(
    () =>
      buildRowColumns({
        subject: row.commit.subject,
        subjectColor: msgColor,
        author: row.commit.authorName,
        date: relativeTime(row.commit.timestamp),
        sha: row.commit.shortSha,
        narrow,
      }),
    [row.commit, msgColor, narrow],
  )
  return (
    <div
      testId={`git-row-${index}`}
      onClick={onSelect}
      onAuxClick={(e) => {
        if (suppressRowMenu.current) {
          suppressRowMenu.current = false
          return
        }
        onMenu(e, 'commit')
      }}
      style={{
        position: 'relative',
        width: rowWidth,
        height: ROW_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        // 原型 .git-row：sel=surfaceActive + inset 2px accent 左条；
        // hover=surface（sel 行 hover 仍 surfaceActive——底相同）；
        // 行底 1px 2.5% 白分隔线；find 非命中整行 .35
        backgroundColor: selected ? COLORS.surfaceActive : undefined,
        hover: { backgroundColor: selected ? COLORS.surfaceActive : COLORS.surface },
        borderBottomWidth: 1,
        borderColor: ROW_SEPARATOR,
        opacity: dimmed ? 0.35 : 1,
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {selected ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 2,
            backgroundColor: COLORS.accent,
            pointerEvents: 'none',
          }}
        />
      ) : null}
      {/* gcell：原型 svg marginLeft 8、宽 gw+6；装饰层 pe:none——GPUIX 命中
          deepest 绘制元素，不挡行点击 */}
      <div
        style={{
          width,
          height: ROW_HEIGHT,
          position: 'relative',
          flexShrink: 0,
          marginLeft: 8,
          pointerEvents: 'none',
        }}
      >
        {pieces.map((p, i) => (
          <svg
            key={i}
            source={p.source}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width,
              height: ROW_HEIGHT,
              color: GRAPH_LANE_COLORS[p.colorIdx % GRAPH_LANE_COLORS.length],
            }}
          />
        ))}
      </div>
      <div
        style={{
          height: ROW_HEIGHT,
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          paddingRight: 12,
          minWidth: 0,
        }}
      >
        <RefBadges
          decors={decors}
          showRemote={showRemote}
          onSelect={onSelect}
          onAux={(d, e) => {
            suppressRowMenu.current = true
            onMenu(e, d)
          }}
        />
        {/* 行文本 4 列：canvas 自绘（见 rowColumns.ts 头注）。pe:none——
            custom element 是绘制元素，不挡行点击/右键 */}
        <git-graph-row row={rowSpec} style={{ flexGrow: 1, minWidth: 0, pointerEvents: 'none' }} />
      </div>
    </div>
  )
}

/** CDV 槽行：原型 .git-cdv 的 margin:8px 10px 10px 由槽位 padding 承担，
 *  卡片盖住 lane 列（原型不画穿线）。 */
function CdvRow({
  afterIndex,
  row,
  rowWidth,
  files,
  body,
  detailLoading,
  detailError,
}: {
  afterIndex: number
  row: GraphRow
  rowWidth: number
  files: readonly ChangedFile[]
  body: string | null
  detailLoading: boolean
  detailError: string | null
}) {
  return (
    <div
      testId={`git-cdv-${afterIndex}`}
      style={{
        width: rowWidth,
        height: CDV_SLOT_H,
        flexShrink: 0,
        paddingTop: 8,
        paddingBottom: 10,
        paddingLeft: 10,
        paddingRight: 10,
        minWidth: 0,
      }}
    >
      <Cdv
        row={row}
        files={files}
        body={body}
        detailLoading={detailLoading}
        detailError={detailError}
      />
    </div>
  )
}

/** 原型 .ctx-menu（第二段）：overlay 底 / borderSubtle / r12 / pad4 /
 *  阴影 0 14 38 rgba(0,0,0,.5)；项 minH30 r6 pad 0 8，hover=surface，
 *  danger 字红（hover 底仍 surface）；分隔线 margin 4 6。 */
function MenuLayer({
  menu,
  onClose,
  onPick,
}: {
  menu: MenuState
  onClose: () => void
  onPick: (item: GitMenuItem) => void
}) {
  return (
    <Popover
      position={{ x: menu.x, y: menu.y }}
      onClose={onClose}
      testId="git-menu"
      minWidth={180}
      style={{
        backgroundColor: COLORS.overlay,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 12,
        padding: 4,
        boxShadow: POP_SHADOW,
      }}
    >
      {menu.items.map((it, i) => {
        if ('sep' in it) {
          return (
            <div
              key={`sep-${i}`}
              style={{
                height: 1,
                backgroundColor: COLORS.borderSubtle,
                marginTop: 4,
                marginBottom: 4,
                marginLeft: 6,
                marginRight: 6,
              }}
            />
          )
        }
        return (
          <div
            key={it.id}
            testId={`git-menu-${it.id}`}
            onClick={() => {
              if (!it.disabled) onPick(it)
            }}
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              minHeight: 30,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 6,
              opacity: it.disabled ? 0.4 : 1,
              cursor: it.disabled ? 'default' : 'pointer',
              hover: it.disabled ? undefined : { backgroundColor: COLORS.surface },
            }}
          >
            <text
              style={{
                fontSize: 12,
                fontFamily: FONT.ui,
                color: it.danger ? COLORS.bell : COLORS.text,
                width: 14,
                flexShrink: 0,
                pointerEvents: 'none',
              }}
            >
              {it.checked ? '✓' : ''}
            </text>
            <text
              style={{
                fontSize: 12,
                fontFamily: FONT.ui,
                color: it.danger ? COLORS.bell : COLORS.text,
                pointerEvents: 'none',
              }}
            >
              {it.label}
            </text>
          </div>
        )
      })}
    </Popover>
  )
}

export function GitGraphView({
  cwd,
  store,
  repoLabel,
  scrollToItem,
}: {
  cwd: string
  store: GitGraphStore
  repoLabel: string
  scrollToItem?: (elementId: number, index: number) => void
}) {
  const s = useGitGraphStore(store, (st) => st)
  const listRef = useRef<PublicInstance | null>(null)
  const rootRef = useRef<PublicInstance | null>(null)
  const { renderer } = useGpuix()
  const { width: winW, height: winH } = useWindowSize()
  const listHeight =
    winH -
    SIZES.topChrome -
    TAB_H -
    TOOLBAR_H -
    HEADER_H -
    (s.status === 'error' || s.actionError ? ERROR_H : 0)
  // 行宽 = 本视图实占宽（侧栏/工作面板挤压后），不是窗口宽——
  // 否则 author/date/sha 固定列被推到可视区外（走查发现的偏差）。
  // getElementBounds 是「上一帧已画」的 bounds，挂载首帧为 null →
  // 回退 winW；100ms 轮询跟随侧栏开合与窗口 resize。
  const [paneW, setPaneW] = useState<number | null>(null)
  useEffect(() => {
    const read = () => {
      const el = rootRef.current
      if (!el) return
      const b = renderer?.getElementBounds?.(el.id)
      if (b && b.width > 0) setPaneW((prev) => (prev === b.width ? prev : b.width))
    }
    read()
    const id = setInterval(read, 100)
    return () => clearInterval(id)
  }, [renderer])
  const rowWidth = paneW ?? winW
  /** 原型 @media(≤900px)：author/date 列隐藏、工具条横向滚动。
      以行实占宽判定（侧栏挤压时同样进入窄态）。 */
  const narrow = rowWidth < 900
  const [findOpen, setFindOpen] = useState(false)
  const [findDraft, setFindDraft] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [promptVal, setPromptVal] = useState('')
  const [branchOpen, setBranchOpen] = useState(false)
  const branchBtnRef = useRef<PublicInstance | null>(null)
  /** 分支浮层左上角：开层时取按钮 bounds + sideOffset 6（原型 Pop sideOffset） */
  const [branchPos, setBranchPos] = useState({ x: 0, y: 0 })
  const findActive = s.findQuery.trim() !== ''
  const matchSet = useMemo(() => new Set(s.findMatches), [s.findMatches])

  useEffect(() => {
    store.mount(cwd)
  }, [cwd, store])
  useEffect(() => {
    if (!s.selectedSha || !scrollToItem) return
    const commitIndex = s.rows.findIndex((r) => r.commit.sha === s.selectedSha)
    // 单选：CDV 插在选中提交之后，滚动对准提交行即可
    if (commitIndex >= 0 && listRef.current) scrollToItem(listRef.current.id, commitIndex)
  }, [s.selectedSha, s.rows, scrollToItem])
  useEffect(() => {
    if (s.actionError) toast(s.actionError)
  }, [s.actionError])

  const currentBranch = s.branches.find((b) => b.current)?.name ?? 'HEAD'
  const graphW = graphColumnWidth(s.maxLanes)
  // 菜单动作派发归 commands.ts：pick 路由（复制/prompt/danger/直执）、
  // runGit = toast+runAction 单点；本组件只持有叠加层开合状态
  const commands = useMemo(
    () => createGitCommands({ runAction: (a) => store.runAction(a), notify: toast }),
    [store],
  )

  function openCommitMenu(e: { x?: number; y?: number }, row: GraphRow, index: number) {
    setMenu({ x: e.x ?? 0, y: e.y ?? 0, ...commitMenu(row, index) })
  }

  function openRefMenu(e: { x?: number; y?: number }, d: RefDecor) {
    setMenu({ x: e.x ?? 0, y: e.y ?? 0, ...refMenu(d, currentBranch) })
  }

  function pickMenu(item: GitMenuItem) {
    const at = menu?.at
    setMenu(null)
    const next = commands.pick(item, at)
    if (next.kind === 'prompt') {
      setPromptVal('')
      setPrompt({ item: next.item, at: next.at })
    } else if (next.kind === 'confirm') {
      setConfirm({ title: next.title, argv: next.argv })
    }
  }

  return (
    <div
      testId="git-graph-view"
      ref={rootRef}
      style={{
        flexGrow: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        backgroundColor: COLORS.pane,
        position: 'relative',
      }}
    >
      {/* 原型 .git-toolbar（第二段）：h42 / pad 0 12 / gap8 /
          bg rgba(32,36,43,.42) / borderBottom borderSubtle */}
      <div
        testId="git-toolbar"
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          height: TOOLBAR_H,
          paddingLeft: 12,
          paddingRight: 12,
          borderBottomWidth: 1,
          borderColor: COLORS.borderSubtle,
          backgroundColor: TOOLBAR_BG,
          flexShrink: 0,
          overflow: narrow ? 'scroll' : 'hidden',
        }}
      >
        <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted, flexShrink: 0 }}>
          {repoLabel}
        </text>
        <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted, flexShrink: 0 }}>
          分支
        </text>
        {/* .git-branch-btn（第二段）：h28 / border borderSubtle / r8 / inputBg 底 /
            pad 0 8 / gap5 / 12px mono / gitBranch+chev 12 muted */}
        <div
          testId="git-branch"
          ref={branchBtnRef}
          onClick={() => {
            const el = branchBtnRef.current
            const b = el ? renderer?.getElementBounds?.(el.id) : null
            if (b) setBranchPos({ x: b.x, y: b.y + b.height + 6 })
            setBranchOpen((v) => !v)
          }}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            height: 28,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: COLORS.borderSubtle,
            backgroundColor: COLORS.inputBg,
            cursor: 'pointer',
            flexShrink: 0,
            hover: { backgroundColor: COLORS.tileHover },
          }}
        >
          <Icon name="gitBranch" size={12} color={COLORS.muted} />
          <text
            style={{
              fontSize: 12,
              fontFamily: FONT.mono,
              color: COLORS.text,
              pointerEvents: 'none',
            }}
          >
            {currentBranch}
          </text>
          <Icon name="chevronDown" size={12} color={COLORS.muted} />
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0,
          }}
        >
          {/* 原型 transform:scale(.85) → Toggle scale prop（GPUIX 无 transform） */}
          <Toggle
            checked={s.showRemote}
            onChange={(on) => store.setShowRemote(on)}
            testId="git-show-remote"
            scale={0.85}
          />
          <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted }}>
            显示远程分支
          </text>
        </div>
        {/* .cnt：margin-left:auto —— spacer 推到右侧图标组前 */}
        <div style={{ flexGrow: 1, minWidth: 0 }} />
        <text
          testId="git-count"
          style={{ fontSize: 11, fontFamily: FONT.ui, color: COLORS.muted, flexShrink: 0 }}
        >
          {s.status === 'loading' && s.loadedCount === 0 ? '读取提交…' : `${s.loadedCount} 提交`}
        </text>
        {/* find 展开时 search 钮消失（原型同） */}
        {findOpen ? (
          <div
            testId="git-find"
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              flexShrink: 0,
            }}
          >
            {/* .git-find input：w180 h24 */}
            <TextInput
              value={findDraft}
              placeholder="查找提交"
              testId="git-find-input"
              width={180}
              height={24}
              onChange={(v) => {
                setFindDraft(v)
                store.find(v)
              }}
              onSubmit={() => store.findNext(1)}
            />
            <text
              style={{
                fontSize: 11,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                width: 40,
                textAlign: 'center',
              }}
            >
              {s.findMatches.length ? `${s.findIndex + 1}/${s.findMatches.length}` : '0/0'}
            </text>
            <IconButton
              name="chevronUp"
              label="上一个"
              testId="git-find-prev"
              hitSize={22}
              size={12}
              onClick={() => store.findNext(-1)}
            />
            <IconButton
              name="chevronDown"
              label="下一个"
              testId="git-find-next"
              hitSize={22}
              size={12}
              onClick={() => store.findNext(1)}
            />
            <IconButton
              name="close"
              label="关闭查找"
              testId="git-find-close"
              hitSize={22}
              size={12}
              onClick={() => {
                setFindOpen(false)
                setFindDraft('')
                store.find('')
              }}
            />
          </div>
        ) : (
          <IconButton
            name="search"
            label="查找提交"
            testId="git-find-open"
            hitSize={26}
            size={16}
            onClick={() => setFindOpen(true)}
          />
        )}
        <IconButton
          name="gear"
          label="设置（后续版本）"
          testId="git-settings"
          hitSize={26}
          size={16}
          onClick={() => toast('设置面板：后续版本提供')}
        />
        <IconButton
          name="download"
          label="拉取远端更新"
          testId="git-fetch"
          hitSize={26}
          size={16}
          onClick={() => commands.runGit(['fetch', '--all', '--prune'])}
        />
        <IconButton
          name="reset"
          label="刷新（R）"
          testId="git-refresh"
          hitSize={26}
          size={16}
          onClick={() => store.refresh()}
        />
      </div>
      {/* 原型 .git-err：h33 / pad 0 10 / gap8 / bell 8% 底 /
          borderBottom border / statusError 字 */}
      {s.status === 'error' || s.actionError ? (
        <div
          testId="git-error"
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            height: ERROR_H,
            paddingLeft: 10,
            paddingRight: 10,
            backgroundColor: ERROR_BG,
            borderBottomWidth: 1,
            borderColor: COLORS.border,
            flexShrink: 0,
          }}
        >
          <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.bell }}>
            {s.actionError ?? s.error ?? 'git log 失败'}
          </text>
        </div>
      ) : null}
      {s.status === 'not-a-repo' ? (
        <div
          testId="git-not-a-repo"
          style={{
            flexGrow: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <text style={{ fontSize: 13, fontFamily: FONT.ui, color: COLORS.muted }}>
            此目录不是 git 仓库
          </text>
        </div>
      ) : (
        <>
          {/* 原型 .git-header（第二段）：h30 / bg #1a1d22 / 9px uppercase
              （GPUIX 无 textTransform/letterSpacing——直接写大写文本，
              letter-spacing .06em 不还原，记偏差）/ muted 字 /
              borderBottom borderSubtle；列几何与行一致 */}
          <div
            testId="git-header"
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              height: HEADER_H,
              paddingRight: 12,
              borderBottomWidth: 1,
              borderColor: COLORS.borderSubtle,
              backgroundColor: HEADER_BG,
              flexShrink: 0,
            }}
          >
            <text
              style={{
                fontSize: 9,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                width: graphW,
                marginLeft: 8,
                flexShrink: 0,
              }}
            >
              GRAPH
            </text>
            <text
              style={{
                fontSize: 9,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                flexGrow: 1,
                minWidth: 0,
              }}
            >
              DESCRIPTION
            </text>
            {narrow ? null : (
              <>
                <text
                  style={{
                    fontSize: 9,
                    fontFamily: FONT.ui,
                    color: COLORS.muted,
                    width: COL_AUTHOR,
                    marginLeft: 8,
                    flexShrink: 0,
                  }}
                >
                  AUTHOR
                </text>
                <text
                  style={{
                    fontSize: 9,
                    fontFamily: FONT.ui,
                    color: COLORS.muted,
                    width: COL_DATE,
                    textAlign: 'right',
                    marginLeft: 8,
                    flexShrink: 0,
                  }}
                >
                  DATE
                </text>
              </>
            )}
            <text
              style={{
                fontSize: 9,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                width: COL_SHA,
                marginLeft: 8,
                flexShrink: 0,
              }}
            >
              SHA
            </text>
          </div>
          <virtual-list
            ref={listRef}
            estimatedItemHeight={ROW_HEIGHT}
            style={{ height: Math.max(listHeight, ROW_HEIGHT) }}
          >
            {s.rows.flatMap((row, i) => {
              const selected = s.selectedSha === row.commit.sha
              const commitRow = (
                <GraphRowView
                  key={row.commit.sha}
                  row={row}
                  index={i}
                  lines={s.linesByRow.get(i) ?? []}
                  maxLanes={s.maxLanes}
                  selected={selected}
                  dimmed={findActive && !matchSet.has(row.commit.sha)}
                  hollow={i === 0}
                  rowWidth={rowWidth}
                  showRemote={s.showRemote}
                  narrow={narrow}
                  onSelect={() => store.select(selected ? null : row.commit.sha)}
                  onMenu={(e, kind) => {
                    if (kind === 'commit') openCommitMenu(e, row, i)
                    else openRefMenu(e, kind)
                  }}
                />
              )
              if (!selected) return [commitRow]
              return [
                commitRow,
                <CdvRow
                  key={`${row.commit.sha}-cdv`}
                  afterIndex={i}
                  row={row}
                  rowWidth={rowWidth}
                  files={s.files}
                  body={s.body}
                  detailLoading={s.detailLoading}
                  detailError={s.detailError}
                />,
              ]
            })}
          </virtual-list>
        </>
      )}
      {menu ? <MenuLayer menu={menu} onClose={() => setMenu(null)} onPick={pickMenu} /> : null}
      {/* 原型 .branch-pop（Pop sideOffset=6，锚在 branch-btn 下缘）：
          overlay 底 / borderSubtle / r12 / pad4 / 阴影；.brow h26 r4
          pad 0 8 gap6 hover=surface，ck w14 terminalKind */}
      {branchOpen ? (
        <Popover
          position={branchPos}
          onClose={() => setBranchOpen(false)}
          testId="git-branch-pop"
          minWidth={180}
          style={{
            backgroundColor: COLORS.overlay,
            borderWidth: 1,
            borderColor: COLORS.borderSubtle,
            borderRadius: 12,
            padding: 4,
            boxShadow: POP_SHADOW,
          }}
        >
          {s.branches.map((b) => (
            <div
              key={b.name}
              testId={`git-branch-${b.name}`}
              onClick={() => {
                setBranchOpen(false)
                if (!b.current) commands.runGit(['checkout', b.name])
              }}
              style={{
                height: 26,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 4,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
                hover: { backgroundColor: COLORS.surface },
              }}
            >
              <text
                style={{
                  fontSize: 12,
                  fontFamily: FONT.ui,
                  color: COLORS.terminalKind,
                  width: 14,
                  flexShrink: 0,
                  pointerEvents: 'none',
                }}
              >
                {b.current ? '✓' : ''}
              </text>
              <Icon name="gitBranch" size={12} color={COLORS.muted} />
              <text
                style={{
                  fontSize: 12,
                  fontFamily: FONT.ui,
                  color: COLORS.text,
                  pointerEvents: 'none',
                }}
              >
                {b.name}
              </text>
            </div>
          ))}
        </Popover>
      ) : null}
      {confirm ? (
        <Modal width={380} onClose={() => setConfirm(null)}>
          <ModalHeading title="确认操作" onClose={() => setConfirm(null)} />
          <ModalBody>
            <text
              style={{
                fontSize: 13,
                fontFamily: FONT.ui,
                color: COLORS.text,
                whiteSpace: 'normal',
              }}
            >
              {`${confirm.title}\ngit ${confirm.argv.join(' ')}`}
            </text>
          </ModalBody>
          <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 12 }}>
            <ModalActions
              actions={[
                { label: '取消', onClick: () => setConfirm(null) },
                {
                  label: '执行',
                  danger: true,
                  onClick: () => {
                    commands.runGit(confirm.argv)
                    setConfirm(null)
                  },
                },
              ]}
            />
          </div>
        </Modal>
      ) : null}
      {prompt ? (
        <Modal width={380} onClose={() => setPrompt(null)}>
          <ModalHeading title={prompt.item.label} onClose={() => setPrompt(null)} />
          <ModalBody>
            <TextInput
              value={promptVal}
              placeholder="名称"
              testId="git-prompt-input"
              width="fill"
              onChange={setPromptVal}
              onSubmit={(v) => {
                if (commands.submitPrompt(prompt.item, v, prompt.at)) setPrompt(null)
              }}
            />
          </ModalBody>
          <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 12 }}>
            <ModalActions
              actions={[
                { label: '取消', onClick: () => setPrompt(null) },
                {
                  label: '创建',
                  primary: true,
                  onClick: () => {
                    if (commands.submitPrompt(prompt.item, promptVal, prompt.at)) setPrompt(null)
                  },
                },
              ]}
            />
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
