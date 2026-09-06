# j-agent Git 树（commit graph）设计

状态：**G1–G3 已落地**（2026-09-10；集成位置=workspace 内 tab、一期=只读 graph，经用户确认。实装：`packages/app/src/git/*` + `plane/WorkspacePage.tsx` + keybindings git 层；测试 app 全量 240 绿。G4 另立设计）  
依据：Zed `crates/git` + `crates/project/git_store.rs` + `crates/git_ui/git_graph.rs`（pin 8b94def 源码调研）· architecture.md §0/§1.2 分层纪律  
参考：Zed git graph 的 lane 算法与数据协议（本设计的主要移植来源）

---

## 0. 结论先行：Zed 的 git 怎么"拿"

Zed git 共三层 ~6.5 万行 Rust：`git`（CLI 数据层 ~10k）、`project/git_store`（协调层 12k）、`git_ui`（视图层 42k）。

| Zed 资产 | 拿法 |
|---|---|
| `git log` 流式数据协议（`--format=%H%x00%P%x00%D`、chunk 追加） | **照抄**。运行时是 Bun，TS 层 `Bun.spawn` 直调 git CLI，**不经过 native seam**（Zed 自己也是 spawn CLI 而非 libgit2 做数据查询；git CLI 子进程不是语言 seam） |
| lane 分配算法（`GraphData::add_commits`，核心 ~150 行纯逻辑） | **逐行移植 TS**（`git/graph.ts`）。无任何 Zed 依赖，状态机语义保持同构 |
| 光学参数（lane 宽、圆点半径、曲线段模型） | 移植并微调 |
| 视图层（gpui-Rust uniform_list + 自定义 Element paint） | **不拿**，用 React-gpuix 重写：`<virtual-list>` + `<svg source>` |
| `git_panel.rs`（status/stage/commit 面板 13.6k 行） | 一期不做，G4 再设计 |
| jagent 已有白捡件 | `<diff>`（unified diff 渲染）、`<code>`（语法高亮）、`<anchored>`（菜单）、`<virtual-list>`（虚拟滚动） |

**明确不做的**：不 vendor Zed crates、不加 Rust 侧 git 依赖（native Cargo.toml 不动）、不做远程仓库/协作语义（GitStore 的 collab 半边全部不要）。

---

## 1. 模块划分与依赖方向

```
packages/app/src/git/                 ← 新 feature 目录（按 feature 组织，architecture §0）
  cli.ts        git CLI 子进程封装（Bun.spawn、流式行解析、取消）
  graph.ts      lane 分配状态机（Zed GraphData 的 TS 同构移植，纯逻辑）
  store.ts      GitGraphStore：repo 检测、log 流生命周期、行快照、选中态
  format.ts     ref 名解析（%D → HEAD/branch/remote/tag 装饰）、相对时间
  components/
    GitGraphView.tsx   视图骨架（工具条 + virtual-list）
    GraphRow.tsx       单行：graph cell + ref badges + message + author + 时间
    graphSvg.ts        行内 lane 线段 → 按颜色分组的 <svg source> 生成
```

依赖方向（沿用 architecture §1.2 纪律）：

```
plane/Pane → git/components → git/store → git/{cli,graph,format}
                              git/store → threads/store（只读 workspace 目录）
git/* 不被 ui/ 依赖；git/components 消费 ui/tokens、ui/Badge
```

`git/cli.ts` 是唯一的进程边界；`git/graph.ts` 零 IO（可独立单测）；`git/store.ts` 不 import 任何 surface。

---

## 2. 数据层契约

### 2.1 cli.ts —— git CLI 封装

