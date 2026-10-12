//! 会话：数据模型、工作区纯函数、ThreadStore 规则（对应旧 `threads/*`）。

mod conversation;
mod model;
mod store;
mod workspaces;

pub use conversation::{Conversation, echo_reply};
pub use model::*;
pub use store::{
    ConversationKind, Effects, SendRequest, SessionEvent, SpawnRequest, StoreError, ThreadStore,
};
pub use workspaces::{
    SearchHit, WorkspaceFormError, clear_last_session, default_workspace, parse_workspace_state,
    record_last_session, rel_time, search_threads, serialize_workspace_state, sort_threads,
    sort_workspaces, thread_priority, validate_workspace_form, workspace_sessions,
};

#[cfg(test)]
mod store_tests;
