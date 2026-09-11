import { createGitGraphStore } from '/Users/wxj/Documents/jagent-terminal/packages/app/src/git/store'
import { App } from '/Users/wxj/Documents/jagent-terminal/packages/app/src/plane/AgentPlane'
import { navigateTarget } from '/Users/wxj/Documents/jagent-terminal/packages/app/src/router'
import { memoryAdapter } from '/Users/wxj/Documents/jagent-terminal/packages/app/src/settings/file'
import { createSettingsStore } from '/Users/wxj/Documents/jagent-terminal/packages/app/src/settings/store'
import { builtinPresetOf } from '/Users/wxj/Documents/jagent-terminal/packages/app/src/threads/presets'
import { createThreadStore } from '/Users/wxj/Documents/jagent-terminal/packages/app/src/threads/store'
import { defaultWorkspace } from '/Users/wxj/Documents/jagent-terminal/packages/app/src/threads/workspaces'
import { createTestRoot } from '@gpuix/react/testing'
import { createElement } from 'react'

const settings = createSettingsStore(memoryAdapter())
const ws = defaultWorkspace('/Users/wxj/Documents/jagent-terminal')
const store = createThreadStore(
  {
    spawnSession: async () => 1,
    destroySession: async () => {},
    navigate: navigateTarget,
    notify: () => {},
    closeOnExit: () => false,
    presetOf: (id) => builtinPresetOf(id),
    chatAgent: { send: async () => 'ok' },
    createAcpAgent: () => ({ send: async () => 'ok' }),
  },
  { initialWorkspaces: [ws] },
)
const t = createTestRoot({ width: 1280, height: 800 })
t.render(createElement(App, { store, settings, gitStore: createGitGraphStore() }))
t.renderer.flush()
await new Promise((r) => setTimeout(r, 50))
t.renderer.captureScreenshot('/tmp/v2-native-default.png')
console.log('done')
