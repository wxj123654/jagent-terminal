/**
 * geom-proto.mjs — React 原型几何导出（getBoundingClientRect，#app 原点）。
 *
 * 用法（仓库根目录）：
 *   node scripts/cmp/geom-proto.mjs            # 全量状态（同 shot-proto 清单）
 *   node scripts/cmp/geom-proto.mjs main tool  # 指定状态
 *
 * 产物：.shots/cmp/geom-proto-<state>.json —— 每条 {sel,i,cls,text,x,y,w,h,
 * bg,color,fs,fw,pl,pr,ml,mt,gap,br,bl}；与 impl 侧 proto-shot.mjs --geom 的
 * geom-impl-<state>.json 逐字段可比（字段同名）。
 *
 * 选择器集按 React 原型 DOM 校准：index.css 类名沿用 HTML 原型；Radix
 * Portal 挂 body（不在 #app 内）——浮层选择器带 [data-radix-popper-content-wrapper]
 * / role=dialog/menu 覆盖，坐标统一减 #app 原点换算。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CMP_DIR, DEFAULT_PORT, ensureDevServer, killChild, openPage } from './chrome.mjs'

/** 结构选择器（任一状态通用）+ 各状态附加集。存在才导出。 */
const BASE = [
  '#app',
  '#sidebar',
  '.sb-head',
  '.sb-nav',
  '.sb-scroll',
  '.sb-foot',
  '.nav-row',
  '.sec-head',
  '.ws-head',
  '.ws-body',
  '.t-row',
  '.ghost',
  '#main',
  '#titlebar',
  '#titlebar-main',
  '.tb-context',
  '#tb-branch',
  '.tb-cell',
  '.tb-actions',
  '.win-ctl',
  '#tb-tabs',
  '.tab',
  '.tab.active',
  '.tb-add-btn',
  '#workbench',
  '.term-surface',
  '.term',
  '.home',
  '.conv-head',
  '.conv-msgs',
  '.composer',
  '.file-surface',
  '.file-pathbar',
  '.code-view',
  '.git-view',
  '.wp-head',
  '.wp-tabs',
  '.wp-body',
]
const PER_STATE = {
  tool: ['[role="dialog"]', '.tool-ctx', '.tool-filter', '.tool-group', '.tool-row', '.mhint'],
  search: ['[role="dialog"]', '.srch-input', '.srch-row', '.srch-hit'],
  addws: ['[role="dialog"]', '.wsf-row', '.wsf-input'],
  errors: ['[role="dialog"]', '.err-item'],
  crash: ['[role="dialog"]', '.crash-box'],
  notif: ['[data-radix-popper-content-wrapper]', '.nt-pop', '.nt-item'],
  'sess-add': [
    '[data-radix-popper-content-wrapper]',
    '.session-add-pop',
    '.sa-act',
    '.sa-sub',
    '.sa-file',
  ],
  ctxmenu: ['[role="menu"]', '[role="menuitem"]'],
  settings: ['.st-nav', '.st-body', '.srow', '.sec-title'],
  git: [
    '.git-toolbar',
    '.git-branch-btn',
    '.git-find',
    '.git-header',
    '.git-header span',
    '.git-row',
    '.gcell',
    '.ref-chip',
    '.git-cdv',
    '.cdv-title',
    '.cdv-meta',
    '.frow',
    '.git-err',
  ],
  'sess-git': [
    '.git-toolbar',
    '.git-branch-btn',
    '.git-find',
    '.git-header',
    '.git-header span',
    '.git-row',
    '.gcell',
    '.ref-chip',
    '.git-cdv',
    '.cdv-title',
    '.cdv-meta',
    '.frow',
    '.git-err',
  ],
  panel: ['.wp-head', '.wp-tabs', '.wp-row', '.wp-diff'],
  font: ['.font-trig', '.font-pop'],
}

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
  ['ctxmenu', 'CTX'],
  ['sess-add', 'ADD'],
]

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const port = Number(process.env.PORT ?? DEFAULT_PORT)

mkdirSync(CMP_DIR, { recursive: true })
const { base, child } = await ensureDevServer(port)
const { browser, page } = await openPage()

/** 收集一组选择器的几何（#app 原点）。在页面里跑。 */
const COLLECT = (sels) => {
  const app = document.querySelector('#app')
  const origin = app ? app.getBoundingClientRect() : { left: 0, top: 0 }
  const out = []
  for (const sel of sels) {
    let els
    try {
      els = document.querySelectorAll(sel)
    } catch {
      continue
    }
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return
      const cs = getComputedStyle(el)
      const txt = el.childElementCount === 0 ? (el.textContent ?? '').slice(0, 60) : ''
      out.push({
        sel,
        i,
        cls: typeof el.className === 'string' ? el.className.slice(0, 60) : '',
        text: txt.replace(/\s+/g, ' ').trim().slice(0, 50),
        x: +(r.left - origin.left).toFixed(1),
        y: +(r.top - origin.top).toFixed(1),
        w: +r.width.toFixed(1),
        h: +r.height.toFixed(1),
        bg: cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? null : cs.backgroundColor,
        color: cs.color,
        fs: cs.fontSize,
        fw: cs.fontWeight,
        pl: cs.paddingLeft,
        pr: cs.paddingRight,
        ml: cs.marginLeft,
        mt: cs.marginTop,
        gap: cs.gap === 'normal' ? null : cs.gap,
        br: cs.borderRadius === '0px' ? null : cs.borderRadius,
        bl: cs.borderLeftWidth === '0px' ? null : cs.borderLeftWidth,
      })
    })
  }
  return out
}

try {
  for (const [name, qs] of STATES) {
    if (only.length && !only.includes(name)) continue
    const url = qs === 'CTX' || qs === 'ADD' ? `${base}/` : `${base}/${qs}`
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(350)
    if (qs === 'CTX') {
      const row = page.locator('.t-row', { hasText: 'IME 候选窗定位' }).first()
      await row.click({ button: 'right' })
      await page.waitForTimeout(250)
    } else if (qs === 'ADD') {
      await page.locator('.tb-add-btn').click()
      await page.waitForTimeout(250)
    }
    const sels = [...BASE, ...(PER_STATE[name] ?? [])]
    const nodes = await page.evaluate(COLLECT, sels)
    const out = join(CMP_DIR, `geom-proto-${name}.json`)
    writeFileSync(out, JSON.stringify(nodes, null, 0))
    console.log('geom', name, '→', out, nodes.length, 'nodes')
  }
} finally {
  await browser.close()
  await killChild(child)
}
