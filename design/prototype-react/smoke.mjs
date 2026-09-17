// smoke.mjs — 用系统 Chrome 对 React 原型做冒烟 + 截图
// 用法: bun run smoke.mjs [baseUrl]   默认 http://localhost:5199
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const base = process.argv[2] ?? 'http://localhost:5199'
const outDir = resolve('../../.shots/react')
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } })

const errors = []
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
page.on('console', m => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`)
})

const states = [
  ['main', ''],
  ['home', '?view=home'],
  ['chat', '?view=chat'],
  ['workspace', '?view=workspace'],
  ['git', '?view=git'],
  ['settings', '?view=settings'],
  ['panel', '?view=panel'],
  ['search', '?view=search'],
  ['tool', '?view=tool'],
  ['addws', '?view=addws'],
  ['errors', '?view=errors'],
  ['crash', '?view=crash'],
  ['notif', '?view=notif'],
  ['font', '?view=font'],
  ['narrow', '?view=narrow'],
  ['hidden', '?view=hidden'],
]

for (const [name, qs] of states) {
  await page.goto(base + '/' + qs, { waitUntil: 'networkidle' })
  await page.waitForTimeout(350)
  await page.screenshot({ path: resolve(outDir, `${name}.png`) })
  console.log('shot', name)
}

// 交互冒烟：终端输入 + 新建会话弹窗 + 右键菜单
await page.goto(base + '/', { waitUntil: 'networkidle' })
await page.waitForTimeout(300)
await page.keyboard.type('git status')
await page.keyboard.press('Enter')
await page.waitForTimeout(200)
await page.screenshot({ path: resolve(outDir, 'term-typed.png') })
console.log('shot term-typed')

// Ctrl-K 搜索
await page.keyboard.press('Control+k')
await page.waitForTimeout(200)
await page.keyboard.type('ime')
await page.waitForTimeout(200)
await page.screenshot({ path: resolve(outDir, 'search-ime.png') })
await page.keyboard.press('Escape')

// 右键会话行
const row = page.locator('.t-row', { hasText: 'IME 候选窗定位' }).first()
if (await row.count()) {
  await row.click({ button: 'right' })
  await page.waitForTimeout(200)
  await page.screenshot({ path: resolve(outDir, 'ctxmenu.png') })
  console.log('shot ctxmenu')
}

if (errors.length) {
  console.log('\n=== 页面错误 ===')
  for (const e of errors) console.log(e)
} else {
  console.log('\n无 JS 错误')
}
await browser.close()
