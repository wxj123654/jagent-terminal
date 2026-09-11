# j-agent 性能分析看板（perf-analysis）

> 目标：渲染/滚动卡顿类性能问题，按模块逐一列出怀疑项 → 验证 → 结论。
> 方法论：`D:/document/j-agent/.tmp/render-jank-report.html`（帧管线 / 症状三分 / 分侧归因 / Top10 根因指纹）。
> 状态图例：✅ 验证无碍（附证据）· ⚠️ 确认问题（附修法）· 👁 观察项（低危/边界）· 📋 待执行（附方案）
>
> 纪律：一次会话推进一两个任务块，做完勾选并在文末追加日志行。

## 模块地图

```
packages/app/src/
  threads/    数据层（store/chat/acp/events/workspaces/presets/nativeDeps）
  plane/      布局层（AgentPlane/Sidebar/WorkspaceList/ThreadRow/TitleBar/ToolMenu）
  surfaces/   视图层（ChatSurface/AcpSurface/TerminalSurface/ConversationView/Settings*）
  settings/   设置持久化（store/useSettings/file/schema）
  ui/         控件库（input/textarea/select/toggle/tooltip/tokens…）
packages/native/           napi 桥（host/element/notify/appearance/picker）——我们的代码
crates/jagent-terminal/      终端栈（model/pool/pty/view/view/render）——vendored 后由本仓维护，属我们代码
.refs/gpuix/               外部依赖（GPUIX）——不在分析/修改范围；仅作行为参考（改动需走 patches 体系，见 TODOLIST）
```

> 范围约定：只分析/修改本仓库代码。GPUIX 的行为（窗口化机制、style hash-cons 等）仅作为理解前提记录在结论证据里，不作为问题对象或修复目标。

---

## 1. threads/ 数据层

| # | 怀疑项 | 状态 | 结论与证据 |
|---|--------|------|-----------|
| 1.1 | 流式 chunk 事件风暴（每 chunk 落 store + 全量广播） | ✅ | `sendConversationMessage` 整条回复落列，无流式 UI；ACP chunk 在连接内 `textParts.push` O(1) 拼装（acp.ts TurnCollector），turn 结束才落 store |
| 1.2 | store 通知无 selector → 全组件重渲染 | ✅ | zustand vanilla + immer 结构共享；useThreadStore 的 selector 返回稳定引用（find 结果未变即同引用）→ useSyncExternalStore 跳过重渲染 |
| 1.3 | PTY 字节流跨 napi | ✅ | 架构硬约束落实：napi 事件仅 title/bell/exit（events.ts 三型窄化），渲染数据在 Rust 侧 |
| 1.4 | Title 事件批内不去重 | 👁 | model.rs `process_pty_event` 对批内每条 Title 都 forward_session_event（跨 napi）+ cx.emit；store 侧值相同时 immer 返回原引用不广播，但**值高频变化**（powerline/vim 进度条）时每 4ms 批可多条跨界。实际场景低频，暂不处理 |
| 1.5 | spawnSession 同步 napi 阻塞帧循环 | ✅ 已知项 | ConPTY 冷启动 ~1s，nativeDeps.ts 头注已文档化（用户显式操作，可接受） |
| 1.6 | workspaces 持久化写盘风暴 | ✅ | `persist()` 仅在实际变化后 fire（activate 的 touchedWorkspace 标记）；装配层写 state.json 低频 |

## 2. threads/acp.ts（JSON-RPC 子进程客户端）

| # | 怀疑项 | 状态 | 结论与证据 |
|---|--------|------|-----------|
| 2.1 | stdout 行解析 O(n²) 字符串拼接 | ✅ | outBuf 行级消费（indexOf + slice），缓冲通常单行长度，非累积型 |
| 2.2 | stderr 尾部追踪成本 | ✅ | `(buf + d).slice(-4000)` 环形截断，上限 4KB |
| 2.3 | 无流式 UI | 📋 功能项 | 非性能问题（turn 级返回是有意设计）；接 AcpSurface 权限面/流式时重审 |

## 3. surfaces/ConversationView.tsx（会话渲染面）

