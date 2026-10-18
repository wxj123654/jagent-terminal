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
- [x] **V2（2026-10-14）**：顶栏分支钮（render 期 cwd 比对触发异步 `list_worktree_status`，
      代际防串）+ Git 菜单浮层（打开 Git 图 / 查看变更）；WorkPanel 右栏集成（≥1100
      h_resizable 可拖 / <1100 右缘浮层 / <760 窄屏叠加，panelRight+showSearch 钮，
      ensure_panel 惰性建实体复用）+ WorkPanel 按原型重对齐（头 44/ptab/file-row h32/
      diff 配色/「文件」页真实预览 read_preview_lines）；通知中心浮层 notif_center.rs
      （bell_popover 锚侧栏脚铃铛 D8，notices 真实事件流，rel_time 分档，全部已读/跳转）
- [x] **V3（2026-10-14）**：Git 图表面对齐——lane 线 SVG 化（geometry 已在 core，新增
      build_row_svg_pieces 按 colorIdx 聚合单色 path + 贝塞尔 C 段 + HEAD 空心圆点）；
      ref 徽标 git_ref_badges.rs（chip 色图/show_remote 过滤/右键→core 菜单）；分支下拉
      （.branch-pop）；右键操作菜单 git_context_menu.rs（confirm/prompt 380 宽弹窗，
      danger 红字）
- [x] **V4（2026-10-14）**：设置页整面重对齐——左 nav 218（品牌头/搜索框/7 分区/命中徽章）
      + srow 行 + 键位表 + 预设/ACP 折叠卡 + 高级诊断卡；settings_defs.rs（13 项
      SETTING_DEFS/section_hits/hl_range 高亮）+ settings_controls.rs（Toggle/Select/
      Number/Range/FontSelect 弹层搜索+键盘导航+字身预览/focus_ring）；打开聚焦搜索；
      「在编辑器打开」（core Effects::open_path → GuiEffects 记账 → flush spawn）
- [x] **V5（2026-10-14）**：统一浮层系统 popup.rs（overlay_shell R9 壳 + PopupTrigger
      Selectable 薄适配走 Popover 公开 API，trigger_with 退役；menu_popover/ctx-item
      danger 红）＋收编 bell/branch/工作区/…菜单/AddPopover/FontSelect；…菜单左键弹
      （MenuTarget 受控态）；AddPopover（打开 Git 图/新建 Shell/打开文件列表→面板文件页）；
      窄屏抽屉滑入动画（drawer_ease = cubic-bezier(.2,.8,.2,1) 端点恒等 + with_animation）
- [x] **V6（2026-10-15）**：会话面重对齐（conv-head 44/760 居中列/user 气泡/markdown/
      composer 704 r12 shell/34² accent 箭头钮）；空态 home-card 全件（empty_presets.rs
      680 渐变卡/grid 2 列 pill/窄态翻转）；侧栏+面板分隔条把手 hover accent 25% 竖条
      （with_handle_appearance）；逐面像素复查 = 视觉三件套 + 布局常量测试锁死
