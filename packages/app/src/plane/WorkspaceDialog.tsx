/**
 * plane/WorkspaceDialog.tsx — 添加工作区弹窗（Phase W7；原型
 * workspace-dialog）。
 *
 * 替代 W2 的侧栏内联表单：名称（空 = 目录名兜底，store 单点）+ 目录
 * （必填绝对路径；「浏览…」= W3 原生目录选择 seam 注入）+ 重复目录
 * 校验（原型同款：尾斜杠归一后比对既有工作区）。
 */

import { useState } from 'react'

import {
  Icon,
  Modal,
  ModalActions,
  ModalBody,
  ModalHeading,
  TextInput,
  COLORS,
  FONT,
} from '@jagent/ui'
import type { ThreadStore, Workspace } from '../threads/store'
import type { DirectoryPicker } from './WorkspaceList'

/** 绝对路径校验（原型正则同款）：~/…、/…、C:\\…、\\\\… */
const ABSOLUTE_PATH = /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)/

export function WorkspaceDialog({
  store,
  workspaces,
  pickDirectory,
  onClose,
}: {
  store: ThreadStore
  workspaces: Workspace[]
  /** 原生目录选择 seam（缺省隐藏「浏览…」——纯手输路径） */
  pickDirectory?: DirectoryPicker
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [nameError, setNameError] = useState('')
  const [pathError, setPathError] = useState('')
  const [picking, setPicking] = useState(false)

  const normalized = (p: string) => p.replace(/[\\/]+$/, '')
  const validate = (): boolean => {
    setNameError('')
    setPathError('')
    if (!name.trim() && !path.trim()) {
      setNameError('请填写名称或项目目录。')
      return false
    }
    if (path.trim() === '') {
      setPathError('请填写项目目录。')
      return false
    }
    if (!ABSOLUTE_PATH.test(path.trim())) {
      setPathError('请填写绝对路径，例如 ~/Projects/app、/Projects/app 或 C:\\Projects\\app。')
      return false
    }
    if (workspaces.some((w) => normalized(w.path) === normalized(path.trim()))) {
      setPathError('此目录已有工作区，请从左侧选择，或填写其他目录。')
      return false
    }
    return true
  }

  const browse = () => {
    if (!pickDirectory || picking) return
    setPicking(true)
    pickDirectory()
      .then((picked) => {
        if (picked) {
          setPath(picked)
          if (!name.trim()) {
            const base = picked.split(/[\\/]/).filter(Boolean).pop()
            if (base) setName(base)
          }
        }
      })
      .finally(() => setPicking(false))
  }

  const submit = () => {
    if (!validate()) return
    store.addWorkspace(name.trim(), path.trim())
    onClose()
  }

  return (
    <Modal width={440} onClose={onClose}>
      <ModalHeading title="添加工作区" onClose={onClose} />
      <ModalBody>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <text style={{ fontSize: 11, fontFamily: FONT.ui, color: COLORS.muted }}>
            工作区名称（空 = 目录名）
          </text>
          <TextInput
            testId="workspace-dialog-name"
            value={name}
            onChange={(v) => {
              setName(v)
              setNameError('')
            }}
            placeholder="my-project"
            width="fill"
          />
          {nameError ? (
            <text
              testId="workspace-dialog-name-error"
              style={{ fontSize: 10, fontFamily: FONT.ui, color: COLORS.bell }}
            >
              {nameError}
            </text>
          ) : null}

          <text style={{ fontSize: 11, fontFamily: FONT.ui, color: COLORS.muted, marginTop: 4 }}>
            项目目录（绝对路径）
          </text>
          <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>
            <div style={{ flexGrow: 1, minWidth: 0 }}>
              <TextInput
                testId="workspace-dialog-path"
                value={path}
                onChange={(v) => {
                  setPath(v)
                  setPathError('')
                }}
                onSubmit={submit}
                placeholder="/Users/you/project"
                mono
                width="fill"
              />
            </div>
            {pickDirectory ? (
              <div
                tabIndex={0}
                testId="workspace-dialog-browse"
                onClick={browse}
                onKeyDown={(e) => {
                  if (e.key === 'enter' || e.key === 'space') browse()
                }}
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  height: 28,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 4,
                  borderWidth: 1,
                  borderColor: COLORS.borderSubtle,
                  backgroundColor: COLORS.surface,
                  cursor: picking ? 'default' : 'pointer',
                  opacity: picking ? 0.5 : 1,
                  hover: { backgroundColor: COLORS.surfaceHover },
                  flexShrink: 0,
                }}
              >
                <Icon name="folder" size={12} color={COLORS.accent} />
                <text
                  style={{
                    fontSize: 11,
                    fontFamily: FONT.ui,
                    color: COLORS.text,
                    pointerEvents: 'none',
                  }}
                >
                  浏览…
                </text>
              </div>
            ) : null}
          </div>
          {pathError ? (
            <text
              testId="workspace-dialog-path-error"
              style={{
                fontSize: 10,
                fontFamily: FONT.ui,
                color: COLORS.bell,
                whiteSpace: 'normal',
              }}
            >
              {pathError}
            </text>
          ) : null}
        </div>
        <ModalActions
          actions={[
            { label: '取消', onClick: onClose },
            { label: '添加工作区', primary: true, onClick: submit },
          ]}
        />
      </ModalBody>
    </Modal>
  )
}
