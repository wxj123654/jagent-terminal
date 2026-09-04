# patches/ — gpuix / zed 本地补丁系列（quilt 风格）

`.refs/` 是浅克隆的上游仓库（gitignore，可随时删除重建），所有本地修改以
patch 文件形式**版本化在本目录**。上游 pin commit + 本补丁系列 = 可复现的
本地依赖（OpenWRT/nixpkgs 的 quilt 模式）。

## 命令

```bash
bun run setup-refs              # .refs/gpuix 重建：clone → pin → 补丁 → dist（幂等）
bun run setup-refs -- --force   # 删除重建
bun run export-patches          # .refs 工作树改动 → 重写 patch 文件
bun run export-patches -- --check  # 只校验一致（CI/提交前用）
```

## 补丁清单

### gpuix/（主仓 pin `e948b20` @ remorses/gpuix）

| patch | 内容 | 对应 TODOLIST 记录 |
|---|---|---|
| `0001-shallow-submodule.patch` | `.gitmodules` zed `shallow = true` | 杂项 |
| `0002-jagent-native-seam.patch` | ① `custom_elements/mod.rs`：`GLOBAL_FACTORIES` 进程级工厂表 + `register_global_factory`，宿主 napi crate 装载期注册、`with_defaults` drain；② `lib.rs`：`pub mod custom_elements` + `run_on_test_app` 条件 re-export；③ `renderer.rs`：`host_ui_commands_ready()`（探测线程化通道存活）；④ `test_renderer.rs`：`run_on_test_app()`（host 闭包直跑本线程 VisualTestState，bun test 单线程 = GPUI 线程往返） | 补丁 #6/#7（e2e seam）+ Phase 1 元素注册 seam |

### gpuix-zed/（zed 子模块 pin `8b94def` @ remorses/zed @gpuix 分支，由 gpuix 仓库记录）

| patch | 内容 | 对应 TODOLIST 记录 |
|---|---|---|
| `0001-gpui-workspace-root.patch` | `gpui/Cargo.toml` 显式 `workspace = "../.."`（gpui 作为 path 依赖被外部 workspace 消费时，`*.workspace = true` 继承的解析根） | Phase 0 结论 |
| `0002-hide-offscreen-test-window.patch` | `visual_test_context.rs`：offscreen 窗口 Windows 上 `show:false`（macOS 保持原样，屏幕外位置天然隐形）；`gpui_windows/window.rs`：show:false 分支用原始 `params.bounds` `SetWindowPos` 应用位置尺寸（不被 `retrieve_window_placement` clamp 污染） | 补丁 #8（test 窗口隐藏化，2026-09-05） |

## 约定

- **分组**：一个源文件恰属一个 patch（见 `scripts/refs-config.ts` 的
  `MANIFEST`）——避免 hunk 级拆分，export-patches 可全自动重写。
- **新补丁**：改 `.refs` 源码 → 测试 → 在 `MANIFEST` 登记新分组（编号顺延）
  → `bun run export-patches` → patch 文件随主仓库 commit。
- **上游 bump**：`setup-refs --force` 之前先更新 `GPUIX_PIN`；`git apply`
  冲突时进 `.refs` 手工合并，再 `export-patches` 刷新。
- patch 只含**工作树对 HEAD 的 diff**（无 staged 中间态）。
- 补丁值得上游化时（如 #8）：`cd .refs/gpuix && git checkout -b fix-xxx &&
  git apply ../..(略) && git commit && push` 到自己的 fork 提 PR。
