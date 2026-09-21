# prototype-react-diff.md — React 原型 ↔ 正式 app 基线差异（R0 产出）

> 基线日期：2026-09-17 · 仓库 commit：`9e91c27`（+ 未提交 WIP：SessionTabs /
> 会话视图 / FileSurface / 顶栏两行）· gpuix pin：`7ac9880`（gpuix-native 0.9.0，
> GPUI/zed `81c99f81`）
>
> **R12 收官复测：2026-09-21 · macOS（arm64 Retina）· 仓库 commit = R12 收官
> commit（其前一提交 `f4ea411`）· gpuix pin 未漂移**。复测修复了 report.mjs /
> region.mjs 的 Retina 归一 bug（见文末「R12 复测记录」）——本文件 R12 列与
> 基线列均为修正口径下的有效值，可互比；但 R9–R11 期间在 macOS 上用未修复
> report.mjs 产出的历史读数偏高，勿再引用。
>
> 基准 = `design/prototype-react`（HTML 原型已退役为其移植源；旧
> `prototype-walkthrough-report.md` 是 HTML 基线，不覆盖）。
> 目标不是逐像素一致（文本整形管线不同），而是 **布局坐标 + 颜色 + 文案 +
> 交互/状态** 一致。逐像素数字只用于定位差异位置，不作通过线。

## 工具链

| 侧 | 脚本 | 产物 |
|---|---|---|
| 原型截图 | `node scripts/cmp/shot-proto.mjs [状态…]` | `.shots/cmp/proto-<state>.png` |
| 原型几何 | `node scripts/cmp/geom-proto.mjs [状态…]` | `.shots/cmp/geom-proto-<state>.json` |
| 实现截图+几何 | `cd packages/app && bun run proto-shot.mjs --geom [--states …]` | `.shots/impl-<state>.png` + `.shots/cmp/geom-impl-<state>.json` |
| 差异报告 | `node scripts/cmp/report.mjs [--diff]` | stdout 表 + `.shots/cmp/report.json` + `diff-<state>.png` |
| 单图对比 | `pngdiff.mjs a b [diff.png] [--rows] [--cols]` / `region.mjs a b` | 阈值 24/通道 |
| DOM 探查 | `probe-dom.mjs` / `tree.mjs` / `crop.mjs` / `show.mjs` | 辅助 |

共享层 `scripts/cmp/chrome.mjs`：playwright-core（从 design/prototype-react
node_modules 解析）+ 系统 Chrome + 1280×800 视口；vite dev server 不在跑时
自动拉起（5199，结束回收）；规范化注入 = `#demo` 隐藏 + `*:focus{outline:none}`
+ `#app` 窗壳装饰（border/radius/shadow）剥掉——窗口 < 视口时窗壳不参与比对。
截图统一裁到 `#app` 盒；几何以 `#app` 左上角为原点（Radix Portal 挂 body，
坐标同原点换算）。`narrow` 态窗口 700×800，PNG 即 700×800。

## 状态对照表

proto 状态 → impl 状态（`?view=` 深链 → proto-shot case）：

| proto | impl | 备注 |
|---|---|---|
| main | main | 默认路由 = t-ime + 会话内 git 视图 |
| home | home | navigateTarget(null) |
| chat | chat | 「侧栏重构」会话 |
| acp | acp | Codex (ACP) |
| workspace | ws | ws-web 工作区页 |
| git | git | ws-jt 工作区 git 整页（paneTab） |
| settings / panel / search / tool / addws / errors / crash / notif / font | 同名 | 弹窗态 impl 侧关 Esc/遮罩 |
| panel-files | panel-files | 无深链：两侧交互复刻（开面板 → 文件 tab → 选 tokens.ts） |
| sess-main / sess-git / sess-file / sess-shell | 同名 | t-ime 会话内视图（原型 ?view= 深链） |
| sess-add | sess-add | 「+」浮层：proto 点 .tb-add-btn，impl 点 testId=session-add |
| ctxmenu | ctxmenu | 右键「IME 候选窗定位」行 |
| narrow | narrow（--width 700） | 窄窗 |
| hidden | hidden | 侧栏收起 |

