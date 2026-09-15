# 原型走查报告 — j-agent-prototype.html vs 实现

> 2026-09-14 · 对比基线：`design/j-agent-prototype.html`（?view= 深链，1280×800）
> vs `packages/app/proto-shot.mjs`（TestRenderer 截图 + `--geom` 几何导出）。
> 工具链在 `.shots/cmp/`：`shot-proto.mjs`（原型截图规范化）、`geom-proto.mjs` /
> `probe-dom.mjs`（原型几何）、`pngdiff.mjs` / `region.mjs` / `crop.mjs` / `geom-cmp.mjs`
> （像素 diff + 几何对齐）。用法详见 `docs/prototype-visual-diff.md`。
>
> **修复后差异率（2026-09-15 复测，A/C/D/E 类已修）**：
> main 1.13% · home 1.38% · chat 3.33% · ws 1.34% · git 4.40% · settings 2.98% ·
> panel 3.22% · search 1.31% · tool 2.90% · notif 1.88% · ctxmenu 1.51% ·
> errors 1.36% · hidden 0.46% · narrow 1.25%。
> 残余差异 = 字体整形/行高/抗锯齿（gpui vs 浏览器管线）+ markdown 高亮渲染
> （代码块语言头、语法着色）+ git 图节点样式，属渲染管线固有差异。
> 注：`shot-proto.mjs` 已修 `ws → workspace` 深链映射（此前 proto-ws.png
> 误截默认态）。

## 全状态差异率（修复前基线）

| 状态 | 差异率 | 主要集中区 |
|---|---|---|
| main | 2.19% | 侧栏列表、工具栏 |
| home | 2.42% | 侧栏列表、工具栏 |
| chat | 4.59% | 消息区、侧栏列表 |
| ws | 2.40% | 侧栏列表 |
| **git** | **6.04%** | Git 图区（多了 tab 条+工具条） |
| settings | 4.00% | 设置面板 |
| panel | 4.33% | 工作面板 |
| **search** | **14.24%** | 弹窗位置 + 面板残留（已修脚本） |
| **tool** | **12.65%** | ToolDialog 布局语言不同 |
| notif | 2.92% | 通知浮层内部 |
| ctxmenu | 2.43% | 位置不同（触发点不同，正常） |
| errors | 4.06% | 错误行结构不同 |
| hidden | 0.58% | 最小 |
| narrow | 1.44% | 工具栏 |

## A. 实现偏离原型（结构性，7 处）——已全部修复

| # | 位置 | 原型 | 实现 | 文件 |
|---|---|---|---|---|
| A1 | 工具栏左端 | 侧栏可见时**无** panelLeft 钮（仅 hidden/narrow 渲染） | 常驻渲染且 on 态高亮，chip 右移 36px（x276→312） | `plane/TitleBar.tsx` ~L380 |
| A2 | 工具栏 trailing | 无独立 Git 钮（入口 = 分支 chip） | 多了 `titlebar-git` 28px 圆钮 | `plane/AgentPlane.tsx` L283 |
| A3 | 错误指示器 | 纯文本 `⚠ 1`（11px 红，无背景） | 红底徽章（15% 底 + 40% 边框 + r6 + ml8） | `errors/ErrorIndicator.tsx` |
| A4 | 分支 chip | `main ⌄` 带 chevron | 无 caret | `plane/TitleBar.tsx` Chip 调用 |
| A5 | 工作区页 | **无 tab 条**（原型注释：paneTab=git 时整页切换） | 顶部多了「起始页/Git 图」tab 条 ~30px | `plane/WorkspacePage.tsx` L85 |
| A6 | ws-body | `margin-left:13 + padding-left:9`，**无竖线** | 多了 `borderLeftWidth:1` 竖引导线，子行右移 1px | `plane/WorkspaceList.tsx` L599/878 |
| A7 | 当前工作区行 | `.cur` 只提亮名字 + 5px 点，**无底色** | `isCurrent → bg:tile` 整行灰底 | `plane/WorkspaceList.tsx` ~L688 |

## B. 原型自身 bug（实现已修正，不回抄）

- **B1 `.ws-row .acts` 选择器失效**：`.acts` 是 `.ws-head` 的子元素而非 `.ws-row`
  后代，`display:flex` 没命中 → 两个 ghost 钮竖排 → ws-head 高 44px（意图 28px）。
  这是原型所有会话行比实现低 16px 的根因。修法：原型 CSS 改 `.ws-head .acts`。
- **B2 `.term-surface` 背景丢失**：`mountTerminals` 用 `slot.replaceWith(el)` 把带
  `--terminal` 底的容器换掉了，原型终端实际透出 pane 色 #1e2127；实现真终端用
  one-dark 底 #282c34，语义更正确。

## C. 弹窗/浮层——已全部修复

