/**
 * scripts/build.ts — 根目录打包入口：native (.node) + 多平台单文件可执行。
 *
 * 产物：dist/<platform>/jagent[.exe]（自包含：Bun 运行时 + 嵌入的 .node）。
 *
 * 用法：
 *   bun run build                                  # 当前平台（裸二进制）
 *   bun run build --target darwin-x64              # 交叉（仅 darwin↔darwin，见下）
 *   bun run build --app                            # macOS 目标额外套 JAgent.app 安装壳
 *   bun run build --skip-native                    # 跳过 Rust 构建（纯 JS/TS 改动）
 *
 * 平台规则：
 *   - 缺省 --target = 宿主平台（process.platform/arch）。
 *   - 交叉编译仅支持 darwin↔darwin（macOS 上 rustup 加 target 即可，MSVC/glibc
 *     无法在 mac 上链接）：其他跨端直接报错——去目标平台机器上跑，或走 CI。
 *   - native 构建参数随平台分化：Linux 追加 --no-default-features（gpuix
 *     test-support 的 wgpu 图像回读在 Linux 未落地，上游 CI 同样禁用）。
 *   - --app 在 compile 后增加安装壳（Info.plist + app.icns + PkgInfo + adhoc codesign）；
 *     Windows 自动嵌入 app.ico（必须在 Windows 构建，Bun 依赖 Windows 资源 API）。
 *     Windows/Linux 安装包形态（installer/AppImage）暂未实现，输出裸二进制。
 *   - Windows 的 compile 之后另做两步 PE 收尾（scripts/pe-*.ts）：
 *     ① RT_GROUP_ICON 帧声明补齐（`--windows-icon` 只给主组声明 1 帧，
 *        会让任务栏拿 16px 放大 → 图标发糊）；
 *     ② Subsystem CUI→GUI（不改会在双击启动时多一个终端窗口）。
 *     bun 1.3.13 的 `--windows-hide-console` 实测不生效；GUI 化后所有
 *     spawn 必须 windowsHide（仓库内 git/ACP/系统打开已处理）。
 *
 * 体积注记：symbol 剥离由根 Cargo.toml [profile.release] strip = "symbols"
 * 统一处理（不用 napi --strip：它传 -C link-arg=-s，MSVC link.exe 不认识）。
 */

import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { patchIconResources } from './pe-icon-resources'
import { describeSubsystem, patchWindowsGuiSubsystem } from './pe-subsystem'
import { REPO_ROOT } from './refs-config'

// ── 平台表 ────────────────────────────────────────────────────────────────
// target       用户输入/目录名；rust    cargo --target 三元组（native 用）
// bun          bun build --compile 的 --target；napi    .node 文件的平台段
type Platform = {
  target: string
  rust: string
  bun: string
  napi: string
  exe: string
  darwin: boolean
}

const PLATFORMS: Platform[] = [
  {
    target: 'darwin-arm64',
    rust: 'aarch64-apple-darwin',
    bun: 'bun-darwin-arm64',
    napi: 'darwin-arm64',
    exe: 'jagent',
    darwin: true,
  },
  {
    target: 'darwin-x64',
    rust: 'x86_64-apple-darwin',
    bun: 'bun-darwin-x64',
    napi: 'darwin-x64',
    exe: 'jagent',
    darwin: true,
  },
  {
    target: 'windows-x64',
    rust: 'x86_64-pc-windows-msvc',
    bun: 'bun-windows-x64',
    napi: 'win32-x64-msvc',
    exe: 'jagent.exe',
    darwin: false,
  },
  {
    target: 'linux-x64-gnu',
    rust: 'x86_64-unknown-linux-gnu',
    bun: 'bun-linux-x64',
    napi: 'linux-x64-gnu',
    exe: 'jagent',
    darwin: false,
  },
  {
    target: 'linux-arm64-gnu',
    rust: 'aarch64-unknown-linux-gnu',
    bun: 'bun-linux-arm64',
    napi: 'linux-arm64-gnu',
    exe: 'jagent',
    darwin: false,
  },
]

// 宿主平台归一化到 PLATFORMS 的命名（win32→windows、linux 补 -gnu 后缀）
const HOST =
  process.platform === 'win32'
    ? `windows-${process.arch}`
    : process.platform === 'linux'
      ? `linux-${process.arch}-gnu`
      : `${process.platform}-${process.arch}`
const argv = process.argv.slice(2)
const WANT_APP = argv.includes('--app')
const SKIP_NATIVE = argv.includes('--skip-native')
const targetIdx = argv.indexOf('--target')
const TARGET_NAME = targetIdx >= 0 ? argv[targetIdx + 1] : HOST
const platform = PLATFORMS.find((p) => p.target === TARGET_NAME)
if (!platform) {
  console.error(
    `未知 --target "${TARGET_NAME}"；可选：${PLATFORMS.map((p) => p.target).join(' | ')}`,
  )
  process.exit(1)
}

