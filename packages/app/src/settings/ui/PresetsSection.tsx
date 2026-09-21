/**
 * settings/ui/PresetsSection.tsx — 设置 Presets 分区（settings-ui.md §7 预设编辑器；T3.1）。
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

import { useState } from 'react'
import type { ReactElement } from 'react'

import { Badge, IconButton, SelectField, TextInput, COLORS, FONT } from '@jagent/ui'
import type { TerminalPreset } from '../../threads/presets'
import {
  presetCommandSummary,
  presetFieldModified,
  presetMatches,
  presetModified,
} from '../../threads/presets'
import type { SettingsStore } from '../store'
import { useSettings } from '../useSettings'
import {
  FieldRow,
  LinesField,
  ListEditorAdd,
  ListEditorCard,
  ListEditorEmpty,
  ListEditorError,
  ModDot,
} from './listEditorParts'

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

      <ListEditorError err={err} hit={(p) => p.startsWith('presets.')} />

      {visible.length === 0 && query ? (
        <ListEditorEmpty text="无匹配预设" />
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

      <ListEditorAdd
        testId="add-preset"
        label="新增预设"
        onAdd={() => setExpandedId(settings.addPreset({ label: `自定义 ${customCount + 1}` }))}
      />
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
  return (
    <ListEditorCard
      testIdPrefix="preset"
      id={p.id}
      label={p.label}
      summary={presetCommandSummary(p)}
      expanded={expanded}
      onToggle={onToggle}
      badges={
        <>
          {modified ? <ModDot testId={`mod-dot-${p.id}`} /> : null}
          <Badge variant={p.builtin ? 'builtin' : 'custom'}>{p.builtin ? '内置' : '自定义'}</Badge>
        </>
      }
      actions={(suppress) => (
        <>
          <IconButton
            name="copy"
            label={`复制预设 ${p.label} 为自定义副本`}
            testId={`preset-copy-${p.id}`}
            onClick={() => {
              suppress()
              onDuplicated(settings.duplicatePreset(p.id))
            }}
          />
          {p.builtin && modified ? (
            <IconButton
              name="reset"
              label={`重置预设 ${p.label} 为出厂值`}
              testId={`preset-reset-${p.id}`}
              onClick={() => {
                suppress()
                settings.resetPreset(p.id)
              }}
            />
          ) : null}
          {!p.builtin ? (
            <IconButton
              name="trash"
              danger
              label={`删除预设 ${p.label}`}
              testId={`preset-delete-${p.id}`}
              onClick={() => {
                suppress()
                settings.deletePreset(p.id)
                onDeleted()
              }}
            />
          ) : null}
        </>
      )}
    >
      <PresetEditor p={p} settings={settings} />
    </ListEditorCard>
  )
}

// ── 展开态编辑器（§7 字段表）─────────────────────────────────────────

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
    <div>
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
        <text
          style={{
            fontSize: 11.5,
            fontFamily: FONT.ui,
            color: COLORS.muted,
            lineHeight: 16,
            whiteSpace: 'normal',
          }}
        >
          凭证走 shell 环境——设置里不出现 API key 输入框。initCommand 作为普通键入打进 shell，不是
          exec 替换进程。
        </text>
      </div>
    </div>
  )
}