```ts
/** 一期 log 格式：Zed 三字段 + 一期直接带的展示字段（见 §6 优化记录） */
const LOG_FORMAT = '--format=%H%x00%P%x00%D%x00%h%x00%an%x00%at%x00%s'

export interface GraphCommit {
  sha: string            // %H 全 sha（oid 键）
  parents: string[]      // %P 按空白切
  refNames: string[]     // %D 逗号+空格切；detached HEAD / 普通提交为 []
  shortSha: string       // %h
  authorName: string     // %an
  timestamp: number      // %at 秒
  subject: string        // %s
}

/** 流式读取 git log，按行回调；返回取消句柄。行缓冲在内部（\n 分行、\x00 分字段）。 */
export function spawnGitLog(
  cwd: string,
  onChunk: (commits: GraphCommit[]) => void,
): { cancel(): void; done: Promise<{ ok: boolean; error?: string }> }

/** repo root 检测：git rev-parse --show-toplevel；非 repo → null */
export async function findRepoRoot(cwd: string): Promise<string | null>

/** 单提交 patch（选中看 diff 用）：git show --format= --patch <sha> */
export async function showPatch(cwd: string, sha: string): Promise<string>
```

实现要点：

- `Bun.spawn(['git', 'log', LOG_FORMAT, '--date-order', ...], { cwd, stdout: 'pipe', stderr: 'pipe' })`；`--date-order`（Zed LogOrder 默认）。
- stdout 用 `ReadableStream` + `TextDecoder({ stream: true })` 手写行缓冲：**禁止** `await new Response(...).text()` 全量拼接（10 万行级 repo 会先卡后爆内存）。
- **chunk 大小 512 行**（Zed GRAPH_CHUNK_SIZE 同量级意图：首屏快、避免 setState 风暴）。
- 行格式注意：`%D` 为空时产生连续两个 `\x00`；subject 可含逗号但不含 `\x00`/`\n`；坏行（字段数 < 7）丢弃不炸。
- `git` 不在 PATH / 非 repo / 退出码非 0：`done` resolve `{ ok: false, error }`，视图显示空态或错误条，不 throw 到 UI。
- 取消：cancel() kill 子进程并丢弃未 flush 行缓冲。视图卸载/切 workspace 时必调（PTY 会话不因切 tab 死，但 log 流应该死——见 §5.3 生命周期）。

### 2.2 graph.ts —— lane 状态机（Zed 同构移植）

Zed 的图数据完全在 UI 层增量计算，数据层只给 sha/parents/refs。移植其 `GraphData`：

```ts
export interface GraphRow {
  commit: GraphCommit
  lane: number        // 本提交所在 lane（行号即数组下标）
  colorIdx: number    // lane 颜色（色板取模）
}

export interface CommitLineSegment =
  | { kind: 'straight'; toRow: number }                          // 垂直线画到 toRow
  | { kind: 'curve'; toColumn: number; onRow: number; merge: boolean } // 贝塞尔在 onRow 行发生

export interface CommitLine {
  childColumn: number          // 线起点 lane
  rowSpan: [number, number]    // 覆盖的行区间（含）
  colorIdx: number
  segments: CommitLineSegment[]
}

export class GitGraphData {
  addCommits(chunk: GraphCommit[]): void    // 增量追加（流式多次调用）
  readonly rows: readonly GraphRow[]
  readonly lines: readonly CommitLine[]
  readonly maxLanes: number                 // graph 列宽 = LANE_WIDTH * max(6, maxLanes)
  clear(): void
}
```

算法（与 Zed `add_commits` 逐句对应）：