## 差异率表（基线 2026-09-17 → R12 复测 2026-09-21，TH=24/通道）

R12 列为修复后 report.mjs / pngdiff.mjs 的全量复测值（机器可读版：
`.shots/cmp/report.json`）。「全图」列给 `基线 → R12` 两值，分区列只列
R12 实测。

| 状态 | 全图（基线→R12） | 侧栏 | 顶栏 | 工作面板区 | 主区 |
|---|---|---|---|---|---|
| main | 6.65% → **4.26%** | 4.19% | 3.92% | 3.31% | 4.70% |
| home | 4.02% → **2.50%** | 4.17% | 1.40% | 0.68% | 2.71% |
| chat | 7.85% → **3.90%** | 4.15% | 3.46% | 1.47% | 4.80% |
| acp | 3.48% → **1.69%** | 4.18% | 2.01% | 0.60% | 1.06% |
| workspace | 4.90% → **2.72%** | 4.15% | 1.84% | 0.99% | 2.95% |
| git | 6.45% → **4.17%** | 4.15% | 3.00% | 3.31% | 4.70% |
| settings | 6.23% → **3.45%** | 4.15% | 1.30% | 2.65% | 3.82% |
| panel | 7.94% → **5.34%** | 4.18% | 3.90% | 6.93% | 5.44% |
| panel-files | 8.53% → **5.68%** | 4.18% | 3.90% | 8.66% | 5.44% |
| search | 2.91% → **14.64%** ⚠ | 1.46% | 0.96% | 0.38% | 27.54% |
| tool | 4.18% → **1.98%** | 1.48% | 0.85% | 0.38% | 2.97% |
| addws | 3.57% → **1.67%** | 1.44% | 0.98% | 0.38% | 2.36% |
| errors | 1.67% → **0.96%** | 1.43% | 0.97% | 0.38% | 1.00% |
| crash | 3.77% → **2.01%** | 1.53% | 0.98% | 0.06% | 3.11% |
| notif | 7.27% → **4.50%** | 5.10% | 3.92% | 3.30% | 4.80% |
| font | 7.28% → **4.22%** | 4.15% | 1.30% | 5.16% | 4.36% |
| sess-main | 2.72% → **1.48%** | 4.18% | 4.11% | 0% | 0.54% |
| sess-git | 6.64% → **4.25%** | 4.18% | 3.92% | 3.31% | 4.70% |
| sess-file | 7.20% → **2.21%** | 4.18% | 3.96% | 0% | 1.98% |
| sess-shell | 2.67% → **1.45%** | 4.18% | 3.95% | 0% | 0.51% |
| sess-add | 7.56% → **5.10%** | 4.18% | 3.96% | 3.34% | 6.32% |
| ctxmenu | 6.84% → **4.35%** | 4.67% | 3.92% | 3.30% | 4.69% |
| hidden | 2.51% → **3.47%** | 7.69% | 2.45% | 3.31% | 2.01% |
| narrow | 7.82% → **5.54%**（pngdiff 全图，700×800） | — | — | — | — |

判读注记：

- **search 14.64% 是契约差异不是回归**：原型 `?view=search` 空 query 显示
  小空态（geom-proto 高 132）；实现按 §15 契约空 query 列全部会话
  （558×392 撑满主区文本）。R7 起即如此，基线 2.91% 是 R7 前的旧形态。
- **hidden 3.47%**（基线 2.51%）：侧栏收起态「侧栏区」只剩窄条带 + 抽屉
  入口，7.69% 为小面积上的底噪放大，非结构差异。
- panel/panel-files 的工作面板区残余（6.93/8.66%）为 diff/预览行密集
  mono 文本的整形底噪（R5 已把布局逐项对齐）。
- 全态残余主体 = 已知差异 §1 文本整形底噪（macOS CoreText vs Chrome）。

## 已知差异（不可达 / 设计内）

1. **文本整形底噪 ≈4–9%**：GPUI 文本栈（macOS CoreText / Windows
   DirectWrite）vs Chrome 的字体整形、灰度抗锯齿、次像素定位不同——
   所有含文本区域都有满屏细描边级差异，这是差异率的主体，不逐项追。