| # | 怀疑项 | 状态 | 结论与证据 |
|---|--------|------|-----------|
| 3.1 | 消息区无虚拟化 → 长会话全量渲染 | ⚠️ **P2b** | **我们的用法问题**：ConversationView 全量 `messages.map()` 挂 children → retained tree 全量注册（实测 2000 条 → 9012 元素，~4.5×n）、React 每键 diff O(n)。GPUIX 的 virtual-list 本身支持 JS 侧窗口化（itemCount/windowStart/visibleRange 事件），我们没用——修法全在本文件：传 `itemCount={messages.length}` + 只渲染 visibleRange 切片 + `windowStart` 随动（GPUIX 测试面有用例先例可参考） |
| 3.2 | **draft state 在组件顶层 → 打字每键重渲染整棵消息树** | ⚠️ **P2a 实测证实** | **bench 数据**（.tmp/perf-bench-typing.ts，TestGpuixRenderer 真实输入路径，20 键均值）：10 条=0.20ms/键 · 100 条=0.30 · 500 条=1.86 · 1000 条=1.00 · 2000 条=2.11——**随消息数线性增长（10.3x）**。**修法（本文件）**：composer 区域抽子组件持 draft state（打字只重渲染 composer）；配合 3.1 窗口化后 diff 面也降 O(可见) |
| 3.3 | markdown 每 chunk 重新 parse/排版 | ✅ | 无流式（见 1.1）；diffCustomProps 值比较（`oldValue !== value`）相同 source 不重发 |
| 3.4 | pendingReply thinking 占位成本 | ✅ | 单行 text，忽略级 |

## 4. plane/（布局层）

| # | 怀疑项 | 状态 | 结论与证据 |
|---|--------|------|-----------|
| 4.1 | Sidebar 订阅粒度过粗 | ✅ | 宽度走 useSettingsValue 单值订阅（注释明确：拖滑块只重渲染侧栏不碰会话树） |
| 4.2 | 搜索 query 每键重渲染 WorkspaceList 整树 | 👁 | query state 在 Sidebar 顶层，打字每键重跑 WorkspaceList——当前规模（线程+工作区几十行）无碍；线程数上数百后同 3.2 修法（搜索框下沉）。低优先 |
| 4.3 | ThreadRow 无 memo | 👁 | 与 3.2 同根因（store 任意变化 → 列表全行重 diff）；当前规模无碍，随 3.2 一并处理 |
| 4.4 | cycle/close 全量 threads.find O(n) | ✅ | n 为会话数（几十），低频操作 |

## 5. settings/（持久化）

| # | 怀疑项 | 状态 | 结论与证据 |
|---|--------|------|-----------|
| 5.1 | 拖滑块写盘风暴 | ✅ | gen 计数合并写（连续 patch 只落最后快照，旧写跳过） |
| 5.2 | TerminalSurface 全量 useSettings 订阅 | 👁 | 任意 settings patch（含拖侧栏宽度）重渲染 TerminalSurface；props 未变 → 无 commitUpdate 无 napi，纯 JS 重跑 ~0.05ms。忽略级（改 useSettingsValue 只订阅 terminal 切片可消，顺手时做） |

## 6. Rust 终端栈 crates/jagent-terminal（渲染热路径）

| # | 怀疑项 | 状态 | 结论与证据 |
|---|--------|------|-----------|
| 6.1 | 事件风暴（每 PTY 输出块一次 notify/重绘） | ✅ | Zed 4ms 批处理：首事件立即 + 4ms 窗口聚合（cap 100/批）；**Wakeup 批内去重**（每批最多 1 次 cx.emit）→ 渲染节流上限 250Hz，实际由 vsync 聚合 |
| 6.2 | 后台会话持续重绘 | ✅ | 视图卸载后 Wakeup 无订阅者（EventEmitter 无 listener = no-op）；exited 会话 channel 关闭 → 消费 task 退出 |
| 6.3 | **paint() 全量逐帧重绘、零缓存** | ⚠️ **P1** | render.rs paint：每帧对全部可见行 ① `grid[point].clone()` 每 cell 一次 clone + Vec 分配（200×60 = 12000/帧）② `layout_row` 实时重建 BatchedTextRun（**无行级 ShapedLine 缓存**——Zed 官方 terminal 有 line cache）③ box_drawing 双遍扫描 + 每行 HashSet 分配 ④ 每 cell 两次 palette.resolve（24000 次/帧）⑤ measure_cell 每 paint 一次 shape_line("M")（靠 gpui 字体缓存，shape 调用本身每帧）。持续输出时每 vsync 帧全量执行：80×24 估 1–3ms 可接受，**大窗口 + 高吞吐（cat 大文件/构建日志）逼近帧预算**。修法方向：行级缓存（HashMap<行指纹, ShapedLine>，Zed 模式）、cells 借用迭代避免 clone、box_drawing HashSet → u128 位图、resolve 结果按行内联缓存 |
| 6.4 | measure_cell 每帧 shape | 👁 | 随 6.3 一并处理（字体/字号未变时跳过，style 变化标志位） |
| 6.5 | resize 锁竞争 | ✅ | FairMutex 短临界区；render 回调内 3 次锁获取（resize 检查/cursor_bounds/paint）间隔短 |
| 6.6 | Title 批内不去重 | 👁 | 见 1.4（根源在此，修在 model.rs 批处理聚合处：批内 last-wins 合并） |
| 6.7 | scrollback 大内存 | ✅ | DEFAULT 10k 行 cap，MAX 100k（Zed 同款）；alacritty 环形 buffer |

