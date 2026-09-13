/**
 * diagnostics/frameOverlay.test.ts — settings → renderer 同步：初值应用、
 * 全量订阅去重、native 失败后下次订阅重试。
 */

import { describe, expect, test } from 'bun:test'

import type { SettingsStore } from '../../settings/store'
import { watchFrameOverlay } from '../frameOverlay'

function fakeSettings(frameOverlay: boolean) {
  const listeners: Array<() => void> = []
  let value = frameOverlay
  return {
    store: {
      get: () => ({ advanced: { frameOverlay: value } }),
      subscribe: (fn: () => void) => {
        listeners.push(fn)
        return () => {}
      },
    } as unknown as SettingsStore,
    emit: (next: boolean) => {
      value = next
      listeners.forEach((f) => f())
    },
    emitSame: () => listeners.forEach((f) => f()),
  }
}

describe('watchFrameOverlay', () => {
  test('初值应用一次 + 变化时才调 native（去重）', () => {
    const { store, emit, emitSame } = fakeSettings(true)
    const applied: string[] = []
    watchFrameOverlay({ setDebugFrameOverlay: (m) => void applied.push(m) }, store)
    expect(applied).toEqual(['full'])
    emitSame() // 全量回调但值未变 → 不调 native
    expect(applied).toEqual(['full'])
    emit(false)
    expect(applied).toEqual(['full', 'hidden'])
  })

  test('native 抛错时置空 applied：下次订阅重试同值', () => {
    const { store, emitSame } = fakeSettings(false)
    const applied: string[] = []
    let fail = true
    watchFrameOverlay(
      {
        setDebugFrameOverlay: (m) => {
          if (fail) throw new Error('native not ready')
          applied.push(m)
        },
      },
      store,
    )
    expect(applied).toEqual([])
    fail = false
    emitSame() // 同值重试成功
    expect(applied).toEqual(['hidden'])
  })
})
