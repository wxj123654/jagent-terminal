# 工作区与 TUI 会话原型

入口：[workspace-plane.html](./workspace-plane.html)。独立单文件，无 CDN、无新增依赖，直接用浏览器打开。

> 这是待评审的工作区方案，不修改已有原生应用，也不替代 `docs/agent-plane-layout.md` 的已拍板实现契约。

## 体验路径

1. 在左侧点击 `jagent-terminal`、`website` 或 `playground`，切换项目；点击箭头仅展开 / 收起分组。
2. 点击会话进入其工具；返回工作区时恢复该项目上次打开的会话。
3. 点击工作区右侧 `＋`，选择 pi、Claude Code、Codex CLI、Shell、lazygit、yazi、btop 或自定义命令。菜单会明确展示目标工作区与 cwd。
4. 顶部「新建会话」作用于当前工作区；「搜索会话」跨工作区搜索标题、工具和目录。
5. 从工作区标题旁的文件夹加号添加示例项目。空工作区默认引导创建 pi 会话。
6. 会话旁 `…` 可重命名或移除；最后一个会话被移除后回到工作区起始页。

## TUI 演示

- **pi / AI 工具**：普通终端文字、工具调用片段及工具自身输入区。不新增应用级聊天框。输入可以提交，但只返回明确标注的演示提示。
- **lazygit**：点击文件或按上下方向键切换示例 diff。
- **yazi**：点击文件或按上下方向键切换示例预览；左列项目可打开对应工作区的 yazi 会话。
- **btop**：静态系统监控示例；明确区分「启动目录」与「全系统监控范围」。
- **Shell**：浏览器内模拟 `pwd`、`ls`、`echo`、`clear`、`help`；不执行任意系统命令。
- **自定义命令**：保存名称和命令字符串，显示其工作区上下文，不安装或运行命令。

## 保持的约束

- 右侧始终只有一个内容区；不增加标签栏、分屏或第二套聊天交互。
- 切换会话保留示例输入草稿、已提交内容和文件选择；刷新页面恢复初始数据。
- 铃铛仅表示示例 BEL 通知，打开会话后清除；不推断工具的思考 / 执行状态。
- HTML 只用于原型。未来原生落地仍使用现有 PTY 和 `<terminal>`，不能把本页 DOM 当作终端仿真实现。
- 演示目录、输出、Git 变更和监控数值均非真实系统数据，无文件读取、模型调用或网络请求。

## 键盘与窗口

- 原生按钮支持 Tab、Enter、Space；弹窗使用浏览器 `<dialog>`，Esc 可退出。
- `⌘K / Ctrl K` 打开搜索；终端输入框内保留 Ctrl 键组合，避免覆盖 TUI 输入。
- 终端输入区 Enter 提交、Shift+Enter 换行；中文输入法组合阶段 Enter 不提交。
- 桌面侧栏 276px，紧凑窗口 250px；760px 以下以可关闭的工作区抽屉呈现。
- 尊重 reduced-motion；本轮仅提供深色方案，不宣称完整 WCAG 或读屏认证。

## 验证

`workspace-plane.test.mjs` 复用环境中已有的 Playwright 和 Chrome，不往仓库引入依赖：

```sh
# 如果当前 Node 环境能解析 playwright：
node design/workspace-plane.test.mjs

# 或显式指定现有安装的入口：
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node design/workspace-plane.test.mjs

# 只测交互，不重新截图：
CAPTURE=0 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node design/workspace-plane.test.mjs
```

默认产物位于 gitignore 的 `.pi/workspace-prototype/review/`，也可通过 `ARTIFACT_DIR` 指定目录。

已覆盖 10 组浏览器交互检查：工作区归属、恢复最近会话、BEL 清除、草稿保留、工具筛选、自定义命令、目录校验、输入转义、中文组合输入、重命名 / 搜索 / 移除及窄窗口抽屉。截图覆盖 1440×960、1024×768、390×844 和各工具关键状态。

独立 reviewer 代行未配置的 finish-reviewer，检查上述 9 张截图、交互源码和测试记录，结论为 **ship**，未列出材料级缺陷；结论仅针对本轮可交互原型，不是原生终端或完整辅助技术认证。设计记录由主任务根据最终界面提取到 `DESIGN.md` 与 `.impeccable/design.json`。

项目 `.oxfmtrc.json` 排除了 `design/`，所以原型不在现有格式化验收范围。Impeccable 检测器因缺少 HTML parser 降级为 regex，本轮不以其空结果宣称全面通过；主要文字颜色另做计算（最弱常用组合：次级文字 / 选中背景约 4.76:1）。
