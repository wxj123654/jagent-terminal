/**
 * fonts.ts — 系统字体枚举 seam（设置字体选择器的数据源）。
 *
 * 数据源是 native `listSystemFonts()`（gpui TextSystem::all_font_names）——
 * 与渲染器解析 fontFamily 用同一字体源，列出的名字保证可解析。
 *
 * 懒加载 + 进程内缓存：字体清单在进程生命期内视为不变（新装字体重启生效），
 * 首次调用才触达 native；失败（旧 .node 无此函数 / host 通道未就绪）记
 * kind:'native' 错误并回 []——调用方退化为自由输入，不炸 UI。失败不缓存，
 * 下次打开重试。
 */

import { reportNativeError } from './errors/native'

let cache: string[] | null = null

export async function loadSystemFonts(): Promise<string[]> {
  if (cache) return cache
  try {
    const mod = await import('@jagent/native')
    const list = typeof mod.listSystemFonts === 'function' ? mod.listSystemFonts() : null
    if (!list) return []
    cache = list
    return list
  } catch (e) {
    reportNativeError('listSystemFonts', e)
    return []
  }
}
