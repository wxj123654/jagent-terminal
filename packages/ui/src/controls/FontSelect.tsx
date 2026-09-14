/**
 * ui/FontSelect.tsx — 字体选择器（SearchSelect 的字体特化薄壳）。
 * 原型：design/j-agent-prototype.html `.font-pop`。
 *
 * 固定开启 SearchSelect 全部能力：searchable（弹层内搜索）+ virtualized
 * （系统字体数百项，<virtual-list> 只布局/绘制可视窗口）+ freeform
 * （「使用 "query"」自由输入兜底，保留任意字体名能力）。
 *
 * 字身预览：itemTextStyle 把每行 fontFamily 设为字体名本身——虚拟化后
 * shaping 只发生在 ~10 个可见行上（实测全量预览首开 ~4s → 虚拟化 ~100ms），
 * 预览成本可接受故保留。
 *
 * 依赖纪律：字体清单经 loadFonts 注入（app 侧 fonts.ts 接 native
 * listSystemFonts）；ui 不 import native。加载失败/无 loader → 空清单，
 * 自由输入兜底仍可用。
 */

import type { ReactElement } from 'react'

import { FONT } from '../theme/tokens'
import { SearchSelect } from './SearchSelect'
import type { SearchSelectLoader } from './SearchSelect'

export type FontLoader = () => Promise<string[]>

export function FontSelect({
  value,
  loadFonts,
  disabled = false,
  onChange,
  testId,
  width = 220,
}: {
  value: string
  /** 系统字体清单加载器（懒调用：首次打开才取）；缺省/失败 → 仅自由输入 */
  loadFonts?: FontLoader
  disabled?: boolean
  onChange: (next: string) => void
  testId: string
  /** 触发器宽度：数字 = 固定 px；'fill' = 撑满容器 */
  width?: number | 'fill'
}): ReactElement {
  const loadOptions: SearchSelectLoader | undefined = loadFonts
    ? async () => (await loadFonts()).map((name) => ({ value: name, label: name }))
    : undefined

  return (
    <SearchSelect
      value={value}
      loadOptions={loadOptions}
      searchable
      virtualized
      freeform
      itemTextStyle={(row) => ({ fontFamily: row.freeform ? FONT.mono : row.value })}
      freeformLabel={(q) => `使用 "${q}"`}
      searchPlaceholder="搜索字体…"
      emptyText="无匹配字体"
      loadingText="正在加载字体…"
      disabled={disabled}
      onChange={onChange}
      testId={testId}
      width={width}
    />
  )
}
