# ui-detail-audit.md — React 原型 ↔ 实现 全量细节审计（2026-09-22）

> 方法：8 个只读子代理按模块并行逐行比对 `design/prototype-react`（唯一视觉/交互基准）
> 与 `packages/app` + `packages/ui`。原型 `index.css` 一律取第二段 `:root`/覆盖段
> （694 行起）生效值；token 引用两侧均解析到 hex 后比对。
> 与 `prototype-react-diff.md` 的关系：该文是**截图/几何差率**口径，本文是**代码级
> 逐细节**口径；该文「已知差异 §1–10」内的项此处标 KNOWN 不重复展开。

## 0. 总评

| 模块 | 一致度 | 主要残余 |
|---|---|---|
| tokens/图标 | ≈100% | COLORS 与第二段 `:root` 逐 hex 全等（34 值复核）；图标 32/33 覆盖（`arrowLeft` 原型死映射有意不收），字形逐字对齐 lucide-react@1.46.0，stroke-width 2/24 viewBox/round cap 一致 |
| Sidebar | ~95% | 角标/红点尺寸偏大（border-box 误读）、IconButton hover 双差、tooltip 全灭、菜单锚定 |
| TitleBar/Plane 壳 | 高 | 悬浮提示整片缺失、抽屉右缘阴影缺、Ctrl-Tab 顺序语义 |
| surfaces 会话面 | 高 | markdown GFM 超集（inline code 紫色等 6 项）、滚动跟随语义、视图退出条形态 |
| WorkPanel | 高 | IconButton hover 色、图标间距 ~3px、截断粒度、重选闪加载 |
| GitGraphView | 高 | **列表高少 30px（TAB_H 幽灵扣除）**、find 不聚焦/⇧Enter 无反向、菜单键盘穿透、表头左偏 8px |
| Dialogs 弹窗族 | 高 | Select 浮层底色 `#1A1A1A`、Esc 嵌套连坐、菜单项 26/r4 vs 30/r6、Toast TTL/单例 |
| Settings+控件 | 高 | st-card 末行残留 1px 边、RangeInput 缺 `px` 后缀、Select 触发器 220 固定宽、窄屏断点未移植 |

**token 层零漂移**：`COLORS` 全部色值与原型第二段 `:root` 逐值相同（多模块独立复核一致）。

---

## 1. 跨模块系统性偏差（一处根因多处表现）

### S1. IconButton hover 规范偏差 —— 波及侧栏头/脚 3 钮、WorkPanel 头 2 钮、Git 工具条、设置 reset
- 原型 `.ibtn:hover` / `.hbtn:hover`：底 `surface #2a3039` + 图标提亮 `textBright`（index.css:141,298）
- 实现 `packages/ui/src/controls/IconButton.tsx:72`：底 `surfaceHover #313844`，图标恒 `muted` 不提亮
- 另有默认 `radius=4`（IconButton.tsx:27）vs 原型 `.ibtn` r8——Git 工具条钮未传 radius 处为 r4
- 修法：hover 底改 surface + 图标 hover 色 textBright；调用方按需传 radius=8

### S2. 悬浮提示/label 全灭 —— 顶栏全部钮 + 侧栏 IconButton + tab + ctx 块
- 原型每钮 `title=`（含快捷键后缀「（Ctrl-B）」「（Ctrl-K）」「（Ctrl-,）」）
- 实现：ToolButton/BranchButton/Tab/ContextBlock/session-add/error-indicator/panel-toggle/drawer-toggle 全无 tooltip；侧栏 IconButton `tooltip={false}`（Sidebar.tsx:85,383,394）
- 附带损失：快捷键提示文案丢失（mac 实为 ⌘ 系，proto Ctrl-* 文案本就不准——补的话按平台拼）
- 注意：`IconButton.tsx:3-4` 自家定的 aria 等价物标准是「强制 label + Tooltip」，顶栏这批裸 div 连 label 都没接

### S3. box-sizing 前提写反 → 角标/红点偏大
- 原型全局 `*{box-sizing:border-box}`（index.css:20）：`width:6+border:1.5` 总宽仍 6px
- 实现注释误读为「CSS border 在盒外」：
  - ThreadRow TileDot 9px vs 原型 6px、idle-on 10 vs 7（ThreadRow.tsx:80-110）
  - 通知红点 badge-dot 10px vs 原型 7px（Sidebar.tsx:402-419，中心对齐了但直径 +43%）

