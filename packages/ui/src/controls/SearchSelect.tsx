/**
 * ui/SearchSelect.tsx — 通用搜索下拉选择器（Zed 式：触发器 → 弹层内可选
 * 搜索框 + 选项列表）。FontSelect 的基座；原型 design/j-agent-prototype.html
 * `.font-pop`。
 *
 * 封装 @gpuix/react headless Combobox 族（anchored 悬浮层、外点关闭、
 * ↑↓/enter/esc 键盘导航内建）。相对 SelectField 的三个增量能力（可独立开关）：
 *
 * - `searchable`：弹层顶部搜索框，过滤排序 startsWith 优先于 includes
 *   （与 Combobox defaultFilter 同序；组件内预排 + filter={null}，使
 *   虚拟列表的可见窗口与键盘导航的 filteredItems 始终一致）。关闭时仍挂
 *   一个隐形 input 保住 ↑↓/enter/esc 键盘导航。
 * - `virtualized`：选项走内建 <virtual-list>——children 全挂载（ComboboxItem
 *   注册/高亮不受影响），只布局/绘制可视窗口的行。大清单（系统字体数百项）
 *   必选；高亮项移出视口时 scrollToItem 跟随（上沿顶对齐 / 下沿底对齐）。
 * - `freeform`：query 无精确匹配时尾部追加「使用 "query"」行，允许提交
 *   清单外任意值。
 *
 * 选项来源：`options` 静态数组，或 `loadOptions` 懒加载（首次打开调用一次；
 * 失败/缺省 → 空清单，freeform 下仍可自由输入）。
 * `itemTextStyle` 钩子按行给文字样式（FontSelect 用它做字身预览——虚拟化后
 * 预览成本只落在 ~10 个可见行，不再全量 shaping）。
 */

import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxTrigger,
  ComboboxValue,
  useGpuix,
} from '@gpuix/react'
import type { PublicInstance, StyleDesc } from '@gpuix/react'
import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { Icon } from '../display/Icon'
import { inputFocus } from '../keyboard'
import { controlText, focusRing } from '../theme/style'
import { COLORS, FONT } from '../theme/tokens'

/** 弹层宽度（原型 280） */
const POP_WIDTH = 280
/** 行高（虚拟列表 estimatedItemHeight 与滚动跟随计算共用） */
const ROW_H = 26
/** 列表最大高（超出滚动） */
const LIST_MAX_H = 264

export type SearchSelectOption = string | { value: string; label?: string }
export type SearchSelectLoader = () => Promise<SearchSelectOption[]>

type Row = { value: string; label: string; freeform?: boolean }

function normalize(options: SearchSelectOption[]): { value: string; label: string }[] {
  return options.map((o) =>
    typeof o === 'string' ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value },
  )
}

/** startsWith 优先于 includes，各自保持原序（同 Combobox defaultFilter） */
function rankRows(rows: { value: string; label: string }[], query: string): Row[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  const scored: { row: Row; rank: number; i: number }[] = []
  rows.forEach((row, i) => {
    const l = row.label.toLowerCase()
    const rank = l.startsWith(q) ? 0 : l.includes(q) ? 1 : -1
    if (rank >= 0) scored.push({ row, rank, i })
  })
  return scored.sort((a, b) => a.rank - b.rank || a.i - b.i).map((s) => s.row)
}

/** 高亮跟随：行被键盘高亮且不在视口内时滚动到它（effect 里做，非渲染期副作用） */
function HighlightFollow({
  highlighted,
  index,
  scrollTo,
  children,
}: {
  highlighted: boolean
  index: number
  scrollTo: (index: number) => void
  children: ReactNode
}): ReactElement {
  useEffect(() => {
    if (highlighted) scrollTo(index)
  }, [highlighted, index, scrollTo])
  return <>{children}</>
}

