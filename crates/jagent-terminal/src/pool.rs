//! TerminalPool — session registry with retain semantics.
//!
//! ```text
//! create(opts) → sessionId ──> HashMap<u64, Entity<TerminalModel>>
//! destroy(id)              ──> shutdown PTY + drop entity + remove
//! get(id)                  ──> Entity<TerminalModel> (views bind by id)
//! ```
//!
//! Sessions outlive views: switching threads unmounts the `<terminal>`
//! element but the session stays here.
//!
//! **Storage note** (revision of architecture.md §2.2): gpui `Entity` /
//! `Subscription` are not `Send`, so a `static OnceLock<Mutex<...>>` pool
//! cannot compile. The registry therefore lives in a gpui
//! [`Global`](gpui::Global) (per-`App`, same lifetime as the process for the
//! single-app design), while the cross-session event sink — which must be
//! reachable from background threads — is a plain `static OnceLock` because
//! `SessionEventFn` is `Send + Sync` by construction.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use anyhow::{anyhow, Result};
use gpui::{App, Entity, Global};

use crate::model::TerminalModel;
use crate::pty::SpawnOptions;

/// Cross-session events forwarded to the host (JS in Phase 1).
#[derive(Debug, Clone)]
pub enum SessionEvent {
    Title { id: u64, title: String },
    Bell { id: u64 },
    /// `code` is the child's exit status when known (`ChildExit`); `None`
    /// when only the stream-end `Exit` was observed.
    Exit { id: u64, code: Option<i32> },
}

/// Global sink for session events. Set once at startup; called from the
/// models' consumer tasks (background context), hence `Send + Sync`.
pub type SessionEventFn = Arc<dyn Fn(&SessionEvent) + Send + Sync>;

static SESSION_EVENT_SINK: OnceLock<SessionEventFn> = OnceLock::new();

/// Install the global session-event sink (host does this once).
pub fn set_session_event_fn(f: SessionEventFn) {
    let _ = SESSION_EVENT_SINK.set(f);
}

/// Internal: forward a session event if a sink is installed.
pub(crate) fn forward_session_event(event: &SessionEvent) {
    if let Some(sink) = SESSION_EVENT_SINK.get() {
        sink(event);
    }
}

/// The pool. Stored as a gpui global: `cx.set_global` once at startup,
/// `cx.update_global` for create/destroy, `cx.global` for lookups.
pub struct TerminalPool {
    sessions: HashMap<u64, Entity<TerminalModel>>,
    next_id: AtomicU64,
}

impl Global for TerminalPool {}

impl TerminalPool {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            next_id: AtomicU64::new(1),
        }
    }

    /// Install the pool as the app-global instance (idempotent).
    pub fn init_global(cx: &mut App) {
        if !cx.has_global::<Self>() {
            cx.set_global(Self::new());
        }
    }

    /// Spawn a session and register it. Returns the new session id.
    ///
    /// The init command is typed (not exec'd): `write_to_pty(cmd)` +
    /// `b"\x0d"` — Zed activation_script precedent.
    pub fn create(&mut self, opts: SpawnOptions, cx: &mut App) -> Result<u64> {
        let entity = TerminalModel::new(&opts, cx);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        entity.update(cx, |model, _| model.set_id(id));
        self.sessions.insert(id, entity);

        // Type the init command after registration so `exit`/`title` events
        // observe a registered session.
        if let Some(init) = opts.init_command.as_deref().filter(|s| !s.is_empty()) {
            if let Some(model) = self.sessions.get(&id) {
                model.read(cx).write_to_pty(init.as_bytes());
                model.read(cx).write_to_pty(b"\x0d");
            }
        }

        Ok(id)
    }

    /// Kill the PTY, drop the entity, remove from the pool.
    pub fn destroy(&mut self, id: u64, _cx: &mut App) -> Result<()> {
        let Some(entity) = self.sessions.remove(&id) else {
            return Err(anyhow!("no terminal session {id}"));
        };
        entity.read(_cx).shutdown();
        // Entity drops here; the gpui release machinery frees it.
        drop(entity);
        Ok(())
    }

    /// Look up a session (views bind by id).
    pub fn get(&self, id: u64) -> Option<Entity<TerminalModel>> {
        self.sessions.get(&id).cloned()
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    pub fn session_ids(&self) -> Vec<u64> {
        self.sessions.keys().copied().collect()
    }
}

impl Default for TerminalPool {
    fn default() -> Self {
        Self::new()
    }
}