## 7. napi 桥 packages/native/

| # | 怀疑项 | 状态 | 结论与证据 |
|---|--------|------|-----------|
| 7.1 | TerminalSurface 重渲染 → setCustomProp 风暴 | ✅ | 双保险 diff：element.rs apply_style 层（`*style != new` 跳过）+ model.rs set_style 层（PartialEq 幂等）；稳态帧零成本 |
| 7.2 | focused 每帧抢焦点 | ✅ | gpui focus() 已聚焦时 no-op；单元素挂载场景无争抢 |
| 7.3 | host.rs 调度开销 | ✅ | 非热路径（spawn/destroy/命令级跨界） |

## ~~8. GPUIX 底座~~（外部依赖，已移出分析范围）

> 2026-09-08 范围收缩：`.refs/gpuix` 不再作为分析/修改对象。此前记录的三项（commitUpdate 无条件重发 style、virtual-list 机制、style hash-cons）是外部行为事实，仅作理解前提——本仓代码的结论已在各自模块里引用，无需在此跟踪。

## 9. git/GitGraphView.tsx（git 图页）

> 2026-09-12 建项。用户观测：git graph 页 HUD draw ~10ms，terminal 仅 3–4ms。基准设施（确定性仓库 + 双 bench 脚本，保留可重跑）：
> ```
> bun scripts/bench/gen-bench-repo.ts --fresh      # 374 提交确定性仓库（feat/hotfix/tag 多 lane）
> cd packages/app && bun bench/git-graph.bench.tsx <repoDir>            # 真实 GitGraphView 滚动基准
> ABL=full|nosvg|notext|bare|sametext|half bun bench/git-graph-ablation.bench.tsx <repoDir>  # 行内窖变
> ```

| # | 怀疑项 | 状态 | 结论与证据 |
|---|--------|------|-----------|
| 9.1 | svg pieces 每帧重光栅化 | ✅ | sprite atlas 按 (内容hash,size) 跨帧缓存；nosvg 瓶颈不变（7.66 vs full 7.37ms） |
| 9.2 | text shaping 缓存 miss | ✅ | LineLayoutCache 命中良好：滚动期仅 4–10 miss/帧（新行进入），miss 成本 0.2–0.3ms；shape 总计仅 ~0.67ms/帧 |
| 9.3 | **text 元素每帧重测量（结构性成本）** | ⚠️ **实测主因** | 窖变：notext 7.37→2.58ms（text 占 ~65%）。.refs 临时插桩（已按补丁纪律恢复）：整帧 ~7ms 中 layout 段 5.1–6.7ms（75%），其中 text 测量闭包 1.0–3.3ms（**410–450 次/帧 ≈ 每 text 元素 ~2.9 次 taffy 探测**）+ taffy 树行 0.8–1.5ms（~800 节点）+ prepaint/hitbox 遍 1.4–3.4ms。根因：GPUIX 每帧重建元素树 → 元素级 TextLayout 缓存永不跨帧；ellipsis（truncate_width=Some）额外绕过帧内元素缓存；重测成本在闭包开销（runs 构建/truncate 决策/缓存查询）而非 shaping 本身（sametext 9.08ms 不降反升=内容无关） |
| 9.4 | 与 terminal 3–4ms 的差异来源 | ✅ | 结构性：terminal=单 custom element 自绘 200×60 网格（HUD term 读数即其自身 paint 成本），无元素树重建/taffy text 节点/测量闭包/hitbox；git graph=29 可见行 × ~27 元素 ≈ 800 元素全管线每帧重跑 |

### 9.x 优化方向（未实施，按预期收益排序）

