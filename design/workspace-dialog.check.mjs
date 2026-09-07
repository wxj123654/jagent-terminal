import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const output = resolve(process.env.ARTIFACT_DIR || '.pi/workspace-prototype/dialog-review')
await mkdir(output, { recursive: true })
const results = []
const failures = []
function check(condition, message) {
  if (!condition) failures.push(message)
}
async function geometry(page) {
  return page.locator('#tool-dialog').evaluate(dialog => {
    const rect = el => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }
    }
    return {
      dialog: rect(dialog),
      list: rect(dialog.querySelector('#tool-options')),
      custom: rect(dialog.querySelector('.custom-option')),
      text: rect(dialog.querySelector('.tool-option .option-text')),
      customText: rect(dialog.querySelector('.custom-option .option-text')),
      outerOverflow: dialog.scrollHeight > dialog.clientHeight + 1,
      horizontalOverflow: dialog.scrollWidth > dialog.clientWidth + 1,
    }
  })
}
try {
  for (const [name, width, height] of [['desktop', 1440, 960], ['compact', 1024, 768], ['mobile', 390, 844], ['short', 568, 320]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
    page.on('pageerror', error => failures.push(error.message))
    await page.goto(new URL('./workspace-plane.html', import.meta.url).href)
    if (width <= 760) await page.locator('#sidebar-toggle').click()
    await page.getByRole('button', { name: '在 website 新建会话', exact: true }).click()
    const before = await geometry(page)
    check(!before.outerOverflow, `${name}: 弹窗整体不应和列表同时滚动`)
    check(!before.horizontalOverflow, `${name}: 弹窗横向溢出`)
    check(before.dialog.y >= 0 && before.dialog.bottom <= height, `${name}: 弹窗越出视口`)
    check(before.custom.bottom <= before.dialog.bottom, `${name}: 自定义命令不可直接看到`)
    check(Math.abs(before.text.x - before.customText.x) <= 1, `${name}: 自定义命令与工具文本起点不同`)
    if (process.env.CAPTURE === '1') await page.screenshot({ path: resolve(output, `${name}.png`) })
    await page.locator('#tool-filter').fill('btop')
    const filtered = await geometry(page)
    check(Math.abs(filtered.dialog.y - before.dialog.y) <= 1, `${name}: 筛选导致弹窗位置跳动`)
    check(Math.abs(filtered.dialog.height - before.dialog.height) <= 1, `${name}: 筛选导致弹窗高度跳动`)
    await page.locator('#tool-filter').fill('无匹配工具')
    check(await page.locator('.custom-option').isVisible(), `${name}: 空态丢失自定义入口`)
    const empty = await page.locator('#tool-dialog').boundingBox()
    check(Math.abs(empty.y - before.dialog.y) <= 1, `${name}: 空态导致弹窗位置跳动`)
    await page.locator('#tool-filter').fill('')
    await page.locator('#tool-workspace').evaluate(select => {
      select.selectedOptions[0].textContent = 'very-long-workspace-name-'.repeat(8)
      document.querySelector('#tool-cwd').textContent = 'cwd  ~/Projects/' + 'long-directory/'.repeat(20)
    })
    const long = await geometry(page)
    check(!long.outerOverflow && !long.horizontalOverflow, `${name}: 长名称或路径破坏布局`)
    check(long.list.height >= 40, `${name}: 长路径挤没工具列表`)
    await page.locator('#tool-filter').fill('yazi')
    await page.locator('#tool-filter').press('Enter')
    assert.equal(await page.locator('dialog[open]').count(), 0)
    assert.equal(await page.locator('#title-workspace').innerText(), 'website')
    assert.ok(await page.getByRole('region', { name: 'yazi TUI 交互示意' }).isVisible())
    results.push({ viewport: name, before })
    await page.close()
  }
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ results, failures }, null, 2))
  console.log(JSON.stringify({ viewports: results.length, failures }, null, 2))
  assert.deepEqual(failures, [])
} finally {
  await browser.close()
}
