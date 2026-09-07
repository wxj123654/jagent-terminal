import '@gpuix/react'

// Project-owned declarations for native titlebar support. The Rust
// implementation remains in the native seam patch until the next migration.
// Included via tsconfig "src", so JSX in TitleBar/Sidebar sees these fields.
declare module '@gpuix/react' {
  interface StyleDesc {
    windowControlArea?: 'drag' | 'close' | 'min' | 'max'
  }

  interface NativeRenderer {
    startWindowMove?(): void
    titlebarDoubleClick?(): void
    minimizeWindow?(): void
    closeWindow?(): void
  }
}

declare module '@gpuix/native' {
  interface WindowOptions {
    /** `"client"` | `"server"`. Linux CSD; ignored on macOS/Windows. */
    windowDecorations?: 'client' | 'server'
  }
}
