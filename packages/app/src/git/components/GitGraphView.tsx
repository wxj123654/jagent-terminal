/**
 * git/components/GitGraphView.tsx — Git 图表面（design/git-graph-v2.md）。
 *
 * 工具条（分支 / 远程开关 / find / fetch / refresh）+ 表头列 + 虚拟化提交
 * 列表。选中后在提交下方插入独立 CDV 行（virtual-list 定高模型不能把同一行撑开）；
 * Graph 列竖线由 buildGapGraphics 穿过详情槽。
 * 右键走 onAuxClick + <anchored> 菜单；git actions 经 store.runAction。
 */

import { useWindowSize } from '@gpuix/react'
import type { PublicInstance } from '@gpuix/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import type { IconName } from '@jagent/ui'
import {
  Icon,
  IconButton,
  Modal,
  ModalActions,
  ModalBody,
  ModalHeading,
  TextInput,
  toast,
  Toggle,
  COLORS,
  FONT,
} from '@jagent/ui'
import { GRAPH_LANE_COLORS, SIZES } from '../../tokens'
import {
  branchMenuItems,
  commitMenuItems,
  remoteMenuItems,
  resolvePrompt,
  tagMenuItems,
  type GitMenuEntry,
  type GitMenuItem,
} from '../actions'
import type { ChangedFile } from '../cli'
import { compactDir, nestChangedFiles, type FileTreeNode } from '../fileTree'
import { formatCommitDate, parseRefNames, relativeTime, type RefDecor } from '../format'
import type { GraphRow } from '../graph'
import { buildGapGraphics, buildRowGraphics, graphColumnWidth, ROW_HEIGHT } from '../graphSvg'
import type { GitGraphStore } from '../store'
import { useGitGraphStore } from '../useGitGraphStore'

