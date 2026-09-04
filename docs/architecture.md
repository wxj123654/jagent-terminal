# j-agent 代码架构

状态：**已拍板**（2026-09-02；D7 声明式清单、R1/R2 契约回写经用户确认；落地前最后人工审读中）  
依据：`docs/agent-plane-layout.md` · `docs/gpuix-zed-terminal-fusion.md` · `docs/settings-ui.md`（三份已拍板契约）  
参考：GPUIX（CustomElement 体系源码）· Zed `crates/terminal` / `terminal_view` / `agent_ui` · muxel / Paneflow（单 crate 按 feature 组织）  
定位：**本文是代码实现契约**——模块划分、接口签名、依赖方向、测试面。落地时对齐本文，而不是重新发明结构。

---

## 0. 设计原则（本项目版）

| 原则 | 本项目的表达 |
|---|---|
| 深模块：小接口后面大量行为 | `<terminal>` 元素 9 个名字的接口 ≈ 一个完整终端仿真器；ThreadStore 6 个方法吃掉全部会话规则 |
| seam 放在真有变化的地方 | Rust/JS 之间（语言变化）、surface 之间（5 种表面）、file adapter 之间（真盘 vs 内存测试） |
| 一个 adapter = 假设性 seam；两个才拆 | 首期 crate 上限 2、包上限 2；shared types 包缓建 |
| interface 即测试面 | ThreadStore / SettingsStore 纯 TS 可测；TerminalPool 经 napi seam 用 TestGpuixRenderer + 真 PTY 测 |
| 删除测试 | 删 ThreadStore → 冻结/清红点/retain 规则在 N 个组件里重现 → 它在挣钱；删 native 壳 → 装配代码散进 app → 同 |

**目录纪律：按 feature 组织，不按实现角色组织。**（muxel / Paneflow / Rust GUI 社区共识，亦即 2025–2026 的通用最佳实践）

---

## 1. 总览

```
┌────────────────────────────────────────────────────────────────────┐
│ packages/app（React 壳，JS 拥有会话）                                │
│                                                                    │
│   plane/          surfaces/           threads/         settings/   │
│   AgentPlane      registry + 5 surface ThreadStore     SettingsStore│
│   Sidebar/Pane    （Pane 整块替换）    （唯一事实源）    （json 事实源）│
│        │               │                  │                │       │
│        └─────── useSyncExternalStore ─────┴────────────────┘       │
│                        main.tsx 装配 + 全局键位                       │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ napi（唯一的跨语言 seam）
┌──────────────────────────┴─────────────────────────────────────────┐
│ Rust                                                               │
│   packages/native（薄壳：createRenderer + registry 装配 + 3 个命令）  │
│        │                                                           │
│   crates/jagent-terminal（深库）                                    │
│     TerminalPool ── pty.rs / view.rs(TerminalModel) / element.rs   │
│     examples/window.rs（Phase 0 验证载体）                           │
└────────────────────────────────────────────────────────────────────┘
```

### 1.1 目录树（首期全量）

```
j-agent/
├── docs/                              # 契约（已有）
├── design/                            # 原型（已有）
├── package.json                       # bun workspace：packages/*
├── Cargo.toml                         # cargo workspace：packages/native + crates/*
│
├── crates/
│   └── jagent-terminal/               # Rust 库：终端会话池 + 元素（无 napi 依赖）
│       ├── src/
│       │   ├── lib.rs                 #   mod 声明 + pub use
│       │   ├── pool.rs                #   TerminalPool：会话表 + 事件转发
│       │   ├── pty.rs                 #   PTY 生命周期（Zed tty/alacritty 模式；TERM/COLORTERM 默认在此）
│       │   ├── model.rs               #   TerminalModel：Term + 设置 + 向上事件
│       │   └── view.rs                #   终端绘制（依赖 gpui-terminal 或 vendored）
│       ├── examples/
│       │   └── window.rs              #   ★ Phase 0：独立 gpui 窗口验证
│       └── Cargo.toml
│
├── packages/
│   ├── native/                        # @jagent/native：napi 壳（<150 行目标）
│   │   ├── src/lib.rs                 #   createRenderer / 3 个会话命令 / 事件注册
│   │   ├── index.d.ts                 #   napi 生成（勿手改）
│   │   ├── Cargo.toml                 #   依赖 jagent-terminal + gpuix Rust 源
│   │   └── package.json
│   │
│   └── app/                           # React 应用（唯一前端包）
│       ├── src/
│       │   ├── main.tsx               #   装配 + 全局键位 + renderer 事件桥
│       │   ├── router.tsx             #   路由树（/ · /thread/$id · /settings）+
│       │   │                          #   memory history + useActiveTarget + 手动桥（R-V1）
│       │   ├── plane/                 #   AgentPlane / Sidebar / ThreadList /
│       │   │                          #   ThreadRow / NewThreadButton / Pane
│       │   ├── threads/               #   store.ts + terminal.ts + presets.ts +
│       │   │                          #   events.ts（SessionEvent 窄化）+
│       │   │                          #   nativeDeps.ts（装配工厂）
│       │   ├── surfaces/              #   registry.ts + Terminal/Chat/Acp/Empty
│       │   │   └── settings/          #   SettingsView + 7 分区
│       │   ├── settings/              #   schema.ts / store.ts / file.ts
│       │   └── ui/                    #   Icon / Tooltip / SettingRow / 控件
│       └── package.json               #   依赖 @gpuix/react + @jagent/native
│
└── e2e/                               # GPUIX TestGpuixRenderer 测试（bun test）
```

