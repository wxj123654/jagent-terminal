//! Minimal panic-report sidecar and crash-loop watchdog for packaged Rust builds.
//!
//! Captures Rust panics as JSON metadata (not native minidumps). Sidecar IO is
//! isolated from the unwinding thread so the panic hook never blocks on pipes.

use std::{
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

static SIDECAR_SENDER: OnceLock<SyncSender<String>> = OnceLock::new();
static SIDECAR_ACK: OnceLock<Mutex<mpsc::Receiver<()>>> = OnceLock::new();
static SIDECAR_CHILD: OnceLock<Mutex<Child>> = OnceLock::new();
static REPORT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn crash_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("JAGENT_CRASH_DIR") {
        return PathBuf::from(path);
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(".j-agent").join("crashes")
}

/// Sidecar process entry point: persist each newline-delimited JSON report.
pub fn run_sidecar() -> io::Result<()> {
    let dir = crash_dir();
    fs::create_dir_all(&dir)?;
    prune_crash_reports(&dir, 64)?;
    println!("READY");
    io::stdout().flush()?;
    for line in BufReader::new(io::stdin().lock()).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let sequence = REPORT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!(
            "crash-{}-{now}-{sequence}.json",
            std::process::id()
        ));
        let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        prune_crash_reports(&dir, 64)?;
        println!("PERSISTED");
        io::stdout().flush()?;
    }
    Ok(())
}

/// Start the sidecar and install a panic hook sending metadata out of process.
pub fn install_panic_sidecar() -> io::Result<()> {
    let dir = crash_dir();
    fs::create_dir_all(&dir)?;
    let exe = std::env::current_exe()?;
    let mut child = Command::new(exe)
        .arg("--crash-sidecar")
        .env("JAGENT_CRASH_DIR", &dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("sidecar stdout unavailable"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("sidecar stdin unavailable"))?;
    let mut ready = BufReader::new(stdout);
    let mut line = String::new();
    ready.read_line(&mut line)?;
    if line.trim() != "READY" {
        let _ = child.kill();
        return Err(io::Error::other("sidecar failed readiness handshake"));
    }
    let _ = SIDECAR_CHILD.set(Mutex::new(child));
    let (tx, rx) = mpsc::sync_channel::<String>(8);
    let _ = SIDECAR_SENDER.set(tx);
    let (ack_tx, ack_rx) = mpsc::sync_channel::<()>(1);
    let _ = SIDECAR_ACK.set(Mutex::new(ack_rx));
    thread::Builder::new()
        .name("jagent-crash-sidecar-io".into())
        .spawn(move || sidecar_writer(rx, stdin, ready, ack_tx))?;

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("non-string panic payload");
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        let report = serde_json::json!({
            "kind": "panic", "pid": std::process::id(), "thread": thread::current().name().unwrap_or("unnamed"),
            "message": message, "location": location,
            "timeUnixMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        });
        if let Some(sender) = SIDECAR_SENDER.get()
            && sender.try_send(report.to_string()).is_ok()
            && let Some(ack) = SIDECAR_ACK.get()
            && let Ok(ack) = ack.lock()
        {
            let _ = ack.recv_timeout(Duration::from_secs(2));
        }
        previous(info);
    }));
    Ok(())
}

fn sidecar_writer(
    rx: mpsc::Receiver<String>,
    mut stdin: ChildStdin,
    mut stdout: BufReader<impl io::Read + Send + 'static>,
    ack: SyncSender<()>,
) {
    for report in rx {
        if report.is_empty() {
            return;
        }
        if writeln!(stdin, "{report}")
            .and_then(|_| stdin.flush())
            .is_err()
        {
            return;
        }
        let mut acknowledgement = String::new();
        if stdout.read_line(&mut acknowledgement).is_err() || acknowledgement.trim() != "PERSISTED"
        {
            return;
        }
        let _ = ack.try_send(());
    }
}

const WATCHDOG_WINDOW: Duration = Duration::from_secs(60);
const WATCHDOG_MAX_STARTS: usize = 5;
const RESTART_DELAY: Duration = Duration::from_secs(3);

fn prune_crash_reports(dir: &std::path::Path, keep: usize) -> io::Result<()> {
    let mut reports = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_ok_and(|ty| ty.is_file())
                && entry.file_name().to_string_lossy().starts_with("crash-")
                && entry.path().extension().is_some_and(|ext| ext == "json")
        })
        .collect::<Vec<_>>();
    reports.sort_by_key(|entry| entry.metadata().and_then(|m| m.modified()).ok());
    let remove_count = reports.len().saturating_sub(keep);
    for entry in reports.into_iter().take(remove_count) {
        fs::remove_file(entry.path())?;
    }
    Ok(())
}

