//! GPUIX custom element: `<terminal>`. Phase 1 — see architecture.md §2.4.
//!
//! Phase 0 leaves this as a typed placeholder; the GPUIX `CustomElement`
//! trait is implemented in Phase 1 inside `packages/native`.

/// Marker for the `<terminal>` custom element factory. Registered into the
/// GPUIX element registry by the napi shell in Phase 1.
#[derive(Debug, Default, Clone, Copy)]
pub struct TerminalFactory;

impl TerminalFactory {
    /// Element type name used from JSX: `<terminal />`.
    pub const ELEMENT_TYPE: &'static str = "terminal";
}