### 1.2 依赖方向（JS 侧，禁止反向）

```
main.tsx ──> router.ts（路由树装配，不依赖任何业务模块）
    ├──> plane ──> threads（读类型+调方法）· router（useActiveTarget）
    │      └───> surfaces ──> threads（读类型）
    │              └────────> settings（读值）        [仅 TerminalSurface/SettingsView]
    ├──> settings（构造 SettingsStore）
    └──> native（仅 main.tsx 与 threads/store.ts 的注入参数可见）
```

规则：
- `threads` **不依赖** `surfaces`、`plane`（store 不知道谁在渲染它）；导航经注入的 `deps.navigate`（§3.2）
- `router.ts` 只描述 URL 形状，不 import threads / surfaces / settings
- `settings` 不依赖 `threads`（两个 store 平行；装配层桥接 `closeOnExit` 等）
- `native` 的导入只允许出现在 `main.tsx`、`threads/nativeDeps.ts`（装配工厂，main 与 e2e 共用）与 `threads/store.ts` 的依赖注入参数类型里，及 `e2e/`（TestGpuixRenderer 环境）——跨语言 seam 的 JS 侧收口
- `ui` 被所有人依赖，不依赖任何人

---

## 2. 跨语言 seam（本文核心增量）

契约草图（agent-plane-layout.md §9）把 `cwd/initCommand` 直接写在 `<terminal>` props 上。落地推演发现该草图**无法同时满足两条已拍板规则**：

> GPUIX 生命周期：`React unmount → CustomElement::destroy()`，且每帧 `prune_missing` 清理不在 retained tree 的实例。  
> 拍板规则 6：切 thread = 卸掉整块 body；后台 PTY **retain**。

→ 若元素持有 PTY，「卸载 body」就是「销毁 PTY」，矛盾。且后台 BEL 发生时元素不存在，`onBell` 无处触发。

**解法（Zed 同构：`terminals: HashMap` 持有实体，`BaseView::Terminal{terminal_id}` 只是引用）：Rust 侧全局 TerminalPool 持有会话；`<terminal>` 是按 sessionId 绑定的视图代理；会话事件走全局通道。**

### 2.1 seam 全景

```
JS ──命令──────────────────────> Rust
     createTerminalSession(opts) → sessionId     （spawn：PTY + initCommand 键入）
     destroyTerminalSession(sessionId)           （关闭：杀进程 + 出池）
     onSessionEvent(cb)                          （注册全局回调，init 时一次）

JS ──元素 props（每帧 diff）──> Rust
     <terminal sessionId font* cursorBlink palette onFocus>

Rust ──会话事件（全局通道）────> JS
     {type:'title'|'bell'|'exit', sessionId, ...}  （后台也送达）

Rust ──元素事件（按 elementId）> JS
     focus / blur                                （视图概念，仅前台有意义）
```

字节流不过 napi（fusion.md §4 硬约束 6 维持）。事件仍然只有 4 种，只是路由分两条。

### 2.2 Rust 侧：TerminalPool

```rust
// crates/jagent-terminal/src/pool.rs
pub struct TerminalPool {
    sessions: HashMap<u64, Entity<TerminalModel>>,
    next_id: AtomicU64,
}
// Mutex：OnceLock 只给共享引用；create/destroy 需要可变访问。
// Phase 3 多窗口可直接共享同一池。
pub static POOL: OnceLock<Mutex<TerminalPool>> = OnceLock::new();  // ← 已修订为 gpui Global，见 R5
impl TerminalPool {
    pub fn create(&mut self, opts: SpawnOptions, window, cx) -> Result<u64>;
    pub fn destroy(&mut self, id: u64, cx) -> Result<()>;
    pub fn get(&self, id: u64) -> Option<Entity<TerminalModel>>;
}
```

- `create`：spawn PTY（opts.program 空 = 系统默认 shell）→ 建 `TerminalModel` → **initCommand 作为键入写入**：`write_to_pty(cmd)` + `write_to_pty(b"\x0d")`（Zed activation_script 先例；PowerShell 必须 `\r` 不能 `\r\n`，否则进续行模式）→ 订阅 model 事件转发到全局 `SessionEventFn`（napi ThreadsafeFunction）→ 返回 sessionId
- `destroy`：kill 进程、drop entity、出池
- 会话在池中存续与元素无关——**retain 由池保证，不 paint 由元素不存在保证**（GPUI immediate mode：不 render 就不画）

```rust
// 上行事件（pool 转发，model 的 gpui Event 订阅）
pub enum SessionEvent {          // → JS payload
    Title { id: u64, title: String },   // {type:'title', sessionId, title}
    Bell  { id: u64 },                  // {type:'bell',  sessionId}
    Exit  { id: u64, code: Option<i32> }// {type:'exit',  sessionId, code}
}
```

（`code` 已贯通：alacritty `ChildExit(ExitStatus)` 携带退出码，model 区分
`ChildExit`（带码）与裸 `Exit`（无码）两分支、先到先转发，2026-09-04 审查后实现。）

### 2.3 napi 命令面（packages/native/src/lib.rs）