```
addCommits(chunk):
  for commit of chunk:
    row = rows.length
    lane = min(parentToLanes.get(commit.sha)) ?? firstEmptyLaneIdx()
    color = laneColor(lane)                     // laneColors 缓存 + nextColor 轮转取模

    // ① 收尾：所有等着本 sha 的活跃 lane 生成 CommitLine（含 merge 曲线重叠修正）
    for l of parentToLanes.remove(commit.sha) ?? []:
      生成 laneStates[l] → CommitLine(childColumn: l, …, colorIdx)
      若首段是 curve(merge) 且曲线行与 commit 行之间在本 lane 上有别的提交 → toColumn 修正为 l（Zed would_overlap 逻辑）
      laneStates[l] = Empty（l ≠ lane 时；l == lane 由下面 ② 重占）

    // ② 开支：parent0 继承本 lane（直线段）；parent1.. 各开新 lane（merge 曲线段）
    laneStates[lane] = Active{ parent: p0, segments: [straight(toRow: ∞)] }
    parentToLanes[p0].push(lane)
    for p of commit.parents.slice(1):
      nl = firstEmptyLaneIdx()
      laneStates[nl] = Active{ parent: p, segments: [curve(toColumn: ∞, onRow: ∞, merge)] }
      parentToLanes[p].push(nl)

    maxLanes = max(maxLanes, laneStates.length)
    rows.push({ commit, lane, colorIdx: color })
```

不变量（也是单测断言面）：`firstEmptyLaneIdx` 复用空 lane → lane 数只在并发分支时增长，merge 后收缩；`parentToLanes` 每个键的 lane 集合在对应 commit 到达时清空；`rowSpan` 闭合。

### 2.3 store.ts —— GitGraphStore

```ts
export interface GitGraphState {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'not-a-repo'
  rows: readonly GraphRow[]
  lines: readonly CommitLine[]
  maxLanes: number
  loadedCount: number          // 流式进度（顶栏显示 n commits）
  selectedSha: string | null
  error?: string
}

createGitGraphStore(): GitGraphStore   // 模式对齐 threads/store.ts：外部 store + useSyncExternalStore 选择器
```

- `mount(workspaceCwd)`：幂等启动（已在跑则复用）；`findRepoRoot` → `spawnGitLog` 流式喂 `GitGraphData.addCommits` → 每整 chunk 通知一次订阅者。
- `select(sha)` / `clearSelection()`：选中态（一期单选）。
- `refresh()`：cancel + clear + 重跑（手动 R 键/工具条按钮；**一期不做 fs watch**）。
- `unmount()`：cancel 流。切换 workspace 时由 Pane 调用。

---

## 3. 渲染契约（React-gpuix）

### 3.1 行结构（定高 26px）

```
┌──────────┬──────────┬─────────────────────────────┬─────────┬────────┐
│ graph cell│ ref badge │ subject（ellipsis）          │ author  │ 时间   │
│ 84–172px │ 内容宽    │ flexGrow + minWidth:0        │ 固定 120│ 60px  │
└──────────┴──────────┴─────────────────────────────┴─────────┴────────┘
  LANE_WIDTH=13, 默认 maxLanes=6 → 6*13+2*3=84px；maxLanes 增长列宽随之增长（Zed 同款，前几百行内即稳定）
```

- `<virtual-list estimatedItemHeight={26}>`，行根 div 定高 26、`flexDirection: 'row'`、`alignItems: 'center'`。
- 主题：行底 COLORS.pane，hover COLORS.surface，选中行 COLORS.surface + 左侧 2px accent 条（对齐 ThreadRow 选中语言）。
- 字体：subject/author 用 FONT.ui 13px；shortSha 用 FONT.mono 11px muted。

### 3.2 graph cell —— svg 按颜色分组

`<svg>` 是单色叶子（Icon.tsx 模式）：**每个 colorIdx 一个 svg**，绝对定位叠放在 graph cell 内（GPUI 树序绘制天然叠加；一行通常涉及 1–3 色）。

`graphSvg.ts` 生成规则（行内局部坐标，viewBox `0 0 W 26`，y=0 行顶、y=13 行中线、y=26 行底）：

