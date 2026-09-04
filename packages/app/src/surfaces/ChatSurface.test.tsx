/**
 * surfaces/ChatSurface.test.tsx — T3.2 chat 表面测试（architecture.md §9：
 * TestGpuixRenderer）。真 createThreadStore + 可控 fake ChatAgent（接口级，
 * 含异步回复链——断言用轮询让出）。时序三律：React 提交需 macrotask 让出。
 *
 * 数据流对齐真实装配：Harness 经 useThreadStore 订阅行（= Pane 的 selector
 * 模式）——store 更新自动重渲染并把新 thread 引用传给 ChatSurface；直接
 * render ChatSurface 传死 props 测不到消息链。
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
import { ChatSurface } from './ChatSurface'

let t: TestRoot
let store: ThreadStore
let settings: SettingsStore
let chatCalls: Array<{ text: string; resolve: (s: string) => void; reject: (e: unknown) => void }>

/** 订阅壳（= Pane 的 selector 模式）：store 更新自动流入 ChatSurface props */
function Harness({ chatId }: { chatId: string }) {
  const thread = useThreadStore(store, (s) => s.threads.find((x) => x.id === chatId))
  if (!thread) return null
  return <ChatSurface thread={thread} store={store} settings={settings} />
}

beforeAll(() => {
  t = createTestRoot({ width: 900, height: 700 })
  chatCalls = []
  const agent: ChatAgent = {
    send: (text) =>
      new Promise((resolve, reject) => {
        chatCalls.push({ text, resolve, reject })
      }),
  }
  settings = createSettingsStore(memoryAdapter())
  store = createThreadStore({
    spawnSession: async () => 0,
    destroySession: async () => {},
    navigate: navigateTarget,
    notify: () => {},
    closeOnExit: () => false,
    presetOf: () => undefined,
    chatAgent: agent,
  })
})

afterAll(() => {
  t?.unmount()
})

const flush = () => new Promise((r) => setTimeout(r, 10))

/** 新建 chat thread + 渲染 Harness；返回 thread id（隔离用例间消息累积） */
async function newChat(): Promise<string> {
  store.createChat()
  await flush()
  const id = store.getState().threads[store.getState().threads.length - 1].id
  t.render(createElement(Harness, { chatId: id }))
  t.renderer.flush()
  return id
}

function texts(): string {
  return t.renderer.getAllText().join('\n')
}

/** markdown 是 native 元素：内容不进 getAllText/getPaintedText（T2.3 结论推广），
 *  断言走元素树 customProps.source（virtual-list 只 mount 视口行，短列表全在） */
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

function clickAt(testId: string): void {
  const el = t.renderer.findByTestId(testId)!
  const b = t.renderer.getElementBounds(el.id)!
  t.renderer.nativeSimulateClick(b[0] + b[2] / 2, b[1] + b[3] / 2)
}

describe('ChatSurface', () => {
  test('顶栏：CHAT pill + 标题；空消息区无 thinking', async () => {
    await newChat()
    expect(texts()).toContain('CHAT')
    expect(texts()).toContain('Chat')
    expect(texts()).not.toContain('thinking…')
  })

  test('composer 打字 + enter（Submit）→ user 落列 + thinking 占位 + draft 清空', async () => {
    await newChat()
    t.renderer.simulateKeystrokes('hello')
    await flush()
    const composer = t.renderer.findByTestId('chat-composer')
    expect(t.renderer.getElement(composer!.id)?.customProps?.value).toBe('hello')

    t.renderer.simulateKeystrokes('enter')
    await until('user message painted', () => texts().includes('hello'))
    expect(texts()).toContain('thinking…')
    expect(chatCalls).toHaveLength(1)
    expect(chatCalls[0].text).toBe('hello')
    // draft 清空
    expect(t.renderer.getElement(composer!.id)?.customProps?.value ?? '').toBe('')
  })

  test('回复 resolve → assistant 消息可见（markdown）+ thinking 消失 + 标题改写', async () => {
    chatCalls[0].resolve('**收到**了 hello')
    await until('assistant reply painted', () => markdownSources().includes('收到'))
    expect(texts()).not.toContain('thinking…')
    expect(texts()).toContain('ASSISTANT')
    // 首条消息改写标题（顶栏不再是默认 'Chat'——用 rowTitle 语义同串不可分辨，改断言次数）
    expect(texts().split('hello').length - 1).toBeGreaterThanOrEqual(2) // 顶栏标题 + 消息体
  })

  test('pendingReply 时 Send 钮点击无效（无第二条 agent 调用）', async () => {
    await newChat()
    t.renderer.simulateKeystrokes('second')
    t.renderer.simulateKeystrokes('enter')
    await until('pending', () => texts().includes('thinking…'))
    expect(chatCalls).toHaveLength(2)
    clickAt('chat-send')
    await flush()
    expect(chatCalls).toHaveLength(2) // 禁发
    chatCalls[1].resolve('r2')
    await until('reply2', () => markdownSources().includes('r2'))
  })

  test('Send 钮点击路径发送（不经 enter）', async () => {
    await newChat()
    // 上一用例点击 Send 抢走了键盘焦点（点击真实聚焦命中元素）——拉回 composer
    const composer = t.renderer.findByTestId('chat-composer')!
    t.renderer.focusElement(composer.id)
    t.renderer.simulateKeystrokes('viabutton')
    await flush()
    expect(t.renderer.getElement(composer.id)?.customProps?.value).toBe('viabutton')
    clickAt('chat-send')
    await until('sent by click', () => chatCalls.some((c) => c.text === 'viabutton'))
  })

  test('错误回复：ERROR role 标签 + 错误文案', async () => {
    chatCalls[chatCalls.length - 1].reject(new Error('agent down'))
    await until('error painted', () => markdownSources().includes('agent down'))
    expect(texts()).toContain('ERROR')
  })
})
