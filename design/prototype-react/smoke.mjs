// smoke.mjs — 全页面与子状态自动化截图 + DOM/UI/UX 几何与视觉审计脚本
// 用法: node smoke.mjs [baseUrl]
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const base = process.argv[2] ?? 'http://127.0.0.1:5199'
const outDir = resolve(__dirname, 'shots')
mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const context = await browser.newContext({
  viewport: { width: 1360, height: 860 },
  deviceScaleFactor: 2,
})
const page = await context.newPage()

const errors = []
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
page.on('console', m => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`)
})

/**
 * 采集当前页面的核心几何与 UI/UX 指标
 */
async function auditPage(name) {
  return await page.evaluate((pageName) => {
    const rect = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        x: Math.round(r.x * 10) / 10,
        y: Math.round(r.y * 10) / 10,
        w: Math.round(r.width * 10) / 10,
        h: Math.round(r.height * 10) / 10,
        bg: cs.backgroundColor,
        borderB: cs.borderBottomWidth + ' ' + cs.borderBottomColor,
        borderR: cs.borderRightWidth + ' ' + cs.borderRightColor,
      }
    }

    const app = rect('#app')
    const sb = rect('#sidebar')
    const sbHead = rect('.sb-head')
    const main = rect('#main')
    const tbMain = rect('#titlebar-main')
    const wb = rect('#workbench')

    // 检查是否存在未处理横向溢出的可见元素
    const clipped = []
    document.querySelectorAll('#app *').forEach(el => {
      if (!(el instanceof HTMLElement)) return
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) {
        if (cs.overflowX !== 'auto' && cs.overflowX !== 'scroll' && cs.textOverflow !== 'ellipsis') {
          clipped.push({
            tag: el.tagName.toLowerCase(),
            cls: el.className,
            text: (el.innerText || '').slice(0, 40).replace(/\n/g, ' '),
            clientW: el.clientWidth,
            scrollW: el.scrollWidth,
          })
        }
      }
    })

    // Git 图谱专项对齐检查
    let gitAudit = null
    const gitHeader = document.querySelector('.git-header')
    const gitRow = document.querySelector('.git-row')
    const gitCdv = document.querySelector('.git-cdv')
    if (gitHeader && gitRow) {
      const hCols = Array.from(gitHeader.children).map(c => {
        const r = c.getBoundingClientRect()
        return { text: c.textContent, x: Math.round(r.x), w: Math.round(r.width) }
      })
      const rCols = Array.from(gitRow.children).map(c => {
        const r = c.getBoundingClientRect()
        return { cls: c.className || c.tagName, x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) }
      })
      const rowRect = gitRow.getBoundingClientRect()
      const svgRect = gitRow.querySelector('svg.gcell')?.getBoundingClientRect()
      let cdvInfo = null
      if (gitCdv) {
        const cdvR = gitCdv.getBoundingClientRect()
        const sumR = gitCdv.querySelector('.sum')?.getBoundingClientRect()
        const filesR = gitCdv.querySelector('.files')?.getBoundingClientRect()
        cdvInfo = {
          cdvH: Math.round(cdvR.height),
          sumRatio: sumR ? Math.round((sumR.width / cdvR.width) * 100) : null,
          filesRatio: filesR ? Math.round((filesR.width / cdvR.width) * 100) : null,
        }
      }
      gitAudit = {
        headerBg: getComputedStyle(gitHeader).backgroundColor,
        rowH: Math.round(rowRect.height),
        svgH: svgRect ? Math.round(svgRect.height) : null,
        hCols,
        rCols,
        cdvInfo,
      }
    }

    // 设置窗口专项检查
    let settingsAudit = null
    const stWin = document.querySelector('.settings-win')
    if (stWin) {
      const winR = stWin.getBoundingClientRect()
      const contentR = stWin.querySelector('.st-content')?.getBoundingClientRect()
      const contentInR = stWin.querySelector('.st-content-in')?.getBoundingClientRect()
      let maxChildBottom = contentInR ? contentInR.top : 0
      stWin.querySelectorAll('.st-content-in > *').forEach(ch => {
        const r = ch.getBoundingClientRect()
        if (r.bottom > maxChildBottom) maxChildBottom = r.bottom
      })
      const usedH = contentInR ? Math.round(maxChildBottom - contentInR.top) : 0
      const availH = contentR ? Math.round(contentR.height) : 0
      settingsAudit = {
        winW: Math.round(winR.width),
        winH: Math.round(winR.height),
        contentW: contentR ? Math.round(contentR.width) : 0,
        contentInW: contentInR ? Math.round(contentInR.width) : 0,
        usedH,
        availH,
        verticalFillPct: availH ? Math.round((usedH / availH) * 100) : 0,
      }
    }

    // 启动台专项检查
    let bentoAudit = null
    const bento = document.querySelector('.bento-launchpad')
    if (bento) {
      const bR = bento.getBoundingClientRect()
      const wrapR = bento.querySelector('.bento-wrap')?.getBoundingClientRect()
      bentoAudit = {
        paneW: Math.round(bR.width),
        paneH: Math.round(bR.height),
        wrapW: wrapR ? Math.round(wrapR.width) : 0,
        wrapH: wrapR ? Math.round(wrapR.height) : 0,
        topGap: wrapR ? Math.round(wrapR.top - bR.top) : 0,
        bottomGap: wrapR ? Math.round(bR.bottom - wrapR.bottom) : 0,
      }
    }

    // 对话面专项检查
    let convAudit = null
    const conv = document.querySelector('.conv')
    if (conv) {
      const cR = conv.getBoundingClientRect()
      const msgsIn = conv.querySelector('.conv-msgs-in')?.getBoundingClientRect()
      const compIn = conv.querySelector('.composer-inner')?.getBoundingClientRect()
      convAudit = {
        convW: Math.round(cR.width),
        convH: Math.round(cR.height),
        msgsInX: msgsIn ? Math.round(msgsIn.x) : 0,
        msgsInW: msgsIn ? Math.round(msgsIn.width) : 0,
        compInX: compIn ? Math.round(compIn.x) : 0,
        compInW: compIn ? Math.round(compIn.width) : 0,
      }
    }

    // 工作面板专项检查
    let wpAudit = null
    const wp = document.querySelector('#work-panel')
    if (wp) {
      const wpR = wp.getBoundingClientRect()
      const wpHead = wp.querySelector('.wp-head')?.getBoundingClientRect()
      const master = wp.querySelector('.wp-split-master')?.getBoundingClientRect()
      const detail = wp.querySelector('.wp-split-detail')?.getBoundingClientRect()
      wpAudit = {
        wpW: Math.round(wpR.width),
        wpH: Math.round(wpR.height),
        wpHeadH: wpHead ? Math.round(wpHead.height) : 0,
        masterH: master ? Math.round(master.height) : 0,
        detailH: detail ? Math.round(detail.height) : 0,
      }
    }

    return {
      pageName,
      app,
      sb,
      sbHead,
      main,
      tbMain,
      wb,
      clipped: clipped.slice(0, 10),
      gitAudit,
      settingsAudit,
      bentoAudit,
      convAudit,
      wpAudit,
    }
  }, name)
}

const shotsMeta = []

async function snap(id, title, desc, setupFn) {
  await page.goto(base + '/', { waitUntil: 'networkidle' })
  await page.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
  if (setupFn) {
    await setupFn(page)
  }
  await page.waitForTimeout(220)
  const file = `${id}.png`
  const appEl = page.locator('#app')
  await appEl.screenshot({ path: resolve(outDir, file) })
  const audit = await auditPage(id)
  shotsMeta.push({ id, file, title, desc, audit })
  console.log(`✓ shot ${file} (${title})`)
}

// 1. 01-launchpad：空工作区启动台（默认满配状态）
await snap('01-launchpad', '01 · 工作区启动台 (Bento Launchpad)', '全高侧栏 + 悬浮圆角画布岛 + Bento 三层启动台（Hero + 双主入口 + 3列预设 + 活跃会话列表）', async (p) => {
  await p.evaluate(() => {
    // 通过点击侧栏第一个工作区进入启动台
    document.querySelector('.ws-row')?.click()
  })
})

// 2. 01b-launchpad-empty-presets：启动台（预设被删空 + 会话清空态）
await snap('01b-launchpad-empty', '01b · 启动台（删空预设 + 0 会话空态）', '验证预设全部删除且无活跃会话时的降级引导与恢复入口', async (p) => {
  await p.evaluate(() => {
    document.getElementById('demo').style.display = 'flex'
  })
  await p.locator('#demo button', { hasText: '删空预设' }).click()
  await p.locator('#demo button', { hasText: '清空会话' }).click()
  await p.evaluate(() => {
    document.getElementById('demo').style.display = 'none'
    const toasts = document.getElementById('toasts')
    if (toasts) toasts.style.display = 'none'
  })
})

// 3. 02-chat：AI 对话与 ACP 主面（内联工具调用链展开 + 底部 Composer 舱）
await snap('02-chat', '02 · AI 对话 / ACP 主面', '移除内部重复顶栏，连接状态胶囊融入 40px 顶栏；内嵌可折叠工具调用链卡片与 760px 中轴对齐 Composer 舱', async (p) => {
  await p.goto(base + '/?view=chat', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
})

// 4. 03-terminal：终端主面 + 双悬浮圆角岛 + 顶栏副页签定数上限与 [+3 ▾] 溢出收纳
await snap('03-terminal', '03 · 终端主面 + 顶栏副页签定数上限 ([+3 ▾] 收纳)', 'Arc 风格左右双悬浮圆角岛架构；顶栏仅展示主视图 + 2 个副视图，超出自动折叠进 [+3 ▾] 胶囊', async (p) => {
  await p.goto(base + '/?view=sess-main', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
  await p.keyboard.type('cargo test --workspace')
  await p.keyboard.press('Enter')
})

// 5. 03b-terminal-file-addpop：点击 [+3 ▾] 弹出溢出副视图管理菜单 + 主画布宽幅 Diff/源码视图
await snap('03b-terminal-file-addpop', '03b · 顶栏 [+3 ▾] 溢出下拉管理菜单 + 主画布宽幅视图', '点击 [+3 ▾] 展开溢出副页签搜索与管理菜单（支持过滤、单独关闭与一键关闭全部副视图）', async (p) => {
  await p.goto(base + '/?view=sess-file', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
  await p.locator('.tb-overflow-btn').click()
})

// 6. 04-work-panel：右侧专职变更/文件树导航栏 + 左侧主画布宽幅 Unified Diff / 并排对比 / 完整源码
await snap('04-work-panel', '04 · 右栏专职变更/文件树 + 主画布宽幅预览 (解耦空间争夺)', '右侧 296px 面板专职做变更分组与项目文件树导航；点击文件在左侧主画布打开宽幅 Unified Diff / 并排对比 / 完整源码', async (p) => {
  await p.goto(base + '/?view=panel', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
})

// 6b. 04b-work-panel-split：主画布并排对比 (Side-by-Side Diff) + 右侧项目文件树
await snap('04b-work-panel-split', '04b · 主画布并排 Diff 对比 + 右栏项目文件目录树', '主画布切换至 Side-by-Side 并排 Diff 对比，右侧面板切换至可折叠项目目录树', async (p) => {
  await p.goto(base + '/?view=panel', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
  await p.locator('.file-pathbar button', { hasText: '并排对比' }).click()
  await p.locator('#work-panel .ptab', { hasText: '文件树' }).click()
})

// 7. 05-git-graph：Git 提交图谱（行内展开 CDV 但左侧双色拓扑轨道线穿透不断裂）
await snap('05-git-graph', '05 · Git 提交图谱（左侧拓扑轨道线穿透 CDV 不断裂）', '展开第 4 行 d3b55e8 提交详情时，左侧双轨彩色分支线垂直穿过整个详情区不断裂，并延伸拐角虚线指向右侧圆角详情舱', async (p) => {
  await p.goto(base + '/?view=git', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
  await p.locator('.git-row').nth(3).click()
})

// 8. 06a-settings-presets：独立多窗口设置中心 — Presets 预设分区（含卡片展开编辑）
await snap('06a-settings-presets', '06a · 独立设置窗口 — Presets 预设管理', '940×620 独立设置窗口，双列预设卡片网格 + 点击展开内联参数编辑器 + 支持全部删除与一键恢复', async (p) => {
  await p.goto(base + '/?view=settings', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
  await p.locator('.le-head').first().click()
})

// 9. 06b-settings-terminal：独立设置窗口 — Terminal 终端分区（含实时预览 + 字体选择器下拉）
await snap('06b-settings-terminal', '06b · 独立设置窗口 — Terminal 终端与字体选择器', '终端参数行 + 底部紧凑实时字体/色板预览卡 + 搜索式字体下拉浮层', async (p) => {
  await p.goto(base + '/?view=font', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
})

// 10. 06c-settings-appearance：独立设置窗口 — Appearance 外观分区
await snap('06c-settings-appearance', '06c · 独立设置窗口 — Appearance 外观与主题色板', '主题下拉、侧栏宽度滑块 + 3 列紧凑主题色卡切换', async (p) => {
  await p.goto(base + '/?view=settings', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
  await p.locator('.st-nav-item', { hasText: 'Appearance' }).click()
})

// 11. 06d-settings-keybindings：独立设置窗口 — Keybindings 键位分区
await snap('06d-settings-keybindings', '06d · 独立设置窗口 — Keybindings 键位绑定', '双列快捷键卡片网格 + 平台固定键位表', async (p) => {
  await p.goto(base + '/?view=settings', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
  await p.locator('.st-nav-item', { hasText: 'Keybindings' }).click()
})

// 12. 06e-settings-notifications：独立设置窗口 — Notifications 通知分区
await snap('06e-settings-notifications', '06e · 独立设置窗口 — Notifications 通知与信号约定', '桌面通知开关 + CLI 侧 BEL/OSC 信号双列约定卡', async (p) => {
  await p.goto(base + '/?view=settings', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
  await p.locator('.st-nav-item', { hasText: 'Notifications' }).click()
})

// 13. 06f-settings-acp：独立设置窗口 — ACP Agents 外部代理分区
await snap('06f-settings-acp', '06f · 独立设置窗口 — ACP Agents 外部代理', '双列 ACP 代理卡片 + 展开编辑 Command / Args', async (p) => {
  await p.goto(base + '/?view=settings', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
  await p.locator('.st-nav-item', { hasText: 'ACP Agents' }).click()
  await p.locator('.le-head').first().click()
})

// 14. 06g-settings-advanced：独立设置窗口 — Advanced 高级分区
await snap('06g-settings-advanced', '06g · 独立设置窗口 — Advanced 高级与性能诊断', 'GPU 后端选择、HUD 开关 + 3 列紧凑运行时性能指标卡', async (p) => {
  await p.goto(base + '/?view=settings', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
  await p.locator('.st-nav-item', { hasText: 'Advanced' }).click()
})

// 15. 07-new-session：新建会话弹窗
await snap('07-new-session', '07 · 新建会话弹窗 (ToolDialog)', '工作区上下文选择器 + 搜索过滤框 + 分组工具列表', async (p) => {
  await p.goto(base + '/?view=tool', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
})

// 16. 08-search：⌘K 搜索会话 Spotlight 面板
await snap('08-search', '08 · ⌘K 搜索会话面板 (SearchDialog)', 'Spotlight 风格搜索弹窗 + 实时过滤会话列表', async (p) => {
  await p.goto(base + '/?view=search', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
  await p.keyboard.type('ime')
})

// 17. 09-add-workspace：添加工作区弹窗
await snap('09-add-workspace', '09 · 添加工作区弹窗 (WorkspaceDialog)', '工作区名称 + 目录路径输入与浏览按钮', async (p) => {
  await p.goto(base + '/?view=addws', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
})

// 18. 10-notif-center：通知中心浮层 + 28+ 会话高密度侧栏
await snap('10-notif-dense-sidebar', '10 · 通知中心浮层 + 28+ 会话高密度侧栏', '左下角通知中心浮层 + 侧栏 28+ 会话高密度滚动态', async (p) => {
  await p.evaluate(() => {
    document.getElementById('demo').style.display = 'flex'
  })
  await p.locator('#demo button', { hasText: '28+ 会话高密度' }).click()
  await p.evaluate(() => {
    document.getElementById('demo').style.display = 'none'
    const toasts = document.getElementById('toasts')
    if (toasts) toasts.style.display = 'none'
  })
  await p.locator('#sidebar .sb-foot .ibtn[title="通知中心"]').click()
})

// 19. 11-narrow-drawer：700px 窄屏模态抽屉态
await snap('11-narrow-drawer', '11 · 窄屏响应式模态抽屉 (<760px)', '窗口宽度 700px 时侧栏自动收起为汉堡菜单抽屉', async (p) => {
  await p.goto(base + '/?view=narrow', { waitUntil: 'networkidle' })
  await p.evaluate(() => {
    const demo = document.getElementById('demo')
    if (demo) demo.style.display = 'none'
  })
  await p.locator('button[aria-label="会话列表"]').click()
})

// 生成汇总 JSON 与可视化 HTML 画廊
writeFileSync(resolve(outDir, 'audit-report.json'), JSON.stringify({ errors, shots: shotsMeta }, null, 2))

const galleryHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>j-agent 全页面 UI/UX 截图与审查画廊</title>
<style>
  body { background: #07090e; color: #c3cad9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 32px; }
  h1 { color: #f2f5fa; font-size: 22px; margin: 0 0 8px; }
  .sub { color: #7e889b; font-size: 13px; margin-bottom: 28px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(580px, 1fr)); gap: 24px; }
  .card { background: #12151e; border: 1px solid #283042; border-radius: 12px; overflow: hidden; box-shadow: 0 16px 40px rgba(0,0,0,.45); }
  .card-head { padding: 14px 18px; border-bottom: 1px solid #1e2330; display: flex; flex-direction: column; gap: 4px; }
  .card-title { color: #f2f5fa; font-size: 14px; font-weight: 600; }
  .card-desc { color: #7e889b; font-size: 12px; }
  .card img { width: 100%; display: block; background: #0b0d12; }
</style>
</head>
<body>
  <h1>j-agent Obsidian Indigo · 全页面 UI/UX 截图画廊 (${shotsMeta.length} 张)</h1>
  <div class="sub">涵盖 8 大核心页面、独立设置窗口 7 个子分区及高密度/空预设/窄屏边界状态</div>
  <div class="grid">
    ${shotsMeta.map(s => `
      <div class="card" id="${s.id}">
        <div class="card-head">
          <div class="card-title">${s.title}</div>
          <div class="card-desc">${s.desc}</div>
        </div>
        <a href="${s.file}" target="_blank"><img src="${s.file}" alt="${s.title}" loading="lazy" /></a>
      </div>
    `).join('')}
  </div>
</body>
</html>`

writeFileSync(resolve(outDir, 'gallery.html'), galleryHtml)
console.log(`\n=== 完成 ${shotsMeta.length} 张截图，报告已写入 shots/audit-report.json 与 shots/gallery.html ===`)
if (errors.length) {
  console.error('页面错误:', errors)
}
await browser.close()
