fn main() {
    println!("cargo:rerun-if-changed=assets/icons/app.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
            // 对齐 Zed：Windows MSVC 默认 1MB 栈在 debug 深层 GPUI 视图树下易栈溢出，提升至 8MB。
            println!("cargo:rustc-link-arg=/stack:{}", 8 * 1024 * 1024);
        }
        let icon = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/icons/app.ico");
        if !icon.is_file() {
            panic!("Windows icon asset missing: {}", icon.display());
        }
        let mut resource = winresource::WindowsResource::new();
        resource.set_icon(icon.to_str().expect("icon path is UTF-8"));
        resource.set("ProductName", "j-agent");
        resource.set("FileDescription", "j-agent desktop application");
        resource.set("InternalName", "j-agent");
        resource.set("OriginalFilename", "j-agent.exe");
        resource.set("ProductVersion", env!("CARGO_PKG_VERSION"));
        resource.set("FileVersion", env!("CARGO_PKG_VERSION"));
        resource
            .compile()
            .expect("compile Windows icon and version resources");

        provision_windows_conpty();
    }
}

/// 在 Windows 构建时将现代 `conpty.dll` 与 `OpenConsole.exe` 部署到构建产物目录（对齐 Zed `build.rs`）。
///
/// `alacritty_terminal` 启动 PTY 时优先尝试 `LoadLibraryW("conpty.dll")`，若未找到则退化为系统内置旧版
/// `conhost.exe`（在输出满屏或窗口 resize 时倾向于原地重绘屏幕而非推入 scrollback 历史，导致终端无法回滚）。
fn provision_windows_conpty() {
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if target_arch != "x86_64" && target_arch != "aarch64" {
        return;
    }

    let Some(out_dir) = std::env::var_os("OUT_DIR").map(std::path::PathBuf::from) else {
        return;
    };
    let Some(target_dir) = out_dir
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
    else {
        return;
    };

    let conpty_dll_target = target_dir.join("conpty.dll");
    let open_console_target = target_dir.join("OpenConsole.exe");
    println!("cargo:rerun-if-changed={}", conpty_dll_target.display());
    println!("cargo:rerun-if-changed={}", open_console_target.display());

    let (dll_rel, exe_rel) = if target_arch == "x86_64" {
        (
            "runtimes/win-x64/native/conpty.dll",
            "build/native/runtimes/x64/OpenConsole.exe",
        )
    } else {
        (
            "runtimes/win-arm64/native/conpty.dll",
            "build/native/runtimes/arm64/OpenConsole.exe",
        )
    };

    let extract_dir = out_dir.join("conpty");
    let conpty_dll_source = extract_dir.join(dll_rel);
    let open_console_source = extract_dir.join(exe_rel);

    if (!conpty_dll_source.is_file() || !open_console_source.is_file())
        && (!conpty_dll_target.is_file() || !open_console_target.is_file())
    {
        let conpty_url = "https://github.com/microsoft/terminal/releases/download/v1.24.10621.0/Microsoft.Windows.Console.ConPTY.1.24.260303001.nupkg";
        let nupkg_path = out_dir.join("conpty.nupkg.zip");
        let script = format!(
            "$ProgressPreference = 'SilentlyContinue'; \
             [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; \
             Invoke-WebRequest -Uri '{}' -OutFile '{}'; \
             Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
            conpty_url,
            nupkg_path.display(),
            nupkg_path.display(),
            extract_dir.display()
        );
        if let Err(e) = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
        {
            println!("cargo:warning=Failed to download conpty nupkg: {e}");
        }
    }

    if conpty_dll_source.is_file() && open_console_source.is_file() {
        for dest_dir in [
            target_dir.to_path_buf(),
            target_dir.join("deps"),
            target_dir.join("examples"),
        ] {
            if dest_dir.is_dir() {
                let _ = std::fs::copy(&conpty_dll_source, dest_dir.join("conpty.dll"));
                let _ = std::fs::copy(&open_console_source, dest_dir.join("OpenConsole.exe"));
            }
        }
    }
}
