import { describe, expect, mock, test } from 'bun:test'
import { createRenderer, startFrameLoop, type RenderOptions } from '@gpuix/react'
import { createAppWindow } from './appWindow'

function fixture(running = true) {
  const order: string[] = []
  const renderer = {
    init: mock(() => {
      order.push('init')
    }),
    requiresTick: () => true,
    tick: mock(() => running),
  } as unknown as ReturnType<typeof createRenderer>
  const loops: ReturnType<typeof startFrameLoop>[] = []
  const host = {
    createRenderer: mock(() => renderer),
    render: mock((_node: unknown, _options: RenderOptions) => {}),
    resetRender: mock(() => {}),
    startFrameLoop: mock((...args: Parameters<typeof startFrameLoop>) => {
      const loop = startFrameLoop(...args)
      loops.push(loop)
      return loop
    }),
    terminate: mock(() => {}),
    applyWindowAppearance: mock(() => {
      order.push('appearance')
    }),
  }
  return { host, renderer, app: createAppWindow(host), loops, order }
}

describe('appWindow', () => {
  test('reuses one initialized renderer across remounts and stops the prior loop', () => {
    const { app, host, renderer, loops, order } = fixture()
    try {
      expect(app.renderer({ title: 'first' })).toBe(renderer)
      app.mount(null)
      const firstStop = mock(loops[0]!.stop)
      loops[0]!.stop = firstStop
      expect(app.renderer({ title: 'hot reload' })).toBe(renderer)
      app.mount(null)
      expect(host.createRenderer).toHaveBeenCalledTimes(1)
      expect(host.applyWindowAppearance).not.toHaveBeenCalled()
      expect(order).toEqual(['init'])
      expect(renderer.init).toHaveBeenCalledTimes(1)
      expect(host.render.mock.calls.map(([, options]) => options?.renderer)).toEqual([
        renderer,
        renderer,
      ])
      expect(firstStop).toHaveBeenCalledTimes(1)
      expect(renderer.tick).toHaveBeenCalledTimes(2)
    } finally {
      app.stop()
    }
  })

  test('module reevaluation reuses the project-owned global window', async () => {
    const previous = globalThis.jagentAppWindow
    const { app } = fixture()
    try {
      globalThis.jagentAppWindow = app
      const reloaded = await import(`./appWindow.ts?reload=${Date.now()}`)
      expect(reloaded.appWindow).toBe(app)
    } finally {
      globalThis.jagentAppWindow = previous
    }
  })

  test('stop clears the public paced loop and unmounts the root', async () => {
    const { app, host, renderer } = fixture()
    app.renderer({})
    app.mount(null)
    app.stop()
    await Bun.sleep(30)
    expect(renderer.tick).toHaveBeenCalledTimes(1)
    expect(host.resetRender).toHaveBeenCalledTimes(1)
    expect(host.terminate).not.toHaveBeenCalled()
  })

  test('last window closing stops/unmounts and exits', async () => {
    const { app, host, renderer } = fixture(false)
    app.renderer({})
    app.mount(null)
    await Bun.sleep(20)
    expect(renderer.tick).toHaveBeenCalledTimes(1)
    expect(host.resetRender).toHaveBeenCalledTimes(1)
    expect(host.terminate).toHaveBeenCalledTimes(1)
    expect(host.startFrameLoop).toHaveBeenCalledTimes(1)
  })

  test('stop during onTerminated does not recurse into another reset/exit', async () => {
    const { app, host } = fixture(false)
    host.resetRender = mock(() => {
      app.stop()
    })
    app.renderer({})
    app.mount(null)
    await Bun.sleep(20)
    expect(host.resetRender).toHaveBeenCalledTimes(1)
    expect(host.terminate).toHaveBeenCalledTimes(1)
  })

  test('refuses a mount before initialization', () => {
    const { app, host } = fixture()
    expect(() => app.mount(null)).toThrow('Initialize')
    expect(host.render).not.toHaveBeenCalled()
    expect(host.startFrameLoop).not.toHaveBeenCalled()
    expect(host.applyWindowAppearance).not.toHaveBeenCalled()
  })
})