```ts
// 全部对 JS 暴露的跨语言面（index.d.ts 自动生成）
type SpawnOptions = {
  cwd?: string                       // 默认项目根/家目录
  program?: string                   // 空 = 系统默认 shell
  args?: string[]
  env?: Record<string, string>       // 如 AMP_FORCE_BEL=1
  initCommand?: string               // 键入，不是 exec（Rust create 内完成）
  scrollbackLines?: number           // 会话属性，创建时定
}
function createTerminalSession(opts: SpawnOptions): Promise<number>   // → sessionId
function destroyTerminalSession(sessionId: number): Promise<void>
function onSessionEvent(cb: (e: SessionEvent) => void): void

// createRenderer：包装 gpuix 构造 + registry.register(TerminalFactory)
//                + init_zed_subsystems（theme/settings，一次性）
```

外观类参数（fontFamily/fontSize/cursorBlink/palette）**不进 SpawnOptions**——它们是即时生效的显示设置，走元素 props，改字号不重开会话。

### 2.4 `<terminal>` 元素

```tsx
// TerminalSurface.tsx —— 全项目唯一写 <terminal> 的地方
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      terminal: TerminalElementProps
    }
  }
}
interface TerminalElementProps {
  sessionId: number                    // 绑定池中会话（必需）
  fontFamily?: string                  // 外观 props：设置变化 → 重渲染 → setCustomProp
  fontSize?: number
  cursorBlink?: boolean
  palette?: string
  focused?: boolean                    // activate 后请求焦点（Phase 1 验证 GPUIX 焦点模型后定稿）
  onFocus?: (e: { sessionId: number }) => void
  onBlur?: (e: { sessionId: number }) => void
}
```

Rust 侧 element 职责：

```rust
// crates/jagent-terminal/src/element.rs
pub struct TerminalFactory;                    // element_type() = "terminal"
pub struct TerminalElement {
    session_id: Option<u64>,                   // set_prop("sessionId") 绑定
    font: FontSettings,                        // set_prop 外观 → 转发 model
    subscription: Option<Subscription>,        // 绑定时订阅 model 的 Wakeup → cx.notify()
}
impl CustomElement for TerminalElement {
    fn render(ctx, window, cx) -> AnyElement {
        // POOL.get(session_id) → view.rs 渲染 TerminalModel
        // 无绑定/会话不存在 → 占位 div（灰底 "session ended"）
    }
    fn supported_props(&self) -> &'static [&'static str] { &["sessionId","fontFamily","fontSize","cursorBlink","palette","focused"] }
    fn supported_events(&self) -> &'static [&'static str] { &["focus","blur"] }
    fn destroy(&mut self) { /* 只解绑订阅。不动会话——retain 语义 */ }
}
```

- **resize**：元素 render 时对比 model 的 `terminal_bounds` 与视口尺寸，变化则 `model.resize()`——不经 JS
- **焦点**：优先把键盘交给 view 内部的 FocusHandle（硬约束 2）；`focused` prop 的取舍（GPUIX onKeyDown 抢键风险）是 Phase 1 的验证项之一，接口先留位

### 2.5 对契约的修订声明（6 条）

| # | 契约草图 | 本文修订 | 理由 |
|---|---|---|---|
| R1 | `<terminal cwd initCommand env …>` | props = `sessionId` + 外观；spawn 走 `createTerminalSession` | retain vs destroy 冲突（本节开头） |
| R2 | `onTitle/onBell/onExit` 元素事件 | 走全局 `onSessionEvent`；元素只留 `onFocus/onBlur` | 后台 BEL 时元素不存在 |
| R3 | `status: idle\|running\|needs-you\|exited` | `status: running\|exited` + `hasBell: boolean` | needs-you 与 hasBell 是同一事实的两种表达；展示层（§4 行为）只用 hasBell + exited，语义不变 |
| R4 | thread id 未定义 | `t{sessionId}` / `c{uuid}` / `a{uuid}` | 混排列表 id 唯一；terminal id 可从事件直接定位 |
| R5 | `POOL: OnceLock<Mutex<TerminalPool>>`（§2.2） | 会话表改 gpui `Global`（`cx.set_global`/`update_global`）；事件转发拆独立 `static OnceLock<SessionEventFn>` | gpui `Entity`/`Subscription` 非 `Send`，static Mutex 编译不过；SessionEventFn 本身 Send+Sync。语义不变（2026-09-02 Phase 0 实测定稿） |
| R6 | view.rs「首选依赖 gpui-terminal」（§8.1） | **已拍板 vendoring**（render/input/colors/box_drawing 四文件 + TerminalView 重写为绑 model） | fork 与 crates.io 同号 0.2.2 不同 API，依赖也需 patch；且 D2 要求 view 不持 PTY，结构性改动不可避免（Phase 0 结论，TODOLIST 结论区） |

R1/R2 已回写 `agent-plane-layout.md`（§2 所有权 / §9 组件树与 TerminalThread / §11 文档表）；`gpuix-zed-terminal-fusion.md` §3 L2 已加指针注记。

---

## 3. threads/ —— ThreadStore

### 3.1 类型

