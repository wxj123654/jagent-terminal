//! jagent-core：不依赖 gpui 的纯逻辑。普通 `#[test]` 即可覆盖，编译快。
//!
//! - [`settings`]：设置 schema（字段级容错、未知键保留）、store（合并写+回滚）、file（原子写）
//! - [`acp`]：ACP 协议层（行分隔 JSON-RPC 编解码 + turn 状态机；进程 IO 在 jagent-app）
//! - [`git`]：git 数据层（cli 进程边界 / 解析 / lane 状态机 / 图状态 / 几何）
//! - [`new_session`]：新建会话弹窗的数据模型（分组 / 筛选 / 归属约束）
//! - [`presets`]：内置/自定义预设 CRUD 规则
//! - [`threads`]：会话域规则（store / model / workspaces / conversation）
//!
//! 迁移前的 React 实现与其测试是这些规则的历史规格，见 git 历史
//! （`aadecd4` 及之前的 `packages/app/src/**`）。

pub mod acp;
pub mod git;
pub mod new_session;
pub mod presets;
pub mod settings;
pub mod threads;
