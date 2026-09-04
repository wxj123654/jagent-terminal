/**
 * threads/terminal.ts — terminal thread 的纯函数（bun test 直测，零依赖）。
 */

import type { TerminalThread } from './store'

/**
 * 展示标题四级兜底（布局契约 §4，一字不改）：
 * customTitle ?? oscTitle ?? initCommand ?? "Terminal"
 * customTitle 手改后冻结——不再被 OSC 覆盖（规则在 store 的 onSessionEvent）。
 */
export function displayTitle(t: Pick<TerminalThread, 'customTitle' | 'oscTitle' | 'initCommand'>): string {
  return t.customTitle ?? t.oscTitle ?? t.initCommand ?? 'Terminal'
}
