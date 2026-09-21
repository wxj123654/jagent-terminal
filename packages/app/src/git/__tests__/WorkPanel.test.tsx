/**
 * git/__tests__/WorkPanel.test.tsx — 工作面板（R5；原型 #work-panel）。
 *
 * 组件级渲染（不挂 App 整树）：假 WorktreeStore deps 注两个变更文件 +
 * 一条 patch + 一段预览。锁：两 tab 行形态（徽章行 / 图标行）、选中 →
 * diff/预览、hint 态、overlay 宽度夹取、拖拽把手、关闭/刷新回调。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { WorkPanel, type WorkPanelTab } from '../components/WorkPanel'
import { createWorktreeStore, type WorktreeStore } from '../worktree'

let t: TestRoot

afterEach(() => {
  t?.unmount()
})

const FILES = [
  { path: 'src/a.ts', status: 'm' as const, added: 3, deleted: 1 },
  { path: 'src/deep/b.ts', status: 'a' as const, added: 9, deleted: 0 },
  { path: 'old/c.ts', status: 'd' as const, added: 0, deleted: 7 },
]
const PATCH =
  'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n ctx\n-old\n+new'
const PREVIEW = 'line one\nline two\n'

function setup(opts: {
  tab?: WorkPanelTab
  overlay?: boolean
  files?: typeof FILES
  status?: 'ok' | 'not-a-repo'
  onClose?: () => void
  onWidthChange?: (w: number) => void
}): { worktree: WorktreeStore; widths: number[] } {
  const flags = { widths: [] as number[] }
  const worktree = createWorktreeStore({
    status: async () =>
      opts.status === 'not-a-repo'
        ? null
        : { root: '/repo', branch: 'main', files: opts.files ?? FILES },
    diff: async (_root, path) => (path === 'src/a.ts' ? PATCH : ''),
    readFile: async (abs) => (abs.endsWith('src/a.ts') ? PREVIEW : null),
  })
  worktree.mount('/repo')
  t = createTestRoot({ width: 1000, height: 700 })
  t.render(
    createElement(WorkPanel, {
      worktree,
      width: 280,
      overlay: opts.overlay ?? false,
      overlayMaxWidth: 420,
      tab: opts.tab ?? 'changes',
      onTabChange: () => {},
      onClose: () => opts.onClose?.(),
      onWidthChange: (w) => {
        flags.widths.push(w)
        opts.onWidthChange?.(w)
      },
      windowWidth: 1000,
    }),
  )
  t.renderer.flush()
  return { worktree, widths: flags.widths }
}

const has = (testId: string) => t.renderer.findByTestId(testId) != null
const texts = () => t.renderer.getAllText()

function click(testId: string) {
  const el = t.renderer.findByTestId(testId)
  if (!el) throw new Error(`not found: ${testId}`)
  const b = t.renderer.getElementBounds(el.id)!
  t.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2, 0)
  t.renderer.flush()
}

async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
    t.renderer.flush()
  }
}

describe('WorkPanel：变更 tab', () => {
  test('汇总行 + 徽章行（M/A/D）渲染；点击行 → select', async () => {
    const { worktree } = setup({})
    await until(() => texts().some((s) => s.includes('3 个文件 +12 −8')))
    expect(has('panel-file-src/a.ts')).toBe(true)
    expect(texts()).toContain('M')
    expect(texts()).toContain('A')
    expect(texts()).toContain('D')
    click('panel-file-src/a.ts')
    expect(worktree.getState().selected).toBe('src/a.ts')
  })

  test('选中文件 → 内联 diff（hunk/add/del 行文本可见）', async () => {
    setup({})
    await until(() => has('panel-file-src/a.ts'))
    click('panel-file-src/a.ts')
    await until(() => texts().some((s) => s.includes('@@ -1,2 +1,3 @@')))
    expect(texts().some((s) => s.includes('+new'))).toBe(true)
    expect(texts().some((s) => s.includes('-old'))).toBe(true)
  })

  test('未跟踪/无 diff 文件 → 提示文案', async () => {
    setup({})
    await until(() => has('panel-file-src/deep/b.ts'))
    click('panel-file-src/deep/b.ts')
    await until(() => texts().some((s) => s.includes('未跟踪文件——无 diff')))
  })

  test('非 git 仓库 → 提示', async () => {
    setup({ status: 'not-a-repo' })
    await until(() => texts().some((s) => s.includes('不是 Git 仓库')))
  })

  test('idle（未挂载 cwd，如主页/设置路由开面板）→ 中性提示而非误报干净', async () => {
    const worktree = createWorktreeStore({
      status: async () => ({ root: '/r', branch: 'm', files: [] }),
      diff: async () => '',
      readFile: async () => null,
    })
    // 不 mount：status 停 'idle'
    t = createTestRoot({ width: 1000, height: 700 })
    t.render(
      createElement(WorkPanel, {
        worktree,
        width: 280,
        overlay: false,
        overlayMaxWidth: 420,
        tab: 'changes',
        onTabChange: () => {},
        onClose: () => {},
        windowWidth: 1000,
      }),
    )
    t.renderer.flush()
    await until(() => texts().some((s) => s.includes('没有打开的工作区')))
    expect(texts().some((s) => s.includes('工作区干净'))).toBe(false)
  })
})

describe('WorkPanel：文件 tab', () => {
  test('文件表渲染（同一 files 列表）+ 未选中提示', async () => {
    setup({ tab: 'files' })
    await until(() => has('panel-file-src/a.ts'))
    expect(has('panel-file-src/deep/b.ts')).toBe(true)
    expect(texts().some((s) => s.includes('选择一个文件查看内容'))).toBe(true)
  })

  test('选中文件 → 文件头路径 + 预览行（行号 + 内容）', async () => {
    const { worktree } = setup({ tab: 'files' })
    await until(() => has('panel-file-src/a.ts'))
    click('panel-file-src/a.ts')
    await until(() => texts().some((s) => s.includes('line one')))
    expect(worktree.getState().selected).toBe('src/a.ts')
    expect(texts().some((s) => s.includes('src/a.ts'))).toBe(true)
    expect(texts().some((s) => s.includes('line two'))).toBe(true)
  })

  test('空文件表 → 「工作区没有文件。」', async () => {
    setup({ tab: 'files', files: [] })
    await until(() => texts().some((s) => s.includes('工作区没有文件')))
  })
})

describe('WorkPanel：壳（overlay / 拖拽 / 头钮）', () => {
  test('overlay 态宽度夹到 overlayMaxWidth 且不渲染把手', async () => {
    setup({ overlay: true })
    await until(() => has('work-panel'))
    // getElementBounds = content-box：280 含 1px 左边线 → 279
    const el = t.renderer.findByTestId('work-panel')!
    expect(t.renderer.getElementBounds(el.id)!.width).toBe(279)
    expect(has('work-panel-resize')).toBe(false)
  })

  test('overlay 态：width > overlayMaxWidth 时夹到上限', async () => {
    const worktree = createWorktreeStore({
      status: async () => ({ root: '/r', branch: 'm', files: [] }),
      diff: async () => '',
      readFile: async () => null,
    })
    worktree.mount('/r')
    t = createTestRoot({ width: 1000, height: 700 })
    t.render(
      createElement(WorkPanel, {
        worktree,
        width: 700,
        overlay: true,
        overlayMaxWidth: 420,
        tab: 'changes',
        onTabChange: () => {},
        onClose: () => {},
        windowWidth: 1000,
      }),
    )
    t.renderer.flush()
    const el = t.renderer.findByTestId('work-panel')!
    expect(t.renderer.getElementBounds(el.id)!.width).toBe(419)
  })

  test('左缘把手拖拽 → onWidthChange（244–720 夹取）', async () => {
    const { widths } = setup({})
    await until(() => has('work-panel-resize'))
    const el = t.renderer.findByTestId('work-panel-resize')!
    const b = t.renderer.getElementBounds(el.id)!
    t.renderer.nativeSimulateMouseDown(b.x + 3, b.y + 100, 0)
    t.renderer.nativeSimulateMouseMove(300, b.y + 100, 0) // → 1000-300=700
    t.renderer.nativeSimulateMouseMove(50, b.y + 100, 0) // → 950 夹到 720
    t.renderer.nativeSimulateMouseMove(900, b.y + 100, 0) // → 100 夹到 244
    t.renderer.nativeSimulateMouseUp(900, b.y + 100, 0)
    t.renderer.flush()
    expect(widths).toContain(700)
    expect(widths).toContain(720)
    expect(widths).toContain(244)
  })

  test('关闭钮 → onClose；刷新钮 → 重新拉 status', async () => {
    let statusCalls = 0
    const worktree = createWorktreeStore({
      status: async () => {
        statusCalls++
        return { root: '/r', branch: 'm', files: [] }
      },
      diff: async () => '',
      readFile: async () => null,
    })
    worktree.mount('/r')
    t = createTestRoot({ width: 1000, height: 700 })
    let closed = false
    t.render(
      createElement(WorkPanel, {
        worktree,
        width: 280,
        overlay: false,
        overlayMaxWidth: 420,
        tab: 'changes',
        onTabChange: () => {},
        onClose: () => {
          closed = true
        },
        windowWidth: 1000,
      }),
    )
    t.renderer.flush()
    await until(() => has('work-panel-close'))
    click('work-panel-close')
    expect(closed).toBe(true)
    click('work-panel-refresh')
    await until(() => statusCalls >= 2)
  })
})
