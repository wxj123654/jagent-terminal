/**
 * shot-proto.mjs — React 原型（design/prototype-react）逐状态截图。
 *
 * 用法（仓库根目录）：
 *   node scripts/cmp/shot-proto.mjs            # 全量状态
 *   node scripts/cmp/shot-proto.mjs main git   # 指定状态
 *   PORT=5200 node scripts/cmp/shot-proto.mjs  # 换 dev server 端口
 *
 * 产物：.shots/cmp/proto-<state>.png（裁到 #app 盒；1280×800 视口，
 * narrow 态窗口 700×800 → PNG 即 700×800）。
 * 规范化（chrome.mjs）：#demo 隐藏 / focus ring 清零 / #app 窗壳装饰剥掉。
 *
 * 状态映射：?view= 深链见 App.tsx applyDeepLink；无深链的态走交互
 * （ctxmenu=右键 .t-row「IME 候选窗定位」，sess-add=点 .tb-add-btn）。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  CMP_DIR,
  DEFAULT_PORT,
  ensureDevServer,
  killChild,
  normalize,
  openPage,
  shotApp,
} from './chrome.mjs'

// [状态名, query]——query 为 null 的走 interact()
const STATES = [
  ['main', ''],
  ['home', '?view=home'],
  ['chat', '?view=chat'],
  ['acp', '?view=acp'],
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
  ['sess-main', '?view=sess-main'],
  ['sess-git', '?view=sess-git'],
  ['sess-file', '?view=sess-file'],
  ['sess-shell', '?view=sess-shell'],
  ['narrow', '?view=narrow'],
  ['hidden', '?view=hidden'],
  ['ctxmenu', null],
  ['sess-add', null],
]

/** 无深链状态的交互步骤（页面已加载默认态后调用）。 */
async function interact(page, name) {
  if (name === 'ctxmenu') {
    const row = page.locator('.t-row', { hasText: 'IME 候选窗定位' }).first()
    await row.click({ button: 'right' })
    await page.waitForTimeout(200)
  } else if (name === 'sess-add') {
    await page.locator('.tb-add-btn').click()
    await page.waitForTimeout(200)
  }
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const port = Number(process.env.PORT ?? DEFAULT_PORT)

mkdirSync(CMP_DIR, { recursive: true })
const { base, child } = await ensureDevServer(port)
const { browser, page, errors } = await openPage()

try {
  for (const [name, qs] of STATES) {
    if (only.length && !only.includes(name)) continue
    if (qs !== null) {
      await page.goto(`${base}/${qs}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(350)
    } else {
      // 交互态：先回默认页再操作
      await page.goto(`${base}/`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(300)
      await interact(page, name)
    }
    await normalize(page)
    await page.waitForTimeout(50)
    const out = join(CMP_DIR, `proto-${name}.png`)
    await shotApp(page, out)
    console.log('shot', name, '→', out)
  }
} finally {
  await browser.close()
  await killChild(child)
}

if (errors.length) {
  console.log('\n=== 页面错误 ===')
  for (const e of errors) console.log(e)
  process.exitCode = 1
} else {
  console.log('\n无 JS 错误')
}