```ts
// threads/store.ts
export type TerminalThread = {
  kind: 'terminal'
  id: string                        // `t${sessionId}`
  sessionId: number
  preset?: string                   // 对应 TerminalPreset.id（内置或自定义）
  cwd: string
  initCommand?: string              // 兜底标题用
  oscTitle?: string                 // 来自 SessionEvent.title
  customTitle?: string              // 手改后冻结（不再被 OSC 覆盖）
  status: 'running' | 'exited'      // R3
  exitCode?: number | null
  hasBell: boolean                  // activate 该 thread 时清除
  createdAt: number
}
export type ChatThread  = { kind:'chat'; id:string; title:string; createdAt:number }   // Phase 2 骨架
export type AcpThread   = { kind:'acp';  id:string; title:string; createdAt:number }   // Phase 3 骨架
export type Thread = TerminalThread | ChatThread | AcpThread

export type ActiveTarget =             // 派生视图类型：从路由状态算出（§3.5）
  | { type: 'thread'; id: string }    // 路由 /thread/$id
  | { type: 'settings' }              // 路由 /settings（S1：特殊表面，非 thread）
  | null                              // 路由 / → EmptyPresets

export type ThreadState = {
  threads: Thread[]                 // 混排，创建序
  lastUsedPreset: string | null     // 运行时态，不写 settings.json
}                                   // active 不在此——导航唯一事实源是 router（§3.5）
```

`displayTitle(t)`（纯函数，threads/terminal.ts）：
`customTitle ?? oscTitle ?? initCommand ?? "Terminal"`——契约 §4，一字不改。

### 3.2 接口

```ts
// 依赖注入——store 本体零 native / 零 router 导入，纯 TS 可测
type ThreadDeps = {
  spawnSession: (o: SpawnOptions) => Promise<number>
  destroySession: (id: number) => Promise<void>
  navigate: (t: ActiveTarget) => void          // 路由跳转薄包装（装配层 = router.navigate）
  notify: (t: TerminalThread) => void          // 桌面通知（读 settings.desktop 的逻辑在装配层；
                                               //  实现 Phase 2 定：JS 侧 node-notifier vs
                                               //  Rust 侧 win32 toast——后者要扩 napi 面）
  closeOnExit: () => boolean                   // 读 settings 终端区（装配层桥接）
  presetOf: (id: string) => TerminalPreset | undefined
}
```

实现底座：**zustand/vanilla**（`createStore`，不绑 React）+ **immer**（不可变更新）。接口是唯一契约——
`getState/subscribe` 直通 zustand store，方法内部 `setState(produce(s => { … }))`
可变写法（immer 负责不可变化与结构共享）；React 侧用 `useStore(store, selector)`
按粒度订阅（ThreadRow 订阅自己那行，引用不变即跳过渲染）。不使用 zustand 的
persist middleware（写盘逻辑不合身，见 §6.2 file adapter）。

```ts
function createThreadStore(deps: ThreadDeps): ThreadStore

interface ThreadStore {
  getState(): ThreadState                      // 快照（不可变；zustand vanilla）
  subscribe(fn: () => void): () => void
  spawnFromPreset(presetId: string): Promise<void>
  activate(target: ActiveTarget): void         // 内部 = deps.navigate（§3.5）
  close(id: string): void
  rename(id: string, title: string): void      // 写 customTitle → 冻结
  cycle(dir: 1 | -1): void                     // Ctrl-Tab 混排循环
  onSessionEvent(e: SessionEvent): void        // 装配层专用：native → store
}
```

### 3.3 内部规则表（全部在 store 一处，locality 的兑现）

| 事件/方法 | 规则 |
|---|---|
| `spawnFromPreset` | 查 preset → `spawnSession({cwd, program, args, env, initCommand, scrollbackLines})` → push thread → `lastUsedPreset = presetId` → `activate` |
| `activate(thread)` | `deps.navigate` 路由跳转（表面整块替换）；清该 thread `hasBell`（契约 §7：聚焦即清） |
| `activate(settings)` / `null` | `deps.navigate(...)` 表面切换，threads 不动（后台 PTY 照跑、BEL 照落红点） |
| `onSessionEvent(title)` | `customTitle` 存在则忽略（冻结）；否则写 `oscTitle` |
| `onSessionEvent(bell)` | 该 thread 非 active 时 `hasBell = true` + `deps.notify(t)` |
| `onSessionEvent(exit)` | `status='exited'` + exitCode；若 `deps.closeOnExit()` → 同 `close` |
| `close` | terminal → `destroySession` + 移除行；当前路由指向它 → 先 `deps.navigate(null)` 再移除；chat/acp → 仅移除（Phase 2/3 补归档） |
| `rename` | 空串忽略；写 `customTitle` |
| `cycle` | threads 数组环形移动 → `activate`（路由跳转覆盖 settings 表面，契约 §4 生命周期） |

不变量：
1. 路由为 `/thread/$id` ⇒ 对应 id 必在 threads（close 前先导航离开）
2. `customTitle != null` ⇒ oscTitle 永不覆盖
3. exited 会话仍在池中（除非 closeOnExit / 手动 close）——重激活显示残留

### 3.4 测试面（bun test，零 GPU 零 PTY）

fake deps 注入即可覆盖全部规则（`navigate` 用真 router 实例，memory history）：spawn 序列（lastUsedPreset 更新）· bell→红点→activate 清除 · 冻结 · exit 灰行 vs closeOnExit 移除 · cycle 环形 · close 先导航离开再移除 · displayTitle 四级兜底。

### 3.5 路由：TanStack Router（memory 模式）—— 导航唯一事实源

`agent-plane-layout.md` §8 的 `activate()` 语义由路由承载；Pane 表面 = 路由树的直接映射：

