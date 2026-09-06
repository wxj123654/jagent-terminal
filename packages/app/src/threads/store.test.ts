/**
 * threads/store 测试（architecture.md §3.4：bun test，零 GPU 零 PTY）。
 *
 * fake deps 注入 + 真 router 实例（memory history；navigate 走 navigateTarget
 * 薄包装，active 判定走 currentActiveThreadId——与装配层同一体）。
 * Phase 1 覆盖最小子集；T2.1 补全用例（displayTitle 已在此覆盖）。
 */

import { beforeEach, describe, expect, test } from 'bun:test'

import { activeTargetFromLocation, currentActiveThreadId, navigateTarget, router } from '../router'
import type { ChatAgent } from './chat'
import { builtinPresetOf, type TerminalPreset } from './presets'
import { createThreadStore, type ThreadDeps, type ThreadStore, type TerminalThread } from './store'
import { displayTitle } from './terminal'
import { defaultWorkspace } from './workspaces'

/** 可控 fake ChatAgent：调用入队，测试手动 resolve/reject */
function makeChatAgent() {
  const calls: Array<{ text: string; resolve: (s: string) => void; reject: (e: unknown) => void }> =
    []
  const agent: ChatAgent = {
    send: (text) =>
      new Promise((resolve, reject) => {
        calls.push({ text, resolve, reject })
      }),
  }
  return { agent, calls }
}

/** 可控 fake ACP 工厂（T3+.1）：记录建连/dispose；send 同 makeChatAgent */
function makeAcpFactory() {
  const created: string[] = []
  const disposed: string[] = []
  const calls: Array<{ text: string; resolve: (s: string) => void; reject: (e: unknown) => void }> =
    []
  const factory = (agentId: string): ChatAgent => {
    created.push(agentId)
    return {
      send: (text) =>
        new Promise((resolve, reject) => {
          calls.push({ text, resolve, reject })
        }),
      dispose: () => {
        disposed.push(agentId)
      },
    }
  }
  return { factory, created, disposed, calls }
}

function makeDeps(overrides: Partial<ThreadDeps> = {}) {
  let nextSession = 1
  const destroyed: number[] = []
  const notified: string[] = []
  const spawned: import('@jagent/native').SpawnOptionsJs[] = []
  let closeOnExit = false
  const chat = makeChatAgent()
  const acp = makeAcpFactory()
  const deps: ThreadDeps = {
    spawnSession: async (o) => {
      spawned.push(o)
      return nextSession++
    },
    destroySession: async (id) => {
      destroyed.push(id)
    },
    navigate: navigateTarget,
    notify: (t) => notified.push(t.id),
    closeOnExit: () => closeOnExit,
    presetOf: (id) => builtinPresetOf(id),
    activeThreadId: currentActiveThreadId,
    chatAgent: chat.agent,
    createAcpAgent: acp.factory,
    ...overrides,
  }
  return {
    deps,
    destroyed,
    notified,
    spawned,
    chat,
    acp,
    setCloseOnExit: (v: boolean) => (closeOnExit = v),
  }
}

/** 等 router 的 async load 链走完（pathname 是同步的，保险起见 flush 微任务）。 */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('router 纯函数（顺带）', () => {
  test('activeTargetFromLocation 三分支', () => {
    expect(activeTargetFromLocation('/')).toBeNull()
    expect(activeTargetFromLocation('/thread/t3')).toEqual({ type: 'thread', id: 't3' })
    expect(activeTargetFromLocation('/settings')).toEqual({ type: 'settings' })
  })
})

