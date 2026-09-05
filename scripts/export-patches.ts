/** Export managed .refs diffs; --check rejects patch drift without writing. */
import { MANIFEST, SUITES, type Suite } from './refs-config'
import { inspectPatchSuite } from './refs-state'

const CHECK_ONLY = process.argv.includes('--check')

async function main() {
  const results = await Promise.all(
    (Object.keys(SUITES) as Suite[]).map(async (suite) => ({
      suite,
      ...(await inspectPatchSuite({ ...SUITES[suite], manifest: MANIFEST[suite] }, CHECK_ONLY)),
    })),
  )
  const problems = results.flatMap(({ suite, problems }) => problems.map((p) => `${suite}: ${p}`))
  if (problems.length) throw new Error(problems.join('\n'))

  for (const { suite, diffs } of results) {
    if (CHECK_ONLY) continue
    for (const [name, diff] of Object.entries(diffs)) {
      await Bun.write(`${SUITES[suite].patchDir}/${name}`, diff)
      console.log(`[export-patches] ${suite}/${name} (${diff.length} bytes)`)
    }
  }
  if (CHECK_ONLY) console.log('[export-patches] --check 通过：patch 目录与工作树一致')
}

main().catch((err) => {
  console.error(`[export-patches] 失败：${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
