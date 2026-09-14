/**
 * range-shot.mjs — RangeInput 滑条截图（TestGpuixRenderer 离屏渲染 → PNG）。
 *
 * 跑法：bun run scripts/range-shot.mjs [outDir]
 * 产物：outDir（默认 .shots/）下 range-{min,mid,max,disabled}.png + range-all.png
 *
 * 原理：createTestRoot 走真 GPUI 渲染管线（Windows DirectX 离屏窗口），
 * renderer.captureScreenshot 把当前帧存成 PNG——与真实 app 同一套绘制。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createTestRoot } from '@gpuix/react/testing'
import { createElement as h } from 'react'

import { RangeInput, COLORS, FONT } from './src/index.ts'

const outDir = process.argv[2] ?? '.shots'
mkdirSync(outDir, { recursive: true })

const t = createTestRoot({ width: 640, height: 480 })

const row = (label, props) =>
  h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
        paddingTop: 14,
        paddingBottom: 14,
      },
    },
    h(
      'text',
      { style: { width: 110, fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted } },
      label,
    ),
    h(RangeInput, props),
  )

const scene = (extra) =>
  h(
    'div',
    {
      style: {
        width: 640,
        height: 480,
        backgroundColor: COLORS.pane,
        display: 'flex',
        flexDirection: 'column',
        padding: 24,
      },
    },
    row('min (200)', {
      value: 200,
      min: 200,
      max: 400,
      step: 2,
      onChange: () => {},
      testId: 'r-min',
      format: (v) => `${v}px`,
    }),
    row('mid (264)', {
      value: 264,
      min: 200,
      max: 400,
      step: 2,
      onChange: () => {},
      testId: 'r-mid',
      format: (v) => `${v}px`,
    }),
    row('max (400)', {
      value: 400,
      min: 200,
      max: 400,
      step: 2,
      onChange: () => {},
      testId: 'r-max',
      format: (v) => `${v}px`,
    }),
    row('disabled', {
      value: 300,
      min: 200,
      max: 400,
      step: 2,
      disabled: true,
      onChange: () => {},
      testId: 'r-dis',
      format: (v) => `${v}px`,
    }),
    ...(extra ? [extra] : []),
  )

t.render(scene())
t.renderer.flush()
await new Promise((r) => setTimeout(r, 50))
const file = join(outDir, 'range-all.png')
t.renderer.captureScreenshot(file)
console.log('saved:', file)
t.unmount()
