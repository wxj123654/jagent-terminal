/**
 * surfaces/PresetsSection.tsx — 设置 Presets 分区（settings-ui.md §7 预设编辑器；T3.1）。
 *
 * 顶部 `+` 按钮默认（presets.plusDefault，null=跟随 lastUsedPreset）+ 预设列表 +
 * 底部「新增预设」。行收起态：图标 + label + mono 命令摘要 + 徽章（内置/自定义、
 * modified 蓝点）+ 行尾动作（复制 / 重置[仅内置且改过] / 删除[仅自定义]）。展开态
 * 六字段编辑器：label / program / args(每行一个) / env(每行 KEY=VALUE) /
 * initCommand / cwd——即时生效（onChange → store.updatePreset；args/env 走
 * draft + onBlur 提交，NumberInput 同款中间态纪律）。
 *
 * 规则单点在 settings/store.ts（addPreset/deletePreset/…：plusDefault 回退、
 * builtin 不可删、副本后缀）；本文件纯展示层。lastUsedPreset 是 ThreadStore
 * 运行时态——本分区（及 settings/ 目录）物理上不接触它。
 *
 * GPUIX 事件（T2.3 结论 + T3.1 实测修正）：head 是命中容器（显式
 * backgroundColor）；label/cmd 摘要 pe:none 穿透。**子元素自带 listener 时
 * click 沿链冒泡到父 listener**（IconButton onClick 触发后 head 的 onClick
 * 也触发；纯 paint 装饰才不冒泡）——JS 无 stopPropagation 面，用抑制 ref：
 * 按钮 handler 先置位（冒泡顺序 deepest-first），head 查后消费。
 * writeError：path 以 presets. 开头 → 分区顶部红条（回滚已由 store 层完成）。
 */

import { useRef, useState } from 'react'
import type { ReactElement } from 'react'

import type { SettingsStore } from '../settings/store'
import { useSettings } from '../settings/useSettings'
import type { TerminalPreset } from '../threads/presets'
import {
  presetCommandSummary,
  presetFieldModified,
  presetMatches,
  presetModified,
} from '../threads/presets'
import { Badge } from '../ui/Badge'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { SelectField } from '../ui/Select'
import { Textarea } from '../ui/Textarea'
import { TextInput } from '../ui/TextInput'
import { COLORS, FONT } from '../ui/tokens'

export function PresetsSection({
  settings,
  query,
}: {
  settings: SettingsStore
  /** 搜索子串（行级过滤；null = 不过滤） */
  query: string | null
}): ReactElement {
  const snap = useSettings(settings)
  const items = snap.presets.items
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const err = settings.writeError()

  const visible = query ? items.filter((p) => presetMatches(p, query)) : items
  const customCount = items.filter((p) => !p.builtin).length

  return (
    <div>
      {/* + 按钮默认（§7 顶部一行） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          marginBottom: 6,
        }}
      >
        <text style={{ fontSize: 12.5, fontFamily: FONT.ui, color: COLORS.text, flexShrink: 0 }}>
          「+」按钮默认预设
        </text>
        <SelectField
          testId="plus-default"
          value={snap.presets.plusDefault ?? ''}
          options={[
            { value: '', label: '跟随上次使用' },
            ...items.map((p) => ({ value: p.id, label: p.label })),
          ]}
          onChange={(v) => settings.patch('presets.plusDefault', v === '' ? null : v)}
        />
      </div>

      <text
        style={{
          fontSize: 12,
          fontFamily: FONT.ui,
          color: COLORS.muted,
          marginTop: 10,
          marginBottom: 4,
        }}
      >
        预设列表
      </text>

      {err && err.path.startsWith('presets.') ? (
        <text
          testId="writeerror"
          style={{ fontSize: 11, fontFamily: FONT.mono, color: COLORS.bell, marginBottom: 6 }}
        >
          {`写入失败：${err.message}`}
        </text>
      ) : null}

      {visible.length === 0 && query ? (
        <text
          testId="settings-empty-hits"
          style={{ fontSize: 12, fontFamily: FONT.ui, color: COLORS.muted, padding: 8 }}
        >
          无匹配预设
        </text>
      ) : (
        visible.map((p) => (
          <PresetCard
            key={p.id}
            p={p}
            settings={settings}
            expanded={expandedId === p.id}
            onToggle={() => setExpandedId(expandedId === p.id ? null : p.id)}
            onDeleted={() => setExpandedId(null)}
            onDuplicated={(nid) => setExpandedId(nid)}
          />
        ))
      )}

      {/* 新增预设（虚线框按钮，原型 .btn-add） */}
      <div
        testId="add-preset"
        tabIndex={0}
        onClick={() => setExpandedId(settings.addPreset({ label: `自定义 ${customCount + 1}` }))}
        onKeyDown={(e) => {
          if (e.key === 'enter' || e.key === 'space') {
            setExpandedId(settings.addPreset({ label: `自定义 ${customCount + 1}` }))
          }
        }}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          height: 30,
          paddingLeft: 12,
          paddingRight: 12,
          marginTop: 2,
          borderWidth: 1,
          borderColor: COLORS.borderSubtle,
          borderRadius: 4,
          cursor: 'pointer',
          hover: { borderColor: COLORS.accent, color: COLORS.textBright },
        }}
      >
        <Icon name="plus" size={12} color={COLORS.muted} />
        <text
          style={{
            fontSize: 12.5,
            fontFamily: FONT.ui,
            color: COLORS.muted,
            pointerEvents: 'none',
          }}
        >
          新增预设
        </text>
      </div>
    </div>
  )
}