```
/                       → EmptyPresets
/thread/$id             → 查 ThreadStore 得 kind → Chat | Acp | Terminal surface
/settings?section=$s    → SettingsView（section 为类型化 search param，分区深链免费获得）
```

```ts
// app/src/router.ts —— 只描述 URL 形状，不 import 业务模块
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, threadRoute, settingsRoute]),
  history: createMemoryHistory({ initialEntries: ['/'] }),
})
export function useActiveTarget(): ActiveTarget   // useRouterState → ActiveTarget 派生
```

规则：

- **ThreadState 不含 active**（§3.1）——导航状态只活在 router 一处，消费方拿派生视图
- ThreadStore 的 `activate / cycle` 内部调注入的 `deps.navigate`；装配层把它接成
  `router.navigate({ to, params, search })` 的薄包装
- 不用 `<Link>`（GPUIX 无 DOM `<a>`）——一律按钮 `onClick → navigate`
- **R-V1（Phase 1 第一验证项）**：`RouterProvider`（依赖 React context）在 GPUIX
  reconciler 下是否正常工作；保底方案：绕开 React 绑定，`router.subscribe` +
  `useStore` / `useSyncExternalStore` 手动桥——`ActiveTarget` / `navigate` 接口与路由树定义不变

---

## 4. surfaces/ —— Pane 表面与注册表

```ts
// surfaces/registry.ts
// T2.5 契约扩展：SurfaceProps 增 settings（SettingsStore 订阅面——terminal
// 外观真值 + 后续 chat/acp 需要读设置）
type SurfaceProps = { thread: Thread; store: ThreadStore; settings: SettingsStore }
type Surface = ComponentType<SurfaceProps>
const SURFACES: Record<Thread['kind'], Surface> = {
  terminal: TerminalSurface,
  chat: ChatSurface,          // Phase 2 前为占位（居中 "chat — Phase 2"）
  acp: AcpSurface,            // Phase 3 前同上
}
export const getSurface = (kind) => SURFACES[kind]
```

```tsx
// plane/Pane.tsx —— 全项目唯一的表面调度
function Pane({ store, settingsStore }) {
  const active = useActiveTarget()                 // §3.5：路由派生
  const thread = useThreadStore(s =>              // zustand selector：只订一行
    active?.type === 'thread' ? s.threads.find(t => t.id === active.id) : undefined)
  if (active?.type === 'settings') return <SettingsView store={settingsStore} />
  if (!thread) return <EmptyPresets onPick={store.spawnFromPreset} />
  const S = getSurface(thread.kind)
  return <S thread={thread} store={store} settings={settingsStore} />
}
```

「整块替换」= 条件渲染（旧 surface 卸载、新 surface 挂载，无 display:none）。retain 由两层保证：thread 记录在 ThreadStore、会话在 TerminalPool。

### TerminalSurface（唯一 `<terminal>` 绑定点）

```tsx
function TerminalSurface({ thread, settings }: SurfaceProps) {
  const term = useSettings(settings).terminal
  return (
    <terminal
      sessionId={thread.sessionId}
      fontFamily={term.fontFamily}
      fontSize={term.fontSize}
      cursorBlink={term.cursorBlink}
      palette={term.palette}
      focused
      onFocus={() => /* store 侧清 bell（activate 已清，此为补充） */}
    />
  )
}
```

外层 div：padding 0、无 overflow 包裹、背景不设色（terminal 自己的 palette）。焦点、选区、滚轮全归 TerminalView。T2.5 起四项外观真值随设置实时调和（setCustomProp 幂等，不重建会话）；scrollbackLines 属 spawn 参数（nativeDeps 兑底，不在此处）。

### 全局键位层（T2.6 提取：src/keybindings.ts）

```ts
// createGlobalKeydown(opts)：main.tsx 与 e2e 挂点共用的依赖注入形态
// （布线差异注入，nativeDeps 同款纪律）。分层：
// - 修饰键组合：Ctrl-Tab/Shift-Tab → cycle；Ctrl-, → toggle 设置；其余透传
// - 设置面生命周期键（无修饰键，仅 inSettings() 时吃）：Esc（消费标记双跳
//   时序，见 keybindings.ts 注释）/ `/`（inputFocus 守卫 + renderer.
//   focusElement(searchInputId)）
// 关闭设置 = activate(lastNonSettings())（router 桥订阅回调维护）
```

### SettingsView（settings-ui.md §12 的对齐）

结构照契约：`SettingsNav`（7 分区 + 搜索）+ `SettingsContent`。分区组件消费 `SETTING_DEFS`（见 §6）渲染 `SettingRow`；Presets 已实装（T3.1，PresetsSection 列表 CRUD）；ACP 分区手写列表 CRUD 待 Phase 3+。当前分区 = `/settings` 的类型化 search param `section`（分区深链免费；Esc / Ctrl-, 退出即返回）。生命周期（Ctrl-, / Esc / 切 thread 关闭）由路由与 `cycle` 天然实现，SettingsView 自身只管表单。

---

## 5. plane/ —— 组件树与状态流

```
App（useSyncExternalStore(threadStore) + useSettings()）
└── AgentPlane                        // flex：sidebar 248px + pane 剩余
    ├── Sidebar
    │   ├── SidebarHeader             // "AGENT" + Ctrl-Tab hint
    │   ├── ThreadList
    │   │   └── ThreadRow × N         // 图标(SVG) · displayTitle 单行 ellipsis+tooltip
    │   │                             //   红点 / exited 标签 · hover/focus 关闭钮
    │   │                             //   双击标题 → 行内 rename
    │   ├── NewThreadButton           // [+ target ▾] anchored 菜单（settings.presets.items；target = plusDefault ?? lastUsedPreset ?? 首项，T3.1）
    │   └── SidebarFooter             // 齿轮 → activate({type:'settings'})
    └── Pane（§4）
```

