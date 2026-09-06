---
name: j-agent Workspace Prototype
description: 工作区侧栏与多种 TUI 会话的深色桌面原型
colors:
  sidebar: "#21252b"
  terminal: "#1a1d23"
  surface: "#282c34"
  hover: "#2c313a"
  selected: "#303844"
  border: "#363c47"
  text: "#bdc4cf"
  bright: "#e2e6ed"
  muted: "#9ca5b3"
  accent: "#83bff1"
  on-accent: "#16212d"
  green: "#a6ce8c"
  red: "#ee929a"
  amber: "#e5c07b"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  terminal:
    fontFamily: '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.85
rounded:
  control: "5px"
  navigation: "6px"
  dialog: "10px"
  window: "11px"
spacing:
  small: "8px"
  medium: "12px"
  large: "20px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "7px 13px"
  button-secondary:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.bright}"
    rounded: "{rounded.control}"
    padding: "7px 13px"
  session-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.bright}"
    rounded: "{rounded.control}"
---

# Design System: j-agent Workspace Prototype

## Overview

本记录从 `workspace-plane.html` 的实际代码与 Chrome 截图提取，**只约束此工作区原型**。不要求旧原型或正式 GPUIX 应用立即同步，也不覆盖 `packages/app/src/ui/tokens.ts`。

延续既有 One Dark 开发者界面：导航层清楚、控件紧凑，工具内容占据主要空间。保留平面深色分区，以可读文字、缩进、轻量选中背景建立层级，不用装饰性卡片替代工作内容。

## Colors

- **accent / on-accent**：焦点、主要操作及当前工具标识；不用于大面积背景装饰。
- **sidebar / terminal / surface**：分别承担应用导航、工具内容和抬升提示。
- **text / bright / muted**：普通、强调和次级文字。原型将次级文字提亮，保证常见选中背景上的可读性。
- **green / red / amber**：终端语义、通知及差异；图标、文字或符号同时表达状态，不仅依靠颜色。
- **border**：控件与浮层边界。列表分组优先使用间距，避免处处画框。

## Typography

导航使用系统 UI 字体，代码和 TUI 内容使用系统等宽字体；没有在线字体请求。等宽字体承担代码与终端本身，而非装饰标签。

界面文字以 12–13px 为主，辅助说明 11px；对话框标题 15px，空工作区标题 23px。移动预览表单输入 16px，避免浏览器自动放大。长路径可换行，侧栏标题单行省略并保留完整 accessible name 和 title。

## Layout

单窗口、单工具内容区。常规侧栏 276px，1100px 以下为 250px；760px 以下改为模态抽屉。全局标题栏 44px，窄屏 48px。

导航工作区以纵向间距区分，会话用缩进、细分组线和选中背景表达归属。展开箭头、项目选择、创建会话为独立操作。原型的具体体验流程见 `workspace-plane.md`，不将其当作所有页面的通用结构。

## Elevation & Depth

普通界面靠底色区分层级。窗口、对话框与临时提示才使用柔和、有偏移的阴影；没有发光描边和装饰性渐变。对话框使用浏览器 top layer，避免被滚动容器裁切。

## Shapes

紧凑圆角控件与细线 SVG 图标。图标统一为 24-unit viewBox、1.65 描边，在界面中以 12–18px 显示；可交互图标外有独立命中区域。

## Components

- **按钮**：主要按钮用于空工作区的启动动作；侧栏新建按钮采用中性背景。所有控件有 hover 和可见焦点，按压不改变布局。
- **工作区与会话行**：当前状态用 `aria-current`，展开用 `aria-expanded`。会话管理入口在选中、hover、focus-within 时可见，窄屏常显。
- **表单**：可见 label、独立提示、字段级错误与焦点定位；错误不是只在通知条里提示。
- **浮层**：原生 `<dialog>` 承担工具选择、短表单和窄屏工作区导航；Esc 可退出。工具列表支持过滤与方向键选择。
- **反馈**：普通颜色过渡 140ms ease-out；对话框淡入 / 小幅位移 160ms。reduced-motion 下全部取消。
- **终端示意**：工具各自的内容与输入区保持在工具表面内部；模拟内容始终有明确标记。

## Do's and Don'ts

- **Do** 保持目录、工作区、会话三者归属明确，使用用户可理解的项目和工具名称。
- **Do** 提供键盘等价操作，并尊重中文输入法组合阶段和终端控制键。
- **Do** 在狭窄预览中改变导航结构，而不是把桌面窗口整体缩小。
- **Don't** 将原型中的 HTML 文字布局当作正式终端仿真方案。
- **Don't** 从静态 TUI 输出推断真实任务状态，或把示例数据呈现为真实执行结果。
- **Don't** 让工作区局部原型的尺寸与 token 自动覆盖正式应用的已拍板设计。
