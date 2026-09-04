/**
 * surfaces/AcpSurface.test.tsx — T3+.1 ACP 表面测试（TestGpuixRenderer）。
 * 真 createThreadStore + 可控 fake ACP 工厂（接口级；真子进程 JSON-RPC 链在
 * threads/acp.test.ts 覆盖）。订阅壳模式（= Pane selector，同 ChatSurface.test）。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

import { navigateTarget } from '../router'
import { memoryAdapter } from '../settings/file'
import { createSettingsStore, type SettingsStore } from '../settings/store'
import type { ChatAgent } from '../threads/chat'
import { createThreadStore, type ThreadStore } from '../threads/store'
import { useThreadStore } from '../threads/useThreadStore'
import { AcpSurface } from './AcpSurface'

let t: TestRoot
let store: ThreadStore
let settings: SettingsStore
let acpCalls: Array<{ text: string; resolve: (s: string) => void; reject: (e: unknown) => void }>

/** 订阅壳（= Pane 的 selector 模式）：store 更新自动流入 AcpSurface props */
function Harness({ acpId }: { acpId: string }) {
  const thread = useThreadStore(store, (s) => s.threads.find((x) => x.id === acpId))
  if (!thread) return null
  return <AcpSurface thread={thread} store={store} settings={settings} />
}

beforeAll(() => {
  t = createTestRoot({ width: 900, height: 700 })
  acpCalls = []
  const agent: ChatAgent = {
    send: (text) =>
      new Promise((resolve, reject) => {
        acpCalls.push({ text, resolve, reject })
      }),
    dispose: () => {},
  }
  settings = createSettingsStore(memoryAdapter())
  store = createThreadStore({
    spawnSession: async () => 0,
    destroySession: async () => {},
    navigate: navigateTarget,
    notify: () => {},
    closeOnExit: () => false,
    presetOf: () => undefined,
    chatAgent: { send: async () => 'chat-unused' },
    createAcpAgent: () => agent,
  })
})

afterAll(() => {
  for (const th of store.getState().threads) store.close(th.id)
  t?.unmount()
})

const flush = () => new Promise((r) => setTimeout(r, 10))

async function newAcp(): Promise<string> {
  store.createAcpThread('acp-test', 'Fake Agent')
  await flush()
  const id = store.getState().threads[store.getState().threads.length - 1].id
  t.render(createElement(Harness, { acpId: id }))
  t.renderer.flush()
  return id
}

function texts(): string {
  return t.renderer.getAllText().join('\n')
}

/** markdown 是 native 元素：断言走 customProps.source（T3.2 结论） */
function markdownSources(): string {
  return t.renderer
    .findByType('markdown')
    .map((el) => String(t.renderer.getElement(el.id)?.customProps?.source ?? ''))
    .join('\n')
}

async function until(desc: string, pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${desc}`)
    await new Promise((r) => setTimeout(r, 20))
    t.renderer.flush()
  }
}

describe('AcpSurface', () => {
  test('顶栏：ACP pill + agent 标题；空消息区', async () => {
    await newAcp()
    expect(texts()).toContain('ACP')
    expect(texts()).toContain('Fake Agent')
    expect(texts()).not.toContain('thinking…')
  })

  test('composer enter → sendAcpMessage 状态机（user + thinking → assistant markdown）', async () => {
    await newAcp()
    t.renderer.simulateKeystrokes('fixbuild')
    t.renderer.simulateKeystrokes('enter')
    await until('user painted', () => texts().includes('fixbuild'))
    expect(texts()).toContain('thinking…')
    expect(acpCalls).toHaveLength(1)

    acpCalls[0].resolve('- tool · execute · npm run build · completed\n\n修好了')
    await until('reply painted', () => markdownSources().includes('修好了'))
    expect(texts()).not.toContain('thinking…')
    expect(texts()).toContain('ASSISTANT')
  })

  test('错误回复：ERROR 标签 + 文案（ACP 连接错误同 chat 语义）', async () => {
    await newAcp()
    t.renderer.simulateKeystrokes('crashpls')
    t.renderer.simulateKeystrokes('enter')
    await until('pending', () => texts().includes('thinking…'))
    const last = acpCalls[acpCalls.length - 1]
    last.reject(new Error('ACP 进程退出（code 3）'))
    await until('error painted', () => markdownSources().includes('code 3'))
    expect(texts()).toContain('ERROR')
  })
})
