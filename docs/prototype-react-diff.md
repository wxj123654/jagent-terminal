# prototype-react-diff.md — React 原型 ↔ 正式 app 基线差异（R0 产出）

> 基线日期：2026-09-17 · 仓库 commit：`9e91c27`（+ 未提交 WIP：SessionTabs /
> 会话视图 / FileSurface / 顶栏两行）· gpuix pin：`7ac9880`（gpuix-native 0.9.0，
> GPUI/zed `81c99f81`）
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
| sess-main / sess-git / sess-file / sess-shell | 同名 | t-ime 会话内视图（原型 ?view= 深链） |
| sess-add | sess-add | 「+」浮层：proto 点 .tb-add-btn，impl 点 testId=session-add |
| ctxmenu | ctxmenu | 右键「IME 候选窗定位」行 |
| narrow | narrow（--width 700） | 窄窗 |
| hidden | hidden | 侧栏收起 |

## 基线差异表（2026-09-17，TH=24/通道）

| 状态 | 全图 | 侧栏 | 顶栏 | 工作面板区 | 主区 |
|---|---|---|---|---|---|
| main | 6.65% | 8.91% | 7.24% | 4.71% | 6.41% |
| home | 4.02% | 8.74% | 2.57% | 0.83% | 3.57% |
| chat | 7.85% | 8.80% | 5.10% | 8.47% | 7.64% |
| acp | 3.48% | 8.90% | 3.64% | 2.35% | 1.73% |
| workspace | 4.90% | 8.70% | 3.50% | 1.12% | 5.04% |
| git | 6.45% | 8.71% | 5.16% | 4.71% | 6.41% |
| settings | 6.23% | 8.69% | 2.69% | 4.85% | 6.29% |
| panel | 9.27% | 8.87% | 7.30% | **14.69%** | 7.66% |
| search | 2.91% | 4.07% | 2.81% | 1.10% | 3.15% |
| tool | 4.18% | 4.09% | 2.80% | 1.10% | 5.59% |
| addws | 3.57% | 4.06% | 2.81% | 1.10% | 4.43% |
| errors | 1.67% | 4.13% | 3.79% | 0% | 1.01% |
| crash | 3.77% | 3.93% | 2.03% | 0.62% | 5.17% |
| notif | 7.27% | 11.45% | 7.24% | 4.71% | 6.58% |
| font | 7.28% | 8.72% | 5.59% | 5.89% | 7.49% |
| sess-main | 2.72% | 8.87% | 7.23% | 0% | 0.65% |
| sess-git | 6.64% | 8.87% | 7.24% | 4.71% | 6.41% |
| sess-file | 7.20% | 8.87% | 7.38% | 0.14% | 9.19% |
| sess-shell | 2.67% | 8.87% | 7.27% | 0% | 0.55% |
| sess-add | 7.56% | 8.87% | 7.66% | 4.74% | 8.10% |
| ctxmenu | 6.84% | 9.96% | 7.24% | 4.71% | 6.36% |
| hidden | 2.51% | 6.22% | 2.74% | 2.42% | 1.05% |
| narrow | 7.82%（pngdiff 全图，700×800） | — | — | — | — |

机器可读版：`.shots/cmp/report.json`。

## 已知差异（不可达 / 设计内）

1. **文本整形底噪 ≈4–9%**：GPUI DirectWrite vs Chrome 的字体整形、灰度
   抗锯齿、次像素定位不同——所有含文本区域都有满屏细描边级差异，
   这是差异率的主体，不逐项追。
2. **font_family 解析**：GPUIX `font_family` 单名精确查找（无 CSS
   fallback 链语义）；CJK 回退在两条管线走的族不同。
3. **sess-file 内容不同源**：原型是 11 行 mock 代码；impl 真读盘
   `Sidebar.tsx`（512KB/400 行截断）。布局可比，逐行文案不可比。
4. **git lane 画法**：commit 圆点/合并曲线在两边各自实现，走向一致、
   像素不同。
5. **几何 JSON 的 text 覆盖**：geom-proto 只采叶子节点文本
   （childElementCount===0），行/容器级文本不参与逐字对比——文案
   核对靠截图目检。

## 需人工复查的真实差异（本基线首次截图目检发现）

| 位置 | 原型 | 实现 | 模块 |
|---|---|---|---|
| 折叠行文案 | `显示另外 3 个` | `展开其余 3 个` | R4 侧栏 |
| 未归属组头 | `未归属会话` | `未归属` | R4 侧栏 |
| 空工作区 CTA | `启动第一个会话` | `创建第一个会话` | R4 侧栏 |
| Git 表头 | `GRAPH / DESCRIPTION / AUTHOR / DATE / SHA`（全大写） | `Graph / Description / Author / Date / Sha` | R6 Git 图 |
| 相对时间 | `昨天 21:40`（>1 天给「昨天 HH:MM」） | `1 天前` | R6 Git 图 relTime |
| git 工具行 `9 提交` | 右侧图标组旁 | toggle 旁（位置偏左） | R6 Git 图 |
| notif/sess-add 态侧栏差异 11.45%/9.96% | 通知铃红点样式 | 同义但描法略异 | R7 浮层 |
| panel 态 workpanel 14.69% | 变更列表 + diff | 布局同、内容行距/字号差异 | R5 WorkPanel |

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
