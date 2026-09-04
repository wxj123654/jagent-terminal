/**
 * e2e/terminal.e2e.test.tsx — T1.6 端到端（architecture.md §9 测试面：
 * element/pool/model 真 PTY + surfaces/registry + Pane 整块替换）。
 *
 * 跑法：bun test e2e/（Windows + TestGpuixRenderer；真 ConPTY，慢是正常的）。
 *
 * 验证面（T1.6 清单）：
 * 1. 两个 PTY 并存（列表两行 + 各自 surface 绑定）
 * 2. retain：切走后元素销毁、池中会话存活、后台 bell 仍送达（红点）
 * 3. activate 清红点
 * 4. exit → 灰行保留（closeOnExit=false）
 * 5. close → 先导航离开 → destroySession + 行移除
 * 6. 焦点模型：TerminalView 聚焦时窗口级 keyDown 是否仍到达（Ctrl-Tab）
 *
 * 时序注记：
 * - session 事件经 TSF 异步到达 JS；PTY 消费 task 的 4ms 批处理定时器
 *   挂在 test dispatcher 的 fake clock 上——轮询循环必须 advanceTime 驱动。
 * - React 对 store/router 的更新提交需要让出主线程（macrotask）。
 * - bell 会话 = 短命 PowerShell 子进程写双 BEL（单 BEL 紧跟 OSC 会被吃，
 *   Phase 0 实测）。spawn resolve 时 PowerShell 还没起来（冷启动 >500ms），
 *   同步 activate 切走必然先于 bell 到达 → bell 落在后台行。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { installTerminalElement, destroyTerminalSession, onSessionEvent } from '@jagent/native'

import { createElement } from 'react'
import { App } from '../packages/app/src/plane/AgentPlane'
import { createThreadStore, type ThreadStore } from '../packages/app/src/threads/store'
import { createSettingsStore } from '../packages/app/src/settings/store'
import { memoryAdapter } from '../packages/app/src/settings/file'
import { createNativeThreadDeps } from '../packages/app/src/threads/nativeDeps'
import { narrowSessionEvent, type TerminalSessionEvent } from '../packages/app/src/threads/events'
import { builtinPresetOf, type TerminalPreset } from '../packages/app/src/threads/presets'
import { currentActiveThreadId } from '../packages/app/src/router'

/** 轮询直到谓词为真：advanceTime 驱动 fake clock（4ms 批处理），setTimeout 让出主线程（React 提交 + TSF 回调） */
async function until(desc: string, pred: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (pred()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${desc}`)
    t.renderer.advanceTime(80)
    await new Promise((r) => setTimeout(r, 30))
  }
}

/** 双 BEL + 存活 3s（bell 到达时会话未死）后自然退出 */
const BELL_PRESET: TerminalPreset = {
  id: 'e2e-bell',
  label: 'E2E Bell',
  builtin: false,
  program: 'powershell',
  args: ['-NoProfile', '-Command', "[Console]::Write([char]7 + [char]7); Start-Sleep 3"],
}

const TEST_TIMEOUT = 30_000
const sessionEvents: TerminalSessionEvent[] = []

let t: TestRoot
let store: ThreadStore
let keyEvents: string[] = []

beforeAll(() => {
  // 顺序敏感：先注册元素（GLOBAL_FACTORIES push），再建 renderer
  // （GpuixView with_defaults 时 drain）。
  installTerminalElement()

  keyEvents = []
  t = createTestRoot({
    width: 1180,
    height: 760,
    // 窗口级 key 事件（on_root_key_event，Bubble 阶段）——模拟真实
    // main.tsx render({ onEvent }) 的键位层挂点
    onKeyDown: (e) => keyEvents.push(`${e.modifiers?.ctrl ? 'ctrl-' : ''}${e.key}`),
  })

  // 与 main.tsx 同一装配工厂——只覆盖差异项（notify 静默 + e2e 专用 bell 预设）
  store = createThreadStore(
    createNativeThreadDeps({
      notify: () => {},
      presetOf: (id) => builtinPresetOf(id) ?? (id === BELL_PRESET.id ? BELL_PRESET : undefined),
    }),
  )

  // 事件桥必须在 store 创建后注册（回调里引用 store）——与 main.tsx 装配一致
  onSessionEvent((_err, e) => {
    const n = narrowSessionEvent(e)
    if (!n) return
    sessionEvents.push(n)
    store.onSessionEvent(n)
  })

  // 设置面：memoryAdapter（隔离真盘 ~/.j-agent/settings.json）
  const settings = createSettingsStore(memoryAdapter())

  t.render(createElement(App, { store, settings }))
})

afterAll(() => {
  for (const th of store.getState().threads) {
    if (th.kind === 'terminal') {
      try {
        destroyTerminalSession(th.sessionId)
      } catch {
        // 幂等：已销毁的 id 忽略
      }
    }
  }
  t?.unmount()
})

describe('T1.6 e2e: two PTYs · retain · bell · exit · close · focus', () => {
  test(
    '初始：EmptyPresets 卡片（内置五预设可见）',
    () => {
      const texts = t.renderer.getAllText()
      expect(texts.some((s) => s.includes('Claude Code'))).toBe(true)
      expect(texts.some((s) => s.includes('Shell'))).toBe(true)
      expect(texts.some((s) => s.includes('新建会话'))).toBe(true)
    },
    TEST_TIMEOUT,
  )

  test(
    'spawn（shell + bell）→ 两行并存，active=bell 行，terminal 元素渲染',
    async () => {
      await store.spawnFromPreset('shell')
      await store.spawnFromPreset(BELL_PRESET.id)

      const s = store.getState()
      expect(s.threads).toHaveLength(2)
      expect(currentActiveThreadId()).toBe(s.threads[1]!.id)

      // React 提交轮询：terminal 元素进树 + 两行兜底标题可见
      await until(
        'terminal surface mounted with both rows',
        () =>
          t.renderer.findByType('terminal').length >= 1 &&
          t.renderer.getAllText().filter((x) => x === 'Terminal').length >= 2,
      )
    },
    TEST_TIMEOUT,
  )

  test(
    'retain：切走 bell 行 → 后台 bell 送达（红点数据）+ activate 清除',
    async () => {
      const s0 = store.getState()
      const shellRow = s0.threads[0]! // 前台：普通 shell
      const bellRow = s0.threads[1]! // 将转后台：bell 会话（此刻 active）

      // 同步切走（PowerShell 冷启动 >500ms，bell 必然晚于这次 activate）
      store.activate({ type: 'thread', id: shellRow.id })
      expect(currentActiveThreadId()).toBe(shellRow.id)

      // 后台 bell 送达：hasBell=true（全局通道，不依赖元素存活）
      await until(
        'bell event → hasBell on background row',
        () => {
          const row = store.getState().threads.find((x) => x.id === bellRow.id)
          return row?.kind === 'terminal' && row.hasBell
        },
      ).catch((err) => {
        console.log(
          '[debug] sessionEvents:', JSON.stringify(sessionEvents),
          '\n[debug] threads:', JSON.stringify(store.getState().threads),
          '\n[debug] active:', currentActiveThreadId(),
        )
        throw err
      })
      expect(
        sessionEvents.some((e) => e.type === 'bell' && `t${e.sessionId}` === bellRow.id),
      ).toBe(true)

      // activate 清红点（契约 §7：聚焦即清）
      store.activate({ type: 'thread', id: bellRow.id })
      const cleared = store.getState().threads.find((x) => x.id === bellRow.id) as {
        hasBell: boolean
      }
      expect(cleared.hasBell).toBe(false)
    },
    TEST_TIMEOUT,
  )

  test(
    'exit → 灰行保留（closeOnExit=false，不变量 3）+ close 全清',
    async () => {
      const bellRowId = store.getState().threads[1]!.id

      // bell 会话 3s 后退出：status='exited'，行保留
      await until('exit event → status exited (row kept)', () => {
        const row = store.getState().threads.find((x) => x.id === bellRowId)
        return row?.kind === 'terminal' && row.status === 'exited'
      })
      expect(store.getState().threads).toHaveLength(2)

      // exited 微标签渲染在列表里（React 提交轮询）
      await until('exited badge visible', () =>
        t.renderer.getAllText().some((x) => x === 'exited'),
      )

      // close 后台行（当前 active 在它上 → 先导航离开再移除，不变量 1）
      store.close(bellRowId)
      await until('row removed', () => store.getState().threads.length === 1)
      expect(currentActiveThreadId()).not.toBe(bellRowId)

      // close 剩下的行 → 回 EmptyPresets（路由 /）
      const lastId = store.getState().threads[0]!.id
      store.close(lastId)
      await until('all rows removed', () => store.getState().threads.length === 0)
      expect(currentActiveThreadId()).toBeNull()
      // Pane 整块替换回 EmptyPresets
      await until('EmptyPresets restored', () =>
        t.renderer.getAllText().some((x) => x.includes('新建会话')),
      )
    },
    TEST_TIMEOUT,
  )

  test(
    '焦点模型：TerminalView 聚焦时窗口 keyDown 仍到达（Ctrl-Tab 全局可用）',
    async () => {
      await store.spawnFromPreset('shell')
      const row = store.getState().threads[0]!
      await until('active = new row', () => currentActiveThreadId() === row.id)
      await new Promise((r) => setTimeout(r, 120))

      // terminal 元素 focused prop → FocusHandle 聚焦；给当前焦点发
      // ctrl-tab（test renderer 的 keystroke 走真 GPUI 输入管线）
      keyEvents.length = 0
      t.renderer.simulateKeystrokes('ctrl-tab')

      // Bubble 阶段的 on_root_key_event 应收到（vendored view 的 on_key_down
      // 不 stop_propagation——预期全局键位层可用，无需降级）
      await until('window-level keyDown arrives while terminal focused', () =>
        keyEvents.some((k) => k === 'ctrl-tab'),
      )
      expect(keyEvents).toContain('ctrl-tab')
    },
    TEST_TIMEOUT,
  )

  test(
    '行点击命中模型：点行文字区 → activate（装饰层 pe:none 穿透）',
    async () => {
      // 上一个用例留下 1 个 shell 行；再 spawn 一个作切换目标
      await store.spawnFromPreset('shell')
      const rows = store.getState().threads
      const target = rows[0]!
      await until('two rows rendered', () =>
        t.renderer.findByTestId(`row-${target.id}`) !== undefined,
      )

      // 点击 target 行中心（标题文字区——GPUIX 不冒泡，装饰 text 必须
      // pe:none 让命中穿透到行容器；无此修复点击会被文字吞掉）
      const el = t.renderer.findByTestId(`row-${target.id}`)!
      const b = t.renderer.getElementBounds(el.id)!
      expect(currentActiveThreadId()).not.toBe(target.id)
      t.renderer.nativeSimulateClick(b[0] + b[2] / 2, b[1] + b[3] / 2)

      await until('click on row text activates thread', () =>
        currentActiveThreadId() === target.id,
      )
    },
    TEST_TIMEOUT,
  )
})