2. **font_family 解析**：GPUIX `font_family` 单名精确查找（无 CSS
   fallback 链语义）；CJK 回退在两条管线走的族不同。
3. **sess-file 内容不同源**：原型是 11 行 mock 代码；impl 真读盘
   `Sidebar.tsx`（512KB/400 行截断）。布局可比，逐行文案不可比。
4. **git lane 画法**：commit 圆点/合并曲线在两边各自实现，走向一致、
   像素不同；原型自身 svg 高 26 vs CSS 行高 30 的每行 ~4px 断口是原型
   bug，实现按 30px 连续画，不还原（R6）。
5. **几何 JSON 的 text 覆盖**：geom-proto 只采叶子节点文本
   （childElementCount===0），行/容器级文本不参与逐字对比——文案
   核对靠截图目检。
6. **search 空 query 列全表（契约）**：原型空 query 是小空态卡；
   实现按 settings-ui §15 契约列全部会话（SearchDialog 高 392 vs
   原型 132）。`search` 态差异率高位由此而来（R7 起）。
7. **原生 markdown 渲染差（R9）**：GPUIX `<markdown>` 对有 lang 的
   fenced code 恒渲染语言头行（无 theme 开关），code 块底是 ink(.035)
   洗色非 theme.bg——与原型 MdLite 裸 pre 存在不可消除的高度/底色差。
8. **滚动条不可达（R10）**：原型 ::-webkit-scrollbar 10px + thumb
   #3e4451 + r5 + 2px 内收边；GPUIX 用户级样式面无 thumb/track 控制
   （GPUI 能力在 native 侧已具备，需单独立项暴露）。终端 Zed 风格自绘
   滚动条是独立机制，不受影响。
9. **CSS 表现力天花板**：letterSpacing/textTransform 无对应（Git 表头
   字面写大写、字距不还原——R6）；CSS transitions / hover translateY
   不落地（R9/R10）；:focus-visible 双环近似为 2px 单阴影环（R10 注记）；
   composer 顶部渐隐近似为底部渐变带（R9）。
10. **平台保真偏离（有意）**：win/linux 三键维持 36px 全高 NC/CSD 命中
    区（原型 28px 居中钮是 CSS mock——R2）；ws-body 1px 引导线为归属锚点
    有意保留（原型无线——R4）；主 TerminalSurface 保持「残留网格」无
    退出条（Phase 1 不变量 3——R3）。

## 需人工复查的真实差异（基线目检发现 → R12 核销状态）

R12 复测逐项核销：文案类差异全部已修并在源码/测试中锁定，像素类残余
全部落入文本整形底噪带。**本表已清零——无待办差异项。**

| 位置 | 原型 | 实现 | R12 核销 |
|---|---|---|---|
| ~~折叠行文案~~ | `显示另外 3 个` | ~~`展开其余 3 个`~~ | ✅ R4 已修为 `显示另外 N 个`（WorkspaceList.test 锁定） |
| ~~未归属组头~~ | `未归属会话` | ~~`未归属`~~ | ✅ R4 已修（测试断言 `未归属会话`） |
| ~~空工作区 CTA~~ | `启动第一个会话` | ~~`创建第一个会话`~~ | ✅ R4 已修（测试断言 `启动第一个会话`） |
| ~~Git 表头~~ | 全大写 | ~~首字母大写~~ | ✅ R6 已修：字面写 `GRAPH / DESCRIPTION / …`（GPUIX 无 textTransform；字距不还原，记已知差异 §9） |
| ~~相对时间~~ | `昨天 21:40` | ~~`1 天前`~~ | ✅ R6 已修：relativeTime 增日历日「昨天 HH:MM」分支（format.test 锁定） |
| ~~git 工具行 `9 提交`~~ | 右侧图标组旁 | ~~位置偏左~~ | ✅ R6 已修：spacer 右置（geom 对照命中） |
| ~~notif/sess-add 侧栏差异~~ | 通知铃红点样式 | 同义但描法略异 | ✅ R4 重绘后收敛：notif 侧栏 11.45%→5.10%、ctxmenu 9.96%→4.67%（R12 实测，残余=底噪） |
| ~~panel 态 workpanel 14.69%~~ | 变更列表 + diff | ~~结构差异~~ | ✅ R5 已修 → R12 复测 6.93%（文本密集区底噪带内） |

