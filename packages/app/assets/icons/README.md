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
- **Windows**：在 Windows 上执行 `bun run build`；`bun build --compile --windows-icon` 将 `app.ico` 写入 `.exe` 资源。Bun 的资源修改依赖 Windows API，跨系统构建会提前报错（即使带 `--skip-native`）。见 [Bun 文档](https://bun.com/docs/bundler/executables#windows-specific-flags)。
- **Linux**：提供 PNG/SVG，但当前输出裸二进制，没有 `.desktop`/AppImage 安装集成，不会自动显示图标。

若 Finder / Dock 仍缓存旧图标，退出旧进程后使用新生成的 `.app`；必要时从 Dock 移除旧项并重新拖入。`bun run dev` 仍由 Bun 宿主启动，不等同于打包应用的图标。
