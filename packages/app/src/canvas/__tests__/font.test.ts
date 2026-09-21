/**
 * canvas/__tests__/font.test.ts — CSS font shorthand 解析单测。
 * 合法输入 → {family,size,weight,italic}；非法 → null（setter 静默忽略）。
 */

import { describe, expect, test } from 'bun:test'
import { parseFontShorthand } from '../font'

describe('parseFontShorthand 合法输入', () => {
  test('最小形态 size + family', () => {
    expect(parseFontShorthand('10px sans-serif')).toEqual({
      family: 'sans-serif',
      size: 10,
      weight: 400,
      italic: false,
    })
  })

  test('全槽位：style weight size/line-height family 列表', () => {
    expect(parseFontShorthand('italic bold 12px/30px Georgia, serif')).toEqual({
      family: 'Georgia',
      size: 12,
      weight: 700,
      italic: true,
    })
  })

  test('oblique / small-caps / stretch 关键字识别', () => {
    expect(parseFontShorthand('oblique small-caps condensed 14px monospace')).toEqual({
      family: 'monospace',
      size: 14,
      weight: 400,
      italic: true,
    })
    // oblique 带角度
    expect(parseFontShorthand('oblique 10deg 12px serif')).toEqual({
      family: 'serif',
      size: 12,
      weight: 400,
      italic: true,
    })
  })

  test('数字 weight 与相对 weight', () => {
    expect(parseFontShorthand('300 12px serif')!.weight).toBe(300)
    expect(parseFontShorthand('900 12px serif')!.weight).toBe(900)
    expect(parseFontShorthand('bolder 12px serif')!.weight).toBe(700)
    expect(parseFontShorthand('lighter 12px serif')!.weight).toBe(300)
  })

  test('normal 关键字可出现在任意槽位', () => {
    expect(parseFontShorthand('normal normal normal 12px serif')).toEqual({
      family: 'serif',
      size: 12,
      weight: 400,
      italic: false,
    })
  })

  test('size 单位换算（基准 16px）', () => {
    expect(parseFontShorthand('12pt serif')!.size).toBe(16)
    expect(parseFontShorthand('1in serif')!.size).toBe(96)
    expect(parseFontShorthand('2em serif')!.size).toBe(32)
    expect(parseFontShorthand('150% serif')!.size).toBe(24)
    expect(parseFontShorthand('medium serif')!.size).toBe(16)
    expect(parseFontShorthand('larger serif')!.size).toBeCloseTo(19.2)
  })

  test('引号 family（含空格）与 family 列表', () => {
    expect(parseFontShorthand('12px "Helvetica Neue", Arial')!.family).toBe('Helvetica Neue')
    expect(parseFontShorthand("12px 'PingFang SC'")!.family).toBe('PingFang SC')
    // 未加引号的带空格 family
    expect(parseFontShorthand('12px Helvetica Neue')!.family).toBe('Helvetica Neue')
  })

  test('size/line-height 的三种书写', () => {
    expect(parseFontShorthand('12px/1.5 serif')!.size).toBe(12)
    expect(parseFontShorthand('12px / 1.5 serif')!.family).toBe('serif')
    expect(parseFontShorthand('12px/ 1.5 serif')!.family).toBe('serif')
  })
})

describe('parseFontShorthand 非法输入 → null', () => {
  test('缺 family / 缺 size / 空串 / 继承关键字 / 系统字体', () => {
    expect(parseFontShorthand('bold')).toBeNull()
    expect(parseFontShorthand('12px')).toBeNull()
    expect(parseFontShorthand('')).toBeNull()
    expect(parseFontShorthand('inherit')).toBeNull()
    expect(parseFontShorthand('initial')).toBeNull()
    expect(parseFontShorthand('caption')).toBeNull()
    expect(parseFontShorthand('not a font at all')).toBeNull()
    expect(parseFontShorthand('12px/ serif')).toBeNull()
  })

  test('未闭合引号 → null', () => {
    expect(parseFontShorthand('12px "Helvetica Neue')).toBeNull()
  })
})
