//! Git 数据层（对应旧 `git/{types,cli,graph}.ts`）：
//! - [`types`]：域类型（零 IO）
//! - [`parse`]：`git` 输出解析 + 流式行缓冲（零 IO，文本进文本出，可直接测）
//! - [`graph`]：lane 分配状态机（Zed `git_graph.rs` 的移植）
//! - [`store`]：GitGraphStore 同步状态机（begin/finish + 代际 ticket 防迟到回调）
//! - [`format`] / [`actions`]：`%D` 装饰、相对时间、变更文件树；右键菜单 → argv 与派发规则
//! - [`cli`]：真进程边界（`std::process`；只有这一个文件起子进程）

pub mod actions;
pub mod cli;
pub mod format;
pub mod geometry;
pub mod graph;
pub mod parse;
pub mod store;
pub mod types;

pub use graph::{CommitLine, GitGraphData, GraphRow, LaneSegment, UNSET};
pub use store::{DetailRequest, GitGraphStatus, GitGraphStore, MountPlan, RootPlan, Ticket};
pub use parse::{LineBuffer, parse_branches, parse_changed_files, parse_log_line, parse_status_entries};
pub use types::{ChangedFile, GitBranch, GraphCommit, WorktreeFile, WorktreeFileKind, WorktreeStatus};
