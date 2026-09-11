import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestRoot } from '@gpuix/react/testing'

const PATCH = join(
  import.meta.dir,
  '../../../patches/gpuix-zed/0002-hide-offscreen-test-window.patch',
)

test('Windows show:true path pins an explicit ShowWindow against STARTUPINFO SW_HIDE', () => {
  const patch = readFileSync(PATCH, 'utf8')
  expect(patch).toContain('ShowWindow(')
  expect(patch).toContain('SW_SHOWNORMAL')
  expect(patch).toContain('SW_SHOWNOACTIVATE')
})

test('TestGpuixRenderer stays hidden on Windows', () => {
  const t = createTestRoot({ width: 320, height: 200 })
  try {
    t.render(
      <div style={{ width: 320, height: 200 }}>
        <text>hidden test window</text>
      </div>,
    )
    expect(t.renderer.getWindowSize()).toEqual({ width: 320, height: 200 })
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-Process -Id ${process.pid} | Select-Object -ExpandProperty MainWindowHandle`,
        ],
        { encoding: 'utf8' },
      ).trim()
      expect(out === '0' || out === '').toBe(true)
    }
  } finally {
    t.unmount()
  }
})