export function SearchSelect({
  value,
  options,
  loadOptions,
  searchable = true,
  virtualized = false,
  freeform = false,
  itemTextStyle,
  freeformLabel = (q) => `使用 "${q}"`,
  searchPlaceholder = '搜索…',
  emptyText = '无匹配结果',
  loadingText = '正在加载…',
  disabled = false,
  onChange,
  testId,
  width = 220,
}: {
  value: string
  options?: SearchSelectOption[]
  /** 懒加载选项（首次打开调用一次）；与 options 二选一 */
  loadOptions?: SearchSelectLoader
  /** 弹层内搜索框；默认 true。false 时仍挂隐形 input 保键盘导航 */
  searchable?: boolean
  /** 大清单虚拟滚动（<virtual-list>）；默认 false 走普通滚动 div */
  virtualized?: boolean
  /** 允许提交清单外任意值（尾部「使用 "query"」行）；默认 false */
  freeform?: boolean
  /** 每行文字样式钩子（字体预览等）；在默认样式之后合并 */
  itemTextStyle?: (row: Row) => StyleDesc
  /** 自由输入行的文案 */
  freeformLabel?: (query: string) => string
  searchPlaceholder?: string
  emptyText?: string
  loadingText?: string
  disabled?: boolean
  onChange: (next: string) => void
  testId: string
  /** 触发器宽度：数字 = 固定 px；'fill' = 撑满容器 */
  width?: number | 'fill'
}): ReactElement {
  const { renderer } = useGpuix()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [loaded, setLoaded] = useState<SearchSelectOption[] | null>(null)
  const [focused, setFocused] = useState(false)
  /** inputFocus 配对计数：弹层内 input 的 acquire 在关闭/卸载时补 release */
  const focusHeld = useRef(false)
  const listRef = useRef<PublicInstance | null>(null)

  const releaseFocus = () => {
    if (focusHeld.current) {
      focusHeld.current = false
      inputFocus.release()
    }
  }
  useEffect(() => releaseFocus, [])

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setQuery('')
      if (loaded === null && loadOptions) void loadOptions().then(setLoaded)
    } else {
      releaseFocus()
    }
  }

  // 候选清单：当前值不在选项里时并到最前（仍可搜到/选中/显示 ✓）；
  // freeform 且 query 无精确匹配时尾部追加自由输入行。
  const norm = normalize(options ?? loaded ?? [])
  const withCurrent =
    value && !norm.some((o) => o.value === value) ? [{ value, label: value }, ...norm] : norm
  const ranked = rankRows(withCurrent, searchable ? query : '')
  const q = query.trim()
  if (
    freeform &&
    searchable &&
    q &&
    !withCurrent.some((o) => o.label.toLowerCase() === q.toLowerCase())
  ) {
    ranked.push({ value: q, label: freeformLabel(q), freeform: true })
  }

  const items = ranked.map((r) => r.value)
  const labelOf = new Map(ranked.map((r) => [r.value, r.label]))
  const loading = loadOptions !== undefined && loaded === null && options === undefined

  /** 高亮项滚入视口：已在视口内不动（避免 hover/同屏导航时跳动） */
  const scrollRowIntoView = (index: number) => {
    const id = listRef.current?.id
    if (id == null || !renderer) return
    if (virtualized) {
      const anchor = renderer.getListScrollTop?.(id)
      if (anchor) {
        const [first, off, vh] = anchor
        const last = first + Math.floor((vh + off) / ROW_H)
        if (index >= first && index <= last) return
        // 目标在上方 → 顶对齐；在下方 → 底对齐（offsetInItem 负值 = 视口顶在 item 上方 N px）
        renderer.scrollToItem?.(id, index, index < first ? 0 : -(vh - ROW_H))
        return
      }
      renderer.scrollToItem?.(id, index)
      return
    }
    const off = renderer.getScrollOffset?.(id)
    if (off) {
      const top = -off[1]
      const itemTop = index * ROW_H
      if (itemTop >= top && itemTop + ROW_H <= top + LIST_MAX_H) return
    }
    renderer.scrollToItem?.(id, index)
  }

  // 打开时把当前选中项滚入视口（仅打开瞬间一次）
  useEffect(() => {
    if (!open) return
    const idx = ranked.findIndex((r) => r.value === value)
    if (idx > 0) {
      const id = listRef.current?.id
      if (id != null) renderer?.scrollToItem?.(id, idx)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开瞬间执行一次
  }, [open])

  const searchInput = (
    <ComboboxInput
      testId={searchable ? `${testId}-search` : undefined}
      placeholder={searchable ? searchPlaceholder : undefined}
      onFocus={() => {
        focusHeld.current = true
        inputFocus.acquire()
      }}
      onBlur={releaseFocus}
      style={
        searchable
          ? { flexGrow: 1, minWidth: 0, ...controlText() }
          : { height: 0, width: 0, opacity: 0 }
      }
    />
  )

  const renderRow = (row: Row, i: number) => (
    <ComboboxItem
      key={row.value}
      value={row.value}
      testId={`${testId}-item-${row.value}`}
      style={({ highlighted }) => ({
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        // virtual-list 子项不默认 stretch——不显式给宽会 shrink-wrap 成
        // 内容宽，高亮底只包住文字（实测截图确认）
        width: '100%',
        height: ROW_H,
        flexShrink: 0,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 4,
        backgroundColor: highlighted ? COLORS.surfaceHover : 'transparent',
      })}
    >
      {(state) => (
        <HighlightFollow highlighted={state.highlighted} index={i} scrollTo={scrollRowIntoView}>
          <div style={{ width: 14, flexShrink: 0, display: 'flex', color: COLORS.accent }}>
            {state.selected ? <Icon name="check" size={12} /> : null}
          </div>
          <text
            style={{
              flexGrow: 1,
              minWidth: 0,
              fontSize: row.freeform ? 12 : 12.5,
              lineHeight: 17,
              fontFamily: row.freeform ? FONT.mono : FONT.ui,
              color: state.selected
                ? COLORS.accent
                : row.freeform
                  ? COLORS.textBright
                  : COLORS.text,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              ...itemTextStyle?.(row),
            }}
          >
            {row.label}
          </text>
        </HighlightFollow>
      )}
    </ComboboxItem>
  )

  return (
    <Combobox
      value={value}
      items={items}
      itemToStringValue={(v) => labelOf.get(v) ?? v}
      filter={null}
      autoHighlight="always"
      open={open}
      onOpenChange={handleOpenChange}
      inputValue={query}
      onInputValueChange={searchable ? setQuery : () => {}}
      onValueChange={(v) => {
        if (typeof v === 'string') onChange(v)
      }}
      disabled={disabled}
    >
      <ComboboxTrigger
        testId={testId}
        onFocus={() => {
          setFocused(true)
          inputFocus.acquire()
        }}
        onBlur={() => {
          setFocused(false)
          inputFocus.release()
        }}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: width === 'fill' ? '100%' : width,
          height: 28,
          paddingLeft: 9,
          paddingRight: 6,
          borderRadius: 4,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          backgroundColor: COLORS.inputBg,
          borderWidth: 1,
          borderColor: open || focused ? COLORS.focusBorder : COLORS.borderSubtle,
          boxShadow: focused && !open ? focusRing() : undefined,
          hover: disabled ? undefined : { borderColor: COLORS.focusBorder },
        }}
      >
        <ComboboxValue placeholder="—">
          <text
            style={{
              ...controlText(true),
              color: disabled ? COLORS.muted : COLORS.textBright,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {value}
          </text>
        </ComboboxValue>
        <Icon name="chevronDown" size={13} color={COLORS.muted} />
      </ComboboxTrigger>

      <ComboboxContent
        side="bottom"
        sideOffset={4}
        align="start"
        testId={`${testId}-menu`}
        style={{
          width: POP_WIDTH,
          paddingTop: 4,
          paddingBottom: 4,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: COLORS.borderSubtle,
          backgroundColor: COLORS.overlay,
        }}
      >
        {searchable ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              height: 28,
              paddingLeft: 8,
              paddingRight: 8,
              borderBottomWidth: 1,
              borderColor: COLORS.border,
            }}
          >
            <Icon name="search" size={12} color={COLORS.muted} />
            {searchInput}
          </div>
        ) : (
          searchInput
        )}

        {virtualized ? (
          <virtual-list
            ref={listRef}
            testId={`${testId}-list`}
            estimatedItemHeight={ROW_H}
            overdraw={4}
            style={{
              height: Math.min(ranked.length * ROW_H, LIST_MAX_H),
              width: '100%',
              marginTop: 4,
            }}
          >
            {ranked.map(renderRow)}
          </virtual-list>
        ) : (
          <div
            ref={listRef}
            testId={`${testId}-list`}
            style={{ maxHeight: LIST_MAX_H, overflowY: 'scroll', paddingTop: 4 }}
          >
            {ranked.map(renderRow)}
          </div>
        )}

        {ranked.length === 0 ? (
          <div style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}>
            <text
              style={{
                fontSize: 11.5,
                fontFamily: FONT.ui,
                color: COLORS.muted,
                whiteSpace: 'nowrap',
              }}
            >
              {loading ? loadingText : emptyText}
            </text>
          </div>
        ) : null}
      </ComboboxContent>
    </Combobox>
  )
}