```
laneX(l) = 3 + l*13 + 6.5                       // Zed lane_center_x 同构
commit 圆点:  <circle cx=laneX(lane) cy=13 r=3.5 fill=none stroke-width=1.5>
              描边色 = lane 色（svg 内 stroke="currentColor"，外层 style.color=色板[colorIdx]）
直线段（覆盖本行的 active line 中 childColumn=col 的段）:
              <path d="M laneX(col) 0 V 26" stroke-width=1.5>
merge 曲线（Curve 段，onRow=本行）:
              起点 laneX(from)，终点 laneX(toColumn)，三次贝塞尔：
              M x0 0  C x0 6.5, x1 6.5, x1 13   （Zed CurveKind::Merge 同型）
              checkout 曲线（merge=false）方向相反（M x0 13 C … x1 26 型）
```

- 直线段画整行高（0→26）：相邻行的同 lane 直线无缝拼接（Zed 同款策略）。
- `toRow` 已过的段不再画（行渲染前用 `getFirstVisibleSegmentIdx` 等价逻辑过滤——直接用 rowSpan + 段的 toRow/onRow 判断即可，不需要 Zed 的缓存版）。
- 色板（8 色轮转，One Dark 调和）：`#61afef #98c379 #c678dd #e5c07b #56b6c2 #e06c75 #d19a66 #56b6c2→#be5046`（放 tokens.ts `GRAPH_LANE_COLORS`）。

### 3.3 ref badges（format.ts 解析 `%D`）

`"HEAD -> main, origin/main, tag: v1.0"` →

| 装饰 | 样式（Badge 组件现成） |
|---|---|
| `HEAD -> <branch>` | accent 底（accentSoft）+ accent 字 |
| 其它本地 branch | textBright + border |
| `origin/*` 等远程 | muted 字无边框 |
| `tag: v*` | amber 字（COLORS cyan/amber 体系，用 `#e5c07b`） |

### 3.4 选中与 diff 查看

- 行点击 / Enter → `store.select(sha)`，Pane 右侧推入 360px 详情列（workspace tab 内布局：`row` 方向 graph 列 + 详情列）。
- 详情列：`showPatch(sha)` 结果喂 **自绘 DiffBody**（逐行 text 着色：文件头 muted、@@ accent、+ 绿 − 红、context 默认；nowrap + 外层横滚）。原因：gpuix `<diff>` 是 native custom element，TestRenderer 不绘制其内容（同 markdown 限制，2026-09-10 实测），且 `<virtual-list>`/`<diff scroll>` 这类列表元素**不吃 flexGrow/absolute 拉伸，只认显式 height**——git 图列表与 diff 体均用 `useWindowSize()` 减已知 chrome 计算高度（G4 真机验证 `<diff>` 后可评估换回）。
- Esc → clearSelection。

---

## 4. 集成契约（workspace 内 tab）

### 4.1 路由与状态

- 路由不变（不加新 route）：`workspace/:id` 一个 route 内切 tab。
- `threads/workspaces.ts` 的 Workspace 运行时态加 `paneTab?: 'home' | 'git'`（与 expanded/lastSession 同级，持久化 state.json；缺省 'home'）。
- ThreadStore 不动。GitGraphStore 是**独立 store**（挂载生命周期跟随 workspace tab，不进 ThreadStore——git 数据不是会话）。

### 4.2 Pane 渲染规则（workspace 分支）

```
workspace route 时：
  无线程 + tab='home'  → WorkspaceEmpty（现状）+ 工具条出现「Git 图」入口
  tab='git'            → GitGraphView（本设计）
  有线程时 workspace 起始页顶部渲染 tab 条：[各线程 tab…（点击 → thread route，现状行为）] [Git 图]
```

- tab 条高 30px、样式对齐 TitleBar 标签页（COLORS.titlebar 底 + 活跃 tab 下边线 accent）。
- workspace 无线程时 tab 条只有 [Git 图]（home 即 WorkspaceEmpty 本身）。

### 4.3 键位

