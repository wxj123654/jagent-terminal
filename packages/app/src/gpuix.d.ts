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
    /** 上一帧已画元素 bounds [x,y,w,h]；未画/未挂载返回 null。
     *  原生 renderer 与 test renderer 都有实现，上游 interface 未声明。 */
    getElementBounds?(elementId: number): number[] | null
  }
}

declare module '@gpuix/native' {
  interface WindowOptions {
    /** `"client"` | `"server"`. Linux CSD; ignored on macOS/Windows. */
    windowDecorations?: 'client' | 'server'
  }
}