describe('spawnFromPreset', () => {
  let store: ThreadStore
  beforeEach(() => {
    void router.navigate({ to: '/' })
    store = createThreadStore(makeDeps().deps)
  })

  test('push + lastUsedPreset + navigate 到新 thread', async () => {
    await store.spawnFromPreset('claude')
    const s = store.getState()
    expect(s.threads).toHaveLength(1)
    expect(s.threads[0]).toMatchObject({ kind: 'terminal', id: 't1', preset: 'claude' })
    expect(s.lastUsedPreset).toBe('claude')
    expect(currentActiveThreadId()).toBe('t1')
  })

  test('未知 preset 抛错且状态不变', async () => {
    await expect(store.spawnFromPreset('nope')).rejects.toThrow('unknown preset')
    expect(store.getState().threads).toHaveLength(0)
  })

  test('preset 字段透传给 spawnSession；cwd 缺省回退 process.cwd()', async () => {
    const custom: TerminalPreset = {
      id: 'my',
      label: 'My',
      builtin: false,
      program: 'pwsh',
      args: ['-NoLogo'],
      env: { FOO: '1' },
      initCommand: 'echo hi',
      // cwd 故意不填
    }
    const ctx = makeDeps({ presetOf: (id) => (id === 'my' ? custom : builtinPresetOf(id)) })
    const store = createThreadStore(ctx.deps)
    await store.spawnFromPreset('my')
    expect(ctx.spawned[0]).toEqual({
      cwd: process.cwd(),
      program: 'pwsh',
      args: ['-NoLogo'],
      env: { FOO: '1' },
      initCommand: 'echo hi',
    })
  })
})

describe('activate / bell 规则', () => {
  test('bell 非激活 → 红点 + notify；activate 清除且不再 notify', async () => {
    const ctx = makeDeps()
    const store = createThreadStore(ctx.deps)
    await store.spawnFromPreset('shell') // t1，激活
    await store.spawnFromPreset('shell') // t2，激活（t1 转后台）
    await store.activate({ type: 'thread', id: 't1' })

    store.onSessionEvent({ type: 'bell', sessionId: 2 })
    let row = store.getState().threads.find((t) => t.id === 't2')
    expect(row?.kind === 'terminal' && row.hasBell).toBe(true)
    expect(ctx.notified).toEqual(['t2'])

    // 激活 t2 → 清红点
    store.activate({ type: 'thread', id: 't2' })
    row = store.getState().threads.find((t) => t.id === 't2')
    expect(row?.kind === 'terminal' && row.hasBell).toBe(false)

    // active 时 bell 不落红点也不通知
    store.onSessionEvent({ type: 'bell', sessionId: 2 })
    row = store.getState().threads.find((t) => t.id === 't2')
    expect(row?.kind === 'terminal' && row.hasBell).toBe(false)
    expect(ctx.notified).toEqual(['t2'])
  })

  test('activate(settings) / null：threads 不动，路由切换', async () => {
    const store = createThreadStore(makeDeps().deps)
    await store.spawnFromPreset('shell')
    const before = store.getState().threads

    store.activate({ type: 'settings' })
    expect(router.history.location.pathname).toBe('/settings')
    expect(store.getState().threads).toBe(before)

    store.activate(null)
    expect(router.history.location.pathname).toBe('/')
    expect(store.getState().threads).toBe(before)
  })
})