### S4. Select/FloatingLayer 缺陷簇（Select + SearchSelect/FontSelect/Combobox）
- `Select.tsx:110-125` SelectContent 无 `backgroundColor` → FloatingLayer/anchored 兜底 `#1A1A1A` 整层错色（应 overlay #242a32）
- 缺左右 padding 4（Select.tsx:112-113、SearchSelect.tsx:366-367 只设上下）
- 项高/圆角：sel-item/font-row 26px r4 vs 原型生效值 min-h30 r6（index.css:834）
- Combobox 四角渗色：FloatingLayer 外层 anchored 无 style → 兜底色透出 r12 圆角（gpuix-usage 技能已记的坑，Popover/Modal 对了、Select/Combobox 绕过）
- 触发器：固定 `width:220` vs 原型 `min-width:120/180` 内容自适应；paddingRight 8 vs 原型 26（chevron 让位）；hover 变 focusBorder 是实现新增
- Select 无字符跳项（typeahead）；Esc 会冒泡连坐关 Modal（见 S5）

### S5. Esc 嵌套连坐关闭
- Modal.tsx:119-126 `modal-card` 对 escape 无条件 onClose；Select/Combobox 弹层 Esc 只关自身后继续冒泡 → ToolDialog 里开着工作区下拉按 Esc 会把整个弹窗关掉（原型 Radix 分层只关最上层）
- 修法：modal-card Esc 分支先查 keyConsumed 是否已被同事件置位

### S6. 菜单定位与键盘
- 原型 Radix：「…」/chip 菜单锚触发钮下缘 +4px；实现统一点击点坐标（ThreadRow/WorkspaceList/SessionTabs/branch chip）——键盘打开时位置取决于上次鼠标位置
- 菜单无 ↑↓ 项间导航（仅 Tab）；GitGraph 菜单开着时 ↑↓ 穿透到 graphKeys 改选中行（graphKeys 无 menu-open 门）
- 右键无 `isRightClick` 守卫处：GitGraphView 行/chip `onAuxClick` 中键也弹菜单（:479-485,147）；ThreadRow/WorkspaceList 已有守卫

### S7. placeholder 色平台硬编码
- GPUIX `input.rs:1389` 硬编码 `#8f8f8f`；原型 `::placeholder{color:var(--muted)}` = `#818b99`
- 影响全部输入框；要对齐需 gpuix 补丁暴露 placeholderColor（走 export-patches 流程），或登记进 diff 文档已知差异

### S8. 焦点视觉覆盖不全
- focusRing() 单环已有（KNOWN §9 近似双环），但：设置搜索框只有 border 变色无环（SettingsView.tsx:176-190）、NumberInput 无 focus 视觉、侧栏 NavRow/more-link/empty-hint/GhostButton 连单环都没接（靠 hover 底兜底）
- [QUESTION] GPUIX focus 是否冒泡：ws-head `.acts`/ThreadRow menu-btn 的 focus-within 揭示依赖焦点落在 opacity:0 的钮上时父级能否感知——不冒泡则键盘用户看不到焦点位置

---

## 2. 分模块 DIFF 清单（去重后；✦=建议优先修）

### Sidebar / WorkspaceList / ThreadRow
- ✦ S3 角标尺寸（上节）
- ✦ 双击 ws-row 缺 `clickCount` 守卫 → 双击=两次 toggle 净零（WorkspaceList.tsx:671；GPUIX click 带 clickCount，TitleBar.tsx:76 已在用）
- ✦ 存活 terminal 行「移除」直接删行 vs 原型 closeThread 转 exited 灰行保留（store.ts:422-449 ↔ proto store.ts:262-266）——行为语义差，需裁决
- active+exited 行标题色：proto 同级后者胜出=textBright；impl `exited?exited:…`=灰（ThreadRow.tsx:213）
- 未归属组头 hover 无底（:524-539）；ws-empty-hint hover 不提亮文字（:776-807）；nav-row 无 userSelect（:233-245）；more-link 多 paddingRight:7（:467）
- 截断豁免多一态：keepId=active∪focusTid（:71-72，注释自称有意）
- sb-resize 把手：原型 `right:-3` 外探 + hover 6px `rgba(97,175,239,.25)` 泛蓝带；impl 收进栏内 `right:0` + hover 2px accent 细线（Sidebar.tsx:349-362，注释称外探会被 Pane hitbox 截断——有意偏离，未进 diff 文档）
- removeWorkspace 无 toast（proto 有「工作区已移除」）
- 版本号 `v0.1` → `v0.1.0`（注入版本，合理偏差）
- rowTitle 兜底链多一级 initCommand + 'Terminal'（terminal.ts:12-15，仅三级全空时可见）

