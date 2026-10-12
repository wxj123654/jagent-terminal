//! 设置：schema（字段级容错）+ store（内存即时、合并写、失败回滚）+ 文件适配器。
//!
//! 对应旧 `settings/{schema,store,file}.ts`。语义要点（旧 zod 实现的行为，逐条保持）：
//! - 叶子坏值 / 越界 / 缺失 → 该叶子回默认，其余字段保留；
//! - 整节缺失 → 该节各叶子回默认；
//! - 整节类型错（如 `terminal: 123`）→ **整体**回默认；
//! - 未知键往返保真（读进来写出去不丢）；
//! - 写盘失败 → 内存回滚到最后一次确认落盘的快照，并置 `write_error`。

mod file;
mod schema;
mod store;

pub use file::{FileAdapter, FsAdapter, MemoryAdapter};
pub use schema::{
    AcpAgent, GpuBackend, Settings, default_terminal_font, parse_settings, serialize_settings,
};
pub use store::{AcpAgentInput, AcpAgentPatch, PresetInput, PresetPatch, SettingsStore, WriteError};