describe('title / exit / closeOnExit', () => {
  test('oscTitle 更新；customTitle 冻结不被覆盖', async () => {
    const store = createThreadStore(makeDeps().deps)
    await store.spawnFromPreset('shell')
    store.onSessionEvent({ type: 'title', sessionId: 1, title: 'vim' })
    let row = store.getState().threads[0]
    expect(row.kind === 'terminal' && row.oscTitle).toBe('vim')

    // 空串 title 忽略（不写入 oscTitle）
    store.onSessionEvent({ type: 'title', sessionId: 1, title: '' })
    row = store.getState().threads[0]
    expect(row.kind === 'terminal' && row.oscTitle).toBe('vim')

    store.rename('t1', '我的会话')
    store.onSessionEvent({ type: 'title', sessionId: 1, title: 'osc-after-rename' })
    row = store.getState().threads[0]
    expect(row.kind === 'terminal' && row.customTitle).toBe('我的会话')
    expect(row.kind === 'terminal' && row.oscTitle).toBe('vim') // 未被覆盖
  })

  test('rename 空串忽略', async () => {
    const store = createThreadStore(makeDeps().deps)
    await store.spawnFromPreset('shell')
    store.rename('t1', '   ')
    const row = store.getState().threads[0]
    expect(row.kind === 'terminal' && row.customTitle).toBeUndefined()
  })

  test('exit + closeOnExit=false → 灰行保留（不变量 3）', async () => {
    const store = createThreadStore(makeDeps().deps)
    await store.spawnFromPreset('shell')
    store.onSessionEvent({ type: 'exit', sessionId: 1 })
    const row = store.getState().threads[0]
    expect(row.kind === 'terminal' && row.status).toBe('exited')
    expect(store.getState().threads).toHaveLength(1)
  })

  test('exitCode 贯通（契约 §2.2：code 无值 → null）', async () => {
    const store = createThreadStore(makeDeps().deps)
    await store.spawnFromPreset('shell')
    await store.spawnFromPreset('shell')
    store.onSessionEvent({ type: 'exit', sessionId: 1, code: 0 })
    store.onSessionEvent({ type: 'exit', sessionId: 2 }) // 无 code → null（不是 undefined）
    const [t1, t2] = store.getState().threads as TerminalThread[]
    expect(t1.exitCode).toBe(0)
    expect(t2.exitCode).toBeNull()
  })

  test('exit + closeOnExit=true → 移除（走 close）', async () => {
    const ctx = makeDeps()
    ctx.setCloseOnExit(true)
    const store = createThreadStore(ctx.deps)
    await store.spawnFromPreset('shell')
    store.onSessionEvent({ type: 'exit', sessionId: 1 })
    expect(store.getState().threads).toHaveLength(0)
    expect(ctx.destroyed).toEqual([1])
    expect(router.history.location.pathname).toBe('/') // 先导航离开
  })
})

describe('close', () => {
  test('close 当前的 thread：先导航离开再移除 + destroySession', async () => {
    const ctx = makeDeps()
    const store = createThreadStore(ctx.deps)
    await store.spawnFromPreset('shell') // t1 active
    store.close('t1')
    expect(store.getState().threads).toHaveLength(0)
    expect(ctx.destroyed).toEqual([1])
    expect(router.history.location.pathname).toBe('/')
  })

  test('close 后台的 thread：不导航，仅移除', async () => {
    const ctx = makeDeps()
    const store = createThreadStore(ctx.deps)
    await store.spawnFromPreset('shell') // t1
    await store.spawnFromPreset('shell') // t2 active
    store.close('t1')
    expect(store.getState().threads.map((t) => t.id)).toEqual(['t2'])
    expect(ctx.destroyed).toEqual([1])
    expect(router.history.location.pathname).toBe('/thread/t2')
  })
})

describe('cycle 环形', () => {
  test('dir=1 到尾回卷；dir=-1 到头回卷', async () => {
    const store = createThreadStore(makeDeps().deps)
    await store.spawnFromPreset('shell') // t1
    await store.spawnFromPreset('shell') // t2
    await store.spawnFromPreset('shell') // t3 active

    store.cycle(1) // t3 → t1（回卷）
    await flush()
    expect(currentActiveThreadId()).toBe('t1')
    store.cycle(-1) // t1 → t3（回卷）
    await flush()
    expect(currentActiveThreadId()).toBe('t3')
    store.cycle(1) // t3 → t1
    await flush()
    expect(currentActiveThreadId()).toBe('t1')
  })

  test('无 active（settings 表面或根路由）：dir=1 → 首个，dir=-1 → 末个', async () => {
    const store = createThreadStore(makeDeps().deps)
    await store.spawnFromPreset('shell') // t1
    await store.spawnFromPreset('shell') // t2

    store.activate({ type: 'settings' })
    await flush()
    store.cycle(1)
    await flush()
    expect(currentActiveThreadId()).toBe('t1')

    store.activate(null) // '/'
    await flush()
    store.cycle(-1)
    await flush()
    expect(currentActiveThreadId()).toBe('t2')
  })
})

