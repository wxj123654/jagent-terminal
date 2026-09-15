# 原型↔实现 截图对比工具链

> 用途：`design/j-agent-prototype.html`（HTML 原型）与 `packages/app`（GPUIX 实现）
> 的逐状态视觉/几何对比。产物全部落在 `.shots/`（gitignore，可重建）。
>
> 关联文档：`docs/prototype-walkthrough-report.md`（首轮走查差异清单）。

## 流水线

```
design/j-agent-prototype.html ──► shot-proto.mjs ──► .shots/cmp/proto-<state>.png
                                └─ geom-proto.mjs ─► .shots/cmp/geom-proto-<state>.json
                                └─ probe-dom.mjs  ──► 任意选择器几何（终端打印）

packages/app/proto-shot.mjs ────► .shots/impl-<state>.png
                  （--geom）  └─► .shots/cmp/geom-impl-<state>.json

pngdiff.mjs  逐像素 diff + 差异率 + diff 图
region.mjs   分区差异率（侧栏/工具栏/面板分段定位）
crop.mjs     同区域左右拼接放大图（人工核对）
tree.mjs     geom-impl JSON 缩进树打印
show.mjs     geom JSON 紧凑表格
```

## 用法

### 1. 实现侧截图 + 几何（bun + TestRenderer）

```bash
cd packages/app
# 全量状态（main home chat ws git settings panel search tool notif ctxmenu）
bun run proto-shot.mjs --geom
# 单状态 / 窄窗
bun run proto-shot.mjs --geom --states main,chat
bun run proto-shot.mjs --geom --width 700 --states narrow
```

产物：`.shots/impl-<state>.png` + `.shots/cmp/geom-impl-<state>.json`。

`--geom` 导出整棵元素树的 `{path,type,testId,text,x,y,w,h,bg,color,fs,fw,pl,pr,ml,mt,gap,br,bl}`，
与原型侧 `getBoundingClientRect` 结果逐字段可比。

### 2. 原型侧截图（headless Chrome）

```bash
# 仓库根目录
node .shots/cmp/shot-proto.mjs            # 全量状态
node .shots/cmp/shot-proto.mjs main chat  # 指定状态
```

产物：`.shots/cmp/proto-<state>.png`（1280×800）。

**规范化三件事**（不做则无法逐像素比）：
1. `#app` 强制 1280×800、去 `fitWindow` 的 border/radius/shadow；
2. 隐藏 `#demo` 演示条与右下角水印（实现侧没有）；
3. `*:focus{outline:none}`——`.term` 是 `tabIndex=0` 的 div，挂载即 focus，
   Chrome 默认 focus-ring 会在终端四周画 2px 白线+黑偏移，污染整图。

### 3. 原型侧几何

```bash
node .shots/cmp/geom-proto.mjs main          # 预置选择器集 → geom-proto-main.json
node .shots/cmp/probe-dom.mjs ".t-row" ".ws-head"          # 任意选择器（view=main）
node .shots/cmp/probe-dom.mjs --view=tool ".tool-row"      # 指定 ?view=
```

坐标以 `#app` 左上角为原点（与 TestRenderer bounds 同基准）。

### 4. 对比

```bash
# 逐像素 diff（阈值 24/通道）+ 差异率 + 行/列直方图 + diff 图
node .shots/cmp/pngdiff.mjs .shots/cmp/proto-main.png .shots/impl-main.png \
    .shots/cmp/diff-main.png --rows --cols

# 分区差异率（侧栏头/nav/区头/列表/脚 + 工具栏左右 + 面板三段）
node .shots/cmp/region.mjs .shots/cmp/proto-main.png .shots/impl-main.png

# 同区域左右拼接放大（左=原型 右=实现，中缝品红）
node .shots/cmp/crop.mjs .shots/cmp/proto-main.png .shots/impl-main.png \
    .shots/cmp/z-list.png 0 145 264 180 3

# 几何树/表格
node .shots/cmp/tree.mjs .shots/cmp/geom-impl-main.json [filterSubstr]
node .shots/cmp/show.mjs .shots/cmp/geom-proto-main.json [geom-impl-main.json]
```

## 状态名对照

| proto-shot `--states` | 原型 `?view=` | 说明 |
|---|---|---|
| main | （无，默认） | 终端会话激活 |
| home | home | 空态起始页 |
| chat | chat | chat 会话（含回复） |
| ws | workspace | 工作区起始页（web） |
| git | git | Git 图（ws-jt） |
| settings | settings | 设置页 |
| panel | panel | 工作面板（变更 tab + diff） |
| search | search | 搜索弹窗 |
| tool | tool | 新建会话弹窗 |
| notif | notif | 通知浮层 |
| ctxmenu | ctxmenu | 会话行右键菜单 |
| errors | errors | 错误历史弹窗 |
| font | font | 字体选择器 |
| crash | crash | 崩溃残留弹窗（独立 root） |
| hidden | hidden | 侧栏收起 |
| narrow | narrow | 700px 窄窗（`--width 700`） |

## 已知边界

- **逐像素一致不可达**：gpui（DirectWrite）与浏览器文本整形/行高/抗锯齿
  管线不同，字形渲染不会逐像素一致。可达成的是布局坐标 + 颜色 + 文本一致。
- **字体**：`FONT.ui`/`FONT.mono` 是 CSS 逗号列表，gpui `font_family` 单名
  精确查找会失败落 fallback——文本宽度/行高差异的主因（见走查报告 D1）。
- **状态污染**：proto-shot 各 case 共享同一 root，`panel`/`font`/`settings`
  等持续态不关会污染后续截图（panel 已加关闭；批量跑 `hidden` 前先确认
  前面状态无副作用）。
- **crash 状态**：测试环境无 TerminalPool seam，`createTestRoot` 二次挂载
  会 panic 一条日志，截图仍正常产出。
- **原型截图的 demo 条**：`shot-proto.mjs` 已隐藏；若手工截原型记得加
  `*:focus{outline:none}` 和 `#demo{display:none}`。
- **diff 阈值**：`pngdiff.mjs` 默认通道差 >24 记为不同（抗锯齿灰边不计）；
  要更严可改 `TH`。