状态流约定：
- **zustand selector 按粒度订阅**：ThreadRow 订阅 `s.threads` 中自己的行（引用不变 → 不重渲染）；导航用 `useActiveTarget()`（§3.5）；两个 store 的写入只经 store 方法
- ThreadRow 的局部态：hover、rename 编辑框——useState，不上 store
- 图标/颜色 tokens 全部从 agent-plane-layout.md §3 引（CSS 变量或 TS 常量，Phase 1 定）

**全局键位层（src/keybindings.ts，T2.6 从 main.tsx 提取；main/e2e 同一 createGlobalKeydown）**：`Ctrl-Tab` / `Ctrl-Shift-Tab` → `cycle`；`Ctrl-,` → 设置路由开/关（toggle）。修饰键组合外只吃设置面生命周期键（Esc/`/`，仅 inSettings() 时；terminal 表面时透传给 PTY——硬约束 2）。焦点模型已验（T1.6）：TerminalView 聚焦时窗口级 keyDown 仍到达，无需降级。

---

## 6. settings/ —— SettingsStore

### 6.1 schema.ts —— 设置项唯一清单

```ts
// settings-ui.md §6 全表 + §9 键位表的代码形态。
// 纪律：新增设置先改这里（= 先上契约表），再出现于 UI。
// 底座：zod——类型从 schema 推导（z.infer，一套维护），字段级 .catch(default)
// 让坏值/越界自动回默认，z.looseObject 保留未知 key（往返保真）。
const SettingsSchema = z.looseObject({
  presets: z.object({
    plusDefault: z.string().nullable().catch(null),
    items: z.array(TerminalPresetSchema).catch(BUILTIN_PRESETS),
  }),
  terminal: z.object({
    fontFamily: z.string().catch("JetBrains Mono"),
    fontSize: z.number().int().min(10).max(22).catch(13),
    // …照 §6 分表逐字段
  }),
  // …notifications / appearance / acpAgents / advanced
})
export type Settings = z.infer<typeof SettingsSchema>   // TS 类型由此推导
// 读盘：const parsed = SettingsSchema.parse(rawJson)    // 坏 JSON/坏值 → 字段级回默认，UI 不炸

export type SettingControl =
  | { type:'toggle' }
  | { type:'select'; options: {value:string; label:string}[] }
  | { type:'number'; min:number; max:number; step?:number }
  | { type:'range';  min:number; max:number; step?:number }
  | { type:'text'; mono?:boolean }
  | { type:'textarea'; rows?:number }

export type SettingDef = {
  path: string                      // 'terminal.fontSize'
  section: 'presets'|'notifications'|'terminal'|'appearance'|'keybindings'|'acp'|'advanced'
  label: string
  description?: string
  control: SettingControl
  phase?: 2 | 3                     // → disabled + Phase 徽章（settings-ui.md §5.3）
}

export const SETTING_DEFS: SettingDef[] = [ /* §6 分表的每行一个 def */ ]
export const SECTIONS = [ {id:'presets', label:'Presets'}, /* 7 分区 */ ]
```

消费方：分区导航（groupBy section）、搜索过滤（label/description/path 命中 + 高亮 + 计数）、SettingRow 声明式渲染。Presets / ACP Agents 分区为结构性数据（列表 CRUD），不走 SETTING_DEFS，直接吃 `get().presets` / `get().acpAgents`。

### 6.2 store.ts / file.ts

```ts
// file.ts —— seam（两个 adapter：真盘 / 内存 fake）
type FileAdapter = { read(): Promise<string|null>; write(s:string): Promise<void> }
export const fsAdapter = (p: string): FileAdapter        // ~/.j-agent/settings.json；
                                                        //  write = tmp + rename 原子写（防写一半损坏）
export const memoryAdapter = (): FileAdapter             // 测试

// store.ts —— zustand/vanilla + immer + zod（同 §3.2 纪律），接口不变
function createSettingsStore(file: FileAdapter): SettingsStore
interface SettingsStore {
  get(): Settings                       // SettingsSchema.parse(read) 后的快照（字段级容错）
  patch(path: Path, value: unknown): void  // 内存即时 + 异步写盘
  reset(path: Path): void               // = patch(path, DEFAULTS 值)
  isModified(path: Path): boolean       // !dequal(get(cur), get(DEFAULTS)) → 蓝点
  subscribe(fn): () => void
  writeError(): { path: string; message: string } | null  // 行内红条；下次成功清除
  init(): Promise<void>                 // 装配期读盘 + 首帧 set
  // ── 预设 CRUD（settings-ui.md §7 规则单点，T3.1；同一写链/回滚面）──
  addPreset(input: PresetInput): string       // builtin:false + 唯一 id（custom-*），返回 id
  updatePreset(id, patch: PresetPatch): void  // id/builtin 不可改（类型面）；空字段归一 undefined；args 空串行过滤
  deletePreset(id: string): void             // 仅自定义；plusDefault 指向它 → 回退 null（lastUsedPreset 是运行时态，消费侧兑底）
  duplicatePreset(id: string): string        // 副本 builtin:false + label 副本后缀 + id -copy 后缀，返回新 id
  resetPreset(id: string): void              // 仅内置，回 BUILTIN 出厂值
}
```