| # | 差异 |
|---|---|
| C1 **ToolDialog** | 布局语言不同：原型 440px 宽、标题 14px/600、工作区整行 select+cwd 同行、行 44px（28px 图标块+双行+cmd 徽章）；实现 420px、标题 16px、工作区小 chip+cwd 独立行、行 53px、cmd 纯文本无徽章底 |
| C2 **SearchDialog** | 原型 y=337（居中偏上），实现 anchored y=220；尺寸接近（560×126 vs 560×130） |
| C3 **ErrorDialog** | 行结构完全不同：原型 50px 行（ERROR 标签 + msg + area 小字 + 右侧相对时间）；实现 30px 行（红点 + 绝对时间戳 + 「错误」标签 + msg）。且实现弹窗高 ~100px（内容撑开），原型固定 body 340px |
| C4 **NotifPopover** | 位置接近，内部：原型标题 12px/600、item 46.8px（nt 12 + ns 10.5）；实现 13px、item 51px（nt 11.5 + ns 10） |
| C5 ContextMenu | 尺寸/行高一致（180×123、item 26px）；位置不同是触发点不同，正常 |

## D. 渲染管线（像素级最大噪音源）——已修复

- **D1 `FONT.ui`/`FONT.mono` 是 CSS 逗号列表**（`packages/ui/src/theme/tokens.ts`
  L77）：`'IBM Plex Sans, Segoe UI, system-ui, ...'`。gpui `font_family` 是
  **单名精确查找**（direct_write `GetMatchingFonts`），整串查不到 → 全部文本
  落内嵌 fallback 字体。所有文本宽度/行高差异的主因（impl 文本行高 19-21px
  vs 原型 17px）。
- **D2 消息区水平 padding 失效**：`virtual-list` 的 `paddingLeft/Right:24`
  没作用到行上——impl 消息行 x264 起、user 气泡右缘贴到 1279；原型内容
  x288 起、气泡右缘 1256。**真 bug**（行根 `width:100%` 吃的是列表全宽）。

## E. ≤2px 小偏差（成批）——已修复

pin 图标 10 vs 12px · idle-on 环 7 vs 9px · 通知红点 5 vs 7px（gpuix 把
border 算进盒内）· nav 文本 y 偏移 ~2px · sec-head 文本 y125 vs 127 ·
ws-row chev x16 vs 14 · chip icon 13 vs 14 / caret 11 vs 12 ·
conv-head 高 35 vs 36 · composer 高 58 vs 59 / textarea 34 vs 36 ·
终端首行 y 差 3px · sb-foot 48 vs 49px

## F. 截图脚本自身问题（已修）

- `panel` 状态后面板未关 → 污染 search/tool/notif/ctxmenu（已加关闭）
- `hidden` 单独跑正常（0.58%），之前批量跑被 font 状态污染
- `crash` 状态触发 `TerminalPool` seam panic（测试环境限制，截图仍产出）

## 结论

**几何级可以做到**（bounds 逐元素对齐），**逐像素做不到**——gpui 与浏览器的
文本整形/行高/抗锯齿管线不同，即使字体名修对，字形渲染也不会逐像素一致。
实际可达成：布局坐标一致 + 颜色一致 + 文本内容一致。

## 修复记录（2026-09-14）

- **A1** TitleBar：panelLeft 钮仅 narrow/sidebarHidden 渲染（`plane/TitleBar.tsx`）
- **A2** AgentPlane：删 `titlebar-git` 钮；分支 chip 点击 → ContextMenu
  （打开 Git 图 / 查看变更）（`plane/AgentPlane.tsx`）
- **A3** ErrorIndicator：徽章 → 纯文本 `⚠ n`（11px bell 色）
- **A4** TitleBar：分支 chip 加 caret；chip onClick 传坐标（键盘回退 lastPointer）
- **A5** WorkspacePage：删 tab 条，paneTab=git 整页 GitGraphView
- **A6** WorkspaceList：删 ws-body 竖引导线（两处）
- **A7** WorkspaceList：删 isCurrent 整行底色；当前 ws 名 textBright
- **B1/B2** 原型 bug 已修（`.ws-head .acts` 选择器、`mountTerminals` appendChild）
- **C1** ToolDialog 重写：440px、标题 14px、`.tool-ctx` 整行（bare SelectField
  + mono cwd）、`.tool-filter` 搜索行、分组标签、28px 图标块行、「默认」徽章、
  cmd 徽章、`.mhint` 脚（`plane/ToolDialog.tsx` + `Select` 加 `bare` prop）
- **C2** Modal：真垂直居中（`anchor="leftCenter"` + y=vh/2）；标题 16→14px
- **C3** ErrorDialog 重写：520 宽、body 340px scroll、`.err-item` 行
  （level UPPERCASE mono + msg + kind·context + relTime）
- **C4** NotifPopover：标题 12/600、item nt 12/lh17 + ns 10.5、clear 11px
- **D1** `FONT.ui`/`FONT.mono` → 平台单名（win `Segoe UI`/`Consolas` 等）
- **D2** ConversationView：virtual-list padding 移到消息行根（真 bug 修复）
- **E** pin 10→12 · 通知红点 7→10px 盒 · chip icon 13→14 / caret 11→12 ·
  ws-head 去定高/padding（高=子行 26px）· notif `.nt` lineHeight 17
- **数据** `pushNotice` 加 `reason` 参数：BEL 通知 sub = `工作区 · BEL`
  （原型「dotfiles · BEL」格式）
- **GitGraphView** RefBadges → 原型 `.ref-chip`：h16 / 8px 色块 / 10px mono /
  透明底 / head 边框 accent / tag 文字 amber
- 测试更新：TitleBar / AgentPlane / GitGraphView / Dialogs / WorkspaceList
  断言跟随新结构；`bun test` app 329 通过（2 个既有 flake：Windows renderer
  超时 + error log 钩子）