| 键 | 行为 |
|---|---|
| `Ctrl+Shift+G` | 当前 workspace → 切到 Git 图 tab（全局层，keybindings.ts 挂载） |
| `↑/↓` | Git 图内移动选中行（virtual-list scrollTo 跟随） |
| `Enter` / 点击 | 选中并打开 diff 详情 |
| `Esc` | 关 diff 详情 → 清选中 |
| `R` | refresh（重跑 log 流） |

硬约束：git 视图聚焦时不注册任何无修饰键的全局处理（vim/终端按键语义优先的教训，main.tsx §3）。

### 4.4 生命周期

- 进入 git tab → `store.mount(workspace.cwd)`（幂等）；离开 tab **不 unmount**（切回免重拉，与终端会话保活的体验对齐）。
- 切换 workspace（路由离开 workspace/:id）→ `unmount()`。
- 应用退出：state.json 已有 workspace 态持久化，git store 不持久化（重进重拉，log 流秒级重建）。

---

## 5. 测试面（bun test，零 GPU 零 PTY）

| 模块 | 测试 |
|---|---|
| `graph.ts` | 纯逻辑单测（核心）：①线性历史 lane 恒 0；②fork（2 parent 各占 lane）+ merge（curve 段生成、lane 收缩复用）；③lane 复用：merge 后 firstEmptyLaneIdx 回收；④颜色轮转取模；⑤增量 addCommits 两次 = 一次（流式分块不变量）；⑥maxLanes 单调不减。fixture 手写 GraphCommit 数组（构造 dagger 形状：a←b←c、b←d、c,e→f 等） |
| `cli.ts` | 行解析单测：`\x00` 分字段、空 `%D` 连续分隔符、坏行丢弃、行缓冲跨 chunk 边界截断（模拟流式分片喂字节）。spawn 本体走集成冒烟（`git init` 临时 repo + 3 commit，可选 e2e） |
| `format.ts` | `%D` 字符串 → badge 数组全分支；相对时间边界 |
| `components` | TestRenderer 现有模式：行数渲染、选中行样式、tab 切换回调、空态（not-a-repo） |
| `graphSvg.ts` | path d 字符串快照（给定 lines+row 断言生成的 path 数与坐标） |

---

## 6. 分阶段

- **G1 数据层**：cli.ts + graph.ts + format.ts + 全部单测（纯逻辑，先立稳算法）。
- **G2 视图**：GitGraphView/GraphRow/graphSvg + workspace tab 集成 + 键盘导航 + diff 详情列。
- **G3 打磨**：流式进度、错误条、refresh、大 repo 性能验证（jagent 自仓 ~2k 提交 + zed 仓 ~40k 提交实测）。
- **G4（另立设计）**：status/stage/commit 面板（Zed git_panel 移植）、branch picker、lazy 详情流（graph 行与详情分离，Zed CommitDataReader 模式——一期把 %h/%an/%at/%s 直接带在 log 流里是简化，~150B/行，2 万提交 ~3MB 可接受；超过 5 万提交的 repo 再上懒加载）。

## 7. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | TS 层 Bun.spawn 调 git CLI，不加 Rust 依赖 | Zed 同款（CLI 而非 libgit2）；跨语言 seam 最小化；Windows/mac/linux git CLI 通吃 |
| D2 | lane 算法 TS 同构移植而非重新发明 | ~150 行纯逻辑，Zed 已被 40k+ 提交 repo 验证，曲线/lane 复用细节多，自造必踩坑 |
| D3 | 一期 log 全字段直带，不做懒详情流 | 代码量减半；内存代价在常规 repo 可忽略；优化路径已预留（G4） |
| D4 | svg 按颜色分组叠加而非每 lane 一个 | 行内 svg 数 = 涉及颜色数（1–3），markup 短，虚拟化后无性能问题 |
| D5 | git store 独立于 ThreadStore | git 数据非会话；生命周期不同（tab 级 vs 应用级） |
| D6 | 一期手动刷新，不做 fs watch | watcher 触发 rescan 是 Zed git_store 协调层的大头（12k 行的主要工作），一期不引入 |