1. ~~**P1 候选·行级 custom element**（terminal 同构）~~ **✅ 2026-09-11 已实施**：`<git-graph-row>`（packages/native/src/git_graph.rs）+ rowColumns.ts 规格 + GitGraphView 接入。每行 4 文本列 canvas 自绘（ShapedLine 直 paint，truncate_line 截断，元素实例级 shaped 缓存跨帧复用）；测试断言改走 getPaintedText。**实测：滚动 draw p90 7.0→3.9–4.2ms（terminal 水平），idle 3.8–3.9ms**。seam 补丁：gpuix 0002 增导出 log_painted_text（canvas 文本进 paint log，测试可见）。
2. **本地小改（已被 1 吸收）**：author+date 合并单 text、去 ellipsis——行文本全部走 custom element 后无 text 节点，不再需要。
3. **上游 GPUIX**（走 patches 体系）：元素级 TextLayout 跨帧复用（按 text+style hash 键控）/taffy 探测降频——收益面大但属外部依赖改动；当前行级元素方案已把 git graph 移出受害者名单，此项降级为「其他重文本页（如 settings 长列表）再看」。

---

## 问题汇总与优先级

| 优先级 | 问题 | 模块 | 触发场景 | 修法 | 状态 |
|--------|------|------|---------|------|------|
| **P1** | paint() 全量重绘零缓存 | 6.3 render.rs | 大窗口 + 高吞吐输出 | 行级 ShapedLine 缓存（Zed 模式）+ cells 借用迭代 + box_drawing 位图 | 📋 待基准测量后实施 |
| **P2a** | ConversationView draft 顶层 state | 3.2 | 长会话打字 | composer 抽子组件持 draft（bench 证实 2.1ms/键 @2000条） | 📋 待实施（小改） |
| **P2b** | 消息列表 JS/retained 层未窗口化 | 3.1 | 长会话内存 + diff/滚动 | itemCount/windowStart/visibleRange 模式（GPUIX 官方先例） | 📋 待实施（中改，与 P2a 同文件） |
| P3 | Title 批内不去重 | 6.6→1.4 | 高频改 title 的 TUI | model.rs 批内 last-wins 合并 | 📋 低频，择机 |
| P3 | Sidebar query / ThreadRow 无 memo | 4.2/4.3 | 线程数百+ | 搜索框下沉 + memo | 📋 低频，择机 |
| P4 | TerminalSurface 全量订阅 | 5.2 | 拖任意设置滑块 | useSettingsValue(terminal) | 📋 顺手 |
| **P5** | git graph 每帧全量重测 ~145 text 元素 | 9.3 | git 图页滚动/hover（~10ms/帧） | 行级 custom element（terminal 同构）或列合并小改 | 📋 已归因，待拍板 |
| 记录 | spawn 阻塞 ~1s | 1.5 | 新建终端 | 已文档化接受（nativeDeps 头注） | 无需行动 |

## 待执行（动态验证，静态结论 → 数据证实）

- [x] **P1 基础设施**：✅ 2026-09-08 性能 HUD 上线（设置 → 高级 → 性能指标 HUD）：标题栏右上角实时显示绘制帧率/单次 paint 均值与峰值/CPU/RSS（500ms 轮询；crates perf 原子打点 + napi takePaintPerf + ui/PerfHud）。P1 基准可直接用它目测；脚本化采样后续补充
- [x] **P1 基础设施 v2（整 app 测绘）**：✅ 2026-09-08 HUD 升级为双层数据面——整 app 帧面接 GPUIX 内建 profiler（gpuix-native 依赖 gpui 时已开 `profiler` feature，编译进 .node；`Window::draw` 全程被 WindowProfiler 计时，最近 1000 帧直方图）：`getDebugFrameOverlayStats` 差分 frames 得**整 app 重绘帧率**（build+layout+paint 全树），p90/max 得**整帧耗时**；终端 paint 打点降为子项 `term`（归因面）。同时新增 `advanced.frameOverlay`（GPUIX 屏幕帧覆盖层，full 模式整帧直方图可视化，与 HUD 同源）。零 Rust 改动、零 .refs 补丁。语义：draw p90/max 每采样窗读后即清（resetDebugFrameOverlayStats 清样本保 frames 计数）——读数为本窗（500ms）内新帧的 p90/max；不做的话低帧率下启动期大帧会冻结在滚动窗 max 里（实测 4fps 下 98ms 假峰长期不衰，用户报「一直不动」）
- [ ] **P1 基准**：大窗口（200×60）高吞吐（`cat` 大文件 / `yes`）下 paint 成本测量（HUD 目测 + PresentMon 或 Rust Instant 采样脚本化）。产出：每帧 ms 数 @窗口尺寸，验证是否逼近 16.7ms
- [x] **P2 基准**：✅ 2026-09-08 完成（.tmp/perf-bench-typing.ts，脚本保留可重跑；跑法：`cp .tmp/perf-bench-typing.ts e2e/__bench.ts && cd e2e && bun run __bench.ts`，跑完删）。结果：打字成本线性增长 0.20→2.11ms/键（10→2000 条）；意外发现 retained 全量注册（P2b）
- [ ] **P2a/P2b 实施**：ConversationView 重构（composer 下沉 + visibleRange 窗口化），bench 脚本复测对比
- [ ] 长会话内存曲线（scrollback cap 下的稳态验证）。

