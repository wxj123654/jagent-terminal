# JAgent 应用图标

![JAgent](app-256.png)

## 设计

- **符号**：白色终端提示符 `>` + 蓝色几何小写 `j`；不依赖字体，也不使用第三方品牌图形。
- **配色**：延续正式应用的 One Dark 色系，石墨色底、`#61AFEF` 蓝色、`#EDF2F7` 前景。背景只使用轻微纵向明暗变化，没有发光或外部阴影。
- **外形**：1024-unit 正方形画布，四周 96-unit 透明安全区，连续曲率圆角底。提示符与 j 的粗线条保留小尺寸辨识度。
- **范围**：仅用于应用包的 Finder / Dock / Explorer 图标，不更改正式应用界面或 `design/DESIGN.md` 的原型设计系统。
- **来源**：为 JAgent 绘制的原创 SVG，随项目许可证发布；无下载图片、字体或生成式图像。

## 文件

| 文件 | 用途 |
|---|---|
| `app.svg` | 唯一可编辑源稿，1024 × 1024 |
| `app-{size}.png` | 16 / 24 / 32 / 48 / 64 / 128 / 256 / 512 / 1024 px，8-bit RGBA |
| `app.icns` | macOS 标准 + Retina 图像（16pt 到 512pt） |
| `app.ico` | Windows 七档尺寸，16 到 256 px，32-bit PNG 帧 |

预览：[`design/app-icon.html`](../../../../design/app-icon.html)，对照深浅底与小尺寸。

## 更新与生成

只编辑 `app.svg`，然后在仓库根目录运行：

```bash
bun run icons
bun test scripts/icons.test.ts
```

生成器使用开发依赖 `@resvg/resvg-js`，无浏览器、ImageMagick、Python 或 macOS 工具依赖。普通打包直接使用已入库生成物，不会重新渲染图标。**源稿和所有生成物必须一起提交**；测试会检查 PNG 像素、源稿 SHA-256、PNG CRC、ICO 索引以及 ICNS 的标准/Retina 表示。

每个 PNG 的 `tEXt` 元数据含原创来源和 SVG SHA-256；ICO/ICNS 内嵌相同 PNG，保留来源。

## 打包接线

- **macOS**：`bun run build --app`；复制 `app.icns` 到 `JAgent.app/Contents/Resources/`，`Info.plist` 的 `CFBundleIconFile` 指向它，复制后再签名。裸 Mach-O 文件本身不显示应用图标，请使用 `.app`。
- **Windows**：在 Windows 上执行 `bun run build`（打包前先退出正在运行的 `jagent.exe`，否则 bun 移动产物时会报 `EPERM`；`build.ts` 会提前探锁并给中文提示）；`bun build --compile --windows-icon` 将 `app.ico` 写入 `.exe` 资源。Bun 的资源修改依赖 Windows API，跨系统构建会提前报错（即使带 `--skip-native`）。见 [Bun 文档](https://bun.com/docs/bundler/executables#windows-specific-flags)。
  - ⚠️ **bun 写入 PE 的 `RT_GROUP_ICON` 帧声明是错的**（bun 1.3.13 实测）：一个 ICO 会变成两个图标组，主组 `IDI_MYICON` 的 `dwBytesInRes` 只声明第一帧（=16px）。Windows 据此认为「这个图标最大只有 16×16」，把 16px 放大到任务栏需要的 32px（96 DPI）——**任务栏图标发糊的根因，与源稿/生成物无关**。`scripts/build.ts` 在打包后调用 `scripts/pe-icon-resources.ts` 把各组指向含帧最多的 blob（幂等，可用 `--check` 复核）。
  - 另：zed/gpui 的 `load_icon()` 用 `LoadImageW(module, MAKEINTRESOURCE(1), …)` 取窗口图标，而 bun 写的组名是 `IDI_MYICON` / `#0`（没有序号 1）——窗口自身拿不到 HICON（`WM_GETICON` 返回 0），任务栏走**回退到 exe 图标**的路径；上面的帧声明修正正是修好了这条回退路径。
  - 若任务栏 / 资源管理器仍显示旧图标：那是 Windows 图标缓存，重启 `explorer.exe` 或取消固定后重新固定即可。
- **Linux**：提供 PNG/SVG，但当前输出裸二进制，没有 `.desktop`/AppImage 安装集成，不会自动显示图标。

若 Finder / Dock 仍缓存旧图标，退出旧进程后使用新生成的 `.app`；必要时从 Dock 移除旧项并重新拖入。`bun run dev` 仍由 Bun 宿主启动，不等同于打包应用的图标。
