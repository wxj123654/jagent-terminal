// Workspace alias: `@gpuix/react` imports `@gpuix/native`; this package
// redirects that specifier to @jagent/native so both resolve to the SAME
// .node binary (jagent-native), which statically links gpuix-native plus the
// terminal registry. Two separate binaries would each have their own Rust
// globals — the custom-element registry and terminal pool must be shared.
module.exports = require("@jagent/native");
