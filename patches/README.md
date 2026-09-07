# patches/ — gpuix / zed 本地补丁系列

`.refs/` 是 gitignore 的上游浅克隆。上游 pin + 本目录补丁 = 可复现的本地依赖。
项目行为优先放在项目代码；这里只保留未开放的原生扩展入口和底层修复。

## 命令与校验

```bash
bun run setup-refs                 # clone → pin → 补丁 → dist；已有 checkout 只检查
bun run setup-refs -- --force      # 删除重建；先检查并备份 .refs 的本地修改
bun run export-patches             # 受管工作树改动 → patch 文件
bun run export-patches -- --check  # 只校验，不写文件
bun test scripts/refs-state.test.ts
```

setup 快速路径检查 gpuix pin、该 commit 中的 zed gitlink、两个仓库的实际 diff
与 patch 一致性、staged／未管理改动、目录中多余的 patch，以及 React 必需的 dist
入口。仅工作树非空不算就位。发现旧补丁残留时拒绝通过，不自动覆盖用户修改。
缺 dist 时可在 `.refs/gpuix` 运行 `bun run build:react`；依赖缺失先 `bun install`。
源码变更后仍须主动重建 dist/native（存在性检查不保证构建产物新鲜）。
export 与 setup 复用 `scripts/refs-state.ts`，导出也拒绝 staged 或未管理改动。

## 剩余补丁（3 份）

### gpuix/（pin `e948b20` @ remorses/gpuix）

`0002-jagent-native-seam.patch` 包含：

- `custom_elements/mod.rs`、`lib.rs`：公开 custom element traits、GpuixView，
  以及进程级工厂注册入口。终端实现本身留在 `packages/native/src/element.rs`。
- `renderer.rs`、`test_renderer.rs`：宿主 App 调度及测试 App 入口。Win/Linux
  用 UI channel，macOS 用当前线程 ApplicationHandle，测试用 VisualTestState。
- `renderer.rs`、`style.rs`：自绘标题栏原生方法及 WindowControlArea 命中支持。
  **本批只迁走 TS 声明，Rust 标题栏实现未迁移。**
- `custom_elements/input.rs`：测量布局使用捕获的文本样式计算行高，而不是取
  已退出元素样式栈的 window 默认行高。caret、选区和 textarea 高度依赖此修复。

### gpuix-zed/（gpuix gitlink pin `8b94def` @ remorses/zed）

| patch | 必要性 |
|---|---|
| `0001-gpui-workspace-root.patch` | gpui Cargo.toml 显式 `workspace = "../.."`，使外部 path 依赖按 zed 根继承 workspace 字段。项目侧替代方案尚未验证。 |
| `0002-hide-offscreen-test-window.patch` | Windows offscreen 测试窗口用 `show:false`，并按原始 bounds 放置隐藏窗口，避免 clamp 和闪窗。macOS 保持上游行为。 |

## 已迁回项目（第一批）

| 原补丁 | 当前实现 |
|---|---|
| gpuix `0001-shallow-submodule.patch` | 删除；setup 显式 `submodule update --init --depth 1 zed`。不再改上游 `.gitmodules`。 |
| gpuix `0003-macos-injected-renderer-frame-loop.patch` | 删除；`packages/app/src/appWindow.ts` 用公开 `startFrameLoop` 泵 macOS AppKit，复用同一 renderer，热重载停止旧循环，窗口关闭退出，`stop()` 清理循环和 React root。 |
| gpuix `0004-window-control-area.patch` | 删除；`packages/app/src/gpuix.d.ts` 用 module augmentation 声明项目原生标题栏类型。 |
| gpuix `0002` 内的 input `vertical_offset` | 删除；单行 measured 文本仍靠 `TextInput`／`NumberInput` 的视觉外壳居中。保留行高修复及 textarea 行高回归测试。 |

后续批次：标题栏迁到项目自定义原生元素；workspace 归属隔离实验；Windows 测试
隐藏替代方案；`GLOBAL_FACTORIES.drain()` 多 renderer 契约（当前第一次
`with_defaults` 后全局表清空）。均**未实施**，不以复制 renderer／样式引擎换取“零 patch”。

## 约定

- 一个源文件恰属一个 patch，映射在 `scripts/refs-config.ts` 的 `MANIFEST`。
  编号保留，不因删除中间补丁重编号。
- 新改动：改 `.refs` → 测试 → MANIFEST 登记 → export → patch 随主仓库提交。
- 删除补丁：先精确反向撤销 `.refs` 对应改动，再删 MANIFEST 条目和 patch，
  重建受影响的 dist/native，最后运行 setup 与 export --check；只删 patch 文件不算迁移。
- patch 仅记录 unstaged 工作树 diff；不要将 `.refs` 修改 stage 后导出。
- 上游 bump 后重新应用、解决冲突并导出；发布上游 PR 是独立任务。
