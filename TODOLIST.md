# j-agent TODOLIST（会话接力文件）

> **给下一个 session 的说明**：本文件是跨会话实施看板。开工前先读本文件 +
> `docs/architecture.md`（当前架构契约），做完一块就更新本文件（勾选 + 文末
> 「会话日志」追加一行）。需要对照旧 React 版行为时去 git 历史（`aadecd4` 及
> 之前的 `packages/`、`docs/`），不在工作树维护两份。

## 环境事实

- macOS（darwin 27, arm64）；工作目录 `~/Documents/jagent-terminal`
- Rust 工具链 pin **1.97.1**（rust-toolchain.toml + CI）；本机 `stable` 恰为同版本
  - ⚠️ `~/.rustup/toolchains/` 属主是 root（历史 sudo 遗留），rustup 无法安装新工具链；
    本机跑命令用 `RUSTUP_TOOLCHAIN=stable` 前缀。修复需用户手动
    `sudo chown -R wxj:staff ~/.rustup`
- 视觉测试（shell_shot/nested_scroll/terminal_settings，harness=false）在沙箱内
  SIGTRAP，须在用户终端跑；沙箱内跑 cargo 需 dangerouslyDisableSandbox（写 ~/.rustup、target/）

## 文档索引

| 文档 | 内容 |
|---|---|
| `docs/architecture.md` | **当前架构契约**：三 crate 分层、Effects 注入、视图范式约定、测试面、明确不做清单 |
| `docs/gpui-rewrite.md` | React → Rust 重写全记录：决策、P0–P8 各阶段证据与偏差（历史文档，不再更新进度） |
| `docs/p0-results.md` | 依赖核实（gpui-pre 0.3.8 / gpui-component 0.7.1）与 spike 实验结论（E1–E9） |
| `CONTEXT.md` | 领域词汇表（Thread/Workspace/SessionView/Effects/sidecar…） |
| `design/DESIGN.md` `design/PRODUCT.md` | 设计说明与产品定义 |

## 进度

**V 轮（原型像素对齐，进行中——用户要求：和 React 原型一模一样，同 gpuix R1–R12 标准）**

参照物已恢复并跑通（`/.archive/`，已 gitignore，从 git 历史提取）：
- 原型 `design/prototype-react`（React+Vite，`bun run dev` → localhost:5173）
- gpuix 达标实现 `packages/`（8df091c，含 tokens.ts / plane / sidebar / ui 全源码）
- 对齐方法：浏览器截原型 ↔ Rust `shell_shot` 离屏截图（1100×700）像素对比，
  gpuix TSX 为「原型→gpui 翻译」的样式字典

- [x] **V1（2026-10-12）**：icons.rs（lucide 全集，`svg().data` 内联 + text_color tint）；
      顶栏两行（TitleBar 44px 上下文块 + 全宽 tb-tabs 38px，SessionTabs/ContextTab 上移）；
      侧栏全件（头 46 收起钮 / nav 新建+搜索 / 区头工作区+ghost ＋ / 工作区分组 folder+acts /
      ThreadRow kind tile+状态角标+pin+…槽 / 未归属虚拟组 / more-link / 脚齿轮铃铛版本号）；
      工作区菜单（置顶/重命名/移除）+ RenameTarget 泛化；RowDot 语义修正（D12：terminal 存活
      无点，bell=紫 need，chat pendingReply=橙 running）；tab 中键关闭
- [ ] **V2**：顶栏分支钮（需异步 branch 查询）+ Git 菜单浮层；WorkPanel 右栏集成（root 布局
      + panelRight 钮 + <1100 浮层）；通知中心浮层（铃铛锚定 D8）
- [ ] **V3**：Git 图表面对齐（lane 贝塞尔弯线、ref 徽标、分支下拉、右键操作菜单+危险确认）
- [ ] **V4**：设置页逐行对齐（打开聚焦搜索、字体系统选择器、搜索 label 高亮/计数、
      焦点环、「在编辑器打开」）
- [ ] **V5**：统一浮层系统（…菜单左键弹、ToolMenu「+」浮层、AddPopover、notif；
      PopupMenuItem danger 红字）；窄屏抽屉滑入动画
- [ ] **V6**：空态/会话面对齐；侧栏右缘拖拽把手 hover accent 线；逐面像素复查

**gpui 重写 P0–P8 全部完成**（2026-10-12 收官）。三 crate、386+ 测试、
watchdog/sidecar、三平台 CI 就绪。剩余待办全部是真机验证与可选项：

- [ ] **三平台真机中文输入法**（P4 遗留硬前置）：候选窗定位、预编辑下划线、
      Windows 字符重复、Linux X11 Fcitx、Enter 提交后是否多换行
- [ ] **Windows / Linux 编译与真机启动**：CI rust-release.yml 远端矩阵未实跑过；
      Windows PE 图标校验脚本仅 Windows runner 能跑
