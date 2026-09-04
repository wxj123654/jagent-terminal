/**
 * settings/file.ts — FileAdapter seam（architecture.md §6.2）。
 *
 * 真盘 adapter 用「同目录 tmp + rename」原子写：防写一半损坏
 * （rename 在 Windows 上 MOVEFILE_REPLACE_EXISTING，覆盖语义成立）。
 * memoryAdapter 供测试（含失败注入与落盘快照读回）。
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type FileAdapter = {
  /** 文件不存在返回 null；存在返回原文（坏 JSON 由调用方 parse 容错） */
  read(): Promise<string | null>
  /** 原子写（tmp + rename） */
  write(s: string): Promise<void>
  /** 真盘 adapter 携带实际路径（「在编辑器中打开」用）；memory 无 */
  readonly path?: string
}

export function fsAdapter(p: string): FileAdapter {
  return {
    path: p,
    async read(): Promise<string | null> {
      const { readFile } = await import('node:fs/promises')
      try {
        return await readFile(p, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    },
    async write(s: string): Promise<void> {
      // 首次运行（如 ~/.j-agent/）目录可能不存在——自建后再写
      await mkdir(dirname(p), { recursive: true })
      const tmp = `${p}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      await writeFile(tmp, s, 'utf8')
      await rename(tmp, p) // 同目录 → 同卷 → 原子替换
    },
  }
}

/**
 * 用系统关联程序打开 settings.json（Advanced「在编辑器中打开」；win32 的
 * `start` 走 .json 关联 = 默认编辑器）。异步 fire-and-forget，失败仅 warn
 * （UI 不因外部程序问题报错弹窗）。
 */
export async function openInSystemApp(p: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  try {
    if (process.platform === 'win32') {
      // cmd /c start "" "path"：空标题参防路径带空格被当标题
      spawn('cmd', ['/c', 'start', '', p], { stdio: 'ignore', detached: true })?.unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [p], { stdio: 'ignore', detached: true })?.unref()
    } else {
      spawn('xdg-open', [p], { stdio: 'ignore', detached: true })?.unref()
    }
  } catch (e) {
    console.warn('openInSystemApp failed:', e)
  }
}

export type MemoryAdapter = FileAdapter & {
  /** 已落盘内容（最后一次成功 write 的原文） */
  snapshot(): string | null
  /** 已写盘次数（合并写断言用） */
  writes(): number
  /** 注入写失败；null 清除 */
  setFailWrite(e: Error | null): void
}

export function memoryAdapter(initial: string | null = null): MemoryAdapter {
  let data = initial
  let n = 0
  let fail: Error | null = null
  return {
    async read() {
      return data
    },
    async write(s: string) {
      if (fail) throw fail
      data = s
      n++
    },
    snapshot: () => data,
    writes: () => n,
    setFailWrite: (e) => {
      fail = e
    },
  }
}
