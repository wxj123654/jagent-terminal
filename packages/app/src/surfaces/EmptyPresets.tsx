/**
 * EmptyPresets — 无 thread 时的 Pane 表面（布局契约 §5.4 E2；路由 `/`）。
 *
 * R9 对齐原型 .home/.home-card（index.css 第二段 :root 生效值）：居中
 * 680px 渐变卡——home-mark 图标块 + mono kicker + h1 + sub + ctx 行
 * （folder + mono path）+ section-head（左 600 右 muted）+ .pills 双列
 * 网格卡（pill-icon + label + arrowRight 尾标）。预设接
 * settings.presets.items（内置 5 + 自定义，设置增删实时反映）。
 * 点击 → spawnFromPreset（内部更新 lastUsedPreset）。
 *
 * HomeShell/HomeCard/HomeMark/HomeKicker/HomeTitle/HomeSub/HomeContext/
 * HomeSectionHead/HomePills/Pill 导出给 sidebar/WorkspaceEmpty（原型
 * WorkspaceEmpty 复用同一 .home 卡；plane → surfaces 依赖方向合法）。
 *
 * 原型特性 GPUIX 无对应（有意偏离）：letter-spacing（kicker/h1/role）、
 * pill hover translateY(-1px)、:focus-visible 双环（focusRing 单圈近似）。
 */

import { useWindowSize } from '@gpuix/react'
import { useState } from 'react'

import { Icon, COLORS, FONT, focusRing, type IconName } from '@jagent/ui'
import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import type { TerminalPreset } from '../threads/presets'
import { SIZES } from '../tokens'

/** 预设 → pill 图标（原型 presetIcon：agent 类机器人头，终端类竖条） */
export function presetIcon(p: TerminalPreset): IconName {
  return p.category === 'agent' ? 'agent' : 'terminal'
}

/** 原型 @media(max-width:760px) 翻转窄态（.home/.home-card/.pills 内距） */
export function useHomeNarrow(): boolean {
  return useWindowSize().width < SIZES.narrowBreakpoint
}

/** .home：整面居中容器（column center/center；padding 32，窄 18） */
export function HomeShell({
  testId,
  narrow = false,
  children,
}: {
  testId?: string
  narrow?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      testId={testId}
      style={{
        flexGrow: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: COLORS.pane,
        padding: narrow ? 18 : 32,
        gap: 6,
        minWidth: 0,
      }}
    >
      {children}
    </div>
  )
}

/** .home-card：min(680px,100%) 渐变卡（r12 + borderSubtle + 0 18 50 阴影） */
export function HomeCard({
  narrow = false,
  children,
}: {
  narrow?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        maxWidth: 680,
        padding: narrow ? 24 : 34,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 12,
        // 原型 linear-gradient(145deg, rgba(42,48,57,.65), rgba(32,36,43,.84))
        background: {
          type: 'linear-gradient',
          angle: 145,
          stops: [
            { color: 'rgba(42,48,57,0.65)', position: 0 },
            { color: 'rgba(32,36,43,0.84)', position: 1 },
          ],
        },
        boxShadow: {
          offsetX: 0,
          offsetY: 18,
          blurRadius: 50,
          spreadRadius: 0,
          color: 'rgba(0,0,0,0.22)',
        },
      }}
    >
      {children}
    </div>
  )
}

/** .home-mark：42² 图标块（r10 + accent 描边/底）；workspace 变体换绿 */
export function HomeMark({ workspace = false }: { workspace?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 42,
        height: 42,
        marginBottom: 18,
        borderWidth: 1,
        borderRadius: 10,
        // 原型：默认 rgba(97,175,239,.3) 边 + accentSoft 底；
        // .home-mark.workspace = rgba(152,195,121,.25) 边 + .1 底
        borderColor: workspace ? 'rgba(152,195,121,0.25)' : 'rgba(97,175,239,0.3)',
        backgroundColor: workspace ? 'rgba(152,195,121,0.1)' : COLORS.accentSoft,
        pointerEvents: 'none',
      }}
    >
      <Icon
        name={workspace ? 'folder' : 'agent'}
        size={20}
        color={workspace ? COLORS.terminalKind : COLORS.accent}
      />
    </div>
  )
}

/** .home-kicker：mono 10 600 muted（letter-spacing .12em 不支持——跳过） */
export function HomeKicker({ children }: { children: React.ReactNode }) {
  return (
    <text
      style={{
        fontFamily: FONT.mono,
        fontSize: 10,
        fontWeight: '600',
        color: COLORS.muted,
        pointerEvents: 'none',
      }}
    >
      {children}
    </text>
  )
}

/** h1（24px 600 lh1.2；原型 .home h1——letter-spacing:-.02em 不支持） */
export function HomeTitle({ children }: { children: React.ReactNode }) {
  return (
    <text
      style={{
        fontSize: 24,
        fontFamily: FONT.ui,
        fontWeight: '600',
        lineHeight: 28.8,
        color: COLORS.textBright,
        marginTop: 7,
        pointerEvents: 'none',
      }}
    >
      {children}
    </text>
  )
}

/** 副文案（13px muted 左对齐；原型 .home .sub 第二段覆盖） */
export function HomeSub({ children }: { children: React.ReactNode }) {
  return (
    <text
      style={{
        fontSize: 13,
        fontFamily: FONT.ui,
        color: COLORS.muted,
        marginTop: 6,
        pointerEvents: 'none',
      }}
    >
      {children}
    </text>
  )
}

