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
}

export function fsAdapter(p: string): FileAdapter {
  return {
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
