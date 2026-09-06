/**
 * git/components/GitGraphView.tsx — Git 图表面（docs/git-graph.md §3/§4）。
 *
 * 布局：工具条（repo 名 + n commits + refresh）+ 虚拟化提交列表
 * （<virtual-list> 定高 26 行）+ 选中时右侧 360px diff 详情列（<diff>）。
 * store 挂载跟随 cwd（幂等 mount；离开 tab 不卸载流——切回免重拉）。
 *
 * 键盘（↑↓/Enter/Esc/R）在全局层（keybindings.ts gitGraphKey 注入），
 * 本组件只负责点击与渲染。
 */

import { useWindowSize } from '@gpuix/react'
import type { PublicInstance } from '@gpuix/react'
import { useEffect, useRef } from 'react'

import { IconButton } from '../../ui/IconButton'
import { COLORS, FONT, GRAPH_LANE_COLORS, SIZES } from '../../ui/tokens'
import { parseRefNames, relativeTime } from '../format'
import type { GraphRow } from '../graph'
import { buildRowGraphics, graphColumnWidth, ROW_HEIGHT } from '../graphSvg'
import type { GitGraphStore } from '../store'
import { useGitGraphStore } from '../useGitGraphStore'

const DETAIL_WIDTH = 360
const TOOLBAR_H = 34
/** WorkspacePage tab 条（布局契约；列表高度 JS 计算用） */
const TAB_H = 30
/** 错误条高度（padding 8×2 + 12px 文字行） */
const ERROR_H = 33

/** ref 徽章样式（§3.3）：head=accent / branch=亮字 / remote=muted / tag=琥珀 */
function RefBadges({ row }: { row: GraphRow }) {
  const decors = parseRefNames(row.commit.refNames.join(', '))
  if (decors.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'row', gap: 4, flexShrink: 0, marginRight: 6 }}>
      {decors.map((d, i) => {
        const style =
          d.kind === 'head'
            ? { color: COLORS.accent, bg: COLORS.accentSoft, border: 'transparent' }
            : d.kind === 'tag'
              ? { color: COLORS.amber, bg: 'rgba(229, 192, 123, 0.10)', border: 'transparent' }
              : d.kind === 'remote'
                ? { color: COLORS.muted, bg: 'transparent', border: COLORS.borderSubtle }
                : { color: COLORS.textBright, bg: COLORS.surface, border: COLORS.borderSubtle }
        return (
          <text
            key={`${d.kind}-${d.label}-${i}`}
            testId={`git-ref-${d.kind}`}
            style={{
              fontSize: 10,
              fontFamily: FONT.mono,
              color: style.color,
              backgroundColor: style.bg,
              borderWidth: 1,
              borderColor: style.border,
              borderRadius: 999,
              paddingTop: 1,
              paddingBottom: 1,
              paddingLeft: 6,
              paddingRight: 6,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {d.label}
          </text>
        )
      })}
    </div>
  )
}