写失败时序：patch → 内存更新 + notify → 写盘 reject → **回滚内存 + 置 writeError + notify**（settings-ui.md §5.3「回滚显示值」）。

运行时态（lastUsedPreset / hasBell；激活表面由路由承载）物理上不出现在 settings/ 任何文件——由目录结构保证「机器记忆不进 JSON」。

### 6.3 测试面

内存 adapter：patch/isModified/reset · 坏 JSON / 越界值字段级回默认（zod catch）· 未知 key 往返保真 · 写失败回滚 + writeError · 合并写 · SETTING_DEFS 的 path 全部真实存在于 Settings（schema 一致性测试）。预设 CRUD（T3.1）：add 唯一 id+builtin:false · update 空字段归一+args 空行过滤 · delete plusDefault 回退 · duplicate 副本语义 · reset 出厂值 · CRUD 写失败同一回滚面。

---

## 7. ui/ —— 原子清单

| 原子 | 用途 | 备注 |
|---|---|---|
| `Icon` | SVG 图标（chat 圆环点 / terminal 竖条 / acp 折线 / 齿轮 / 关闭 ×） | 内联 SVG，禁 emoji |
| `Tooltip` | 长标题、aria 补充 | anchored overlay |
| `SettingRow` | label + description + 控件 + 蓝点 + reset | settings-ui.md §5.1 布局 |
| `Toggle` / `Select` / `NumberInput` / `RangeInput` / `TextInput` / `Textarea` | §6 控件映射 | toggle 用真 checkbox；range 用 input[type=range] |
| `Badge` / `PhaseBadge` | 内置/自定义、Phase 2/3 | |
| `IconButton` | icon-only 按钮 | 强制 aria-label |

全部原生可聚焦 + `:focus-visible` 环（契约 §10/§11）。

---

## 8. Rust crates —— 模块职责

### 8.1 crates/jagent-terminal（无 napi 依赖，可独立 cargo test）

| 文件 | module | 接口（对 crate 外） | 实现要点 |
|---|---|---|---|
| `pool.rs` | TerminalPool | `create/destroy/get`（gpui Global 承载，R5）+ `set_session_event_fn` | 会话表 `HashMap<u64, Entity<TerminalModel>>`；事件转发走独立 `static OnceLock<SessionEventFn>`（model 消费 task 直调）；sessionId 分配；create 内键入 initCommand（D5） |
| `model.rs` | TerminalModel | gpui `Event::{Title,Bell,Exit,Wakeup}` + `write_to_pty` / `resize` / `set_style` | Zed `Terminal` 同构：alacritty `Term`（FairMutex）+ `SessionListener` channel + 事件消费 task（4ms 批处理，首事件立即+Wakeup 单独+上限 100）；Exit/ChildExit 去重；外观设置存 model |
| `pty.rs` | PTY 装配 | `open_pty` / `SpawnOptions` / `PtySender` | Zed `TerminalBuilder` 模式：`tty::new(options)` + `EventLoop::new(term, listener, pty).spawn()`；PtySender = Notifier 包装（write/resize/shutdown 走 Msg 通道）；alacritty_terminal 0.26（crates.io） |
| `view.rs` + `view/` | 绘制 | `TerminalView::new(Entity<TerminalModel>)` | **已 vendoring（R6）**：view/render/input/colors/box_drawing 四文件来自 gpui-terminal（MIT/Apache 双证随拷）；view 重写为绑 model（订阅 Wakeup 重绘、resize 在 paint 检测、输入走 model）；fork API 适配仅两处（ShapedLine::paint 补参、focus 三参） |
| `element.rs` | TerminalElement | `TerminalFactory`（注册用，占位） | §2.4：props 5+1、事件 focus/blur、destroy 不动会话；Phase 1 在 native 里接 GPUIX CustomElement |

### 8.2 packages/native（napi 壳）

三个文件各司其职（2026-09-04 审查后定型）：

- `lib.rs` —— 纯协议镜像（SpawnOptionsJs / SessionEvent）+ 四个 napi 命令
  （`install_terminal_element` / `create_terminal_session` / `destroy_terminal_session` /
  `on_session_event`）。**修改它的理由只允许是 seam 协议变化**。
- `host.rs` —— host 分发 module：`run_host<T>(f) → Result<T>` 一个 interface，
  两个 adapter（线程化通道 `run_on_gpuix` / 测试 `run_on_test_app`）；两条通道签名
  被 gpuix 锁在 serde_json::Value，typed↔JSON 装箱只发生在这里一处。
- `element.rs` —— GPUIX `CustomElement` 实现（`<terminal>` 元素，§2.4；曾同时在
  crates/jagent-terminal 留有占位 TerminalFactory，2026-09-04 审查后删除——元素实现的
  唯一住所就是这里）。

### 8.3 examples/window.rs（Phase 0，已完成）

纯 gpui 窗口（不经 GPUIX/React）：`gpui_platform::application()` + pool create + `TerminalView` 渲染 model，默认 shell（Windows = PowerShell）。**已验证**：ConPTY ✓ · BEL → `[session] BELL` ✓ · OSC 0/2 title ✓ · exit 单次 Exit 事件 ✓（真彩色/应用光标随窗口人工验收）。完整结论与踩坑记录见 TODOLIST.md Phase 0 结论区（fork 同号不同 API、跨 workspace 继承需 exclude、vendoring 四文件清单）。

