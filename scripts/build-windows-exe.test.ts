/**
 * scripts/build-windows-exe.test.ts — Windows 产物收尾步骤的接线测试。
 *
 * 覆盖 README「Windows：GUI 子系统 / 图标资源」两条打包约定：
 *   1. PE Subsystem 必须被改成 GUI（否则双击多一个终端窗口）；
 *   2. RT_GROUP_ICON 各组必须指向含帧最多的 blob（否则任务栏用 16px 放大发糊）。
 *
 * 直接对合成 PE 跑 build.ts 用的同一组函数，断言收尾顺序与幂等性，不依赖
 * 真实的 137MB 产物。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeIconFixture } from './pe-fixture'
import { listIconGroups, patchIconResources } from './pe-icon-resources'
import {
  describeSubsystem,
  IMAGE_SUBSYSTEM_WINDOWS_GUI,
  patchWindowsGuiSubsystem,
  readPeSubsystem,
} from './pe-subsystem'

describe('Windows 产物收尾（build.ts 实际调用的两步）', () => {
  test('GUI 子系统 + 图标组修正：两步都生效且可重复执行', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jagent-exe-'))
    try {
      const file = join(dir, 'jagent.exe')
      await writeFile(file, makeIconFixture().buf)

      // ① 图标资源（序号 + 帧声明；与 build 里 subsystem 步骤前后紧邻）
      const patch = patchIconResources(file)
      expect(patch.ordinalFix).toEqual({ name: '#0', from: 0, to: 1 })
      expect(patch.frameFixes.map((f) => `${f.name}:${f.fromFrames}→${f.toFrames}`)).toEqual([
        'IDI_MYICON:1→7',
      ])
      // ② Subsystem
      const subsystem = patchWindowsGuiSubsystem(file)
      expect(subsystem.changed).toBe(true)
      expect(describeSubsystem(subsystem.to)).toBe(`${IMAGE_SUBSYSTEM_WINDOWS_GUI}=GUI`)

      const bytes = await readFile(file)
      expect(readPeSubsystem(bytes)).toBe(IMAGE_SUBSYSTEM_WINDOWS_GUI)
      expect(listIconGroups(bytes).map((g) => [g.ordinal, g.frames])).toEqual([
        [null, 7],
        [1, 7],
      ])

      // 再跑一遍（打包重复执行 / CI 重跑）：两步都应当自报无需改动
      const again = patchIconResources(file)
      expect(again.ordinalFix).toBeNull()
      expect(again.frameFixes).toEqual([])
      expect(patchWindowsGuiSubsystem(file).changed).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