function GraphRow({
  row,
  index,
  lines,
  maxLanes,
  selected,
  rowWidth,
  onSelect,
}: {
  row: GraphRow
  index: number
  lines: readonly import('../graph').CommitLine[]
  maxLanes: number
  selected: boolean
  /** 行宽（窗口宽 - 详情列；list 行不吃百分比宽） */
  rowWidth: number
  onSelect: () => void
}) {
  const width = graphColumnWidth(maxLanes)
  const pieces = buildRowGraphics({
    row: index,
    lines,
    commitLane: row.lane,
    commitColorIdx: row.colorIdx,
    maxLanes,
  })
  return (
    <div
      testId={`git-row-${index}`}
      onClick={onSelect}
      style={{
        width: rowWidth,
        height: ROW_HEIGHT,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 8,
        paddingRight: 12,
        backgroundColor: selected ? COLORS.surface : undefined,
        borderLeftWidth: selected ? 2 : 0,
        borderColor: COLORS.accent,
        cursor: 'pointer',
        minWidth: 0,
      }}
    >
      {/* graph cell：按色分组的 svg 叠放（GPUI 树序绘制，后画的圆点盖线） */}
      <div
        style={{
          width,
          height: ROW_HEIGHT,
          position: 'relative',
          flexShrink: 0,
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
      <RefBadges row={row} />
      <text
        style={{
          fontSize: 13,
          fontFamily: FONT.ui,
          color: selected ? COLORS.textBright : COLORS.text,
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
        }}
      >
        {row.commit.subject}
      </text>
      <text
        style={{
          fontSize: 11,
          fontFamily: FONT.ui,
          color: COLORS.muted,
          width: 110,
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
          width: 72,
          flexShrink: 0,
          textAlign: 'right',
          marginLeft: 8,
        }}
      >
        {relativeTime(row.commit.timestamp)}
      </text>
    </div>
  )
}

/** diff 行着色（uni﷕diff 约定：+/绿 −/红 @@/accent 头部/muted）；nowrap + 外层横滚。
 *  一期自绘 —— gpuix <diff> 是 native custom element，TestRenderer 不绘制
 *  （同 markdown 的绘制限制），G4 真机验证后再评估换回。 */
function DiffBody({ patch, height }: { patch: string; height: number }) {
  const lines = patch.split('\n')
  return (
    <div style={{ height, overflow: 'scroll' }}>
      {lines.map((ln, i) => {
        // 注意顺序：---/+++ 必须先于 -/+ 判断（否则文件头误着红/绿）
        const isHeader =
          ln.startsWith('diff ') ||
          ln.startsWith('index ') ||
          ln.startsWith('---') ||
          ln.startsWith('+++')
        const color = isHeader
          ? COLORS.muted
          : ln.startsWith('@@')
            ? COLORS.accent
            : ln.startsWith('+')
              ? '#98c379'
              : ln.startsWith('-')
                ? '#e06c75'
                : COLORS.text
        return (
          <text
            key={i}
            style={{
              fontSize: 11,
              fontFamily: FONT.mono,
              color,
              whiteSpace: 'nowrap',
              height: 16,
            }}
          >
            {ln === '' ? ' ' : ln}
          </text>
        )
      })}
    </div>
  )
}

/** 详情列：提交头 + <diff> patch（现成元素；Esc 关闭在全局层） */
function DiffDetail({ store, sha }: { store: GitGraphStore; sha: string }) {
  // selector 返回整个 state（引用稳定）——禁止对象字面量（useSyncExternalStore
  // 不稳定 snapshot → 无限重渲染，threads/useThreadStore 同款纪律）
  const st = useGitGraphStore(store, (s) => s)
  // <diff scroll> 是虚拟化列表：不吃 flexGrow（同 virtual-list），给显式高度
  // = 窗口高 - 详情头部（subject 行 + meta 行 + padding，实测 ~76）
  const { height: winH } = useWindowSize()
  const bodyHeight = winH - SIZES.titleBarHeight - TAB_H - 76
  const row = st.rows.find((r) => r.commit.sha === sha)
  const shortSha = row?.commit.shortSha || sha.slice(0, 7)
  const subject = row?.commit.subject ?? ''
  const author = row?.commit.authorName ?? ''
  const timestamp = row?.commit.timestamp ?? 0
  return (
    <div
      testId="git-detail"
      style={{
        width: DETAIL_WIDTH,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeftWidth: 1,
        borderColor: COLORS.border,
        backgroundColor: COLORS.pane,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: 12,
          borderBottomWidth: 1,
          borderColor: COLORS.border,
          flexShrink: 0,
        }}
      >
        <text
          style={{
            fontSize: 13,
            fontFamily: FONT.ui,
            color: COLORS.textBright,
            whiteSpace: 'normal',
            minWidth: 0,
          }}
        >
          {subject}
        </text>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <text style={{ fontSize: 11, fontFamily: FONT.mono, color: COLORS.accent }}>
            {shortSha}
          </text>
          <text style={{ fontSize: 11, fontFamily: FONT.ui, color: COLORS.muted }}>
            {author} · {relativeTime(timestamp)}
          </text>
        </div>
      </div>
      <div
        style={{
          height: bodyHeight,
          overflow: 'scroll',
          padding: 8,
        }}
      >
        {st.patchLoading ? (
          <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted }}>加载 diff…</text>
        ) : st.patchError ? (
          <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.bell }}>
            {st.patchError}
          </text>
        ) : st.patch != null && st.patch !== '' ? (
          <DiffBody patch={st.patch} height={bodyHeight - 16} />
        ) : (
          <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted }}>无变更</text>
        )}
      </div>
    </div>
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
  /** 工具条显示名（workspace.name） */
  repoLabel: string
  /** 键盘导航的视口跟随（renderer.scrollToItem；缺省不跟随） */
  scrollToItem?: (elementId: number, index: number) => void
}) {
  const s = useGitGraphStore(store, (st) => st)
  const listRef = useRef<PublicInstance | null>(null)
  // gpui 的 list 不吃 flexGrow/absolute 拉伸（实测 B/D 实验，chat 消息区同病），
  // 只认显式 height —— 用窗口尺寸减已知 chrome（顶栏/tab 条/工具条/错误条）
  const { width: winW, height: winH } = useWindowSize()
  const listHeight =
    winH - SIZES.titleBarHeight - TAB_H - TOOLBAR_H - (s.status === 'error' ? ERROR_H : 0)
  const rowWidth = winW - (s.selectedSha ? DETAIL_WIDTH : 0)
  useEffect(() => {
    store.mount(cwd)
  }, [cwd, store])
  // 选中变化 → 视口跟随（↑↓ 跨视口行时关键）
  useEffect(() => {
    if (!s.selectedSha || !scrollToItem) return
    const index = s.rows.findIndex((r) => r.commit.sha === s.selectedSha)
    if (index >= 0 && listRef.current) scrollToItem(listRef.current.id, index)
    // rows 依赖：选中到达但列表刚流式更新时仍需滚
  }, [s.selectedSha, s.rows, scrollToItem])

  return (
    <div
      testId="git-graph-view"
      style={{
        flexGrow: 1,
        display: 'flex',
        flexDirection: 'row',
        minWidth: 0,
        backgroundColor: COLORS.pane,
      }}
    >
      <div
        style={{
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          position: 'relative',
        }}
      >
        {/* 工具条 */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            height: 34,
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
          <text
            testId="git-count"
            style={{ fontSize: 11, fontFamily: FONT.ui, color: COLORS.muted, flexGrow: 1 }}
          >
            {s.status === 'loading' && s.loadedCount === 0 ? '读取提交…' : `${s.loadedCount} 提交`}
          </text>
          <IconButton
            name="reset"
            label="刷新（R）"
            testId="git-refresh"
            onClick={() => store.refresh()}
          />
        </div>
        {s.status === 'error' ? (
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
              {s.error ?? 'git log 失败'}
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
          <virtual-list
            estimatedItemHeight={ROW_HEIGHT}
            style={{ height: Math.max(listHeight, ROW_HEIGHT) }}
          >
            {s.rows.map((row, i) => (
              <GraphRow
                key={row.commit.sha}
                row={row}
                index={i}
                lines={s.linesByRow.get(i) ?? []}
                maxLanes={s.maxLanes}
                selected={s.selectedSha === row.commit.sha}
                rowWidth={rowWidth}
                onSelect={() => store.select(row.commit.sha)}
              />
            ))}
          </virtual-list>
        )}
      </div>
      {s.selectedSha ? <DiffDetail store={store} sha={s.selectedSha} /> : null}
    </div>
  )
}