describe('activeThreadId 未注入的回退行为', () => {
  // deps.activeThreadId 缺省（如旧装配/局部复用）：bell 视为非 active，close 保守先导航
  test('bell 落红点 + notify；close 先导航离开再移除', async () => {
    const ctx = makeDeps({ activeThreadId: undefined })
    const store = createThreadStore(ctx.deps)
    await store.spawnFromPreset('shell')
    // 未注入 → 视为非 active → 红点 + 通知
    store.onSessionEvent({ type: 'bell', sessionId: 1 })
    let row = store.getState().threads[0]
    expect(row.kind === 'terminal' && row.hasBell).toBe(true)
    expect(ctx.notified).toEqual(['t1'])
    // 保守先导航（navigate(null) 到 '/'）再移除
    store.close('t1')
    expect(router.history.location.pathname).toBe('/')
    expect(store.getState().threads).toHaveLength(0)
  })
})

describe('displayTitle 四级兜底（契约 §4）', () => {
  test('customTitle ?? oscTitle ?? initCommand ?? "Terminal"', () => {
    expect(displayTitle({ customTitle: 'c', oscTitle: 'o', initCommand: 'i' })).toBe('c')
    expect(displayTitle({ oscTitle: 'o', initCommand: 'i' })).toBe('o')
    expect(displayTitle({ initCommand: 'i' })).toBe('i')
    expect(displayTitle({})).toBe('Terminal')
  })
})

// ── T3.2 chat（createChat / sendChatMessage / rename）────────────────

describe('chat: createChat', () => {
  test('push 空 chat thread + activate；默认标题', async () => {
    void router.navigate({ to: '/' })
    const store = createThreadStore(makeDeps().deps)
    store.createChat()
    await flush()
    const s = store.getState()
    expect(s.threads).toHaveLength(1)
    expect(s.threads[0]).toMatchObject({
      kind: 'chat',
      title: 'Chat',
      messages: [],
      pendingReply: false,
    })
    expect(currentActiveThreadId()).toBe(s.threads[0].id)
  })
})

describe('chat: sendChatMessage 状态机', () => {
  let store: ThreadStore
  let ctx: ReturnType<typeof makeDeps>
  beforeEach(() => {
    void router.navigate({ to: '/' })
    ctx = makeDeps()
    store = createThreadStore(ctx.deps)
    store.createChat()
    store.createChat()
  })
  const chat = (i: number) => {
    const t = store.getState().threads[i]
    if (t?.kind !== 'chat') throw new Error('not chat')
    return t
  }

  test('user 落列 + pendingReply；resolve → assistant 落列 + 复位', async () => {
    const id = chat(0).id
    store.sendChatMessage(id, '第一条')
    let t = chat(0)
    expect(t.messages).toHaveLength(1)
    expect(t.messages[0]).toMatchObject({ role: 'user', text: '第一条' })
    expect(t.pendingReply).toBe(true)

    ctx.chat.calls[0].resolve('回复 A')
    await flush()
    t = chat(0)
    expect(t.messages).toHaveLength(2)
    expect(t.messages[1]).toMatchObject({ role: 'assistant', text: '回复 A' })
    expect(t.pendingReply).toBe(false)
  })

  test('首条消息改标题（>32 截断）；第二条不再改', async () => {
    const long = '这段话特别长需要被截断处理因为它超过了三十二个字符的长度限制还要再长一点'
    const id = chat(0).id
    store.sendChatMessage(id, long)
    expect(chat(0).title).toBe(`${long.slice(0, 32)}…`)
    ctx.chat.calls[0].resolve('r')
    await flush()
    store.sendChatMessage(id, '第二条')
    expect(chat(0).title).toBe(`${long.slice(0, 32)}…`)
  })

  test('空串/纯空白忽略；pendingReply 中再发忽略；非 chat id 忽略', async () => {
    const id = chat(0).id
    store.sendChatMessage(id, '   ')
    expect(chat(0).messages).toHaveLength(0)
    store.sendChatMessage(id, 'x')
    store.sendChatMessage(id, 'y') // pending 中
    expect(chat(0).messages).toHaveLength(1)
    expect(ctx.chat.calls).toHaveLength(1)
    store.sendChatMessage('t999', 'z') // 不存在的 thread
    expect(ctx.chat.calls).toHaveLength(1)
  })

  test('reject → error assistant 行 + 复位', async () => {
    const id = chat(0).id
    store.sendChatMessage(id, 'hi')
    ctx.chat.calls[0].reject(new Error('boom'))
    await flush()
    const t = chat(0)
    expect(t.messages).toHaveLength(2)
    expect(t.messages[1]).toMatchObject({ role: 'assistant', error: true })
    expect(t.messages[1].text).toContain('boom')
    expect(t.pendingReply).toBe(false)
  })

  test('close 后回复到达 → 丢弃（不复活已删行）', async () => {
    const id = chat(0).id
    store.sendChatMessage(id, 'hi')
    store.close(id)
    await flush()
    ctx.chat.calls[0].resolve('迟到的回复')
    await flush()
    expect(store.getState().threads.some((t) => t.id === id)).toBe(false)
  })

  test('close chat：先导航离开再移除（不变量 1）；非 active 行不导航', async () => {
    // active = 第二个 chat（createChat 后 activate）；close 非 active 的第一个：路由不动
    store.close(chat(0).id)
    await flush()
    expect(router.history.location.pathname).not.toBe('/')
    expect(store.getState().threads).toHaveLength(1)
    // close active 行：先导航离开再移除
    const activeId = currentActiveThreadId()
    expect(activeId).toBeTruthy()
    store.close(activeId!)
    await flush()
    expect(router.history.location.pathname).toBe('/')
    expect(store.getState().threads).toHaveLength(0)
  })

  test('rename：chat 直接改 title；手改后首条消息不再改写（冻结）', async () => {
    const id = chat(0).id
    store.rename(id, '我的会话')
    expect(chat(0).title).toBe('我的会话')
    store.sendChatMessage(id, '首条消息')
    expect(chat(0).title).toBe('我的会话') // 不被首条消息覆盖
    // 空串忽略（同 terminal 语义）
    store.rename(id, '  ')
    expect(chat(0).title).toBe('我的会话')
  })
})