## 会话日志

- 2026-09-11 · **P1 实施**：`<git-graph-row>` 行级元素落地（git_graph.rs / rowColumns.ts / GitGraphView 接入 / gpuix 0002 增 log_painted_text seam）。实测滚动 p90 7.0→3.9–4.2ms。回归：git 72 + surfaces 31 全绿、scroll-chain 6 + terminal 17 e2e 全绿、tsc/clippy 零告警、export-patches --check 通过。**事故与修复**：bench 仓库生成脚本首版 cwd 处理 bug 把 39 个空提交写进主仓 HEAD（树与真 HEAD 零差异，reflog 恢复）；脚本已加双重护栏（GIT_DIR/GIT_WORK_TREE 清空 + init 前后 --show-toplevel 自检），--fresh 验证主仓 HEAD 纹丝不动。bench 截图人工核对未做（视觉 sidecar 400），用结构化像素采样替代：行带 text/muted 列稳定呈现。
- 2026-09-12 · git graph 10ms vs terminal 3–4ms 调研（模块 9 建项）：新建确定性仓库 gen（374 提交）+ 真实组件/窖变双 bench（保畵在 packages/app/bench/ 与 scripts/bench/，未提交待拍板）。真实组件滚动 draw p90 ~7ms/max 11.7ms（本仓 374 提交/3 lane）；窖变定位 text 占 65%（notext 2.58ms）、svg/缓存 miss 无辜。.refs 临时插桩（[DEBUG-jgg1/jgg2]，gpui window.rs 三段 + renderer.rs 树构建 + text.rs 测量闭包 + text_system shape/miss）出最终分解：build 0.65（树构建 0.07）/taffy 2–4（含测量闭包 1–3.3、410–450 次/帧 ≈ 2.9 次/text，shape 仅 0.67）/prepaint+hitbox 1.4–3.4/paint ~1。根因=GPUIX 每帧重建元素树→text 元素每帧全量重测（ellipsis 绕过帧内缓存）；terminal 为单 custom element 无此成本。插桩已按纪律恢复（保存 diff→checkout→--include 回补→export-patches --check 通过→重编 release .node→bench 冒烟无 [jgg1] 输出）。

- 2026-09-08 · 全模块静态分析首轮 + P2 动态基准：8 模块 32 项过筛；确认 P1×1（render.rs 零缓存）、P2a×1（draft 顶层，bench 证实线性增长 10.3x）、P2b×1（virtual-list JS/retained 层未窗口化，bench 意外发现）；观察项×5，上游/已知记录×3。P1 基准与修复待执行。
- 2026-09-08 · 范围收缩（用户拍板）：只看本仓代码，`.refs/gpuix` 移出分析范围（模块 8 整节移除，问题清单剔除上游项）；P1/P2a/P2b 的问题与修法已确认全部落在本仓文件，无需碰外部依赖。
- 2026-09-08 · 性能 HUD 上线（advanced.perfHud）：crates/jagent-terminal perf.rs 原子打点（PaintGuard RAII 挂在 TerminalRenderer::paint）→ napi takePaintPerf（直读原子，不走 host 通道）→ main.tsx 采样器（差分 fps/均值 + cpuUsage/mem）→ ui/PerfHud（500ms 轮询，seam 注入零 native 依赖）→ TitleBar trailing 插槽（win 三键左侧/mac 右侧空白）。全链测试绿（Rust 单测 + PerfHud 3 + app 180 + e2e 17；debug→release 已切回）。
- 2026-09-08 · HUD v2 整 app 测绘：发现 GPUIX 上游已内建整帧 profiler（gpui `profiler` feature + Window::draw 计时 + 1000 帧直方图，napi 已导出 getDebugFrameOverlayStats/setDebugFrameOverlay，@gpuix/react 类型面已带）——HUD 纯 JS 升级：fps 语义升级为整 app 重绘帧率（frames 差分），新增 draw p90/max 整帧耗时行，terminal paint 降为 term 子项；新增 advanced.frameOverlay 屏幕覆盖层开关（main.tsx 订阅 settings 去 重后调 setDebugFrameOverlay）。settings-ui.md §6/分表/§10 同步。app 180 全绿。P1 基准测量可直接读 draw p90/max。
