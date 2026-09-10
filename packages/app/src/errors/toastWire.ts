/**
 * errors/toastWire.ts — 总线 → Toast 即时通知（方案 A 可见面）。
 *
 * error/fatal 弹 4s toast（原型既有体系，无新 UI 原语）；warn 只进面板/
 * 徽章/日志（频繁警告弹 toast 会刷屏——settings 写失败已分区红条）。
 * main.tsx 装配一次；测试不接（Toast 有自身时序）。
 */

import { toast } from '@jagent/ui'
import { subscribeErrors } from './bus'

export function wireErrorToasts(): () => void {
  return subscribeErrors((e) => {
    if (e && (e.level === 'error' || e.level === 'fatal')) toast(e.message)
  })
}