describe('acp: createAcpThread / sendAcpMessage（T3+.1）', () => {
  let store: ThreadStore
  let ctx: ReturnType<typeof makeDeps>
  beforeEach(() => {
    void router.navigate({ to: '/' })
    ctx = makeDeps()
    store = createThreadStore(ctx.deps)
  })
  const acpThread = (store: ThreadStore, i = 0) => {
    const t = store.getState().threads[i]
    if (t?.kind !== 'acp') throw new Error('not acp')
    return t
  }

  test('createAcpThread：push + activate；title=传入 label；autoTitle', async () => {
    store.createAcpThread('acp-codex', 'Codex (ACP)')
    await flush()
    const t = acpThread(store)
    expect(t).toMatchObject({
      kind: 'acp',
      agentId: 'acp-codex',
      title: 'Codex (ACP)',
      messages: [],
      pendingReply: false,
      autoTitle: true,
    })
    expect(currentActiveThreadId()).toBe(t.id)
  })

  test('sendAcpMessage：情建连接（每 thread 一次）+ 状态机同 chat', async () => {
    store.createAcpThread('acp-codex', 'Codex (ACP)')
    const id = acpThread(store).id
    store.sendAcpMessage(id, '看下这个 bug')
    // 同步部分：user 落列 + pending + 工厂已按 agentId 建连
    const t = acpThread(store)
    expect(t.messages[0]).toMatchObject({ role: 'user', text: '看下这个 bug' })
    expect(t.pendingReply).toBe(true)
    expect(ctx.acp.created).toEqual(['acp-codex'])
    // 首条消息改写 title（从 label）
    expect(t.title).toBe('看下这个 bug')

    ctx.acp.calls[0].resolve('修好了')
    await flush()
    expect(acpThread(store).messages[1]).toMatchObject({ role: 'assistant', text: '修好了' })
    expect(acpThread(store).pendingReply).toBe(false)

    // 第二条消息：连接复用（不重建）
    store.sendAcpMessage(id, '再来')
    expect(ctx.acp.created).toEqual(['acp-codex'])
    ctx.acp.calls[1].resolve('ok')
    await flush()
    expect(acpThread(store).messages).toHaveLength(4)
  })

  test('rename 冻结：手改后首条消息不改写；空串忽略', async () => {
    store.createAcpThread('acp-codex', 'Codex (ACP)')
    const id = acpThread(store).id
    store.rename(id, '调参专用')
    expect(acpThread(store).title).toBe('调参专用')
    store.sendAcpMessage(id, '首条')
    expect(acpThread(store).title).toBe('调参专用') // 不改写
    store.rename(id, '  ')
    expect(acpThread(store).title).toBe('调参专用')
  })

  test('createAcpAgent throw（配置被删）→ error 行，不置 pending', async () => {
    const ctx2 = makeDeps({
      createAcpAgent: () => {
        throw new Error('unknown ACP agent: gone')
      },
    })
    const store2 = createThreadStore(ctx2.deps)
    store2.createAcpThread('gone', 'Gone')
    const id = store2.getState().threads[0]!.id
    store2.sendAcpMessage(id, 'hello')
    const t = store2.getState().threads[0]!
    expect(t.kind).toBe('acp')
    if (t.kind !== 'acp') return
    expect(t.messages).toHaveLength(1)
    expect(t.messages[0]).toMatchObject({ role: 'assistant', error: true })
    expect(t.messages[0].text).toContain('unknown ACP agent')
    expect(t.pendingReply).toBe(false)
  })

  test('close：连接 dispose + 行移除 + 先导航离开；建连前 close 无 dispose', async () => {
    store.createAcpThread('acp-codex', 'Codex (ACP)')
    store.createAcpThread('acp-claude', 'Claude (ACP)')
    const a = acpThread(store, 0).id
    const b = acpThread(store, 1).id
    // a 建连后 close；b 未建连直接 close
    store.sendAcpMessage(a, 'hi')
    store.close(a)
    await flush()
    expect(ctx.acp.disposed).toEqual(['acp-codex'])
    expect(store.getState().threads.some((t) => t.id === a)).toBe(false)
    store.close(b)
    await flush()
    expect(ctx.acp.disposed).toEqual(['acp-codex']) // b 无连接不 dispose
    expect(store.getState().threads).toHaveLength(0)
    expect(router.history.location.pathname).toBe('/')
  })

  test('close 后迟到回复丢弃；reject → error 行（同 chat 语义）', async () => {
    store.createAcpThread('acp-codex', 'Codex (ACP)')
    const id = acpThread(store).id
    store.sendAcpMessage(id, 'x')
    store.close(id)
    await flush()
    ctx.acp.calls[0].resolve('迟到')
    await flush()
    expect(store.getState().threads).toHaveLength(0) // 不复活

    store.createAcpThread('acp-codex', 'Codex (ACP)')
    const id2 = acpThread(store).id
    store.sendAcpMessage(id2, 'y')
    ctx.acp.calls[1].reject(new Error('ACP 进程退出'))
    await flush()
    const t = acpThread(store)
    expect(t.messages[1]).toMatchObject({ role: 'assistant', error: true })
    expect(t.pendingReply).toBe(false)
    store.close(id2)
  })
})