const TOOLBAR_H = 34
const HEADER_H = 26
const TAB_H = 30
const ERROR_H = 33
const CDV_H = 224
/** vscode-git-graph：Committer: 是最宽 label，12px 约 82px */
const CDV_LABEL_W = 82
const COL_AUTHOR = 110
const COL_DATE = 80
const COL_SHA = 72

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
  colorIdx,
  showRemote,
  onAux,
}: {
  decors: RefDecor[]
  colorIdx: number
  showRemote: boolean
  onAux: (d: RefDecor, e: { x?: number; y?: number }) => void
}) {
  const visible = showRemote ? decors : decors.filter((d) => d.kind !== 'remote')
  if (visible.length === 0) return null
  const lane = GRAPH_LANE_COLORS[colorIdx % GRAPH_LANE_COLORS.length]
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        gap: 4,
        flexShrink: 0,
        marginRight: 6,
      }}
    >
      {visible.map((d, i) => {
        const ico: IconName = d.kind === 'tag' ? 'tag' : 'gitBranch'
        const icoBg = d.kind === 'tag' ? COLORS.amber : d.kind === 'remote' ? COLORS.muted : lane
        const border = d.kind === 'head' ? lane : COLORS.borderSubtle
        const color =
          d.kind === 'head'
            ? COLORS.textBright
            : d.kind === 'tag'
              ? COLORS.amber
              : d.kind === 'remote'
                ? COLORS.muted
                : COLORS.textBright
        return (
          <div
            key={`${d.kind}-${d.label}-${i}`}
            testId={`git-ref-${d.kind}`}
            onAuxClick={(e) => onAux(d, e)}
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              height: 18,
              borderWidth: 1,
              borderColor: border,
              borderRadius: 5,
              overflow: 'hidden',
              flexShrink: 0,
              backgroundColor: 'rgba(128,128,128,0.12)',
            }}
          >
            <div
              style={{
                width: 15,
                height: 15,
                backgroundColor: icoBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Icon name={ico} size={10} color={COLORS.pane} />
            </div>
            <text
              style={{
                fontSize: 11,
                fontFamily: FONT.mono,
                color,
                paddingLeft: 4,
                paddingRight: 5,
                fontWeight: d.kind === 'head' ? '700' : undefined,
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
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'flex-start',
        minWidth: 0,
        marginTop: 3,
      }}
    >
      <text
        style={{
          width: CDV_LABEL_W,
          minWidth: CDV_LABEL_W,
          flexShrink: 0,
          fontSize: 12,
          fontFamily: FONT.ui,
          fontWeight: '600',
          color: COLORS.textBright,
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
  extra?: { color?: string; fontFamily?: string; onClick?: () => void },
) {
  return (
    <text
      onClick={extra?.onClick}
      style={{
        fontSize: 12,
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

function FileTree({ files }: { files: readonly ChangedFile[] }) {
  if (files.length === 0) {
    return <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted }}>无变更</text>
  }
  const render = (n: FileTreeNode, key: string) => (
    <div key={key} style={{ paddingLeft: key ? 16 : 0, minWidth: 0 }}>
      {Object.entries(n.dirs).map(([d, child]) => {
        const compact = compactDir(d, child)
        return (
          <div key={compact.name} style={{ minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                height: 18,
                minWidth: 0,
                overflow: 'hidden',
              }}
            >
              <Icon name="folder" size={11} color={COLORS.muted} />
              <text
                style={{
                  fontSize: 12,
                  fontFamily: FONT.ui,
                  color: COLORS.text,
                  marginLeft: 4,
                  minWidth: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {compact.name}
              </text>
            </div>
            {render(compact.node, `${key}/${compact.name}`)}
          </div>
        )
      })}
      {n.files.map((f) => {
        const name = f.path.split('/').pop() ?? f.path
        const bin = f.added == null || f.deleted == null
        return (
          <div
            key={f.path}
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              height: 18,
              minWidth: 0,
              overflow: 'hidden',
            }}
          >
            <Icon name="file" size={11} color={COLORS.cyan} />
            <text
              style={{
                fontSize: 12,
                fontFamily: FONT.mono,
                color: COLORS.cyan,
                marginLeft: 4,
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {name}
            </text>
            {bin ? (
              <text
                style={{
                  fontSize: 11,
                  fontFamily: FONT.mono,
                  color: COLORS.muted,
                  marginLeft: 8,
                  flexShrink: 0,
                }}
              >
                BIN
              </text>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  flexShrink: 0,
                  marginLeft: 8,
                }}
              >
                <text
                  style={{
                    fontSize: 11,
                    fontFamily: FONT.mono,
                    color: COLORS.muted,
                  }}
                >
                  (
                </text>
                <text
                  style={{
                    fontSize: 11,
                    fontFamily: FONT.mono,
                    color: COLORS.terminalKind,
                  }}
                >
                  {`+${f.added}`}
                </text>
                <text
                  style={{
                    fontSize: 11,
                    fontFamily: FONT.mono,
                    color: COLORS.muted,
                  }}
                >
                  {' | '}
                </text>
                <text
                  style={{
                    fontSize: 11,
                    fontFamily: FONT.mono,
                    color: COLORS.bell,
                  }}
                >
                  {`-${f.deleted}`}
                </text>
                <text
                  style={{
                    fontSize: 11,
                    fontFamily: FONT.mono,
                    color: COLORS.muted,
                  }}
                >
                  )
                </text>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
  return render(nestChangedFiles(files), '')
}

function Cdv({
  row,
  store,
  files,
  body,
  detailLoading,
  detailError,
}: {
  row: GraphRow
  store: GitGraphStore
  files: readonly ChangedFile[]
  body: string | null
  detailLoading: boolean
  detailError: string | null
}) {
  const c = row.commit
  const parents = c.parents
  return (
    <div
      testId="git-detail"
      style={{
        height: CDV_H,
        display: 'flex',
        flexDirection: 'row',
        borderTopWidth: 1,
        borderColor: COLORS.borderSubtle,
        backgroundColor: 'rgba(128,128,128,0.08)',
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
          borderColor: COLORS.borderSubtle,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ flexShrink: 0, minWidth: 0 }}>
          <MetaRow label="Commit:">
            {ellipsisText(c.sha, {
              color: COLORS.textBright,
              fontFamily: FONT.mono,
            })}
          </MetaRow>
          {parents.length > 0 ? (
            <MetaRow label="Parents:">
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  gap: 8,
                  minWidth: 0,
                }}
              >
                {parents.map((p) => (
                  <text
                    key={p}
                    onClick={() => store.select(p)}
                    style={{
                      fontSize: 12,
                      fontFamily: FONT.mono,
                      color: COLORS.accent,
                      cursor: 'pointer',
                      minWidth: 0,
                      flexShrink: 1,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      textDecoration: 'underline',
                    }}
                  >
                    {p}
                  </text>
                ))}
              </div>
            </MetaRow>
          ) : null}
          <MetaRow label="Author:">
            {ellipsisText(person(c.authorName, c.authorEmail), {
              color: COLORS.textBright,
            })}
          </MetaRow>
          <MetaRow label="Committer:">
            {ellipsisText(person(c.committerName, c.committerEmail), {
              color: COLORS.textBright,
            })}
          </MetaRow>
          <MetaRow label="Date:">
            {ellipsisText(formatCommitDate(c.timestamp), {
              color: COLORS.textBright,
            })}
          </MetaRow>
        </div>
        <div
          style={{
            marginTop: 10,
            paddingTop: 8,
            borderTopWidth: 1,
            borderColor: COLORS.borderSubtle,
            flexGrow: 1,
            minHeight: 0,
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          <div style={{ height: '100%', minWidth: 0, overflow: 'scroll' }}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                minWidth: 0,
                overflow: 'hidden',
              }}
            >
              <Icon name="gitBranch" size={12} color={COLORS.terminalKind} />
              <text
                style={{
                  fontSize: 13,
                  fontFamily: FONT.ui,
                  color: COLORS.textBright,
                  fontWeight: '600',
                  marginLeft: 6,
                  minWidth: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {c.subject}
              </text>
            </div>
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
                  color: COLORS.text,
                  whiteSpace: 'normal',
                  lineHeight: 18,
                }}
              >
                {body}
              </text>
            ) : null}
          </div>
        </div>
      </div>
      <div
        testId="git-cdv-files"
        style={{ flexGrow: 1, minWidth: 0, padding: 10, overflow: 'scroll' }}
      >
        <FileTree files={files} />
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
  muted,
  hollow,
  rowWidth,
  showRemote,
  onSelect,
  onMenu,
}: {
  row: GraphRow
  index: number
  lines: readonly import('../graph').CommitLine[]
  maxLanes: number
  selected: boolean
  muted: boolean
  hollow: boolean
  rowWidth: number
  showRemote: boolean
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
  const dim = muted ? 0.45 : 1
  return (
    <div
      testId={`git-row-${index}`}
      style={{
        width: rowWidth,
        height: ROW_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        backgroundColor: selected ? 'rgba(128,128,128,0.22)' : undefined,
        hover: selected ? undefined : { backgroundColor: 'rgba(128,128,128,0.12)' },
        cursor: 'pointer',
      }}
    >
      <div
        style={{
          width,
          height: ROW_HEIGHT,
          position: 'relative',
          flexShrink: 0,
          marginLeft: 8,
          marginRight: 6,
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
        onClick={onSelect}
        onAuxClick={(e) => {
          if (suppressRowMenu.current) {
            suppressRowMenu.current = false
            return
          }
          onMenu(e, 'commit')
        }}
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
        {hollow ? (
          <div
            style={{
              width: 6,
              height: 6,
              borderWidth: 2,
              borderColor: GRAPH_LANE_COLORS[row.colorIdx % GRAPH_LANE_COLORS.length],
              borderRadius: 6,
              marginRight: 6,
              flexShrink: 0,
            }}
          />
        ) : null}
        <RefBadges
          decors={decors}
          colorIdx={row.colorIdx}
          showRemote={showRemote}
          onAux={(d, e) => {
            suppressRowMenu.current = true
            onMenu(e, d)
          }}
        />
        <text
          style={{
            fontSize: 13,
            fontFamily: FONT.ui,
            color: msgColor,
            opacity: dim,
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            fontWeight: selected ? '600' : undefined,
          }}
        >
          {row.commit.subject}
        </text>
        <text
          style={{
            fontSize: 11,
            fontFamily: FONT.ui,
            color: COLORS.muted,
            opacity: dim,
            width: COL_AUTHOR,
            flexShrink: 0,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            marginLeft: 8,
          }}
        >
          {row.commit.authorName}
        </text>
        <text
          style={{
            fontSize: 11,
            fontFamily: FONT.ui,
            color: COLORS.muted,
            opacity: dim,
            width: COL_DATE,
            flexShrink: 0,
            textAlign: 'right',
            marginLeft: 8,
          }}
        >
          {relativeTime(row.commit.timestamp)}
        </text>
        <text
          testId={`git-sha-${index}`}
          onClick={() => {
            toast(`已复制 ${row.commit.shortSha}`)
          }}
          style={{
            fontSize: 11,
            fontFamily: FONT.mono,
            color: COLORS.muted,
            width: COL_SHA,
            flexShrink: 0,
            marginLeft: 8,
          }}
        >
          {row.commit.shortSha}
        </text>
      </div>
    </div>
  )
}

function CdvRow({
  afterIndex,
  row,
  lines,
  maxLanes,
  rowWidth,
  store,
  files,
  body,
  detailLoading,
  detailError,
}: {
  afterIndex: number
  row: GraphRow
  lines: readonly import('../graph').CommitLine[]
  maxLanes: number
  rowWidth: number
  store: GitGraphStore
  files: readonly ChangedFile[]
  body: string | null
  detailLoading: boolean
  detailError: string | null
}) {
  const width = graphColumnWidth(maxLanes)
  const pieces = buildGapGraphics({
    afterRow: afterIndex,
    lines,
    maxLanes,
    height: CDV_H,
  })
  return (
    <div
      testId={`git-cdv-${afterIndex}`}
      style={{
        width: rowWidth,
        height: CDV_H,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        minWidth: 0,
        backgroundColor: 'rgba(128,128,128,0.08)',
      }}
    >
      <div
        style={{
          width,
          height: CDV_H,
          position: 'relative',
          flexShrink: 0,
          marginLeft: 8,
          marginRight: 6,
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
              height: CDV_H,
              color: GRAPH_LANE_COLORS[p.colorIdx % GRAPH_LANE_COLORS.length],
            }}
          />
        ))}
      </div>
      <div style={{ flexGrow: 1, minWidth: 0 }}>
        <Cdv
          row={row}
          store={store}
          files={files}
          body={body}
          detailLoading={detailLoading}
          detailError={detailError}
        />
      </div>
    </div>
  )
}

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
    <anchored
      position={{ x: menu.x, y: menu.y }}
      deferred
      occlude
      onMouseDownOutside={onClose}
      style={{
        minWidth: 220,
        backgroundColor: COLORS.inputBg,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 6,
        padding: 4,
      }}
    >
      <text
        style={{
          fontSize: 11,
          fontFamily: FONT.ui,
          color: COLORS.muted,
          paddingLeft: 10,
          paddingTop: 4,
          paddingBottom: 2,
        }}
      >
        {menu.title}
      </text>
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
              height: 26,
              paddingLeft: 10,
              paddingRight: 12,
              borderRadius: 4,
              opacity: it.disabled ? 0.4 : 1,
              cursor: it.disabled ? 'default' : 'pointer',
              hover: it.disabled
                ? undefined
                : { backgroundColor: it.danger ? COLORS.bell : COLORS.accent },
            }}
          >
            <text
              style={{
                fontSize: 12,
                fontFamily: FONT.ui,
                color: it.danger ? COLORS.bell : COLORS.text,
                width: 14,
                flexShrink: 0,
              }}
            >
              {it.checked ? '✓' : ''}
            </text>
            <text
              style={{
                fontSize: 12,
                fontFamily: FONT.ui,
                color: it.danger ? COLORS.bell : COLORS.text,
              }}
            >
              {it.label}
            </text>
          </div>
        )
      })}
    </anchored>
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
  const { width: winW, height: winH } = useWindowSize()
  const listHeight =
    winH -
    SIZES.titleBarHeight -
    TAB_H -
    TOOLBAR_H -
    HEADER_H -
    (s.status === 'error' || s.actionError ? ERROR_H : 0)
  const rowWidth = winW
  const [findOpen, setFindOpen] = useState(false)
  const [findDraft, setFindDraft] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [promptVal, setPromptVal] = useState('')
  const [branchOpen, setBranchOpen] = useState(false)

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

  function openCommitMenu(e: { x?: number; y?: number }, row: GraphRow, index: number) {
    setMenu({
      x: e.x ?? 0,
      y: e.y ?? 0,
      title: `${row.commit.shortSha} · ${row.commit.subject.slice(0, 24)}`,
      items: commitMenuItems(row.commit.sha, index === 0),
      at: row.commit.sha,
    })
  }

  function openRefMenu(e: { x?: number; y?: number }, d: RefDecor) {
    if (d.kind === 'head' || d.kind === 'branch') {
      setMenu({
        x: e.x ?? 0,
        y: e.y ?? 0,
        title: `分支 ${d.label}`,
        items: branchMenuItems(d.label, d.label === currentBranch),
        at: d.label,
      })
      return
    }
    if (d.kind === 'remote') {
      setMenu({
        x: e.x ?? 0,
        y: e.y ?? 0,
        title: `远程 ${d.label}`,
        items: remoteMenuItems(d.label),
        at: d.label,
      })
      return
    }
    setMenu({
      x: e.x ?? 0,
      y: e.y ?? 0,
      title: `标签 ${d.label}`,
      items: tagMenuItems(d.label),
      at: d.label,
    })
  }

  function pickMenu(item: GitMenuItem) {
    setMenu(null)
    if (item.id === 'copy-sha' && menu?.at) {
      toast(`已复制 ${menu.at.slice(0, 7)}`)
      return
    }
    if (item.id === 'copy-tag' && menu?.at) {
      toast(`已复制 ${menu.at}`)
      return
    }
    if (item.prompt) {
      setPromptVal('')
      setPrompt({ item, at: menu?.at })
      return
    }
    if (!item.argv) return
    if (item.danger) {
      setConfirm({ title: item.label, argv: item.argv })
      return
    }
    toast(`$ git ${item.argv.join(' ')}`)
    void store.runAction(item.argv)
  }

  return (
    <div
      testId="git-graph-view"
      style={{
        flexGrow: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        backgroundColor: COLORS.pane,
        position: 'relative',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          height: TOOLBAR_H,
          paddingLeft: 12,
          paddingRight: 8,
          borderBottomWidth: 1,
          borderColor: COLORS.border,
          flexShrink: 0,
        }}
      >
        <text
          style={{
            fontSize: 12,
            fontFamily: FONT.ui,
            color: COLORS.textBright,
            flexShrink: 0,
          }}
        >
          {repoLabel}
        </text>
        <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted }}>分支</text>
        <div
          testId="git-branch"
          onClick={() => setBranchOpen((v) => !v)}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            height: 24,
            paddingLeft: 8,
            paddingRight: 6,
            borderRadius: 4,
            cursor: 'pointer',
            hover: { backgroundColor: COLORS.surface },
          }}
        >
          <text
            style={{
              fontSize: 12,
              fontFamily: FONT.ui,
              color: COLORS.textBright,
            }}
          >
            {currentBranch}
          </text>
          <Icon name="chevronDown" size={11} color={COLORS.muted} />
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Toggle
            checked={s.showRemote}
            onChange={(on) => store.setShowRemote(on)}
            testId="git-show-remote"
          />
          <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted }}>
            显示远程分支
          </text>
        </div>
        <text
          testId="git-count"
          style={{
            fontSize: 11,
            fontFamily: FONT.ui,
            color: COLORS.muted,
            flexGrow: 1,
          }}
        >
          {s.status === 'loading' && s.loadedCount === 0 ? '读取提交…' : `${s.loadedCount} 提交`}
        </text>
        {findOpen ? (
          <div
            testId="git-find"
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <TextInput
              value={findDraft}
              placeholder="查找提交"
              testId="git-find-input"
              width={180}
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
        ) : null}
        <IconButton
          name="search"
          label="查找提交"
          testId="git-find-open"
          onClick={() => setFindOpen(true)}
        />
        <IconButton
          name="gear"
          label="设置（后续版本）"
          testId="git-settings"
          onClick={() => toast('设置面板：后续版本提供')}
        />
        <IconButton
          name="download"
          label="拉取远端更新"
          testId="git-fetch"
          onClick={() => {
            toast('$ git fetch --all --prune')
            void store.runAction(['fetch', '--all', '--prune'])
          }}
        />
        <IconButton
          name="reset"
          label="刷新（R）"
          testId="git-refresh"
          onClick={() => store.refresh()}
        />
      </div>
      {s.status === 'error' || s.actionError ? (
        <div
          testId="git-error"
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            padding: 8,
            paddingLeft: 12,
            backgroundColor: 'rgba(224, 108, 117, 0.10)',
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
          <div
            testId="git-header"
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              height: HEADER_H,
              paddingLeft: 8,
              paddingRight: 12,
              borderBottomWidth: 1,
              borderColor: COLORS.borderSubtle,
              flexShrink: 0,
            }}
          >
            <text
              style={{
                fontSize: 11,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                width: graphW + 6,
              }}
            >
              Graph
            </text>
            <text
              style={{
                fontSize: 11,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                flexGrow: 1,
              }}
            >
              Description
            </text>
            <text
              style={{
                fontSize: 11,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                width: COL_AUTHOR,
                marginLeft: 8,
              }}
            >
              Author
            </text>
            <text
              style={{
                fontSize: 11,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                width: COL_DATE,
                textAlign: 'right',
                marginLeft: 8,
              }}
            >
              Date
            </text>
            <text
              style={{
                fontSize: 11,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                width: COL_SHA,
                marginLeft: 8,
              }}
            >
              Sha
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
                  muted={s.muteShas.has(row.commit.sha)}
                  hollow={i === 0}
                  rowWidth={rowWidth}
                  showRemote={s.showRemote}
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
                  lines={s.linesByRow.get(i) ?? []}
                  maxLanes={s.maxLanes}
                  rowWidth={rowWidth}
                  store={store}
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
      {branchOpen ? (
        <anchored
          position={{ x: 56, y: SIZES.titleBarHeight + TAB_H + TOOLBAR_H }}
          deferred
          occlude
          onMouseDownOutside={() => setBranchOpen(false)}
          style={{
            minWidth: 180,
            backgroundColor: COLORS.inputBg,
            borderWidth: 1,
            borderColor: COLORS.borderSubtle,
            borderRadius: 6,
            padding: 4,
          }}
        >
          {s.branches.map((b) => (
            <div
              key={b.name}
              testId={`git-branch-${b.name}`}
              onClick={() => {
                setBranchOpen(false)
                if (!b.current) {
                  toast(`$ git checkout ${b.name}`)
                  void store.runAction(['checkout', b.name])
                }
              }}
              style={{
                height: 26,
                paddingLeft: 10,
                paddingRight: 12,
                borderRadius: 4,
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                cursor: 'pointer',
                hover: { backgroundColor: COLORS.accent },
              }}
            >
              <text
                style={{
                  fontSize: 12,
                  fontFamily: FONT.ui,
                  color: COLORS.text,
                  width: 14,
                }}
              >
                {b.current ? '✓' : ''}
              </text>
              <text
                style={{
                  fontSize: 12,
                  fontFamily: FONT.ui,
                  color: COLORS.text,
                }}
              >
                {b.name}
              </text>
            </div>
          ))}
        </anchored>
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
              {confirm.title}
              {'\n'}
              git {confirm.argv.join(' ')}
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
                    toast(`$ git ${confirm.argv.join(' ')}`)
                    void store.runAction(confirm.argv)
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
                try {
                  const argv = resolvePrompt(prompt.item, v, prompt.at)
                  toast(`$ git ${argv.join(' ')}`)
                  void store.runAction(argv)
                  setPrompt(null)
                } catch (e) {
                  toast(e instanceof Error ? e.message : String(e))
                }
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
                    try {
                      const argv = resolvePrompt(prompt.item, promptVal, prompt.at)
                      toast(`$ git ${argv.join(' ')}`)
                      void store.runAction(argv)
                      setPrompt(null)
                    } catch (e) {
                      toast(e instanceof Error ? e.message : String(e))
                    }
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