- [x] **V7（2026-10-16）输入控件打磨**：`views/field.rs` 统一文本输入外壳（30 高 / r8 /
      inputBg / 12px，mono 变体给命令路径类字段；收编添加工作区 / 重命名 / Git prompt /
      预设·ACP 编辑卡）；主题 radius 8 / radius.lg 12 对齐原型；SelectField 改 RenderOnce
      （Tab 可聚焦 + 焦点环、Enter/Space/↓ 开、↑↓ 循环高亮 + hover 同步、Enter 提交、Esc
      关、焦点归还触发器；菜单与触发器同宽；行 30 高 r6）+ 3 个 gpui 测试锁键盘契约；
      NumberInput 96 宽 + mono + 步进分隔线（修 scrollback「100(」截断）；Toggle 关态对比度
      提升 + toggle/range 进 Tab 循环；预设卡按原型改两列网格 + placeholder；设置遮罩
      `occlude()`（修点 nav 穿透到下层侧栏行、设置被关）；`v_shots` 新增 `v_inputs` 巡检
      5 张（i_preset/i_terminal/i_appearance/i_select/i_wsdialog，`ONLY_INPUTS=1` 单跑）
- 基建（同轮）：**PTY reader 线程泄漏修复**（jagent-terminal/pty.rs：PtySender 持 join
  动作，shutdown 后 join 线程；join 返回值 mem::forget 防 Pty::drop 的 waitpid 阻塞；
  state 测试收尾显式 close_thread）——此前 ~20% 概率 gpui test scheduler 判非确定性

**V 轮执行方式**：V2/V3/V4/V5 四个并行 subagent 实现（V3/V5 报告超时但代码已落，主会话
收尾 7 个编译错误+4 个断言）；V6b 会话面/空态 subagent；其余主会话。

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

- 2026-10-16 · **修：输入框删不掉字**——`actions::install` 用 `clear_key_bindings()` 清空
      全局键位表，连 gpui-component 输入框的 backspace/delete/方向键/cmd-a 一起抹掉（打字走
      IME 通道不受影响，所以「能输入删不掉」）。改为只替换 `jagent::` 动作、保留库绑定；
      2 个回归测试（重装后库键位仍在 + 真实 Input 里 backspace 删字）
- 2026-10-16 · **V7 输入控件打磨**（见进度 V7）· 已知：`state::tests::spawning_a_preset…`
      偶发 PTY reader 线程判非确定性（本轮 20+ 次跑中 1 次，基线同测例历史 ~20%→修后罕见），
      非本轮引入 · 下一步：真机手感（Select 键盘、Tab 焦点环、IME 在双列字段）

- 2026-10-15 · **V 轮像素 diff 复核（收官后追加）**：新增视觉测试 `tests/v_shots.rs`
      （harness=false，8 面离屏截图到 target/shots/v/：空态/chat/设置/通知/Git 图/面板/
      AddPopover/窄屏；数据尽量复刻 seed.ts，真 git repo 9 提交含 merge）· 原型 vite 起服
      浏览器截对应 8 面到 target/shots/proto/ · 并排对比页 compare.html 目检结论：**8 面
      结构/布局/配色高度同构**（空态 home-card、会话面气泡/composer、设置页 nav+分区、
      通知浮层 3 条含时间分档、Git 图工具条+徽标+表头、WorkPanel 文件行 M/A/D、
      AddPopover 三段式、窄屏抽屉+遮罩全部对上）· 内容级差异均为预期（sha/±计数/真
      zsh 提示符/工作区 path）· 顺手：root.rs 增 `set_add_popover_open`（测试用受控）
      · 下一步：真窗口手感清单（输入法/拖动手感等，需用户真机）
- 2026-10-15 · **V 轮收官（V2–V6 全部落地）**：多 subagent 并行实现（V2 分支钮/右栏/
      通知浮层、V3 Git 图贝塞尔/徽标/下拉/右键菜单、V4 设置页重写、V5 统一浮层 popup.rs
      +AddPopover+抽屉动画、V6b 会话面/空态）→ 主会话统一收尾（7 编译错+4 断言+
      AddPopover 文件区+把手 accent）· 顺手修 PTY reader 线程泄漏 flaky（pty.rs join+
      mem::forget，state 测试收尾 close_thread；此前 ~20% 概率炸 test scheduler）·
      clippy 机械项清零（type 别名收编 14 条 complex type）· gate：check/test
      --workspace 全绿（app 133 + core 271 + terminal 41 + 集成 4）+ 视觉三件套 OK
      （SHELL/NESTED_SCROLL/TERMINAL_SETTINGS）+ shell 截图目检无异常 · 下一步：真窗口
      手感清单（见下）、V 轮逐面真浏览器↔截图像素 diff（当前为常量断言+目检级）
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