// ── 工作区（Phase W；design/workspace-plane.md 契约）──────────────────

describe('工作区 CRUD 与持久化', () => {
  let store: ThreadStore
  let persisted: string[][] // 每次 persist 时的 workspaces id 快照
  beforeEach(() => {
    void router.navigate({ to: '/' })
    persisted = []
    store = createThreadStore(makeDeps().deps, {
      initialWorkspaces: [{ ...defaultWorkspace('/w/one') }],
    })
  })

  test('addWorkspace：入列表 + persist + 返回 id；空名回退 basename(path)', () => {
    const id = store.addWorkspace('', '/w/my-proj')
    const s = store.getState()
    expect(s.workspaces).toHaveLength(2)
    expect(s.workspaces[1]).toMatchObject({
      id,
      name: 'my-proj',
      path: '/w/my-proj',
      expanded: true,
      lastSession: null,
    })
    expect(persisted).toHaveLength(0) // 未注入 persistWorkspaces → 不炸
  })

  test('renameWorkspace：改名；空串忽略；unknown no-op', () => {
    const id0 = store.getState().workspaces[0]!.id
    store.renameWorkspace(id0, '  改名  ')
    expect(store.getState().workspaces[0]!.name).toBe('改名')
    store.renameWorkspace(id0, '   ')
    expect(store.getState().workspaces[0]!.name).toBe('改名')
    store.renameWorkspace('w-void', 'x')
    expect(store.getState().workspaces[0]!.name).toBe('改名')
  })

  test('persistWorkspaces：workspaces 每次变化后 fire（快照含变更）', () => {
    const snapshots: string[][] = []
    const st = createThreadStore(
      makeDeps({ persistWorkspaces: (ws) => snapshots.push(ws.map((w) => w.name)) }).deps,
      {
        initialWorkspaces: [],
      },
    )
    st.addWorkspace('a', '/a')
    st.renameWorkspace(st.getState().workspaces[0]!.id, 'b')
    st.toggleWorkspaceExpanded(st.getState().workspaces[0]!.id)
    expect(snapshots).toEqual([['a'], ['b'], ['b']])
  })

  test('toggleWorkspaceExpanded：翻转 + 不导航', () => {
    const id0 = store.getState().workspaces[0]!.id
    expect(store.getState().workspaces[0]!.expanded).toBe(true)
    store.toggleWorkspaceExpanded(id0)
    expect(store.getState().workspaces[0]!.expanded).toBe(false)
    expect(currentActiveThreadId()).toBeNull()
  })
})