// ── 预设卡（收起态 head + 可选展开编辑器）──────────────────────────

function PresetCard({
  p,
  settings,
  expanded,
  onToggle,
  onDeleted,
  onDuplicated,
}: {
  p: TerminalPreset
  settings: SettingsStore
  expanded: boolean
  onToggle: () => void
  onDeleted: () => void
  onDuplicated: (newId: string) => void
}): ReactElement {
  const modified = presetModified(p)
  // 冒泡抑制：行内按钮 click 会冒到 head 的 onClick（见文件头），按钮先置位、
  // head 消费后跳过本次 toggle。React 状态同步提交保证同批可靠。
  const suppressHead = useRef(false)
  const guarded = (action: () => void) => () => {
    suppressHead.current = true
    action()
  }

  return (
    <div
      testId={`preset-card-${p.id}`}
      style={{
        borderWidth: 1,
        borderColor: expanded ? COLORS.borderSubtle : COLORS.border,
        borderRadius: 6,
        marginBottom: 8,
        backgroundColor: COLORS.sidebar,
      }}
    >
      {/* head：命中容器（显式 backgroundColor；装饰 pe:none 穿透） */}
      <div
        testId={`preset-head-${p.id}`}
        tabIndex={0}
        onClick={() => {
          if (suppressHead.current) {
            suppressHead.current = false
            return
          }
          onToggle()
        }}
        onKeyDown={(e) => {
          if (e.key === 'enter' || e.key === 'space') onToggle()
        }}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 38,
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 12,
          paddingRight: 8,
          borderTopLeftRadius: 6,
          borderTopRightRadius: 6,
          backgroundColor: COLORS.sidebar,
          cursor: 'pointer',
          hover: { backgroundColor: COLORS.surfaceHover },
        }}
      >
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} color={COLORS.muted} />
        <text
          style={{
            fontSize: 13,
            fontFamily: FONT.ui,
            color: COLORS.textBright,
            flexShrink: 0,
            pointerEvents: 'none',
          }}
        >
          {p.label}
        </text>
        <text
          style={{
            flexGrow: 1,
            minWidth: 0,
            fontSize: 11.5,
            fontFamily: FONT.mono,
            color: COLORS.muted,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {presetCommandSummary(p)}
        </text>
        {modified ? <ModDot testId={`mod-dot-${p.id}`} /> : null}
        <Badge variant={p.builtin ? 'builtin' : 'custom'}>{p.builtin ? '内置' : '自定义'}</Badge>
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 2,
            flexShrink: 0,
          }}
        >
          <IconButton
            name="copy"
            label={`复制预设 ${p.label} 为自定义副本`}
            testId={`preset-copy-${p.id}`}
            onClick={guarded(() => onDuplicated(settings.duplicatePreset(p.id)))}
          />
          {p.builtin && modified ? (
            <IconButton
              name="reset"
              label={`重置预设 ${p.label} 为出厂值`}
              testId={`preset-reset-${p.id}`}
              onClick={guarded(() => settings.resetPreset(p.id))}
            />
          ) : null}
          {!p.builtin ? (
            <IconButton
              name="trash"
              danger
              label={`删除预设 ${p.label}`}
              testId={`preset-delete-${p.id}`}
              onClick={guarded(() => {
                settings.deletePreset(p.id)
                onDeleted()
              })}
            />
          ) : null}
        </div>
      </div>

      {expanded ? <PresetEditor p={p} settings={settings} /> : null}
    </div>
  )
}

/** modified 蓝点（原型 .mod-dot；形状区别于颜色——行级徽章旁 + 字段行尾） */
function ModDot({ testId }: { testId?: string }): ReactElement {
  return (
    <div
      testId={testId}
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        backgroundColor: COLORS.accent,
        flexShrink: 0,
      }}
    />
  )
}

// ── 展开态编辑器（§7 字段表）───────────────────────────────────────