fn allow_restart(starts: &mut Vec<std::time::Instant>, now: std::time::Instant) -> bool {
    starts.retain(|t| now.duration_since(*t) <= WATCHDOG_WINDOW);
    if starts.len() >= WATCHDOG_MAX_STARTS {
        return false;
    }
    starts.push(now);
    true
}

/// Run the same executable as an app child; stop after five starts in a 60s window.
pub fn run_watchdog() -> io::Result<()> {
    run_watchdog_with(
        &std::env::current_exe()?,
        &["--app-child"],
        WATCHDOG_MAX_STARTS,
        RESTART_DELAY,
    )
}

fn run_watchdog_with(
    exe: &std::path::Path,
    child_args: &[&str],
    max_starts: usize,
    delay: Duration,
) -> io::Result<()> {
    let mut starts = Vec::<std::time::Instant>::new();
    loop {
        let now = std::time::Instant::now();
        if !allow_restart(&mut starts, now) || starts.len() > max_starts {
            eprintln!(
                "[watchdog] {} starts in 60s; stopping to prevent crash loop",
                starts.len()
            );
            return Err(io::Error::other("application crash loop"));
        }
        let mut command = Command::new(exe);
        command.args(child_args).env("JAGENT_WATCHDOG_CHILD", "1");
        let status = command.status()?;
        if status.success() {
            return Ok(());
        }
        eprintln!("[watchdog] app exited with {status}; restarting");
        if delay != Duration::ZERO {
            thread::sleep(delay);
        }
    }
}

/// Process-level smoke mode: launch two failing children, then prove crash-loop cutoff.
pub fn run_watchdog_smoke() -> io::Result<()> {
    run_watchdog_with(
        &std::env::current_exe()?,
        &["--watchdog-child-smoke"],
        2,
        Duration::ZERO,
    )
}

/// Run one watchdog child that exits normally to exercise the normal-stop path.
pub fn run_watchdog_normal_smoke() -> io::Result<()> {
    let exe = std::env::current_exe()?;
    run_watchdog_with(&exe, &["--watchdog-smoke-once"], 2, Duration::ZERO)?;
    // Also exercise the *ordinary launch* routing, not only the helper directly. The first
    // child enters main as an unspecialized launch and returns only via watchdog supervision.
    let status = Command::new(exe).arg("--watchdog-normal-child").status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("normal watchdog child failed"))
    }
}

/// Stop the sidecar child; normal app shutdown need not wait for a report.
pub fn shutdown_sidecar() {
    if let Some(child) = SIDECAR_CHILD.get() {
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watchdog_caps_crash_loops_and_expires_old_starts() {
        let now = std::time::Instant::now();
        let mut starts = Vec::new();
        for i in 0..WATCHDOG_MAX_STARTS - 1 {
            assert!(allow_restart(
                &mut starts,
                now + Duration::from_secs(i as u64)
            ));
        }
        assert!(allow_restart(&mut starts, now + Duration::from_secs(5)));
        assert!(!allow_restart(&mut starts, now + Duration::from_secs(6)));
        assert!(allow_restart(
            &mut starts,
            now + WATCHDOG_WINDOW + Duration::from_secs(6)
        ));
        assert_eq!(starts.len(), 1);
    }

    #[test]
    fn sidecar_persists_reports_and_prunes_to_a_bounded_history() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..70 {
            std::fs::write(
                dir.path().join(format!("crash-test-{i}.json")),
                format!("{{\"i\":{i}}}"),
            )
            .unwrap();
        }
        std::fs::write(dir.path().join("unrelated.txt"), "keep").unwrap();
        prune_crash_reports(dir.path(), 64).unwrap();
        let crash_count = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .count();
        assert_eq!(crash_count, 64);
        assert!(dir.path().join("unrelated.txt").exists());
    }

    #[test]
    fn crash_report_dir_respects_an_explicit_override() {
        let old = std::env::var_os("JAGENT_CRASH_DIR");
        let expected = std::env::temp_dir().join("jagent-crash-dir-test");
        unsafe {
            std::env::set_var("JAGENT_CRASH_DIR", &expected);
        }
        assert_eq!(crash_dir(), expected);
        match old {
            Some(v) => unsafe {
                std::env::set_var("JAGENT_CRASH_DIR", v);
            },
            None => unsafe {
                std::env::remove_var("JAGENT_CRASH_DIR");
            },
        }
    }
}
