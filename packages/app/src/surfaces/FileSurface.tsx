/**
 * FileSurface — 会话内文件预览（最新原型 .file-surface；SessionTabs「打开
 * 文件」→ ThreadStore.openSessionFile 的目标面）。
 *
 * 真读盘：readFile 默认 fs/readTextFile 的 512KB/前 400 行截断适配器
 * （与 WorkPanel 预览同一边界——预览不是编辑器）。相对路径按 base
 * （会话 cwd / 归属工作区 path）解析为绝对路径后读。
 *
 * 视觉：32px 路径条（file 图标 + mono 路径）+ 行号代码区（mono 11px，
 * 行号 34px 右对齐列）。
 */

import { isAbsolute, resolve } from 'node:path'
import { useEffect, useState } from 'react'

import { Icon, COLORS, FONT } from '@jagent/ui'
import { readTextFile } from '../fs/readTextFile'

export function FileSurface({
  path,
  base,
  readFile = readTextFile,
}: {
  /** 视图记录的路径（worktree 变更文件多为仓库相对路径） */
  path: string
  /** 相对路径的解析基准（会话 cwd / 工作区 path；null → 进程 CWD） */
  base: string | null
  /** 文件读取 seam（测试注假；默认 fs/readTextFile 截断适配器） */
  readFile?: (absPath: string) => Promise<string | null>
}) {
  const abs = isAbsolute(path) ? path : resolve(base ?? '', path)
  // undefined = 加载中；null = 不可读（二进制/过大/不存在）；string = 内容
  const [text, setText] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    setText(undefined)
    void readFile(abs).then((r) => {
      if (live) setText(r)
    })
    return () => {
      live = false
    }
  }, [abs, readFile])

  const lines = text == null ? [] : text.split('\n')
  return (
    <div
      testId="file-surface"
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        minWidth: 0,
        minHeight: 0,
        backgroundColor: COLORS.pane,
      }}
    >
      {/* 路径条（原型 .file-pathbar：32px / 0 12 / 下边框） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          height: 32,
          flexShrink: 0,
          paddingLeft: 12,
          paddingRight: 12,
          borderBottomWidth: 1,
          borderColor: COLORS.border,
          color: COLORS.muted,
        }}
      >
        <Icon name="file" size={12} />
        <text
          style={{
            minWidth: 0,
            fontSize: 11.5,
            fontFamily: FONT.mono,
            color: COLORS.muted,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {path}
        </text>
      </div>

      {/* 代码区（原型 .code-view：mono 11 / lh 1.55 / 行号列） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          minHeight: 0,
          overflow: 'scroll',
          paddingTop: 8,
          paddingBottom: 8,
          fontFamily: FONT.mono,
          fontSize: 11,
          lineHeight: 17,
        }}
      >
        {text === undefined ? (
          <Hint text="加载中…" />
        ) : text === null ? (
          <Hint text="无法预览（不存在 / 二进制 / 超过 512KB）" />
        ) : (
          lines.map((l, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'row' }}>
              <text
                style={{
                  width: 34,
                  flexShrink: 0,
                  textAlign: 'right',
                  paddingRight: 10,
                  color: COLORS.muted,
                  pointerEvents: 'none',
                }}
              >
                {String(i + 1)}
              </text>
              <text style={{ color: COLORS.text, whiteSpace: 'nowrap' }}>{l || ' '}</text>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function Hint({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', padding: 24 }}>
      <text style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted }}>{text}</text>
    </div>
  )
}