### TitleBar / Plane 壳 / SessionTabs
- S2 tooltip 全灭（上节）；分支菜单项文案两侧一致 ✓
- ✦ 抽屉 `#drawer-panel` 缺 `8px 0 32px rgba(0,0,0,.4)` 右缘投影（AgentPlane.tsx:354-365 ↔ index.css:675）
- Ctrl-Tab 循环序 = 创建序 vs 原型侧栏可视序（store.ts:468-479 ↔ proto store.ts:436-446；impl 注释有意，但与「下一个看见的会话」预期不同——产品确认）
- Toast 单例+TTL 4000 vs 原型堆叠+2600（Toast.tsx:41 注释误记「原型 4s」）
- 分支 chip `maxWidth:220` 防溢出（impl 独有，方向正确）；分支 chip 只在有 git 上下文时渲染（proto mock 恒显，impl 诚实语义）
- PerfHud 右距 12 vs 6（小）；navGo 前进/后退栈无 UI 入口（潜在缺口）
- SessionTabs：`session-add` 浮层 minWidth:280 vs proto 定宽 280；新增「当前工作区无变更文件」空态；shell tab 的 oscTitle/need 紫点为真 PTY 语义增强（合理）

### surfaces / ConversationView / FileSurface / EmptyPresets
- ✦ markdown 超集差（对 proto 可见）：GFM 全语法 vs MdLite 字面渲染——
  - inline code 色 `#c4b5fd`（Comet 默认未覆盖）vs 承正文 `#b6beca` —— MD_THEME 加 `codeText: COLORS.text` 一行可修
  - code 块 syntect 着色 vs 单色；code 12.5/18 vs 12/19.8
  - **块距方向修正**：proto `p/ul margin:6px 0` 相邻 collapse → 有效 6px、`pre m8` → 8px；impl `mdBlockGap:12` 统一（ConversationView.tsx:65 注释「6+6 合并」误读了 margin collapsing）→ 实现块间距约 1.5–2× **偏大**（非偏小）
  - ul 26px 缩进+accent 圆点 vs 18px+本色点；有序列表 accent 数字 vs 字面 `1.`；软换行 `\n`→空格 vs `<br>`
- 滚动跟随：followTail 用户上滚脱随 vs 原型强制回底（impl 语义更好，行为不同）
- 视图退出条：26px 固定底条/mono11 vs 原型参照物为网格内 ~19px 文本行/mono13（且原型视图层本无退出态——新增能力的形态选择）
- composer autoFocus（原型无）；send 钮 disabled 态仍可聚焦；placeholder #8f8f8f（S7）
- FileSurface：400 行截断静默无标记；新增加载/失败 hint（设计内）
- 窄态消息列底内距 18 vs 22（B8）；user 气泡 lineHeight 21 vs normal
- home/empty 卡、pills、kicker、ctx 行、全部中文文案逐字一致 ✓

### WorkPanel
- S1 头钮 hover 色差；✦ 面板开关钮 tooltip 缺（S2）
- ptab/wp-file-head 图标↔文字间距少 ~3px（原型 JSX 同行空格 vs 裸 gap）
- FileName 双 text 各自 ellipsis vs 原型单文本流尾截（dir 先断）
- 'a' 态分支：暂存新文件 impl 显示 diff、proto 恒 hint；diff 尾行多一条 16.5px 空白（runGit 不 trim）
- 重选同一文件重拉 diff 闪「加载 diff…」（QUESTION）
- 预览行高 17.05→17（亚像素）；wp-file-head 加 ellipsis（更收敛）
- 新增 6 条加载/异常文案（无原型可比对，必要）