---

## 9. 测试面总表

| 模块 | 测试面 | 工具 |
|---|---|---|
| threads/store | 接口 + fake deps（navigate 用真 router 实例） | bun test（§3.4 用例集） |
| router | 路由树 → ActiveTarget 派生、close 先导航离开、settings 分区深链 | bun test（memory history） |
| threads/terminal | displayTitle 纯函数 | bun test |
| settings/store | 接口 + memoryAdapter | bun test（§6.3 用例集） |
| settings/schema | SETTING_DEFS ↔ Settings 一致性 | bun test |
| surfaces/registry + Pane | kind → surface 映射、整块替换 | TestGpuixRenderer 截图（GPUIX img.test.tsx 模式） |
| element/pool/model | 真 PTY e2e：echo '\a' → bell；printf '\e]2;x\007' → title | e2e/（TestGpuixRenderer + bun test） |
| pty.rs / view.rs | cargo test（crate 内单测）+ window.rs 人工验收 | cargo |

---

## 10. Phase 落地映射

| Phase | 新增 | 交付锚点 |
|---|---|---|
| 0 | crates/jagent-terminal（model/pty/view 骨架）+ examples/window.rs | 调研 §5 Phase 0 清单；**结论回写 view.rs 策略与本文 §8.1** |
| 1 | workspace 根 + packages/native + app 骨架（router / plane / registry / TerminalSurface / ThreadStore 最小集：spawn/activate/close） | 布局契约 §12：单 pane、无 chrome、两个 PTY sidebar 切换、焦点模型结论；**R-V1：RouterProvider@GPUIX（§3.5 保底手动桥）** |
| 2 | ThreadStore 全规则（bell/冻结/exit/cycle）+ settings-core/controls/term-notify + SettingsView | 设置契约 §15 第 1–5、9–11 条；**桌面通知实现定型（node-notifier vs Rust win32 toast，见 §3.2 deps.notify）** |
| 3 | settings-presets + chat 实装 | 设置契约 §15 第 7–8 条；fusion §5 Phase 3 |
| 3+ | settings-acp-advanced + ACP + 键位编辑解锁 | 设置契约 §15 第 6 条；fusion §5 Phase 3+ |

横切：§15 第 12 条（无障碍）随各切片验收。依赖关系允许的并行：Phase 0（Rust 窗口）与 ThreadStore/SettingsStore 的 bun test（纯 TS）零耦合并行——seam 分工的直接红利。

---

## 11. 本轮设计决策清单

| # | 决策 | 依据 |
|---|---|---|
| D1 | 双 workspace，crate/包上限 2+2 | muxel/Paneflow 先例 + 防过度拆分 |
| D2 | TerminalPool 全局持会话，`<terminal>` 仅绑定视图 | GPUIX destroy 生命周期 vs retain 拍板（§2） |
| D3 | 会话事件走全局通道，元素只留 focus/blur | 后台 BEL 送达（§2.1） |
| D4 | spawn 参数走 napi 命令，外观走元素 props | 即时生效 vs 会话属性分离（§2.3） |
| D5 | initCommand 在 Rust create 内键入（`\x0d` 回车） | Zed activation_script 先例 |
| D6 | status 简化 running\|exited + hasBell | 单一事实源；展示语义不变（R3） |
| D7 | SETTING_DEFS 声明式清单驱动分区/搜索/行渲染 | 「先上表再进 UI」纪律代码化（§6.1）；**已拍板** |
| D8 | 全局键位层只处理修饰键组合，其余透传 | 硬约束 2；Phase 1 验证焦点模型（§5） |
| D9 | store 依赖注入（spawn/destroy/navigate/notify/closeOnExit） | interface 即测试面（§3.2） |
| D10 | **zustand/vanilla 为两 store 实现底座**；组件 selector 按粒度订阅 | 消样板 + 行级渲染粒度；接口/注入纪律不变（2026-09-02 拍板） |
| D11 | **TanStack Router（memory 模式）承载 Pane 表面路由**；`active` 从 ThreadState 移除、改为路由派生 | 用户拍板（2026-09-02）；R-V1 保底路径见 §3.5 |
| D12 | **zod 为 settings schema**：z.infer 类型推导 + 字段级 .catch 回默认 + loose 未知 key 保真；TanStack Router search param 校验复用 | 用户拍板（2026-09-02）；坏 JSON 防线（S3 外部事实源） |
| D13 | **immer 为两 store 不可变更新**；dequal 为深比较 | zustand 官方 pattern；用户拍板（2026-09-02） |

依赖白名单（packages/app）：`@gpuix/react` · `@jagent/native` · `zustand` · `@tanstack/react-router` · `zod` · `immer` · `dequal`——新增依赖须先进本表。

已评估不引入：react-hook-form / conform（submit 模式，不合即时生效）· fuse.js（设置搜索是子串匹配）· lodash（get/set 手写类型安全版）· uuid（crypto.randomUUID 内置）· zustand persist（写盘逻辑不合身）· node-notifier（Phase 2 与 Rust toast 二选一再定）。

下一步：搭骨架（§10 Phase 0）。文档交叉审读已完成（TerminalPreset / 验收锚点 / POOL Mutex / bun test 统一等已回写）。
