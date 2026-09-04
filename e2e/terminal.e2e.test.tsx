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
import { currentActiveThreadId, router, activeTargetFromLocation, lastNonSettings } from '../packages/app/src/router'
import { settingsKeyboard } from '../packages/app/src/surfaces/SettingsView'
import { inputFocus } from '../packages/app/src/ui/keyboard'
import { createGlobalKeydown, type GlobalKeydown } from '../packages/app/src/keybindings'

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
let settings: ReturnType<typeof createSettingsStore>
let keyEvents: string[] = []
// 键位层（store 创建后接线；挂点先占位——与 main.tsx 同一 createGlobalKeydown）
let handleKeydown: GlobalKeydown = () => {}

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
    onKeyDown: (e) => {
      keyEvents.push(`${e.modifiers?.ctrl ? 'ctrl-' : ''}${e.key}`)
      handleKeydown(e.key ?? '', e.modifiers?.ctrl ?? false, e.modifiers?.shift ?? false)
    },
  })

  // 设置面先行（memoryAdapter：隔离真盘；不 init——默认值即测试值）
  settings = createSettingsStore(memoryAdapter())

  // 与 main.tsx 同一装配工厂——只覆盖差异项（notify 静默：e2e 不真弹 toast；
  // 注入 e2e 专用 bell 预设）
  store = createThreadStore(
    createNativeThreadDeps(settings, {
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

  // 键位层接线（与 main.tsx 同一工厂；focusSearch 走 TestRenderer 的
  // focusElement——同一 GPUI 焦点管线）
  handleKeydown = createGlobalKeydown({
    store,
    inSettings: () =>
      activeTargetFromLocation(router.history.location.pathname)?.type === 'settings',
    closeSettings: () => store.activate(lastNonSettings()),
    focusSearch: () => {
      const id = settingsKeyboard.searchInputId()
      if (id != null) t.renderer.focusElement(id)
    },
    inputFocused: () => inputFocus.any,
    settingsQuery: settingsKeyboard.query,
  escConsumed: settingsKeyboard.escConsumed,
  clearEscConsumed: settingsKeyboard.clearEscConsumed,
  })

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

  test(
    'T2.5 设置联动：terminal 外观 props 随 settings.terminal 变化',
    async () => {
      await store.spawnFromPreset('shell')
      await until('terminal mounted', () => t.renderer.findByType('terminal').length >= 1)

      // 默认值（schema 兜底）：fontSize 13 / palette one-dark / cursorBlink true
      // （useSettings → TerminalSurface → <terminal> props；探针实测
      // customProps 全量透传）
      const props = () =>
        t.renderer.findByType('terminal')[0]!.customProps as Record<string, unknown>
      expect(props().fontSize).toBe(13)
      expect(props().palette).toBe('one-dark')
      expect(props().cursorBlink).toBe(true)

      // 设置 patch → props 联动（Rust 侧 setCustomProp 幂等调和，不重建会话）；
      // 设置变化触发整树重渲染（useSettings 订阅），需让出主线程
      settings.patch('terminal.fontSize', 18)
      settings.patch('terminal.cursorBlink', false)
      await until(
        'terminal props follow settings',
        () =>
          (props().fontSize as number) === 18 && props().cursorBlink === false,
      )

      // 会话未重建（sessionId 不变——「样式调和而非重建」的不变量）
      expect(props().sessionId).toBe(store.getState().threads.at(-1)!.sessionId)
    },
    TEST_TIMEOUT,
  )

  test(
    'T2.6 键位层：Ctrl-, / Esc / `/` 设置面生命周期（键盘两跳 + 模块态时序）',
    async () => {
      // 前置：一个 thread 存在（设置关闭后要能回去）
      await store.spawnFromPreset('shell')
      await until('terminal mounted', () => t.renderer.findByType('terminal').length >= 1)
      const tid = currentActiveThreadId()

      // ① Ctrl-, 开设置：窗口 root 键位层（与 main.tsx 同构的 handleKeyDown
      // 已在 createTestRoot 挂点里）——键盘事件走真 GPUI 输入管线
      t.renderer.simulateKeystrokes('ctrl-,')
      await until('settings view open', () => t.renderer.findByTestId('settings-view') !== undefined)

      // ② 搜索框 autoFocus（§4 打开设置时焦点进搜索框）：打字 → query 更新
      //    （键盘事件到焦点元素；nativeSimulateKeystrokes 定向搜索框）
      const search = () => t.renderer.findByTestId('settings-search')
      await until('settings search autofocused', () => {
        // autoFocus 生效后才能定向打字：直接尝试打一个字，用 nav 计数面验证
        return search() !== undefined
      })
      const sid = search()!.id
      t.renderer.nativeSimulateKeystrokes(sid, 'bel')
      await until('query committed', () => settingsKeyboard.query() === 'bel')

      // ③ `/` 输入态守卫：焦点在搜索框时 `/` 是普通字符（root 层即使误判
      //    也只是无操作 focusElement——字符照进搜索框；autoFocus 不发
      //    onFocus 是已知面，守卫的后果分析见 keybindings.ts）
      t.renderer.simulateKeystrokes('/')
      await until('slash typed into focused search', () => settingsKeyboard.query() === 'bel/')
      expect(t.renderer.findByTestId('settings-view')).toBeDefined()

      // ④ Esc × 1：query 非空 → 组件层清空，设置面不关（root 层读消费标记）
      t.renderer.simulateKeystrokes('escape')
      await until('query cleared by first Esc', () => settingsKeyboard.query() === '')
      expect(t.renderer.findByTestId('settings-view')).toBeDefined()

      // ⑤ Esc × 2：query 已空 → root 层关闭设置，回上一 thread 表面
      t.renderer.simulateKeystrokes('escape')
      await until(
        'settings closed by second Esc',
        () => t.renderer.findByTestId('settings-view') === undefined,
      )
      expect(currentActiveThreadId()).toBe(tid)

      // ⑥ Ctrl-Tab cycle 仍工作（键位层互不干扰）。先等 spawn 导航生效
      //    （navigate fire-and-forget，需让出后 pathname 才指向新 thread）
      //    全量跑时前面用例的 threads 遗留——cycle 落点按数组序断言，
      //    不假设「下一个 = 本用例开头的 tid」
      await store.spawnFromPreset('shell')
      await until(
        'second thread active',
        () => currentActiveThreadId() === store.getState().threads.at(-1)!.id,
      )
      const threadsBeforeCycle = store.getState().threads
      const curIdx = threadsBeforeCycle.findIndex((x) => x.id === currentActiveThreadId())
      const expectedNext = threadsBeforeCycle[(curIdx + 1) % threadsBeforeCycle.length]!.id
      t.renderer.simulateKeystrokes('ctrl-tab')
      await until('cycled to next thread', () => currentActiveThreadId() === expectedNext)
    },
    TEST_TIMEOUT,
  )
})
