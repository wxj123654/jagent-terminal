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

- 2026-10-12 · **P8 清理收官（gpui 重写全部完成）**：先提交 P0–P7 全量成果为
  安全点（044bd9f，119 文件），再删除旧 TS 链——packages/、e2e/、patches/、
  scripts/ 的 bun/PE/refs 脚本、package.json/bun.lock、旧 CI build.yml、
  design/ 原型（留 DESIGN.md/PRODUCT.md）、八个旧契约文档、oxlint/oxfmt 配置、
  gpuix-usage skill；本地清 .refs/(299M)/node_modules/dist/.shots/spikes ·
  重写 README / TODOLIST / docs/architecture.md / CONTEXT.md 为 Rust 工作区
  语境；.gitignore/Cargo.toml（去 exclude）/jagent-core lib.rs 注释同步 ·
  gate：cargo check/build/test --workspace 全绿（core 270 + terminal 41 +
  app 75 + sidecar/watchdog/视觉 5）· 下一步：真机验证清单（见上）