- [ ] **真窗口手感**：标题栏拖动/双击缩放/红绿灯让位（macOS）、侧栏拖宽真实
      鼠标拖动（当前只测落盘路径）、窄屏抽屉、分隔条跟手度
- [ ] **1 万提交真窗口（含 GPU）帧耗时**：E7/P5 的 <1ms 不含 GPU 呈现
- [ ] **流式 markdown 增量重解析性能**（长回复 + 官方 agent 大文档实测）
- [ ] macOS Finder 启动 `.app` 验证；正式 Developer ID 签名/公证（当前 ad-hoc）
- [ ] 环境修复：`~/.rustup` root 属主（见上）

**可选重开项**（重写时明确砍掉，做前先立设计）：FileSurface 文件浏览、原生
目录选择器（添加工作区「浏览…」）、Git 危险操作确认菜单、独立全局错误面板、
Git 图贝塞尔弯线、桌面通知真实弹出（Effects::notify 目前只记账）、minidump
崩溃捕获。

## 硬约束速查（违反 = 返工）

1. gpui 系列精确锁定（=0.3.8 / =0.7.1），同一工程只允许一份 gpui，升级整体进行（AGENTS.md 规则 5）
2. 规则在 `jagent-core`，视图在 `jagent-app`；core 不 import gpui
3. core 新副作用必须走 `Effects` trait，不得直接碰进程/时钟/文件
4. settings.json / state.json 与旧版互读兼容（未知键往返保留，有回归测试）
5. 定宽单行列三件套：`overflow_hidden` + `whitespace_nowrap` + `text_ellipsis`
6. 嵌套滚动统一走 `views/nested_scroll` 封装，不裸写 on_scroll_wheel
7. 引依赖先联网核实版本（AGENTS.md 规则 1–4）
8. 虚拟列表用 gpui `list`/`uniform_list`（+`FollowMode::Tail`），不用 gpui-component VirtualList

## 会话日志（每 session 追加一行：日期 · 做了什么 · 下一步）

- 2026-10-12 · **V1 原型对齐轮开跑（顶栏+侧栏）**：用户判定 P0–P7 迁移与原型差距过大，
  重启逐面对齐 · 恢复参照物到 /.archive/（原型 vite 可跑 + gpuix TS 源码）·
  icons.rs lucide 全集 · 顶栏两行 + 侧栏全件 + SessionTabs/ContextTab 原型形态 ·
  工作区菜单/RenameTarget/RowDot 语义修正/tab 中键关闭 · gate：workspace 测试全绿
  （app 80 + core 270 + terminal 41 + sidecar/watchdog）+ shell_shot SHELL OK +
  clippy 机械项清零 · 下一步：V2（分支钮/WorkPanel/通知浮层）
- 2026-10-12 · **P8 清理收官（gpui 重写全部完成）**：先提交 P0–P7 全量成果为
  安全点（044bd9f，119 文件），再删除旧 TS 链——packages/、e2e/、patches/、
  scripts/ 的 bun/PE/refs 脚本、package.json/bun.lock、旧 CI build.yml、
  design/ 原型（留 DESIGN.md/PRODUCT.md）、八个旧契约文档、oxlint/oxfmt 配置、
  gpuix-usage skill；本地清 .refs/(299M)/node_modules/dist/.shots/spikes ·
  重写 README / TODOLIST / docs/architecture.md / CONTEXT.md 为 Rust 工作区
  语境；.gitignore/Cargo.toml（去 exclude）/jagent-core lib.rs 注释同步 ·
  gate：cargo check/build/test --workspace 全绿（core 270 + terminal 41 +
  app 75 + sidecar/watchdog/视觉 5）· 下一步：真机验证清单（见上）
- 2026-10-12 · **全面校验轮**：clippy 首跑（0 error）——自动修 10 文件 +
  修 `#[test]` 重复属性（input.rs：ctrl_tab 曾被 libtest 注册两次，41 里有
  重复；救活从未运行的 test_ctrl_combinations，现在 41 个全唯一）+ doc 缩进
  5 处；剩 9 条判断性警告（too many args ×3 / complex type ×5 / 测试断言
  风格 ×1）有意保留 · fmt 归一 clippy 分歧 · 文档-代码一致性：13 个 Action、
  全部模块/类型/函数锚点、README/TODOLIST 路径逐一命中；修正 SETTING_DEFS
  幽灵引用（旧 TS 名，Rust 是 schema.rs 结构体 + parse/serialize）· 残留
  引用全扫：只剩历史陈述（指向 aadecd4）· 发布链冒烟全过：release 构建、
  --version、--watchdog-smoke（crash-loop 截止）、--watchdog-normal-smoke
  （exit 0）、package-macos-app.sh（codesign+plutil+新图标路径）· CI 引用的
  两个脚本在位 · gate：clippy 0 error、fmt clean、test --workspace 全绿
  （75/1/2 + 视觉 3 OK + 270 + 41 唯一）