## R0 工具链修复记录（顺手做的）

- `proto-shot.mjs`：`getElementBounds` 数组下标 → `{x,y,width,height}`
  对象（gpuix eac7181 起 API 变更，3 处）。
- `proto-shot.mjs`：ctxmenu 态右键菜单截图后未关 → Esc 到 Popover 内容盒
  （autoFocus 焦点所在；发 root 无效——事件从焦点向上冒泡）+ 外点兜底。
  此前一直污染后续 sess-* 截图。
- `FileSurface.tsx`：代码区容器缺 `display:flex/flexDirection:column` +
  `lineHeight:1.55`（GPUIX line_height 是 px 绝对值不是 CSS 倍数，1.55→
  2px 行高 → 600 行叠成马赛克）。修为 column + `lineHeight:17`（项目
  惯例绝对 px）。sess-file 全图差异 15.89%→7.20%、主区 25.69%→9.19%。
- 原型 `App.tsx`：补 `?view=sess-main/git/file/shell` 深链（截图入口，
  不改语义）；`.tb-add-btn`/`.session-add-pop` 类名供工具链定位。

## dev 崩溃调查进展（R0 附带任务，未结）

现象：`bun run dev` 起 ~2min 后 `window not found` → `无效的窗口句柄`
→ `getDebugFrameOverlayStats` 报「UI thread stopped」→ exit 9。

已确认：

- `PerfHud`/`getDebugFrameOverlayStats` 只是首个发现者。真正的死亡序列：
  `cx.windows` 里窗口被移除（`removed=true` → trail 清理 → `Box<Window>`
  drop → `DestroyWindow`）→ `QuitMode::LastWindowClosed` 下 `cx.quit()` →
  `run_ui_commands` 的 command receiver 随 UI 线程一起结束 → 后续
  `send_ui_command` 全部报 UI thread stopped。
- `window not found`（app.rs:1929 `update_window_id`）有两条路径：
  窗口已移除，**或 re-entrant update**（`take()?` 在窗口正被 update 时
  返回 None）。单次失败不杀线程，只是错误日志。
- 复现不稳定：默认日志级别 ~2min 崩了一次；`RUST_LOG=debug` 下连跑
  12min+ 未崩（stderr IO 改变时序 → 竞态特征）。
- panic.log 反复出现 `Leaked handle for entity TerminalView`（gpuix-ui
  线程退出时 entity_map 清点的泄漏报告）——与 UI 线程退出同时出现，
  但尚不能证明因果（也可能都是窗口销毁的后果）。

待查：① 谁在无输入时触发了窗口移除（`remove_window` 调用点：
`CloseWindow` action、`WM_CLOSE`/`WM_DESTROY` wndproc、app 代码）——
二分 WIP（SessionTabs/tabs 插槽/新视图调度）确认是否新渲染路径触发；
② `handle_destroy_msg` 的 close callback 链；③ TerminalView 泄漏是否与
视图 PTY 的 TestRenderer/dev 生命周期有关。

**R12 状态**：调查未结，转入下方「真窗口手验清单」——原竞态在 Windows
上复现不稳定（debug 日志下 12min+ 不崩），macOS 上是否复现待 `bun run
dev` 长开观察。

## R12 复测记录（2026-09-21）

**工具链修复（本轮发现，两处在 macOS Retina 下才触发）**：

- `report.mjs`：impl 图归一到 proto 尺寸后，像素索引仍用原图宽
  `ib.width`（2560）作行步长 → 错行采样，差异率系统性偏高（errors
  报 10.5% 实应 0.96%）。修为 `db.width`。1:1 截图环境（Windows 非
  Retina）下该 bug 潜伏不发作。
- `region.mjs`：从未做 Retina 归一（只裁两图重叠区 = 拿 impl 2x 图的
  左上四分之一比），同步修为 pngdiff 同款「归一到 A 图尺寸」。
- 修复正确性交叉验证：复测值与 R10 当日 pngdiff 抽查逐字吻合（tool
  1.98 / addws 1.67 / errors 0.96 / crash 2.01 / search 14.64）。