describe('工作区会话归属与 cwd 继承', () => {
  let store: ThreadStore
  beforeEach(() => {
    void router.navigate({ to: '/' })
    store = createThreadStore(makeDeps().deps, {
      initialWorkspaces: [
        defaultWorkspace('/w/proj'),
        { ...defaultWorkspace('/w/other'), name: 'other' },
      ],
    })
  })

  test('spawnFromPreset(presetId, workspaceId)：cwd = workspace.path；thread 落归属；lastSession 记录', async () => {
    const wsId = store.getState().workspaces[0]!.id
    await store.spawnFromPreset('shell', wsId)
    const t = store.getState().threads[0] as TerminalThread
    expect(t.workspaceId).toBe(wsId)
    expect(t.cwd).toBe('/w/proj')
    expect(store.getState().workspaces[0]!.lastSession).toBe(t.id)
  })

  test('preset.cwd 优先于工作区目录（用户配置意图）；无工作区回退进程 CWD', async () => {
    const custom: TerminalPreset = {
      id: 'fixed-cwd',
      label: '固定目录',
      builtin: true,
      cwd: '/preset/dir',
    }
    const store2 = createThreadStore(
      makeDeps({ presetOf: (id) => (id === 'fixed-cwd' ? custom : builtinPresetOf(id)) }).deps,
      { initialWorkspaces: [defaultWorkspace('/w/proj')] },
    )
    const wsId = store2.getState().workspaces[0]!.id
    await store2.spawnFromPreset('fixed-cwd', wsId)
    expect((store2.getState().threads[0] as TerminalThread).cwd).toBe('/preset/dir')
    await store2.spawnFromPreset('shell')
    expect((store2.getState().threads[1] as TerminalThread).cwd).toBe(process.cwd())
    expect((store2.getState().threads[1] as TerminalThread).workspaceId).toBeUndefined()
  })

  test('unknown workspaceId：spawn / createChat / createAcpThread 均抛错', async () => {
    await expect(store.spawnFromPreset('shell', 'w-void')).rejects.toThrow('unknown workspace')
    expect(() => store.createChat('w-void')).toThrow('unknown workspace')
    expect(() => store.createAcpThread('acp-codex', 'Codex', 'w-void')).toThrow('unknown workspace')
    expect(store.getState().threads).toHaveLength(0)
  })

  test('createChat/createAcpThread 带归属：workspaceId 落值 + lastSession 更新', () => {
    const wsId = store.getState().workspaces[1]!.id
    store.createChat(wsId)
    const c = store.getState().threads[0]!
    expect(c.workspaceId).toBe(wsId)
    expect(store.getState().workspaces[1]!.lastSession).toBe(c.id)
    expect(store.getState().workspaces[0]!.lastSession).toBeNull()
  })

  test('activate 归属会话 → lastSession 跟随（含 cycle 路径）；重复 activate 不重复 persist', async () => {
    const wsId = store.getState().workspaces[0]!.id
    await store.spawnFromPreset('shell', wsId)
    await store.spawnFromPreset('pi', wsId)
    const [t1, t2] = store.getState().threads as TerminalThread[]
    // 激活 t1（经 activate 面而非创建）→ lastSession 回写
    store.activate({ type: 'thread', id: t1.id })
    expect(store.getState().workspaces[0]!.lastSession).toBe(t1.id)
    // cycle 也会更新（activate 单点）
    store.cycle(1)
    expect(currentActiveThreadId()).toBe(t2.id)
    expect(store.getState().workspaces[0]!.lastSession).toBe(t2.id)
  })
})

