// Windows：GUI 子系统，避免双击启动时弹出控制台窗口。
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        println!("j-agent {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.iter().any(|arg| arg == "--crash-sidecar") {
        if let Err(err) = jagent_app::crash::run_sidecar() {
            eprintln!("[crash-sidecar] {err}");
            std::process::exit(1);
        }
        return;
    }
    if args.iter().any(|arg| arg == "--panic-smoke") {
        if let Err(err) = jagent_app::crash::install_panic_sidecar() {
            eprintln!("[crash-sidecar] unavailable: {err}");
            std::process::exit(2);
        }
        panic!("integration panic smoke marker");
    }
    if args.iter().any(|arg| arg == "--watchdog-normal-smoke") {
        let result = jagent_app::crash::run_watchdog_normal_smoke();
        std::process::exit(if result.is_ok() { 0 } else { 3 });
    }
    if args.iter().any(|arg| arg == "--watchdog-normal-child") {
        if let Some(path) = std::env::var_os("JAGENT_WATCHDOG_NORMAL_CHILD_MARKER") {
            use std::io::Write as _;
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                let _ = writeln!(file, "started");
            }
        }
        return;
    }
    if args.iter().any(|arg| arg == "--watchdog-child-smoke") {
        std::process::exit(7);
    }
    if args.iter().any(|arg| arg == "--watchdog-smoke-once") {
        return;
    }
    if args.iter().any(|arg| arg == "--watchdog-smoke") {
        let result = jagent_app::crash::run_watchdog_smoke();
        std::process::exit(if result.is_err() { 0 } else { 3 });
    }
    if should_run_watchdog(&args) {
        if let Err(err) = jagent_app::crash::run_watchdog() {
            eprintln!("[watchdog] {err}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(err) = jagent_app::crash::install_panic_sidecar() {
        eprintln!("[crash-sidecar] unavailable: {err}");
    }
    jagent_app::app::run();
    jagent_app::crash::shutdown_sidecar();
}

fn should_run_watchdog(args: &[std::ffi::OsString]) -> bool {
    args.iter().any(|arg| arg == "--watchdog") || !args.iter().any(|arg| arg == "--app-child")
}

#[cfg(test)]
mod tests {
    use super::should_run_watchdog;

    #[test]
    fn ordinary_launch_is_supervised_and_only_internal_child_bypasses_watchdog() {
        assert!(
            should_run_watchdog(&[]),
            "double-click/default launch must enter watchdog"
        );
        assert!(should_run_watchdog(&["--watchdog".into()]));
        assert!(!should_run_watchdog(&["--app-child".into()]));
    }
}