**截图复测口径**：shot-proto 24 态 + geom-proto 24 态全量重采；impl 侧
按 R10 记录的坑分四进程跑——主进程 21 态（…,sess-add,font 收尾）+
`crash`（独立 root）、`hidden`（持久侧栏态）、`narrow --width 700` 各自
独立进程，互不污染 testId/路由态。

**全量回归（R12 数字）**：app `tsc --noEmit` 0 错 · ui `tsc` 0 错 ·
`fmt:check` 224 文件干净 · `oxlint` 234 文件 0 警 · 根 `bun test`
**532 pass / 0 fail** · `bun test e2e/` **35 pass / 0 fail** ·
`export-patches --check` 一致 · `cargo test -p jagent-terminal`
**41 pass / 0 fail**（本 Phase 未动 Rust，确认无漂移）。

## 真窗口手验清单（R12 汇总——给用户的人工验收项）

以下各项 e2e/截图/几何已尽可能覆盖，剩余只能真窗口确认。按功能分组，
每条一句话说验什么。

**窗口与顶栏**

- [ ] macOS 红绿灯让位（侧栏头部 71px）、顶栏拖拽移动、双击 zoom
  （测试基建 click_count 恒 1，双击/手感只能真机验）
- [ ] 真彩色渲染 + vim 类 TUI 应用光标模式/反色光标块（Phase 0 验收项，
  macOS 窗口复验一遍）
- [ ] IME 中文输入 + 候选窗定位（曾验收通过；Phase R 改过周边 chrome，
  顺手复验）

**终端本体**

- [ ] 鼠标拖选/双击选词/三击整行/Shift 扩展选区 + 松开即复制
- [ ] 滚动条：拖 thumb、点轨道翻页、滚轮/移入渐入·静止移出渐出的手感
- [ ] 终端聚焦时 Ctrl-Tab 会话切换（W5 修复的 ctrl-tab→\t 吞键回归）
- [ ] ⌘K 开搜索弹窗后打字是否正常（TestRenderer 有「terminal 在场
  帧后抢回焦点丢键」已知问题——真窗口若复现需开专项修 gpuix/gpui 层）

**侧栏与工作区**

- [ ] 「浏览…」目录选择 NSOpenPanel 真交互：弹出/选择回填/取消
  （W3 seam，agent 无法自动断言模态面板）
- [ ] 窄窗口 <760px 抽屉：汉堡钮开合、scrim/Esc 关、**跨断点拖宽复位
  后再收窄不自动重开**（offscreen 窗口不能动态变宽，R11 fit() 语义
  只真窗可验）
- [ ] 右键/「…」两级上下文菜单项与 disabled 态、工作区行整行折叠手感

**Git 图**

- [ ] 虚拟列表行点击选中（TestRenderer 拿不到 list 行 bounds，点击
  管线只真机可验）+ 提交详情右栏「无内容不再可滚」回归复查
- [ ] 分支浮层锚定、find 步进、r 刷新 / Esc / ↑↓ / Enter 键位手感

**弹窗与提示**

- [ ] 错误面板（titlebar ⚠ → ErrorDialog 行结构/关闭）与崩溃残留
  提示（CrashDialog + 真 crash.json/minidump 路径）真窗口展示
- [ ] Toast 右下角弹出（如工作面板刷新触发）与自动消散
- [ ] 通知中心铃铛红点、条目点击已读+跳转对应会话
- [ ] FontSelect 弹层定位、长字体列表滚动、自由输入兜底

**系统与遗留**

- [ ] 桌面通知：bell → 切到非激活会话 → 系统通知送达（macOS 通道）
- [ ] Windows 真机：`.exe` 图标 + 任务栏/Dock 外观、ConPTY 全链
  （本机 macOS，Windows 面全部未验）
- [ ] dev 崩溃未结调查（见上节）：`bun run dev` 长开观察是否复现
  「window not found → UI thread stopped」
- [ ] 嵌套滚动序列锁定手感：内层到底不带动父层、鼠标移动后才交父层
  （500ms 空闲 / 10px slop，Chromium 式——e2e 已锁语义，手感待验）