### GitGraphView
- ✦✦ `TAB_H=30` 幽灵扣除：listHeight = winH − topChrome(83) − TAB_H − 42 − 30，但会话视图 tab 已含在 topChrome 内、Pane/WorkspacePage 无 30px 条 → **列表底部 ~30px 死区**（GitGraphView.tsx:727-733）
- ✦ find input 无 autoFocus（打开要先点一下）+ radius 8 vs proto r4；⇧Enter 不能反向（TextInput 只看 key==='enter'）
- ✦ 菜单开着 ↑↓ 穿透改选中行（S6）
- 表头 GRAPH 文本 x=8 vs proto x=16（impl 把原型「表头比 gcell 右偏 8」的错位修平了——裁决还原还是保留）
- hollow 语义：`i===0` 恒首行空心 vs proto 数据位 `c.hollow`（v2 意图=HEAD 空心，建议绑 HEAD 而非行 0）
- lane 配色：首占顺序 vs proto `LANE_COLORS[lane%8]`；merge 线取 parent lane 色 vs proto from-lane 色（复杂历史下可见）
- 分支浮层缺 upstream 尾标（`b.up`；types/cli 未取 upstream 字段）
- CDV SHA 显示 40 位全 sha vs proto 7 位短 sha
- 远程开关真过滤 remote chips（proto 开关不生效——impl 超前符合 v2 意图，记为差异）
- remote 判定 `includes('/')` 误伤本地斜杠分支（feat/x 被当远程——关掉开关会隐藏它）
- 实现超前（符合 v2 意图）：15 项提交菜单、ref 三级菜单、danger 确认/prompt 弹窗、会话内 git 也吃裸键
- 窄态断点口径：proto `@media(max-width:900px)` 按**窗口宽** vs impl `rowWidth<900` 按**面板宽**（GitGraphView.tsx:753,838）——侧栏挤压时 impl 更早隐 author/date 列
- [QUESTION] `.tb-cell.off{opacity:.38}`：proto CSS 有该禁用态类，impl ToolButton 无 off 态——proto 实际挂载点未确证（疑死 CSS 或真用于不可用态）
- 死代码：`git_graph.rs:54-84,307-359` 原生徽章绘制不可达（RowSpec 从不发 badges）；commitMenu title 字段不渲染
- 双侧均缺的 v2 项：⌘F、find flash、圆点 tooltip、SHA 点击复制、列宽拖拽（G5）、CDV 穿线、mute

### Dialogs / 浮层
- S4 Select 簇、S5 Esc 连坐（上节）
- ✦ ToolDialog 未归属入口 bug：`workspace` 条件误伤 ACP 行 → 未归属态下「对话」组标悬空无行（ToolDialog.tsx:199-220 ↔ proto Dialogs.tsx:148-168 ACP 行不要求 ws）
- SearchDialog：↑↓ 环回 vs proto 钳位；hover 联动选中为实现新增（无害）
- WorkspaceDialog：label2 `项目目录（绝对路径）` vs proto `目录`；name 输入缺 autoFocus；三态 inline 校验 vs proto 单 toast（实现更完整，文案面不同）
- RenameDialog：空名提交 impl 静默关 vs proto 清空标题（impl 更安全）
- ErrorDialog：空态 12px 居中 vs proto 13px 顶对齐；level 模型不同（fatal/error/warn vs error/warn/info）+ 行展开 detail 为新增
- CrashDialog：meta 行/真路径为真实数据（有意）；[QUESTION] Esc/遮罩也 dismiss 删 crash.json 是否有意
- NotifPopover 结构/锚定/tone 逐字一致 ✓；S3 红点偏大

### Settings / 控件
- ✦ st-card 末行底边未去除 → 每张卡最后一行多 1px 线（SettingRow.tsx:152、SettingsSections.tsx:361,437 无条件 borderBottom ↔ proto `:last-child{border-bottom:0}`）
- RangeInput 值缺 `px` 后缀（回滚行数/侧栏宽度/终端字号三处；SettingRow 未传 format）
- 触发器宽度 S4；NumberInput 无 focus 视觉；设置搜索框无 focusRing（S8）
- 窄屏 <760 断点未移植（proto settings 折纵向/nav 横排）
- `设置` 品牌字重 400 vs strong 700；搜索分区头 400 vs 600；`.hit` 徽章字重待证
- `.st-clear` 居中 vs proto 贴左；`.le-add` hover 不提亮文字；`.le-card` 首卡 marginTop 10 vs 12
- 文案追加（信息扩充，需确认保留）：perfHud desc 追加、ACP intro 追加句、预设/ACP 编辑器尾注各一段、Label placeholder `显示名`
- acts 展开常显（proto 仅 hover）；置灰 nav 点击清空搜索（新增行为）；nav/按钮无 Space 激活
- amp 预设多 `env:{AMP_FORCE_BEL:'1'}`（数据差）；`Badge.tsx` 三变体死代码且与原型 `.bdg` 形态不符

---

## 3. QUESTION / 待裁决汇总

1. Ctrl-Tab 创建序 vs 侧栏可视序（建议可视序）
2. 存活 terminal「移除」删行 vs 转灰行（原型语义）
3. Toast 堆叠 2600ms vs 单例 4000ms
4. CrashDialog Esc/遮罩即删 crash.json
5. 菜单锚定：点击点 vs 触发钮下缘（涉及全部「…」/chip/＋）
6. hollow 圆点绑 `i===0` vs HEAD
7. 表头 x=8 vs 还原原型 x=16 错位
8. GPUIX focus 是否冒泡（focus-within 揭示实际可用性）
9. gpuix host.ts 实际暴露 `role/aria-*` 面（与「无 aria」前提不符）——是否补接线
10. `<text>` 节点 padding 是否生效（hint 内距）、`overflow:'scroll'` 是否恒占轨
11. `<anchored>` 菜单视口钳位（右下边缘菜单）
12. Toggle disabled 叠加 phase 行 opacity .5 的叠乘观感