/** ctx 行（原型 .home .ctx：mt18 / pad 8·10 / inputBg 凹陷盒 + folder 14
 *  + mono 12 path；第二段起 max-width:none = 卡内容全宽） */
export function HomeContext({ path }: { path: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 18,
        minWidth: 0,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 10,
        paddingRight: 10,
        borderWidth: 1,
        borderColor: COLORS.borderSubtle,
        borderRadius: 8,
        backgroundColor: COLORS.inputBg,
      }}
    >
      <Icon name="folder" size={14} color={COLORS.faint} />
      <text
        style={{
          fontSize: 12,
          fontFamily: FONT.mono,
          color: COLORS.faint,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
          minWidth: 0,
          flexShrink: 1,
          pointerEvents: 'none',
        }}
      >
        {path}
      </text>
    </div>
  )
}

/** .home-section-head：mt24 mb9 行两端（左 11/600 text，右 11/400 muted） */
export function HomeSectionHead({ left, right }: { left: string; right: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: 24,
        marginBottom: 9,
      }}
    >
      <text
        style={{
          fontSize: 11,
          fontFamily: FONT.ui,
          fontWeight: '600',
          color: COLORS.text,
          pointerEvents: 'none',
        }}
      >
        {left}
      </text>
      <text
        style={{
          fontSize: 11,
          fontFamily: FONT.ui,
          color: COLORS.muted,
          pointerEvents: 'none',
        }}
      >
        {right}
      </text>
    </div>
  )
}

/** .pills：双列网格（grid-cols 2 / gap 8；窄态 1 列） */
export function HomePills({
  narrow = false,
  children,
}: {
  narrow?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: narrow ? 1 : 2,
        gap: 8,
      }}
    >
      {children}
    </div>
  )
}

/** 预设 pill（原型 .pill：h42 / pad 0 11 / r8 / 凹陷半透底 + pill-icon
 *  24² surface 块 + 文本 + arrowRight 尾标；featured = pi 主胶囊 accent
 *  描边/底）。hover → surfaceHover + #4b5665 边（translateY 不支持跳过；
 *  featured 原型无 hover 差分——同优先级后声明胜出，保持静态）。 */
export function Pill({
  icon,
  label,
  testId,
  featured = false,
  onClick,
}: {
  icon: IconName
  label: string
  testId: string
  /** .pill.featured：accent 描边 + accentSoft 底（工作区页 pi 主入口） */
  featured?: boolean
  onClick: () => void
}) {
  const [focused, setFocused] = useState(false)
  return (
    <div
      tabIndex={0}
      testId={testId}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onClick()
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        width: '100%',
        height: 42,
        paddingLeft: 11,
        paddingRight: 11,
        borderWidth: 1,
        borderColor: featured ? 'rgba(97,175,239,0.42)' : COLORS.borderSubtle,
        borderRadius: 8,
        backgroundColor: featured ? COLORS.accentSoft : 'rgba(23,26,31,0.55)',
        cursor: 'pointer',
        userSelect: 'none',
        boxShadow: focused ? focusRing() : undefined,
        hover: featured
          ? undefined
          : { backgroundColor: COLORS.surfaceHover, borderColor: '#4b5665' },
      }}
    >
      {/* .pill-icon：24² r6 surface 块（pe:none 让点击落在 pill 上） */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 6,
          backgroundColor: COLORS.surface,
          flexShrink: 0,
          pointerEvents: 'none',
        }}
      >
        <Icon name={icon} size={14} color={COLORS.accent} />
      </div>
      <text
        style={{
          flexGrow: 1,
          minWidth: 0,
          fontSize: 12,
          fontFamily: FONT.ui,
          fontWeight: 550,
          color: COLORS.textBright,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          pointerEvents: 'none',
        }}
      >
        {label}
      </text>
      {/* .pill>svg 尾标：arrowRight 12 faint */}
      <Icon name="arrowRight" size={12} color={COLORS.faint} />
    </div>
  )
}

export function EmptyPresets({
  onPick,
  settings,
  cwd,
}: {
  onPick: (presetId: string) => void
  settings: SettingsStore
  /** 上下文目录（首个工作区 path；原型 .ctx 行） */
  cwd?: string
}) {
  const presets = useSettings(settings).presets.items
  const narrow = useHomeNarrow()

  return (
    <HomeShell testId="home-empty" narrow={narrow}>
      <HomeCard narrow={narrow}>
        <HomeMark />
        <HomeKicker>J-AGENT WORKSPACE</HomeKicker>
        <HomeTitle>想做点什么？</HomeTitle>
        <HomeSub>从左侧选择工作区，或直接开始一个新任务</HomeSub>
        <HomeContext path={cwd ?? '未归属 · 无项目目录'} />
        <HomeSectionHead left="快速开始" right={`${presets.length} 个工具`} />
        <HomePills narrow={narrow}>
          {presets.map((p) => (
            <Pill
              key={p.id}
              icon={presetIcon(p)}
              label={p.label}
              testId={`preset-${p.id}`}
              onClick={() => onPick(p.id)}
            />
          ))}
        </HomePills>
      </HomeCard>
    </HomeShell>
  )
}
