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
    SearchHit, WorkspaceDirStatus, WorkspaceFormError, clear_last_session, default_workspace,
    discover_suggested_workspace_dirs, expand_workspace_path, inspect_workspace_dir,
    parse_persisted_acp_threads, parse_workspace_state, record_last_session, rel_time,
    search_threads, serialize_workspace_and_acp_state, serialize_workspace_state, sort_threads,
    sort_workspaces, thread_priority, validate_workspace_form, validate_workspace_form_on_disk,
    workspace_sessions,
};

#[cfg(test)]
mod store_tests;