function PresetEditor({
  p,
  settings,
}: {
  p: TerminalPreset
  settings: SettingsStore
}): ReactElement {
  const update = (patch: Parameters<SettingsStore['updatePreset']>[1]) =>
    settings.updatePreset(p.id, patch)

  return (
    <div
      testId={`preset-editor-${p.id}`}
      style={{
        borderTopWidth: 1,
        borderColor: COLORS.border,
        padding: 12,
        paddingLeft: 14,
        paddingBottom: 14,
        backgroundColor: COLORS.app,
      }}
    >
      <FieldRow label="Label" name="label" modified={presetFieldModified(p, 'label')}>
        <TextInput
          testId={`field-label-${p.id}`}
          value={p.label}
          placeholder="显示名"
          onChange={(v) => update({ label: v })}
        />
      </FieldRow>
      <FieldRow label="Program" name="program" modified={presetFieldModified(p, 'program')}>
        <TextInput
          testId={`field-program-${p.id}`}
          mono
          value={p.program ?? ''}
          placeholder="可执行文件名或绝对路径；留空 = 系统默认 shell"
          onChange={(v) => update({ program: v })}
        />
      </FieldRow>
      <FieldRow label="Args" name="args[]" modified={presetFieldModified(p, 'args')}>
        <LinesField
          testId={`field-args-${p.id}`}
          placeholder="每行一个参数"
          serialize={() => (p.args ?? []).join('\n')}
          parse={(text) => text.split('\n')}
          commit={(v) => update({ args: v as string[] })}
        />
      </FieldRow>
      <FieldRow label="Env" name="env" modified={presetFieldModified(p, 'env')}>
        <LinesField
          testId={`field-env-${p.id}`}
          placeholder="每行 KEY=VALUE，如 AMP_FORCE_BEL=1"
          serialize={() =>
            Object.entries(p.env ?? {})
              .map(([k, v]) => `${k}=${v}`)
              .join('\n')
          }
          parse={(text) => {
            const env: Record<string, string> = {}
            for (const line of text.split('\n')) {
              const s = line.trim()
              if (!s) continue
              const i = s.indexOf('=')
              if (i <= 0) continue // 无 = 或空 key 的行忽略（行式语法约定）
              env[s.slice(0, i)] = s.slice(i + 1)
            }
            return env
          }}
          commit={(v) => update({ env: v as Record<string, string> })}
        />
      </FieldRow>
      <FieldRow
        label="InitCommand"
        name="initCommand"
        modified={presetFieldModified(p, 'initCommand')}
      >
        <TextInput
          testId={`field-initCommand-${p.id}`}
          mono
          value={p.initCommand ?? ''}
          placeholder="作为普通键入打进 shell，不是 exec 替换进程"
          onChange={(v) => update({ initCommand: v })}
        />
      </FieldRow>
      <FieldRow label="Cwd" name="cwd?" modified={presetFieldModified(p, 'cwd')}>
        <TextInput
          testId={`field-cwd-${p.id}`}
          mono
          value={p.cwd ?? ''}
          placeholder="可选；默认项目根目录"
          onChange={(v) => update({ cwd: v })}
        />
      </FieldRow>

      <div style={{ display: 'flex', flexDirection: 'row', gap: 6, marginTop: 10 }}>
        <text style={{ fontSize: 11.5, fontFamily: FONT.ui, color: COLORS.muted, lineHeight: 16 }}>
          凭证走 shell 环境——设置里不出现 API key 输入框。initCommand 作为普通键入打进 shell，不是
          exec 替换进程。
        </text>
      </div>
    </div>
  )
}

/** 编辑器字段行：label 列（名称 + key + 字段级蓝点）+ 控件 */
function FieldRow({
  label,
  name,
  modified,
  children,
}: {
  label: string
  /** 字段名 mono 小字（原型 .f-key） */
  name: string
  modified: boolean
  children: ReactElement
}): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', marginBottom: 9 }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          width: 130,
          flexShrink: 0,
        }}
      >
        <text
          style={{ fontSize: 12.5, fontFamily: FONT.ui, color: COLORS.text, pointerEvents: 'none' }}
        >
          {label}
        </text>
        <text
          style={{
            fontSize: 10.5,
            fontFamily: FONT.mono,
            color: COLORS.muted,
            pointerEvents: 'none',
          }}
        >
          {name}
        </text>
        {modified ? <ModDot /> : null}
      </div>
      {children}
    </div>
  )
}

/**
 * 行式字段（args / env）：**即时提交**（onChange → parse → store，行级归一在
 * store 层：空串行过滤）+ draft 只管显示（编辑中间态的尾随换行/空行不回写
 * 受控值，无光标跳动）；onBlur 仅归一显示（draft → committed）。
 * blur 不可依赖的背景：TestGpuixRenderer 路径点击/焦点转移均不派发 React
 * focus/blur 事件（T2.6 autoFocus 同源限制，实测），提交面必须不依赖 blur。
 */
function LinesField({
  testId,
  placeholder,
  serialize,
  parse,
  commit,
}: {
  testId: string
  placeholder: string
  /** 当前 store 值 → 规范文本 */
  serialize: () => string
  /** 提交文本 → store 值（行级过滤在 store 层） */
  parse: (text: string) => string[] | Record<string, string>
  /** 即时提交 */
  commit: (parsed: string[] | Record<string, string>) => void
}): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const committed = serialize()

  return (
    <Textarea
      testId={testId}
      value={draft ?? committed}
      placeholder={placeholder}
      minRows={2}
      onChange={(v) => {
        setDraft(v)
        commit(parse(v))
      }}
      onBlur={() => setDraft(null)}
    />
  )
}
