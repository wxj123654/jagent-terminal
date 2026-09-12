# Codex 侧栏裁剪方案 C（折中）原型 v2

入口：[codex-sidebar-v2.html](./codex-sidebar-v2.html)。独立单文件，无 CDN、无新增依赖，浏览器直接打开。

> 从 `codex-sidebar-v1.html`（全量 Codex 逻辑）裁剪定稿：保留 Codex 的「操作逻辑」精华，去掉「平台功能」外壳。与 `desktop-plane-v2.html`（现有侧栏）并存对比。

## 与现有侧栏（desktop-plane-v2）的差异

| 维度 | 现有（v2） | 本页（方案 C） |
|---|---|---|
| 顶部 | 图标条（收起/＋/搜索） | nav 行组：全宽文字行 New chat / Search |
| 会话区 | 「会话」区（无归属）+ 工作区时间分组 | 无独立会话区——无归属会话归入「未归属」项目组 |
| 组内排序 | 时间分组（今天/昨天/本周/更早）+ 创建序 | **priority**：pin > running > queued > unread > recency |
| 组内截断 | 10 条 + 展开其余 | 4 条 + Show more/less；**active/focus 行不被截断** |
| 未读 | 仅 hasBell 瞬态 | 一等状态：unread 加粗 + 状态点 + 菜单 Mark as unread |
| pin | 无 | 会话 + 项目均可 pin 置顶 |
| 行级操作 | 「…」→ 管理弹窗 | 「…」+ **右键**同一面菜单：Pin / Rename / Mark as unread / Remove |
| 收起 | ⌘B 整列隐藏 | 同（整列隐藏，无 icon rail） |
| 项目行 | 点名=切项目、箭头=折叠、hover ＋/… | 同语义保留 + pin 项目 + 当前工作区 5px 点 |

## 去掉的 Codex 特性（项目无对应功能）

- **Automations / Plugins** nav 行 —— 无自动化/插件系统
- **Archive**（软删除 + ⌃⇧A + Show archived）—— threads 重启即死、无持久层；移除 = 关闭
- **Copy link / Open in new window** —— 无剪贴板 seam、单窗口应用
- **Move to project / Add to section** —— 未实现占位项，交互复杂收益低
- **icon rail / roving tabindex / ⌘1–9 / attention 徽标** —— Phase 2 可选增强，非核心
- **账户行** —— 无账户系统；脚部 = 设置 + 通知铃（对齐现有 Sidebar）

## 操作逻辑要点

1. **行内 hover 「…」+ 右键同一面菜单**；快捷槽占位防位移。
2. **打开即已读**：点击会话清除 unread；菜单可手动标回未读（待办语义）。
3. **项目行**：箭头 = 仅折叠；点名 = 切项目（激活其最高优先级会话）；hover ＋/…。
4. **Rename 弹窗**（`<dialog>`）：Enter 提交，Esc/Cancel/点 backdrop 取消。
5. **⌘B** 收起整列；**Esc** 关菜单。
6. **active/focus 行不被截断**：自动扩展 lim 包含它。
7. **新建会话**（nav 行 / 项目行 ＋）→ 进「未归属」组或目标项目。

## 保持的硬约束

- 配色不动：全部沿用 `--g*` token 与 hover/active/cur 色阶。
- 点项目名 = 切项目；点箭头 = 仅折叠，两操作分离。
- 行 hover 按钮槽位常驻、opacity 切换，不推位移。
- 原生落地仍走现有 PTY + `<terminal>`；本页 DOM 只是交互示意。

## 已知简化（原型级）

- 数据为内存示例；刷新还原。pin/unread 不持久化。
- 搜索/新建走占位（正式实现 = SearchDialog / ToolDialog）。
- 无浅色主题；无响应式断点。

## 落地映射注意点

- `Thread` 加 `unread?: boolean` + `pin?: boolean`；activate 时清 unread（与 hasBell 同处）。
- `workspaces.ts` 的 `timeGroupsOf` 可保留但侧栏改走 `sortThreads`（pin > status > unread > createdAt）。
- 侧栏头从 SidebarHeader 图标条改 nav 行组；「会话」区去掉，无归属会话归入「未归属」工作区组。
- 右键菜单：ThreadRow 加 `onAuxClick` → anchored 菜单（参照 GitGraphView:806 模式）。
- 「active 行不被截断」：排序 + 截断联合逻辑（lim 扩展包含 active/focus 行）。
