/**
 * EmptyPresets — 无 thread 时的 Pane 表面（布局契约 §5.4 E2；路由 `/`）。
 *
 * V2 统一空态（D15，原型 .home）：居中单列——h1 标题 + 副文案 +
 * ctx 行（folder + mono path）+ 预设 pills（胶囊 chip：icon + label）。
 * 预设接 settings.presets.items（内置 5 + 自定义，设置增删实时反映）。
 * 点击 → spawnFromPreset（内部更新 lastUsedPreset）。
 *
 * HomeShell/Pill 导出给 plane/WorkspaceEmpty（同原型布局；plane →
 * surfaces 依赖方向合法，反向不合法）。
 */

import { Icon, COLORS, FONT, type IconName } from '@jagent/ui'
import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import type { TerminalPreset } from '../threads/presets'

/** 预设 → pill 图标（原型 quick-tool：agent 类用机器人头，终端类用竖条） */
export function presetIcon(p: TerminalPreset): IconName {
  return p.category === 'agent' ? 'agent' : 'terminal'
}

/** V2 home 壳（原型 .home：居中单列；内容 maxWidth 收，padding-bottom 72 偏上） */
export function HomeShell({ testId, children }: { testId?: string; children: React.ReactNode }) {
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
        paddingLeft: 24,
        paddingRight: 24,
        paddingBottom: 72,
        gap: 6,
        minWidth: 0,
      }}
    >
      {children}
    </div>
  )
}

/** h1（22px 600；原型 .home h1） */
export function HomeTitle({ children }: { children: React.ReactNode }) {
  return (
    <text
      style={{
        fontSize: 22,
        fontFamily: FONT.ui,
        fontWeight: '600',
        color: COLORS.textBright,
        marginTop: 8,
      }}
    >
      {children}
    </text>
  )
}

/** 副文案（14px text-3；原型 .home .sub） */
export function HomeSub({ children }: { children: React.ReactNode }) {
  return (
    <text
      style={{
        fontSize: 14,
        fontFamily: FONT.ui,
        color: COLORS.muted,
        textAlign: 'center',
      }}
    >
      {children}
    </text>
  )
}

/** ctx 行（folder 13 + mono path；原型 .home .ctx：margin-top 18，text-4） */
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
        maxWidth: 560,
      }}
    >
      <Icon name="folder" size={13} color={COLORS.faint} />
      <text
        style={{
          fontSize: 12,
          fontFamily: FONT.mono,
          color: COLORS.faint,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          overflow: 'hidden',
          pointerEvents: 'none',
        }}
      >
        {path}
      </text>
    </div>
  )
}

/** pills 容器（原型 .pills：wrap + gap 8 + margin-top 16） */
export function HomePills({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        justifyContent: 'center',
        marginTop: 16,
        maxWidth: 560,
      }}
    >
      {children}
    </div>
  )
}

/** 预设 pill（原型 .pills button：h30 / padding 0 13 / radius full / tile 底） */
export function Pill({
  icon,
  label,
  testId,
  onClick,
}: {
  icon: IconName
  label: string
  testId: string
  onClick: () => void
}) {
  return (
    <div
      tabIndex={0}
      testId={testId}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'enter' || e.key === 'space') onClick()
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        height: 30,
        paddingLeft: 13,
        paddingRight: 13,
        borderRadius: 9999,
        backgroundColor: COLORS.tile,
        cursor: 'pointer',
        hover: { backgroundColor: COLORS.tileHover },
      }}
    >
      <Icon name={icon} size={13} color={COLORS.muted} />
      <text
        style={{
          fontSize: 12,
          fontFamily: FONT.ui,
          color: COLORS.text,
          pointerEvents: 'none',
        }}
      >
        {label}
      </text>
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

  return (
    <HomeShell testId="home-empty">
      <HomeTitle>想做点什么？</HomeTitle>
      <HomeSub>从左侧选择工作区，或直接开始一个新任务</HomeSub>
      <HomeContext path={cwd ?? '未归属 · 无项目目录'} />
      <HomePills>
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
    </HomeShell>
  )
}
