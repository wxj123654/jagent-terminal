# Git Graph v2 原型

入口：[git-graph-v2.html](./git-graph-v2.html)。独立单文件，无 CDN、无新增依赖，浏览器直接打开。

> HTML 原型仍可打开对照。原生落地见 `packages/app/src/git/*`（G4）：行内 CDV、右键 git actions、find、mute、表头。一期右侧 diff 列已替换为行内展开。

## 调研结论（先读这个）

### `git-graph` crate（mlange-42，crates.io 0.8.0）——不能作为支撑

| 维度 | 事实 |
|---|---|
| 渲染目标 | 终端字符网格（ASCII/Unicode 字符画），不是 GUI 的 lane/segment 位置数据 |
| 硬限制 | 不支持 octopus merge（>2 parents）；依赖 merge commit 的 **summary 原文**判断分支归属（message 被 squash/改写即失效）；只认 `origin` |
| 卖点 | branching model 感知的 lane 分组（GitFlow 等）——CLI 可读性优化，观感与 vscode-git-graph 不同 |

现有 `packages/app/src/git/graph.ts`（Zed lane 算法的 TS 同构移植）在布局能力和视觉风格上都更贴近 vscode-git-graph。**不要引入该 crate。**

### git 操作不需要任何 crate

核实了 mhutchie/vscode-git-graph 的 `src/dataSource.ts`（~1924 行）：checkout / merge / rebase / cherry-pick / drop / revert / tag / branch / fetch / pull / push **全部 `runGitCommand(['checkout', …])` spawn git CLI**，没有 libgit2/nodegit。Zed 同样如此。这与现有 `cli.ts`（Bun.spawn）架构同构——做 git actions 只是往 `cli.ts` 加命令封装，零新依赖。

### 若未来仍想 Rust 化

正确路线是 `git2-rs` 或 `gitoxide(gix)` 的 revwalk + 把 `graph.ts` 移回 Rust，而不是 git-graph crate。当前瓶颈在 UI 渲染不在数据层（流式已做好），一期不建议。

## 体验路径

1. 默认选中 `Merge branch 'feat/ime'`，行下方展开 **summary + 文件树** 分栏；图线穿过 Graph 列空槽，不盖文字。
2. 再点同一行关闭详情；点其他行切换。
3. 右键提交行 → checkout / cherry-pick / drop / merge / rebase / reset / 建分支 / 打标签（toast 模拟 `git …` 命令，不真执行）。
4. 右键 `feat/ime` / `origin/feat/ime` / `v0.2.0` 徽章 → 对应分支 / 远程 / 标签菜单。
5. 控件条「分支 ▾」检出；「显示远程分支」开关隐藏 `origin/*` 徽章。
6. ⌘F / 放大镜：按哈希或提交信息查找，Enter / ⇧Enter 跳转并 flash。
7. 表头 Description / Author / Date / Sha 右缘拖列宽。
8. hover 圆点看 tooltip（sha + subject + refs）。
9. 点击 Sha 列复制（toast）。点击详情里的父提交哈希跳转。

## 与现有实现的差距（落地清单）

现有 G1–G3：流式 `git log` + Zed lane + 逐行 SVG + 右侧 360px diff。v2 要补：

| 项 | vscode-git-graph | 现有 | 原型已演示 |
|---|---|---|---|
| 控件条（分支下拉 / 远程开关 / find / fetch / refresh） | ✓ | 仅 repo 名 + count + refresh | ✓ |
| 表头列 + 列宽可拖 | ✓ | 无表头 | ✓ |
| hover / 选中加深 / mute 非线性提交 | ✓ | 无 hover、无 mute | ✓ |
| Ref 徽章（图标色块 + remote 斜体 + HEAD 描边） | ✓ | 圆角文字徽章 | ✓ |
| HEAD 空心圆点 + 描述前 head-dot | ✓ | 实心圆点 | ✓ |
| 行内展开 CDV（summary + 文件树，图线穿过） | ✓ | 右侧栏 | ✓ |
| 右键 git actions | ✓ | 无 | ✓（toast 模拟） |
| 圆点 tooltip / find + flash | ✓ | 无 | ✓ |
| 图线 shadow 分离层 | ✓ | 无（逐行 svg 单色） | ✓（整列 SVG） |

落地时注意：

- **数据层保持 JS spawn git CLI**，不引入 git-graph crate，不改 `packages/native`。
- 行内展开会把后续行整体下移——GPUI 的 `<virtual-list>` 定高模型需要改：选中行占用 `ROW_HEIGHT + CDV_H`，或 CDV 不进 list、叠在选中行下方（更接近 vgg 的 table 插入行）。
- 整列 SVG 与现有逐行 `<svg source>` 不同。GPUI 没有 CSS stacking context，跨行连贯的 shadow 层更适合一张 canvas/svg 盖在 list 上，按 scrollTop 平移；或继续逐行画、接受交叉处无 shadow。
- git actions 的真实执行 = `cli.ts` 加 `runGit(args)`，成功后 `store.refresh()`。危险操作（reset --hard / drop / 删分支）要确认对话框。
- 文件树需要新命令：`git show --name-status --format=` 或 `git diff-tree --no-commit-id --name-status -r <sha>`，不再只 `git show --patch`。

## 光学参数（与现有 graphSvg.ts 对齐）

`ROW_HEIGHT=26` · `LANE_WIDTH=13` · `PAD_X=8`（原型略宽于生产的 3，给徽章留空）· `CIRCLE_RADIUS=3.5` · 线宽 1.6 · HEAD 空心（fill=pane, stroke=lane 2px）· 普通点 fill=lane + pane 描边 2px · shadow path stroke=pane width 5。

色板：`GRAPH_LANE_COLORS`（One Dark 8 色轮转）。

## 保持的约束

- HTML 只用于原型。落地仍走 `packages/app/src/git/*` + gpuix，不把本页 DOM 当 GPUI 实现。
- 演示提交、diff 统计、签名状态均非真实仓库数据；菜单命令只 toast，不 spawn git。
- 尊重现有分层：`git/cli.ts` 是唯一进程边界；`graph.ts` 零 IO。
