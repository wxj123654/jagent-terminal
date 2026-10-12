//! jagent-core：不依赖 gpui 的纯逻辑。普通 `#[test]` 即可覆盖，编译快。
//!
//! 对应旧 TS 实现：
//! - [`settings`]：`settings/schema.ts` + `store.ts` + `file.ts`
//! - [`acp`]：`threads/acp.ts` 的协议层（行分隔 JSON-RPC 编解码 + turn 状态机；进程 IO 在 jagent-app）
//! - [`git`]：`git/{types,cli,graph}.ts`（解析 / lane 状态机 / 进程边界）
//! - [`new_session`]：新建会话弹窗的数据模型（分组 / 筛选 / 归属约束）
//! - [`presets`]：`threads/presets.ts`
//! - [`threads`]：`threads/{store,workspaces,chat,terminal}.ts` + `internal/*`
//!
//! 规格来源是旧 TS 代码与它的测试（`packages/app/src/**/__tests__`），P8 删除旧代码前以其为准。

pub mod acp;
pub mod git;
pub mod new_session;
pub mod presets;
pub mod settings;
pub mod threads;
