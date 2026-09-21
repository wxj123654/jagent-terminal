/**
 * fs/readTextFile.ts — 截断式文本读取 adapter（共享 seam）。
 *
 * 两个真实消费方：git worktree 预览（WorkPanel/WorktreeStore.readFile）
 * 与 FileSurface 会话内文件预览——原为 git/deps.ts 私有实现，FileSurface
 * 借道 git/ 域取用；抽为共享 adapter 后 seam 转正（一 adapter 假设、
 * 两 adapter 成真）。
 *
 * 预览不是编辑器：512KB / 前 400 行截断；不可读（不存在/二进制/过大/
 * 目录）返回 null。
 */

import { readFile, stat } from 'node:fs/promises'

/** 预览上限：512KB / 前 400 行（面板是预览不是编辑器） */
const PREVIEW_MAX_BYTES = 512 * 1024
const PREVIEW_MAX_LINES = 400

export async function readTextFile(path: string): Promise<string | null> {
  try {
    const st = await stat(path)
    if (!st.isFile() || st.size > PREVIEW_MAX_BYTES) return null
    const text = await readFile(path, 'utf8')
    const lines = text.split('\n')
    return lines.length > PREVIEW_MAX_LINES ? lines.slice(0, PREVIEW_MAX_LINES).join('\n') : text
  } catch {
    return null
  }
}