const NATIVE_DIR = join(REPO_ROOT, 'packages/native')
const APP_ENTRY = join('packages/app/src/main.tsx') // 相对 REPO_ROOT
const DIST_DIR = join(REPO_ROOT, 'dist', platform.target)
const NODE_FILE = join(NATIVE_DIR, `jagent-native.${platform.napi}.node`)
const ICON_DIR = join(REPO_ROOT, 'packages/app/assets/icons')

// ── 工具 ──────────────────────────────────────────────────────────────────

/** 跑命令：stdout/stderr 直通终端（Rust 构建耗时长，要看到实时进度），非零退出直接终止。 */
async function runLive(cmd: string, args: string[], cwd: string) {
  const proc = Bun.spawn([cmd, ...args], { cwd, stdout: 'inherit', stderr: 'inherit' })
  const code = await proc.exited
  if (code !== 0) {
    process.exit(code)
  }
}

function die(msg: string): never {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

// 图标预检在耗时编译之前失败，不发布缺图标的 Windows/macOS 安装产物。
if (platform.target === 'windows-x64' && process.platform !== 'win32') {
  die(
    'Windows .exe 图标嵌入依赖 Windows 资源 API，Bun 不支持跨系统 --windows-icon。' +
      '请在 Windows 上构建（即使使用 --skip-native 也一样）。',
  )
}
const iconFile =
  platform.target === 'windows-x64'
    ? join(ICON_DIR, 'app.ico')
    : WANT_APP && platform.darwin
      ? join(ICON_DIR, 'app.icns')
      : undefined
if (iconFile && !existsSync(iconFile)) {
  die(`缺少应用图标 ${iconFile}；运行 bun run icons 重新生成。`)
}

// ── 1. native：napi build（cargo 增量） ───────────────────────────────────

const crossNative = platform.target !== HOST

if (!SKIP_NATIVE) {
  if (crossNative && !(process.platform === 'darwin' && platform.darwin)) {
    die(
      `交叉构建 ${platform.target} 的 native 层需要 MSVC/glibc 工具链，宿主 ${HOST} 不具备。` +
        `请在 ${platform.target} 机器上跑本命令（或走 CI matrix）。` +
        `若对应 .node 已就位，可加 --skip-native 只做 compile。`,
    )
  }
  console.log(`── native: napi build --release [${platform.target}]`)
  const napiArgs = ['run', 'build']
  if (crossNative) napiArgs.push('--target', platform.rust)
  if (process.platform === 'linux') napiArgs.push('--no-default-features')
  await runLive('bun', napiArgs, NATIVE_DIR)
  // napi 会重写 index.d.ts，抹掉 gpuix 面手工维护的 CSD 类型（b786b4c
  // 起就是手工回补——自动化掉这个坑）。幂等：已存在则跳过。
  await runLive('bun', ['run', join('scripts', 'patch-native-dts.ts')], REPO_ROOT)
} else {
  console.log(`── native: skipped (--skip-native)`)
}

if (!existsSync(NODE_FILE)) {
  die(
    `缺少 ${NODE_FILE}——bun compile 需要目标平台的 .node 才能嵌入。` +
      `去掉 --skip-native 构建，或在目标平台机器上产出该文件。`,
  )
}

// 提醒：packages/native 下若混有多平台 .node，bundler 可能把存在的都嵌进去（体积膨胀）
const strayNodes = PLATFORMS.filter((p) => p.target !== platform.target)
  .map((p) => join(NATIVE_DIR, `jagent-native.${p.napi}.node`))
  .filter((f) => existsSync(f))
if (strayNodes.length > 0) {
  console.log(
    `⚠ packages/native 下存在其他平台的 .node（${strayNodes.map((f) => f.split('/').pop()).join(', ')}），可能一并嵌入。仅保留目标平台文件可减小体积。`,
  )
}

// ── 2. compile：bun build --compile → dist/<platform>/ ───────────────────

// 产物预检：bun 自己的「move executable」在目标文件被占用时只报一句 EPERM
// （最典型场景：上一次打包出来的 jagent.exe 还在运行，Windows 锁定映像）。
// 这里提前探一次，给中文可操作的提示。
const outFile = join(DIST_DIR, platform.exe)
if (existsSync(outFile)) {
  try {
    const probe = openSync(outFile, 'r+')
    closeSync(probe)
  } catch (e) {
    const code = (e as { code?: string }).code ?? '未知'
    die(
      `产物 ${outFile} 被占用（${code}）——常见原因：正在运行的 ${platform.exe} 锁定自身映像。` +
        `请先退出该进程再重新打包。`,
    )
  }
}

console.log(`── compile: dist/${platform.target}/${platform.exe}`)
mkdirSync(DIST_DIR, { recursive: true })
const compileArgs = [
  'build',
  '--compile',
  APP_ENTRY,
  '--outfile',
  join('dist', platform.target, platform.exe),
]
if (crossNative) compileArgs.push('--target', platform.bun)
if (platform.target === 'windows-x64') {
  compileArgs.push('--windows-icon', join(ICON_DIR, 'app.ico'))
}
await runLive('bun', compileArgs, REPO_ROOT)

// ── 2b. Windows：PE 收尾（图标资源 + Subsystem CUI → GUI）────────────────
// 两步都幂等，失败即构建失败（不发布糊图标 / 带终端窗口的产物）。
if (platform.target === 'windows-x64') {
  const exe = join(DIST_DIR, platform.exe)

  // ① 图标：`--windows-icon` 写入的资源有两处问题（scripts/pe-icon-resources.ts）：
  //    a) 主组只声明 1 帧（=16px），Windows 认为图标最大 16×16，把 16px 放大
  //       到任务栏需要的 32px（帧声明发糊）；
  //    b) 组名是 IDI_MYICON/#0，而 gpui 注册窗口类用 MAKEINTRESOURCE(1) 取
  //       图标 —— 取不到 → 窗口无图标 → 任务栏走 16px 小图标回退再放大。
  const iconPatch = patchIconResources(exe)
  const iconParts: string[] = []
  if (iconPatch.ordinalFix) {
    iconParts.push(
      `组序号 #${iconPatch.ordinalFix.from}→#${iconPatch.ordinalFix.to}（窗口图标生效）`,
    )
  }
  if (iconPatch.frameFixes.length > 0) {
    iconParts.push(
      `帧声明已补齐（${iconPatch.frameFixes.map((f) => `${f.name} ${f.fromFrames}→${f.toFrames} 帧`).join('、')}）`,
    )
  }
  console.log(iconParts.length > 0 ? `── icon: ${iconParts.join('；')}` : `── icon: 资源已完整，跳过`)

  // ② 子系统：bun 的 `--windows-hide-console` 在本仓 bun 版本不生效，
  //    直接改 PE 头部（scripts/pe-subsystem.ts）。
  const patch = patchWindowsGuiSubsystem(exe)
  console.log(
    patch.changed
      ? `── subsystem: ${describeSubsystem(patch.from)} → ${describeSubsystem(patch.to)}（启动不再分配终端窗口）`
      : `── subsystem: 已是 ${describeSubsystem(patch.to)}，跳过`,
  )
}

// ── 3. --app：macOS 安装壳（Info.plist + 图标 + PkgInfo + adhoc codesign） ──

if (WANT_APP) {
  if (!platform.darwin) {
    console.log(
      `⚠ --app 暂不支持 ${platform.target}（Windows installer / Linux AppImage 未实现），仅输出裸二进制。`,
    )
  } else {
    const version =
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '0.1.0'
    const appDir = join(DIST_DIR, 'JAgent.app')
    rmSync(appDir, { recursive: true, force: true })
    const contents = join(appDir, 'Contents')
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    mkdirSync(join(contents, 'Resources'), { recursive: true })
    cpSync(join(DIST_DIR, platform.exe), join(contents, 'MacOS', platform.exe))
    cpSync(join(ICON_DIR, 'app.icns'), join(contents, 'Resources', 'app.icns'))

    writeFileSync(
      join(contents, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>JAgent</string>
	<key>CFBundleDisplayName</key><string>JAgent</string>
	<key>CFBundleIdentifier</key><string>com.jagent.terminal</string>
	<key>CFBundleVersion</key><string>${version}</string>
	<key>CFBundleShortVersionString</key><string>${version}</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleExecutable</key><string>${platform.exe}</string>
	<key>LSMinimumSystemVersion</key><string>11.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>CFBundleIconFile</key><string>app.icns</string>
</dict>
</plist>
`,
    )
    writeFileSync(join(contents, 'PkgInfo'), 'APPL????')

    // adhoc 签名 + JIT entitlements（JavaScriptCore 需要 JIT；正式分发换开发者证书）
    const entitlements = join(REPO_ROOT, 'dist', 'entitlements.plist')
    writeFileSync(
      entitlements,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.cs.allow-jit</key><true/>
	<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict>
</plist>
`,
    )
    await runLive(
      'codesign',
      ['--entitlements', entitlements, '--force', '--sign', '-', appDir],
      REPO_ROOT,
    )

    console.log(`✓ ${appDir}`)
  }
}

// ── 收尾 ──────────────────────────────────────────────────────────────────

const out = join(DIST_DIR, platform.exe)
console.log(`\n✓ ${out} (${(statSync(out).size / 1024 / 1024).toFixed(0)}MB)`)
