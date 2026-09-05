import { existsSync } from 'node:fs'

// The parent releases this process only after the bell terminal is unmounted.
// Keep the PTY alive for three seconds after BEL, then exit naturally.
const trigger = process.env.JAGENT_E2E_BELL_TRIGGER
if (!trigger) throw new Error('Missing bell trigger path')
while (!existsSync(trigger)) await Bun.sleep(20)
process.stdout.write('\x07\x07')
await Bun.sleep(3000)
