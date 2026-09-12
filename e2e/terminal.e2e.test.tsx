/**
 * e2e/terminal.e2e.test.tsx — T1.6 端到端（architecture.md §9 测试面：
 * element/pool/model 真 PTY + surfaces/registry + Pane 整块替换）。
 *
 * 跑法：bun test e2e/（macOS/Windows + TestGpuixRenderer；真 PTY）。
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
 * - bell 会话 = 本机 Bun 子进程，等待父测试的临时文件握手后写双 BEL。
 *   父测试确认切后台且 terminal 元素解绑后才触发，不依赖 shell 冷启动时长。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestRoot, type TestRoot } from '@gpuix/react/testing'
import { installTerminalElement, destroyTerminalSession, onSessionEvent } from '@jagent/native'

import { inputFocus } from '@jagent/ui'
import { createElement } from 'react'
import { createGitGraphStore } from '../packages/app/src/git/store'
import { createWorktreeStore } from '../packages/app/src/git/worktree'
import { createGlobalKeydown, type GlobalKeydown } from '../packages/app/src/keybindings'
import { App } from '../packages/app/src/plane/AgentPlane'
import { dialogKeyboard } from '../packages/app/src/plane/dialogKeyboard'
import { planeKeyboard } from '../packages/app/src/plane/planeKeyboard'
import {
  currentActiveThreadId,
  router,
  activeTargetFromLocation,
  lastNonSettings,
} from '../packages/app/src/router'
import { memoryAdapter } from '../packages/app/src/settings/file'
import { createSettingsStore } from '../packages/app/src/settings/store'
import { settingsKeyboard } from '../packages/app/src/surfaces/settingsKeyboard'
import { createEchoAgent } from '../packages/app/src/threads/chat'
import { narrowSessionEvent, type TerminalSessionEvent } from '../packages/app/src/threads/events'
import { createNativeThreadDeps } from '../packages/app/src/threads/nativeDeps'
import { type TerminalPreset } from '../packages/app/src/threads/presets'
import { createThreadStore, type ThreadStore } from '../packages/app/src/threads/store'
import { defaultWorkspace } from '../packages/app/src/threads/workspaces'

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
  program: process.execPath,
  args: [join(import.meta.dir, '__fixtures__/bell.ts')],
}

const TEST_TIMEOUT = 30_000
const sessionEvents: TerminalSessionEvent[] = []

let bellFixtureDir: string
let bellTrigger: string
let t: TestRoot
let store: ThreadStore
let e2eWorkspace: ReturnType<typeof defaultWorkspace>
let settings: ReturnType<typeof createSettingsStore>
let keyEvents: string[] = []
// 键位层（store 创建后接线；挂点先占位——与 main.tsx 同一 createGlobalKeydown）
let handleKeydown: GlobalKeydown = () => {}

beforeAll(() => {
  bellFixtureDir = mkdtempSync(join(tmpdir(), 'jagent-e2e-bell-'))
  bellTrigger = join(bellFixtureDir, 'release')
  BELL_PRESET.env = { JAGENT_E2E_BELL_TRIGGER: bellTrigger }

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
      handleKeydown(
        e.key ?? '',
        e.modifiers?.ctrl ?? false,
        e.modifiers?.shift ?? false,
        e.modifiers?.cmd ?? false,
      )
    },
  })

  // 设置面先行（memoryAdapter：隔离真盘；不 init——默认值即测试值）
  settings = createSettingsStore(memoryAdapter())

  // 与 main.tsx 同一装配工厂——只覆盖差异项（notify 静默：e2e 不真弹 toast；
  // presetOf 叠加注入 e2e 专用 bell 预设：settings items 查询优先（真装配
  // 语义，T3.1 自定义预设全链依赖），BELL_PRESET 作为额外项
  // Phase W2：e2e 装配与 main.tsx 首启同构（默认工作区；会话归属它——
  // 侧栏是工作区分组树，无归属行不渲染）
  e2eWorkspace = defaultWorkspace(process.cwd())
  store = createThreadStore(
    createNativeThreadDeps(settings, {
      // T3.2：echo 后端零延迟（产品默认 600ms 模拟思考；e2e 不等）
      chatAgent: createEchoAgent(0),
      notify: () => {},
      presetOf: (id) =>
        settings.get().presets.items.find((p) => p.id === id) ??
        (id === BELL_PRESET.id ? BELL_PRESET : undefined),
    }),
    { initialWorkspaces: [e2eWorkspace] },
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
    focusThreadSearch: () => {
      // W7 ⌘K/Ctrl-K：打开搜索会话弹窗（原型语义；W4 聚焦侧栏搜索框废弃）
      dialogKeyboard.openSearch()
    },
    // D7 ⌘N：新建会话弹窗；D18 抽屉 Esc（与 main.tsx 同链）
    newSession: () => dialogKeyboard.newSession(),
    toggleSidebar: () => planeKeyboard.toggleSidebar(),
    drawerEsc: () => planeKeyboard.escape(),
    inputFocused: () => inputFocus.any,
    settingsQuery: settingsKeyboard.query,
    escConsumed: settingsKeyboard.escConsumed,
    clearEscConsumed: settingsKeyboard.clearEscConsumed,
    // 键位真值 = settings 快照（与 main.tsx 同——修改即时生效，T3+.2）
    keys: () => settings.get().keybindings,
  })

  t.render(
    createElement(App, {
      store,
      settings,
      gitStore: createGitGraphStore(),
      // 假 deps：e2e 不起 git 子进程（status null → not-a-repo 静默态）
      worktree: createWorktreeStore({
        status: async () => null,
        diff: async () => '',
        readFile: async () => null,
      }),
    }),
  )
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
  rmSync(bellFixtureDir, { recursive: true, force: true })
})

describe('T1.6 e2e: two PTYs · retain · bell · exit · close · focus', () => {
  test(
    '初始：EmptyPresets 卡片（内置五预设可见）',
    () => {
      const texts = t.renderer.getAllText()
      expect(texts.some((s) => s.includes('Claude Code'))).toBe(true)
      expect(texts.some((s) => s.includes('Shell'))).toBe(true)
      // V2 统一空态（D15，原型 .home）：h1 文案 + 预设 pills
      expect(texts.some((s) => s.includes('想做点什么'))).toBe(true)
    },
    TEST_TIMEOUT,
  )

  test(
    'spawn（shell + bell）→ 两行并存，active=bell 行，terminal 元素渲染',
    async () => {
      await store.spawnFromPreset('shell', e2eWorkspace.id)
      await store.spawnFromPreset(BELL_PRESET.id, e2eWorkspace.id)

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

      store.activate({ type: 'thread', id: shellRow.id })
      expect(currentActiveThreadId()).toBe(shellRow.id)
      await until('shell surface mounted before releasing bell', () =>
        t.renderer
          .findByType('terminal')
          .some((el) => el.customProps?.sessionId === shellRow.sessionId),
      )
      writeFileSync(bellTrigger, 'release\n')

      // 后台 bell 送达：hasBell=true（全局通道，不依赖元素存活）
      await until('bell event → hasBell on background row', () => {
        const row = store.getState().threads.find((x) => x.id === bellRow.id)
        return row?.kind === 'terminal' && row.hasBell
      }).catch((err) => {
        console.log(
          '[debug] sessionEvents:',
          JSON.stringify(sessionEvents),
          '\n[debug] threads:',
          JSON.stringify(store.getState().threads),
          '\n[debug] active:',
          currentActiveThreadId(),
        )
        throw err
      })
      expect(sessionEvents.some((e) => e.type === 'bell' && `t${e.sessionId}` === bellRow.id)).toBe(
        true,
      )

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

      // V2 语义：exited 行保留且标题弱化（无「已退出」徽标——原型 .row.exited
      // 仅降文字色）。可断言面 = 行仍在列表中 + store status 已退出（上一步已验）。
      await until(
        'exited row kept in list',
        () => t.renderer.findByTestId(`row-${bellRowId}`) != null,
      )

      // close 后台行（当前 active 在它上 → 先导航离开再移除，不变量 1）
      store.close(bellRowId)
      await until('row removed', () => store.getState().threads.length === 1)
      expect(currentActiveThreadId()).not.toBe(bellRowId)

      // close 剩下的行 → 回其工作区起始页（Phase W：close 兑底 = /workspace/$id）
      const lastId = store.getState().threads[0]!.id
      store.close(lastId)
      await until('all rows removed', () => store.getState().threads.length === 0)
      expect(currentActiveThreadId()).toBeNull()
      // Pane 整块替换为工作区起始页（WorkspaceEmpty，非全局 EmptyPresets）
      await until('workspace empty page restored', () =>
        t.renderer.getAllText().some((x) => x.includes('这个工作区还没有会话')),
      )
    },
    TEST_TIMEOUT,
  )

  test(
    '焦点模型：TerminalView 聚焦时窗口 keyDown 仍到达（Ctrl-Tab 全局可用）',
    async () => {
      await store.spawnFromPreset('shell', e2eWorkspace.id)
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
      await store.spawnFromPreset('shell', e2eWorkspace.id)
      const rows = store.getState().threads
      const target = rows[0]!
      await until(
        'two rows rendered',
        () => t.renderer.findByTestId(`row-${target.id}`) !== undefined,
      )

      // 点击 target 行中心（标题文字区——GPUIX 不冒泡，装饰 text 必须
      // pe:none 让命中穿透到行容器；无此修复点击会被文字吞掉）
      const el = t.renderer.findByTestId(`row-${target.id}`)!
      const b = t.renderer.getElementBounds(el.id)!
      expect(currentActiveThreadId()).not.toBe(target.id)
      t.renderer.nativeSimulateClick(b[0] + b[2] / 2, b[1] + b[3] / 2)

      await until('click on row text activates thread', () => currentActiveThreadId() === target.id)
    },
    TEST_TIMEOUT,
  )

  test(
    'T2.5 设置联动：terminal 外观 props 随 settings.terminal 变化',
    async () => {
      await store.spawnFromPreset('shell', e2eWorkspace.id)
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
        () => (props().fontSize as number) === 18 && props().cursorBlink === false,
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
      await store.spawnFromPreset('shell', e2eWorkspace.id)
      await until('terminal mounted', () => t.renderer.findByType('terminal').length >= 1)
      const tid = currentActiveThreadId()

      // ① Ctrl-, 开设置：窗口 root 键位层（与 main.tsx 同构的 handleKeyDown
      // 已在 createTestRoot 挂点里）——键盘事件走真 GPUI 输入管线
      t.renderer.simulateKeystrokes('ctrl-,')
      await until(
        'settings view open',
        () => t.renderer.findByTestId('settings-view') !== undefined,
      )

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
      await store.spawnFromPreset('shell', e2eWorkspace.id)
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

  test(
    'T3.1 自定义预设全链：settings CRUD → nativeDeps presetOf → 真 PTY spawn → exit 灰行',
    async () => {
      // ① 设置层新增自定义预设（真 SettingsStore CRUD 面）
      const nid = settings.addPreset({
        label: 'E2E 自定义',
        program: process.execPath,
        args: ['-e', 'console.log("jagent-custom")'],
      })
      const added = settings.get().presets.items.find((p) => p.id === nid)
      expect(added?.builtin).toBe(false)

      // ② spawn 走真 nativeDeps.presetOf（查 settings items，非 e2e override；
      //    lastUsedPreset 更新）。W2 起 + 主按钮移除：UI 面断言改为归属行
      //    出现在工作区分组树
      await store.spawnFromPreset(nid, e2eWorkspace.id)
      const row = store.getState().threads.at(-1)!
      expect(row.kind === 'terminal' && row.preset === nid).toBe(true)
      expect(store.getState().lastUsedPreset).toBe(nid)
      await until(
        'row visible in workspace tree',
        () => t.renderer.findByTestId(`row-${row.id}`) !== undefined,
      )

      // ③ 真 PTY 整链：echo 完进程退出 → exited 灰行保留（closeOnExit=false）
      await until('custom preset process exits', () => {
        const r = store.getState().threads.find((x) => x.id === row.id)
        return r?.kind === 'terminal' && r.status === 'exited'
      })
      expect(currentActiveThreadId()).toBe(row.id)

      // ④ 清理：close 销毁会话 + 行移除（避免污染后续用例）
      store.close(row.id)
      await until('closed', () => !store.getState().threads.some((x) => x.id === row.id))
      settings.deletePreset(nid)
    },
    TEST_TIMEOUT,
  )
})

describe('T3.2 e2e: chat 全链（菜单入口 → ChatSurface → echo 回复 → close）', () => {
  test(
    'New Chat 菜单入口 → 消息往返 → 混排列表 → close',
    async () => {
      const threadsBefore = store.getState().threads.length

      // ① + 菜单展开：预设项 + 固定 New Chat（分隔线下）
      const menuBtn = t.renderer.findByTestId(`new-menu-${e2eWorkspace.id}`)!
      const mb = t.renderer.getElementBounds(menuBtn.id)!
      t.renderer.nativeSimulateClick(mb[0] + mb[2] / 2, mb[1] + mb[3] / 2)
      await until('preset menu open with New Chat item', () => {
        const item = t.renderer.findByTestId('new-chat')
        return item !== undefined && t.renderer.getElementBounds(item.id) != null
      })

      // ② 点击 New Chat → ChatSurface 挂载（CHAT pill + composer autoFocus）
      const item = t.renderer.findByTestId('new-chat')!
      const ib = t.renderer.getElementBounds(item.id)!
      t.renderer.nativeSimulateClick(ib[0] + ib[2] / 2, ib[1] + ib[3] / 2)
      const chatId = currentActiveThreadId()
      expect(chatId).toMatch(/^c/)
      await until('chat surface mounted', () => {
        const texts = t.renderer.getAllText()
        return texts.includes('CHAT') && t.renderer.findByTestId('chat-composer') !== undefined
      })

      // ③ 混排：chat 行与既有 terminal 行同列表（图标/标题渲染面）
      await until('chat row in mixed list', () => {
        const row = t.renderer.findByTestId(`row-${chatId}`)
        return row !== undefined
      })

      // ④ composer 打字 + enter → user 落列 + thinking → echo 回复落列
      //    （e2e 装配 chatAgent=echo 零延迟；真 setTimeout 异步链）
      t.renderer.simulateKeystrokes('helloe2e')
      await until('draft committed', () => {
        const c = t.renderer.findByTestId('chat-composer')
        return t.renderer.getElement(c!.id)?.customProps?.value === 'helloe2e'
      })
      t.renderer.simulateKeystrokes('enter')
      await until('user message + thinking', () => {
        const texts = t.renderer.getAllText()
        return texts.includes('helloe2e') && texts.includes('thinking…')
      })
      await until('echo reply rendered', () =>
        t.renderer
          .findByType('markdown')
          .some((el) =>
            String(t.renderer.getElement(el.id)?.customProps?.source ?? '').includes('收到'),
          ),
      )
      // 首条消息改写标题：列表行标题 = helloe2e
      await until('row title rewritten', () =>
        t.renderer.getAllText().some((s) => s === 'helloe2e'),
      )

      // ⑤ close chat（无 session 销毁）：行移除，不误伤 terminal 行
      store.close(chatId!)
      await until('chat row removed', () => !store.getState().threads.some((x) => x.id === chatId))
      expect(store.getState().threads.length).toBe(threadsBefore)
    },
    TEST_TIMEOUT,
  )
})

describe('T3+.1 e2e: ACP 全链（菜单入口 → AcpSurface → 真子进程 JSON-RPC → close）', () => {
  test(
    'agent 菜单入口 → fake agent 子进程会话 → echo 回复 → close 释放',
    async () => {
      // ① 注入 fake agent 配置（真 nativeDeps.createAcpAgent 读 settings →
      //    process.execPath 真 spawn fake-acp-agent.ts——完整 stdio JSON-RPC 链）
      const fixture = join(
        import.meta.dir,
        '..',
        'packages',
        'app',
        'src',
        'threads',
        '__fixtures__',
        'fake-acp-agent.ts',
      )
      settings.patch('acpAgents', [
        { id: 'e2e-fake', label: 'FakeACP', command: process.execPath, args: [fixture] },
      ])
      const threadsBefore = store.getState().threads.length

      // ② 菜单展开 → agent 项（分隔线下，New Chat 之后）
      const menuBtn = t.renderer.findByTestId(`new-menu-${e2eWorkspace.id}`)!
      const mb = t.renderer.getElementBounds(menuBtn.id)!
      t.renderer.nativeSimulateClick(mb[0] + mb[2] / 2, mb[1] + mb[3] / 2)
      await until('agent entry in menu', () => {
        const item = t.renderer.findByTestId('new-acp-e2e-fake')
        return item !== undefined && t.renderer.getElementBounds(item.id) != null
      })

      // ③ 点击 → AcpSurface 挂载（ACP pill + 标题 = label）
      const item = t.renderer.findByTestId('new-acp-e2e-fake')!
      const ib = t.renderer.getElementBounds(item.id)!
      t.renderer.nativeSimulateClick(ib[0] + ib[2] / 2, ib[1] + ib[3] / 2)
      const acpId = currentActiveThreadId()
      expect(acpId).toMatch(/^a/)
      await until('acp surface mounted', () => {
        const texts = t.renderer.getAllText()
        return texts.includes('ACP') && t.renderer.findByTestId('acp-composer') !== undefined
      })
      await until(
        'acp row in mixed list',
        () => t.renderer.findByTestId(`row-${acpId}`) !== undefined,
      )

      // ④ 打字 + enter → 子进程 initialize/session/new/prompt → echo 回复
      //    （连接情建：首条消息才 spawn——UI 无感）
      t.renderer.simulateKeystrokes('pingacp')
      await until('draft committed', () => {
        const c = t.renderer.findByTestId('acp-composer')
        return t.renderer.getElement(c!.id)?.customProps?.value === 'pingacp'
      })
      t.renderer.simulateKeystrokes('enter')
      await until('user message + thinking', () => {
        const texts = t.renderer.getAllText()
        return texts.includes('pingacp') && texts.includes('thinking…')
      })
      await until('fake agent reply rendered', () =>
        t.renderer
          .findByType('markdown')
          .some((el) =>
            String(t.renderer.getElement(el.id)?.customProps?.source ?? '').includes(
              'echo: pingacp',
            ),
          ),
      )
      // 首条消息改写标题（autoTitle → pingacp）
      await until('row title rewritten', () =>
        store.getState().threads.some((x) => x.id === acpId && x.title === 'pingacp'),
      )

      // ⑤ close → 连接 dispose（子进程 kill）+ 行移除
      store.close(acpId!)
      await until('acp row removed', () => !store.getState().threads.some((x) => x.id === acpId))
      expect(store.getState().threads.length).toBe(threadsBefore)
    },
    TEST_TIMEOUT,
  )
})

describe('T3+.2 e2e: 键位可编辑（捕获格 → 即时生效 → Advanced JSON 视图）', () => {
  test(
    '改键即时生效 + Advanced 分区 JSON 实时视图 + 键位表动态命中',
    async () => {
      // 前置：设置面打开（Ctrl-, 默认键位）
      t.renderer.simulateKeystrokes('ctrl-,')
      await until(
        'settings view open',
        () => t.renderer.findByTestId('settings-view') !== undefined,
      )

      // ① 改键：toggleSettings → ctrl-.（设置层直改；键位层 getter 即时读）
      settings.patch('keybindings.toggleSettings', 'ctrl-.')
      expect(settings.get().keybindings.toggleSettings).toBe('ctrl-.')

      // ② 新键位生效：ctrl-. 关设置（旧 ctrl-, 不再响应）
      t.renderer.simulateKeystrokes('ctrl-.')
      await until(
        'settings closed by new binding',
        () => t.renderer.findByTestId('settings-view') === undefined,
      )
      t.renderer.simulateKeystrokes('ctrl-,')
      await new Promise((r) => setTimeout(r, 150))
      expect(t.renderer.findByTestId('settings-view')).toBeUndefined()

      // ③ 重开设置 → Advanced 分区：JSON 实时视图 + 诊断卡 + 打开钮（memory 无 path）
      t.renderer.simulateKeystrokes('ctrl-.')
      await until(
        'settings reopened by new binding',
        () => t.renderer.findByTestId('settings-view') !== undefined,
      )
      const adv = () => t.renderer.findByTestId('nav-advanced')
      const a = adv()!
      const b = t.renderer.getElementBounds(a.id)!
      t.renderer.nativeSimulateClick(b[0] + b[2] / 2, b[1] + b[3] / 2)
      await until(
        'json view visible',
        () => t.renderer.findByTestId('settings-json-view') !== undefined,
      )
      expect(t.renderer.findByTestId('diagnostics-card')).toBeDefined()
      expect(t.renderer.findByTestId('open-settings-json')).toBeUndefined() // memory adapter 无 path
      const json = String(
        t.renderer.getElement(t.renderer.findByTestId('settings-json-view')!.id)?.customProps
          ?.source ?? '',
      )
      expect(json).toContain('ctrl-.')
      expect(json).toContain('"keybindings"')

      // ④ 键位表搜索动态命中：搜 esc → 只读行 'Esc（平台语义）' 命中
      //    （ctrl-. 组合键不产生文本；tab 是焦点移动键——都用普通字符）
      const search = t.renderer.findByTestId('settings-search')!
      t.renderer.focusElement(search.id)
      t.renderer.nativeSimulateKeystrokes(search.id, 'esc')
      await until('search query committed', () => settingsKeyboard.query() === 'esc')
      // 跨分区命中列表出现 Keybindings 分区（键位值动态命中 ctrl-.）
      await until('keybindings section listed in search results', () =>
        t.renderer.getAllText().some((x) => x.includes('Keybindings · 键位')),
      )

      // ⑤ 收尾：Esc ×2（先清 query 再关设置——T2.6 同语义）+ 键位回默认
      t.renderer.simulateKeystrokes('escape')
      await until('query cleared', () => settingsKeyboard.query() === '')
      t.renderer.simulateKeystrokes('escape')
      await until('settings closed', () => t.renderer.findByTestId('settings-view') === undefined)
      settings.reset('keybindings.toggleSettings')
      expect(settings.get().keybindings.toggleSettings).toBe('ctrl-,')
    },
    TEST_TIMEOUT,
  )
})

// ═══════════════════════════════════════════════════════════════════
// Phase W e2e：工作区全链（多工作区 spawn 归属 → 跨工作区 cycle →
// 恢复最近会话 → 移除连锁回退 → ⌘K 端到端）。前面 describe 的会话继续
// 存活（retain 语义），不重置 store——按 arrival 顺序构造归属。
// ═══════════════════════════════════════════════════════════════════
describe('Phase W e2e: 工作区全链', () => {
  let w2: string
  let w1ShellId: string
  let w2ShellId: string

  test(
    '添加工作区 → spawn 归属 → 侧栏双分组渲染',
    async () => {
      // 自包含：前面 describe 的会话已被各自收尾 close——w1 会话在此新建
      await store.spawnFromPreset('shell', e2eWorkspace.id)
      w2 = store.addWorkspace('proj2', '/w/proj2')
      await store.spawnFromPreset('shell', w2)

      const s = store.getState()
      expect(s.workspaces).toHaveLength(2)
      const t2 = s.threads.filter((x) => x.kind === 'terminal' && x.workspaceId === w2)
      expect(t2).toHaveLength(1)
      w2ShellId = t2[0]!.id
      // 全量跑时前面 describe 会遗留 threads（retain 池）——取「最后 spawn
      // 的」w1 会话（本用例刚 spawn 的），不假设唯一
      const t1 = s.threads
        .filter((x) => x.kind === 'terminal' && x.workspaceId === e2eWorkspace.id)
        .filter((x) => x.id === s.threads.at(-2)?.id || x.id === s.threads.at(-1)?.id)
      expect(t1.length).toBeGreaterThanOrEqual(1)
      w1ShellId = t1.at(-1)!.id

      // 侧栏分组树：两个 workspace 行 + 缩进行
      await until('both workspace rows', () => {
        t.renderer.flush()
        return (
          t.renderer.findByTestId(`workspace-${e2eWorkspace.id}`) != null &&
          t.renderer.findByTestId(`workspace-${w2}`) != null &&
          t.renderer.findByTestId(`row-${w1ShellId}`) != null &&
          t.renderer.findByTestId(`row-${w2ShellId}`) != null
        )
      })
      // lastSession 记账：w2 的最近会话 = 新 shell
      expect(store.getState().workspaces.find((x) => x.id === w2)?.lastSession).toBe(w2ShellId)
    },
    TEST_TIMEOUT,
  )

  test(
    'Ctrl-Tab 跨工作区 cycle（真事件管线；环形流转）',
    async () => {
      // 收敛：activate w2 的 shell；router push 异步 → until 生效后再走
      store.activate({ type: 'thread', id: w2ShellId })
      await until('w2 active', () => currentActiveThreadId() === w2ShellId)

      // 真管线（simulateKeystrokes；navigate fire-and-forget，每步等生效）
      const ring = store.getState().threads.length
      const seen = new Set<string>([w2ShellId])
      for (let i = 0; i < ring + 2; i++) {
        // prev 必须在 tab 前取：tab 生效（activate → navigate 异步落地）后
        // 才算一次「落地」，循环里 prev-after 结构会死锁等下一次变化
        const prev = currentActiveThreadId()
        t.renderer.simulateKeystrokes('ctrl-tab')
        await until('cycle landed', () => currentActiveThreadId() !== prev)
        const cur = currentActiveThreadId()
        if (cur != null) seen.add(cur)
        if (cur === w2ShellId) break
      }
      expect(seen.has(w1ShellId)).toBe(true) // 跨工作区环形可达
      expect(currentActiveThreadId()).toBe(w2ShellId)
    },
    TEST_TIMEOUT,
  )

  test(
    'activateWorkspace 恢复 lastSession；close 后回退空态（临时 w3，不破坏 w1/w2）',
    async () => {
      const w3 = store.addWorkspace('w3', '/w/w3')
      await store.spawnFromPreset('shell', w3)
      const w3Id = store
        .getState()
        .threads.find((x) => x.kind === 'terminal' && x.workspaceId === w3)!.id

      // 切走 → activateWorkspace(w3) 恢复其最近会话
      store.activate({ type: 'thread', id: w1ShellId })
      store.activateWorkspace(w3)
      expect(currentActiveThreadId()).toBe(w3Id)
      expect(store.getState().workspaces.find((x) => x.id === w3)?.lastSession).toBe(w3Id)

      // close → lastSession 清（null）→ activateWorkspace 回起始页（不激活死 id）
      store.close(w3Id)
      expect(store.getState().workspaces.find((x) => x.id === w3)?.lastSession ?? null).toBeNull()
      store.activateWorkspace(w3)
      expect(currentActiveThreadId()).toBeNull()
      store.removeWorkspace(w3) // 收尾
    },
    TEST_TIMEOUT,
  )

  test(
    '⌘K/Ctrl-K 端到端：打开搜索会话弹窗（terminal 在场不写 PTY）',
    async () => {
      // W7：⌘K → dialogKeyboard.openSearch()（模块态 → AgentPlane DialogHost）
      // 键事件走真事件管线（root onKeyDown → handleKeydown）
      t.renderer.simulateKeystrokes(process.platform === 'darwin' ? 'cmd-k' : 'ctrl-k')
      await until('search dialog visible', () => t.renderer.findByTestId('modal-card') != null)
      expect(t.renderer.findByTestId('search-dialog-input') != null).toBe(true)
      // 关闭收尾（V2 命令面板无 X 钮——遮罩点击；点左上角落避开卡片）
      const scrim = t.renderer.findByTestId('modal-scrim')!
      const cb = t.renderer.getElementBounds(scrim.id)!
      t.renderer.nativeSimulateClick(cb[0] + 4, cb[1] + 4, 0)
      await until('search dialog closed', () => t.renderer.findByTestId('modal-card') == null)
      // 无 PTY 泄漏：两工作区 shell 会话仍在（未被误关/误写崩溃）
      const terms = store.getState().threads.filter((x) => x.kind === 'terminal')
      expect(terms.length).toBeGreaterThanOrEqual(2)
    },
    TEST_TIMEOUT,
  )

  test(
    'removeWorkspace：连锁 close 会话 + 工作区消失 + 活跃回退存活会话',
    async () => {
      store.activate({ type: 'thread', id: w2ShellId })
      expect(currentActiveThreadId()).toBe(w2ShellId)
      store.removeWorkspace(w2)
      const s = store.getState()
      expect(s.workspaces.map((x) => x.id)).not.toContain(w2)
      expect(s.threads.some((x) => x.id === w2ShellId)).toBe(false)
      // close 单点既有语义：active thread 被 close → activate(null) 回起始页
      expect(currentActiveThreadId()).toBeNull()
      await until(
        'sidebar shows single group',
        () => t.renderer.findByTestId(`workspace-${w2}`) == null,
      )
    },
    TEST_TIMEOUT,
  )
})