describe('activateWorkspace / close / removeWorkspace', () => {
  let store: ThreadStore
  beforeEach(() => {
    void router.navigate({ to: '/' })
    store = createThreadStore(makeDeps().deps, {
      initialWorkspaces: [defaultWorkspace('/w/proj')],
    })
  })

  test('activateWorkspace：恢复 lastSession；无/死 lastSession → 回起始页（null）', async () => {
    const wsId = store.getState().workspaces[0]!.id
    // 无 lastSession → 起始页
    store.activateWorkspace(wsId)
    expect(currentActiveThreadId()).toBeNull()
    // 有 lastSession → 恢复
    await store.spawnFromPreset('shell', wsId)
    const tid = currentActiveThreadId()
    void router.navigate({ to: '/' })
    store.activateWorkspace(wsId)
    expect(currentActiveThreadId()).toBe(tid)
    // 死 id（会话已 close）→ 起始页
    store.close(tid!)
    store.activateWorkspace(wsId)
    expect(currentActiveThreadId()).toBeNull()
  })

  test('close lastSession 指向的会话 → lastSession 清空（工作区起始页数据面）', async () => {
    const wsId = store.getState().workspaces[0]!.id
    await store.spawnFromPreset('shell', wsId)
    const tid = store.getState().threads[0]!.id
    expect(store.getState().workspaces[0]!.lastSession).toBe(tid)
    store.close(tid)
    expect(store.getState().workspaces[0]!.lastSession).toBeNull()
  })

  test('removeWorkspace：连带 close 归属会话（destroy + 导航兑底）+ 移除行', async () => {
    const deps = makeDeps()
    store = createThreadStore(deps.deps, {
      initialWorkspaces: [defaultWorkspace('/w/a'), defaultWorkspace('/w/b')],
    })
    const [wa, wb] = store.getState().workspaces
    await store.spawnFromPreset('shell', wa!.id)
    await store.spawnFromPreset('shell', wb!.id)
    expect(currentActiveThreadId()).toBe('t2') // 后建的 wb 会话 active
    store.removeWorkspace(wa!.id)
    expect(deps.destroyed).toEqual([1]) // 仅 wa 的会话销毁
    expect(store.getState().threads.map((t) => t.id)).toEqual(['t2'])
    expect(store.getState().workspaces.map((w) => w.id)).toEqual([wb!.id])
    expect(currentActiveThreadId()).toBe('t2') // active 不在 wa → 不导航
    // 移除含 active 会话的工作区 → 先导航兑底再清
    store.removeWorkspace(wb!.id)
    expect(deps.destroyed).toEqual([1, 2])
    expect(currentActiveThreadId()).toBeNull()
    expect(store.getState().threads).toHaveLength(0)
    expect(store.getState().workspaces).toHaveLength(0)
  })

  test('removeWorkspace：无会话工作区仅移除行；unknown no-op', () => {
    const wsId = store.getState().workspaces[0]!.id
    store.removeWorkspace('w-void')
    expect(store.getState().workspaces).toHaveLength(1)
    store.removeWorkspace(wsId)
    expect(store.getState().workspaces).toHaveLength(0)
  })
})
