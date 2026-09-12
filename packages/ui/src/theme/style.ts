/**
 * ui/style.ts — 控件共享样式片段（architecture.md §7）。
 *
 * GPUIX 平台事实：StyleDesc 只有 hover/active 伪类，没有 :focus-visible；
 * focus 环由各控件的 onFocus/onBlur state 驱动，统一走这里的 focusRing()
 * （原型 --accent-soft 的 2px 环；GPUI BoxShadow 无 inset，用 spread 外扩近似）。
 */

import type { StyleDesc } from '@gpuix/react'

import { COLORS, FONT } from './tokens'

/** focus 环：0 blur + spread 2 = 原型 `box-shadow: 0 0 0 2px accent-soft` 的硬边近似 */
export function focusRing(color: string = COLORS.accentSoft): {
  offsetX: number
  offsetY: number
  blurRadius: number
  spreadRadius: number
  color: string
} {
  return { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 2, color }
}

/** 表单控件通用盒：凹陷底 + subtle 边（原型 .row-ctrl input/select 基态） */
export function controlBox(focused: boolean, disabled: boolean = false): StyleDesc {
  return {
    backgroundColor: COLORS.inputBg,
    borderWidth: 1,
    borderColor: focused ? COLORS.focusBorder : COLORS.borderSubtle,
    borderRadius: 4,
    boxShadow: focused ? focusRing() : undefined,
    opacity: disabled ? 0.5 : 1,
  }
}

/** 表单控件通用文字。
 *  lineHeight 必须显式：gpuix input/textarea 的 caret 与行高取元素自身
 *  text style 的 line_height（修复后随捕获 style 计算），不设则继承
 *  phi 比例——对 12.5px 字约 20px，在 28px 控件里 caret 视觉上几乎占满。
 *  取 1.36×字号 ≈ web normal 的紧凑行高，caret 与文字视觉等高。 */
export const controlText = (mono: boolean = false): StyleDesc => ({
  fontSize: 12.5,
  lineHeight: 17,
  fontFamily: mono ? FONT.mono : FONT.ui,
  color: COLORS.textBright,
})