## 4. 文档漂移（顺手记）

- `docs/git-graph.md` §3 过期：ROW_HEIGHT 26→30、graph cell 84→gw+6、author 120→110、date 60→80、sha 11→12、CDV_H 224→218、Commit/Parents/Committer 元行已移除
- `prototype-react-diff.md` 手验清单「红绿灯让位 71px」已分代 71/78（Darwin≥25 Tahoe=78）
- 子代理报告勘误（主代理复核）：① placeholder 色某代理报「MATCH（实现显式 muted）」有误——已核实 `input.rs:1387` 硬编码 `rgba(0x8f8f8fff)` 无 JS 面可覆写（S7 成立）；② markdown 块距方向一处报告写反，正确方向见 §2 surfaces 节；③ st-card 末行边一处报 MATCH，核实 `SettingRow.tsx:152` 为无条件 `borderBottomWidth:1`（DIFF 成立）
- `git-graph-v2.md` 光学参数 ROW_HEIGHT=26 与 React 基线 30 冲突——以 React 基线为准
- `Toast.tsx:41` 注释「原型 4s」有误（proto 2600ms）
- IconButton 头注「原型 .icon-btn」——原型类名实为 `.ibtn`
- RangeInput 头注「原型 180px 轨道 + 38px」与 proto 实际 200/44 不符

## 5. 建议修复优先级（汇总各模块 ✦）

> 2026-09-22 首批已修（详见 TODOLIST 当日日志）：P0 全部三项、P1 全部六项、
> P2 中「抽屉右缘阴影 / ws-row 双击守卫 / RangeInput px」三项。
> 2026-10-11 续修：P3 中「↑↓ 穿透」（早已由 GitGraphView `keyConsumed.mark()` 修好，经核对确认）与 GitGraph 行/ref chip 中键守卫（`isRightClick`，无测试覆盖）。
> 未动：P2 tooltip 文案策略、P3 菜单锚定与 placeholder 色与窄屏/退出条/followTail、§3 十二项待裁决。

| 序 | 项 | 影响面 | 修复成本 |
|---|---|---|---|
| P0 | GitGraph `TAB_H` 多扣 30px 底部死区 | git 整页/会话内 git 视图 | 一行 |
| P0 | Select 浮层底色 `#1A1A1A` + 缺左右 padding + 项 26/r4 | 全部下拉（ToolDialog 工作区选择、设置 Select、字体） | Select/SearchSelect 各几行 |
| P0 | Esc 连坐关 Modal | ToolDialog 内下拉场景 | Modal Esc 分支查 keyConsumed |
| P1 | IconButton hover 底/图标提亮/radius | 侧栏 3 钮 + WorkPanel + Git 工具条 + 设置 | 组件级一处 |
| P1 | st-card 末行 1px 残留边 | 设置每卡 | last-child 判断 |
| P1 | ToolDialog 未归属态 ACP 行被 gate + 组标悬空 | 未归属新建会话 | 行级条件 |
| P1 | markdown inline code 紫 `#c4b5fd` | chat/acp 消息面 | MD_THEME 一行 |
| P1 | find input autoFocus + ⇧Enter 反向 + 菜单 ↑↓ 穿透 | git 图交互 | 小 |
| P1 | 角标/红点尺寸（S3 border-box 误读） | 侧栏每行 | 改尺寸常量 |
| P2 | tooltip/label 整片缺失（S2） | 顶栏+侧栏 | 需定文案策略（按平台拼快捷键） |
| P2 | 抽屉右缘阴影 | 窄窗 | 一行 |
| P2 | 双击 ws-row 守卫 | 侧栏 | 一行 |
| P2 | RangeInput `px` 后缀 | 设置三行 | format prop |
| P3 | 菜单锚定（§3 第 5 条待裁决）；↑↓ 穿透与 GitGraph 中键守卫已修（2026-10-11） | 全部浮层菜单 | 中 |
| P3 | placeholder 色 | 全部输入 | 需 gpuix 补丁或登记已知差异 |
| P3 | 窄屏 settings 断点、退出条形态、followTail 语义 | 边角 | 中 |
