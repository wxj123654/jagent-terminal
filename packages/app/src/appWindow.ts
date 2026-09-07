import {
  createRenderer,
  render,
  resetRender,
  startFrameLoop,
  type FrameLoop,
  type RenderOptions,
  type WindowOptions,
} from '@gpuix/react'
import { applyWindowAppearance } from '@jagent/native'
import type { ReactNode } from 'react'

type AppRenderer = ReturnType<typeof createRenderer>

export type AppWindowHost = {
  createRenderer: typeof createRenderer
  render: (node: ReactNode, options: RenderOptions) => unknown
  resetRender: () => void
  startFrameLoop: typeof startFrameLoop
  terminate: () => void
  applyWindowAppearance?: () => void
}

const nativeHost: AppWindowHost = {
  createRenderer,
  render,
  resetRender,
  startFrameLoop,
  terminate: () => process.exit(0),
  applyWindowAppearance,
}

/** Own the injected renderer and its loop together. stop() unmounts React,
 * but retains the native renderer: GPUIX has no public window disposal method. */
export function createAppWindow(host: AppWindowHost = nativeHost) {
  let renderer: AppRenderer | undefined
  let loop: FrameLoop | undefined
  let stopping = false

  const stop = () => {
    if (stopping) return
    stopping = true
    try {
      loop?.stop()
      loop = undefined
      host.resetRender()
    } catch {
      // Last window closed: GPUI already exited, so resetRender's unmount
      // hits "GPUI application is not initialized" from applyBatch. Swallow
      // it so the onTerminated caller can still reach host.terminate().
    } finally {
      stopping = false
    }
  }

  return {
    renderer(options: WindowOptions) {
      if (!renderer) {
        const created = host.createRenderer()
        // Appearance is applied inside renderer.init (after GPUIApplication
        // exists, before NSWindow). Calling NSApplication.sharedApplication
        // here would freeze the AppKit singleton as the stock class.
        created.init(options)
        renderer = created
      }
      return renderer
    },
    mount(node: ReactNode, options: Omit<RenderOptions, 'renderer'> = {}) {
      if (!renderer) throw new Error('Initialize the app window before mounting')
      // render() reuses its root/window slot for hot remounts. Inject the same
      // renderer every time, and own the loop via the public GPUIX interface.
      host.render(node, { ...options, renderer })
      loop?.stop()
      loop = host.startFrameLoop(renderer, {
        onTerminated: () => {
          stop()
          host.terminate()
        },
      })
    },
    stop,
  }
}

declare global {
  var jagentAppWindow: ReturnType<typeof createAppWindow> | undefined
}

// Bun --hot retains globalThis. Do not reach into GPUIX's private render slot.
export const appWindow = (globalThis.jagentAppWindow ??= createAppWindow())
